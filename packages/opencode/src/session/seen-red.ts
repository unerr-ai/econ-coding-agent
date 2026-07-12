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

/** The path/pytest-id/dotted-label tokens a command names as its test target(s); empty when none are extractable (the caller falls back to exact-command matching). */
function extractTestTargetTokens(command: string): string[] {
  const tokens = command.split(/\s+/).filter(Boolean)
  const runnerIdx = tokens.findIndex((t) => TEST_RUNNER_TOKEN_RE.test(t))
  const targets = new Set<string>()
  tokens.forEach((raw, i) => {
    const token = raw.replace(/^['"]|['"]$/g, "")
    if (TEST_RUNNER_TOKEN_RE.test(token)) return // the runner script itself, never a target
    if (PATH_LIKE_TOKEN_RE.test(token) || PY_FILE_TOKEN_RE.test(token) || PYTEST_ID_TOKEN_RE.test(token)) {
      targets.add(token)
    } else if (runnerIdx !== -1 && i > runnerIdx && DOTTED_LABEL_RE.test(token)) {
      // A dotted test label (e.g. `app.tests.SomeTest.test_x`) only counts
      // as a target when it trails the runner — a stray dotted-looking
      // argument ahead of it (a version pin, a path fragment) must not.
      targets.add(token)
    }
  })
  return [...targets]
}

function isRedTestExecution(exec: SeenRedExecution): boolean {
  if (exec.exitCode === undefined || exec.exitCode === 0) return false
  if (!TEST_SHAPED_COMMAND_RE.test(exec.command)) return false
  if (!TEST_FAILURE_SIGNATURE_RE.test(exec.output)) return false
  // Env-red (a missing file/module) is a broken environment, not an
  // unverified fix — the same discipline `selectRegressionPinCandidate`
  // (regression-neighbors.ts) applies to a regression-gate failure.
  if (MISSING_FILE_RE.test(exec.output) || MODULE_MISSING_RE.test(exec.output)) return false
  return true
}

/** Whether `candidateCommand` clears a red execution's `command`/`targets` — an exact match always clears; a token-shared match only when targets were extractable. */
function clears(targets: readonly string[], command: string, candidateCommand: string): boolean {
  if (candidateCommand === command) return true
  if (targets.length === 0) return false
  const candidateTargets = extractTestTargetTokens(candidateCommand)
  return targets.some((token) => candidateTargets.includes(token))
}

function outputTail(output: string): string {
  return output.trim().split("\n").slice(-OUTPUT_TAIL_LINES).join("\n")
}

/**
 * The turn's red test/repro runs that were never re-run green — the
 * finish-time signal the M4/S3/F11 gates each miss (none of them replay the
 * transcript). A red is cleared by a LATER green execution sharing a test
 * target (or an exact command match), or by `clearedByProbe` (the M4 gate's
 * own re-run, which happens outside the transcript entirely since it shells
 * out directly rather than going through an assistant tool call). Pure: no
 * Effect, no I/O, no commands run. Empty array when nothing is unresolved.
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
      .some((later) => later.exitCode === 0 && clears(targets, exec.command, later.command))
    if (clearedLater) continue
    unresolved.push({ command: exec.command, outputTail: outputTail(exec.output) })
  }
  return unresolved
}
