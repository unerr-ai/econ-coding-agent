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
}

/**
 * The narrow slice the orchestration doors consume (skeleton seed gate,
 * autoTypeTodos net, and — via the arming store — the per-slice difficulty
 * floor `todosToLoopSlices` reads). `ambiguity` is optional so an older
 * caller/test double built before it existed still type-checks.
 */
export type ArmingDecision = Pick<ArmingVerdict, "armLocalization" | "hardness"> & { ambiguity?: ArmingAmbiguity }

const HARDNESS_RANK: Record<ArmingHardness, number> = { trivial: 0, moderate: 1, hard: 2 }

/** The shapes localization applies to — build/audit/qa/run-only never arm. */
function isDiagnosisGoal(goal: TriageGoal): boolean {
  return goal.shape === "diagnosis-vague" || goal.shape === "diagnosis-grounded"
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
 * A null verdict stands down entirely — the P5 neutral degrade never guesses.
 *
 * @sem domain=routing role=router
 */
export function decideArming(verdict?: TriageVerdict | null): ArmingVerdict {
  if (!verdict || verdict.goals.length === 0) {
    return {
      armLocalization: false,
      localized: true,
      hardness: "moderate",
      ambiguity: "clear",
      evidence: "no turn-read verdict — arming stands down",
    }
  }

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
