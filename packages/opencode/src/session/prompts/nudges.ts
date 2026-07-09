// Mid-turn corrective nudges the turn driver injects as synthetic user messages.
import type { StuckSignal } from "../../../../code-intelligence/src/orchestration-fsm"

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
        : signal.reason === "excessive-reread"
          ? "You have re-read the same file many times without acting on what you found."
          : signal.reason === "no-op"
            ? "You have taken several steps without performing any action."
            : "You have repeated the exact same action without making progress."
  if (rung >= 2)
    return `${diagnosis} Stop and reconsider from first principles: re-read the exact failing output and the change you made, identify the SPECIFIC constraint your fix is violating — often a second-order invariant the obvious fix silently breaks — and correct the root cause. Do not repeat the previous approach, and do not weaken or edit the test.`
  return `${diagnosis} Step back and think before acting: state the exact failure, form a hypothesis about the ROOT cause rather than the symptom, and change your approach. Do not repeat the previous action, and do not edit the test to make it pass.`
}

// OL-9.6b length-continuation nudge — injected when a step is cut off by the output-token limit.
export const LENGTH_CONTINUATION_NUDGE =
  "Your previous response was cut off by the output-token limit before any tool call or final answer was produced. Continue from where you stopped: re-issue the intended tool calls or give the final answer, and keep any visible reasoning brief."
