/**
 * AC-0.4 cache-hit-rate meter + AC-8.4 per-tier rollup unit tests.
 *
 * Covers:
 *  1. computeCacheHitRate — zero denominator, full hit, partial hit.
 *  2. recordCacheHit — cold first turn is never flagged, a warm turn below
 *     threshold is flagged + emitted, a warm turn above threshold is not.
 *  3. TierCacheRollup — per-tier hit-rate/cost aggregation, cross-tier
 *     transition counting, and the < 70% flag signal.
 */

import { describe, it, expect } from "bun:test"
import { computeCacheHitRate, recordCacheHit, TierCacheRollup } from "../src/cache-meter.ts"
import type { CacheHitEvent, TierCacheRollupSignal } from "../src/cache-meter.ts"

// ---------------------------------------------------------------------------
// computeCacheHitRate
// ---------------------------------------------------------------------------

describe("computeCacheHitRate", () => {
  it("returns 0 when cacheRead, input, and cacheWrite are all 0 (divide-by-zero guard)", () => {
    expect(computeCacheHitRate({ cacheRead: 0, input: 0, cacheWrite: 0 })).toBe(0)
  })

  it("returns 1 on a full hit (input and cacheWrite are 0, all reads cached)", () => {
    expect(computeCacheHitRate({ cacheRead: 500, input: 0, cacheWrite: 0 })).toBe(1)
  })

  it("returns the partial ratio for a mixed turn", () => {
    expect(computeCacheHitRate({ cacheRead: 400, input: 100, cacheWrite: 0 })).toBeCloseTo(0.8)
  })

  it("returns 0 for a cold turn with no cache reads at all", () => {
    expect(computeCacheHitRate({ cacheRead: 0, input: 1000, cacheWrite: 0 })).toBe(0)
  })

  it("counts cacheWrite in the denominator as a miss", () => {
    // cacheRead=200, input=0, cacheWrite=800 -> 200/(200+0+800) = 0.2
    expect(computeCacheHitRate({ cacheRead: 200, input: 0, cacheWrite: 800 })).toBeCloseTo(0.2)
  })
})

// ---------------------------------------------------------------------------
// recordCacheHit
// ---------------------------------------------------------------------------

describe("recordCacheHit", () => {
  it("does not flag warn on a cold first turn even with a 0% hit rate", () => {
    const event = recordCacheHit({
      sessionID: "s1",
      turnId: "t1",
      tokens: { cacheRead: 0, cacheWrite: 500, input: 1000 },
      isFirstTurn: true,
    })
    expect(event.cacheHitRate).toBe(0)
    expect(event.warn).toBe(false)
  })

  it("flags warn on a later turn whose hit rate falls below 80%", () => {
    const event = recordCacheHit({
      sessionID: "s1",
      turnId: "t2",
      tokens: { cacheRead: 200, cacheWrite: 0, input: 800 },
      isFirstTurn: false,
    })
    expect(event.cacheHitRate).toBeCloseTo(0.2)
    expect(event.warn).toBe(true)
  })

  it("does not flag warn on a later turn at or above the 80% threshold", () => {
    const event = recordCacheHit({
      sessionID: "s1",
      turnId: "t3",
      tokens: { cacheRead: 800, cacheWrite: 0, input: 200 },
      isFirstTurn: false,
    })
    expect(event.cacheHitRate).toBeCloseTo(0.8)
    expect(event.warn).toBe(false)
  })

  it("forwards the computed event through the emit callback (no new transport)", () => {
    const received: CacheHitEvent[] = []
    const event = recordCacheHit(
      {
        sessionID: "s1",
        turnId: "t4",
        tokens: { cacheRead: 900, cacheWrite: 0, input: 100 },
        isFirstTurn: false,
        tier: "cheap",
        modelID: "claude-haiku-3",
      },
      (e) => received.push(e),
    )
    expect(received).toHaveLength(1)
    expect(received[0]).toEqual(event)
    expect(event.tier).toBe("cheap")
    expect(event.modelID).toBe("claude-haiku-3")
  })

  it("passes cost through to the emitted event, defaulting to 0 when omitted", () => {
    const withCost = recordCacheHit({
      sessionID: "s1",
      turnId: "t5",
      tokens: { cacheRead: 900, cacheWrite: 0, input: 100 },
      isFirstTurn: false,
      cost: 0.042,
    })
    expect(withCost.cost).toBe(0.042)

    const withoutCost = recordCacheHit({
      sessionID: "s1",
      turnId: "t6",
      tokens: { cacheRead: 900, cacheWrite: 0, input: 100 },
      isFirstTurn: false,
    })
    expect(withoutCost.cost).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// TierCacheRollup (AC-8.4)
// ---------------------------------------------------------------------------

const hitEvent = (overrides: Partial<CacheHitEvent> = {}): CacheHitEvent => ({
  sessionID: "s1",
  turnId: "t",
  timestamp: 1000,
  cacheRead: 800,
  cacheWrite: 0,
  input: 200,
  cacheHitRate: 0.8,
  warn: false,
  cost: 0.01,
  ...overrides,
})

describe("TierCacheRollup", () => {
  it("aggregates hit-rate and cost per tier across multiple turns", () => {
    const rollup = new TierCacheRollup()
    rollup.add(hitEvent({ tier: "cheap", cacheRead: 800, input: 200, cost: 0.01 }))
    rollup.add(hitEvent({ tier: "cheap", cacheRead: 900, input: 100, cost: 0.02 }))
    rollup.add(hitEvent({ tier: "oracle", cacheRead: 100, input: 900, cost: 0.5 }))

    const snapshot = rollup.snapshot()
    expect(snapshot.byTier["cheap"].turns).toBe(2)
    expect(snapshot.byTier["cheap"].cacheRead).toBe(1700)
    expect(snapshot.byTier["cheap"].input).toBe(300)
    expect(snapshot.byTier["cheap"].cost).toBeCloseTo(0.03)
    expect(snapshot.byTier["cheap"].hitRate).toBeCloseTo(1700 / 2000)

    expect(snapshot.byTier["oracle"].turns).toBe(1)
    expect(snapshot.byTier["oracle"].cost).toBeCloseTo(0.5)
  })

  it("buckets turns with no tier under 'unknown'", () => {
    const rollup = new TierCacheRollup()
    rollup.add(hitEvent({ tier: undefined }))
    expect(rollup.snapshot().byTier["unknown"].turns).toBe(1)
  })

  it("increments the cross-tier transition counter only when the tier changes", () => {
    const rollup = new TierCacheRollup()
    rollup.add(hitEvent({ tier: "cheap" }))
    rollup.add(hitEvent({ tier: "cheap" }))
    expect(rollup.crossTierTransitions).toBe(0)

    rollup.add(hitEvent({ tier: "oracle" }))
    expect(rollup.crossTierTransitions).toBe(1)

    rollup.add(hitEvent({ tier: "oracle" }))
    expect(rollup.crossTierTransitions).toBe(1)

    rollup.add(hitEvent({ tier: "cheap" }))
    expect(rollup.crossTierTransitions).toBe(2)

    const snapshot = rollup.snapshot()
    expect(snapshot.crossTierTransitions).toBe(2)
    expect(snapshot.transitions[0]).toMatchObject({ fromTier: "cheap", toTier: "oracle" })
    expect(snapshot.transitions[1]).toMatchObject({ fromTier: "oracle", toTier: "cheap" })
  })

  it("flags a tier once its cumulative hit rate falls below 70%", () => {
    const rollup = new TierCacheRollup()
    const signals: TierCacheRollupSignal[] = []
    rollup.add(hitEvent({ tier: "reasoner", cacheRead: 100, input: 900 }), (s) => signals.push(s))

    const snapshot = rollup.snapshot()
    expect(snapshot.byTier["reasoner"].hitRate).toBeCloseTo(0.1)
    expect(snapshot.byTier["reasoner"].flagged).toBe(true)
    expect(signals.some((s) => s.kind === "flag")).toBe(true)
  })

  it("does not flag a tier at or above the 70% threshold", () => {
    const rollup = new TierCacheRollup()
    const signals: TierCacheRollupSignal[] = []
    rollup.add(hitEvent({ tier: "cheap", cacheRead: 900, input: 100 }), (s) => signals.push(s))

    expect(rollup.snapshot().byTier["cheap"].flagged).toBe(false)
    expect(signals.some((s) => s.kind === "flag")).toBe(false)
  })
})
