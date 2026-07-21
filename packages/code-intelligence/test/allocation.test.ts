/**
 * Unit tests for allocation.ts: allocateSlice — the TWO-AXIS reframe (OL-7.2,
 * corpus R5). Pure function tests: no I/O, all inputs inline fixtures.
 *
 * The load-bearing assertion is the CORE INVARIANT of the two-axis reframe:
 * the GENERATOR tier follows DIFFICULTY (hardness/ambiguity + design +
 * unbacked-authoring) — CONSEQUENCE (coupling/risk) never escalates it, it
 * only escalates the VERIFIER rung (→ judge). A high-coupling *testable*
 * slice therefore still does NOT escalate to oracle — the sound check is the
 * safety net — but now neither does a high-coupling *untestable* slice: it
 * stays on the executor while the verifier alone absorbs the coupling/risk.
 * A second load-bearing assertion (SM5): `design` routes to the oracle
 * regardless of coupling/test-strength. A third (the difficulty floor):
 * `hardness==="hard"` or `ambiguity==="ambiguous"` floors the generator at
 * the oracle — and ambiguity is the one case that overrides the testable
 * clamp, because a sound check proves the code runs, never that it solved
 * the right problem. Gap-closure §4.3 (2026-07-19): every generator path that
 * used to land on the reasoner now redirects to the oracle — the reasoner is
 * judge-only, never a solve rung. `reasonCode` pins the machine-readable
 * factor behind each tier.
 */

import { describe, it, expect } from "bun:test"
import { allocateSlice, ALLOCATION_RISK_TIEBREAK, type SliceAllocationInput } from "../src/allocation.js"

// ---------------------------------------------------------------------------
// The four matrix cells (coupling × test-strength) — verifier rung only;
// the generator tier no longer follows coupling (see the two-axis block below).
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

  it("high-coupling · untestable → executor + judge (coupling routes the verifier, never the tier)", () => {
    const a = allocateSlice({ coupling: "high", testStrength: "untestable" })
    expect(a.tier).toBe("executor")
    expect(a.tier).not.toBe("oracle")
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
// Slice type — only `design` forces the oracle floor (§4.3: the reasoner is
// judge-only, so the insight-heavy floor lands one hop straight past it)
// ---------------------------------------------------------------------------

describe("allocateSlice — slice type", () => {
  it("design → oracle even when low-coupling and testable", () => {
    const a = allocateSlice({ sliceType: "design", coupling: "low", testStrength: "testable" })
    expect(a.tier).toBe("oracle")
    expect(a.reasonCode).toBe("design-insight")
  })

  // SM5 regression: coupling and difficulty are different axes. An atomic
  // insight bug (combine fast-delete queries with
  // defaultdict(list) + reduce(operator.or_, …)) can sit in the
  // high-coupling·testable cell and still exceed executor capability — the
  // matrix must not demote it there because a sound check exists.
  it("design → oracle even with HIGH coupling and testable (the SM5 fix — insight-heavy work routes up regardless of coupling)", () => {
    const a = allocateSlice({ sliceType: "design", coupling: "high", testStrength: "testable" })
    expect(a.tier).toBe("oracle")
    expect(a.tier).not.toBe("executor")
    expect(a.reasonCode).toBe("design-insight")
  })

  it("design keeps a sound verifier when the slice is testable", () => {
    const a = allocateSlice({ sliceType: "design", testStrength: "testable" })
    expect(a.verification).toBe("sound")
  })

  it("design → judge verifier when untestable, tier stays at the oracle floor (§4.3)", () => {
    const a = allocateSlice({ sliceType: "design", coupling: "high", testStrength: "untestable" })
    expect(a.tier).toBe("oracle")
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
// Risk tiebreaker — verifier only (low-coupling·untestable borderline moves
// to `judge`, the generator tier never moves)
// ---------------------------------------------------------------------------

describe("allocateSlice — risk is an in-cell verifier tiebreaker, never a generator escalator", () => {
  it("high risk breaks the low-coupling·untestable borderline to judge (verifier only — tier stays executor)", () => {
    const a = allocateSlice({ coupling: "low", testStrength: "untestable", risk: 90 })
    expect(a.tier).toBe("executor")
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
// The two-axis reframe — consequence (coupling/risk) never escalates the
// generator; only difficulty (hardness/ambiguity) does.
// ---------------------------------------------------------------------------

describe("allocateSlice — consequence (coupling/risk) never escalates the generator", () => {
  it("coupling never escalates the generator: high-coupling·untestable stays executor, only the verifier moves to judge", () => {
    const a = allocateSlice({ coupling: "high", testStrength: "untestable" })
    expect(a.tier).toBe("executor")
    expect(a.verification).toBe("judge")
    expect(a.reasonCode).toBe("untestable-default")
  })

  it("risk never escalates the generator: a high risk score stays executor, only the verifier moves to judge", () => {
    const a = allocateSlice({ coupling: "low", testStrength: "untestable", risk: 90 })
    expect(a.tier).toBe("executor")
    expect(a.verification).toBe("judge")
  })
})

// ---------------------------------------------------------------------------
// Difficulty floor — the sole structural→generator lever (hardness/ambiguity)
// ---------------------------------------------------------------------------

describe("allocateSlice — difficulty floor (the generator axis)", () => {
  it("hardness=\"hard\" floors a testable slice at oracle (overriding the executor default, §4.3)", () => {
    const a = allocateSlice({ testStrength: "testable", hardness: "hard" })
    expect(a.tier).toBe("oracle")
    expect(a.verification).toBe("sound")
    expect(a.reasonCode).toBe("difficulty-floor")
  })

  it("ambiguity=\"ambiguous\" overrides the testable clamp and floors at oracle", () => {
    const a = allocateSlice({ testStrength: "testable", ambiguity: "ambiguous" })
    expect(a.tier).toBe("oracle")
    expect(a.verification).toBe("sound")
    expect(a.reasonCode).toBe("difficulty-floor")
  })

  it("the floor never demotes: a trivial-hardness design slice stays at oracle (floor is a no-op)", () => {
    const a = allocateSlice({ sliceType: "design", hardness: "trivial" })
    expect(a.tier).toBe("oracle")
    expect(a.reasonCode).toBe("design-insight")
  })

  it("the floor never demotes: a hard design slice is already ≥oracle, so reasonCode stays design-insight", () => {
    const a = allocateSlice({ sliceType: "design", hardness: "hard" })
    expect(a.tier).toBe("oracle")
    expect(a.reasonCode).toBe("design-insight")
  })
})

// ---------------------------------------------------------------------------
// Conductor `need` hint — raises, never lowers, never breaks the invariant —
// except once ambiguity/hardness already broke the testable clamp.
// ---------------------------------------------------------------------------

describe("allocateSlice — need hint", () => {
  it("need raises a low-coupling·untestable slice from executor to oracle", () => {
    const a = allocateSlice({ coupling: "low", testStrength: "untestable", need: "oracle" })
    expect(a.tier).toBe("oracle")
  })

  it("need still raises a plain untestable slice to oracle, reasonCode need-hint", () => {
    const a = allocateSlice({ testStrength: "untestable", need: "oracle" })
    expect(a.tier).toBe("oracle")
    expect(a.reasonCode).toBe("need-hint")
  })

  it("need is ignored on a plain testable slice (sound-net invariant holds, reasonCode stays testable-invariant)", () => {
    const a = allocateSlice({ testStrength: "testable", need: "oracle" })
    expect(a.tier).toBe("executor")
    expect(a.reasonCode).toBe("testable-invariant")
  })

  it("need is a no-op once ambiguity already floors the tier at the oracle ceiling (§4.3 — nothing higher to raise to, reasonCode stays difficulty-floor)", () => {
    const a = allocateSlice({ testStrength: "testable", ambiguity: "ambiguous", need: "oracle" })
    expect(a.tier).toBe("oracle")
    expect(a.reasonCode).toBe("difficulty-floor")
  })

  it("need cannot lower a design slice below its oracle floor (matrix decides the floor)", () => {
    const a = allocateSlice({ sliceType: "design", need: "executor" })
    expect(a.tier).toBe("oracle")
  })

  it("need at the design slice's oracle floor is a no-op — reasonCode stays design-insight, not need-hint", () => {
    const a = allocateSlice({ sliceType: "design", need: "oracle" })
    expect(a.tier).toBe("oracle")
    expect(a.reasonCode).toBe("design-insight")
  })

  it("a low-ranked need (conductor) cannot lower a high-coupling·untestable slice below its executor default", () => {
    const a = allocateSlice({ coupling: "high", testStrength: "untestable", need: "conductor" })
    expect(a.tier).toBe("executor")
    expect(a.verification).toBe("judge")
  })

  it("an unknown need string is ignored (falls back to the matrix)", () => {
    const a = allocateSlice({ coupling: "low", testStrength: "untestable", need: "supercomputer" })
    expect(a.tier).toBe("executor")
  })

  it("a \"reasoner\" need hint redirects to oracle — the reasoner is judge-only, §4.3", () => {
    const a = allocateSlice({ coupling: "low", testStrength: "untestable", need: "reasoner" })
    expect(a.tier).toBe("oracle")
    expect(a.reasonCode).toBe("need-hint")
  })
})

// ---------------------------------------------------------------------------
// specBacked — an unbacked mechanical/untestable edit has neither a design
// patch to transcribe nor a sound check to catch it, so the oracle authors
// it instead (§4.3 — the reasoner is judge-only); a design patch
// (specBacked) or a sound check keeps it cheap.
// ---------------------------------------------------------------------------

describe("allocateSlice — specBacked (mechanical + untestable)", () => {
  it("mechanical · untestable · low-coupling · unbacked → oracle authors the edit (qe unchanged)", () => {
    const a = allocateSlice({ sliceType: "mechanical", coupling: "low", testStrength: "untestable" })
    expect(a.tier).toBe("oracle")
    expect(a.verification).toBe("qe")
    expect(a.reasonCode).toBe("mechanical-unbacked")
  })

  it("mechanical · untestable · low-coupling · specBacked → stays executor (design patch to transcribe)", () => {
    const a = allocateSlice({ sliceType: "mechanical", coupling: "low", testStrength: "untestable", specBacked: true })
    expect(a.tier).toBe("executor")
    expect(a.verification).toBe("qe")
    expect(a.reasonCode).toBe("untestable-default")
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

  it("missing testStrength is treated as untestable — routes the verifier to judge via coupling, but the generator still defaults to executor", () => {
    const a = allocateSlice({ coupling: "high" })
    expect(a.tier).toBe("executor")
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
  it("tags the high-coupling·untestable cell untestable-default (coupling no longer produces a distinct residual code)", () => {
    const a = allocateSlice({ coupling: "high", testStrength: "untestable" })
    expect(a.reasonCode).toBe("untestable-default")
  })

  it("tags the low-coupling·untestable default", () => {
    const a = allocateSlice({ coupling: "low", testStrength: "untestable" })
    expect(a.reasonCode).toBe("untestable-default")
  })

  it("tags an unbacked mechanical/untestable slice", () => {
    const a = allocateSlice({ sliceType: "mechanical", coupling: "low", testStrength: "untestable" })
    expect(a.reasonCode).toBe("mechanical-unbacked")
  })

  it("a risk-driven verifier tiebreak does not get its own reasonCode — it still tags untestable-default (risk-tiebreak was removed; risk only moves the verifier)", () => {
    const a = allocateSlice({ coupling: "low", testStrength: "untestable", risk: 90 })
    expect(a.reasonCode).toBe("untestable-default")
  })
})
