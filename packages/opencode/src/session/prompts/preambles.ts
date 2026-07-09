// The turn-scoped preambles the turn driver rides on the system-array tail:
// the §8 casting playbook per turn shape, and the §1.1/§4.1 triage preamble
// that replaces it whenever turn triage returned a verdict.
import type { TurnShapeCategory } from "../slice-orchestrator"
import type { TriageVerdict } from "../turn-triage"
import type { ArmingDecision } from "../arming-judge"

// One casting playbook per shape (§8): ≤4 lines each, appended to the turn's
// system array tail — never a prefix swap. Tier-speak only.
const CATEGORY_PREAMBLE: Record<TurnShapeCategory, string> = {
  "diagnosis-vague": [
    "TURN SHAPE: diagnosis (vague symptom — no site named).",
    "A localization/plan pre-pass frames this turn; do not anchor on a cause before its result folds back.",
    "Accept a defect site only with a discriminating probe result attached — never narrative alone.",
    "If evidence contradicts the frame, enumerate at least two candidate layers with a cheap probe each.",
  ].join("\n"),
  "diagnosis-grounded": [
    "TURN SHAPE: diagnosis (grounded — the prompt names the site).",
    "Verify the named site before editing: one discriminating probe that confirms the mechanism, then the fix.",
    "Confirm the named site is the CAUSE, not just where the symptom surfaces — trace one edge upstream before editing; keep exploration to that confirmation.",
  ].join("\n"),
  build: [
    "TURN SHAPE: build.",
    "Type the plan: write the full pending list first; decided changes become typed slices and parallel-eligible slices run as a DAG.",
    "Give every check-run item a real runnable command — a verify slice without one cannot reject.",
    "If the build uncovers a defect, localize its cause before patching — do not fix the first symptom site.",
  ].join("\n"),
  audit: [
    "TURN SHAPE: audit.",
    "Judgment items are dispatched reasoner slices — never judge inline; synthesis composes the slice verdicts.",
    "Keep your own steps to dispatch and relay.",
  ].join("\n"),
  qa: [
    "TURN SHAPE: Q&A.",
    "Answer directly with the graph/read tools; no decomposition, no todo slices, no plan.",
    "Prefer the smallest read that answers — an explorer child only for a genuinely broad sweep.",
  ].join("\n"),
}

/**
 * §8 rule 4 — the turn-scoped category preamble. Pure so the prompt seam and
 * tests share one source of truth.
 *
 * @sem domain=routing role=config
 */
export function categoryPreamble(category: TurnShapeCategory): string {
  return CATEGORY_PREAMBLE[category]
}

/**
 * §1.1/§4.1 — the turn-scoped preamble built from a non-null triage verdict:
 * lists every extracted goal (shape + deliverable) and constraint so the
 * conductor tracks each goal against its own todo instead of collapsing a
 * compound turn into one label. Pure and byte-stable for the turn — the same
 * verdict AND arming decision always yield the same string — so it rides the
 * system-array tail exactly like `categoryPreamble`, replacing it whenever
 * triage is non-null. Task #52 — when the arming judge flagged the turn
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
