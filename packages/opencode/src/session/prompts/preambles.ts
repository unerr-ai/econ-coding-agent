// The turn-scoped preamble the turn driver rides on the system-array tail,
// built from the §1.1/§4.1 turn-read verdict. A null-verdict turn rides NO
// preamble (P5 neutral degrade) — a wrong guess steers worse than no guess.
import type { TriageVerdict } from "../turn-triage"
import type { ArmingDecision } from "../arming-judge"

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
