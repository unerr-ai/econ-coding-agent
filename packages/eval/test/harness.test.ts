/**
 * Unit tests for the eval harness — scorer and mock provider.
 * Run with: bun test packages/eval/test/harness.test.ts
 */

import { describe, expect, it } from "bun:test"
import { FIXTURES } from "../src/fixtures.js"
import { mockTierConfig, runHarness } from "../src/harness.js"
import { score, renderReport } from "../src/scorer.js"
import type { RunResult } from "../src/types.js"

// ── fixtures ─────────────────────────────────────────────────────────────────

describe("FIXTURES", () => {
  it("has at least 4 fixtures", () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(4)
  })

  it("covers all three tiers", () => {
    const tiers = new Set(FIXTURES.map((f) => f.tier))
    expect(tiers.has("conductor")).toBe(true)
    expect(tiers.has("executor")).toBe(true)
    expect(tiers.has("oracle")).toBe(true)
  })

  it("each fixture's mockResponse passes its own check", () => {
    for (const f of FIXTURES) {
      expect(f.check(f.mockResponse)).toBe(true)
    }
  })
})

// ── scorer ────────────────────────────────────────────────────────────────────

describe("score()", () => {
  const makeRun = (overrides: Partial<RunResult>): RunResult => ({
    fixtureId: "test-fixture",
    tier: "executor",
    modelName: "test-model",
    pass: true,
    output: "ok",
    latencyMs: 100,
    inputTokens: 50,
    outputTokens: 20,
    costUsd: 0.000001,
    ...overrides,
  })

  it("aggregates pass rate correctly", () => {
    const runs: RunResult[] = [
      makeRun({ pass: true, fixtureId: "a" }),
      makeRun({ pass: false, fixtureId: "b" }),
    ]
    const shortlist = score(runs)
    expect(shortlist.executor[0]?.passRate).toBe(0.5)
  })

  it("sums cost across fixtures", () => {
    const runs: RunResult[] = [
      makeRun({ costUsd: 0.000001, fixtureId: "a" }),
      makeRun({ costUsd: 0.000002, fixtureId: "b" }),
    ]
    const shortlist = score(runs)
    expect(shortlist.executor[0]?.totalCostUsd).toBeCloseTo(0.000003)
  })

  it("sorts by passRate desc then costUsd asc", () => {
    const runs: RunResult[] = [
      makeRun({ modelName: "cheap-bad", pass: false, costUsd: 0.000001, fixtureId: "a" }),
      makeRun({ modelName: "expensive-good", pass: true, costUsd: 0.000999, fixtureId: "b" }),
    ]
    const shortlist = score(runs)
    expect(shortlist.executor[0]?.modelName).toBe("expensive-good")
    expect(shortlist.executor[1]?.modelName).toBe("cheap-bad")
  })
})

// ── renderReport ──────────────────────────────────────────────────────────────

describe("renderReport()", () => {
  it("includes DRY-RUN tag when dryRun=true", () => {
    const shortlist = score([])
    const report = renderReport(shortlist, true)
    expect(report).toContain("DRY-RUN")
  })

  it("omits DRY-RUN tag when dryRun=false", () => {
    const shortlist = score([])
    const report = renderReport(shortlist, false)
    expect(report).not.toContain("DRY-RUN")
  })
})

// ── integration: mock harness run ────────────────────────────────────────────

describe("runHarness() with mock provider", () => {
  it("returns a shortlist with all tiers populated", async () => {
    const config = mockTierConfig()
    const shortlist = await runHarness(FIXTURES, config)

    expect(shortlist.conductor.length).toBeGreaterThan(0)
    expect(shortlist.executor.length).toBeGreaterThan(0)
    expect(shortlist.oracle.length).toBeGreaterThan(0)
  })

  it("all mock runs pass (mock responses satisfy checks)", async () => {
    const config = mockTierConfig()
    const shortlist = await runHarness(FIXTURES, config)

    for (const tier of ["conductor", "executor", "oracle"] as const) {
      for (const ts of shortlist[tier]) {
        expect(ts.passRate).toBe(1)
      }
    }
  })

  it("records non-zero token counts", async () => {
    const config = mockTierConfig()
    const shortlist = await runHarness(FIXTURES, config)

    for (const tier of ["conductor", "executor", "oracle"] as const) {
      for (const ts of shortlist[tier]) {
        expect(ts.totalInputTokens).toBeGreaterThan(0)
        expect(ts.totalOutputTokens).toBeGreaterThan(0)
      }
    }
  })
})
