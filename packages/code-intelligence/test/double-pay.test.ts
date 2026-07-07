/**
 * S3.6 double-pay accounting unit tests.
 *
 * Covers:
 *  1. recordEscalation — shape, totalCost, wastedCost, emit callback.
 *  2. DoublePayLedger — non-escalated turn accrues nothing; escalated turn
 *     accumulates correctly; multiple turns sum; snapshot is a stable
 *     point-in-time copy.
 *  3. Mixed-session scenario — cheap-only turn + escalated turn → ledger
 *     tracks the wasted double-pay cost.
 */

import { describe, it, expect } from "bun:test"
import { recordEscalation, DoublePayLedger } from "../src/double-pay.ts"
import type { EscalationCost } from "../src/double-pay.ts"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CHEAP_MODEL = "qwen/qwen-2.5-coder-32b-instruct"
const ORACLE_MODEL = "anthropic/claude-opus-4"

function cheapCall(cost = 0.0012) {
  return { model: CHEAP_MODEL, cost, tokens: { input: 1200, output: 320 } }
}

function oracleCall(cost = 0.018) {
  return { model: ORACLE_MODEL, cost, tokens: { input: 1200, output: 480 } }
}

// ---------------------------------------------------------------------------
// recordEscalation
// ---------------------------------------------------------------------------

describe("recordEscalation", () => {
  it("sets tier fields automatically", () => {
    const rec = recordEscalation({ turnId: "t-001", cheap: cheapCall(), oracle: oracleCall() })
    expect(rec.cheap.tier).toBe("cheap")
    expect(rec.oracle.tier).toBe("oracle")
  })

  it("totalCost = cheap.cost + oracle.cost", () => {
    const rec = recordEscalation({ turnId: "t-002", cheap: cheapCall(0.0015), oracle: oracleCall(0.02) })
    expect(rec.totalCost).toBeCloseTo(0.0015 + 0.02)
  })

  it("wastedCost = cheap.cost", () => {
    const rec = recordEscalation({ turnId: "t-003", cheap: cheapCall(0.0015), oracle: oracleCall(0.02) })
    expect(rec.wastedCost).toBeCloseTo(0.0015)
  })

  it("preserves model names and token counts", () => {
    const rec = recordEscalation({
      turnId: "t-004",
      cheap: { model: CHEAP_MODEL, cost: 0.001, tokens: { input: 500, output: 100, cacheRead: 50 } },
      oracle: oracleCall(),
    })
    expect(rec.cheap.model).toBe(CHEAP_MODEL)
    expect(rec.cheap.tokens.cacheRead).toBe(50)
    expect(rec.oracle.model).toBe(ORACLE_MODEL)
  })

  it("calls emit callback with the completed record", () => {
    const received: EscalationCost[] = []
    recordEscalation({
      turnId: "t-005",
      cheap: cheapCall(),
      oracle: oracleCall(),
      emit: (r) => received.push(r),
    })
    expect(received).toHaveLength(1)
    expect(received[0]?.turnId).toBe("t-005")
  })

  it("does not throw when emit is omitted", () => {
    expect(() =>
      recordEscalation({ turnId: "t-006", cheap: cheapCall(), oracle: oracleCall() }),
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// DoublePayLedger
// ---------------------------------------------------------------------------

describe("DoublePayLedger", () => {
  it("starts empty", () => {
    const ledger = new DoublePayLedger()
    expect(ledger.escalations).toBe(0)
    expect(ledger.totalWastedCost).toBe(0)
  })

  it("non-escalated turn: caller does not call add() — ledger stays empty", () => {
    const ledger = new DoublePayLedger()
    // A cheap-only turn that succeeded — the router never creates an EscalationCost
    // so no add() call is made. Ledger must remain pristine.
    expect(ledger.escalations).toBe(0)
    expect(ledger.totalWastedCost).toBe(0)
  })

  it("accumulates one escalated turn", () => {
    const ledger = new DoublePayLedger()
    ledger.add(recordEscalation({ turnId: "e-001", cheap: cheapCall(0.001), oracle: oracleCall(0.015) }))

    expect(ledger.escalations).toBe(1)
    expect(ledger.totalWastedCost).toBeCloseTo(0.001)
  })

  it("accumulates multiple escalated turns", () => {
    const ledger = new DoublePayLedger()
    ledger.add(recordEscalation({ turnId: "e-001", cheap: cheapCall(0.001), oracle: oracleCall(0.01) }))
    ledger.add(recordEscalation({ turnId: "e-002", cheap: cheapCall(0.002), oracle: oracleCall(0.02) }))

    expect(ledger.escalations).toBe(2)
    expect(ledger.totalWastedCost).toBeCloseTo(0.003)
  })

  it("snapshot returns a stable point-in-time copy", () => {
    const ledger = new DoublePayLedger()
    ledger.add(recordEscalation({ turnId: "e-001", cheap: cheapCall(0.001), oracle: oracleCall(0.01) }))
    const snap = ledger.snapshot()

    // Mutate ledger after snapshot
    ledger.add(recordEscalation({ turnId: "e-002", cheap: cheapCall(0.002), oracle: oracleCall(0.02) }))

    // Snapshot must not reflect the later addition
    expect(snap.escalations).toBe(1)
    expect(snap.totalWastedCost).toBeCloseTo(0.001)
    // Ledger itself is updated
    expect(ledger.escalations).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Mixed-session scenario
// ---------------------------------------------------------------------------

describe("mixed session: cheap-only turns + escalated turn", () => {
  it("ledger tracks the wasted double-pay cost of an escalated turn", () => {
    const ledger = new DoublePayLedger()

    // Turn A: cheap model succeeds — no escalation, no ledger entry.
    // Turn B: cheap model fails → oracle invoked; both costs are paid.
    const escB = recordEscalation({
      turnId: "turn-B",
      cheap: cheapCall(0.0015),
      oracle: oracleCall(0.018),
    })
    ledger.add(escB)

    // Shape assertions on the escalated turn
    expect(escB.totalCost).toBeCloseTo(0.0015 + 0.018)
    expect(escB.wastedCost).toBeCloseTo(0.0015)
    expect(escB.cheap.tier).toBe("cheap")
    expect(escB.oracle.tier).toBe("oracle")

    // Ledger reflects only the one escalation
    expect(ledger.escalations).toBe(1)
    expect(ledger.totalWastedCost).toBeCloseTo(0.0015)
  })
})
