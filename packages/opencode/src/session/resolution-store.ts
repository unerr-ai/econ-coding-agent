/**
 * Per-session resolve-attempt counter — the #53/#54 prior-uncertainty
 * resolution gate's recursion/termination guard at the todo→slice seam
 * (`runConductorOrchestration` in `slice-orchestrator.ts`). Same per-session
 * module-state pattern as `arming-store.ts`: keyed by sessionID, read before
 * a resolution-phase decision so `resolutionDecision`'s `MAX_RESOLVE_ATTEMPTS`
 * cap is checkable, incremented once per `"resolve-first"` pass so the cap is
 * actually reachable — within a turn the counter only ever grows, so the
 * recursive resolve-then-recheck loop is bounded by construction. The budget
 * is PER TASK, not per session (P10): the turn-open seam calls
 * `resetResolveAttempts` on every FRESH turn, so an ambiguous turn that
 * burned both passes cannot disable resolution for every later turn of a
 * long session — while a continuation turn (P4) skips the reset, because the
 * same task is still running and its recursion bound must hold across the
 * follow-up.
 *
 * @sem domain=routing role=config
 */
const resolveAttemptsBySession = new Map<string, number>()

/** How many resolution passes already ran on this turn — 0 before the first. */
export function getResolveAttempts(sessionID: string): number {
  return resolveAttemptsBySession.get(sessionID) ?? 0
}

/** Record that one more resolution pass ran on this turn. */
export function incResolveAttempts(sessionID: string): void {
  resolveAttemptsBySession.set(sessionID, getResolveAttempts(sessionID) + 1)
}

/** P10 — a FRESH user turn is a new task: zero the counter at turn open so each task gets its own bounded resolution budget. A continuation turn (P4) never calls this — the same task is still running. */
export function resetResolveAttempts(sessionID: string): void {
  resolveAttemptsBySession.delete(sessionID)
}
