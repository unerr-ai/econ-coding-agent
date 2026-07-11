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

/**
 * L4.2 — the message injected when the grind valve opens (turn-supervisor.ts
 * `createGrindValve`): the turn crossed its soft step budget with no green
 * verify in the stall window, and a reasoner design pre-pass todo was planted
 * (the slice hook dispatches it automatically). As a USER message it also
 * un-mutes the conductor's thinking, same as the stuck-ladder nudge above.
 */
export function grindValveNudgeText(signal: { step: number; stepsSinceGreen: number }): string {
  return `You have taken ${signal.step} steps this turn and none of the last ${signal.stepsSinceGreen} produced a passing verification — this approach is grinding, not converging. A design pre-pass has been added to your todo list and will run automatically; it returns a concrete fix design (the files to change, the edits, the invariants to preserve, and the verify commands). STOP making code edits until that design comes back, then execute it step by step and verify. Do not remove the design item from the todo list.`
}

/**
 * L1.2c — the message injected when the batch-momentum watcher fires
 * (turn-supervisor.ts `createBatchMomentumWatcher`): the transcript shows a
 * run of single-call steps, which in-context trains the model out of the
 * batching it does natively on a clean transcript (fw-batch-probe 2026-07-10:
 * poisoned history 2/6 batched despite BATCH_RULE, tail reminder 6/6). Recency
 * does the work the system-prompt rule cannot — this restates the doctrine's
 * self-check at the moment of choice, not its full definition (BATCH_RULE in
 * prompts/fragments.ts stays the single source). L1.4 adds the probe-script
 * alternative (PROBE_SCRIPT_RULE, same source file) as a short pointer, not a
 * restatement of its full definition either.
 */
export function batchMomentumNudgeText(signal: { consecutiveSingleCalls: number }): string {
  return `ECONOMY CHECK: your last ${signal.consecutiveSingleCalls} messages each carried exactly ONE tool call — that many paid round trips where fewer would do. Apply the BATCH RULE now: name every independent read/search/command you already know you need, then issue them ALL as tool calls in this ONE message; they run together and the results come back together — or better: one read-only bash script that runs every known probe with labeled sections, if what you know you need is 3+ shell probes (tests, git, builds, file stats) rather than reads. Only a true dependency chain — the next call needs this call's output — justifies another single-call message.`
}

/**
 * S5 — the message injected when the stuck supervisor reclassifies a
 * repeated-red streak as environment slowness (a command ran >=60s each time,
 * the shared-CPU starvation signature). The machine is slow, not the
 * approach wrong — steer toward narrower, cheaper commands instead of
 * escalating models.
 */
export const ENVIRONMENT_SLOW_NUDGE =
  "This machine is running commands SLOWLY (the same command failed repeatedly, each run taking 60s+). Treat it as environment slowness, not a wrong approach: run the single NARROWEST test target (one test method, not a suite), raise the per-command timeout, and never re-run a command whose output you already have."
