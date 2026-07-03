/**
 * Live-path tier router (OL-3.1/3.2): the B-into-A adapter that lets econ's risk-escalation
 * router pick a live turn's model tier at the model-resolution seam, so the conductor's pinned
 * model no longer serves every turn unconditionally. Pure orchestration over code-intelligence's
 * pure routeTurn + decideTriageTurn; the only state it holds is per-session hysteresis, in memory.
 *
 * @sem domain=routing role=adapter
 */
import { routeTurn, defaultRouterState, defaultRouterConfig, type RouterState, type Tier } from "../../../code-intelligence/src/router"
import { decideTriageTurn, isHeavyPrompt } from "../../../code-intelligence/src/triage"
import { escalationFromAbstention } from "../../../code-intelligence/src/abstention"

// Per-session hysteresis state. In-memory is adequate for the POC: a session is served by one
// process, and a restart resetting to the cheap conductor tier is the safe default. The absence of
// an entry also marks a session's first turn (see resolveTier). The seam now supplies a real
// code-structural risk (OL-3.3, probeTurnRisk over the live graph); persistence can move to the
// session row if hysteresis must survive restarts.
const stateBySession = new Map<string, RouterState>()

/** econ's four tier agents (opencode.json). Only these agents are candidates for auto-routing. */
export const ECON_TIER_AGENTS: ReadonlySet<string> = new Set(["conductor", "executor", "oracle", "reasoner"])

/** True when an agent name is one of econ's routable tiers. */
export function isEconTierAgent(name: string): boolean {
  return ECON_TIER_AGENTS.has(name)
}

/** The router's choice for one turn. */
export interface TierDecision {
  /** The tier the router picked. */
  tier: Tier
  /** Human-readable reason (surfaced in telemetry / logs). */
  reason: string
}

/** Inputs the live seam supplies for one turn. */
export interface ResolveTierInput {
  sessionID: string
  /** The user's prompt text for this turn — the turn-open heaviness signal. */
  prompt: string
  /**
   * OL-3.5: whether the previous turn's assistant output signalled abstention
   * ([[ABSTAIN]]/[[UNSURE]]/low-confidence). The seam detects this from history;
   * when true the router forces an escalation regardless of triage/heaviness.
   */
  priorAbstained?: boolean
  /**
   * OL-3.3: code-structural risk for this turn (0–100), computed at the seam by
   * probeTurnRisk over the live call graph (blast-radius / fan-in / centrality
   * of the entities the prompt names). Undefined/0 → the router falls back to
   * the prompt-heaviness signal. A high score lifts an otherwise light-looking
   * turn to the reasoner (or, past routeTurn's oracle threshold, the oracle) —
   * the point of structural routing over prompt-text classification.
   */
  risk?: number
}

/**
 * Pick the model tier for one live turn and advance the session's hysteresis state.
 *
 * Turn-open signals:
 *   - the previous turn abstained → force-escalate to the oracle, overriding triage (OL-3.5)
 *   - session's first turn + a light prompt → triage biases the cheap conductor (OL-3.2)
 *   - high code-structural risk on the prompt's entities → routeTurn lifts the tier (OL-3.3)
 *   - a heavy prompt (multi-file / high-risk / plan request) → hardStep → reasoner (mid tier)
 *   - otherwise → hysteresis holds the prior tier, de-escalating to conductor when nothing is hard
 */
export function resolveTier(input: ResolveTierInput): TierDecision {
  const { sessionID, prompt, priorAbstained = false, risk = 0 } = input
  const isFirstTurn = !stateBySession.has(sessionID)
  const prior = stateBySession.get(sessionID) ?? defaultRouterState

  // OL-3.5: a prior-turn abstention forces the oracle and outranks triage — the cheap tier told us
  // it was unsure, so this turn must not stay cheap. (escalationFromAbstention → { forceTier: "oracle" }.)
  const abstainForce = priorAbstained ? escalationFromAbstention({ abstained: true }).forceTier : undefined

  const heavy = isHeavyPrompt(prompt)
  const triage = decideTriageTurn({ isFirstTurn, enabled: true, prompt })
  // OL-3.3: structural risk outranks the turn-0 cheap-bias. A first turn naming a high-blast-radius
  // hub isn't exploratory — let routeTurn escalate it rather than pinning it cheap. Below the oracle
  // threshold triage still holds, so a genuinely light opener stays on the conductor.
  const triageForce = triage.applyTriage && risk <= defaultRouterConfig.escalateAbove ? "conductor" : undefined
  const forceTier: Tier | undefined = abstainForce ?? triageForce

  // OL-3.3: the seam supplies a real code-structural risk (0–100). routeTurn escalates on it past
  // its threshold; a heavy prompt additionally raises hardStep so a light-risk but multi-file turn
  // still lifts to the reasoner rather than paying for the frontier oracle.
  const out = routeTurn({ risk, state: prior, forceTier, hardStep: heavy })
  stateBySession.set(sessionID, out.state)

  return {
    tier: out.tier,
    reason: abstainForce
      ? "prior turn abstained → escalate to oracle"
      : forceTier
        ? `triage: ${triage.reason}`
        : out.reason,
  }
}

/** Drop a finished session's hysteresis state (lifecycle / test hook). */
export function clearTierState(sessionID: string): void {
  stateBySession.delete(sessionID)
}
