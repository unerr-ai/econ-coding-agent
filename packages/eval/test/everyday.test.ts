/**
 * Unit tests for the everyday-capability eval (OL-7.12) — test-poor repo
 * scanning, signal detection, per-metric scoring, the flip-gate rollup, and
 * the mock-trace runner. Offline only — no network, no live binary spawn
 * (the live sources short-circuit on the ECON_EVAL_LIVE=1 gate, which these
 * tests never set).
 * Run with: bun test packages/eval/test/everyday.test.ts
 */

import { describe, expect, it } from "bun:test"
import { EVERYDAY_CASES } from "../src/everyday-cases.js"
import { runEverydayEval, runEverydayFlipGate } from "../src/everyday-harness.js"
import {
  binaryClarifySource,
  binaryCoherenceSource,
  binaryLatencySource,
  liveRunEnabled,
} from "../src/everyday-live-source.js"
import { evaluateFlipGate, renderEverydayReport, scoreEverydayCase } from "../src/everyday-scorer.js"
import type { ClarifyCase, CoherenceCase, LatencyCase } from "../src/everyday-types.js"
import { isTestPoor, scanRepoFileCounts, TEST_POOR_REPOS } from "../src/test-poor-repos.js"

// ── TEST_POOR_REPOS ─────────────────────────────────────────────────────────

describe("TEST_POOR_REPOS", () => {
  it("has at least 2 registered repos", () => {
    expect(TEST_POOR_REPOS.length).toBeGreaterThanOrEqual(2)
  })

  it("every registered repo is test-poor (zero test files) on disk", () => {
    for (const repo of TEST_POOR_REPOS) {
      expect(isTestPoor(repo)).toBe(true)
    }
  })

  it("every registered repo has at least one real source file", () => {
    for (const repo of TEST_POOR_REPOS) {
      const counts = scanRepoFileCounts(repo)
      expect(counts.sourceFileCount).toBeGreaterThan(0)
      expect(counts.testFileCount).toBe(0)
    }
  })
})

// ── EVERYDAY_CASES ──────────────────────────────────────────────────────────

describe("EVERYDAY_CASES", () => {
  it("covers all three metrics", () => {
    const metrics = new Set(EVERYDAY_CASES.map((c) => c.metric))
    expect(metrics.has("trivial_latency")).toBe(true)
    expect(metrics.has("clarify_vs_guess")).toBe(true)
    expect(metrics.has("multiturn_coherence")).toBe(true)
  })

  it("references at least one registered test-poor repo", () => {
    const repoIds = new Set(TEST_POOR_REPOS.map((r) => r.id))
    const referenced = EVERYDAY_CASES.some((c) => "repoId" in c && c.repoId && repoIds.has(c.repoId))
    expect(referenced).toBe(true)
  })

  it("includes at least one ambiguous and one control clarify case", () => {
    const clarifyCases = EVERYDAY_CASES.filter((c): c is ClarifyCase => c.metric === "clarify_vs_guess")
    expect(clarifyCases.some((c) => c.ambiguous)).toBe(true)
    expect(clarifyCases.some((c) => !c.ambiguous)).toBe(true)
  })

  it("each case's canned/mock fields pass its own scoring", () => {
    for (const c of EVERYDAY_CASES) {
      const result = scoreEverydayCase(c)
      expect(result.pass).toBe(true)
    }
  })
})

// ── scoreEverydayCase — trivial_latency ──────────────────────────────────────

describe("scoreEverydayCase() — trivial_latency", () => {
  const base: LatencyCase = {
    id: "t",
    metric: "trivial_latency",
    prompt: "p",
    baselineLatencyMs: 900,
    decomposeLatencyMs: 900,
    maxDeltaMs: 250,
  }

  it("passes when the decompose delta is within the ceiling", () => {
    const result = scoreEverydayCase({ ...base, decomposeLatencyMs: 1000 })
    expect(result.pass).toBe(true)
  })

  it("fails when decomposition ceremony pushes the delta past the ceiling", () => {
    const result = scoreEverydayCase({ ...base, decomposeLatencyMs: 2000 })
    expect(result.pass).toBe(false)
  })

  it("passes when decompose is actually faster than baseline (negative delta)", () => {
    const result = scoreEverydayCase({ ...base, baselineLatencyMs: 1500, decomposeLatencyMs: 900 })
    expect(result.pass).toBe(true)
  })
})

// ── scoreEverydayCase — clarify_vs_guess ─────────────────────────────────────

describe("scoreEverydayCase() — clarify_vs_guess", () => {
  const base: ClarifyCase = {
    id: "c",
    metric: "clarify_vs_guess",
    repoId: "tiny-cli-tool",
    prompt: "p",
    ambiguous: true,
    threshold: 1.0,
    mockTrace: { textParts: [], toolCalls: [], latencyMs: 100 },
  }

  it("passes an ambiguous case whose trace asks a clarifying question", () => {
    const result = scoreEverydayCase({
      ...base,
      mockTrace: { textParts: ["Which target format do you mean?"], toolCalls: [], latencyMs: 100 },
    })
    expect(result.pass).toBe(true)
  })

  it("fails an ambiguous case whose trace guesses instead of clarifying", () => {
    const result = scoreEverydayCase({
      ...base,
      mockTrace: { textParts: ["Done — reformatted all dates to ISO."], toolCalls: [], latencyMs: 100 },
    })
    expect(result.pass).toBe(false)
  })

  it("passes an unambiguous control case that proceeds without clarifying", () => {
    const result = scoreEverydayCase({
      ...base,
      ambiguous: false,
      mockTrace: { textParts: ["Added the LICENSE file."], toolCalls: [], latencyMs: 100 },
    })
    expect(result.pass).toBe(true)
  })

  it("fails an unambiguous control case that over-clarifies", () => {
    const result = scoreEverydayCase({
      ...base,
      ambiguous: false,
      mockTrace: { textParts: ["Which license text do you want exactly?"], toolCalls: [], latencyMs: 100 },
    })
    expect(result.pass).toBe(false)
  })
})

// ── scoreEverydayCase — multiturn_coherence ──────────────────────────────────

describe("scoreEverydayCase() — multiturn_coherence", () => {
  const base: CoherenceCase = {
    id: "m",
    metric: "multiturn_coherence",
    repoId: "tiny-cli-tool",
    turnPrompts: ["set the fact", "unrelated turn", "recall the fact"],
    compactionAtTurn: 2,
    factToRecall: "node 18",
    threshold: 1.0,
    mockTurns: [
      { textParts: ["ok"], toolCalls: [], latencyMs: 100 },
      { textParts: ["ok"], toolCalls: [], latencyMs: 100 },
      { textParts: ["still targeting Node 18"], toolCalls: [], latencyMs: 100 },
    ],
  }

  it("passes when the scored turn recalls the fact (case-insensitive)", () => {
    expect(scoreEverydayCase(base).pass).toBe(true)
  })

  it("fails when the scored turn loses the fact after compaction", () => {
    const dropped: CoherenceCase = {
      ...base,
      mockTurns: [base.mockTurns[0]!, base.mockTurns[1]!, { textParts: ["done"], toolCalls: [], latencyMs: 100 }],
    }
    expect(scoreEverydayCase(dropped).pass).toBe(false)
  })
})

// ── evaluateFlipGate ─────────────────────────────────────────────────────────

describe("evaluateFlipGate()", () => {
  it("passes for EVERYDAY_CASES (the golden mock set) and reports a test-poor repo in the set", async () => {
    const results = await runEverydayEval(EVERYDAY_CASES)
    const summary = evaluateFlipGate(EVERYDAY_CASES, results)
    expect(summary.includesTestPoorRepo).toBe(true)
    expect(summary.pass).toBe(true)
  })

  it("fails overall when any one metric has a failing case", async () => {
    const results = await runEverydayEval(EVERYDAY_CASES)
    const brokenResults = results.map((r, i) => (i === 0 ? { ...r, pass: false } : r))
    const summary = evaluateFlipGate(EVERYDAY_CASES, brokenResults)
    expect(summary.pass).toBe(false)
  })

  it("fails when the case set has no test-poor repo", () => {
    const noRepoCases = EVERYDAY_CASES.filter((c) => c.metric === "trivial_latency").map((c) => ({ ...c, repoId: undefined }))
    const results = noRepoCases.map(scoreEverydayCase)
    const summary = evaluateFlipGate(noRepoCases, results)
    expect(summary.includesTestPoorRepo).toBe(false)
    expect(summary.pass).toBe(false)
  })
})

// ── renderEverydayReport ──────────────────────────────────────────────────────

describe("renderEverydayReport()", () => {
  it("includes each case id and the FLIP GATE verdict line", async () => {
    const results = await runEverydayEval(EVERYDAY_CASES)
    const summary = evaluateFlipGate(EVERYDAY_CASES, results)
    const report = renderEverydayReport(summary)
    for (const c of EVERYDAY_CASES) {
      expect(report).toContain(c.id)
    }
    expect(report).toContain("FLIP GATE")
  })
})

// ── runEverydayEval / runEverydayFlipGate (integration) ──────────────────────

describe("runEverydayEval() / runEverydayFlipGate()", () => {
  it("returns one result per case", async () => {
    const results = await runEverydayEval(EVERYDAY_CASES)
    expect(results.length).toBe(EVERYDAY_CASES.length)
  })

  it("runEverydayFlipGate composes eval + gate in one call", async () => {
    const summary = await runEverydayFlipGate(EVERYDAY_CASES)
    expect(summary.pass).toBe(true)
  })
})

// ── live-source env gate (must never spawn without ECON_EVAL_LIVE=1) ────────

describe("live sources — env gate", () => {
  it("liveRunEnabled() is false in the test environment", () => {
    expect(liveRunEnabled()).toBe(false)
  })

  it("binaryLatencySource returns the case unchanged (no spawn) when the gate is off", async () => {
    const c = EVERYDAY_CASES.find((c): c is LatencyCase => c.metric === "trivial_latency")!
    const result = await binaryLatencySource(c)
    expect(result).toEqual(c)
  })

  it("binaryClarifySource returns the case unchanged (no spawn) when the gate is off", async () => {
    const c = EVERYDAY_CASES.find((c): c is ClarifyCase => c.metric === "clarify_vs_guess")!
    const result = await binaryClarifySource(c)
    expect(result).toEqual(c)
  })

  it("binaryCoherenceSource returns the case unchanged (no spawn) when the gate is off", async () => {
    const c = EVERYDAY_CASES.find((c): c is CoherenceCase => c.metric === "multiturn_coherence")!
    const result = await binaryCoherenceSource(c)
    expect(result).toEqual(c)
  })
})
