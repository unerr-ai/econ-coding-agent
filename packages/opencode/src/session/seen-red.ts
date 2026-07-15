/**
 * F18 — seen-red must re-verify: scans a turn's own bash-execution history
 * for a test/repro run that failed and was never re-run green before the
 * turn finishes. The M4/S3/F11 finish-time gates each check a narrower
 * shape (a pinned probe, zero landed source edits, a neighbor regression)
 * but none of them replay the turn's own transcript — the gap that let
 * django-11790 ship a patch after a mid-turn pytest run failed and was
 * never re-verified. Pure transcript scan: no Effect, no I/O, no commands
 * run — the caller extracts the plain execution array from message parts
 * and injects the nudge/log.
 *
 * @sem domain=routing role=gate
 */
import { MISSING_FILE_RE, MODULE_MISSING_RE } from "./slice-orchestrator"
import { looksLikeTestExecution } from "./turn-supervisor"
import { detectOracleInversion, type IssueExpectation } from "./issue-expectations"

/** One bash execution from the turn's transcript, in chronological order. */
export interface SeenRedExecution {
  command: string
  exitCode: number | undefined
  output: string
}

/** An unresolved red execution surfaced to the model, with a short evidence tail. */
export interface UnresolvedSeenRed {
  command: string
  outputTail: string
}

// A test-shaped command: a pytest/Django-style runner invocation, or a
// `repro*` script — never a bare non-test shell command (grep, ls, a build
// step) whose failure carries no verification meaning.
const TEST_SHAPED_COMMAND_RE = /pytest|(?:^|[\s/])tests?(?:[\s/._]|$)|runtests|manage\.py test|repro/i

// The output actually carries a test-failure signature — a non-zero exit
// from a test-shaped command alone (e.g. a collection warning) is not
// enough to count as seen-red.
const TEST_FAILURE_SIGNATURE_RE = /FAILED|AssertionError|Traceback|FAIL:|ERROR:|[1-9]\d* (failed|errors?)/

// Stricter, summary-line-only signature for the exit-laundered branch: a
// zero-exit execution may only count as red on the shapes a test RUNNER
// prints for a red run (django/unittest "FAILED (failures=…)"/"FAIL: ",
// pytest "FAILED tests/…"/"2 failed") — never on a mere failure-shaped word
// (Traceback/ERROR:) that legitimately appears in verbose green output.
const LAUNDERED_FAILURE_SIGNATURE_RE = /FAILED\s*\(|(?:^|\n)\s*FAILED\b|\b[1-9]\d* failed\b|(?:^|\n)FAIL: /

// An interpreter path (`python`, `python3.9`, `.venv/bin/python`) is shared
// by nearly every command a turn runs — treating it as a test target let any
// later exit-0 python invocation falsely clear a red (11885 live shape).
const INTERPRETER_TOKEN_RE = /(?:^|\/)python[\w.]*$/i
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

function isRedTestExecution(exec: SeenRedExecution): boolean {
  if (exec.exitCode === undefined) return false
  if (!TEST_SHAPED_COMMAND_RE.test(exec.command)) return false
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
 * an assistant tool call). Pure: no Effect, no I/O, no commands run. Empty
 * array when nothing is unresolved; at most the LAST 3 otherwise — the most
 * recent evidence, bounded so a repeated-red turn can't flood the nudge.
 *
 * @sem domain=routing role=gate
 */
export function findUnresolvedSeenRed(
  executions: readonly SeenRedExecution[],
  clearedByProbe?: string,
): UnresolvedSeenRed[] {
  const unresolved: UnresolvedSeenRed[] = []
  for (let i = 0; i < executions.length; i++) {
    const exec = executions[i]!
    if (!isRedTestExecution(exec)) continue
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
