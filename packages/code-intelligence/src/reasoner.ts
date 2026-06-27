/**
 * Step-level reasoner routing for econ's three-tier ladder.
 *
 * Decides whether a hard step should be sent to the reasoner (mid-size thinking
 * model with CoT) or escalated to the oracle (frontier). CoT is paid only when
 * hardStep=true — normal turns never touch this module.
 *
 * Hard-step signal contract:
 *   hardStep=false → conductor (no CoT)
 *   hardStep=true, alreadyTriedReasoner=false → reasoner (CoT, mid cost)
 *   hardStep=true, alreadyTriedReasoner=true  → oracle (CoT, high cost, last resort)
 *
 * @sem domain=routing role=reasoner
 */

import type { Tier } from "./router.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input to decideReasoner. */
export interface ReasonerInput {
  /** Code-structural risk score for this step: 0 (safe) – 100 (high risk). */
  risk: number
  /**
   * Hard-step signal: the conductor (or caller) sets this to true when the
   * current step needs chain-of-thought reasoning. When false, the step is
   * treated as easy and conductor is returned.
   */
  hardStep: boolean
  /**
   * Retry flag: true when the reasoner has already been invoked for this step
   * and it is still not resolved. Forces escalation to oracle.
   */
  alreadyTriedReasoner: boolean
}

/** Output from decideReasoner. */
export interface ReasonerOutput {
  /** Resolved tier for this step. */
  tier: "conductor" | "reasoner" | "oracle"
  /** Human-readable explanation of the decision. */
  reason: string
}

// ---------------------------------------------------------------------------
// Pure reasoner decision
// ---------------------------------------------------------------------------

/**
 * Resolves the model tier for a single hard step.
 *
 * This is a pure function: no I/O, no side effects. It implements only the
 * hard-step branch of the three-rung ladder; risk-band hysteresis is handled
 * upstream in routeTurn.
 *
 * @sem domain=routing role=reasoner
 */
export function decideReasoner(input: ReasonerInput): ReasonerOutput {
  const { hardStep, alreadyTriedReasoner } = input

  // Easy step: no CoT needed.
  if (!hardStep) {
    return {
      tier: "conductor",
      reason: "hardStep=false: easy step, using conductor (no CoT)",
    }
  }

  // Hard step, reasoner already tried → escalate to oracle.
  if (alreadyTriedReasoner) {
    return {
      tier: "oracle",
      reason: "hardStep=true, alreadyTriedReasoner=true: reasoner exhausted, escalating to oracle",
    }
  }

  // Hard step, first attempt → use reasoner.
  return {
    tier: "reasoner",
    reason: "hardStep=true: chain-of-thought step, routing to reasoner",
  }
}

// Re-export Tier so consumers of reasoner.ts don't need a separate import.
export type { Tier }
