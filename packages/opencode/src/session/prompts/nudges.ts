// Mid-turn corrective nudges the turn driver injects as synthetic user messages.
import type { StuckSignal } from "../../../../code-intelligence/src/orchestration-fsm"
import type { ReproDriftKind } from "../repro-drift"

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

/**
 * Repro-drift nudge (NUDGE_V2 port) — the targeted, once-per-kind steer
 * prompt.ts's SM4 block injects when `classifyReproDrift` (repro-drift.ts)
 * flags a step during the repro pre-pass window. Each names the CONCRETE
 * alternative — a standalone `repro_issue.py` run as its own command — rather
 * than restating the seed's full instructions. The 4th kind,
 * `pinned-repro-deleted`, fires AFTER a pin lands (not during the pre-pass)
 * and takes an optional `context` naming the deleted file and the pinned
 * command the done-gate re-runs; the other three kinds ignore it.
 */
export function reproDriftNudgeText(kind: ReproDriftKind, context?: { file: string; probeCommand: string }): string {
  switch (kind) {
    case "inline-repro":
      return "You ran an inline `python -c`/heredoc command carrying an assertion instead of a file. An inline command cannot be pinned as this turn's verification contract — the turn-end gate has nothing to re-run. Write that exact assertion into a file named `repro_issue.py` at the repo root and run `python repro_issue.py` as its own single command."
    case "suite-edit-denied":
      return "Your edit to the existing test suite was denied by the no-test-edit gate. Modifying the committed suite cannot substitute for a reproduction — creating NEW scratch files is allowed, changing the oracle is not. Write a NEW file, `repro_issue.py` at the repo root (never inside the tests/ tree), importing ONLY from the installed package (never from a tests.* module — define minimal stand-in classes inline if you need one), asserting the issue's expected behavior and run it standalone as `python repro_issue.py`."
    case "unpinnable-red":
      return "Your failing command was a whole-suite run or a multi-line/batched script. Neither can be pinned as this turn's reproduction — the gate needs one single, targeted command to re-run. Isolate the same failure into a single-command file, `repro_issue.py` at the repo root, and run it alone as `python repro_issue.py`."
    case "pinned-repro-deleted":
      return `You deleted \`${context?.file ?? "the pinned repro file"}\`, but it is this turn's pinned verification contract — the done-gate re-runs \`${context?.probeCommand ?? "the pinned command"}\` and a missing file counts as RED. Recreate the file exactly as it was and leave it in place until the turn ends; it is untracked and never enters the patch.`
  }
}

/**
 * Tier-2 repro-drift escalation — fires once per turn when total drift
 * events reach the threshold with still no pin, restating the contract as
 * one stronger combined reminder instead of another per-kind nudge.
 */
export const REPRO_DRIFT_ESCALATION_NUDGE =
  "You have drifted from the repro contract three times without pinning a reproduction — inline commands, a denied suite edit, or an unpinnable run, never a file. " +
  "Write the exact assertion into `repro_issue.py` at the repo root and run it ALONE as `python repro_issue.py`, confirming it is RED before any fix. " +
  "This is the last reminder on this turn."

/**
 * S8 — converge-now nudge: prompt.ts's SM4 block injects this when a
 * bug-shaped turn has landed a source fix but never pinned a reproduction
 * for POST_FIX_CONVERGE_STEPS observed steps — broad "verification" that
 * never converges (django-11790 strict run #3: 38 more minutes of tool calls
 * after a rejected finish, no second finish attempt). Names both concrete
 * exits — a single-file repro run, or an honest finish — rather than another
 * open-ended "keep verifying."
 */
export function convergeNowNudgeText(steps: number): string {
  return `Your source fix landed ${steps} steps ago and no reproduction has been pinned — continued broad verification is not converging. Do ONE of these now: (a) make a single-file repro run — \`repro_issue.py\` at the repo ROOT, one command, \`python repro_issue.py\` — confirming your fix (it must fail on the pre-fix code for the issue's reason); or (b) FINISH: give your final answer now, stating plainly what you verified and what you could not. Do not start any new investigation.`
}

/**
 * S9 — pin-green finish nudge: prompt.ts's SM4 block injects this when the
 * turn's pinned reproduction has already run GREEN after the source fix
 * landed and the model keeps "verifying" broadly for PIN_GREEN_FINISH_STEPS
 * more observed steps (django-11790 strict run #4: green at step 18, 9 more
 * steps of re-running suites, then a step-24 `rm` of the pinned file and a
 * 3600s wall-kill at step 25 — nothing told it the done-gate is now the
 * terminator). Unlike `convergeNowNudgeText`, there is no repro-run
 * alternative to offer — the pin already confirmed green — so this names
 * only the honest finish, plus the one concrete thing NOT to touch.
 */
export function pinGreenFinishNudgeText(probeCommand: string): string {
  return `Your pinned reproduction (\`${probeCommand}\`) ran GREEN after your source fix — the verification contract for this turn is satisfied, and the done-gate will re-run it to confirm. STOP verifying: do not run more suites or probes. Leave the repro file exactly where it is (it is untracked and never enters the patch). Give your final answer now.`
}
