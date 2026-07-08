/**
 * Region-routing scaffold for econ Sprint 8.1: in-region inference and data residency.
 *
 * Provides the config schema, residency policy, and per-tier endpoint fallback chains
 * that enable routing LLM calls to Indian in-region infrastructure when it becomes
 * available. All production defaults today point to the existing global LiteLLM gateway
 * endpoints from opencode.json — real in-region (India) OSS endpoints are GATED
 * (no infrastructure or credentials yet). Pure data and pure functions only: no I/O,
 * no network calls, no external imports.
 *
 * @sem domain=intelligence role=config
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Identifies whether an endpoint runs in the Indian in-region cloud or the default
 * global cloud, supporting data-residency enforcement and regional preference routing.
 *
 * @sem domain=intelligence role=config
 */
export type Region = "in" | "global"

/**
 * The four model tiers in econ's cost-routing hierarchy, each configurable with its
 * own endpoint chain so tier assignment and endpoint selection remain decoupled.
 *
 * @sem domain=intelligence role=config
 */
export type EconTier = "conductor" | "oracle" | "reasoner" | "executor"

/**
 * Categories of data that flow through an inference call, used to enforce per-class
 * residency restrictions when the policy mode is strict or preferred.
 *
 * @sem domain=intelligence role=config
 */
export type DataClass = "code" | "prompt" | "completion" | "telemetry" | "secret"

/**
 * Controls how strictly the residency policy is applied when selecting an endpoint:
 * strict rejects all non-compliant endpoints, preferred uses them as a last resort,
 * and off disables residency filtering entirely.
 *
 * @sem domain=intelligence role=config
 */
export type ResidencyMode = "strict" | "preferred" | "off"

/**
 * Describes a single LLM inference endpoint: its provider, model identity, regional
 * placement, and optional custom base URL for self-hosted or in-region deployments.
 *
 * @sem domain=intelligence role=config
 */
export interface RegionEndpoint {
  providerId: string
  model: string
  region: Region
  baseUrl?: string
}

/**
 * Declares which regions are permitted for each data class, and whether the restriction
 * is enforced (strict), advisory (preferred), or disabled (off).
 *
 * @sem domain=intelligence role=config
 */
export interface ResidencyPolicy {
  mode: ResidencyMode
  allow: Record<DataClass, Region[]>
}

/**
 * The full region-routing configuration: a residency policy paired with per-tier
 * endpoint chains that the resolver consults when selecting an inference endpoint.
 *
 * @sem domain=intelligence role=config
 */
export interface RegionConfig {
  residency: ResidencyPolicy
  tiers: Record<EconTier, RegionEndpoint[]>
}

/**
 * The result of a residency compliance check for a specific endpoint and data class,
 * surfacing a human-readable reason when the check fails.
 *
 * @sem domain=intelligence role=config
 */
export interface ResidencyCheck {
  ok: boolean
  reason?: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Strict-leaning residency policy where code, prompts, completions, and secrets
 * must stay in-region while telemetry may also flow to global providers, expressed
 * in "preferred" mode so availability is preferred over residency when no in-region
 * endpoint is configured yet.
 *
 * @sem domain=intelligence role=config
 */
export const DEFAULT_RESIDENCY_POLICY: ResidencyPolicy = {
  mode: "preferred",
  allow: {
    code: ["in"],
    prompt: ["in"],
    completion: ["in"],
    secret: ["in"],
    telemetry: ["in", "global"],
  },
}

/**
 * The baseline region configuration for econ, wiring each tier to exactly one global
 * LiteLLM gateway endpoint matching opencode.json; in-region chains are empty until infra
 * is provisioned and prepended via parseRegionConfig.
 *
 * @sem domain=intelligence role=config
 */
export const DEFAULT_REGION_CONFIG: RegionConfig = {
  residency: DEFAULT_RESIDENCY_POLICY,
  // Tier→model bindings must match ECON_TIER_BINDING in model-registry.ts (the authoritative
  // source of truth) and opencode.json; model-registry.test.ts guards the two against drift.
  tiers: {
    conductor: [{ providerId: "litellm", model: "minimax/minimax-m3", region: "global" }],
    oracle: [{ providerId: "litellm", model: "z-ai/glm-5.2", region: "global" }],
    reasoner: [
      // OL-8.B4+: a distinct model from the oracle (deliberate verifier de-correlation) — see
      // opencode.json reasoner agent.
      { providerId: "litellm", model: "deepseek/deepseek-v4-pro", region: "global" },
    ],
    executor: [{ providerId: "litellm", model: "openai/gpt-oss-120b", region: "global" }],
  },
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Merges a partial or unknown runtime config object over the defaults, enabling
 * per-deployment overrides of residency mode, allow lists, and per-tier endpoint
 * chains without mutating the DEFAULT_REGION_CONFIG singleton.
 *
 * @sem domain=intelligence role=config
 */
export function parseRegionConfig(raw: unknown): RegionConfig {
  // Deep-clone the defaults so we never mutate them
  const base: RegionConfig = {
    residency: {
      mode: DEFAULT_RESIDENCY_POLICY.mode,
      allow: {
        code: [...DEFAULT_RESIDENCY_POLICY.allow.code],
        prompt: [...DEFAULT_RESIDENCY_POLICY.allow.prompt],
        completion: [...DEFAULT_RESIDENCY_POLICY.allow.completion],
        secret: [...DEFAULT_RESIDENCY_POLICY.allow.secret],
        telemetry: [...DEFAULT_RESIDENCY_POLICY.allow.telemetry],
      },
    },
    tiers: {
      conductor: [...DEFAULT_REGION_CONFIG.tiers.conductor],
      oracle: [...DEFAULT_REGION_CONFIG.tiers.oracle],
      reasoner: [...DEFAULT_REGION_CONFIG.tiers.reasoner],
      executor: [...DEFAULT_REGION_CONFIG.tiers.executor],
    },
  }

  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    return base
  }

  const rawObj = raw as Record<string, unknown>

  // Overlay residency if present and well-formed
  const rawResidency = rawObj["residency"]
  if (
    rawResidency !== undefined &&
    rawResidency !== null &&
    typeof rawResidency === "object" &&
    !Array.isArray(rawResidency)
  ) {
    const res = rawResidency as Record<string, unknown>

    const rawMode = res["mode"]
    if (rawMode === "strict" || rawMode === "preferred" || rawMode === "off") {
      base.residency.mode = rawMode
    }

    const rawAllow = res["allow"]
    if (
      rawAllow !== undefined &&
      rawAllow !== null &&
      typeof rawAllow === "object" &&
      !Array.isArray(rawAllow)
    ) {
      const allowObj = rawAllow as Record<string, unknown>
      const dataClasses: DataClass[] = ["code", "prompt", "completion", "telemetry", "secret"]
      for (const dc of dataClasses) {
        const rawList = allowObj[dc]
        if (Array.isArray(rawList)) {
          const regions = (rawList as unknown[]).filter(
            (r): r is Region => r === "in" || r === "global",
          )
          if (regions.length > 0) {
            base.residency.allow[dc] = regions
          }
        }
      }
    }
  }

  // Overlay tiers if present and well-formed
  const rawTiers = rawObj["tiers"]
  if (
    rawTiers !== undefined &&
    rawTiers !== null &&
    typeof rawTiers === "object" &&
    !Array.isArray(rawTiers)
  ) {
    const tiersObj = rawTiers as Record<string, unknown>
    const econTiers: EconTier[] = ["conductor", "oracle", "reasoner", "executor"]
    for (const tier of econTiers) {
      const rawChain = tiersObj[tier]
      if (Array.isArray(rawChain)) {
        base.tiers[tier] = rawChain as RegionEndpoint[]
      }
    }
  }

  return base
}

/**
 * Returns a tier's endpoint chain sorted so in-region endpoints precede global
 * endpoints (stable within each group), expressing preference for in-region inference
 * unless the policy explicitly disables residency ordering.
 *
 * @sem domain=intelligence role=config
 */
export function resolveTierChain(config: RegionConfig, tier: EconTier): RegionEndpoint[] {
  const chain = config.tiers[tier]
  if (config.residency.mode === "off") {
    return [...chain]
  }
  const inRegion = chain.filter((ep) => ep.region === "in")
  const globalRegion = chain.filter((ep) => ep.region === "global")
  return [...inRegion, ...globalRegion]
}

/**
 * Checks whether sending a given data class to an endpoint complies with the residency
 * policy, returning an advisory reason when the endpoint falls outside the allowed regions
 * for that data class.
 *
 * @sem domain=intelligence role=config
 */
export function checkResidency(
  endpoint: RegionEndpoint,
  policy: ResidencyPolicy,
  dataClass: DataClass,
): ResidencyCheck {
  if (policy.mode === "off") {
    return { ok: true }
  }
  const allowed = policy.allow[dataClass]
  if (allowed.includes(endpoint.region)) {
    return { ok: true }
  }
  return {
    ok: false,
    reason: `${dataClass} may not leave region; endpoint is ${endpoint.region}`,
  }
}

/**
 * Picks the best endpoint for a tier and data class given the current residency policy:
 * strict mode enforces compliance hard (returns undefined when none qualify), preferred
 * mode uses the first compliant endpoint or falls back to the first available, and off
 * mode returns the first endpoint unconditionally.
 *
 * @sem domain=intelligence role=config
 */
export function selectEndpoint(
  config: RegionConfig,
  tier: EconTier,
  dataClass: DataClass,
): RegionEndpoint | undefined {
  const chain = resolveTierChain(config, tier)
  const mode = config.residency.mode

  if (mode === "off") {
    return chain[0]
  }

  const compliant = chain.find((ep) => checkResidency(ep, config.residency, dataClass).ok)

  if (mode === "strict") {
    return compliant
  }

  // "preferred": compliant endpoint if found, else first in chain
  return compliant ?? chain[0]
}
