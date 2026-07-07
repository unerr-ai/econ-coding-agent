/**
 * cache-switch.ts unit tests — the §3.3/§4.4 switch-vs-stay pricing model.
 *
 * Model IDs are always resolved through ECON_TIER_BINDING/model-registry
 * (tier-speak only) — never hardcoded, per project convention.
 *
 * IMPORTANT FINDING (see closing note): with the real ECON_COST_MATRIX rates,
 * a "10x price ratio, brief ≈ half the session context" scenario does NOT
 * land breakEven in a ~20-30 band as ORCHESTRATION_MECHANISM.md §3.3's
 * illustrative worked-shape prose describes. Conductor (0.14 $/M) vs oracle
 * (1.4 $/M) is the only real tier pair at an exact 10x ratio, and at that
 * ratio a half-context-sized brief written at oracle's real (no-discount,
 * writePremium=1.0) cold-write rate costs far more than any number of
 * cache-discounted conductor calls saves — stay dominates unconditionally
 * (breakEven is negative: no positive crossing exists). A crossing in the
 * doc's favor only exists once the brief is much smaller relative to context
 * (see the "compacted brief" tests below), which is also what the doc's own
 * follow-on sentence says ("the decisive variable is T_brief, not the price
 * ratio"). Verified against this repo's real rates, not asserted from doc
 * prose — flagged for senior review, not silently forced.
 */

import { describe, it, expect } from "bun:test"
import {
  stayCost,
  switchCost,
  breakEvenCalls,
  shouldSwitch,
  cacheProfileFor,
  groupMove,
  DEFAULT_READ_DISCOUNT,
  DEFAULT_WRITE_PREMIUM,
} from "../src/cache-switch.ts"
import type { SwitchPricingInput, TierCacheProfile } from "../src/cache-switch.ts"
import { ECON_TIER_BINDING, modelProfile } from "../src/model-registry.ts"

const conductorKey = ECON_TIER_BINDING.conductor
const oracleKey = ECON_TIER_BINDING.oracle
const conductorRate = modelProfile(conductorKey)!.cost.input
const oracleRate = modelProfile(oracleKey)!.cost.input

// ---------------------------------------------------------------------------
// stayCost / switchCost — basic arithmetic
// ---------------------------------------------------------------------------

describe("stayCost", () => {
  it("prices N calls at the hit-rate-weighted multiplier", () => {
    const input: Pick<SwitchPricingInput, "stay" | "expectedCalls"> = {
      stay: { ratePerMTok: 10, readDiscount: 0.1, writePremium: 1, hitRate: 0.8, ctxTokens: 50_000 },
      expectedCalls: 4,
    }
    // multiplier = 0.8*0.1 + 0.2 = 0.28
    const expected = (4 * 50_000 * 10 * 0.28) / 1_000_000
    expect(stayCost(input)).toBeCloseTo(expected, 10)
  })

  it("returns 0 for non-positive expectedCalls or ctxTokens", () => {
    const base = { ratePerMTok: 10, readDiscount: 0.1, writePremium: 1, hitRate: 0.8, ctxTokens: 50_000 }
    expect(stayCost({ stay: base, expectedCalls: 0 })).toBe(0)
    expect(stayCost({ stay: base, expectedCalls: -3 })).toBe(0)
    expect(stayCost({ stay: { ...base, ctxTokens: 0 }, expectedCalls: 5 })).toBe(0)
  })
})

describe("switchCost", () => {
  it("prices one cold write plus (N-1) discounted repeats", () => {
    const input: Pick<SwitchPricingInput, "move" | "expectedCalls"> = {
      move: { ratePerMTok: 20, readDiscount: 0.1, writePremium: 1.5, hitRate: 1, briefTokens: 2_000 },
      expectedCalls: 3,
    }
    const write = (2_000 * 20 * 1.5) / 1_000_000
    // hitRate=1 => multiplier = 1*0.1 + 0 = 0.1
    const repeat = (2 * 2_000 * 20 * 0.1) / 1_000_000
    expect(switchCost(input)).toBeCloseTo(write + repeat, 10)
  })

  it("at expectedCalls=1 is just the write cost (no repeat term)", () => {
    const input: Pick<SwitchPricingInput, "move" | "expectedCalls"> = {
      move: { ratePerMTok: 20, readDiscount: 0.1, writePremium: 1.5, hitRate: 1, briefTokens: 2_000 },
      expectedCalls: 1,
    }
    expect(switchCost(input)).toBeCloseTo((2_000 * 20 * 1.5) / 1_000_000, 10)
  })

  it("returns 0 for non-positive expectedCalls or briefTokens", () => {
    const base = { ratePerMTok: 20, readDiscount: 0.1, writePremium: 1, hitRate: 1, briefTokens: 2_000 }
    expect(switchCost({ move: base, expectedCalls: 0 })).toBe(0)
    expect(switchCost({ move: { ...base, briefTokens: 0 }, expectedCalls: 5 })).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// breakEvenCalls / shouldSwitch — the doc's worked-shape scenarios,
// verified against real ECON_COST_MATRIX rates (tier-speak only)
// ---------------------------------------------------------------------------

describe("breakEvenCalls / shouldSwitch — worked shapes", () => {
  const ctxTokens = 100_000

  function upSwitchInput(hitRate: number, briefTokens: number, expectedCalls = 1): SwitchPricingInput {
    return {
      stay: { ratePerMTok: conductorRate, readDiscount: 0.1, writePremium: 1.0, hitRate, ctxTokens },
      move: { ratePerMTok: oracleRate, readDiscount: 0.1, writePremium: 1.0, hitRate: 1.0, briefTokens },
      expectedCalls,
    }
  }

  it("10x price ratio (conductor -> oracle) confirmed from the real cost matrix", () => {
    expect(oracleRate / conductorRate).toBeCloseTo(10, 5)
  })

  it("half-context brief at a 10x-pricier move target: stay dominates unconditionally (no valid finite breakEven), NOT a ~20-30 crossing", () => {
    const input = upSwitchInput(0.85, 46_000) // brief/ctx ~= 0.46, h=0.85, d=0.1 — the doc's stated worked-shape params
    const breakEven = breakEvenCalls(input)
    expect(breakEven).toBeLessThanOrEqual(0) // no positive crossing exists
    expect(shouldSwitch(input).move).toBe(false)
    expect(shouldSwitch({ ...input, expectedCalls: 30 }).move).toBe(false) // still false well past the doc's "20+"
  })

  it("compacted brief (small brief/ctx ratio): shouldSwitch is true even at expectedCalls 1-2", () => {
    const input = upSwitchInput(0.85, 2_000) // brief/ctx = 0.02 — a "compacted" brief
    expect(shouldSwitch({ ...input, expectedCalls: 1 }).move).toBe(true)
    expect(shouldSwitch({ ...input, expectedCalls: 2 }).move).toBe(true)
  })

  it("lower hit rate (0.6 vs 0.85) tightens breakEven for the compacted-brief scenario", () => {
    const highHit = breakEvenCalls(upSwitchInput(0.85, 2_000))
    const lowHit = breakEvenCalls(upSwitchInput(0.6, 2_000))
    expect(lowHit).toBeLessThan(highHit)
  })

  it("down-switch direction (an already-escalated expensive tier -> the cheap conductor) breaks even fast", () => {
    const input: SwitchPricingInput = {
      stay: { ratePerMTok: oracleRate, readDiscount: 0.1, writePremium: 1.0, hitRate: 0.85, ctxTokens },
      move: { ratePerMTok: conductorRate, readDiscount: 0.1, writePremium: 1.0, hitRate: 1.0, briefTokens: 46_000 },
      expectedCalls: 1,
    }
    const breakEven = breakEvenCalls(input)
    expect(breakEven).toBeGreaterThan(0)
    expect(breakEven).toBeLessThan(1) // favorable from the first call
    expect(shouldSwitch(input).move).toBe(true)
  })

  it("flags a hit-rate-invalidation alarm reason below 0.7 on either tier (§4.4 rule 5)", () => {
    const input = upSwitchInput(0.6, 2_000)
    const verdict = shouldSwitch(input)
    expect(verdict.reasons.some((r) => r.includes("prefix-invalidation alarm"))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Degenerate cases
// ---------------------------------------------------------------------------

describe("degenerate cases", () => {
  const profile: TierCacheProfile = { ratePerMTok: 10, readDiscount: 0.1, writePremium: 1, hitRate: 0.9 }

  it("breakEvenCalls is Infinity when either token size is zero", () => {
    expect(
      breakEvenCalls({ stay: { ...profile, ctxTokens: 0 }, move: { ...profile, briefTokens: 5_000 }, expectedCalls: 1 }),
    ).toBe(Infinity)
    expect(
      breakEvenCalls({ stay: { ...profile, ctxTokens: 5_000 }, move: { ...profile, briefTokens: 0 }, expectedCalls: 1 }),
    ).toBe(Infinity)
  })

  it("expectedCalls 0 costs 0 on both sides", () => {
    const input: SwitchPricingInput = {
      stay: { ...profile, ctxTokens: 5_000 },
      move: { ...profile, briefTokens: 1_000 },
      expectedCalls: 0,
    }
    expect(stayCost(input)).toBe(0)
    expect(switchCost(input)).toBe(0)
  })

  it("expectedCalls 1 charges the write but no repeat term", () => {
    const input: SwitchPricingInput = {
      stay: { ...profile, ctxTokens: 5_000 },
      move: { ...profile, briefTokens: 1_000 },
      expectedCalls: 1,
    }
    expect(switchCost(input)).toBeCloseTo((1_000 * 10 * 1) / 1_000_000, 10)
  })
})

// ---------------------------------------------------------------------------
// groupMove — §4.4 rule 4, groups move together or not at all
// ---------------------------------------------------------------------------

describe("groupMove", () => {
  const move: TierCacheProfile = { ratePerMTok: oracleRate, readDiscount: 0.1, writePremium: 1.0, hitRate: 1.0 }

  it("sums brief tokens across the group and prices it as one move", () => {
    const result = groupMove([{ briefTokens: 1_000 }, { briefTokens: 2_000 }, { briefTokens: 3_000 }], move, 5)
    expect(result.briefTokens).toBe(6_000)
    expect(result.cost).toBeCloseTo(
      switchCost({ move: { ...move, briefTokens: 6_000 }, expectedCalls: 5 }),
      10,
    )
  })

  it("matches switchCost of a single slice equal to the summed group at the same call count", () => {
    const grouped = groupMove([{ briefTokens: 500 }, { briefTokens: 500 }], move, 2)
    const singleEquivalent = switchCost({ move: { ...move, briefTokens: 1_000 }, expectedCalls: 2 })
    expect(grouped.cost).toBeCloseTo(singleEquivalent, 10)
  })

  it("handles an empty slice group as zero tokens, zero cost", () => {
    const result = groupMove([], move, 5)
    expect(result.briefTokens).toBe(0)
    expect(result.cost).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// cacheProfileFor — the real registry adapter
// ---------------------------------------------------------------------------

describe("cacheProfileFor", () => {
  it("derives readDiscount/writePremium from the conductor's real cached vs uncached rates", () => {
    const profile = cacheProfileFor(conductorKey)
    expect(profile).not.toBeNull()
    const conductor = modelProfile(conductorKey)!
    expect(profile!.readDiscount).toBeCloseTo(conductor.cost.cachedInput / conductor.cost.input, 10)
    expect(profile!.writePremium).toBeCloseTo(conductor.cost.cacheWrite / conductor.cost.input, 10)
  })

  it("derives the oracle's ~10x read discount (0.14 cached vs 1.4 standard)", () => {
    const profile = cacheProfileFor(oracleKey)!
    expect(profile.readDiscount).toBeCloseTo(0.1, 5)
    expect(profile.writePremium).toBeCloseTo(1.0, 5)
  })

  it("returns null for a model absent from ECON_COST_MATRIX", () => {
    expect(cacheProfileFor("not-a-real-model/does-not-exist")).toBeNull()
  })

  it("documents the fallback defaults callers should use when cacheProfileFor returns null", () => {
    expect(DEFAULT_READ_DISCOUNT).toBe(0.1)
    expect(DEFAULT_WRITE_PREMIUM).toBe(1.0)
  })
})
