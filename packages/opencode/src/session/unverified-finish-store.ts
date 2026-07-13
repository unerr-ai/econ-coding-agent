/**
 * Wave 10 — per-session "already denied" flag for the unverified-finish gate
 * (prompt.ts's finish-time block): a FIX-SHAPED root turn that lands a
 * non-test source edit with ZERO real test executions in its own transcript
 * gets ONE reject-with-nudge cycle, then is always allowed to finish — the
 * 11885 autopsy shape (a 36-line deletion.py patch shipped after only
 * `py_compile`, no pytest/runtests run ever). Same per-session module-state
 * pattern as arming-store.ts/resolution-store.ts: keyed by sessionID, set
 * once the gate denies, read before every later finish attempt so the deny
 * is genuinely bounded to one — never a wedge.
 *
 * @sem domain=routing role=config
 */
const unverifiedFinishDeniedBySession = new Set<string>()

/** Whether this session's unverified-finish gate already spent its one deny. */
export function hasDeniedUnverifiedFinish(sessionID: string): boolean {
  return unverifiedFinishDeniedBySession.has(sessionID)
}

/** Record that the unverified-finish gate denied this session's finish once. */
export function markUnverifiedFinishDenied(sessionID: string): void {
  unverifiedFinishDeniedBySession.add(sessionID)
}
