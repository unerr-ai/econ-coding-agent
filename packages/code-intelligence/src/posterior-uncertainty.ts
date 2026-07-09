/**
 * The posterior-uncertainty gate (task #48) — the "green-but-wrong" trust
 * signal. A passing sound-rung verdict only proves a slice's code RUNS, never
 * that it solved the RIGHT problem; on a prior-flagged (ambiguous/hard) slice
 * a high-uncertainty signal earns ONE extra generator escalation even on a
 * green verdict. The gate is strictly one-way and prior-gated — an unflagged
 * slice never triggers it, so the cost thesis (cheap-by-default) stays intact.
 * Pure: no I/O, no model names (tier-speak only) — the caller (slice-loop.ts)
 * supplies the signal and decides what to do with a `true` verdict.
 *
 * @sem domain=routing role=gate
 */

/** One raw token from a logprob-emitting dispatch, in stream order. */
export interface LogprobToken {
  token: string
  logprob: number
}

/**
 * Generator family discriminator for `answerChannelTokens` — tier-speak, not a
 * model id: `executor` carries a channel-tagged reasoning transcript, `conductor`
 * carries inline `<mm:think>` reasoning blocks. Kept as a closed union (rather
 * than the full `EconTier`) because only these two tiers stream distinguishable
 * reasoning/answer channels today; extend when a third family needs stripping.
 *
 * @sem domain=routing role=type
 */
export type ModelFamily = "executor" | "conductor"

/**
 * A normalized uncertainty reading — higher `value` always means MORE
 * uncertain, regardless of `kind`, so `posteriorEscalation` never needs to
 * know how the number was produced. `kind` records provenance only (logprob
 * perplexity vs. a verbalized self-confidence fallback) for telemetry/debugging.
 *
 * @sem domain=routing role=type
 */
export interface UncertaintySignal {
  kind: "perplexity" | "verbalized"
  value: number
  high: boolean
}

/** The gate's marker boundary in an executor-family transcript: everything at/after this string is the answer channel, everything before it is reasoning. */
const EXECUTOR_ANSWER_BOUNDARY = "<|channel|>final"

/** The gate's reasoning-block delimiter in a conductor-family transcript — every matched span (tags included) is reasoning, not answer. */
const CONDUCTOR_THINK_BLOCK = /<mm:think>[\s\S]*?<\/mm:think>/g

/**
 * Filter a family's raw token stream down to ANSWER tokens only — reasoning
 * interleaves with the answer, so a perplexity computed over the raw stream
 * would be dominated by exploratory reasoning noise instead of the committed
 * answer. Executor strips everything up to and including the
 * `<|channel|>final` boundary; conductor strips every `<mm:think>…</mm:think>`
 * span. No boundary/span found ⇒ the stream is returned unchanged (nothing to
 * strip, not an error).
 *
 * @sem domain=routing role=filter
 */
export function answerChannelTokens(tokens: readonly LogprobToken[], family: ModelFamily): LogprobToken[] {
  if (tokens.length === 0) return []

  const offsets: Array<{ start: number; end: number }> = []
  let cursor = 0
  for (const t of tokens) {
    offsets.push({ start: cursor, end: cursor + t.token.length })
    cursor += t.token.length
  }
  const text = tokens.map((t) => t.token).join("")

  if (family === "executor") {
    const boundaryIdx = text.indexOf(EXECUTOR_ANSWER_BOUNDARY)
    if (boundaryIdx === -1) return [...tokens]
    const keepFrom = boundaryIdx + EXECUTOR_ANSWER_BOUNDARY.length
    return tokens.filter((_, i) => offsets[i].start >= keepFrom)
  }

  const reasoningSpans: Array<{ start: number; end: number }> = []
  for (const m of text.matchAll(CONDUCTOR_THINK_BLOCK)) {
    reasoningSpans.push({ start: m.index, end: m.index + m[0].length })
  }
  if (reasoningSpans.length === 0) return [...tokens]
  return tokens.filter((_, i) => !reasoningSpans.some((s) => offsets[i].start < s.end && offsets[i].end > s.start))
}

/**
 * Geometric-mean perplexity `exp(-mean(logprob))` over the given tokens
 * (typically pre-filtered to the answer channel via `answerChannelTokens`) —
 * low perplexity (near 1) means the model was near-certain token-by-token.
 * An empty stream has no signal, so it returns `undefined` (unknown) rather
 * than a fabricated low/high value — callers must treat unknown as not-high.
 *
 * @sem domain=routing role=calculator
 */
export function perplexityFromLogprobs(tokens: readonly LogprobToken[]): number | undefined {
  if (tokens.length === 0) return undefined
  const meanLogprob = tokens.reduce((sum, t) => sum + t.logprob, 0) / tokens.length
  return Math.exp(-meanLogprob)
}

/**
 * Perplexity at/above this counts as "high" uncertainty for `posteriorEscalation`.
 * Chosen as a conservative first cut — well above the ~1.0-1.5 typical for a
 * confident greedy answer — so the gate does not eat into the cost thesis by
 * firing on ordinary token-level noise. TODO(task #56): provisional; retune
 * once real logprob traces from prior-flagged slices are available.
 *
 * @sem domain=routing role=config
 */
export const PERPLEXITY_HIGH_THRESHOLD = 3

/**
 * Verbalized-confidence uncertainty (`1 - confidence`) at/above this counts as
 * "high" — i.e. a generator self-reporting 50% confidence or less floors the
 * `confidenceGenerate` fallback to escalate. Provisional, same as
 * `PERPLEXITY_HIGH_THRESHOLD` — no live calibration data yet either.
 *
 * @sem domain=routing role=config
 */
export const VERBALIZED_UNCERTAINTY_HIGH_THRESHOLD = 0.5

/**
 * Wrap a raw perplexity reading (from `perplexityFromLogprobs`) into a
 * normalized `UncertaintySignal` against `PERPLEXITY_HIGH_THRESHOLD`. An
 * unknown (`undefined`) perplexity is never high — absence of a logprob
 * signal is not evidence of uncertainty.
 *
 * @sem domain=routing role=converter
 */
export function signalFromPerplexity(perplexity: number | undefined): UncertaintySignal {
  return {
    kind: "perplexity",
    value: perplexity ?? 0,
    high: perplexity !== undefined && perplexity >= PERPLEXITY_HIGH_THRESHOLD,
  }
}

/**
 * Wrap a verbalized self-confidence reading (0 = no confidence, 1 = certain)
 * into a normalized `UncertaintySignal` — the `confidenceGenerate` fallback's
 * output shape. Confidence is clamped to `[0, 1]` before inversion so an
 * out-of-range generator response can't produce a negative or >1 uncertainty.
 *
 * @sem domain=routing role=converter
 */
export function signalFromConfidence(confidence: number): UncertaintySignal {
  const clamped = Math.min(1, Math.max(0, confidence))
  const uncertainty = 1 - clamped
  return { kind: "verbalized", value: uncertainty, high: uncertainty >= VERBALIZED_UNCERTAINTY_HIGH_THRESHOLD }
}

/** The slice-loop fields the gate needs to decide prior-flagged status — a structural subset of `LoopSlice`, kept local to avoid an import cycle with slice-loop.ts. */
export interface PriorFlaggedSlice {
  hardness?: "trivial" | "moderate" | "hard"
  ambiguity?: "clear" | "ambiguous"
}

/**
 * The cost-thesis guard: ONE generator escalation is warranted on a green
 * verdict ONLY when the slice was PRIOR-flagged (ambiguous or hard — the
 * arming judge's own signal, not a re-derived one) AND the posterior signal
 * itself reads high. Either half absent ⇒ false — an unflagged slice never
 * escalates on green, no matter how uncertain the signal, which is what keeps
 * this one-way (escalate-only) and off the common path.
 *
 * @sem domain=routing role=gate
 */
export function posteriorEscalation(signal: UncertaintySignal | undefined, slice: PriorFlaggedSlice): boolean {
  if (!signal) return false
  const priorFlagged = slice.ambiguity === "ambiguous" || slice.hardness === "hard"
  return priorFlagged && signal.high
}
