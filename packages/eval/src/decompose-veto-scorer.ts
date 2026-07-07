/**
 * Aggregation + report math for the OL-7.6 decompose-vs-risk-veto A/B
 * comparison — summarizes one arm's per-task results into an ArmSummary,
 * diffs two arms into the decision report (cost delta, quality delta,
 * double-pay rate), and checks the "flip the default" criterion. Pure — no
 * I/O — so it is fully unit-testable on recorded fixture results, matching
 * the plan's offline-first architecture for OL-7.6.
 * @sem domain=eval role=scoring
 */

import type {
  ArmSummary,
  DecomposeVetoReport,
  FlipCriteria,
  OrchestrationMode,
  TaskArmResult,
} from "./decompose-veto-types.js"
import { DEFAULT_FLIP_CRITERIA } from "./decompose-veto-types.js"

/**
 * Aggregates one arm's per-task results into its ArmSummary. Empty input
 * yields an all-zero summary with a vacuous passRate of 1 (nothing failed),
 * mirroring loop-scorer's vacuous-pass convention for an inapplicable case.
 */
export function summarizeArm(mode: OrchestrationMode, results: readonly TaskArmResult[]): ArmSummary {
  const taskCount = results.length
  if (taskCount === 0) {
    return {
      mode,
      taskCount: 0,
      passRate: 1,
      totalCostUsd: 0,
      avgCostUsd: 0,
      avgLatencyMs: 0,
      totalEscalations: 0,
      escalationRate: 0,
      totalWastedCostUsd: 0,
      doublePayRate: 0,
    }
  }

  let passed = 0
  let totalCostUsd = 0
  let totalLatencyMs = 0
  let totalEscalations = 0
  let totalWastedCostUsd = 0

  for (const r of results) {
    if (r.success) passed += 1
    totalCostUsd += r.costUsd
    totalLatencyMs += r.latencyMs
    totalEscalations += r.escalations
    totalWastedCostUsd += r.wastedCostUsd
  }

  return {
    mode,
    taskCount,
    passRate: passed / taskCount,
    totalCostUsd,
    avgCostUsd: totalCostUsd / taskCount,
    avgLatencyMs: totalLatencyMs / taskCount,
    totalEscalations,
    escalationRate: totalEscalations / taskCount,
    totalWastedCostUsd,
    doublePayRate: totalCostUsd > 0 ? totalWastedCostUsd / totalCostUsd : 0,
  }
}

/** Diffs the decompose arm against the risk-veto baseline into the OL-7.6 decision report. */
export function compareArms(decompose: ArmSummary, riskVeto: ArmSummary): DecomposeVetoReport {
  const costDeltaPct =
    riskVeto.totalCostUsd > 0 ? (riskVeto.totalCostUsd - decompose.totalCostUsd) / riskVeto.totalCostUsd : 0
  return {
    decompose,
    riskVeto,
    costDeltaPct,
    qualityDeltaPct: decompose.passRate - riskVeto.passRate,
    doublePayRateDelta: decompose.doublePayRate - riskVeto.doublePayRate,
  }
}

/**
 * OL-7.6 done-when check: decompose must show a materially lower net cost
 * (>= minCostReductionPct) at >= parity quality (within qualityParityTolerance).
 * Historical/offline signal only — orchestration is unconditional in
 * production as of 2026-07-04, so this no longer gates a default flip.
 */
export function meetsFlipCriterion(
  report: DecomposeVetoReport,
  criteria: FlipCriteria = DEFAULT_FLIP_CRITERIA,
): boolean {
  return (
    report.costDeltaPct >= criteria.minCostReductionPct &&
    report.qualityDeltaPct >= -criteria.qualityParityTolerance
  )
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`
}

/** Renders a human-readable OL-7.6 A/B report — mirrors loop-scorer's renderLoopReport format. */
export function renderDecomposeVetoReport(
  report: DecomposeVetoReport,
  criteria: FlipCriteria = DEFAULT_FLIP_CRITERIA,
): string {
  const lines: string[] = []
  lines.push("\necon eval — OL-7.6 decompose vs risk-veto")
  lines.push("=".repeat(60))
  for (const arm of [report.decompose, report.riskVeto]) {
    lines.push(`  ${arm.mode}`)
    lines.push(
      `    tasks=${arm.taskCount} passRate=${pct(arm.passRate)} totalCost=$${arm.totalCostUsd.toFixed(4)} ` +
        `avgLatency=${arm.avgLatencyMs.toFixed(0)}ms`,
    )
    lines.push(
      `    escalations=${arm.totalEscalations} (rate=${arm.escalationRate.toFixed(2)}/task) ` +
        `doublePayRate=${pct(arm.doublePayRate)}`,
    )
  }
  lines.push("  deltas (decompose vs risk-veto)")
  lines.push(
    `    costDelta=${pct(report.costDeltaPct)} qualityDelta=${pct(report.qualityDeltaPct)} ` +
      `doublePayRateDelta=${pct(report.doublePayRateDelta)}`,
  )
  const flips = meetsFlipCriterion(report, criteria)
  lines.push(
    `  meetsFlipCriterion=${flips} (minCostReduction=${pct(criteria.minCostReductionPct)}, ` +
      `qualityTolerance=${pct(criteria.qualityParityTolerance)})`,
  )
  lines.push("")
  return lines.join("\n")
}
