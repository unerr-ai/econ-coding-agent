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
