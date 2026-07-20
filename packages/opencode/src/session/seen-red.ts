/**
 * F18 — seen-red must re-verify: scans a turn's own bash-execution history
 * for a test/repro run that failed and was never re-run green before the
 * turn finishes. The M4/S3/F11 finish-time gates each check a narrower
 * shape (a pinned probe, zero landed source edits, a neighbor regression)
 * but none of them replay the turn's own transcript — the gap that let
 * django-11790 ship a patch after a mid-turn pytest run failed and was
 * never re-verified. Transcript scan: no Effect, no commands run — the
 * caller extracts the plain execution array from message parts and injects
 * the nudge/log. Test-shaped classification and red detection also consult
 * the repo's profile (docs/design/agnostic-hands-eyes.md §2.2) and any
 * attached structured test report (`reportContent`), so a non-Python
 * ecosystem's runner/suite commands and exit-0-laundered reds are caught
 * without new regexes; the profile lookup is memoized per repo root, so it
 * costs real FS/git I/O at most once per process.
 *
 * @sem domain=routing role=gate
 */
import { MISSING_FILE_RE, MODULE_MISSING_RE } from "./slice-orchestrator"
import { looksLikeTestExecution, normalizeResult } from "./turn-supervisor"
import { detectOracleInversion, type IssueExpectation } from "./issue-expectations"
import { getRepoProfileSync, type EcosystemProfile } from "../code-intelligence/repo-profile"
import { detectAndParseTestReport } from "../code-intelligence/test-report"

/** One bash execution from the turn's transcript, in chronological order. */
export interface SeenRedExecution {
  command: string
  exitCode: number | undefined
  output: string
  /**
   * True when a source (non-test, non-scratch-repro) edit had already landed
   * BEFORE this execution ran. Optional — every existing extractor that
   * never populates it reads as "unknown," which `partitionSeenRedByEnvBlock`
   * treats as before-any-edit (conservative: a caller that hasn't wired edit
   * provenance yet should not be silently excluded from that rung).
   */
  sawEditBefore?: boolean
  /**
   * Raw structured test-report content (JUnit XML / go test -json / jest
   * `--json` / TAP) for this execution, when the caller already has it —
   * e.g. a `--junitxml=<path>` file read alongside the command's stdout.
   * Optional: every existing caller that omits it keeps today's
   * regex-only classification and red detection byte-identical.
   */
  reportContent?: string
}

/** An unresolved red execution surfaced to the model, with a short evidence tail. */
export interface UnresolvedSeenRed {
  command: string
  outputTail: string
}

// A test-shaped command: a pytest/Django-style runner invocation, or a
// `repro*` script — never a bare non-test shell command (grep, ls, a build
// step) whose failure carries no verification meaning. Exported for F21's
// interpreter harvest (regression-neighbors.ts) so both keep one definition.
export const TEST_SHAPED_COMMAND_RE = /pytest|(?:^|[\s/])tests?(?:[\s/._]|$)|runtests|manage\.py test|repro/i

// The output actually carries a test-failure signature — a non-zero exit
// from a test-shaped command alone (e.g. a collection warning) is not
// enough to count as seen-red.
const TEST_FAILURE_SIGNATURE_RE = /FAILED|AssertionError|Traceback|FAIL:|ERROR:|[1-9]\d* (failed|errors?)/

// Stricter, summary-line-only signature for the exit-laundered branch: a
// zero-exit execution may only count as red on the shapes a test RUNNER
// prints for a red run (django/unittest "FAILED (failures=…)"/"FAIL: ",
// pytest "FAILED tests/…"/"2 failed") — never on a mere failure-shaped word
// (Traceback/ERROR:) that legitimately appears in verbose green output.
export const LAUNDERED_FAILURE_SIGNATURE_RE = /FAILED\s*\(|(?:^|\n)\s*FAILED\b|\b[1-9]\d* failed\b|(?:^|\n)FAIL: /

// An interpreter path (`python`, `python3.9`, `.venv/bin/python`) is shared
// by nearly every command a turn runs — treating it as a test target let any
// later exit-0 python invocation falsely clear a red (11885 live shape).
export const INTERPRETER_TOKEN_RE = /(?:^|\/)python[\w.]*$/i
// A bare module label trailing the runner (django's `runtests.py delete`).
const BARE_LABEL_RE = /^[A-Za-z_]\w*$/

// Token shapes that identify WHAT a command targets, so a later green run of
// the same test/file/module clears the earlier red without requiring a
// byte-identical command (a rerun with `-v` or a narrower `-k` still
// counts). The runner token itself (pytest/runtests.py/manage.py) is never
// a target — see the exclusion in extractTestTargetTokens below.
const PATH_LIKE_TOKEN_RE = /\//
const PY_FILE_TOKEN_RE = /\.py$/
const PYTEST_ID_TOKEN_RE = /::/
const DOTTED_LABEL_RE = /^\w+(?:\.\w+)+$/
const TEST_RUNNER_TOKEN_RE = /^(?:.*\/)?(?:pytest|runtests\.py|manage\.py)$/i

const OUTPUT_TAIL_LINES = 15

/** The path/pytest-id/dotted-label/bare-module tokens a command names as its test target(s), read from the runner-bearing segment only — pipe filters (`| grep | tail`) and compound trailers (`; python inspect.py`) are output plumbing, not test selection. Empty when none are extractable (the caller falls back to exact-command matching). */
function extractTestTargetTokens(command: string): string[] {
  const segments = command
    .split(/&&|;|\|/)
    .map((s) => s.trim())
    .filter(Boolean)
  const runnerSegment =
    segments.find((s) => s.split(/\s+/).some((t) => TEST_RUNNER_TOKEN_RE.test(t.replace(/^['"]|['"]$/g, "")))) ??
    command
  const tokens = runnerSegment.split(/\s+/).filter(Boolean)
  const runnerIdx = tokens.findIndex((t) => TEST_RUNNER_TOKEN_RE.test(t.replace(/^['"]|['"]$/g, "")))
  const targets = new Set<string>()
  tokens.forEach((raw, i) => {
    const token = raw.replace(/^['"]|['"]$/g, "")
    if (TEST_RUNNER_TOKEN_RE.test(token)) return // the runner script itself, never a target
    if (INTERPRETER_TOKEN_RE.test(token)) return // shared by every command the turn runs — never identifying
    if (PATH_LIKE_TOKEN_RE.test(token) || PY_FILE_TOKEN_RE.test(token) || PYTEST_ID_TOKEN_RE.test(token)) {
      targets.add(token)
    } else if (
      runnerIdx !== -1 &&
      i > runnerIdx &&
      !token.startsWith("-") &&
      (DOTTED_LABEL_RE.test(token) || BARE_LABEL_RE.test(token))
    ) {
      // A dotted test label (`app.tests.SomeTest.test_x`) or a bare module
      // label (django's `runtests.py delete`) only counts as a target when
      // it trails the runner — a stray identifier ahead of it (a version
      // pin, a path fragment) must not.
      targets.add(token)
    }
  })
  return [...targets]
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`, "i")
}

/** Does `command` reference a file token matching one of the profile's test-file glob patterns (`test_*.py`, `*_test.go`, …)? */
function matchesProfileTestFilePattern(command: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false
  return command
    .split(/\s+/)
    .filter(Boolean)
    .map((raw) => raw.replace(/^['"]|['"]$/g, ""))
    .map((token) => token.split("/").pop() ?? token)
    .some((base) => patterns.some((pattern) => globToRegExp(pattern).test(base)))
}

/** Does `command` reference one of the profile's test-dir conventions (`tests/`, `__tests__/`, `src/test/java/`, …)? */
function matchesProfileTestDir(command: string, dirs: readonly string[]): boolean {
  return dirs.some((dir) => dir.length > 0 && command.includes(`${dir}/`))
}

/**
 * Profile-driven OR-extension of TEST_SHAPED_COMMAND_RE (docs/design/
 * agnostic-hands-eyes.md §2.2): a command is also test-shaped when it
 * invokes one of the repo profile's runner/suite/single-test tokens,
 * touches a path matching its test-dir/file conventions, or is its repro
 * run command — the same three shapes the regex hardcodes for pytest/
 * Django, generalized to every ecosystem the profile derives.
 */
function isProfileTestShapedCommand(command: string, cwd: string): boolean {
  const profile = getRepoProfileSync(cwd)
  for (const eco of profile.ecosystems as readonly EcosystemProfile[]) {
    if (eco.repro.run && command.includes(eco.repro.run)) return true
    if ("unknown" in eco.tests) continue
    const { runner, suite, single, conventions } = eco.tests
    if (runner && command.includes(runner)) return true
    if (suite && command.includes(suite)) return true
    const singlePrefix = single.split("{testId}")[0]?.trim()
    if (singlePrefix && command.includes(singlePrefix)) return true
    if (matchesProfileTestDir(command, conventions.dirs)) return true
    if (matchesProfileTestFilePattern(command, conventions.filePatterns)) return true
  }
  return false
}

function isRedTestExecution(exec: SeenRedExecution, cwd: string = process.cwd()): boolean {
  if (exec.exitCode === undefined) return false
  const testShaped = TEST_SHAPED_COMMAND_RE.test(exec.command) || isProfileTestShapedCommand(exec.command, cwd)
  if (!testShaped) return false
  // Structured output first (§2.2): a parsed report with >0 fail/error
  // entries is red BY CONSTRUCTION, independent of exit code or the
  // summary-line regexes below — this is what makes exit-0 laundering
  // structural instead of requiring a pipe/tail heuristic per format.
  const report = exec.reportContent ? detectAndParseTestReport(exec.reportContent) : undefined
  if (report && report.totals.fail + report.totals.error > 0) {
    if (MISSING_FILE_RE.test(exec.output) || MODULE_MISSING_RE.test(exec.output)) return false
    return true
  }
  if (!TEST_FAILURE_SIGNATURE_RE.test(exec.output)) return false
  // Env-red (a missing file/module) is a broken environment, not an
  // unverified fix — the same discipline `selectRegressionPinCandidate`
  // (regression-neighbors.ts) applies to a regression-gate failure.
  if (MISSING_FILE_RE.test(exec.output) || MODULE_MISSING_RE.test(exec.output)) return false
  if (exec.exitCode !== 0) return true
  // Exit-code laundering (11885 rounds C+C3: 12 of 12 watched reds): a pipe
  // filter (`2>&1 | grep … | tail -40`) or compound trailer (`; python
  // inspect.py`) makes the shell report 0 for a failing run. A zero-exit
  // execution still counts as red when the command actually EXECUTES a test
  // at command position (never a cat/grep read of test files) and the output
  // carries a runner's red-run summary line.
  return /[|;]/.test(exec.command) && looksLikeTestExecution(exec.command) && LAUNDERED_FAILURE_SIGNATURE_RE.test(exec.output)
}

/** Whether `candidateCommand` clears a red execution's `command`/`targets` — an exact match always clears; a token-shared match only when targets were extractable. A bare module label and a dotted narrowing of it (`delete` ⇄ `delete.DeletionTests`) count as shared. */
function clears(targets: readonly string[], command: string, candidateCommand: string): boolean {
  if (candidateCommand === command) return true
  if (targets.length === 0) return false
  const candidateTargets = extractTestTargetTokens(candidateCommand)
  return targets.some((token) =>
    candidateTargets.some(
      (candidate) => candidate === token || candidate.startsWith(token + ".") || token.startsWith(candidate + "."),
    ),
  )
}

function outputTail(output: string): string {
  return output.trim().split("\n").slice(-OUTPUT_TAIL_LINES).join("\n")
}

/**
 * The turn's red test/repro runs that were never re-run green — the
 * finish-time signal the M4/S3/F11 gates each miss (none of them replay the
 * transcript). A red is cleared by a LATER green execution sharing a test
 * target (or an exact command match) whose own output is not red-signatured
 * (an exit-laundered re-run that failed again must never clear), or by
 * `clearedByProbe` (the M4 gate's own re-run, which happens outside the
 * transcript entirely since it shells out directly rather than going through
 * an assistant tool call). No Effect, no commands run (test-shaped
 * classification may consult the repo's cached profile — see this module's
 * doc comment). Empty array when nothing is unresolved; at most the LAST 3
 * otherwise — the most recent evidence, bounded so a repeated-red turn
 * can't flood the nudge.
 *
 * @sem domain=routing role=gate
 */
export function findUnresolvedSeenRed(
  executions: readonly SeenRedExecution[],
  clearedByProbe?: string,
  cwd: string = process.cwd(),
): UnresolvedSeenRed[] {
  const unresolved: UnresolvedSeenRed[] = []
  for (let i = 0; i < executions.length; i++) {
    const exec = executions[i]!
    if (!isRedTestExecution(exec, cwd)) continue
    const targets = extractTestTargetTokens(exec.command)
    if (clearedByProbe && clears(targets, exec.command, clearedByProbe)) continue
    const clearedLater = executions
      .slice(i + 1)
      .some(
        (later) =>
          later.exitCode === 0 &&
          !LAUNDERED_FAILURE_SIGNATURE_RE.test(later.output) &&
          clears(targets, exec.command, later.command),
      )
    if (clearedLater) continue
    unresolved.push({ command: exec.command, outputTail: outputTail(exec.output) })
  }
  return unresolved.slice(-3)
}

/**
 * H1 tooth 3 (gap-closure-plan §2.7, F2P full-set claim) — every test-target
 * id (or, when none is extractable, the whole command) that appeared in a
 * RED execution anywhere in `executions`, deduped. This is the finish
 * claim's SCOPE: the agent's OWN observed reds, never a benchmark-provided
 * F2P list (strip-the-future). Unlike `findUnresolvedSeenRed` this is not
 * bounded to the last 3 and does not drop an id a later execution cleared —
 * the caller (prompt.ts's turn-scoped accumulator) needs the full set ever
 * seen red this turn; `observedTestVerdicts` below supplies each id's
 * LATEST verdict for the actual coverage check. When an execution carries a
 * structured test report (`reportContent`), that report's own fail/error
 * entry ids are unioned in too — report-native ids alongside the
 * pytest/Django command-token extraction, never replacing it.
 *
 * @sem domain=routing role=gate
 */
export function collectObservedRedTestIds(
  executions: readonly SeenRedExecution[],
  cwd: string = process.cwd(),
): string[] {
  const ids = new Set<string>()
  for (const exec of executions) {
    if (!isRedTestExecution(exec, cwd)) continue
    const targets = extractTestTargetTokens(exec.command)
    for (const id of targets.length > 0 ? targets : [exec.command]) ids.add(id)
    const report = exec.reportContent ? detectAndParseTestReport(exec.reportContent) : undefined
    if (report) {
      for (const entry of report.entries) {
        if (entry.status === "fail" || entry.status === "error") ids.add(entry.id)
      }
    }
  }
  return [...ids]
}

/**
 * H1 tooth 3 — the LATEST verdict per test-target id across `executions`, in
 * transcript order (a later execution overwrites an earlier one) — the
 * evidence `checkTestSetCoverage` (repro-fidelity-judge.ts) checks
 * `collectObservedRedTestIds`'s claim scope against. Only a red execution
 * (`isRedTestExecution`) records "fail"; only a clean, non-laundered green
 * (`exitCode === 0` and no laundered-failure signature — the same green
 * `clears()` already recognizes as a legitimate clearing re-run) records
 * "pass". Any other shape (undefined exit, ambiguous output) leaves a prior
 * entry untouched rather than guessing. A structured test report
 * (`reportContent`), when present, also sets each of its entries' verdict
 * directly from the report's own pass/fail/error status.
 *
 * @sem domain=routing role=gate
 */
export function observedTestVerdicts(
  executions: readonly SeenRedExecution[],
  cwd: string = process.cwd(),
): Map<string, "pass" | "fail"> {
  const verdicts = new Map<string, "pass" | "fail">()
  for (const exec of executions) {
    const red = isRedTestExecution(exec, cwd)
    const cleanGreen = exec.exitCode === 0 && !LAUNDERED_FAILURE_SIGNATURE_RE.test(exec.output)
    if (!red && !cleanGreen) continue
    const targets = extractTestTargetTokens(exec.command)
    for (const id of targets.length > 0 ? targets : [exec.command]) verdicts.set(id, red ? "fail" : "pass")
    const report = exec.reportContent ? detectAndParseTestReport(exec.reportContent) : undefined
    if (report) {
      for (const entry of report.entries) {
        if (entry.status === "fail" || entry.status === "error") verdicts.set(entry.id, "fail")
        else if (entry.status === "pass") verdicts.set(entry.id, "pass")
      }
    }
  }
  return verdicts
}

/** An unresolved red whose failure is oracle-inversion-shaped: a COMMITTED visible test still expects the value the issue calls wrong while the code now produces the issue's stated desired form. Sanctioned — exempt from the confirm-GREEN demand; the finish owes a stated verdict instead. */
export interface SeenRedInversion extends UnresolvedSeenRed {
  desiredLiteral?: string
  buggyLiteral?: string
}

/**
 * Committed-suite provenance for the inversion form rung: the command's
 * extracted test targets reference the committed tests tree (a `tests/` path,
 * a dotted module label, or a bare module label trailing the runner) and
 * nothing about the command is repro-shaped. The agent's own scratch repro
 * (`repro_issue.py` at the repo root) must never qualify — its expectation
 * side legitimately carries the issue's desired form ahead of an unfixed
 * producer, which is an honest red, not an inversion.
 *
 * @sem domain=routing role=gate
 */
export function isTrackedSuiteCommand(command: string): boolean {
  if (/repro/i.test(command)) return false
  const targets = extractTestTargetTokens(command)
  return targets.some(
    (t) => /(?:^|\/)tests?\//.test(t) || DOTTED_LABEL_RE.test(t) || BARE_LABEL_RE.test(t),
  )
}

/**
 * Partition F18's unresolved reds into `binding` (owe a green re-run — the
 * unchanged confirm-GREEN demand) and `sanctioned` (oracle-inversion-shaped:
 * a committed visible test whose red tail shows the code PRODUCING the
 * issue's stated desired value while the assertion still expects the value
 * the issue calls wrong — the 2026-07-15 11815 shape, where the agent
 * applied the general gold-equivalent fix, watched the stale committed suite
 * go red on it, and the confirm-GREEN nudge forced the retreat to a
 * narrowed Promise-conditional patch). A sanctioned red must NOT be re-run
 * green; the caller nudges keep-the-general-fix + state-the-conflict
 * instead. Empty `literals` (no issue expectations extracted) sanctions
 * nothing — every red stays binding, byte-identical to the pre-partition
 * behavior.
 *
 * @sem domain=routing role=gate
 */
export function partitionSeenRedByInversion(
  unresolved: readonly UnresolvedSeenRed[],
  literals: readonly IssueExpectation[],
): { binding: UnresolvedSeenRed[]; sanctioned: SeenRedInversion[] } {
  const binding: UnresolvedSeenRed[] = []
  const sanctioned: SeenRedInversion[] = []
  for (const red of unresolved) {
    if (literals.length === 0 || !isTrackedSuiteCommand(red.command)) {
      binding.push(red)
      continue
    }
    const verdict = detectOracleInversion(red.outputTail, literals, { fromTrackedSuite: true })
    if (verdict.inverted) {
      sanctioned.push({ ...red, desiredLiteral: verdict.desiredLiteral, buggyLiteral: verdict.buggyLiteral })
    } else {
      binding.push(red)
    }
  }
  return { binding, sanctioned }
}

// Conservative environment-gap markers beyond the MISSING_FILE_RE/
// MODULE_MISSING_RE family already excluded upstream (isRedTestExecution
// above never lets those reach `unresolved` at all — checked again here only
// as defense in depth). The django-11880 shape: the real arena text reads
// "A GIS database backend is required to run gis_tests." — `backend` and
// `required` share a clause but are not adjacent, so the gap between them
// is bounded (never `.*`) to stay a conservative red-sanctioning marker
// rather than a generic environment-gap catch-all that could write off a
// real failure.
const ENV_BLOCKED_MARKER_RE = /backend\b[^.\n]{0,24}?\brequired|ImproperlyConfigured|command not found/i

/** Whether an unresolved red's evidence tail is environment-shaped: the MISSING_FILE_RE/MODULE_MISSING_RE family or the conservative marker set above. */
export function isEnvBlockedSignature(outputTail: string): boolean {
  return (
    ENV_BLOCKED_MARKER_RE.test(outputTail) || MISSING_FILE_RE.test(outputTail) || MODULE_MISSING_RE.test(outputTail)
  )
}

/** An unresolved red sanctioned as environment/baseline-blocked — never fixable by editing the issue's code. `repeats` is how many red executions in the turn shared its normalized signature (evidence it is a stable gap, not a one-off flake). */
export interface SeenRedEnvBlock extends UnresolvedSeenRed {
  repeats: number
}

/**
 * Partition F18's still-binding unresolved reds (after `partitionSeenRedByInversion`)
 * into `binding` (owe a green re-run, unchanged) and `envBlocked`: a red
 * whose evidence tail is environment-shaped (`isEnvBlockedSignature`) OR
 * whose FIRST occurrence in `executions` predates this turn's first landed
 * source edit (`sawEditBefore` unset/false), AND has repeated with an
 * identical normalized signature at least twice — the 2026-07-15 django-
 * 11880 shape (a GIS-backend-required regression neighbor burned 42 of 59
 * turns re-running a red that can never pass in this arena). Both conditions
 * are conservative on purpose: a red whose ONLY evidence is "first observed
 * after an edit" and carries no environment marker stays binding — it could
 * be a regression the edit itself caused. Applies uniformly to suite and
 * repro commands alike (unlike the inversion partition, an environment gap
 * is equally real evidence regardless of provenance).
 *
 * @sem domain=routing role=gate
 */
export function partitionSeenRedByEnvBlock(
  unresolved: readonly UnresolvedSeenRed[],
  executions: readonly SeenRedExecution[],
): { binding: UnresolvedSeenRed[]; envBlocked: SeenRedEnvBlock[] } {
  const binding: UnresolvedSeenRed[] = []
  const envBlocked: SeenRedEnvBlock[] = []
  for (const red of unresolved) {
    const envMarker = isEnvBlockedSignature(red.outputTail)
    const firstExec = executions.find((e) => e.command === red.command)
    const beforeEdit = firstExec ? firstExec.sawEditBefore !== true : true
    if (!envMarker && !beforeEdit) {
      binding.push(red)
      continue
    }
    const signature = normalizeResult(red.outputTail)
    const repeats = executions.filter(
      (exec) => isRedTestExecution(exec) && normalizeResult(outputTail(exec.output)) === signature,
    ).length
    if (repeats >= 2) {
      envBlocked.push({ ...red, repeats })
    } else {
      binding.push(red)
    }
  }
  return { binding, envBlocked }
}
