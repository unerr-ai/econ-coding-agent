/**
 * Unit tests for posterior-uncertainty.ts (task #48) — the green-but-wrong
 * trust signal. Covers: answer-channel token filtering for both generator
 * families (executor's `<|channel|>final` boundary, conductor's `<mm:think>`
 * blocks), perplexity math on known logprobs (incl. the empty-stream guard),
 * the perplexity/confidence → UncertaintySignal converters, and
 * `posteriorEscalation`'s cost-thesis gate (flagged+high only).
 */

import { describe, it, expect } from "bun:test"
import {
  answerChannelTokens,
  perplexityFromLogprobs,
  signalFromPerplexity,
  signalFromConfidence,
  posteriorEscalation,
  PERPLEXITY_HIGH_THRESHOLD,
  VERBALIZED_UNCERTAINTY_HIGH_THRESHOLD,
  type LogprobToken,
  type UncertaintySignal,
} from "../src/posterior-uncertainty.js"

// ---------------------------------------------------------------------------
// answerChannelTokens — strip reasoning, keep the answer, per family
// ---------------------------------------------------------------------------

describe("answerChannelTokens", () => {
  it("executor: strips everything at/before the <|channel|>final boundary, keeps the answer tokens after it", () => {
    const tokens: LogprobToken[] = [
      { token: "Let", logprob: -0.5 },
      { token: " me", logprob: -0.3 },
      { token: " think", logprob: -0.9 },
      { token: "<|channel|>final", logprob: -0.05 },
      { token: "The", logprob: -0.02 },
      { token: " answer", logprob: -0.01 },
      { token: " is", logprob: -0.03 },
      { token: " 42", logprob: -0.01 },
    ]
    const answer = answerChannelTokens(tokens, "executor")
    expect(answer.map((t) => t.token)).toEqual(["The", " answer", " is", " 42"])
  })

  it("executor: no boundary present → returns the stream unchanged (nothing to strip)", () => {
    const tokens: LogprobToken[] = [{ token: "just", logprob: -0.1 }, { token: " answer", logprob: -0.2 }]
    expect(answerChannelTokens(tokens, "executor")).toEqual(tokens)
  })

  it("conductor: strips a <mm:think>…</mm:think> block, keeps the answer tokens outside it", () => {
    const tokens: LogprobToken[] = [
      { token: "<mm:think>", logprob: -0.1 },
      { token: "pondering", logprob: -0.4 },
      { token: "</mm:think>", logprob: -0.05 },
      { token: "Final", logprob: -0.02 },
      { token: " answer", logprob: -0.01 },
    ]
    const answer = answerChannelTokens(tokens, "conductor")
    expect(answer.map((t) => t.token)).toEqual(["Final", " answer"])
  })

  it("conductor: strips MULTIPLE think blocks and keeps only what's outside every span", () => {
    const tokens: LogprobToken[] = [
      { token: "<mm:think>", logprob: -0.1 },
      { token: "a", logprob: -0.1 },
      { token: "</mm:think>", logprob: -0.1 },
      { token: "mid", logprob: -0.1 },
      { token: "<mm:think>", logprob: -0.1 },
      { token: "b", logprob: -0.1 },
      { token: "</mm:think>", logprob: -0.1 },
      { token: "end", logprob: -0.1 },
    ]
    const answer = answerChannelTokens(tokens, "conductor")
    expect(answer.map((t) => t.token)).toEqual(["mid", "end"])
  })

  it("conductor: no think block present → returns the stream unchanged", () => {
    const tokens: LogprobToken[] = [{ token: "plain", logprob: -0.1 }, { token: " text", logprob: -0.2 }]
    expect(answerChannelTokens(tokens, "conductor")).toEqual(tokens)
  })

  it("empty stream → empty for either family", () => {
    expect(answerChannelTokens([], "executor")).toEqual([])
    expect(answerChannelTokens([], "conductor")).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// perplexityFromLogprobs — geometric-mean perplexity, empty-stream guard
// ---------------------------------------------------------------------------

describe("perplexityFromLogprobs", () => {
  it("computes exp(-mean(logprob)) over the given tokens", () => {
    const tokens: LogprobToken[] = [{ token: "a", logprob: -1 }, { token: "b", logprob: -1 }, { token: "c", logprob: -1 }]
    expect(perplexityFromLogprobs(tokens)).toBeCloseTo(Math.E, 6)
  })

  it("a near-zero mean logprob (near-certain tokens) → perplexity near 1", () => {
    const tokens: LogprobToken[] = [{ token: "a", logprob: 0 }, { token: "b", logprob: 0 }]
    expect(perplexityFromLogprobs(tokens)).toBeCloseTo(1, 6)
  })

  it("empty stream → undefined (unknown, not a fabricated value)", () => {
    expect(perplexityFromLogprobs([])).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// signalFromPerplexity / signalFromConfidence — normalize into UncertaintySignal
// ---------------------------------------------------------------------------

describe("signalFromPerplexity", () => {
  it("flags high at/above PERPLEXITY_HIGH_THRESHOLD", () => {
    const signal = signalFromPerplexity(PERPLEXITY_HIGH_THRESHOLD)
    expect(signal).toEqual({ kind: "perplexity", value: PERPLEXITY_HIGH_THRESHOLD, high: true })
  })

  it("does not flag high just below the threshold", () => {
    const signal = signalFromPerplexity(PERPLEXITY_HIGH_THRESHOLD - 0.01)
    expect(signal.high).toBe(false)
  })

  it("undefined (unknown) perplexity is never high", () => {
    expect(signalFromPerplexity(undefined)).toEqual({ kind: "perplexity", value: 0, high: false })
  })
})

describe("signalFromConfidence", () => {
  it("inverts confidence into uncertainty and flags high at/below the 50% confidence floor", () => {
    expect(signalFromConfidence(0.1)).toEqual({ kind: "verbalized", value: 0.9, high: true })
    expect(signalFromConfidence(0.9)).toEqual({ kind: "verbalized", value: expect.closeTo(0.1, 6), high: false })
  })

  it("clamps an out-of-range confidence into [0, 1] before inverting", () => {
    expect(signalFromConfidence(1.5).value).toBeCloseTo(0, 6)
    expect(signalFromConfidence(-0.5).value).toBeCloseTo(1, 6)
  })

  it("exactly VERBALIZED_UNCERTAINTY_HIGH_THRESHOLD counts as high (>=, not >)", () => {
    const confidence = 1 - VERBALIZED_UNCERTAINTY_HIGH_THRESHOLD
    expect(signalFromConfidence(confidence).high).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// posteriorEscalation — the cost-thesis guard: flagged AND high, nothing else
// ---------------------------------------------------------------------------

describe("posteriorEscalation", () => {
  const highSignal: UncertaintySignal = { kind: "perplexity", value: 10, high: true }
  const lowSignal: UncertaintySignal = { kind: "perplexity", value: 1, high: false }

  it("flagged (hard) + high → true", () => {
    expect(posteriorEscalation(highSignal, { hardness: "hard" })).toBe(true)
  })

  it("flagged (ambiguous) + high → true", () => {
    expect(posteriorEscalation(highSignal, { ambiguity: "ambiguous" })).toBe(true)
  })

  it("flagged + low → false", () => {
    expect(posteriorEscalation(lowSignal, { hardness: "hard" })).toBe(false)
    expect(posteriorEscalation(lowSignal, { ambiguity: "ambiguous" })).toBe(false)
  })

  it("unflagged (trivial/clear) + high → false — the cost thesis never inverts", () => {
    expect(posteriorEscalation(highSignal, { hardness: "trivial", ambiguity: "clear" })).toBe(false)
    expect(posteriorEscalation(highSignal, {})).toBe(false)
  })

  it("no signal at all → false regardless of flagged status", () => {
    expect(posteriorEscalation(undefined, { hardness: "hard" })).toBe(false)
  })
})
