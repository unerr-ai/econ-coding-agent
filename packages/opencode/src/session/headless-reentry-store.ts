/**
 * D4 (09-ops-hands) — per-session state for the headless completion re-entry gate (prompt.ts's
 * finish-time block, `decideHeadlessCompletionReentry` in turn-supervisor.ts): how many times
 * this session's gate has already held a finish for a running background job, bounded so a
 * hold always terminates, and which running job ids already fired their one heartbeat nudge —
 * a job id in that set lets a later finish PASS instead of holding again. Same per-session
 * module-state pattern as unverified-finish-store.ts/arming-store.ts.
 *
 * @sem domain=routing role=config
 */
const headlessReentryCountBySession = new Map<string, number>()
const heartbeatFlaggedJobIdsBySession = new Map<string, Set<string>>()
const EMPTY_JOB_ID_SET: ReadonlySet<string> = new Set()

/** How many times the D4 gate has already held this session's finish. */
export function headlessReentryCount(sessionID: string): number {
  return headlessReentryCountBySession.get(sessionID) ?? 0
}

/** Record one more D4 hold for this session. */
export function incrementHeadlessReentryCount(sessionID: string): void {
  headlessReentryCountBySession.set(sessionID, headlessReentryCount(sessionID) + 1)
}

/** Job ids this session's D4 gate has already sent one heartbeat nudge for. */
export function heartbeatFlaggedJobIds(sessionID: string): ReadonlySet<string> {
  return heartbeatFlaggedJobIdsBySession.get(sessionID) ?? EMPTY_JOB_ID_SET
}

/** Mark these job ids as heartbeat-flagged for this session (idempotent). */
export function markHeartbeatFlagged(sessionID: string, jobIds: readonly string[]): void {
  const set = heartbeatFlaggedJobIdsBySession.get(sessionID) ?? new Set<string>()
  for (const id of jobIds) set.add(id)
  heartbeatFlaggedJobIdsBySession.set(sessionID, set)
}
