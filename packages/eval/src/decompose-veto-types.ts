/**
 * Types for the OL-7.6 decompose-vs-risk-veto A/B comparison runner: the
 * two orchestration arms, one task's per-arm result, and the aggregated
 * report the plan's §7/§8 metrics score from (net cost, quality, latency,
 * double-pay — not a raw benchmark delta). Offline/historical comparison
 * only — orchestration is unconditional in production as of 2026-07-04, so
 * this no longer gates a default flip.
 * @sem domain=eval role=types
 */

/** The two orchestration arms this eval compares (decompose vs the legacy risk-veto path, no longer live in production). */
export type OrchestrationMode = "decompose" | "risk-veto"

/** One task in the fixed real-repo task set OL-7.6's done-when references. */
export interface DecomposeVetoTask {
  id: string
  /** The prompt sent to the conductor under both arms. */
  prompt: string
}

/** Token counts for one task's run — mirrors code-intelligence/double-pay.ts's TurnTokens shape. */
export interface ArmTokens {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

/**
 * One task's outcome under one arm — the raw unit both the live driver
 * produces and the recorded fixtures stand in for in tests.
 */
export interface TaskArmResult {
  taskId: string
  mode: OrchestrationMode
  /** The eval's checker verdict for this task (pass/fail — task success). */
  success: boolean
  latencyMs: number
  tokens: ArmTokens
  /** Gross cost for this task's run (USD). */
  costUsd: number
  /** Count of slice/turn escalations that fired during this task's run. */
  escalations: number
  /** Double-pay: cheap spend discarded on escalation (double-pay.ts wastedCost), USD. */
  wastedCostUsd: number
}

/** Aggregated metrics for one arm across the whole task set. */
export interface ArmSummary {
  mode: OrchestrationMode
  taskCount: number
  /** Quality — fraction of tasks whose checker passed. */
  passRate: number
  totalCostUsd: number
  avgCostUsd: number
  avgLatencyMs: number
  totalEscalations: number
  /** Escalations per task — the residual-escalation-rate metric (plan §8). */
  escalationRate: number
  totalWastedCostUsd: number
  /** wastedCost / totalCost — the double-pay rate the plan names as a decision metric. */
  doublePayRate: number
}

/** The OL-7.6 decision report: both arm summaries plus the deltas that gate the default flip. */
export interface DecomposeVetoReport {
  decompose: ArmSummary
  riskVeto: ArmSummary
  /** (riskVeto.totalCost - decompose.totalCost) / riskVeto.totalCost — positive = decompose cheaper. */
  costDeltaPct: number
  /** decompose.passRate - riskVeto.passRate — 0 = parity, negative = decompose regresses quality. */
  qualityDeltaPct: number
  /** decompose.doublePayRate - riskVeto.doublePayRate. */
  doublePayRateDelta: number
}

/**
 * Thresholds gating the OL-7.6 "flip the default" decision — the done-when
 * reads "materially lower net cost at >= parity quality on the set."
 */
export interface FlipCriteria {
  /** Minimum cost reduction (fraction, e.g. 0.1 = 10%) decompose must show over risk-veto. */
  minCostReductionPct: number
  /** How far below parity (fraction) quality may fall and still count as "parity" (0 = strict). */
  qualityParityTolerance: number
}

/** Strict defaults: any cost reduction (>0) at no quality regression. Tune per the plan's OL-7.4/7.12 gates. */
export const DEFAULT_FLIP_CRITERIA: FlipCriteria = {
  minCostReductionPct: 0,
  qualityParityTolerance: 0,
}
