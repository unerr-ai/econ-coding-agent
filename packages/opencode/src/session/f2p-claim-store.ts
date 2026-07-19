/**
 * H1 tooth 3 (gap-closure-plan §2.7) — per-session "already denied" flag for
 * the F2P full-set finish claim (prompt.ts's finish-time block): a
 * bug-shaped root turn whose own observed red test ids (seen-red.ts's
 * `collectObservedRedTestIds`) include one never re-run green by the LATEST
 * run (`checkTestSetCoverage`, repro-fidelity-judge.ts) gets ONE
 * reject-with-nudge cycle, then is always allowed to finish (fail open LOUD
 * via a tail signal, never a deny loop). Same per-session module-state
 * pattern as patch-sanity-store.ts: keyed by sessionID, set once the gate
 * denies, read before every later finish attempt so the deny is genuinely
 * bounded to one — never a wedge.
 *
 * @sem domain=routing role=config
 */
const f2pClaimDeniedBySession = new Set<string>()

/** Whether this session's F2P claim gate already spent its one deny. */
export function hasDeniedF2pClaim(sessionID: string): boolean {
  return f2pClaimDeniedBySession.has(sessionID)
}

/** Record that the F2P claim gate denied this session's finish once. */
export function markF2pClaimDenied(sessionID: string): void {
  f2pClaimDeniedBySession.add(sessionID)
}
