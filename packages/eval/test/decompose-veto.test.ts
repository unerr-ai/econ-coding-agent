/**
 * Unit tests for the OL-7.6 decompose-vs-risk-veto A/B eval — aggregation,
 * arm diffing, the flip criterion, and the harness's env-set/restore
 * plumbing — all against recorded fixture results (no live process, no
 * network), per the plan's offline-first architecture for OL-7.6.
 * Run with: bun test packages/eval/test/decompose-veto.test.ts
 */

import { describe, expect, it } from "bun:test"
import {
  DECOMPOSE_FIXTURE_RESULTS,
  DECOMPOSE_VETO_TASKS,
  RISK_VETO_FIXTURE_RESULTS,
} from "../src/decompose-veto-fixtures.js"
import { runArm, runDecomposeVetoComparison } from "../src/decompose-veto-harness.js"
import {
  compareArms,
  meetsFlipCriterion,
  renderDecomposeVetoReport,
  summarizeArm,
} from "../src/decompose-veto-scorer.js"
import type { DecomposeVetoTask, OrchestrationMode, TaskArmResult } from "../src/decompose-veto-types.js"

// ── summarizeArm() ───────────────────────────────────────────────────────────

describe("summarizeArm()", () => {
  it("aggregates pass rate, cost, latency, and escalations from recorded results", () => {
    const summary = summarizeArm("decompose", DECOMPOSE_FIXTURE_RESULTS)
    expect(summary.taskCount).toBe(3)
    expect(summary.passRate).toBeCloseTo(1, 5)
    expect(summary.totalCostUsd).toBeCloseTo(0.031 + 0.0012 + 0.0016, 6)
    expect(summary.totalEscalations).toBe(1)
    expect(summary.escalationRate).toBeCloseTo(1 / 3, 5)
  })

  it("computes doublePayRate as wasted cost / total cost", () => {
    const summary = summarizeArm("decompose", DECOMPOSE_FIXTURE_RESULTS)
    expect(summary.totalWastedCostUsd).toBeCloseTo(0.0002, 6)
    expect(summary.doublePayRate).toBeCloseTo(0.0002 / summary.totalCostUsd, 6)
  })

  it("returns an all-zero, vacuously-passing summary for an empty result set", () => {
    const summary = summarizeArm("risk-veto", [])
    expect(summary.taskCount).toBe(0)
    expect(summary.passRate).toBe(1)
    expect(summary.totalCostUsd).toBe(0)
    expect(summary.doublePayRate).toBe(0)
  })
})

// ── compareArms() ────────────────────────────────────────────────────────────

describe("compareArms()", () => {
  it("shows decompose materially cheaper at >= parity quality on the fixture set (plan §4.4 worked example)", () => {
    const decompose = summarizeArm("decompose", DECOMPOSE_FIXTURE_RESULTS)
    const riskVeto = summarizeArm("risk-veto", RISK_VETO_FIXTURE_RESULTS)
    const report = compareArms(decompose, riskVeto)
    expect(report.costDeltaPct).toBeGreaterThan(0.8) // decompose is ~7x cheaper on this set
    expect(report.qualityDeltaPct).toBeGreaterThanOrEqual(0) // decompose fixes the risk-veto miss
  })
})

// ── meetsFlipCriterion() ─────────────────────────────────────────────────────

describe("meetsFlipCriterion()", () => {
  it("passes on the fixture set with default criteria", () => {
    const decompose = summarizeArm("decompose", DECOMPOSE_FIXTURE_RESULTS)
    const riskVeto = summarizeArm("risk-veto", RISK_VETO_FIXTURE_RESULTS)
    const report = compareArms(decompose, riskVeto)
    expect(meetsFlipCriterion(report)).toBe(true)
  })

  it("fails when a quality regression exceeds the parity tolerance", () => {
    // risk-veto's passRate on the fixture set is 2/3 (only add-retry-boot fails) — drop
    // decompose to 1/3 (two failures) so its passRate falls strictly below risk-veto's.
    const regressed: TaskArmResult[] = [
      { ...DECOMPOSE_FIXTURE_RESULTS[0]!, success: false },
      { ...DECOMPOSE_FIXTURE_RESULTS[1]!, success: false },
      DECOMPOSE_FIXTURE_RESULTS[2]!,
    ]
    const decompose = summarizeArm("decompose", regressed)
    const riskVeto = summarizeArm("risk-veto", RISK_VETO_FIXTURE_RESULTS)
    const report = compareArms(decompose, riskVeto)
    expect(meetsFlipCriterion(report, { minCostReductionPct: 0, qualityParityTolerance: 0 })).toBe(false)
  })

  it("fails when cost reduction misses a stricter minimum", () => {
    const decompose = summarizeArm("decompose", DECOMPOSE_FIXTURE_RESULTS)
    const riskVeto = summarizeArm("risk-veto", RISK_VETO_FIXTURE_RESULTS)
    const report = compareArms(decompose, riskVeto)
    expect(meetsFlipCriterion(report, { minCostReductionPct: 0.99, qualityParityTolerance: 0 })).toBe(false)
  })
})

// ── renderDecomposeVetoReport() ──────────────────────────────────────────────

describe("renderDecomposeVetoReport()", () => {
  it("includes both arms and the flip verdict", () => {
    const decompose = summarizeArm("decompose", DECOMPOSE_FIXTURE_RESULTS)
    const riskVeto = summarizeArm("risk-veto", RISK_VETO_FIXTURE_RESULTS)
    const text = renderDecomposeVetoReport(compareArms(decompose, riskVeto))
    expect(text).toContain("decompose")
    expect(text).toContain("risk-veto")
    expect(text).toContain("meetsFlipCriterion=true")
  })
})

// ── runArm() ──────────────────────────────────────────────────────────────────

describe("runArm()", () => {
  it("sets ECON_ORCHESTRATION for the arm's duration and restores the prior value", async () => {
    const saved = process.env["ECON_ORCHESTRATION"]
    process.env["ECON_ORCHESTRATION"] = "sentinel"
    let seenDuringRun: string | undefined
    const runner = async (task: DecomposeVetoTask, mode: OrchestrationMode): Promise<TaskArmResult> => {
      seenDuringRun = process.env["ECON_ORCHESTRATION"]
      return {
        taskId: task.id,
        mode,
        success: true,
        latencyMs: 1,
        tokens: { input: 0, output: 0 },
        costUsd: 0,
        escalations: 0,
        wastedCostUsd: 0,
      }
    }
    await runArm(DECOMPOSE_VETO_TASKS, "decompose", runner)
    expect(seenDuringRun).toBe("decompose")
    expect(process.env["ECON_ORCHESTRATION"]).toBe("sentinel")
    process.env["ECON_ORCHESTRATION"] = saved
  })

  it("restores an unset ECON_ORCHESTRATION (deletes it) even when the runner throws", async () => {
    const saved = process.env["ECON_ORCHESTRATION"]
    delete process.env["ECON_ORCHESTRATION"]
    const throwingRunner = async (): Promise<TaskArmResult> => {
      throw new Error("boom")
    }
    await expect(runArm(DECOMPOSE_VETO_TASKS, "risk-veto", throwingRunner)).rejects.toThrow("boom")
    expect(process.env["ECON_ORCHESTRATION"]).toBeUndefined()
    if (saved !== undefined) process.env["ECON_ORCHESTRATION"] = saved
  })
})

// ── runDecomposeVetoComparison() ─────────────────────────────────────────────

describe("runDecomposeVetoComparison()", () => {
  it("runs both arms against an injected runner and returns a scored report", async () => {
    const fixturesByMode: Record<OrchestrationMode, TaskArmResult[]> = {
      decompose: DECOMPOSE_FIXTURE_RESULTS,
      "risk-veto": RISK_VETO_FIXTURE_RESULTS,
    }
    const runner = async (task: DecomposeVetoTask, mode: OrchestrationMode): Promise<TaskArmResult> => {
      const fixture = fixturesByMode[mode].find((r) => r.taskId === task.id)
      if (!fixture) throw new Error(`no fixture for ${task.id}/${mode}`)
      return fixture
    }
    const { report, decompose, riskVeto } = await runDecomposeVetoComparison(DECOMPOSE_VETO_TASKS, runner)
    expect(decompose).toHaveLength(DECOMPOSE_VETO_TASKS.length)
    expect(riskVeto).toHaveLength(DECOMPOSE_VETO_TASKS.length)
    expect(meetsFlipCriterion(report)).toBe(true)
  })
})
