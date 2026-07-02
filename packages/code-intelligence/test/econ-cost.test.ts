/**
 * econ-cost.ts unit tests — econ's own Fireworks BYOK price matrix, not the
 * (unreliable) upstream models.dev cost field.
 *
 * Covers: deepseek + glm-5.2 exact cost math, executor (gpt-oss-20b) always
 * zero, unknown model → 0, "openrouter/" prefix resolution, and
 * econModelLabel known/unknown.
 */

import { describe, it, expect } from "bun:test"
import { econStepCost, econModelLabel, ECON_COST_MATRIX } from "../src/econ-cost.ts"
import type { EconTokens } from "../src/econ-cost.ts"

describe("econStepCost", () => {
  it("prices a deepseek conductor turn against the BYOK matrix", () => {
    const tokens: EconTokens = {
      input: 10000,
      output: 300,
      reasoning: 0,
      cache: { read: 8000, write: 1000 },
    }
    // 10000*0.14/1e6 + 8000*0.03/1e6 + 1000*0.14/1e6 + 300*0.28/1e6
    const expected =
      (10000 * 0.14) / 1_000_000 +
      (8000 * 0.03) / 1_000_000 +
      (1000 * 0.14) / 1_000_000 +
      (300 * 0.28) / 1_000_000
    const cost = econStepCost({ modelID: "deepseek/deepseek-v4-flash", tokens })
    expect(cost).toBeCloseTo(expected, 10)
    expect(cost).toBeCloseTo(0.001864, 10)
  })

  it("prices a glm-5.2 oracle turn against the BYOK matrix", () => {
    const tokens: EconTokens = {
      input: 5000,
      output: 1000,
      reasoning: 200,
      cache: { read: 2000, write: 500 },
    }
    // 5000*1.4/1e6 + 2000*0.14/1e6 + 500*1.4/1e6 + 1000*4.4/1e6 + 200*4.4/1e6
    const expected =
      (5000 * 1.4) / 1_000_000 +
      (2000 * 0.14) / 1_000_000 +
      (500 * 1.4) / 1_000_000 +
      (1000 * 4.4) / 1_000_000 +
      (200 * 4.4) / 1_000_000
    const cost = econStepCost({ modelID: "z-ai/glm-5.2", tokens })
    expect(cost).toBeCloseTo(expected, 10)
    expect(cost).toBeCloseTo(0.01326, 10)
  })

  it("is exactly zero for the self-hosted executor regardless of tokens", () => {
    const tokens: EconTokens = {
      input: 1_000_000,
      output: 500_000,
      reasoning: 100_000,
      cache: { read: 200_000, write: 50_000 },
    }
    const cost = econStepCost({ modelID: "openai/gpt-oss-20b", tokens })
    expect(cost).toBe(0)
  })

  it("returns 0 for an unknown model rather than throwing", () => {
    const tokens: EconTokens = {
      input: 1000,
      output: 100,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    }
    const cost = econStepCost({ modelID: "some/unknown-model", tokens })
    expect(cost).toBe(0)
  })

  it("resolves an 'openrouter/' prefixed modelID the same as the bare key", () => {
    const tokens: EconTokens = {
      input: 10000,
      output: 300,
      reasoning: 0,
      cache: { read: 8000, write: 1000 },
    }
    const bare = econStepCost({ modelID: "deepseek/deepseek-v4-flash", tokens })
    const prefixed = econStepCost({
      modelID: "openrouter/deepseek/deepseek-v4-flash",
      tokens,
    })
    expect(prefixed).toBeCloseTo(bare, 10)
    expect(prefixed).toBeGreaterThan(0)
  })

  it("has rate entries for every model documented in the matrix", () => {
    expect(ECON_COST_MATRIX["deepseek/deepseek-v4-flash"]).toEqual({
      input: 0.14,
      cachedInput: 0.03,
      output: 0.28,
    })
    expect(ECON_COST_MATRIX["z-ai/glm-5.2"]).toEqual({
      input: 1.4,
      cachedInput: 0.14,
      output: 4.4,
    })
    expect(ECON_COST_MATRIX["openai/gpt-oss-20b"]).toEqual({
      input: 0,
      cachedInput: 0,
      output: 0,
    })
  })
})

describe("econModelLabel", () => {
  it("labels known models with their tier", () => {
    expect(econModelLabel("deepseek/deepseek-v4-flash")).toBe(
      "DeepSeek V4 Flash (conductor)",
    )
    expect(econModelLabel("z-ai/glm-5.2")).toBe("GLM 5.2 (oracle)")
    expect(econModelLabel("openai/gpt-oss-20b")).toBe(
      "gpt-oss-20b (executor · self-hosted)",
    )
  })

  it("passes an unknown modelID through unchanged", () => {
    expect(econModelLabel("some/unknown-model")).toBe("some/unknown-model")
  })
})
