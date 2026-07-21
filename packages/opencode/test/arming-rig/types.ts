// Interface contract for the arming-rig — the offline harness that exercises
// the localization-arming decision (Door 1 = the turn-open skeleton, Door 2 =
// autoTypeTodos) over a labeled corpus: mock turn-read verdicts carry the
// P1-alt per-goal evidence, and the PURE `decideArming` table converts it
// into the decision. P4 rows also exercise the continuation path: the pre-LLM
// short-circuit predicate and the turnRole-driven inherit-don't-recompute
// flow. Do NOT put logic here — contract only.
import type { TriageVerdict, TriageGoalShape } from "../../src/session/turn-triage"
import type { OrchestrationTodo } from "../../src/session/slice-orchestrator"

/**
 * One isolated arming scenario: a task prompt (+ optional conductor-authored todos for
 * the Door-2 net, + optional mocked triage verdict for deterministic mode) and the door
 * outcome we expect. The rig runs the arming pipeline and scores `localizationArmed`
 * on the seeds THIS TURN plants (a seed already present in `todos` — e.g. a settled
 * pre-pass from the prior turn — never counts as armed).
 */
export interface ArmingScenario {
  readonly id: string
  readonly prompt: string
  /** Conductor-authored/session todos fed to the Door-2 net (autoTypeTodos). For continuation rows this is the SESSION's existing list (settled seeds included). Omit for Door-1-only cases. */
  readonly todos?: readonly OrchestrationTodo[]
  /** Deterministic mode: the triage verdict to inject, bypassing the live LLM. Omit → live triage (or a short-circuit row, which never calls). */
  readonly mockVerdict?: TriageVerdict
  /** P4 — the session's PRIOR fresh turn's verdict: the store a continuation inherits (`decideArming` over it = the inherited arming decision). Present ⇒ the session has prior turns. */
  readonly priorMockVerdict?: TriageVerdict
  readonly expect: {
    /** Expected final shape after arming (optional — assert only when it matters). */
    readonly shape?: TriageGoalShape
    /** THE signal: did THIS TURN arm a frame pre-pass (skeleton seed OR autoTypeTodos injection)? */
    readonly localizationArmed: boolean
    /** P12 — the seed KIND an armed row must plant: the diagnosis localization writer or the hard-build plan seed. Required whenever localizationArmed is true; the rig scores a kind mismatch as wrong-seed. */
    readonly seedKind?: "localization" | "plan"
    /** P4 — this prompt must (true) / must not (false) trip the pre-LLM continuation short-circuit. Omitted = don't assert. */
    readonly shortCircuit?: boolean
    /** P4 — the role this turn must resolve to after both nets (short-circuit OR the mock verdict's turnRole). Omitted = fresh. */
    readonly turnRole?: "fresh" | "continuation"
    /** One-line human reason this is the correct outcome (over-fire vs under-fire rationale). */
    readonly reason: string
  }
  /** Provenance, e.g. "trivial fix in a central file". */
  readonly note?: string
}

export type { TriageVerdict, TriageGoalShape, OrchestrationTodo }
