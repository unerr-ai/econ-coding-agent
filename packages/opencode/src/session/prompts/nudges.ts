// Mid-turn corrective nudges the turn driver injects as synthetic user messages.
import type { StuckSignal } from "../../../../code-intelligence/src/orchestration-fsm"
import type { ReproDriftKind } from "../repro-drift"
import type { FamilyConflictEvidence } from "../../tool/convention-divergence"

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
 * Wave 7 — the message injected when the hub-shopping trigger's synchronous
 * design call (prompt.ts's `hubDesignDispatch`) returns a real verdict: the
 * session has now bounced two DISTINCT hub files, the tell that the model is
 * moving the same wrong-layer fix to another shared module instead of
 * reconsidering where it belongs. Unlike Wave 6's todo-plant (which the
 * conductor could clobber/ignore), the decided fix site is now INSIDE the
 * nudge itself — file, entity, and change — with a documented-deviation
 * escape hatch instead of blind compliance.
 */
export function hubDesignVerdictNudgeText(
  verdict: { file: string; entity: string; change: string },
  bouncedFiles: string[],
): string {
  return `Your edits have twice landed on shared hub modules (${bouncedFiles.join(", ")}) — that is symptom-layer avoidance. A root-cause design pass (reasoner tier) has decided the fix site: edit ${verdict.file} — ${verdict.entity}: ${verdict.change}. Implement the fix AT this site now. The hub gate stays armed; edits at other shared files will keep bouncing. If this site proves genuinely impossible, state why in one line before deviating.`
}

/**
 * Wave 7 — the message injected when the hub-shopping trigger's design call
 * degrades (model/language unresolved, or the judge itself produced no
 * verdict): no design to hand back, so the nudge falls back to asking the
 * model to re-derive the fix site itself under the same never-a-coercion
 * constraint the judge would otherwise have enforced. Wave 8d: when the
 * session's defining-file allowlist has resolved, the nudge names those
 * candidates concretely instead of asking the model to re-derive them.
 */
export function hubDesignDegradedNudgeText(bouncedFiles: string[], rootMostCandidates: readonly string[] = []): string {
  const opening = `Your edits have twice landed on shared hub modules (${bouncedFiles.join(", ")}) — that is symptom-layer avoidance. `
  if (rootMostCandidates.length === 0) {
    return `${opening}Re-derive the fix site yourself before any further edit: name the module that DEFINES the misbehaving class or function the issue names, and fix its behavior THERE — never a coercion at a consumption site.`
  }
  return `${opening}Per the code graph, the symbols this issue names are defined in: ${rootMostCandidates.join(", ")}. The root-most of these is the fix site — fix the misbehaving class or function's own behavior THERE, never a coercion at a consumption site.`
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

/**
 * F9a — repro-fidelity nudge: prompt.ts's SM4 pin-from-red site injects this
 * once, when the repro-fidelity judge (repro-fidelity-judge.ts) reports
 * `faithful:false` on the reproduction just pinned. Names the concrete gaps,
 * why a green fix can still fail the real grader anyway (a
 * rendered/serialized/printed value can look right while the underlying
 * type or object is wrong, and a quoted expression with no dedicated assert
 * is silently unverified), and the one action to take: add the missing
 * asserts, re-run the repro, and confirm it is STILL RED on the unpatched
 * code for the NEW asserts too — a repro edited after the fix can only ever
 * run green.
 */
export function reproFidelityNudgeText(gaps: string[]): string {
  const list = gaps.map((gap) => `- ${gap}`).join("\n")
  return `Your pinned reproduction misses part of the issue's real expectation:\n${list}\nA green fix can still fail the real grader while these gaps stand — a rendered/serialized/printed value can look right even when the underlying type or object is wrong, and an expression the issue explicitly names needs its own assert, not just a downstream effect. Add the missing asserts to the pinned reproduction file now, re-run it, and confirm it is STILL RED on the unpatched code for these NEW asserts too before you continue. Verify each gap above against the issue text yourself first — ignore any gap here that asserts something the issue itself does not state.`
}

/**
 * F15c — toothless-repro nudge: prompt.ts's pin sites inject this once, when
 * the about-to-be-pinned repro script has no assertion teeth
 * (`hasAssertionTeeth` in repro-fidelity-judge.ts) — a print-only script that
 * always exits 0 can never fail, so it forms an unfalsifiable verification
 * contract and the pin is refused rather than landed. Names the one concrete
 * fix rather than a generic "verify better."
 */
export function toothlessReproNudgeText(script: string): string {
  return `Your reproduction script (\`${script}\`) only prints — it can never fail, so it was not pinned. Add an assertion (or a non-zero exit) that fails while the bug is present, run it again, and it will be pinned.`
}

/**
 * S3 — unverified-finish nudge: prompt.ts's finish-time block injects this
 * on each rejected finish arrival for a bug-shaped turn with no verified
 * reproduction / no source change, up to MAX_UNVERIFIED_FINISH_ATTEMPTS
 * times (django-11848 iter-3: the old once-nudge model let a second silent
 * arrival fail open loud with source edits shipped and no repro ever run).
 * `attempt` 1 keeps the original ask-for-a-repro wording plus any S4
 * unresolved-block fold-in; attempt 2+ escalates to the explicit either/or
 * contract from the repro seed's own escape hatch (seeds.ts
 * REPRO_SLICE_CONTENT point 6) — build and run the repro, or mark the repro
 * todo cancelled with a one-line reason — so a still-silent model can no
 * longer plausibly claim it didn't know cancellation was a legitimate exit.
 */
export function unverifiedFinishNudgeText(attempt: number, blockLines?: string): string {
  if (attempt <= 1) {
    return (
      "You are finishing a bug-fix task with NO verified reproduction / NO source change. Author a minimal repro script asserting the issue's EXPECTED behavior, RUN it, and report the result. If it fails, your fix is incomplete." +
      (blockLines ? `\n${blockLines}` : "")
    )
  }
  return `You are finishing a bug-fix task with NO verified reproduction / NO source change (rejection ${attempt}). You cannot finish silently: build the repro and run it red→green, or mark the repro todo cancelled with a one-line reason.`
}

/**
 * F18 — seen-red nudge: prompt.ts's finish-time block injects this once,
 * when `findUnresolvedSeenRed` (seen-red.ts) finds a test/repro run the
 * turn's own transcript shows went red and was never re-run green. Names
 * each command plus its evidence tail so the model can't claim it never saw
 * the failure — the django-11790 shape (a mid-turn pytest run failed, was
 * never re-run, and the patch shipped anyway).
 */
export function seenRedUnresolvedNudgeText(unresolved: readonly { command: string; outputTail: string }[]): string {
  const single = unresolved.length === 1
  const list = unresolved.map((u) => `\`${u.command}\`:\n${u.outputTail}`).join("\n\n")
  return `You saw ${single ? "this command" : "these commands"} fail mid-turn and never re-ran ${single ? "it" : "them"} green:\n${list}\nRe-run ${single ? "it" : "each of them"} now (fixing the underlying issue first if it is still failing) and confirm GREEN before finishing.`
}

/**
 * F18b — seen-red oracle-inversion nudge: prompt.ts's finish-time block
 * injects this once instead of the confirm-GREEN demand above, when
 * `partitionSeenRedByInversion` (seen-red.ts) finds a red from a COMMITTED
 * visible test whose failure shows the code PRODUCING the issue's stated
 * desired value while the assertion still expects the value the issue calls
 * wrong. The 2026-07-15 11815 shape: the agent applied the general
 * gold-equivalent fix, the stale committed suite went red on it, and the
 * confirm-GREEN nudge forced a retreat to a narrowed conditional patch.
 * This nudge sanctions that red explicitly — keep the general fix, never
 * narrow it, state the conflict — the same senior-oracle rule the
 * no-test-edit denial and the localization seed's EXCEPTION already name.
 */
export function seenRedInversionNudgeText(
  sanctioned: readonly { command: string; desiredLiteral?: string; buggyLiteral?: string }[],
): string {
  const single = sanctioned.length === 1
  const list = sanctioned
    .map((s) => {
      const evidence =
        s.desiredLiteral && s.buggyLiteral
          ? ` — your code now produces \`${s.desiredLiteral}\` (the issue's stated desired form) while the committed test still expects \`${s.buggyLiteral}\` (the value the issue calls wrong)`
          : ""
      return `\`${s.command}\`${evidence}`
    })
    .join("\n")
  return (
    `${single ? "This red is" : "These reds are"} SANCTIONED — do NOT make ${single ? "it" : "them"} green:\n${list}\n` +
    `The committed test's expectation contradicts the issue's stated desired output, so the ISSUE is the spec and that assertion is stale (the grader supplies a corrected oracle). ` +
    `Keep your fix GENERAL: do not narrow it with type or condition guards, and do not rework it, just to satisfy the contradicting assertion. ` +
    `Leave ${single ? "that test" : "those tests"} red, and state the conflict plainly in your final answer with the evidence above.`
  )
}

/**
 * Wave 10 — unverified-finish-gate nudge: prompt.ts's finish-time block
 * injects this once, when a FIX-SHAPED root turn lands a non-test source
 * edit with ZERO real test executions anywhere in its own transcript (the
 * 11885 autopsy: a 36-line deletion.py patch shipped after only
 * `py_compile`, whose one `runtests.py`-matching command was
 * `cat tests/runtests.py` — a read, never a run). `command` is the concrete
 * verify command derived from the edited files (`probeSliceVerifyCommands`,
 * graph-tools.ts) when the graph can find one; undefined falls back to a
 * generic ask.
 */
export function unverifiedFinishGateNudgeText(command?: string): string {
  return command
    ? `You are finishing after making source changes with NO test execution anywhere in this turn. Run \`${command}\` now, confirm the result, and only then give your final answer.`
    : "You are finishing after making source changes with NO test execution anywhere in this turn. Run the project's test suite for the modules you changed, then finish."
}

/**
 * Wave 11 stage 2 — convention-divergence gate nudge: edit.ts/write.ts throw
 * this once per session, at the moment `detectReceiverMethodDivergence`
 * (convention-divergence.ts) flags an added `<receiver>.<method>(...)` call
 * whose receiver is already established in the file but never paired with
 * this method before (the django-11848 A4 red shape). Never names the right
 * answer or an alternative — only points back at the file's own existing
 * usage and asks for a re-read; an identical retry is accepted.
 */
export function conventionDivergenceNudgeText(receiver: string, method: string, receiverSites: number[]): string {
  return `Verification pause (fires once per task): this edit calls \`${receiver}.${method}(...)\` — a method this file has never used — while the file already uses \`${receiver}\` at line(s) ${receiverSites.join(", ")}. Re-read the entity you are editing and this file's existing usage, including comments and docstrings, and confirm the right variant for THIS code. Then retry; an identical retry will be accepted.`
}

/**
 * Round-F §7 stage 3 — convention-divergence gate's evidence-bearing SECOND
 * pause: fires once, on the identical retry that follows the first deny,
 * only when the divergence's method belongs to a known ambiguous semantic
 * family AND the file itself carries opposite-member evidence
 * (`detectFamilyConflictEvidence` in convention-divergence.ts). Quotes that
 * evidence verbatim — the other family member's call-site line numbers, or
 * the docstring/comment token — so the agent isn't asked to re-derive it,
 * and states the fail-open floor: a third identical attempt is accepted.
 */
export function conventionDivergenceSecondDenyNudgeText(
  receiver: string,
  method: string,
  evidence: FamilyConflictEvidence,
): string {
  const evidenceText =
    evidence.kind === "call"
      ? `this file also calls \`${receiver}.${evidence.member}(...)\` at line(s) ${(evidence.lines ?? []).join(", ")}`
      : `this file's own comments/docstring mention "${evidence.token}" near \`${receiver}\`'s existing use`
  return `Second verification pause: \`${receiver}.${method}(...)\` belongs to a family of mutually-ambiguous variants, and ${evidenceText} — evidence the two are not interchangeable here. Re-read this file's existing usage and confirm \`${method}\` is really the right variant before retrying. An identical retry after this second pause will be accepted.`
}
