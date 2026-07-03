/**
 * econ's model abstraction: the single source of truth binding each abstract
 * tier (conductor / executor / reasoner / oracle) to a concrete model, plus the
 * tracked capabilities that let us swap models by config instead of code —
 * context window, max output, reasoning support, and BYOK cost. Add a model to
 * ECON_MODELS to make it available; repoint a tier by editing ECON_TIER_BINDING.
 * Nothing downstream hard-codes a model id: the router, receipt, and loop query
 * this registry, so a model swap (e.g. gpt-oss-20b → Nemotron 3) is a one-line
 * binding change, and a capability question ("can this tier's model take a
 * reasoning-effort bump?") is a lookup, not a guess.
 *
 * @sem domain=routing role=registry
 */

import { ECON_COST_MATRIX, type EconModelRate } from "./econ-cost"
import type { EconTier } from "./region"

/**
 * Tracked capabilities for one model econ can serve. Capability fields mirror
 * econ's opencode.json (the operative config the runtime loads) and are held
 * true by a drift test; `reasoning` means econ has a reasoning channel enabled
 * for the model (so a per-call effort is settable), not merely that the model
 * family is reasoning-capable — see per-entry notes for that nuance.
 *
 * @sem domain=routing role=type
 */
export interface EconModelProfile {
  /** Provider id the model is served through (e.g. "openrouter"). */
  providerID: string
  /** Provider-local model id (e.g. "deepseek/deepseek-v4-flash"); the ECON_COST_MATRIX key. */
  modelID: string
  /** Human-readable label. */
  name: string
  /** Max input context window in tokens (opencode.json limit.context). */
  contextWindow: number
  /** Max output tokens (opencode.json limit.output). */
  maxOutput: number
  /** Reasoning channel enabled in econ's opencode.json (a per-call effort is settable). */
  reasoning: boolean
  /** BYOK rates in $/1M tokens, sourced from ECON_COST_MATRIX (its single home). */
  cost: EconModelRate
  /** Serving / provenance / capability nuance not captured by the fields above. */
  notes?: string
}

/**
 * The models econ ships, keyed by provider-local model id. This is the manifest:
 * to make a new model available (e.g. Nemotron 3) add an entry here, then point a
 * tier at it in ECON_TIER_BINDING. Capability values are held consistent with
 * opencode.json by model-registry.test.ts.
 *
 * @sem domain=routing role=config
 */
export const ECON_MODELS: Record<string, EconModelProfile> = {
  "deepseek/deepseek-v4-flash": {
    providerID: "openrouter",
    modelID: "deepseek/deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    contextWindow: 1_000_000,
    maxOutput: 8192,
    reasoning: false,
    cost: ECON_COST_MATRIX["deepseek/deepseek-v4-flash"]!,
    notes: "econ conductor. Fireworks BYOK. No reasoning channel enabled in opencode.json (treated as a fast non-reasoning model — see OL-3.8 won't-build).",
  },
  "z-ai/glm-5.2": {
    providerID: "openrouter",
    modelID: "z-ai/glm-5.2",
    name: "GLM 5.2",
    contextWindow: 200_000,
    maxOutput: 8192,
    reasoning: true,
    cost: ECON_COST_MATRIX["z-ai/glm-5.2"]!,
    notes: "econ oracle + reasoner (shared model). Reasoning ENABLED in opencode.json (effort:high, exclude:true — the trace is hidden from customers); these are the think-hard tiers used sparingly on the hard tail. Reasoning tokens bill at the output rate. Cached read ($0.14) is ~1/10th the input rate: keep oracle hops prefix-shared (OL-3.7).",
  },
  "openai/gpt-oss-20b": {
    providerID: "openrouter",
    modelID: "openai/gpt-oss-20b",
    name: "gpt-oss-20b",
    contextWindow: 131_072,
    maxOutput: 8192,
    reasoning: true,
    cost: ECON_COST_MATRIX["openai/gpt-oss-20b"]!,
    notes: "econ executor. Self-hosted → $0 marginal in the cost matrix (real fixed GPU cost tracked separately in econ-cost). reasoning:true, effort:low, exclude:true. Post-POC swap target: NVIDIA Nemotron 3 (OL-M.1) — add its entry and repoint the executor binding.",
  },
}

/**
 * Which model backs each abstract tier. This is the swap point: repointing a
 * tier at a different model — for a config experiment or the Nemotron swap — is
 * a one-line change here, and every consumer (router, receipt, loop) follows
 * because they resolve through tierProfile, never a literal model id.
 *
 * @sem domain=routing role=config
 */
export const ECON_TIER_BINDING: Record<EconTier, string> = {
  conductor: "deepseek/deepseek-v4-flash",
  executor: "openai/gpt-oss-20b",
  reasoner: "z-ai/glm-5.2",
  oracle: "z-ai/glm-5.2",
}

/** A model profile resolved for a specific tier. */
export interface TierProfile extends EconModelProfile {
  tier: EconTier
}

/**
 * The capability profile for one model by key, or undefined if it isn't in the
 * manifest.
 *
 * @sem domain=routing role=query
 */
export function modelProfile(key: string): EconModelProfile | undefined {
  return ECON_MODELS[key]
}

/**
 * Resolve a tier to its bound model's full capability profile. Throws if a tier
 * is bound to a model missing from the manifest — a misconfiguration that must
 * fail loud, not route to a phantom model.
 *
 * @sem domain=routing role=query
 */
export function tierProfile(tier: EconTier): TierProfile {
  const key = ECON_TIER_BINDING[tier]
  const model = ECON_MODELS[key]
  if (!model) {
    throw new Error(`econ tier "${tier}" is bound to unknown model "${key}" — add it to ECON_MODELS`)
  }
  return { tier, ...model }
}

/**
 * The full model reference ("providerID/modelID") a tier resolves to — the form
 * opencode.json agents and the model-resolution chain expect.
 *
 * @sem domain=routing role=query
 */
export function tierModelRef(tier: EconTier): string {
  const p = tierProfile(tier)
  return `${p.providerID}/${p.modelID}`
}

/**
 * Whether a tier's bound model has a reasoning channel enabled in econ config
 * (so a per-call effort can be set). This answers the OL-3.8 question directly:
 * supportsReasoning("conductor") === false is why the budget-rung is a no-op.
 *
 * @sem domain=routing role=query
 */
export function supportsReasoning(tier: EconTier): boolean {
  return tierProfile(tier).reasoning
}

/**
 * A tier's bound model's max input context window — the ceiling the loop must
 * respect before routing a large context to this tier.
 *
 * @sem domain=routing role=query
 */
export function contextWindow(tier: EconTier): number {
  return tierProfile(tier).contextWindow
}

/**
 * The tiers a given model backs (reverse of ECON_TIER_BINDING). Lets a
 * model-keyed signal (a usage event's modelID) be mapped back to its tier(s)
 * without hard-coded string matching — glm-5.2 backs both oracle and reasoner.
 *
 * @sem domain=routing role=query
 */
export function tiersForModel(key: string): EconTier[] {
  return (Object.keys(ECON_TIER_BINDING) as EconTier[]).filter((t) => ECON_TIER_BINDING[t] === key)
}
