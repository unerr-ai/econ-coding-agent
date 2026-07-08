/**
 * Root-turn step observation for the inline-loop stuck supervisor: distils one
 * completed assistant step's tool parts into the StepObservation the supervisor
 * keys on (a re-issued call, a repeated failing result, a test-file edit) plus
 * the shell commands that appear to have failed — the probe-from-red pool the
 * turn-end gate pins a reproduction from. Pure: no Effect, no shell, no session,
 * so it is table-testable; mirrors extractTrajectory's completed-part reading so
 * the two seams agree on what a step is.
 *
 * @sem domain=routing role=digest
 */
import type { StepObservation, StuckSignal } from "../../../code-intelligence/src/orchestration-fsm"
import { isTestFilePath } from "../tool/edit-governance"

const FILE_EDIT_TOOLS = new Set(["edit", "write", "apply_patch"])
const COMMAND_TOOLS = new Set(["shell", "bash"])

// The most identifying string in a non-edit, non-command tool's input. Reads,
// searches, and sub-agent spawns (read/grep/glob/list/task/webfetch/…) are
// tracked by tool + this key so DIVERSE exploration yields DIVERSE signatures.
// Without it every read-only step collapsed to the same empty signature and a
// short burst of them falsely tripped the resultless repeated-tool detector
// (run 11885: a conductor reading files and spawning an @explorer escalated to
// the reasoner before running a single test — a 3× cost regression for no gain).
const IDENTITY_KEYS = ["filePath", "path", "pattern", "query", "url", "description", "prompt"]
function identifyingInput(input: Record<string, unknown>): string {
  for (const key of IDENTITY_KEYS) {
    const value = input[key]
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 200)
  }
  return ""
}

/** Minimal structural view of a completed tool part — mirrors slice-orchestrator's ToolPartLike, plus the result output. */
interface ToolPartLike {
  type: string
  tool?: string
  state?: { status?: string; input?: Record<string, unknown>; output?: string }
}

// A command "failed" when the tool errored or its output carries a failure
// marker. Deliberately generous: this only decides whether a command is worth
// re-running as a probe candidate — deriveTurnProbe re-runs it and the actual
// exit code is the authority on red/green.
const FAILURE_RE =
  /\b(?:FAILED|FAIL|ERROR|ERRORS|Traceback|AssertionError|Exception|panic:|\d+\s+failed|not ok|assertion\s+failed)\b/i

function looksFailed(status: string, output: string): boolean {
  if (status === "error") return true
  return FAILURE_RE.test(output)
}

/**
 * Strip run-to-run noise (durations, timestamps, hex addresses, temp paths) so
 * an identical failure hashes identically across re-runs while its assertion
 * text — the actual signal — survives. Capped so a huge log can't dominate the
 * signature.
 */
export function normalizeResult(output: string): string {
  return output
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|seconds?|minutes?)\b/gi, "·t")
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}\S*/g, "·ts")
    .replace(/0x[0-9a-fA-F]+/g, "·hex")
    .replace(/(?:\/tmp\/|\/private\/|\/var\/folders\/)\S+/g, "·tmp")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000)
}

export interface StepObservationResult {
  observation: StepObservation
  /**
   * Commands the step ran that appear to have failed, in order — the
   * probe-from-red candidate pool. deriveTurnProbe filters these to test
   * reproductions and confirms redness by re-running, so false positives here
   * are harmless.
   */
  failedCommands: string[]
}

/**
 * Distil one completed assistant step's parts into a StepObservation plus the
 * shell commands that looked like failures. `isTestSlice` suppresses the
 * test-file-edit tell for a turn where editing tests is legitimate (the gate is
 * not armed), so it never misreads sanctioned test work as fake-green.
 */
export function observeStep(parts: readonly unknown[], opts?: { isTestSlice?: boolean }): StepObservationResult {
  const toolTokens: string[] = []
  const resultTokens: string[] = []
  const failedCommands: string[] = []
  let editedTestFile: string | undefined
  let ranCommand = false

  for (const raw of parts) {
    const part = raw as ToolPartLike
    if (part?.type !== "tool" || !part.tool) continue
    const status = part.state?.status ?? "completed"
    if (status !== "completed" && status !== "error") continue
    const input = part.state?.input ?? {}

    if (FILE_EDIT_TOOLS.has(part.tool)) {
      const filePath = (input["filePath"] ?? input["path"]) as string | undefined
      toolTokens.push(`${part.tool}:${filePath ?? ""}`)
      // Only a completed edit to a tracked test file, on a turn that forbids
      // test edits, is the fake-green tell — a denied attempt (status "error")
      // never modified anything and a sanctioned test turn is exempt.
      if (!opts?.isTestSlice && status === "completed" && filePath && !editedTestFile && isTestFilePath(filePath))
        editedTestFile = filePath
    } else if (COMMAND_TOOLS.has(part.tool)) {
      const command = typeof input["command"] === "string" ? (input["command"] as string).trim() : ""
      if (!command) continue
      ranCommand = true
      const output = typeof part.state?.output === "string" ? part.state.output : ""
      toolTokens.push(`${part.tool}:${command}`)
      resultTokens.push(`${status}|${normalizeResult(output)}`)
      if (looksFailed(status, output)) failedCommands.push(command)
    } else {
      // Any other tool (read/grep/glob/list/task/webfetch/…) still distinguishes
      // the step: track it by tool + its most identifying input so a burst of
      // varied exploration reads as varied, not as a repeat. These run no command,
      // so they stay resultless and never touch the red tally.
      toolTokens.push(`${part.tool}:${identifyingInput(input)}`)
    }
  }

  return {
    observation: {
      toolSignature: toolTokens.join("|"),
      // Only a step that ran a command carries a result signature — an
      // edit-only or read-only step leaves the red tally untouched, which is
      // how the supervisor tolerates interleaved edits between re-runs.
      resultSignature: ranCommand ? resultTokens.join("|") : undefined,
      editedTestFile,
    },
    failedCommands,
  }
}

/**
 * The rethink message injected when the supervisor flags a stuck loop. As a
 * USER message it also reads as a plan step to the adaptive reasoning gate, so
 * the conductor's thinking un-mutes for the next step. Rung 2 (the model is
 * also bumped to the reasoner) asks for a first-principles root-cause pass; both
 * rungs forbid repeating the last action or editing the test to pass.
 */
export function stuckNudgeText(signal: StuckSignal, rung: number): string {
  const diagnosis =
    signal.reason === "test-edit"
      ? "You modified a test file. Editing the test to make it pass is not a fix — the grader runs the original tests, so a green suite over an edited test is invalid."
      : signal.reason === "repeated-red"
        ? "You have hit the same failure repeatedly without resolving it."
        : signal.reason === "repeated-tool"
          ? "You have repeated the same action without making progress."
          : "The last several steps made no measurable progress."
  if (rung >= 2)
    return `${diagnosis} Stop and reconsider from first principles: re-read the exact failing output and the change you made, identify the SPECIFIC constraint your fix is violating — often a second-order invariant the obvious fix silently breaks — and correct the root cause. Do not repeat the previous approach, and do not weaken or edit the test.`
  return `${diagnosis} Step back and think before acting: state the exact failure, form a hypothesis about the ROOT cause rather than the symptom, and change your approach. Do not repeat the previous action, and do not edit the test to make it pass.`
}
