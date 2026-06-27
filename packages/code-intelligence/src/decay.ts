/**
 * Confidence-decay model for anchored notes: older notes are weighted less so
 * stale project facts don't crowd out recent observations — keeping the
 * memory store self-pruning without requiring explicit deletion.
 *
 * @sem domain=intelligence role=analysis
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Tuning knob for the exponential decay curve; the default 30-day half-life
 * balances recency against note churn in typical project lifecycles.
 *
 * @sem domain=intelligence role=utilities
 */
export interface DecayConfig {
  halfLifeMs: number
}

/**
 * Ready-to-use decay configuration with a 30-day half-life — suitable for
 * most project-level notes without any caller configuration.
 *
 * @sem domain=intelligence role=utilities
 */
export const DEFAULT_DECAY_CONFIG: DecayConfig = {
  halfLifeMs: 1000 * 60 * 60 * 24 * 30, // 30 days
}

// ---------------------------------------------------------------------------
// decayConfidence
// ---------------------------------------------------------------------------

/**
 * Applies pure exponential decay to a confidence score based on elapsed time,
 * returning the decayed value clamped to [0, 1] so downstream consumers never
 * receive out-of-range weights.
 *
 * @sem domain=intelligence role=analysis
 */
export function decayConfidence(
  confidence: number,
  ageMs: number,
  config: DecayConfig = DEFAULT_DECAY_CONFIG,
): number {
  const decayed = confidence * Math.pow(0.5, ageMs / config.halfLifeMs)
  return Math.min(1, Math.max(0, decayed))
}
