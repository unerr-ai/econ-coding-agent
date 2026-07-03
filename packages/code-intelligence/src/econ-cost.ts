/**
 * econ's own per-model cost matrix and step-cost calculator — priced off our
 * Fireworks BYOK rates, NOT the upstream models.dev `cost` field (which is
 * wrong for our BYOK path). Feeds the savings receipt and status line with a
 * dollar figure we can stand behind.
 *
 * @sem domain=observability role=accounting
 */

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
  // conductor
  "deepseek/deepseek-v4-flash": { input: 0.14, cachedInput: 0.03, output: 0.28 },
  // oracle/reasoner
  "z-ai/glm-5.2": { input: 1.4, cachedInput: 0.14, output: 4.4 },
  // executor — self-hosted on cheap GPUs, zero marginal cost
  "openai/gpt-oss-20b": { input: 0, cachedInput: 0, output: 0 },
}

const LABELS: Record<string, string> = {
  "deepseek/deepseek-v4-flash": "DeepSeek V4 Flash (conductor)",
  "z-ai/glm-5.2": "GLM 5.2 (oracle)",
  "openai/gpt-oss-20b": "gpt-oss-20b (executor · self-hosted)",
}

const OPENROUTER_PREFIX = "openrouter/"

/** Resolve a rate row for a modelID, tolerating an "openrouter/" provider prefix. */
function resolveRate(modelID: string): EconModelRate | undefined {
  const direct = ECON_COST_MATRIX[modelID]
  if (direct) return direct
  if (modelID.includes("/") && modelID.startsWith(OPENROUTER_PREFIX)) {
    const stripped = modelID.slice(OPENROUTER_PREFIX.length)
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
      tokens.cache.write * rate.input +
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
// Executor self-host break-even model (OL-M.3)
//
// ECON_COST_MATRIX prices the executor at $0/M, which only holds once
// self-host utilization is high enough to amortize the GPU's fixed monthly
// cost away. Below that volume a managed endpoint is actually cheaper. This
// section is an additive, opt-in layer on top of econStepCost — it does not
// change the matrix or econStepCost's behaviour.
// ---------------------------------------------------------------------------

/** Tunable inputs for the executor break-even model; all optional, defaulting to the plan's calibrated shape. */
export interface ExecutorBreakEvenOptions {
  /** Effective fixed monthly cost ($) amortized across the executor's self-host capacity — a dedicated inference GPU card (e.g. cloud L40S-class ~$0.7/hr ≈ $500/mo, or owned+power amortized over 3yr ≈ $400–500/mo), not a token-level figure. */
  fixedMonthlyCostUsd?: number
  /** Managed-endpoint comparison floor ($/M tokens), low end of the plan's ~$0.05/$0.20 band. */
  managedFloorLowUsdPerM?: number
  /** Managed-endpoint comparison floor ($/M tokens), high end of the plan's ~$0.05/$0.20 band. */
  managedFloorHighUsdPerM?: number
}

/**
 * Default self-host executor break-even parameters, calibrated to a real
 * dedicated inference-GPU card (~$500/mo) rather than reverse-fit to a
 * target token price. At realistic volumes (≤100M tok/mo) self-host
 * marginal cost is $5–500/M — well above the managed $0.05–0.20/M floor, so
 * a managed endpoint wins. Self-host only reaches parity at multi-billion
 * tok/mo: break-even vs. the low managed floor ($0.05/M) ≈ 10B tok/mo, vs.
 * the high floor ($0.20/M) ≈ 2.5B tok/mo — near full utilization of a
 * single card. Override via {@link ExecutorBreakEvenOptions} once real
 * hosting-bill numbers are known.
 *
 * @sem domain=observability role=accounting
 */
export const EXECUTOR_BREAK_EVEN_DEFAULTS: Required<ExecutorBreakEvenOptions> = {
  fixedMonthlyCostUsd: 500,
  managedFloorLowUsdPerM: 0.05,
  managedFloorHighUsdPerM: 0.2,
}

/**
 * Amortized self-host $/M-token rate for the executor tier at a given
 * monthly volume — the honest number behind the matrix's "$0" executor row,
 * which only holds at high utilization. Cost falls off as roughly
 * fixedCost/volume, so it rises sharply below break-even and only nears the
 * managed floor at multi-billion tok/mo volume. Non-positive volume returns
 * Infinity (no amortization base).
 *
 * @sem domain=observability role=accounting
 */
export function executorMarginalCostPerMTokens(
  monthlyTokens: number,
  opts?: ExecutorBreakEvenOptions,
): number {
  if (monthlyTokens <= 0) return Infinity
  const fixed = opts?.fixedMonthlyCostUsd ?? EXECUTOR_BREAK_EVEN_DEFAULTS.fixedMonthlyCostUsd
  return fixed / (monthlyTokens / 1_000_000)
}

/**
 * Monthly token volume at which the self-host executor rate crosses a
 * managed-endpoint comparison rate (defaults to the plan's low floor,
 * $0.05/M) — below this volume a managed endpoint is the cheaper choice.
 *
 * @sem domain=observability role=accounting
 */
export function executorBreakEvenMonthlyTokens(
  opts?: ExecutorBreakEvenOptions & { managedRateUsdPerM?: number },
): number {
  const fixed = opts?.fixedMonthlyCostUsd ?? EXECUTOR_BREAK_EVEN_DEFAULTS.fixedMonthlyCostUsd
  const rate =
    opts?.managedRateUsdPerM ??
    opts?.managedFloorLowUsdPerM ??
    EXECUTOR_BREAK_EVEN_DEFAULTS.managedFloorLowUsdPerM
  return (fixed / rate) * 1_000_000
}

/**
 * Real executor cost for one step's tokens at a given monthly volume — the
 * additive, opt-in honest figure the savings receipt should show instead of
 * the matrix's aspirational $0. Leaves {@link ECON_COST_MATRIX} and
 * {@link econStepCost} untouched; volume-blind callers keep seeing $0.
 *
 * @sem domain=observability role=accounting
 */
export function executorEffectiveCost(input: {
  monthlyTokens: number
  tokens: EconTokens
  opts?: ExecutorBreakEvenOptions
}): number {
  const rate = executorMarginalCostPerMTokens(input.monthlyTokens, input.opts)
  const { tokens } = input
  const total =
    tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
  return (total * rate) / 1_000_000
}
