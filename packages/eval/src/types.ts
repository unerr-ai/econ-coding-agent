/**
 * Core types for the econ eval harness — tasks, model endpoints,
 * run results, and the scored shortlist per tier.
 * @sem domain=eval role=types
 */

/** The three agent tiers we are pinning model candidates for. */
export type Tier = "conductor" | "executor" | "oracle"

/**
 * A single benchmark fixture: a prompt, the tier it targets, and
 * a predicate that decides pass/fail from the model's text output.
 */
export interface Fixture {
  id: string
  tier: Tier
  /** System prompt (optional). */
  system?: string
  /** User prompt sent to the model. */
  prompt: string
  /**
   * Returns true when the model output satisfies the task.
   * Keep checks coarse: substring / regex, not exact match.
   */
  check: (output: string) => boolean
  /** Human-readable description of what "pass" means. */
  checkDescription: string
  /**
   * A canned response the mock provider returns for this fixture,
   * so the harness runs without any network or API key.
   */
  mockResponse: string
}

/** Pricing in USD per 1 M tokens (input / output). */
export interface Pricing {
  inputPer1M: number
  outputPer1M: number
}

/**
 * A model endpoint config for one tier. Set provider:"mock" to use
 * the built-in dry-run provider (no key needed).
 */
export interface ModelEndpoint {
  /** Display name, e.g. "qwen3-32b" */
  name: string
  /** OpenAI-compatible base URL, e.g. "https://econ-litellm.fly.dev/v1" */
  baseURL: string
  /** Model id string passed in the request body. */
  model: string
  /** API key (omit in dry-run / mock mode). */
  apiKey?: string
  /** "mock" skips HTTP; "openai-compat" calls the real endpoint. */
  provider: "mock" | "openai-compat"
  pricing: Pricing
}

/** One model run against one fixture. */
export interface RunResult {
  fixtureId: string
  tier: Tier
  modelName: string
  pass: boolean
  output: string
  latencyMs: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  error?: string
}

/** Aggregated score for a model across all fixtures in its tier. */
export interface TierScore {
  tier: Tier
  modelName: string
  passRate: number
  /** Average latency across all fixtures (ms). */
  avgLatencyMs: number
  /** Total tokens consumed. */
  totalInputTokens: number
  totalOutputTokens: number
  /** Total cost across all fixtures (USD). */
  totalCostUsd: number
  runs: RunResult[]
}

/** Per-tier shortlist produced by the harness. */
export type ScoredShortlist = Record<Tier, TierScore[]>
