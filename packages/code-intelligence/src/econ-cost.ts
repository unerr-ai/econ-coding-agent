/**
 * econ's own per-model cost matrix and step-cost calculator — priced off our
 * Fireworks BYOK rates, NOT the upstream models.dev `cost` field (which is
 * wrong for our BYOK path). Feeds the savings receipt and status line with a
 * dollar figure we can stand behind.
 *
 * @sem domain=observability role=accounting
 */

import type { EconTier } from "./region"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One turn's token counts, already split by cache status. */
export interface EconTokens {
  /** Uncached input tokens (excludes cache read + write). */
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

/** Per-million-token USD rates for one model on econ's BYOK path. */
export interface EconModelRate {
  /** USD per 1M uncached input tokens. */
  input: number
  /** USD per 1M cache-read (cache-hit) input tokens. */
  cachedInput: number
  /** USD per 1M cache-WRITE input tokens. Our BYOK path bills a cache write at
   * the input rate today, but it is its own rate so a model swap can change it
   * without touching {@link econStepCost}. */
  cacheWrite: number
  /** USD per 1M output tokens. */
  output: number
}

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

/**
 * econ's Fireworks BYOK price matrix, keyed by bare modelID. Source of truth
 * for {@link econStepCost} — do not derive rates from models.dev.
 *
 * @sem domain=observability role=accounting
 */
export const ECON_COST_MATRIX: Record<string, EconModelRate> = {
  // conductor — cache-write billed at the input rate on our BYOK path today
  "deepseek/deepseek-v4-flash": { input: 0.14, cachedInput: 0.03, cacheWrite: 0.14, output: 0.28 },
  // oracle — cache-write billed at the input rate on our BYOK path today
  "z-ai/glm-5.2": { input: 1.4, cachedInput: 0.14, cacheWrite: 1.4, output: 4.4 },
  // reasoner (OL-8.B4+, was shared glm-5.2) — cache-write billed at the input rate
  "deepseek/deepseek-v4-pro": { input: 1.74, cachedInput: 0.15, cacheWrite: 1.74, output: 3.48 },
  // executor (OL-8.B4+, was gpt-oss-20b) — real Fireworks serverless rate, no longer $0 self-hosted
  "openai/gpt-oss-120b": { input: 0.15, cachedInput: 0.01, cacheWrite: 0.15, output: 0.60 },
  // catalog (unbound, 2026-07-08) — available in the gateway/registry, not pointed at a tier yet;
  // cache-write billed at the input rate on our BYOK path today
  "minimax/minimax-m3": { input: 0.3, cachedInput: 0.06, cacheWrite: 0.3, output: 1.2 },
  "moonshotai/kimi-k2p7-code": { input: 0.95, cachedInput: 0.19, cacheWrite: 0.95, output: 4.0 },
  // gap-closure-plan §4.4 frontier-patch oracle profile (2026-07-19) — direct-to-Anthropic, NOT
  // the litellm gateway, so it never appears in infra/litellm/config.yaml. $5/$25 per M in/out;
  // cache read at 0.1x ($0.5), cache write at 1.25x ($6.25) per Anthropic's ephemeral 5-min TTL
  // rate card. Catalog-only until ECON_ORACLE_PROFILE selects "frontier-patch" (model-registry.ts
  // ECON_ORACLE_PROFILES) — the live oracle default stays z-ai/glm-5.2.
  "claude-opus-4-8": { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 },
}

const LABELS: Record<string, string> = {
  "deepseek/deepseek-v4-flash": "DeepSeek V4 Flash (conductor)",
  "z-ai/glm-5.2": "GLM 5.2 (oracle)",
  "deepseek/deepseek-v4-pro": "DeepSeek V4 Pro (reasoner)",
  "openai/gpt-oss-120b": "gpt-oss-120b (executor)",
  "minimax/minimax-m3": "MiniMax M3 (catalog)",
  "moonshotai/kimi-k2p7-code": "Kimi K2.7 Code (catalog)",
  "claude-opus-4-8": "Claude Opus 4.8 (oracle — frontier-patch profile)",
}

const LITELLM_PREFIX = "litellm/"

/** Resolve a rate row for a modelID, tolerating a "litellm/" gateway prefix. */
function resolveRate(modelID: string): EconModelRate | undefined {
  const direct = ECON_COST_MATRIX[modelID]
  if (direct) return direct
  if (modelID.includes("/") && modelID.startsWith(LITELLM_PREFIX)) {
    const stripped = modelID.slice(LITELLM_PREFIX.length)
    return ECON_COST_MATRIX[stripped]
  }
  return undefined
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * Prices one turn's tokens against econ's own BYOK matrix — the figure the
 * savings receipt and status line report, since upstream per-model cost is
 * unreliable on our provider path. Unknown models cost 0 rather than throw.
 *
 * @sem domain=observability role=accounting
 */
export function econStepCost(input: {
  modelID: string
  providerID?: string
  tokens: EconTokens
}): number {
  const rate = resolveRate(input.modelID)
  if (!rate) return 0
  const { tokens } = input
  return (
    (tokens.input * rate.input +
      tokens.cache.read * rate.cachedInput +
      tokens.cache.write * rate.cacheWrite +
      tokens.output * rate.output +
      tokens.reasoning * rate.output) /
    1_000_000
  )
}

/**
 * Short human label for a known econ model (tier annotated); passes unknown
 * modelIDs through unchanged for display fallback.
 *
 * @sem domain=observability role=accounting
 */
export function econModelLabel(modelID: string): string {
  return LABELS[modelID] ?? modelID
}

// ---------------------------------------------------------------------------
// Self-host break-even model (OL-M.3)
//
// ECON_COST_MATRIX prices the executor at $0/M, which only holds once
// self-host utilization is high enough to amortize the GPU's fixed monthly
// cost away. Below that volume a managed endpoint is actually cheaper. The
// model is general — any tier, any region: self-host converts a variable
// per-token bill into a fixed monthly GPU cost, and below break-even volume
// a managed endpoint is cheaper. This section is an additive, opt-in layer
// on top of econStepCost — it does not change the matrix or econStepCost's
// behaviour.
// ---------------------------------------------------------------------------

/** Tunable inputs for the self-host break-even model; all optional, defaulting to the plan's calibrated shape. */
export interface SelfHostBreakEvenOptions {
  /** Effective fixed monthly cost ($) amortized across the self-host capacity — a dedicated inference GPU box (e.g. a 1×H100 India neocloud on-demand box ≈ $1825/mo), not a token-level figure. */
  fixedMonthlyCostUsd?: number
  /** Managed-endpoint comparison floor ($/M tokens), low (cheap, cache-heavy blended) end of the band. */
  managedFloorLowUsdPerM?: number
  /** Managed-endpoint comparison floor ($/M tokens), high (output-rate) end of the band. */
  managedFloorHighUsdPerM?: number
}

/**
 * Default self-host break-even parameters, calibrated to the executor's
 * real box (gpt-oss-120b on 1×H100, ~$2.50/hr India neocloud on-demand ≈
 * $1825/mo) and its real serverless rate (input $0.15 / output $0.60 per
 * M). Break-even vs the $0.20 blended managed floor ≈ 9.1B tok/mo, vs the
 * $0.60 output rate ≈ 3.0B tok/mo — near full utilization of a single
 * H100. Under an IndiaAI-subsidized box (~$730/mo) these drop to ~3.65B /
 * ~1.2B tok/mo. Override via {@link SelfHostBreakEvenOptions} — e.g. via
 * {@link selfHostFixedMonthlyUsd} — once real per-tier hosting-bill numbers
 * are known.
 *
 * @sem domain=observability role=accounting
 */
export const SELF_HOST_BREAK_EVEN_DEFAULTS: Required<SelfHostBreakEvenOptions> = {
  fixedMonthlyCostUsd: 1825, // 1×H100 @ ~$2.50/hr × 730h — India neocloud on-demand, the un-subsidized in-region floor
  managedFloorLowUsdPerM: 0.2, // gpt-oss-120b blended serverless (cache-heavy) — cheap end
  managedFloorHighUsdPerM: 0.6, // gpt-oss-120b output rate — expensive end
}

/**
 * Amortized self-host $/M-token rate at a given monthly volume — the honest
 * number behind the matrix's "$0" executor row, which only holds at high
 * utilization. Cost falls off as roughly fixedCost/volume, so it rises
 * sharply below break-even and only nears the managed floor at
 * multi-billion tok/mo volume. Non-positive volume returns Infinity (no
 * amortization base).
 *
 * @sem domain=observability role=accounting
 */
export function selfHostMarginalCostPerMTokens(
  monthlyTokens: number,
  opts?: SelfHostBreakEvenOptions,
): number {
  if (monthlyTokens <= 0) return Infinity
  const fixed = opts?.fixedMonthlyCostUsd ?? SELF_HOST_BREAK_EVEN_DEFAULTS.fixedMonthlyCostUsd
  return fixed / (monthlyTokens / 1_000_000)
}

/**
 * Monthly token volume at which the self-host rate crosses a
 * managed-endpoint comparison rate (defaults to the plan's low floor,
 * $0.20/M) — below this volume a managed endpoint is the cheaper choice.
 *
 * @sem domain=observability role=accounting
 */
export function selfHostBreakEvenMonthlyTokens(
  opts?: SelfHostBreakEvenOptions & { managedRateUsdPerM?: number },
): number {
  const fixed = opts?.fixedMonthlyCostUsd ?? SELF_HOST_BREAK_EVEN_DEFAULTS.fixedMonthlyCostUsd
  const rate =
    opts?.managedRateUsdPerM ??
    opts?.managedFloorLowUsdPerM ??
    SELF_HOST_BREAK_EVEN_DEFAULTS.managedFloorLowUsdPerM
  return (fixed / rate) * 1_000_000
}

/**
 * Real self-host cost for one step's tokens at a given monthly volume — the
 * additive, opt-in honest figure the savings receipt should show instead of
 * the matrix's aspirational $0. Leaves {@link ECON_COST_MATRIX} and
 * {@link econStepCost} untouched; volume-blind callers keep seeing $0.
 *
 * @sem domain=observability role=accounting
 */
export function selfHostEffectiveCost(input: {
  monthlyTokens: number
  tokens: EconTokens
  opts?: SelfHostBreakEvenOptions
}): number {
  const rate = selfHostMarginalCostPerMTokens(input.monthlyTokens, input.opts)
  const { tokens } = input
  const total =
    tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
  return (total * rate) / 1_000_000
}

// ---------------------------------------------------------------------------
// Region/box-parameterized hosting inputs
// ---------------------------------------------------------------------------

/** Hours in a billing month — converts a $/hour GPU rate into a fixed monthly cost. */
export const HOURS_PER_MONTH = 730

/**
 * One live 2026 GPU-rental preset — region, representative $/hour, and
 * whether the GPU sits physically in India (satisfies data residency) —
 * looked up by {@link selfHostFixedMonthlyUsd} to price a real box.
 *
 * @sem domain=observability role=accounting
 */
export interface HostingScenario {
  id: string
  label: string
  region: "india" | "global"
  /** Representative single-GPU $/hour. */
  gpuHourUsd: number
  /** true = GPU physically in India (satisfies data residency). */
  residencyCompliant: boolean
  notes: string
}

/**
 * Registry of live 2026 GPU-rental presets spanning India (residency-
 * compliant, at a cost premium) and global (cheaper, residency-failing)
 * options — the lookup table {@link selfHostFixedMonthlyUsd} resolves a
 * scenario id against.
 *
 * @sem domain=observability role=accounting
 */
export const HOSTING_SCENARIOS: Record<string, HostingScenario> = {
  "india-indiaai": {
    id: "india-indiaai",
    label: "India — IndiaAI Mission (subsidized)",
    region: "india",
    gpuHourUsd: 1.0,
    residencyCompliant: true,
    notes: "IndiaAI Mission subsidized $0.65–1.35/hr; application- and capacity-gated",
  },
  "india-spot": {
    id: "india-spot",
    label: "India — spot (E2E)",
    region: "india",
    gpuHourUsd: 0.82,
    residencyCompliant: true,
    notes: "E2E spot; interruptible, no SLA — stateless tiers only",
  },
  "india-neocloud": {
    id: "india-neocloud",
    label: "India — neocloud on-demand",
    region: "india",
    gpuHourUsd: 2.5,
    residencyCompliant: true,
    notes: "NeevCloud/E2E/Cyfuture on-demand $2.25–2.93",
  },
  "india-reserved": {
    id: "india-reserved",
    label: "India — reserved (3–12mo commit)",
    region: "india",
    gpuHourUsd: 1.8,
    residencyCompliant: true,
    notes: "3–12mo commit $1.53–2.12",
  },
  "global-ondemand": {
    id: "global-ondemand",
    label: "Global — on-demand (out-of-region)",
    region: "global",
    gpuHourUsd: 1.99,
    residencyCompliant: false,
    notes: "Voltage Park/RunPod PCIe — cheapest reliable out-of-region (US)",
  },
  "global-spot": {
    id: "global-spot",
    label: "Global — spot/community (out-of-region)",
    region: "global",
    gpuHourUsd: 1.25,
    residencyCompliant: false,
    notes: "Vast.ai/RunPod community $1.03–1.53; no SLA; fails data residency",
  },
}

/**
 * Converts a hosting scenario (by id or object) plus a GPU count into a
 * fixed monthly USD cost — the bridge that feeds a real per-box bill into
 * {@link SelfHostBreakEvenOptions.fixedMonthlyCostUsd}. Throws on an unknown
 * scenario id.
 *
 * @sem domain=observability role=accounting
 */
export function selfHostFixedMonthlyUsd(input: {
  scenario: HostingScenario | string
  gpuCount: number
  hoursPerMonth?: number
}): number {
  const scenario =
    typeof input.scenario === "string" ? HOSTING_SCENARIOS[input.scenario] : input.scenario
  if (!scenario) {
    throw new Error(`selfHostFixedMonthlyUsd: unknown hosting scenario id "${input.scenario}"`)
  }
  return scenario.gpuHourUsd * input.gpuCount * (input.hoursPerMonth ?? HOURS_PER_MONTH)
}

/**
 * GPU count per econ tier's self-host box. Only the executor (gpt-oss-120b,
 * ~5B active MoE) is confirmed 1×H100; the 8×H100 count for
 * conductor/reasoner/oracle is an ESTIMATE assuming a DeepSeek-V3/GLM-large-
 * MoE class model (~671B / ~355B total params), to be revised once the real
 * DeepSeek V4 Flash/Pro + GLM 5.2 param counts are confirmed.
 *
 * @sem domain=observability role=accounting
 */
export const TIER_GPU_COUNT: Record<EconTier, number> = {
  executor: 1,
  conductor: 8,
  reasoner: 8,
  oracle: 8,
}
