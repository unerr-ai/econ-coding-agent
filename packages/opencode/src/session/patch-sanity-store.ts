/**
 * H3 — per-session "already denied" flag for the patch-sanity floor
 * (prompt.ts's finish-time block, `detectPatchSanityGap`/`shouldDenyPatchSanity`
 * in turn-supervisor.ts): a bug-shaped root turn whose landed patch touches
 * none of the issue-named/candidate-definition files — a $1.31
 * conftest.py-only patch with zero relation to the issue —
 * gets ONE reject-with-nudge cycle, then is always allowed to finish (fail
 * open LOUD via a tail signal, never a deny loop). Same per-session
 * module-state pattern as unverified-finish-store.ts: keyed by sessionID,
 * set once the gate denies, read before every later finish attempt so the
 * deny is genuinely bounded to one — never a wedge.
 *
 * @sem domain=routing role=config
 */
const patchSanityDeniedBySession = new Set<string>()

/** Whether this session's patch-sanity gate already spent its one deny. */
export function hasDeniedPatchSanity(sessionID: string): boolean {
  return patchSanityDeniedBySession.has(sessionID)
}

/** Record that the patch-sanity gate denied this session's finish once. */
export function markPatchSanityDenied(sessionID: string): void {
  patchSanityDeniedBySession.add(sessionID)
}
