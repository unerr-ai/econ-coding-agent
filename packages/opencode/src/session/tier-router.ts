/**
 * Tier-agent identity + the OL-7.5 plan-reasoning raise for the live turn seam. Turn-level tier
 * routing was demoted here on 2026-07-06: a whole-turn hijack was observed billing every
 * mechanical step at the expensive tier while the per-slice allocator sat idle, so the lead
 * agent is now NEVER swapped at turn-open. Escalation is slice-level only: allocateSlice (coupling ×
 * test-strength + the conductor's `need` hint) routes each decomposed slice, and the escalation
 * ladder retries a failed slice upward. What survives at turn-open is the cheap signal pair
 * (prompt heaviness + structural risk) driving the conductor's plan-time reasoning budget.
 *
 * @sem domain=routing role=adapter
 */
import { defaultRouterConfig } from "../../../code-intelligence/src/router"
import { isHeavyPrompt } from "../../../code-intelligence/src/triage"
import { planReasoningEffort } from "../../../code-intelligence/src/plan-reasoning"

/** econ's four tier agents (opencode.json). Only these agents get turn-open plan-raise handling. */
export const ECON_TIER_AGENTS: ReadonlySet<string> = new Set(["conductor", "executor", "oracle", "reasoner"])

/** True when an agent name is one of econ's tier agents. */
export function isEconTierAgent(name: string): boolean {
  return ECON_TIER_AGENTS.has(name)
}

/**
 * Decides whether the conductor's plan-time (decomposition-step) reasoning budget should be
 * raised for this turn, from the turn-open signals: a heavy prompt or structural risk at or
 * above the router's mid-band floor. Only meaningful for a conductor lead — reasoner/oracle
 * reason at config-pinned effort and the executor's endpoints reject reasoning-off.
 *
 * @sem domain=routing role=decision
 */
export function planRaiseForTurn(input: { prompt: string; risk?: number }): boolean {
  return planReasoningEffort({
    heavy: isHeavyPrompt(input.prompt),
    risk: input.risk ?? 0,
    riskFloor: defaultRouterConfig.deescalateBelow,
  }).raise
}
