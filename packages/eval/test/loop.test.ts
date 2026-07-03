/**
 * Unit tests for the loop-adherence eval — signal detection, scoring, and
 * the mock-trace runner.
 * Run with: bun test packages/eval/test/loop.test.ts
 */

import { describe, expect, it } from "bun:test"
import { LOOP_CASES } from "../src/loop-cases.js"
import { runLoopEval } from "../src/loop-harness.js"
import { detectSignals, renderLoopReport, scoreLoopCase } from "../src/loop-scorer.js"
import type { LoopCase, LoopTrace } from "../src/loop-types.js"

const baseCase = (overrides: Partial<LoopCase>): LoopCase => ({
  id: "test-case",
  prompt: "test prompt",
  nontrivial: true,
  expectDelegation: false,
  expectVerification: false,
  threshold: 1.0,
  mockTrace: { textParts: [], toolCalls: [] },
  ...overrides,
})

// ── LOOP_CASES ───────────────────────────────────────────────────────────────

describe("LOOP_CASES", () => {
  it("has at least 3 cases", () => {
    expect(LOOP_CASES.length).toBeGreaterThanOrEqual(3)
  })

  it("each case's mockTrace passes its own scoring", () => {
    for (const c of LOOP_CASES) {
      const result = scoreLoopCase(c, c.mockTrace)
      expect(result.pass).toBe(true)
    }
  })

  it("covers a delegation-expected case and a trivial case", () => {
    expect(LOOP_CASES.some((c) => c.expectDelegation)).toBe(true)
    expect(LOOP_CASES.some((c) => !c.nontrivial)).toBe(true)
  })
})

// ── detectSignals ────────────────────────────────────────────────────────────

describe("detectSignals()", () => {
  it("detects has_meta_plan from a numbered opening plan", () => {
    const trace: LoopTrace = {
      textParts: ["Plan: 1) find the code 2) make the change 3) verify it works end to end."],
      toolCalls: [],
    }
    expect(detectSignals(baseCase({}), trace).has_meta_plan).toBe(true)
  })

  it("does not flag a short/no-plan opening as a meta-plan", () => {
    const trace: LoopTrace = { textParts: ["Sure."], toolCalls: [] }
    expect(detectSignals(baseCase({}), trace).has_meta_plan).toBe(false)
  })

  it("detects used_task_list from a todowrite tool call", () => {
    const trace: LoopTrace = { textParts: [], toolCalls: [{ name: "todowrite" }] }
    expect(detectSignals(baseCase({}), trace).used_task_list).toBe(true)
  })

  it("used_task_list is false with no todowrite call", () => {
    const trace: LoopTrace = { textParts: [], toolCalls: [{ name: "task" }] }
    expect(detectSignals(baseCase({}), trace).used_task_list).toBe(false)
  })

  it("delegated_when_expected is true when a task call occurred and delegation was expected", () => {
    const trace: LoopTrace = { textParts: [], toolCalls: [{ name: "task" }] }
    const c = baseCase({ expectDelegation: true })
    expect(detectSignals(c, trace).delegated_when_expected).toBe(true)
  })

  it("delegated_when_expected is false when expected but no task call occurred", () => {
    const trace: LoopTrace = { textParts: [], toolCalls: [] }
    const c = baseCase({ expectDelegation: true })
    expect(detectSignals(c, trace).delegated_when_expected).toBe(false)
  })

  it("delegated_when_expected is vacuously true when delegation isn't expected", () => {
    const trace: LoopTrace = { textParts: [], toolCalls: [] }
    const c = baseCase({ expectDelegation: false })
    expect(detectSignals(c, trace).delegated_when_expected).toBe(true)
  })

  it("verified_nontrivial is true when a task call's input mentions verification", () => {
    const trace: LoopTrace = {
      textParts: [],
      toolCalls: [{ name: "task", input: { description: "run typecheck and verify the change" } }],
    }
    const c = baseCase({ expectVerification: true })
    expect(detectSignals(c, trace).verified_nontrivial).toBe(true)
  })

  it("verified_nontrivial is false when expected but no verify-shaped task call occurred", () => {
    const trace: LoopTrace = { textParts: [], toolCalls: [{ name: "task", input: { description: "add the feature" } }] }
    const c = baseCase({ expectVerification: true })
    expect(detectSignals(c, trace).verified_nontrivial).toBe(false)
  })
})

// ── scoreLoopCase ─────────────────────────────────────────────────────────────

describe("scoreLoopCase()", () => {
  it("scores 1 and passes a fully trivial case with an empty trace", () => {
    const c = baseCase({ nontrivial: false, expectDelegation: false, expectVerification: false, threshold: 1.0 })
    const result = scoreLoopCase(c, { textParts: [], toolCalls: [] })
    expect(result.weightedScore).toBe(1)
    expect(result.pass).toBe(true)
  })

  it("scores 0 and fails a full-loop case whose trace skips every step", () => {
    const c = baseCase({
      nontrivial: true,
      expectDelegation: true,
      expectVerification: true,
      threshold: 1.0,
    })
    const result = scoreLoopCase(c, { textParts: ["Doing the work now."], toolCalls: [] })
    expect(result.weightedScore).toBe(0)
    expect(result.pass).toBe(false)
  })

  it("weights only the signals the case actually expects", () => {
    // nontrivial only (no delegation/verification expected): 2 applicable signals.
    const c = baseCase({ nontrivial: true, expectDelegation: false, expectVerification: false, threshold: 0.5 })
    const trace: LoopTrace = { textParts: [], toolCalls: [{ name: "todowrite" }] }
    const result = scoreLoopCase(c, trace)
    // has_meta_plan false, used_task_list true → 1 of 2 applicable signals.
    expect(result.weightedScore).toBeCloseTo(0.5)
    expect(result.pass).toBe(true)
  })
})

// ── renderLoopReport ──────────────────────────────────────────────────────────

describe("renderLoopReport()", () => {
  it("includes each case id and a pass/fail icon", () => {
    const results = LOOP_CASES.map((c) => scoreLoopCase(c, c.mockTrace))
    const report = renderLoopReport(results)
    for (const c of LOOP_CASES) {
      expect(report).toContain(c.id)
    }
    expect(report).toContain("✓")
  })
})

// ── runLoopEval (integration) ──────────────────────────────────────────────────

describe("runLoopEval()", () => {
  it("returns one result per case, all passing for LOOP_CASES", async () => {
    const results = await runLoopEval(LOOP_CASES)
    expect(results.length).toBe(LOOP_CASES.length)
    for (const r of results) {
      expect(r.pass).toBe(true)
    }
  })
})
