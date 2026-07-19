/**
 * Tests for f2p-claim-store.ts (packages/opencode/src/session/f2p-claim-store.ts):
 * H1 tooth 3's per-session "already denied" flag for the F2P full-set finish
 * claim gate. Same shape as patch-sanity-store.ts/unverified-finish-store.ts
 * — a module-level Set keyed by sessionID, so these tests exercise the real
 * shared state (each test uses a fresh, unique sessionID to stay isolated).
 */
import { describe, it, expect } from "bun:test"
import { hasDeniedF2pClaim, markF2pClaimDenied } from "../../src/session/f2p-claim-store"

describe("f2p-claim-store", () => {
  it("a session with no recorded deny reads false", () => {
    expect(hasDeniedF2pClaim("f2p-store-session-1")).toBe(false)
  })

  it("marking a session denied is reflected by hasDeniedF2pClaim for that session only", () => {
    markF2pClaimDenied("f2p-store-session-2")
    expect(hasDeniedF2pClaim("f2p-store-session-2")).toBe(true)
    expect(hasDeniedF2pClaim("f2p-store-session-3")).toBe(false)
  })

  it("marking twice is idempotent — still reads denied, never throws", () => {
    markF2pClaimDenied("f2p-store-session-4")
    markF2pClaimDenied("f2p-store-session-4")
    expect(hasDeniedF2pClaim("f2p-store-session-4")).toBe(true)
  })
})
