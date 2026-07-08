/**
 * Unit tests for allocation.ts: allocateSlice — the (coupling × test-strength)
 * matrix (OL-7.2). Pure function tests: no I/O, all inputs inline fixtures.
 *
 * The load-bearing assertion is the CORE INVARIANT of the decomposition-first
 * reframe: a high-coupling *testable* slice does NOT escalate to oracle — the
 * sound check is the safety net. Everything else (risk, the conductor need hint)
 * is only an in-cell tiebreaker and can never break that invariant. A second
 * load-bearing assertion (SM5): `design` routes to the reasoner regardless of
 * which coupling/test-strength cell it lands in — coupling and difficulty are
 * different axes, so a testable/high-coupling design slice must not be demoted
 * to the executor. `reasonCode` pins the machine-readable factor behind each tier.
 */

import { describe, it, expect } from "bun:test"
import { allocateSlice, ALLOCATION_RISK_TIEBREAK, type SliceAllocationInput } from "../src/allocation.js"

// ---------------------------------------------------------------------------
// The four matrix cells (coupling × test-strength), no type / hint / risk
// ---------------------------------------------------------------------------

describe("allocateSlice — the four matrix cells", () => {
  it("low-coupling · testable → executor + sound", () => {
    const a = allocateSlice({ coupling: "low", testStrength: "testable" })
    expect(a.tier).toBe("executor")
    expect(a.verification).toBe("sound")
  })

  it("high-coupling · testable → executor + sound (NOT oracle — the core invariant)", () => {
    const a = allocateSlice({ coupling: "high", testStrength: "testable" })
    expect(a.tier).toBe("executor")
    expect(a.tier).not.toBe("oracle")
    expect(a.verification).toBe("sound")
  })

  it("low-coupling · untestable → executor + qe", () => {
    const a = allocateSlice({ coupling: "low", testStrength: "untestable" })
    expect(a.tier).toBe("executor")
    expect(a.verification).toBe("qe")
  })

  it("high-coupling · untestable → oracle + judge (the residual)", () => {
    const a = allocateSlice({ coupling: "high", testStrength: "untestable" })
    expect(a.tier).toBe("oracle")
    expect(a.verification).toBe("judge")
  })
})

// ---------------------------------------------------------------------------
// CORE INVARIANT — testable slices never reach oracle, under any pressure
// ---------------------------------------------------------------------------

describe("allocateSlice — core invariant: testable never escalates to oracle", () => {
  const testablePressures: SliceAllocationInput[] = [
    { coupling: "high", testStrength: "testable", risk: 100 },
    { coupling: "high", testStrength: "testable", need: "oracle" },
    { coupling: "high", testStrength: "testable", need: "reasoner", risk: 99 },
    { coupling: "low", testStrength: "testable", need: "oracle", risk: 95 },
    { coupling: "high", testStrength: "testable", sliceType: "mechanical", need: "oracle", risk: 100 },
  ]

  for (const input of testablePressures) {
    it(`stays executor under ${JSON.stringify(input)}`, () => {
      const a = allocateSlice(input)
      expect(a.tier).toBe("executor")
      expect(a.verification).toBe("sound")
    })
  }

  it("a maxed-out risk score cannot push a high-coupling testable slice to oracle", () => {
    const a = allocateSlice({ coupling: "high", testStrength: "testable", risk: ALLOCATION_RISK_TIEBREAK + 30 })
    expect(a.tier).toBe("executor")
  })
})

// ---------------------------------------------------------------------------
// Slice type — only `design` forces the oracle floor
// ---------------------------------------------------------------------------

describe("allocateSlice — slice type", () => {
  it("design → reasoner even when low-coupling and testable", () => {
    const a = allocateSlice({ sliceType: "design", coupling: "low", testStrength: "testable" })
    expect(a.tier).toBe("reasoner")
    expect(a.reasonCode).toBe("design-insight")
  })

  // SM5 regression: coupling and difficulty are different axes. An atomic
  // insight bug (django-11885: combine fast-delete queries with
  // defaultdict(list) + reduce(operator.or_, …)) can sit in the
  // high-coupling·testable cell and still exceed executor capability — the
  // matrix must not demote it there because a sound check exists.
  it("design → reasoner even with HIGH coupling and testable (the SM5 fix — insight-heavy work routes up regardless of coupling)", () => {
    const a = allocateSlice({ sliceType: "design", coupling: "high", testStrength: "testable" })
    expect(a.tier).toBe("reasoner")
    expect(a.tier).not.toBe("executor")
    expect(a.reasonCode).toBe("design-insight")
  })

  it("design keeps a sound verifier when the slice is testable", () => {
    const a = allocateSlice({ sliceType: "design", testStrength: "testable" })
    expect(a.verification).toBe("sound")
  })

  it("design → judge verifier when untestable, tier stays reasoner (not oracle)", () => {
    const a = allocateSlice({ sliceType: "design", coupling: "high", testStrength: "untestable" })
    expect(a.tier).toBe("reasoner")
    expect(a.verification).toBe("judge")
  })

  it("mechanical / recon / verify flow through the matrix (testable → executor), unaffected by the design fix", () => {
    for (const sliceType of ["mechanical", "recon", "verify"] as const) {
      const a = allocateSlice({ sliceType, coupling: "high", testStrength: "testable" })
      expect(a.tier).toBe("executor")
      expect(a.reasonCode).toBe("testable-invariant")
    }
  })
})

// ---------------------------------------------------------------------------
// Risk tiebreaker — only the low-coupling·untestable borderline moves
// ---------------------------------------------------------------------------

describe("allocateSlice — risk is an in-cell tiebreaker", () => {
  it("high risk breaks the low-coupling·untestable borderline to oracle + judge", () => {
    const a = allocateSlice({ coupling: "low", testStrength: "untestable", risk: 90 })
    expect(a.tier).toBe("oracle")
    expect(a.verification).toBe("judge")
  })

  it("risk at the threshold does not break the borderline (strictly greater)", () => {
    const a = allocateSlice({ coupling: "low", testStrength: "untestable", risk: ALLOCATION_RISK_TIEBREAK })
    expect(a.tier).toBe("executor")
    expect(a.verification).toBe("qe")
  })

  it("low risk leaves the low-coupling·untestable cell on executor + qe", () => {
    const a = allocateSlice({ coupling: "low", testStrength: "untestable", risk: 10 })
    expect(a.tier).toBe("executor")
    expect(a.verification).toBe("qe")
  })
})

// ---------------------------------------------------------------------------
// Conductor `need` hint — raises, never lowers, never breaks the invariant
// ---------------------------------------------------------------------------

describe("allocateSlice — need hint", () => {
  it("need raises a low-coupling·untestable slice from executor to oracle", () => {
    const a = allocateSlice({ coupling: "low", testStrength: "untestable", need: "oracle" })
    expect(a.tier).toBe("oracle")
  })

  it("need cannot lower a design slice below its reasoner floor (matrix decides the floor)", () => {
    const a = allocateSlice({ sliceType: "design", need: "executor" })
    expect(a.tier).toBe("reasoner")
  })

  it("need CAN raise a design slice above its reasoner floor to oracle", () => {
    const a = allocateSlice({ sliceType: "design", need: "oracle" })
    expect(a.tier).toBe("oracle")
    expect(a.reasonCode).toBe("need-hint")
  })

  it("need cannot lower the high-coupling·untestable residual below oracle", () => {
    const a = allocateSlice({ coupling: "high", testStrength: "untestable", need: "conductor" })
    expect(a.tier).toBe("oracle")
  })

  it("an unknown need string is ignored (falls back to the matrix)", () => {
    const a = allocateSlice({ coupling: "low", testStrength: "untestable", need: "supercomputer" })
    expect(a.tier).toBe("executor")
  })

  it("need raises an untestable slice to reasoner", () => {
    const a = allocateSlice({ coupling: "low", testStrength: "untestable", need: "reasoner" })
    expect(a.tier).toBe("reasoner")
  })
})

// ---------------------------------------------------------------------------
// specBacked — an unbacked mechanical/untestable edit has neither a design
// patch to transcribe nor a sound check to catch it, so the reasoner authors
// it instead; a design patch (specBacked) or a sound check keeps it cheap.
// ---------------------------------------------------------------------------

describe("allocateSlice — specBacked (mechanical + untestable)", () => {
  it("mechanical · untestable · low-coupling · unbacked → reasoner authors the edit (qe unchanged)", () => {
    const a = allocateSlice({ sliceType: "mechanical", coupling: "low", testStrength: "untestable" })
    expect(a.tier).toBe("reasoner")
    expect(a.verification).toBe("qe")
  })

  it("mechanical · untestable · low-coupling · specBacked → stays executor (design patch to transcribe)", () => {
    const a = allocateSlice({ sliceType: "mechanical", coupling: "low", testStrength: "untestable", specBacked: true })
    expect(a.tier).toBe("executor")
    expect(a.verification).toBe("qe")
  })

  it("mechanical · testable · low-coupling · unbacked → still executor (core invariant untouched)", () => {
    const a = allocateSlice({ sliceType: "mechanical", coupling: "low", testStrength: "testable" })
    expect(a.tier).toBe("executor")
    expect(a.verification).toBe("sound")
  })

  it("non-mechanical sliceType (recon) · untestable · low-coupling → still executor", () => {
    const a = allocateSlice({ sliceType: "recon", coupling: "low", testStrength: "untestable" })
    expect(a.tier).toBe("executor")
    expect(a.verification).toBe("qe")
  })
})

// ---------------------------------------------------------------------------
// Defensive defaults — partially- or un-tagged slices still allocate cheaply
// ---------------------------------------------------------------------------

describe("allocateSlice — defensive defaults", () => {
  it("an empty input defaults to low-coupling·untestable → executor + qe", () => {
    const a = allocateSlice({})
    expect(a.tier).toBe("executor")
    expect(a.verification).toBe("qe")
  })

  it("missing coupling defaults to low (testable → executor)", () => {
    const a = allocateSlice({ testStrength: "testable" })
    expect(a.tier).toBe("executor")
    expect(a.verification).toBe("sound")
  })

  it("missing testStrength is treated as untestable (no assumed safety net)", () => {
    const a = allocateSlice({ coupling: "high" })
    expect(a.tier).toBe("oracle")
    expect(a.verification).toBe("judge")
  })

  it("always returns a non-empty reason trace", () => {
    expect(allocateSlice({ coupling: "high", testStrength: "testable" }).reason.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// reasonCode — machine-readable telemetry for the deciding factor (SM5)
// ---------------------------------------------------------------------------

describe("allocateSlice — reasonCode telemetry", () => {
  it("tags the high-coupling·untestable residual", () => {
    const a = allocateSlice({ coupling: "high", testStrength: "untestable" })
    expect(a.reasonCode).toBe("high-coupling-untestable-residual")
  })

  it("tags the low-coupling·untestable default", () => {
    const a = allocateSlice({ coupling: "low", testStrength: "untestable" })
    expect(a.reasonCode).toBe("untestable-default")
  })

  it("tags an unbacked mechanical/untestable slice", () => {
    const a = allocateSlice({ sliceType: "mechanical", coupling: "low", testStrength: "untestable" })
    expect(a.reasonCode).toBe("mechanical-unbacked")
  })

  it("tags a risk-tiebreak override", () => {
    const a = allocateSlice({ coupling: "low", testStrength: "untestable", risk: 90 })
    expect(a.reasonCode).toBe("risk-tiebreak")
  })
})
