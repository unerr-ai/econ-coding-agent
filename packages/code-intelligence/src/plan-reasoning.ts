/**
 * OL-7.5 — adaptive plan-time reasoning: decides whether the conductor should raise its
 * thinking budget for THIS turn's decomposition step. The conductor tier is bound to a hybrid
 * model — reasoning is a config toggle, not a model swap (F6; a registry capability, see
 * ECON_MODELS.reasoning) — so this is a cheap gate
 * reusing the turn-open complexity signals routeTurn already computes (heaviness, code-structural
 * risk); no new probe. A trivial turn holds the baseline (no reasoning tokens spent on planning);
 * a heavy or moderate-to-high-risk turn raises it, once, at the plan step (F1/F2/F4).
 *
 * @sem domain=routing role=planner
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Turn-open complexity signals already computed by the tier router (no new probe). */
export interface PlanReasoningInput {
  /** True for a heavy prompt (multi-file / high-risk / explicit-plan-request) — the same signal routeTurn uses as hardStep. */
  heavy: boolean
  /** Code-structural risk for this turn (0-100), from probeTurnRisk. */
  risk: number
  /**
   * Risk floor at/above which a turn is no longer "light" — reuses routeTurn's own
   * de-escalation threshold (RouterConfig.deescalateBelow) so the reasoning gate agrees with
   * the tier hysteresis on what counts as routine. Default 40.
   */
  riskFloor?: number
}

/** OL-7.5 decision: raise or hold the conductor's plan-time reasoning budget for this turn. */
export interface PlanReasoningDecision {
  /** Whether the conductor's plan step should reason at raised effort this turn. */
  raise: boolean
  /** Human-readable explanation (surfaced in telemetry / logs). */
  reason: string
}

// ---------------------------------------------------------------------------
// Pure decision
// ---------------------------------------------------------------------------

/**
 * Resolves whether this turn's decomposition step should reason at a raised budget.
 *
 * This is a pure function: no I/O, no side effects. F1/F4 — reasoning is spent only where it
 * pays (a hard/long decomposition), never on every turn, so a trivial turn's plan step stays at
 * the model's baseline (near-zero reasoning tokens) while a genuinely complex turn (heavy, or
 * risk at/above the mid-band floor) gets the raised budget.
 *
 * @sem domain=routing role=planner
 */
export function planReasoningEffort(input: PlanReasoningInput): PlanReasoningDecision {
  const { heavy, risk, riskFloor = 40 } = input

  if (heavy) {
    return {
      raise: true,
      reason: "heavy prompt (multi-file/high-risk/plan-request): plan-time reasoning raised",
    }
  }

  if (risk >= riskFloor) {
    return {
      raise: true,
      reason: `risk ${risk} >= riskFloor ${riskFloor}: plan-time reasoning raised`,
    }
  }

  return { raise: false, reason: "routine turn: plan-time reasoning held at baseline" }
}
