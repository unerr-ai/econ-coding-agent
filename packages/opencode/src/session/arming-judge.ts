/**
 * §1.1b arming decision (P1-alt) — whether a turn needs a LOCALIZATION
 * PRE-PASS (a dedicated step that finds the root-cause code location BEFORE
 * any fix is written) is decided in CODE, not by a model: `decideArming` is a
 * pure table over the turn-read verdict's extracted evidence
 * (turn-triage.ts). The model reports facts per diagnosis goal —
 * locationNamed / fixSpecified (verbatim quotes) plus the judged
 * hardness/ambiguity — and this function applies the policy. Misapplied
 * prose rules (the django-12039 class: a trivial, file-named fix cascading
 * to the oracle) are structurally impossible; policy changes are code
 * review; the rig's decision tests are table tests. Both localization doors
 * consume ONE decision: the turn-open skeleton (buildTriageTodoSkeleton) and
 * the todowrite net (autoTypeTodos), bridged mid-turn by arming-store.ts.
 *
 * @sem domain=routing role=router
 */
import type { ArmingAmbiguity, ArmingHardness, TriageGoal, TriageVerdict } from "./turn-triage"

/** The arming decision: the single evidence-grounded verdict both localization doors read. */
export interface ArmingVerdict {
  /** THE decision — plant a localization pre-pass before any fix is attempted. */
  readonly armLocalization: boolean
  /** Do we already know WHERE to fix — every diagnosis goal names a concrete location? */
  readonly localized: boolean
  readonly hardness: ArmingHardness
  readonly ambiguity: ArmingAmbiguity
  /** The exact evidence spans that decided the call — makes it auditable, never invented. */
  readonly evidence: string
  /**
   * True ONLY on `DEGRADED_ARMING` (turn-read verdict === null); absent/false on
   * every computed verdict. Downstream (runConductorOrchestration) reads it to
   * hold the conductor INLINE for the whole turn — a degraded turn's mid-turn
   * todos never orchestrate into tiered slices; the grind valve is the sole
   * escape hatch. See `DEGRADED_ARMING`.
   */
  readonly degraded?: boolean
}

/**
 * The narrow slice the orchestration doors consume (skeleton seed gate,
 * autoTypeTodos net, and — via the arming store — the per-slice difficulty
 * floor `todosToLoopSlices` reads). `ambiguity` is optional so an older
 * caller/test double built before it existed still type-checks.
 */
export type ArmingDecision = Pick<ArmingVerdict, "armLocalization" | "hardness"> & {
  ambiguity?: ArmingAmbiguity
  /** True only on the degraded (null turn-read) posture — the orchestration hook's inline-stand-down flag. See `DEGRADED_ARMING`. */
  degraded?: boolean
}

const HARDNESS_RANK: Record<ArmingHardness, number> = { trivial: 0, moderate: 1, hard: 2 }

/** The shapes localization applies to — build/refactor/audit/qa/research/run-only never arm. */
function isDiagnosisGoal(goal: TriageGoal): boolean {
  return goal.shape === "diagnosis-vague" || goal.shape === "diagnosis-grounded"
}

/**
 * The ONE posture a degraded/absent turn-read resolves to (P5) — the single
 * source of truth for "no verdict", so no consumer synthesizes its own guess.
 * The full degraded policy is CHEAPEST POSTURE AND NO MID-TURN DECOMPOSITION:
 *  - Cheapest posture: localization stands down (`armLocalization:false`) and
 *    every difficulty signal reads at its FLOOR (`hardness:"trivial"`,
 *    `ambiguity:"clear"`), below the `hard`/`ambiguous` threshold every lift
 *    consumer gates on — the per-slice difficulty floor (allocation.ts), the
 *    turn reasoning un-mute (llm/request.ts), the resolution decompose gate
 *    (resolution-phase.ts).
 *  - No decomposition: `degraded:true` flags the turn so runConductorOrchestration
 *    keeps the conductor INLINE — its own mid-turn todos are tracked but never
 *    flow through todosToLoopSlices/shouldOrchestrate into tiered slices. On the
 *    2026-07-10 11964 fire a degraded turn-read decomposed an ex-conductor-solo
 *    ticket ($0.0985 solo) into reasoner/oracle slices via the allocator's
 *    structural cells, costing $0.3467 (3.5×) for zero quality gain.
 * The ONLY way up on a degraded turn is the grind valve (turn-supervisor.ts
 * createGrindValve): a 60-step stall with no green verify plants a reasoner
 * design prepass (GRIND_DESIGN_SLICE_CONTENT) that DOES orchestrate — escalation
 * on OBSERVED evidence, not a turn-open guess. Default-cheap-with-escalation is
 * the established cascade posture (FrugalGPT / RouteLLM / MinionS): misrouting
 * easy work to the expensive tier is the 20–100× costlier error versus
 * escalating on failure evidence.
 *
 * @sem domain=routing role=config
 */
export const DEGRADED_ARMING: ArmingVerdict = {
  armLocalization: false,
  localized: true,
  hardness: "trivial",
  ambiguity: "clear",
  degraded: true,
  evidence: "no turn-read verdict — degrade to the cheapest posture, localization stands down",
}

/**
 * THE arming decision, pure over extracted evidence. Per diagnosis goal:
 *
 *   arm = !fixSpecified && (!locationNamed || hardness === "hard")
 *
 * OR-ed across goals — a handed fix is an executor grep (no pre-pass even
 * with no file named); a named location skips the pre-pass unless the bug is
 * judged hard (knowing the file is not knowing the mechanism); anything else
 * arms. `localized` = every diagnosis goal names a location. Missing/invalid
 * evidence reads as the conservative posture (unlocated, no handed fix ⇒
 * arm) — a cheap pre-pass beats an expensive wrong guess. Turn-level
 * `hardness` is the max judged hardness, floored to "hard" by any needsPlan
 * goal (feeds the per-slice difficulty floor and the reasoning un-mute);
 * `ambiguity` ORs the per-goal judgement with a low-confidence extraction.
 * A null verdict resolves to `DEGRADED_ARMING` — the cheapest posture
 * (localization stood down, hardness/ambiguity at the floor), so a missing
 * turn-read can never lift work off the conductor, never a guess.
 *
 * @sem domain=routing role=router
 */
export function decideArming(verdict?: TriageVerdict | null): ArmingVerdict {
  if (!verdict || verdict.goals.length === 0) return DEGRADED_ARMING

  const diagnosis = verdict.goals.filter(isDiagnosisGoal)
  const anyNeedsPlan = verdict.goals.some((g) => g.needsPlan === true)

  let arm = false
  let localized = true
  let judgedAmbiguous = false
  let maxHardness: ArmingHardness | undefined
  const grounds: string[] = []
  for (const goal of diagnosis) {
    const ev = goal.evidence
    const locationNamed = ev?.locationNamed === true
    const fixSpecified = ev?.fixSpecified === true
    if (!locationNamed) localized = false
    if (ev?.hardness && (maxHardness === undefined || HARDNESS_RANK[ev.hardness] > HARDNESS_RANK[maxHardness]))
      maxHardness = ev.hardness
    if (ev?.ambiguity === "ambiguous") judgedAmbiguous = true
    if (!fixSpecified && (!locationNamed || ev?.hardness === "hard")) arm = true
    grounds.push(
      fixSpecified
        ? `fix handed: "${ev?.fixQuote ?? ""}"`
        : !locationNamed
          ? ev
            ? `no location named: "${goal.quote}"`
            : `no evidence extracted: "${goal.quote}"`
          : ev?.hardness === "hard"
            ? `located ("${ev?.locationQuote ?? ""}") but judged hard`
            : `location named: "${ev?.locationQuote ?? ""}"`,
    )
  }

  return {
    armLocalization: arm,
    localized,
    hardness: anyNeedsPlan ? "hard" : (maxHardness ?? (arm ? "moderate" : "trivial")),
    ambiguity: judgedAmbiguous || verdict.confidence === "low" ? "ambiguous" : "clear",
    evidence: diagnosis.length === 0 ? "no diagnosis-shaped goal — localization does not apply" : grounds.join("; "),
  }
}
