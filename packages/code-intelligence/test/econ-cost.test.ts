/**
 * econ-cost.ts unit tests — econ's own Fireworks BYOK price matrix, not the
 * (unreliable) upstream models.dev cost field.
 *
 * Covers: deepseek + glm-5.2 exact cost math, executor (gpt-oss-20b) always
 * zero, unknown model → 0, "openrouter/" prefix resolution, and
 * econModelLabel known/unknown.
 */

import { describe, it, expect } from "bun:test"
import {
  econStepCost,
  econModelLabel,
  ECON_COST_MATRIX,
  executorMarginalCostPerMTokens,
  executorBreakEvenMonthlyTokens,
  executorEffectiveCost,
  EXECUTOR_BREAK_EVEN_DEFAULTS,
} from "../src/econ-cost.ts"
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

describe("executor self-host break-even model (OL-M.3)", () => {
  it("ships sensible default parameters", () => {
    expect(EXECUTOR_BREAK_EVEN_DEFAULTS).toEqual({
      fixedMonthlyCostUsd: 500,
      managedFloorLowUsdPerM: 0.05,
      managedFloorHighUsdPerM: 0.2,
    })
  })

  it("below break-even: self-host costs far more than the managed floor at low volume", () => {
    const rate = executorMarginalCostPerMTokens(200_000) // 200K tok/mo
    expect(rate).toBeCloseTo(2500.0, 10)
    expect(rate).toBeGreaterThan(EXECUTOR_BREAK_EVEN_DEFAULTS.managedFloorHighUsdPerM)
    expect(rate).toBeGreaterThan(EXECUTOR_BREAK_EVEN_DEFAULTS.managedFloorLowUsdPerM)
  })

  it("at realistic volumes (50-100M tok/mo) self-host is still well above the managed floor", () => {
    const at50M = executorMarginalCostPerMTokens(50_000_000)
    const at100M = executorMarginalCostPerMTokens(100_000_000)
    expect(at50M).toBeCloseTo(10.0, 10)
    expect(at100M).toBeCloseTo(5.0, 10)
    // a managed endpoint wins at these volumes — self-host is nowhere near the floor yet
    expect(at50M).toBeGreaterThan(EXECUTOR_BREAK_EVEN_DEFAULTS.managedFloorHighUsdPerM)
    expect(at100M).toBeGreaterThan(EXECUTOR_BREAK_EVEN_DEFAULTS.managedFloorHighUsdPerM)
    // self-host only nears the low managed floor at multi-billion tok/mo (near full card utilization)
    const atMultiBillion = executorMarginalCostPerMTokens(10_000_000_000)
    expect(atMultiBillion).toBeCloseTo(EXECUTOR_BREAK_EVEN_DEFAULTS.managedFloorLowUsdPerM, 10)
  })

  it("rises sharply as volume approaches zero and is Infinity at zero/negative volume", () => {
    expect(executorMarginalCostPerMTokens(0)).toBe(Infinity)
    expect(executorMarginalCostPerMTokens(-1)).toBe(Infinity)
    const veryLow = executorMarginalCostPerMTokens(10_000) // 10K tok/mo
    const low = executorMarginalCostPerMTokens(1_000_000) // 1M tok/mo
    expect(veryLow).toBeGreaterThan(low)
  })

  it("computes the crossover point against the low managed floor by default", () => {
    const crossover = executorBreakEvenMonthlyTokens()
    expect(crossover).toBeCloseTo(10_000_000_000, 6) // 10B tok/mo
    // at the crossover, self-host cost exactly matches the comparison floor
    const rateAtCrossover = executorMarginalCostPerMTokens(crossover)
    expect(rateAtCrossover).toBeCloseTo(
      EXECUTOR_BREAK_EVEN_DEFAULTS.managedFloorLowUsdPerM,
      10,
    )
  })

  it("computes the crossover point against the high managed floor at the default fixed cost", () => {
    const crossover = executorBreakEvenMonthlyTokens({
      managedRateUsdPerM: EXECUTOR_BREAK_EVEN_DEFAULTS.managedFloorHighUsdPerM,
    })
    expect(crossover).toBeCloseTo(2_500_000_000, 6) // 2.5B tok/mo
  })

  it("computes the crossover point against a custom managed rate and fixed cost", () => {
    const crossover = executorBreakEvenMonthlyTokens({
      fixedMonthlyCostUsd: 1,
      managedRateUsdPerM: 0.2,
    })
    expect(crossover).toBeCloseTo(5_000_000, 6)
  })

  it("executorEffectiveCost returns a non-zero honest figure the matrix's $0 hides", () => {
    const tokens: EconTokens = {
      input: 500_000,
      output: 200_000,
      reasoning: 0,
      cache: { read: 100_000, write: 50_000 },
    }
    // the matrix keeps pricing the executor at exactly $0 regardless of volume
    expect(econStepCost({ modelID: "openai/gpt-oss-20b", tokens })).toBe(0)

    const atHighVolume = executorEffectiveCost({ monthlyTokens: 100_000_000, tokens })
    const atLowVolume = executorEffectiveCost({ monthlyTokens: 200_000, tokens })
    expect(atHighVolume).toBeGreaterThan(0)
    expect(atLowVolume).toBeGreaterThan(atHighVolume)

    const total = 500_000 + 200_000 + 0 + 100_000 + 50_000
    // rate at 100M tok/mo = 500 / (100M / 1e6) = 5.0 $/M
    const expectedAtHighVolume = (total * 5.0) / 1_000_000
    expect(atHighVolume).toBeCloseTo(expectedAtHighVolume, 10)
  })

  it("executorEffectiveCost honors custom break-even options", () => {
    const tokens: EconTokens = {
      input: 1_000_000,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    }
    const cost = executorEffectiveCost({
      monthlyTokens: 10_000_000,
      tokens,
      opts: { fixedMonthlyCostUsd: 2 },
    })
    // rate = 2 / (10_000_000 / 1e6) = 0.2 $/M
    expect(cost).toBeCloseTo((1_000_000 * 0.2) / 1_000_000, 10)
  })
})
