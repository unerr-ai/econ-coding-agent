/**
 * Per-repo go/no-go triage: decides whether cheap-first routing pays off for
 * a given repo based on observed pass-rate, cost ratio, and signal quality.
 * Answers "should we trust the conductor tier for this repo?" before any
 * session starts. Degrade-open: missing or zero-sample data defaults to
 * cheap-first so econ never crashes on sparse signal.
 *
 * @sem domain=routing role=triage
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Observed stats for a repo's routing history.
 * All fields should be finite numbers; NaN/Infinity triggers degrade-open.
 */
export interface TriageStats {
  /**
   * Fraction of turns (0–1) where the cheap tier (conductor) produced an
   * acceptable result without oracle escalation.
   */
  cheapPassRate: number
  /**
   * Relative cost of oracle vs conductor (e.g. 5 means oracle costs 5×).
   * Must be > 1 for routing to have any cost benefit.
   */
  costRatio: number
  /**
   * Signal discrimination quality: how well the risk signal separates
   * cheap-pass turns from cheap-fail turns (e.g. AUC or normalised
   * separation score, 0–1). Higher → risk signal is predictive.
   */
  signalDiscrimination: number
  /**
   * Number of observed turns used to compute the above statistics.
   * Too few → unreliable; triggers degrade-open below MIN_SAMPLE_SIZE.
   */
  sampleSize: number
}

/** Result returned by triageRepo. */
export interface TriageResult {
  /** Routing policy for this repo. */
  decision: "cheap-first" | "oracle-first"
  /**
   * When oracle-first, set to "oracle" so callers can pass it directly into
   * routeTurn({ forceTier }) and bypass risk logic entirely.
   * Absent when decision is "cheap-first".
   */
  forceTier?: "oracle"
  /** Human-readable explanation of the triage decision. */
  reason: string
}

// ---------------------------------------------------------------------------
// Defaults / thresholds
// ---------------------------------------------------------------------------

/** Minimum sample size before statistics are considered reliable. */
export const MIN_SAMPLE_SIZE = 30

/**
 * Minimum signal discrimination score to trust the risk signal as a
 * predictor (AUC equivalent; 0.5 = random, 1.0 = perfect).
 */
export const MIN_DISCRIMINATION = 0.6

// ---------------------------------------------------------------------------
// Core triage function
// ---------------------------------------------------------------------------

/**
 * Decides whether cheap-first routing pays for this repo.
 *
 * Go/no-go inequality (must ALL hold for cheap-first):
 *   cheapPassRate > 1/costRatio          — routing saves money in expectation
 *   signalDiscrimination >= 0.6          — risk signal actually predicts failures
 *   sampleSize >= 30                     — statistics are reliable
 *
 * Degrade-open rule: any NaN, Infinity, non-positive costRatio, or
 * sampleSize < 1 → cheap-first with reason "insufficient signal", no crash.
 *
 * @sem domain=routing role=triage
 */
export function triageRepo(
  stats: TriageStats,
  options: { minSampleSize?: number; minDiscrimination?: number } = {},
): TriageResult {
  const minSampleSize = options.minSampleSize ?? MIN_SAMPLE_SIZE
  const minDiscrimination = options.minDiscrimination ?? MIN_DISCRIMINATION

  const { cheapPassRate, costRatio, signalDiscrimination, sampleSize } = stats

  // Degrade-open: detect missing / degenerate signal before any comparison.
  if (
    !Number.isFinite(cheapPassRate) ||
    !Number.isFinite(costRatio) ||
    !Number.isFinite(signalDiscrimination) ||
    !Number.isFinite(sampleSize) ||
    sampleSize < 1 ||
    costRatio <= 0
  ) {
    return {
      decision: "cheap-first",
      reason: "insufficient signal",
    }
  }

  // Degrade-open: too few samples → statistics not trustworthy.
  if (sampleSize < minSampleSize) {
    return {
      decision: "cheap-first",
      reason: `insufficient signal (sampleSize=${sampleSize} < ${minSampleSize})`,
    }
  }

  // Go/no-go inequality check.
  const passRateThreshold = 1 / costRatio
  const passRateOk = cheapPassRate > passRateThreshold
  const discriminationOk = signalDiscrimination >= minDiscrimination

  if (passRateOk && discriminationOk) {
    return {
      decision: "cheap-first",
      reason: `cheapPassRate=${cheapPassRate.toFixed(3)} > 1/costRatio=${passRateThreshold.toFixed(3)} and discrimination=${signalDiscrimination.toFixed(3)} >= ${minDiscrimination}: cheap-first routing pays`,
    }
  }

  // At least one condition failed → oracle-first.
  const reasons: string[] = []
  if (!passRateOk) {
    reasons.push(
      `cheapPassRate=${cheapPassRate.toFixed(3)} <= 1/costRatio=${passRateThreshold.toFixed(3)} (cheap won't pay)`,
    )
  }
  if (!discriminationOk) {
    reasons.push(
      `signalDiscrimination=${signalDiscrimination.toFixed(3)} < ${minDiscrimination} (risk signal too weak)`,
    )
  }

  return {
    decision: "oracle-first",
    forceTier: "oracle",
    reason: reasons.join("; "),
  }
}
