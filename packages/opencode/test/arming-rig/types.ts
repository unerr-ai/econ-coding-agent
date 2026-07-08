// Interface contract for the arming-rig — the offline harness that exercises just
// the localization-arming decision (Door 1 = triage round-up, Door 2 = autoTypeTodos)
// over a labeled corpus, so we can iterate the arming logic without full arena runs.
//
// The main thread owns this file; the runner (run.ts) and the corpus (corpus.ts) are
// built in parallel against it. Do NOT put logic here — contract only.
import type { TriageVerdict, TriageGoalShape } from "../../src/session/turn-triage"
import type { OrchestrationTodo } from "../../src/session/slice-orchestrator"

/**
 * One isolated arming scenario: a task prompt (+ optional conductor-authored todos for
 * the Door-2 net, + optional mocked triage verdict for deterministic mode) and the door
 * outcome we expect. The rig runs the arming pipeline and scores `localizationArmed`.
 */
export interface ArmingScenario {
  readonly id: string
  readonly prompt: string
  /** Conductor-authored todos fed to the Door-2 net (autoTypeTodos). Omit for Door-1-only cases. */
  readonly todos?: readonly OrchestrationTodo[]
  /** Deterministic mode: the triage verdict to inject, bypassing the live LLM. Omit → live triage. */
  readonly mockVerdict?: TriageVerdict
  readonly expect: {
    /** Expected final shape after arming (optional — assert only when it matters). */
    readonly shape?: TriageGoalShape
    /** THE signal: did a localization pre-pass get armed (skeleton seed OR autoTypeTodos injection)? */
    readonly localizationArmed: boolean
    /** One-line human reason this is the correct outcome (over-fire vs under-fire rationale). */
    readonly reason: string
  }
  /** Provenance, e.g. "django-12039: trivial fix in a central file". */
  readonly note?: string
}

export type { TriageVerdict, TriageGoalShape, OrchestrationTodo }
