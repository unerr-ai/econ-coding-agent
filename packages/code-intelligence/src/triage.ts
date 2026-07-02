/**
 * Cheap-first triage decisions for econ's router: a per-repo go/no-go
 * (`triageRepo`) that decides whether cheap-first routing pays off at all,
 * and a per-turn bias (`decideTriageTurn` / `isHeavyPrompt`, AC-3.1/AC-3.2)
 * that routes a session's first turn to a cheap triage-tier model unless the
 * prompt clearly warrants skipping straight to the risk-router. Both
 * degrade-open: missing or ambiguous signal never blocks routing.
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

// ---------------------------------------------------------------------------
// Per-turn triage bias (AC-3.1 / AC-3.2 — cheap-first triage tier)
// ---------------------------------------------------------------------------

/** Default escalate_on signals — mirrors config.ts `triage.escalate_on`'s default. */
export const DEFAULT_ESCALATE_ON = ["multi_file_edit", "high_risk", "explicit_plan_request"] as const

/** Keyword/phrase heuristics per escalate_on signal. Case-insensitive; any match on a signal counts. */
const ESCALATE_SIGNAL_PATTERNS: Record<string, RegExp[]> = {
  multi_file_edit: [
    /\brefactor across\b/i,
    /\bacross (multiple|several|all|many) files\b/i,
    /\bmigrat(e|ion|ing)\b/i,
    /\bevery (file|caller|usage|call site)\b/i,
    /\ball (files|callers|usages|call sites)\b/i,
    /\brename .*(everywhere|throughout|across)\b/i,
    /\bcodemod\b/i,
  ],
  high_risk: [
    /\bbreaking change\b/i,
    /\bproduction\b/i,
    /\bsecurity\b/i,
    /\bauth(entication|orization)?\b/i,
    /\bpayment\b/i,
    /\bdelete\b/i,
    /\bdrop (table|database)\b/i,
    /\birreversible\b/i,
  ],
  explicit_plan_request: [
    /\bplan the\b/i,
    /\bcreate a plan\b/i,
    /\bwrite (a |an )?(rfc|proposal|design doc)\b/i,
    /\bdesign (a |the )?(architecture|system)\b/i,
    /\bpropose (a |an )?approach\b/i,
  ],
}

/**
 * Pure heuristic: does the first prompt clearly warrant skipping the triage
 * tier and letting the normal risk-router pick conductor/oracle directly?
 * Matches keyword/phrase signals per escalate_on entry (config default:
 * multi_file_edit, high_risk, explicit_plan_request). Prevents paying for
 * both a triage turn and a full escalation on the same heavy first prompt.
 *
 * @sem domain=routing role=triage
 */
export function isHeavyPrompt(text: string, escalateOn: readonly string[] = DEFAULT_ESCALATE_ON): boolean {
  const trimmed = text?.trim()
  if (!trimmed) return false
  for (const signal of escalateOn) {
    const patterns = ESCALATE_SIGNAL_PATTERNS[signal]
    if (patterns?.some((pattern) => pattern.test(trimmed))) return true
  }
  return false
}

/** Input to decideTriageTurn: the per-turn signals the router already has. */
export interface TriageTurnInput {
  /** True when this is the session's first turn (no prior hysteresis state). */
  isFirstTurn: boolean
  /** cfg.triage.enabled — caller resolves the config default (true) before calling. */
  enabled: boolean
  /** The first user prompt's text, when a producer supplies it. Absent → never heavy. */
  prompt?: string
  /** cfg.triage.escalate_on override; defaults to DEFAULT_ESCALATE_ON. */
  escalateOn?: readonly string[]
}

/** Result of decideTriageTurn. */
export interface TriageTurnResult {
  /** True when the caller should bias this turn to the triage-tier model. */
  applyTriage: boolean
  /** Human-readable explanation of the decision. */
  reason: string
}

/**
 * Decides whether to bias the current turn to the cheap triage-tier model
 * (AC-3.1) or fall through to the normal risk-router (AC-3.2 when the first
 * prompt is heavy, or on any later turn). Pure — no I/O.
 *
 * @sem domain=routing role=triage
 */
export function decideTriageTurn(input: TriageTurnInput): TriageTurnResult {
  const { isFirstTurn, enabled, prompt, escalateOn = DEFAULT_ESCALATE_ON } = input
  if (!enabled) return { applyTriage: false, reason: "triage disabled" }
  if (!isFirstTurn) return { applyTriage: false, reason: "not the session's first turn" }
  if (isHeavyPrompt(prompt ?? "", escalateOn)) {
    return {
      applyTriage: false,
      reason: "first prompt matches an escalate_on signal — skipping triage to avoid paying for both triage and full escalation",
    }
  }
  return { applyTriage: true, reason: "first turn, triage enabled, prompt not heavy" }
}
