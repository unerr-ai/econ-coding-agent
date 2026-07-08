/**
 * Per-session arming-decision store — the bridge from the turn-open arming judge
 * (`prompt.ts`, which computes the `ArmingVerdict` once per turn) to the
 * todowrite door (`autoTypeTodos`, reached via `tool/todo.ts`). Same per-session
 * module-state pattern as the test-edit gate (`tool/edit-governance.ts`): set at
 * turn open, consulted mid-turn, overwritten every turn so a later turn on the
 * same session never reads a stale decision.
 *
 * @sem domain=routing role=config
 */
import type { ArmingDecision } from "./arming-judge"

const armingBySession = new Map<string, ArmingDecision>()

/** Record this turn's arming decision for the session — called once at turn open. */
export function setArmingDecision(sessionID: string, decision: ArmingDecision): void {
  armingBySession.set(sessionID, decision)
}

/** The turn's arming decision, or `undefined` before triage ran (the door then degrades to its syntactic heuristic). */
export function getArmingDecision(sessionID: string): ArmingDecision | undefined {
  return armingBySession.get(sessionID)
}
