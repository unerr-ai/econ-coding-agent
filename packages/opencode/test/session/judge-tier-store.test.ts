/**
 * Tests for judge-tier-store.ts (packages/opencode/src/session/judge-tier-store.ts):
 * gap-closure §4.3 (#27)'s per-session "already surfaced" flag for the
 * ECON_JUDGE_TIER=off master kill switch — bounds the loud degrade notice
 * to ONE per session across all three judge dispatch sites. Same
 * module-level-Set-keyed-by-sessionID shape as patch-sanity-store.ts; each
 * test uses a fresh, unique sessionID to stay isolated from the real
 * shared state.
 */
import { describe, it, expect } from "bun:test"
import { hasNotedJudgeTierOff, markJudgeTierOffNoted } from "../../src/session/judge-tier-store"

describe("judge-tier-store", () => {
  it("a session with no recorded note reads false", () => {
    expect(hasNotedJudgeTierOff("judge-tier-store-session-1")).toBe(false)
  })

  it("marking a session noted is reflected by hasNotedJudgeTierOff for that session only — the once-per-session bound", () => {
    markJudgeTierOffNoted("judge-tier-store-session-2")
    expect(hasNotedJudgeTierOff("judge-tier-store-session-2")).toBe(true)
    expect(hasNotedJudgeTierOff("judge-tier-store-session-3")).toBe(false)
  })

  it("marking twice is idempotent — still reads noted, never throws", () => {
    markJudgeTierOffNoted("judge-tier-store-session-4")
    markJudgeTierOffNoted("judge-tier-store-session-4")
    expect(hasNotedJudgeTierOff("judge-tier-store-session-4")).toBe(true)
  })
})
