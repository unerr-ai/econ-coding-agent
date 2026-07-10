/**
 * econ receipt unit tests.
 *
 * Covers:
 *  1. buildReceipt — tier split tokenShares sum to ~1; largeTierTokenShare +
 *     estimatedReduction = 1; per-tier costShare, cacheHitRatio, toolCalls,
 *     peakContextTokens; contextLimit present for econ tiers (conductor/
 *     executor/reasoner/oracle) and absent for "unknown"; catches pass-
 *     through; largeTiers override; double-pay reflects the ledger snapshot.
 *  2. formatReceipt — overall block (turns/tools/batch-per-msg/tokens/cache/
 *     context/spend/reduction/double-pay), per-tier drilldown lines (including
 *     the per-tier batch ratio), catches rendering. No frontier baseline
 *     anywhere.
 *  3. formatReceipt cache honesty + routing — the "n/r" (not a hollow 0%)
 *     render only fires for a tier whose bound model's registry
 *     cacheAccounting is "nonstream-only"; since W8 (2026-07-06) fixed the
 *     client-side cached_tokens mapping gap, all four econ tiers are now
 *     "stream"-accounted, so a reasoner turn with zero cache reads renders
 *     its real "0.0%" instead (the mechanism itself stays in receipt.ts for a
 *     hypothetical future nonstream-only model, just unexercised by a live
 *     tier today); a "stream" tier with real cache reads still renders its
 *     numeric percentage; the routing line names every tier that ran above
 *     conductor/executor with turns + cost, and is omitted entirely when none
 *     did — this is what closes the "0 escalations while 100% reasoner"
 *     blind spot (double-pay only counts mid-turn escalation, not turn-open
 *     routing).
 *  4. U6 trace sections (goals/evaluations/contained) — absent when omitted
 *     (undefined, not empty arrays: today's shape stays byte-identical); each
 *     section passes through unchanged when the caller supplies an
 *     already-folded root+child array; no comparison-shaped field appears on
 *     the receipt even with every section populated (standing rule guard).
 *
 * Uses real TelemetryStore + DoublePayLedger throughout (no mocks). Model ids
 * are read from ECON_TIER_BINDING (never hard-coded) so a model swap there
 * cannot silently desync these fixtures.
 */

import { describe, it, expect } from "bun:test"
import { buildReceipt, formatReceipt } from "../src/receipt.ts"
import type { ReceiptCatch, ReceiptGoal, ReceiptEvaluation, ReceiptContainment } from "../src/receipt.ts"
import { TelemetryStore, emitUsageEvent } from "../src/telemetry.ts"
import { DoublePayLedger, recordEscalation } from "../src/double-pay.ts"
import { ECON_TIER_BINDING, contextWindow } from "../src/model-registry.ts"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONDUCTOR_MODEL = ECON_TIER_BINDING.conductor
const ORACLE_MODEL = ECON_TIER_BINDING.oracle
const REASONER_MODEL = ECON_TIER_BINDING.reasoner
const SESSION = "rcpt-sess"

/**
 * Build a store with 2 conductor + 1 oracle turn — non-trivial tier mix with
 * cache + tool-call activity on every turn.
 *
 *   conductor ×2: input=500 output=100 cacheRead=200 cacheWrite=50, cost=0.0005
 *     each, toolCalls 3 then 2 → tier totals: tokens 1000/200/0/400/100,
 *     totalTokens=1700, cost=0.001, toolCalls=5, cacheHitRatio=400/1500≈0.2667,
 *     peakContextTokens=750 (500+200+50, same both turns)
 *   oracle ×1: input=1000 output=300 cacheRead=100 cacheWrite=0, cost=0.018,
 *     toolCalls=5 → totalTokens=1400, cacheHitRatio=100/1100≈0.0909,
 *     peakContextTokens=1100
 *
 * Overall: totalTokens=3100, cost=0.019, toolCalls=10,
 *   peakContextTokens=1100, cacheHitRatio=500/2600≈0.1923
 *   conductorShare=1700/3100≈0.5484, oracleShare=1400/3100≈0.4516
 */
function makeStore(): TelemetryStore {
  const store = new TelemetryStore()
  emitUsageEvent(store, {
    sessionID: SESSION,
    model: CONDUCTOR_MODEL,
    tier: "conductor",
    cost: 0.0005,
    tokens: { input: 500, output: 100, cache: { read: 200, write: 50 } },
    toolCalls: 3,
    timestamp: 1000,
  })
  emitUsageEvent(store, {
    sessionID: SESSION,
    model: CONDUCTOR_MODEL,
    tier: "conductor",
    cost: 0.0005,
    tokens: { input: 500, output: 100, cache: { read: 200, write: 50 } },
    toolCalls: 2,
    timestamp: 2000,
  })
  emitUsageEvent(store, {
    sessionID: SESSION,
    model: ORACLE_MODEL,
    tier: "oracle",
    cost: 0.018,
    tokens: { input: 1000, output: 300, cache: { read: 100, write: 0 } },
    toolCalls: 5,
    timestamp: 3000,
  })
  return store
}

// ---------------------------------------------------------------------------
// buildReceipt
// ---------------------------------------------------------------------------

describe("buildReceipt", () => {
  it("tier split tokenShares sum to 1", () => {
    const store = makeStore()
    const ledger = new DoublePayLedger()
    const receipt = buildReceipt({ store, ledger })
    const total = receipt.tierSplit.reduce((acc, r) => acc + r.tokenShare, 0)
    expect(total).toBeCloseTo(1)
  })

  it("largeTierTokenShare + estimatedReduction = 1", () => {
    const store = makeStore()
    const ledger = new DoublePayLedger()
    const receipt = buildReceipt({ store, ledger })
    expect(receipt.largeTierTokenShare + receipt.estimatedReduction).toBeCloseTo(1)
  })

  it("conductor and oracle rows have non-trivial, distinct tokenShares", () => {
    const store = makeStore()
    const ledger = new DoublePayLedger()
    const receipt = buildReceipt({ store, ledger })
    const conductorRow = receipt.tierSplit.find((r) => r.tier === "conductor")
    const oracleRow = receipt.tierSplit.find((r) => r.tier === "oracle")
    expect(conductorRow?.tokenShare).toBeCloseTo(1700 / 3100)
    expect(oracleRow?.tokenShare).toBeCloseTo(1400 / 3100)
  })

  it("oracle is the default large tier: largeTierTokenShare ≈ oracleShare", () => {
    const store = makeStore()
    const ledger = new DoublePayLedger()
    const receipt = buildReceipt({ store, ledger })
    // Default large tiers = oracle, reasoner, frontier — only oracle present here
    expect(receipt.largeTierTokenShare).toBeCloseTo(1400 / 3100)
    expect(receipt.estimatedReduction).toBeCloseTo(1 - 1400 / 3100)
  })

  it("actualCost, totalTokens, turns, toolCalls, and peakContextTokens roll up overall totals", () => {
    const store = makeStore()
    const ledger = new DoublePayLedger()
    const receipt = buildReceipt({ store, ledger })
    expect(receipt.turns).toBe(3)
    expect(receipt.actualCost).toBeCloseTo(0.019)
    expect(receipt.totalTokens).toBe(3100)
    expect(receipt.toolCalls).toBe(10)
    expect(receipt.peakContextTokens).toBe(1100)
    expect(receipt.cacheHitRatio).toBeCloseTo(500 / 2600)
  })

  it("per-tier costShare sums to 1 and matches each tier's cost fraction", () => {
    const store = makeStore()
    const ledger = new DoublePayLedger()
    const receipt = buildReceipt({ store, ledger })
    const total = receipt.tierSplit.reduce((acc, r) => acc + r.costShare, 0)
    expect(total).toBeCloseTo(1)
    const conductorRow = receipt.tierSplit.find((r) => r.tier === "conductor")
    const oracleRow = receipt.tierSplit.find((r) => r.tier === "oracle")
    expect(conductorRow?.costShare).toBeCloseTo(0.001 / 0.019)
    expect(oracleRow?.costShare).toBeCloseTo(0.018 / 0.019)
  })

  it("costShare is 0 for every row when total cost is 0", () => {
    const store = new TelemetryStore()
    emitUsageEvent(store, {
      sessionID: SESSION,
      model: CONDUCTOR_MODEL,
      tier: "conductor",
      cost: 0,
      tokens: { input: 100, output: 20 },
      timestamp: 1000,
    })
    const receipt = buildReceipt({ store, ledger: new DoublePayLedger() })
    for (const row of receipt.tierSplit) expect(row.costShare).toBe(0)
  })

  it("per-tier cacheHitRatio, toolCalls, and peakContextTokens match the tier's own turns", () => {
    const store = makeStore()
    const ledger = new DoublePayLedger()
    const receipt = buildReceipt({ store, ledger })
    const conductorRow = receipt.tierSplit.find((r) => r.tier === "conductor")
    const oracleRow = receipt.tierSplit.find((r) => r.tier === "oracle")
    expect(conductorRow?.cacheHitRatio).toBeCloseTo(400 / 1500)
    expect(conductorRow?.toolCalls).toBe(5)
    expect(conductorRow?.peakContextTokens).toBe(750)
    expect(oracleRow?.cacheHitRatio).toBeCloseTo(100 / 1100)
    expect(oracleRow?.toolCalls).toBe(5)
    expect(oracleRow?.peakContextTokens).toBe(1100)
  })

  it("contextLimit is populated for the four econ tiers from the model registry", () => {
    const store = makeStore()
    const receipt = buildReceipt({ store, ledger: new DoublePayLedger() })
    const conductorRow = receipt.tierSplit.find((r) => r.tier === "conductor")
    const oracleRow = receipt.tierSplit.find((r) => r.tier === "oracle")
    expect(conductorRow?.contextLimit).toBe(contextWindow("conductor"))
    expect(oracleRow?.contextLimit).toBe(contextWindow("oracle"))
  })

  it("contextLimit is undefined for a non-econ tier label (e.g. 'unknown')", () => {
    const store = new TelemetryStore()
    emitUsageEvent(store, {
      sessionID: SESSION,
      model: "some/unrecognised-model",
      tier: "unknown",
      cost: 0.001,
      tokens: { input: 100, output: 20 },
      timestamp: 1000,
    })
    const receipt = buildReceipt({ store, ledger: new DoublePayLedger() })
    const unknownRow = receipt.tierSplit.find((r) => r.tier === "unknown")
    expect(unknownRow?.contextLimit).toBeUndefined()
  })

  it("doublePay reflects the ledger snapshot at receipt build time", () => {
    const store = makeStore()
    const ledger = new DoublePayLedger()
    ledger.add(
      recordEscalation({
        turnId: "esc-1",
        cheap: { model: CONDUCTOR_MODEL, cost: 0.0005, tokens: { input: 500, output: 100 } },
        oracle: { model: ORACLE_MODEL, cost: 0.018, tokens: { input: 1000, output: 300 } },
      }),
    )
    const receipt = buildReceipt({ store, ledger })
    expect(receipt.doublePay.escalations).toBe(1)
    expect(receipt.doublePay.wastedCost).toBeCloseTo(0.0005)
  })

  it("doublePay snapshot is independent of later ledger mutations", () => {
    const store = makeStore()
    const ledger = new DoublePayLedger()
    const receipt = buildReceipt({ store, ledger }) // 0 escalations at build time

    ledger.add(
      recordEscalation({
        turnId: "esc-2",
        cheap: { model: CONDUCTOR_MODEL, cost: 0.0005, tokens: { input: 500, output: 100 } },
        oracle: { model: ORACLE_MODEL, cost: 0.018, tokens: { input: 1000, output: 300 } },
      }),
    )

    expect(receipt.doublePay.escalations).toBe(0)
    expect(receipt.doublePay.wastedCost).toBe(0)
    expect(ledger.escalations).toBe(1)
  })

  it("catches are included in the receipt unchanged", () => {
    const store = makeStore()
    const ledger = new DoublePayLedger()
    const catches: ReceiptCatch[] = [
      { name: "src/heavy-module.ts", tier: "oracle", reason: "high fan-in" },
    ]
    const receipt = buildReceipt({ store, ledger, catches })
    expect(receipt.catches).toHaveLength(1)
    expect(receipt.catches[0]?.name).toBe("src/heavy-module.ts")
    expect(receipt.catches[0]?.reason).toBe("high fan-in")
  })

  it("catches defaults to empty array when omitted", () => {
    const store = makeStore()
    const ledger = new DoublePayLedger()
    const receipt = buildReceipt({ store, ledger })
    expect(receipt.catches).toHaveLength(0)
  })

  it("largeTiers override controls which tiers count as large", () => {
    const store = makeStore()
    const ledger = new DoublePayLedger()
    // Only "conductor" as large — oracle excluded
    const receipt = buildReceipt({ store, ledger, largeTiers: ["conductor"] })
    const conductorRow = receipt.tierSplit.find((r) => r.tier === "conductor")
    expect(receipt.largeTierTokenShare).toBeCloseTo(conductorRow?.tokenShare ?? -1)
    expect(receipt.estimatedReduction).toBeCloseTo(1 - (conductorRow?.tokenShare ?? -1))
  })
})

// ---------------------------------------------------------------------------
// U6 — goals / evaluations / contained trace sections
// ---------------------------------------------------------------------------

describe("buildReceipt — U6 trace sections", () => {
  it("goals, evaluations, and contained are all absent (undefined, not empty arrays) when omitted — today's shape unchanged", () => {
    const store = makeStore()
    const ledger = new DoublePayLedger()
    const receipt = buildReceipt({ store, ledger })
    expect(receipt.goals).toBeUndefined()
    expect(receipt.evaluations).toBeUndefined()
    expect(receipt.contained).toBeUndefined()
    expect(Object.keys(receipt)).not.toContain("goals")
    expect(Object.keys(receipt)).not.toContain("evaluations")
    expect(Object.keys(receipt)).not.toContain("contained")
  })

  it("goals fold across root + child slices — every entry from both sources survives unchanged", () => {
    const store = makeStore()
    const ledger = new DoublePayLedger()
    // Simulates the upstream caller having already folded the root turn's
    // goal(s) together with a child slice's own re-triaged goal (U2 fold-back).
    const goals: ReceiptGoal[] = [
      { summary: "root: add retry to boot path", shape: "mechanical" },
      { summary: "child: extract shared retry helper", shape: "judgment" },
    ]
    const receipt = buildReceipt({ store, ledger, goals })
    expect(receipt.goals).toHaveLength(2)
    expect(receipt.goals).toEqual(goals)
  })

  it("evaluations fold across root + child slices — inline and child venues both present", () => {
    const store = makeStore()
    const ledger = new DoublePayLedger()
    const evaluations: ReceiptEvaluation[] = [
      { sliceId: "slice-root-1", tier: "executor", venue: "inline", reasons: ["low blast radius"] },
      { sliceId: "slice-child-1", tier: "reasoner", venue: "child", reasons: ["high fan-in", "history: prior fail"] },
    ]
    const receipt = buildReceipt({ store, ledger, evaluations })
    expect(receipt.evaluations).toHaveLength(2)
    expect(receipt.evaluations?.find((e) => e.venue === "inline")?.sliceId).toBe("slice-root-1")
    expect(receipt.evaluations?.find((e) => e.venue === "child")?.reasons).toEqual([
      "high fan-in",
      "history: prior fail",
    ])
  })

  it("contained entries fold across root + child slices, including an unresolved (no toTier) revert", () => {
    const store = makeStore()
    const ledger = new DoublePayLedger()
    const contained: ReceiptContainment[] = [
      { sliceId: "slice-root-1", fromTier: "executor", toTier: "conductor", rungReason: "sound-reject", reverted: true },
      { sliceId: "slice-child-1", fromTier: "conductor", rungReason: "behavior-gate", reverted: false },
    ]
    const receipt = buildReceipt({ store, ledger, contained })
    expect(receipt.contained).toHaveLength(2)
    expect(receipt.contained?.[0]?.reverted).toBe(true)
    expect(receipt.contained?.[1]?.toTier).toBeUndefined()
    expect(receipt.contained?.[1]?.reverted).toBe(false)
  })

  it("no comparison-shaped fields appear anywhere on the receipt, even with every U6 section populated (standing rule)", () => {
    const store = makeStore()
    const ledger = new DoublePayLedger()
    const receipt = buildReceipt({
      store,
      ledger,
      goals: [{ summary: "compound prompt goal", shape: "mechanical" }],
      evaluations: [{ sliceId: "s1", tier: "reasoner", venue: "child", reasons: ["blast-radius"] }],
      contained: [{ sliceId: "s1", fromTier: "executor", toTier: "reasoner", rungReason: "shrink-reject", reverted: true }],
    })
    const serialized = JSON.stringify(receipt).toLowerCase()
    for (const banned of ["frontier", "counterfactual", "wouldhavecost", "netsaved", "grosssaved", "vsclaude", "vscursor"]) {
      expect(serialized).not.toContain(banned)
    }
  })
})

// ---------------------------------------------------------------------------
// formatReceipt
// ---------------------------------------------------------------------------

describe("formatReceipt", () => {
  /** Minimal store: one conductor event. */
  function singleEventStore(): TelemetryStore {
    const store = new TelemetryStore()
    emitUsageEvent(store, {
      sessionID: SESSION,
      model: CONDUCTOR_MODEL,
      tier: "conductor",
      cost: 0.001,
      tokens: { input: 100, output: 50, cache: { read: 20, write: 5 } },
      toolCalls: 4,
      timestamp: 1000,
    })
    return store
  }

  it("contains the header line 'econ receipt'", () => {
    const store = singleEventStore()
    const ledger = new DoublePayLedger()
    const text = formatReceipt(buildReceipt({ store, ledger }))
    expect(text).toContain("econ receipt")
  })

  it("overall block contains turns, tool calls, tokens, cache hit, context, and spend", () => {
    const store = singleEventStore()
    const ledger = new DoublePayLedger()
    const text = formatReceipt(buildReceipt({ store, ledger }))
    expect(text).toContain("turns:")
    expect(text).toContain("tool calls:")
    expect(text).toContain("tokens:")
    expect(text).toContain("cache hit:")
    expect(text).toContain("context:")
    expect(text).toContain("spent:")
  })

  it("always contains the 'double-pay' line", () => {
    const store = singleEventStore()
    const ledger = new DoublePayLedger()
    const text = formatReceipt(buildReceipt({ store, ledger }))
    expect(text).toContain("double-pay")
  })

  it("contains the reduction label and a percentage", () => {
    const store = singleEventStore()
    const ledger = new DoublePayLedger()
    const text = formatReceipt(buildReceipt({ store, ledger }))
    expect(text).toContain("reduction:")
    expect(text).toMatch(/reduction:\s+[\d.]+%/)
  })

  it("never mentions a frontier baseline anywhere", () => {
    const store = makeStore()
    const ledger = new DoublePayLedger()
    const text = formatReceipt(buildReceipt({ store, ledger }))
    expect(text.toLowerCase()).not.toContain("frontier")
    expect(text).not.toContain("NET SAVED")
    expect(text).not.toContain("gross saved")
  })

  it("turns line carries the batch ratio (tool calls per assistant message, 2 decimals)", () => {
    // makeStore: 3 assistant messages ("turns"), 10 tool calls → 10/3 ≈ 3.33
    const store = makeStore()
    const ledger = new DoublePayLedger()
    const text = formatReceipt(buildReceipt({ store, ledger }))
    expect(text).toContain("turns:      3 · tool calls: 10 · batch 3.33/msg")
  })

  it("batch ratio renders '—' when there are no assistant messages (turns=0)", () => {
    const store = new TelemetryStore() // no events recorded
    const ledger = new DoublePayLedger()
    const text = formatReceipt(buildReceipt({ store, ledger }))
    expect(text).toContain("turns:      0 · tool calls: 0 · batch —/msg")
  })

  it("each per-tier line carries its own batch ratio after the tools count", () => {
    const store = makeStore()
    const ledger = new DoublePayLedger()
    const text = formatReceipt(buildReceipt({ store, ledger }))
    // conductor: 5 tool calls over 2 messages → 2.50; oracle: 5 over 1 → 5.00
    expect(text).toMatch(/conductor\s+2 turns.*5 tools \(2\.50\/msg\)/)
    expect(text).toMatch(/oracle\s+1 turn .*5 tools \(5\.00\/msg\)/)
  })

  it("renders a per-tier drilldown line for each tier with tokens, cost, cache, tools, and context", () => {
    const store = makeStore()
    const ledger = new DoublePayLedger()
    const text = formatReceipt(buildReceipt({ store, ledger }))
    expect(text).toContain("tiers:")
    expect(text).toContain("conductor")
    expect(text).toContain("oracle")
    expect(text).toMatch(/conductor\s+\d+ turns/)
    expect(text).toContain("cache")
    expect(text).toContain("tools")
    expect(text).toContain("ctx")
  })

  it("renders each catch entry with name, tier, and reason", () => {
    const store = singleEventStore()
    const ledger = new DoublePayLedger()
    const catches: ReceiptCatch[] = [
      { name: "src/risky.ts", tier: "oracle", reason: "blast-radius" },
    ]
    const text = formatReceipt(buildReceipt({ store, ledger, catches }))
    expect(text).toContain("catches:")
    expect(text).toContain("src/risky.ts")
    expect(text).toContain("oracle")
    expect(text).toContain("blast-radius")
  })

  it("omits 'catches:' section when catches is empty", () => {
    const store = singleEventStore()
    const ledger = new DoublePayLedger()
    const text = formatReceipt(buildReceipt({ store, ledger }))
    expect(text).not.toContain("catches:")
  })

  it("shows escalation count in double-pay line", () => {
    const store = singleEventStore()
    const ledger = new DoublePayLedger()
    ledger.add(
      recordEscalation({
        turnId: "fmt-1",
        cheap: { model: CONDUCTOR_MODEL, cost: 0.001, tokens: { input: 100, output: 50 } },
        oracle: { model: ORACLE_MODEL, cost: 0.01, tokens: { input: 500, output: 150 } },
      }),
    )
    const text = formatReceipt(buildReceipt({ store, ledger }))
    expect(text).toContain("1 escalation")
  })
})

// ---------------------------------------------------------------------------
// Cache honesty (n/r) + routing line
// ---------------------------------------------------------------------------

describe("formatReceipt — cache honesty + routing", () => {
  it("reasoner turns with no cache fields reported render a real '0.0%' (stream-accounted, W8) and a routing line with correct counts + cost", () => {
    const store = new TelemetryStore()
    emitUsageEvent(store, {
      sessionID: SESSION,
      model: REASONER_MODEL,
      tier: "reasoner",
      cost: 1.5,
      tokens: { input: 50_000, output: 2_000, reasoning: 1_000 },
      toolCalls: 4,
      timestamp: 1000,
    })
    emitUsageEvent(store, {
      sessionID: SESSION,
      model: REASONER_MODEL,
      tier: "reasoner",
      cost: 1.07,
      tokens: { input: 40_000, output: 1_500, reasoning: 800 },
      toolCalls: 3,
      timestamp: 2000,
    })
    const receipt = buildReceipt({ store, ledger: new DoublePayLedger() })
    const text = formatReceipt(receipt)
    expect(text).toMatch(/reasoner\s+2 turns.*cache 0\.0%/)
    expect(text).toContain("routing:    2 of 2 turns ran above conductor (reasoner: 2·$2.5700)")
  })

  it("all-conductor run omits the routing line entirely", () => {
    const store = new TelemetryStore()
    emitUsageEvent(store, {
      sessionID: SESSION,
      model: CONDUCTOR_MODEL,
      tier: "conductor",
      cost: 0.001,
      tokens: { input: 100, output: 50, cache: { read: 20, write: 5 } },
      toolCalls: 4,
      timestamp: 1000,
    })
    const receipt = buildReceipt({ store, ledger: new DoublePayLedger() })
    const text = formatReceipt(receipt)
    expect(text).not.toContain("routing:")
  })

  it("a stream-accounted tier with real cache reads keeps its numeric percentage unchanged", () => {
    const store = makeStore()
    const receipt = buildReceipt({ store, ledger: new DoublePayLedger() })
    const text = formatReceipt(receipt)
    // conductor is cacheAccounting:"stream" with real cache reads: cacheHitRatio = 400/1500 ≈ 26.7%
    expect(text).toMatch(/conductor\s+2 turns.*cache 26\.7%/)
  })
})
