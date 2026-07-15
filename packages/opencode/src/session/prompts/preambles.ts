// The turn-scoped preamble the turn driver rides on the system-array tail,
// built from the §1.1/§4.1 turn-read verdict. A null-verdict turn rides NO
// triage preamble (P5 neutral degrade — a wrong guess steers worse than no
// guess), but still rides TEST_EDIT_GATE_RULE alone when the no-test-edit
// gate is armed (prompt.ts guards the injection on testEditGateArmed, not on
// triage having run).
import type { TriageVerdict } from "../turn-triage"
import { verdictIsReadOnly, type ArmingDecision } from "../arming-judge"

// P3 — per-shape playbooks (≤4 lines each), appended when the verdict carries
// the shape. Policy statements only; no special decomposition path — the
// benefit gate still decides whether any fan-out pays.
const RESEARCH_PLAYBOOK = [
  "RESEARCH PLAYBOOK: the deliverable is a CITED digest of external sources (docs/changelogs/web) — name the source next to each fact it grounds; an uncited claim does not count.",
  "Fan out parallel `recon` lookup slices (they run as web-enabled researchers on this turn) ONLY when the questions are genuinely independent; otherwise look it up inline.",
  "Verification is the citation check — never run the test suite to validate a research digest.",
].join("\n")

const REFACTOR_PLAYBOOK = [
  "REFACTOR PLAYBOOK: behavior must NOT change — done when the existing suite is green and no public signature breaks (the edit-time governance gate flags callers at risk).",
  "Type refactor slices `mechanical` (the suite is the safety net); if the work adds behavior, that is a separate build goal — never smuggle it into the refactor.",
].join("\n")

// P4b — the read-only playbook, appended when EVERY goal is read-only
// (qa/research/audit/run-only — no diagnosis/build/refactor goal). It steers the
// conductor to answer-and-stop: the observed over-work was a pure question
// spawning a repro script + tiered verify slices. Positively framed (leads with
// the deliverable, not a "don't") per the negative-constraint caution in the
// variance report — a bare prohibition primes the very token it forbids.
const READ_ONLY_PLAYBOOK = [
  "READ-ONLY TURN: every goal here asks you to answer, locate, explain, review, or run something — not to change code. The turn is DONE the moment the question is answered or the findings are reported.",
  "Investigate with the graph/read tools and reply directly. Authoring a repro script, editing source or tests, and running the full suite are OUT OF SCOPE unless the user explicitly asks — and a question needs no fix to confirm, so do not open todos to 'verify' an answer.",
].join("\n")

/**
 * B3 — the no-test-edit gate's upfront rule, printed as the FIRST line of the
 * turn's model-visible preamble whenever `testEditGateArmed` is true for the
 * session. Injected on BOTH the triage-verdict path (prefixed onto
 * `triagePreamble`'s output) and the P5 neutral-degrade (null-verdict) path,
 * where no other preamble text reaches the model at all — an enhancement-shaped
 * prompt with zero defect words ("Combine fast delete queries") armed the
 * structural gate but the model never saw the rule stated, and rewrote an
 * existing test's expectations to launder a design divergence.
 *
 * @sem domain=routing role=config
 */
export const TEST_EDIT_GATE_RULE =
  "Do not modify existing test files — the grader runs the original tests; fix the source instead. Leave unrelated config files (package manifests, lockfiles, CI configs) alone unless the task itself is about them."

/**
 * §1.1/§4.1 — the turn-scoped preamble built from a non-null turn-read
 * verdict: lists every extracted goal (shape + deliverable) and constraint so
 * the conductor tracks each goal against its own todo instead of collapsing a
 * compound turn into one label. Pure and byte-stable for the turn — the same
 * verdict AND arming decision always yield the same string — so it rides the
 * system-array tail, never a prefix swap (the cached prefix stays stable).
 * Task #52 — when the arming decision flagged the turn
 * ambiguous or hard, appends a decomposition-bias line steering the conductor
 * toward `todowrite` over an inline single-shot, so the work reaches the
 * per-slice tier allocator instead of being authored inline.
 *
 * @sem domain=routing role=config
 */
export function triagePreamble(verdict: TriageVerdict, arming: ArmingDecision): string {
  const lines = [
    `TURN SHAPE: triage (${verdict.goals.length} goal${verdict.goals.length === 1 ? "" : "s"} extracted, confidence=${verdict.confidence}).`,
  ]
  verdict.goals.forEach((goal, i) => {
    const tags = goal.needsPlan ? `${goal.shape}, needs-plan` : goal.shape
    lines.push(`${i + 1}. [${tags}] "${goal.quote}" — done when: ${goal.deliverable || "the goal is satisfied"}`)
  })
  for (const constraint of verdict.constraints) {
    lines.push(`CONSTRAINT (${constraint.kind}): "${constraint.quote}"`)
  }
  lines.push("Track each goal against its own todo; verify each independently — never conflate or drop one for another.")
  if (verdictIsReadOnly(verdict)) lines.push(READ_ONLY_PLAYBOOK)
  if (verdict.goals.some((goal) => goal.shape === "research")) lines.push(RESEARCH_PLAYBOOK)
  if (verdict.goals.some((goal) => goal.shape === "refactor")) lines.push(REFACTOR_PLAYBOOK)
  if (arming.ambiguity === "ambiguous" || arming.hardness === "hard") {
    const flags = [arming.ambiguity === "ambiguous" ? "AMBIGUOUS" : null, arming.hardness === "hard" ? "HARD" : null]
      .filter((x): x is string => x !== null)
      .join("/")
    lines.push(
      `TURN FLAGGED ${flags}: prefer todowrite over inline single-shot handling — decompose so each goal routes through the per-slice tier allocator.`,
    )
  }
  return lines.join("\n")
}
