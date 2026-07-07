/**
 * Unit tests for the decomposition-quality eval (OL-7.4) — DAG-shape scoring
 * and allocation-placement scoring, both run through the real
 * `todosToLoopSlices` + `allocateSlice` with no model call.
 * Run with: bun test packages/eval/test/decomp.test.ts
 */

import { describe, expect, it } from "bun:test"
import { DECOMP_CASES } from "../src/decomp-cases.js"
import { runDecompEval } from "../src/decomp-harness.js"
import { renderDecompReport, scoreDecompCase } from "../src/decomp-scorer.js"
import type { DecompCase } from "../src/decomp-types.js"

const baseCase = (overrides: Partial<DecompCase>): DecompCase => ({
  id: "test-case",
  prompt: "test prompt",
  threshold: 1.0,
  mockTodos: [
    {
      content: "do the one thing",
      status: "pending",
      sliceType: "mechanical",
      need: "executor",
      coupling: "low",
      testStrength: "testable",
    },
  ],
  expectedSlices: [
    {
      content: "do the one thing",
      sliceType: "mechanical",
      deps: [],
      coupling: "low",
      testStrength: "testable",
      tier: "executor",
      verification: "sound",
    },
  ],
  ...overrides,
})

// ── DECOMP_CASES ─────────────────────────────────────────────────────────────

describe("DECOMP_CASES", () => {
  it("has at least 5 cases", () => {
    expect(DECOMP_CASES.length).toBeGreaterThanOrEqual(5)
  })

  it("each case scores a perfect pass against its own hand-labeled expectations", async () => {
    for (const c of DECOMP_CASES) {
      const result = await scoreDecompCase(c)
      expect(result.notes).toEqual([])
      expect(result.weightedScore).toBe(1)
      expect(result.pass).toBe(true)
    }
  })

  it("covers all four (coupling × test-strength) matrix cells", () => {
    const cells = DECOMP_CASES.flatMap((c) => c.expectedSlices).map((s) => `${s.coupling}-${s.testStrength}`)
    expect(cells).toContain("low-testable")
    expect(cells).toContain("low-untestable")
    expect(cells).toContain("high-testable")
    expect(cells).toContain("high-untestable")
  })

  it("covers a design slice (forced to oracle) and a need-hint-ignored slice", () => {
    expect(DECOMP_CASES.some((c) => c.expectedSlices.some((s) => s.sliceType === "design"))).toBe(true)
    expect(DECOMP_CASES.some((c) => c.expectedSlices.some((s) => s.needHintShouldBeIgnored))).toBe(true)
  })

  it("covers a multi-slice DAG with dependency edges", () => {
    expect(DECOMP_CASES.some((c) => c.expectedSlices.some((s) => (s.deps?.length ?? 0) > 0))).toBe(true)
  })
})

// ── runDecompEval ────────────────────────────────────────────────────────────

describe("runDecompEval()", () => {
  it("returns one result per case, in case order", async () => {
    const results = await runDecompEval(DECOMP_CASES)
    expect(results.map((r) => r.caseId)).toEqual(DECOMP_CASES.map((c) => c.id))
  })

  it("renderDecompReport renders a line per case without throwing", async () => {
    const results = await runDecompEval(DECOMP_CASES)
    const report = renderDecompReport(results)
    for (const c of DECOMP_CASES) expect(report).toContain(c.id)
  })
})

// ── scoreDecompCase — DAG-shape scoring catches malformed decompositions ─────

describe("scoreDecompCase() — DAG-shape signals", () => {
  it("flags a wrong sliceType", async () => {
    const c = baseCase({ mockTodos: [{ ...baseCase({}).mockTodos[0]!, sliceType: "recon" }] })
    const result = await scoreDecompCase(c)
    expect(result.signals.slice_types_valid).toBe(false)
    expect(result.pass).toBe(false)
  })

  it("flags a missing dependency edge (missed dependency)", async () => {
    const c = baseCase({
      expectedSlices: [{ ...baseCase({}).expectedSlices[0]!, deps: ["some upstream slice"] }],
    })
    const result = await scoreDecompCase(c)
    expect(result.signals.deps_sane).toBe(false)
    expect(result.pass).toBe(false)
  })

  it("flags a dependency cycle as unsound (planWaves throws)", async () => {
    const c = baseCase({
      mockTodos: [
        { content: "slice A", status: "pending", sliceType: "mechanical", deps: ["slice B"], coupling: "low", testStrength: "testable" },
        { content: "slice B", status: "pending", sliceType: "mechanical", deps: ["slice A"], coupling: "low", testStrength: "testable" },
      ],
      expectedSlices: [
        { content: "slice A", sliceType: "mechanical", deps: ["slice B"], coupling: "low", testStrength: "testable", tier: "executor", verification: "sound" },
        { content: "slice B", sliceType: "mechanical", deps: ["slice A"], coupling: "low", testStrength: "testable", tier: "executor", verification: "sound" },
      ],
    })
    const result = await scoreDecompCase(c)
    expect(result.signals.deps_sane).toBe(false)
    expect(result.notes.some((n) => /cycle/.test(n))).toBe(true)
  })

  it("flags over-fragmentation (more slices produced than expected)", async () => {
    const c = baseCase({
      mockTodos: [
        ...baseCase({}).mockTodos,
        { content: "an extra unplanned slice", status: "pending", sliceType: "mechanical", coupling: "low", testStrength: "testable" },
      ],
    })
    const result = await scoreDecompCase(c)
    expect(result.signals.no_over_fragmentation).toBe(false)
    expect(result.pass).toBe(false)
  })
})

// ── scoreDecompCase — allocation-placement scoring ───────────────────────────

describe("scoreDecompCase() — allocation-placement signals", () => {
  it("flags a wrong expected matrix cell", async () => {
    const c = baseCase({
      expectedSlices: [{ ...baseCase({}).expectedSlices[0]!, tier: "oracle", verification: "judge" }],
    })
    const result = await scoreDecompCase(c)
    expect(result.signals.allocation_matches_cell).toBe(false)
    expect(result.pass).toBe(false)
  })

  it("passes when a needHintShouldBeIgnored slice's tier is genuinely held to executor", async () => {
    const c = baseCase({
      mockTodos: [{ ...baseCase({}).mockTodos[0]!, need: "oracle" }],
      expectedSlices: [{ ...baseCase({}).expectedSlices[0]!, needHintShouldBeIgnored: true }],
    })
    const result = await scoreDecompCase(c)
    expect(result.signals.need_not_over_escalating).toBe(true)
    expect(result.signals.allocation_matches_cell).toBe(true)
    expect(result.pass).toBe(true)
  })

  it("flags a slice mislabeled as needHintShouldBeIgnored when the hint actually wins (design exemption)", async () => {
    // A design slice's need hint is never "ignored" — design always forces oracle
    // regardless of need, so tier === need here is expected behavior, not a bug.
    // needHintShouldBeIgnored only makes sense for a non-design, testable slice.
    const c = baseCase({
      mockTodos: [{ content: "design the thing", status: "pending", sliceType: "design", need: "oracle", coupling: "low", testStrength: "untestable" }],
      expectedSlices: [
        {
          content: "design the thing",
          sliceType: "design",
          deps: [],
          coupling: "low",
          testStrength: "untestable",
          tier: "oracle",
          verification: "qe",
          needHintShouldBeIgnored: true,
        },
      ],
    })
    const result = await scoreDecompCase(c)
    // tier legitimately equals the "oracle" need hint here (design forces it anyway),
    // so the over-escalation check correctly flags this mislabeled fixture.
    expect(result.signals.need_not_over_escalating).toBe(false)
  })
})
