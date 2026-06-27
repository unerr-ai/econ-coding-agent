/**
 * S7.2 savings receipt unit tests.
 *
 * Covers:
 *  1. buildReceipt — tier split shares sum to ~1; largeTierTokenShare +
 *     estimatedReduction = 1; HONEST dollar path (netSavings = grossSavings −
 *     wastedCost); double-pay subtraction reduces netSavings by exactly the
 *     wastedCost; baseline-omitted leaves $ fields undefined; catches pass-
 *     through; largeTiers override.
 *  2. formatReceipt — header, NET SAVED presence/absence, double-pay label,
 *     reduction %, catches rendering.
 *
 * Uses real TelemetryStore + DoublePayLedger throughout (no mocks).
 */

import { describe, it, expect } from "bun:test"
import { buildReceipt, formatReceipt } from "../src/receipt.ts"
import type { FrontierBaseline, ReceiptCatch } from "../src/receipt.ts"
import { TelemetryStore, emitUsageEvent } from "../src/telemetry.ts"
import { DoublePayLedger, recordEscalation } from "../src/double-pay.ts"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Frontier baseline priced like a top-tier model (~Claude Opus rates).
 * Simple round numbers make hand-verification easy.
 *   cheap event:  (500*15 + 100*75)/1e6 = 0.015
 *   oracle event: (1000*15 + 300*75)/1e6 = 0.0375
 */
const BASELINE: FrontierBaseline = {
  model: "claude-opus-4",
  inputPerMTok: 15,
  outputPerMTok: 75,
}

const SESSION = "rcpt-sess"

/**
 * Build a store with 2 cheap + 1 oracle turn — non-trivial tier mix.
 *
 *   cheap ×2: tokens input=500 output=100, sumTokens=600 each, cost=0.0005 each
 *   oracle ×1: tokens input=1000 output=300, sumTokens=1300, cost=0.018
 *
 * Totals:
 *   totalTokens = 600+600+1300 = 2500
 *   cheapShare  = 1200/2500 = 0.48
 *   oracleShare = 1300/2500 = 0.52
 *   actualCost  = 0.0005+0.0005+0.018 = 0.019
 *
 * Frontier costs (BASELINE):
 *   cheap ×2: 0.015 each → 0.030
 *   oracle:   0.0375
 *   total:    0.0675
 *   grossSavings = 0.0675 − 0.019 = 0.0485
 */
function makeStore(): TelemetryStore {
  const store = new TelemetryStore()
  emitUsageEvent(store, {
    sessionID: SESSION,
    model: "claude-haiku-3",
    cost: 0.0005,
    tokens: { input: 500, output: 100 },
    timestamp: 1000,
  })
  emitUsageEvent(store, {
    sessionID: SESSION,
    model: "claude-haiku-3",
    cost: 0.0005,
    tokens: { input: 500, output: 100 },
    timestamp: 2000,
  })
  emitUsageEvent(store, {
    sessionID: SESSION,
    model: "anthropic/claude-opus-4",
    cost: 0.018,
    tokens: { input: 1000, output: 300 },
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

  it("cheap and oracle rows have non-trivial, distinct tokenShares", () => {
    const store = makeStore()
    const ledger = new DoublePayLedger()
    const receipt = buildReceipt({ store, ledger })
    const cheapRow = receipt.tierSplit.find((r) => r.tier === "cheap")
    const oracleRow = receipt.tierSplit.find((r) => r.tier === "oracle")
    expect(cheapRow?.tokenShare).toBeCloseTo(0.48)
    expect(oracleRow?.tokenShare).toBeCloseTo(0.52)
  })

  it("oracle is the default large tier: largeTierTokenShare ≈ oracleShare", () => {
    const store = makeStore()
    const ledger = new DoublePayLedger()
    const receipt = buildReceipt({ store, ledger })
    // Default large tiers = oracle, reasoner, frontier — only oracle present here
    expect(receipt.largeTierTokenShare).toBeCloseTo(0.52)
    // estimatedReduction = 1 − 0.52 = 0.48
    expect(receipt.estimatedReduction).toBeCloseTo(0.48)
  })

  // ---- HONEST dollar path -------------------------------------------------

  it("HONEST $: netSavings = grossSavings − ledger.totalWastedCost", () => {
    const store = makeStore()
    const ledger = new DoublePayLedger()
    ledger.add(
      recordEscalation({
        turnId: "t-1",
        cheap: { model: "claude-haiku-3", cost: 0.0005, tokens: { input: 500, output: 100 } },
        oracle: {
          model: "anthropic/claude-opus-4",
          cost: 0.018,
          tokens: { input: 1000, output: 300 },
        },
      }),
    )
    const receipt = buildReceipt({ store, ledger, baseline: BASELINE })

    expect(receipt.grossSavings).toBeDefined()
    expect(receipt.netSavings).toBeDefined()
    expect(receipt.netSavings).toBeCloseTo(receipt.grossSavings! - ledger.totalWastedCost)
  })

  it("adding an escalation reduces netSavings by exactly the wastedCost", () => {
    const store = makeStore()
    const wastedCost = 0.0005

    // Build receipt without any escalation
    const ledger0 = new DoublePayLedger()
    const receiptBefore = buildReceipt({ store, ledger: ledger0, baseline: BASELINE })
    const netBefore = receiptBefore.netSavings!

    // Now add one escalation
    const ledger1 = new DoublePayLedger()
    ledger1.add(
      recordEscalation({
        turnId: "esc-1",
        cheap: { model: "claude-haiku-3", cost: wastedCost, tokens: { input: 500, output: 100 } },
        oracle: {
          model: "anthropic/claude-opus-4",
          cost: 0.018,
          tokens: { input: 1000, output: 300 },
        },
      }),
    )
    const receiptAfter = buildReceipt({ store, ledger: ledger1, baseline: BASELINE })

    expect(receiptAfter.netSavings).toBeCloseTo(netBefore - wastedCost)
  })

  it("grossSavings = frontierBaselineCost − actualCost", () => {
    const store = makeStore()
    const ledger = new DoublePayLedger()
    const receipt = buildReceipt({ store, ledger, baseline: BASELINE })

    // frontierBaselineCost ≈ 0.015 + 0.015 + 0.0375 = 0.0675
    // actualCost ≈ 0.019
    expect(receipt.frontierBaselineCost).toBeCloseTo(0.0675)
    expect(receipt.actualCost).toBeCloseTo(0.019)
    expect(receipt.grossSavings).toBeCloseTo(receipt.frontierBaselineCost! - receipt.actualCost)
  })

  // ---- baseline-omitted path ----------------------------------------------

  it("baseline-omitted: frontierBaselineCost, grossSavings, netSavings are undefined", () => {
    const store = makeStore()
    const ledger = new DoublePayLedger()
    const receipt = buildReceipt({ store, ledger })
    expect(receipt.frontierBaselineCost).toBeUndefined()
    expect(receipt.grossSavings).toBeUndefined()
    expect(receipt.netSavings).toBeUndefined()
  })

  it("baseline-omitted: actualCost and tierSplit are still populated", () => {
    const store = makeStore()
    const ledger = new DoublePayLedger()
    const receipt = buildReceipt({ store, ledger })
    expect(receipt.actualCost).toBeCloseTo(0.019)
    expect(receipt.tierSplit.length).toBeGreaterThan(0)
    expect(receipt.turns).toBe(3)
  })

  // ---- doublePay field ----------------------------------------------------

  it("doublePay reflects the ledger snapshot at receipt build time", () => {
    const store = makeStore()
    const ledger = new DoublePayLedger()
    ledger.add(
      recordEscalation({
        turnId: "t-snap",
        cheap: { model: "claude-haiku-3", cost: 0.0005, tokens: { input: 500, output: 100 } },
        oracle: {
          model: "anthropic/claude-opus-4",
          cost: 0.018,
          tokens: { input: 1000, output: 300 },
        },
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

    // Mutate ledger after receipt is built
    ledger.add(
      recordEscalation({
        turnId: "t-late",
        cheap: { model: "claude-haiku-3", cost: 0.001, tokens: { input: 500, output: 100 } },
        oracle: {
          model: "anthropic/claude-opus-4",
          cost: 0.015,
          tokens: { input: 1000, output: 300 },
        },
      }),
    )
    // The already-built receipt must not reflect the later mutation
    expect(receipt.doublePay.escalations).toBe(0)
    expect(receipt.doublePay.wastedCost).toBe(0)
  })

  // ---- catches pass-through -----------------------------------------------

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

  // ---- largeTiers override -------------------------------------------------

  it("largeTiers override controls which tiers count as large", () => {
    const store = makeStore()
    const ledger = new DoublePayLedger()
    // Only "cheap" as large — oracle excluded
    const receipt = buildReceipt({ store, ledger, largeTiers: ["cheap"] })
    const cheapRow = receipt.tierSplit.find((r) => r.tier === "cheap")
    expect(receipt.largeTierTokenShare).toBeCloseTo(cheapRow?.tokenShare ?? -1)
    // estimatedReduction = 1 − cheapShare ≈ 1 − 0.48 = 0.52
    expect(receipt.estimatedReduction).toBeCloseTo(1 - (cheapRow?.tokenShare ?? -1))
  })
})

// ---------------------------------------------------------------------------
// formatReceipt
// ---------------------------------------------------------------------------

describe("formatReceipt", () => {
  /** Minimal store: one cheap event. */
  function singleEventStore(): TelemetryStore {
    const store = new TelemetryStore()
    emitUsageEvent(store, {
      sessionID: SESSION,
      model: "claude-haiku-3",
      cost: 0.001,
      tokens: { input: 100, output: 50 },
      timestamp: 1000,
    })
    return store
  }

  it("contains the header line 'econ savings receipt'", () => {
    const store = singleEventStore()
    const ledger = new DoublePayLedger()
    const text = formatReceipt(buildReceipt({ store, ledger }))
    expect(text).toContain("econ savings receipt")
  })

  it("always contains the 'double-pay' line", () => {
    const store = singleEventStore()
    const ledger = new DoublePayLedger()
    const text = formatReceipt(buildReceipt({ store, ledger }))
    expect(text).toContain("double-pay")
  })

  it("contains 'NET SAVED' when baseline is provided (netSavings present)", () => {
    const store = singleEventStore()
    const ledger = new DoublePayLedger()
    const text = formatReceipt(buildReceipt({ store, ledger, baseline: BASELINE }))
    expect(text).toContain("NET SAVED")
  })

  it("does NOT contain 'NET SAVED' when no baseline provided", () => {
    const store = singleEventStore()
    const ledger = new DoublePayLedger()
    const text = formatReceipt(buildReceipt({ store, ledger }))
    expect(text).not.toContain("NET SAVED")
  })

  it("contains the reduction label and a percentage", () => {
    const store = singleEventStore()
    const ledger = new DoublePayLedger()
    const text = formatReceipt(buildReceipt({ store, ledger }))
    expect(text).toContain("reduction:")
    // Should contain a percentage somewhere on that line
    expect(text).toMatch(/reduction:\s+[\d.]+%/)
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

  it("contains 'vs frontier' and 'gross saved' when baseline given", () => {
    const store = singleEventStore()
    const ledger = new DoublePayLedger()
    const text = formatReceipt(buildReceipt({ store, ledger, baseline: BASELINE }))
    expect(text).toContain("vs frontier:")
    expect(text).toContain("gross saved:")
  })

  it("shows escalation count in double-pay line", () => {
    const store = singleEventStore()
    const ledger = new DoublePayLedger()
    ledger.add(
      recordEscalation({
        turnId: "fmt-1",
        cheap: { model: "claude-haiku-3", cost: 0.001, tokens: { input: 100, output: 50 } },
        oracle: {
          model: "anthropic/claude-opus-4",
          cost: 0.01,
          tokens: { input: 500, output: 150 },
        },
      }),
    )
    const text = formatReceipt(buildReceipt({ store, ledger }))
    expect(text).toContain("1 escalation")
  })
})
