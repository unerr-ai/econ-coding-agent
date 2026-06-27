/**
 * Fidelity gate for compression passes — measures whether required answer-keys
 * survive a compression step and rejects savings that lose load-bearing content.
 *
 * Two exports: `assessFidelity` (pure verdict, no side-effects) and
 * `gateCompression` (applies a compressor and falls back to the original when
 * any answer key is missing). Both are degrade-safe: a failed gate never
 * discards the original.
 *
 * @sem domain=fidelity role=gate
 */

import { estimateTokens } from "./trim.js"

// ---------------------------------------------------------------------------
// assessFidelity
// ---------------------------------------------------------------------------

/**
 * Describes the before/after pair to evaluate.
 *
 * Supply `mustContain` or its alias `answerKey` (or both — they are merged).
 * Omit both to get a token-savings-only report (fidelity is trivially 1.0).
 *
 * @sem domain=fidelity role=gate
 */
export interface FidelityInput {
  /** Text before compression. */
  before: string
  /** Text after compression. */
  after: string
  /**
   * Substrings that MUST be present in `after` for the compression to be
   * considered faithful.
   */
  mustContain?: string[]
  /**
   * Alias for `mustContain` — preferred name when the keys represent expected
   * answers a downstream model must see.
   */
  answerKey?: string[]
}

/**
 * Verdict emitted by `assessFidelity`.
 *
 * @sem domain=fidelity role=gate
 */
export interface FidelityVerdict {
  /** True when all required keys survived compression. */
  kept: boolean
  /** Estimated tokens saved (negative means the output grew). */
  tokensSaved: number
  /**
   * Fraction of answer keys that survived (0–1). Returns 1.0 when there are
   * no required keys (nothing to lose → trivially faithful).
   */
  fidelityScore: number
  /** Keys not found in `after`. Empty when `kept` is true. */
  missing: string[]
}

/**
 * Checks whether every answer-key (required substring) is still present in
 * the compressed text, and computes token savings. Does not modify any input.
 *
 * @sem domain=fidelity role=gate
 */
export function assessFidelity(input: FidelityInput): FidelityVerdict {
  const { before, after } = input
  const keys = [...(input.mustContain ?? []), ...(input.answerKey ?? [])]

  const beforeTokens = estimateTokens(before)
  const afterTokens = estimateTokens(after)
  const tokensSaved = beforeTokens - afterTokens

  if (keys.length === 0) {
    return { kept: true, tokensSaved, fidelityScore: 1.0, missing: [] }
  }

  const missing = keys.filter((key) => !after.includes(key))
  const fidelityScore = (keys.length - missing.length) / keys.length

  return {
    kept: missing.length === 0,
    tokensSaved,
    fidelityScore,
    missing,
  }
}

// ---------------------------------------------------------------------------
// gateCompression
// ---------------------------------------------------------------------------

/**
 * Optional serializers for `gateCompression`. Needed when the compressor does
 * not operate on raw strings (e.g., passage arrays, message arrays).
 */
export interface GateOptions<I, O> {
  /** Convert the input to a string for fidelity checking (default: `String`). */
  serializeBefore?: (input: I) => string
  /** Convert the compressed output to a string for fidelity checking (default: `String`). */
  serializeAfter?: (output: O) => string
}

/**
 * Result returned by `gateCompression`.
 *
 * @sem domain=fidelity role=gate
 */
export interface GateResult<I, O> {
  /**
   * The accepted output. Equals the compressor result when `kept` is true,
   * or the original `input` (type `I`) when the gate rejected the compression.
   */
  output: O | I
  /** Fidelity verdict for the compression attempt. */
  verdict: FidelityVerdict
  /** True when the compressed output was rejected and the original was returned. */
  degraded: boolean
}

/**
 * Applies `compressor` to `input`, then runs the fidelity gate against
 * `answerKeys`. Returns the compressed output when all keys survive; falls
 * back to the original input (degrade-safe) when any key is missing.
 *
 * Example (string → string compressor):
 * ```ts
 * const { output, verdict } = gateCompression(
 *   (text) => smartTruncate(text, { budget: 500 }).text,
 *   rawText,
 *   ["Error: ENOENT", "at line 42"],
 * )
 * ```
 *
 * For non-string compressors supply `opts.serializeBefore` /
 * `opts.serializeAfter` to project both sides to strings before key-checking.
 *
 * @sem domain=fidelity role=gate
 */
export function gateCompression<I, O>(
  compressor: (input: I) => O,
  input: I,
  answerKeys: string[],
  opts?: GateOptions<I, O>,
): GateResult<I, O> {
  const serializeBefore: (v: I) => string = opts?.serializeBefore ?? ((v) => String(v))
  const serializeAfter: (v: O) => string = opts?.serializeAfter ?? ((v) => String(v))

  const before = serializeBefore(input)
  const compressed = compressor(input)
  const after = serializeAfter(compressed)

  const verdict = assessFidelity({ before, after, answerKey: answerKeys })

  if (!verdict.kept) {
    return { output: input, verdict, degraded: true }
  }

  return { output: compressed, verdict, degraded: false }
}
