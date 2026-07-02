/**
 * Risk-escalation router for econ's three-tier model selection.
 *
 * Maps a turn's code-structural risk score + hard-step signal to a routing
 * decision (conductor | reasoner | oracle) with hysteresis bands to prevent
 * mid-band flapping. Pure: no I/O, no side effects — safe to call in any context.
 *
 * Three-rung ladder (S3.7):
 *   conductor  — cheap, no CoT; default for normal turns
 *   reasoner   — mid-size thinking model; activated only on explicit hardStep signal
 *   oracle     — frontier; activated when risk > 70 or reasoner already tried
 *
 * Hysteresis bands (defaults):
 *   risk > 70  → escalate to oracle (overrides hardStep), UNLESS AC-8.5
 *                stickiness holds: current tier isn't oracle and risk is
 *                only borderline above 70 (within stickinessMargin, default
 *                10) — econ's topology keeps a sticky mid tier warm and
 *                treats oracle as a stateless brief-fed detour, so a
 *                borderline turn holds rather than cold-flushing that KV
 *                cache for a round trip. Risk clearly above the margin
 *                always escalates — never suppressed.
 *   risk < 40  → de-escalate to conductor (never dampened — leaving the
 *                stateless oracle tier costs nothing)
 *   40–70      → hold current tier (no-flap zone)
 *   reasoner state with no hardStep signal → maps to conductor in mid-band
 *
 * Extension hooks for later sprints:
 *   abstain  (S3.3) — hold current tier without logging a routing change
 *   forceTier (S3.5) — bypass risk logic entirely (triage override)
 *
 * @sem domain=routing role=router
 */

import { decideReasoner } from "./reasoner.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The three model tiers.
 *   conductor — cheap, no CoT; default for normal turns.
 *   reasoner  — mid-size thinking model; activated only on explicit hardStep signal.
 *   oracle    — frontier; for high-risk turns or when reasoner has been tried and failed.
 */
export type Tier = "conductor" | "reasoner" | "oracle"

/** Per-session hysteresis state: the tier selected on the previous turn. */
export interface RouterState {
  /** The tier resolved on the previous turn — carries the hysteresis. */
  tier: Tier
}

/** Router configuration: the hysteresis band boundaries (both configurable). */
export interface RouterConfig {
  /**
   * Escalate to oracle when risk strictly exceeds this threshold.
   * Default: 70.
   */
  escalateAbove: number
  /**
   * De-escalate to conductor when risk strictly falls below this threshold.
   * Default: 40.
   */
  deescalateBelow: number
  /**
   * AC-8.5: extra risk margin above escalateAbove required to escalate away
   * from the current tier when that tier isn't already oracle — a "last
   * tier used" stickiness signal (RouterInput.state.tier) that discourages
   * a needless flip off the warm sticky mid tier for a borderline turn.
   * Risk > escalateAbove + stickinessMargin always escalates regardless —
   * a genuine high-risk turn is never held back for cache economy.
   * Optional so existing partial RouterConfig literals keep compiling;
   * routeTurn falls back to 10 when omitted.
   */
  stickinessMargin?: number
}

/** Input to routeTurn. */
export interface RouterInput {
  /** Code-structural risk score for this turn: 0 (safe) – 100 (high risk). */
  risk: number
  /** Previous-turn hysteresis state (persisted by the caller). */
  state: RouterState
  /**
   * Abstention hook (S3.3): when true, hold the current tier regardless of
   * risk. Unused in this sprint — field is accepted so callers can be wired
   * without a signature change later.
   */
  abstain?: boolean
  /**
   * Triage override hook (S3.5): when set, bypass all risk logic and use this
   * tier directly. Unused in this sprint — field accepted for future wiring.
   */
  forceTier?: Tier
  /**
   * Hard-step signal (S3.7): when true, this step requires chain-of-thought
   * reasoning. Routes to "reasoner" if risk ≤ escalateAbove; escalates to
   * "oracle" if alreadyTriedReasoner is also true. Has no effect when false
   * or absent — CoT is NOT paid on normal turns.
   */
  hardStep?: boolean
  /**
   * Reasoner retry flag (S3.7): when true together with hardStep, the reasoner
   * has already been tried and the step is still hard — escalate to oracle.
   */
  alreadyTriedReasoner?: boolean
}

/** Output from routeTurn. */
export interface RouterOutput {
  /** Resolved tier for this turn. */
  tier: Tier
  /** Human-readable explanation of the routing decision. */
  reason: string
  /** Updated hysteresis state — callers must persist this for the next turn. */
  state: RouterState
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Hysteresis state for a brand-new session: start on conductor. */
export const defaultRouterState: RouterState = { tier: "conductor" }

/** Default hysteresis band config. */
export const defaultRouterConfig: RouterConfig = {
  escalateAbove: 70,
  deescalateBelow: 40,
  stickinessMargin: 10,
}

// ---------------------------------------------------------------------------
// Pure router
// ---------------------------------------------------------------------------

/**
 * Resolves the model tier for one LLM turn using hysteresis and the hard-step signal.
 *
 * Evaluation order:
 *   1. forceTier (S3.5 triage override) — immediate return, bypasses everything
 *   2. abstain (S3.3) — hold current tier without counting as a transition
 *   3. risk > escalateAbove → oracle (overrides hardStep), unless AC-8.5
 *      stickiness holds a borderline turn (risk within stickinessMargin,
 *      current tier not already oracle) on its current tier instead
 *   4. hardStep=true → decideReasoner (reasoner or oracle if alreadyTriedReasoner)
 *   5. risk < deescalateBelow → conductor
 *   6. mid-band → hold current tier (no flap); "reasoner" maps to "conductor" when
 *      hardStep is absent (avoids persistent CoT without an explicit signal)
 *
 * @sem domain=routing role=router
 */
export function routeTurn(input: RouterInput, config: RouterConfig = defaultRouterConfig): RouterOutput {
  const { risk, state, abstain = false, forceTier, hardStep = false, alreadyTriedReasoner = false } = input
  const { escalateAbove, deescalateBelow, stickinessMargin = 10 } = config

  // 1. Triage override (S3.5): bypass all risk logic.
  if (forceTier !== undefined) {
    return {
      tier: forceTier,
      reason: `forceTier="${forceTier}" override`,
      state: { tier: forceTier },
    }
  }

  // 2. Abstention (S3.3): hold current tier without recording a transition.
  if (abstain) {
    return {
      tier: state.tier,
      reason: "abstain=true: holding current tier",
      state: { tier: state.tier },
    }
  }

  // 3. High risk → oracle (takes precedence over hardStep) — unless AC-8.5
  //    stickiness holds: the current tier isn't already oracle (nothing to
  //    protect there — it's a stateless brief-fed detour) and risk is only
  //    borderline above escalateAbove (within stickinessMargin). Risk
  //    clearly above the margin always escalates — safety first, never
  //    suppressed by cache economy.
  if (risk > escalateAbove) {
    const stickyHold = state.tier !== "oracle" && risk <= escalateAbove + stickinessMargin
    if (stickyHold) {
      return {
        tier: state.tier,
        reason: `risk=${risk} borderline above escalateAbove=${escalateAbove} (within stickinessMargin=${stickinessMargin}): holding tier="${state.tier}" to avoid a cold cache flip`,
        state: { tier: state.tier },
      }
    }
    return {
      tier: "oracle",
      reason: `risk=${risk} > escalateAbove=${escalateAbove}: escalating to oracle`,
      state: { tier: "oracle" },
    }
  }

  // 4. Hard step: route via reasoner decision (only reached when risk ≤ escalateAbove).
  if (hardStep) {
    const rd = decideReasoner({ risk, hardStep: true, alreadyTriedReasoner })
    return {
      tier: rd.tier,
      reason: rd.reason,
      state: { tier: rd.tier },
    }
  }

  // 5. Low risk → de-escalate.
  if (risk < deescalateBelow) {
    return {
      tier: "conductor",
      reason: `risk=${risk} < deescalateBelow=${deescalateBelow}: using conductor`,
      state: { tier: "conductor" },
    }
  }

  // 6. Mid-band: hold current tier — no flap.
  // "reasoner" requires an explicit hardStep signal; without it, de-escalate to
  // conductor so CoT is not paid on a normal follow-up turn.
  const holdTier: Tier = state.tier === "reasoner" ? "conductor" : state.tier
  return {
    tier: holdTier,
    reason: `risk=${risk} in hysteresis band [${deescalateBelow}, ${escalateAbove}]: holding tier="${holdTier}"`,
    state: { tier: holdTier },
  }
}
