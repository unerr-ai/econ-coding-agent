/**
 * econ-cost.ts unit tests — econ's own Fireworks BYOK price matrix, not the
 * (unreliable) upstream models.dev cost field.
 *
 * Covers: deepseek + glm-5.2 + deepseek-v4-pro exact cost math, executor
 * (gpt-oss-120b) real BYOK pricing, unknown model → 0, "litellm/" gateway
 * prefix resolution, and econModelLabel known/unknown.
 */

import { describe, it, expect } from "bun:test"
import {
  econStepCost,
  econModelLabel,
  ECON_COST_MATRIX,
  selfHostMarginalCostPerMTokens,
  selfHostBreakEvenMonthlyTokens,
  selfHostEffectiveCost,
  SELF_HOST_BREAK_EVEN_DEFAULTS,
  HOURS_PER_MONTH,
  HOSTING_SCENARIOS,
  selfHostFixedMonthlyUsd,
  TIER_GPU_COUNT,
} from "../src/econ-cost.ts"
import type { EconTokens } from "../src/econ-cost.ts"
import { ECON_TIER_BINDING } from "../src/model-registry.ts"

describe("econStepCost", () => {
  it("prices a deepseek conductor turn against the BYOK matrix", () => {
    const tokens: EconTokens = {
      input: 10000,
      output: 300,
      reasoning: 0,
      cache: { read: 8000, write: 1000 },
    }
    // 10000*input(0.14)/1e6 + 8000*cachedInput(0.03)/1e6 + 1000*cacheWrite(0.14)/1e6 + 300*output(0.28)/1e6
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
    // 5000*input(1.4)/1e6 + 2000*cachedInput(0.14)/1e6 + 500*cacheWrite(1.4)/1e6 + 1000*output(4.4)/1e6 + 200*output(4.4)/1e6
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

  it("prices a gpt-oss-120b executor turn against the BYOK matrix (OL-8.B4+: no longer $0)", () => {
    const tokens: EconTokens = {
      input: 1_000_000,
      output: 500_000,
      reasoning: 100_000,
      cache: { read: 200_000, write: 50_000 },
    }
    // 1e6*input(0.15)/1e6 + 200_000*cachedInput(0.01)/1e6 + 50_000*cacheWrite(0.15)/1e6 + 500_000*output(0.6)/1e6 + 100_000*output(0.6)/1e6
    const expected =
      (1_000_000 * 0.15) / 1_000_000 +
      (200_000 * 0.01) / 1_000_000 +
      (50_000 * 0.15) / 1_000_000 +
      (500_000 * 0.6) / 1_000_000 +
      (100_000 * 0.6) / 1_000_000
    const cost = econStepCost({ modelID: ECON_TIER_BINDING.executor, tokens })
    expect(cost).toBeCloseTo(expected, 10)
    expect(cost).toBeCloseTo(0.5195, 10)
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

  it("resolves a 'litellm/' prefixed modelID the same as the bare key", () => {
    const tokens: EconTokens = {
      input: 10000,
      output: 300,
      reasoning: 0,
      cache: { read: 8000, write: 1000 },
    }
    const bare = econStepCost({ modelID: "deepseek/deepseek-v4-flash", tokens })
    const prefixed = econStepCost({
      modelID: "litellm/deepseek/deepseek-v4-flash",
      tokens,
    })
    expect(prefixed).toBeCloseTo(bare, 10)
    expect(prefixed).toBeGreaterThan(0)
  })

  it("has rate entries for every model documented in the matrix", () => {
    expect(ECON_COST_MATRIX["deepseek/deepseek-v4-flash"]).toEqual({
      input: 0.14,
      cachedInput: 0.03,
      cacheWrite: 0.14,
      output: 0.28,
    })
    expect(ECON_COST_MATRIX["z-ai/glm-5.2"]).toEqual({
      input: 1.4,
      cachedInput: 0.14,
      cacheWrite: 1.4,
      output: 4.4,
    })
    expect(ECON_COST_MATRIX["deepseek/deepseek-v4-pro"]).toEqual({
      input: 1.74,
      cachedInput: 0.15,
      cacheWrite: 1.74,
      output: 3.48,
    })
    expect(ECON_COST_MATRIX["openai/gpt-oss-120b"]).toEqual({
      input: 0.15,
      cachedInput: 0.01,
      cacheWrite: 0.15,
      output: 0.60,
    })
  })
})

describe("econModelLabel", () => {
  it("labels known models with their tier", () => {
    expect(econModelLabel("deepseek/deepseek-v4-flash")).toBe(
      "DeepSeek V4 Flash (conductor)",
    )
    expect(econModelLabel("z-ai/glm-5.2")).toBe("GLM 5.2 (oracle)")
    expect(econModelLabel("deepseek/deepseek-v4-pro")).toBe(
      "DeepSeek V4 Pro (reasoner)",
    )
    expect(econModelLabel("openai/gpt-oss-120b")).toBe(
      "gpt-oss-120b (executor)",
    )
  })

  it("passes an unknown modelID through unchanged", () => {
    expect(econModelLabel("some/unknown-model")).toBe("some/unknown-model")
  })
})

describe("self-host break-even model (OL-M.3)", () => {
  it("ships sensible default parameters", () => {
    expect(SELF_HOST_BREAK_EVEN_DEFAULTS).toEqual({
      fixedMonthlyCostUsd: 1825,
      managedFloorLowUsdPerM: 0.2,
      managedFloorHighUsdPerM: 0.6,
    })
  })

  it("below break-even: self-host costs far more than the managed floor at low volume", () => {
    const rate = selfHostMarginalCostPerMTokens(200_000) // 200K tok/mo
    expect(rate).toBeCloseTo(
      SELF_HOST_BREAK_EVEN_DEFAULTS.fixedMonthlyCostUsd / 0.2,
      10,
    )
    expect(rate).toBeGreaterThan(SELF_HOST_BREAK_EVEN_DEFAULTS.managedFloorHighUsdPerM)
    expect(rate).toBeGreaterThan(SELF_HOST_BREAK_EVEN_DEFAULTS.managedFloorLowUsdPerM)
  })

  it("at realistic volumes (50-100M tok/mo) self-host is still well above the managed floor", () => {
    const at50M = selfHostMarginalCostPerMTokens(50_000_000)
    const at100M = selfHostMarginalCostPerMTokens(100_000_000)
    expect(at50M).toBeCloseTo(SELF_HOST_BREAK_EVEN_DEFAULTS.fixedMonthlyCostUsd / 50, 10)
    expect(at100M).toBeCloseTo(SELF_HOST_BREAK_EVEN_DEFAULTS.fixedMonthlyCostUsd / 100, 10)
    // a managed endpoint wins at these volumes — self-host is nowhere near the floor yet
    expect(at50M).toBeGreaterThan(SELF_HOST_BREAK_EVEN_DEFAULTS.managedFloorHighUsdPerM)
    expect(at100M).toBeGreaterThan(SELF_HOST_BREAK_EVEN_DEFAULTS.managedFloorHighUsdPerM)
    // self-host only nears the fixed-cost-derived rate at multi-billion tok/mo (near full box utilization)
    const atMultiBillion = selfHostMarginalCostPerMTokens(10_000_000_000)
    expect(atMultiBillion).toBeCloseTo(
      SELF_HOST_BREAK_EVEN_DEFAULTS.fixedMonthlyCostUsd / 10_000,
      10,
    )
  })

  it("rises sharply as volume approaches zero and is Infinity at zero/negative volume", () => {
    expect(selfHostMarginalCostPerMTokens(0)).toBe(Infinity)
    expect(selfHostMarginalCostPerMTokens(-1)).toBe(Infinity)
    const veryLow = selfHostMarginalCostPerMTokens(10_000) // 10K tok/mo
    const low = selfHostMarginalCostPerMTokens(1_000_000) // 1M tok/mo
    expect(veryLow).toBeGreaterThan(low)
  })

  it("computes the crossover point against the low managed floor by default", () => {
    const crossover = selfHostBreakEvenMonthlyTokens()
    expect(crossover).toBeCloseTo(
      (SELF_HOST_BREAK_EVEN_DEFAULTS.fixedMonthlyCostUsd /
        SELF_HOST_BREAK_EVEN_DEFAULTS.managedFloorLowUsdPerM) *
        1_000_000,
      6,
    ) // ~9.1B tok/mo
    // at the crossover, self-host cost exactly matches the comparison floor
    const rateAtCrossover = selfHostMarginalCostPerMTokens(crossover)
    expect(rateAtCrossover).toBeCloseTo(
      SELF_HOST_BREAK_EVEN_DEFAULTS.managedFloorLowUsdPerM,
      10,
    )
  })

  it("computes the crossover point against the high managed floor at the default fixed cost", () => {
    const crossover = selfHostBreakEvenMonthlyTokens({
      managedRateUsdPerM: SELF_HOST_BREAK_EVEN_DEFAULTS.managedFloorHighUsdPerM,
    })
    expect(crossover).toBeCloseTo(
      (SELF_HOST_BREAK_EVEN_DEFAULTS.fixedMonthlyCostUsd /
        SELF_HOST_BREAK_EVEN_DEFAULTS.managedFloorHighUsdPerM) *
        1_000_000,
      6,
    ) // ~3.0B tok/mo
  })

  it("computes the crossover point against a custom managed rate and fixed cost", () => {
    const crossover = selfHostBreakEvenMonthlyTokens({
      fixedMonthlyCostUsd: 1,
      managedRateUsdPerM: 0.2,
    })
    expect(crossover).toBeCloseTo(5_000_000, 6)
  })

  it("selfHostEffectiveCost returns a non-zero honest figure the matrix's $0 hides", () => {
    const tokens: EconTokens = {
      input: 500_000,
      output: 200_000,
      reasoning: 0,
      cache: { read: 100_000, write: 50_000 },
    }
    // the matrix keeps pricing the executor at exactly $0 regardless of volume
    expect(econStepCost({ modelID: "openai/gpt-oss-20b", tokens })).toBe(0)

    const atHighVolume = selfHostEffectiveCost({ monthlyTokens: 100_000_000, tokens })
    const atLowVolume = selfHostEffectiveCost({ monthlyTokens: 200_000, tokens })
    expect(atHighVolume).toBeGreaterThan(0)
    expect(atLowVolume).toBeGreaterThan(atHighVolume)

    const total = 500_000 + 200_000 + 0 + 100_000 + 50_000
    // rate at 100M tok/mo = fixedMonthlyCostUsd / (100M / 1e6) $/M
    const rateAtHighVolume = SELF_HOST_BREAK_EVEN_DEFAULTS.fixedMonthlyCostUsd / 100
    const expectedAtHighVolume = (total * rateAtHighVolume) / 1_000_000
    expect(atHighVolume).toBeCloseTo(expectedAtHighVolume, 10)
  })

  it("selfHostEffectiveCost honors custom break-even options", () => {
    const tokens: EconTokens = {
      input: 1_000_000,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    }
    const cost = selfHostEffectiveCost({
      monthlyTokens: 10_000_000,
      tokens,
      opts: { fixedMonthlyCostUsd: 2 },
    })
    // rate = 2 / (10_000_000 / 1e6) = 0.2 $/M
    expect(cost).toBeCloseTo((1_000_000 * 0.2) / 1_000_000, 10)
  })
})

describe("selfHostFixedMonthlyUsd", () => {
  it("prices a single-GPU IndiaAI-subsidized box at ~$730/mo", () => {
    const cost = selfHostFixedMonthlyUsd({ scenario: "india-indiaai", gpuCount: 1 })
    expect(cost).toBeCloseTo(HOSTING_SCENARIOS["india-indiaai"].gpuHourUsd * HOURS_PER_MONTH, 10)
    expect(cost).toBeCloseTo(730, 0)
  })

  it("prices an 8-GPU global on-demand box using the scenario's rate and HOURS_PER_MONTH", () => {
    const cost = selfHostFixedMonthlyUsd({ scenario: "global-ondemand", gpuCount: 8 })
    expect(cost).toBeCloseTo(
      HOSTING_SCENARIOS["global-ondemand"].gpuHourUsd * 8 * HOURS_PER_MONTH,
      10,
    )
  })

  it("accepts a HostingScenario object directly, not just an id", () => {
    const scenario = HOSTING_SCENARIOS["india-neocloud"]
    const cost = selfHostFixedMonthlyUsd({ scenario, gpuCount: 1 })
    expect(cost).toBeCloseTo(scenario.gpuHourUsd * HOURS_PER_MONTH, 10)
  })

  it("honors an explicit hoursPerMonth override", () => {
    const cost = selfHostFixedMonthlyUsd({
      scenario: "india-spot",
      gpuCount: 2,
      hoursPerMonth: 24,
    })
    expect(cost).toBeCloseTo(HOSTING_SCENARIOS["india-spot"].gpuHourUsd * 2 * 24, 10)
  })

  it("throws a clear error on an unknown scenario id", () => {
    expect(() => selfHostFixedMonthlyUsd({ scenario: "not-a-real-scenario", gpuCount: 1 })).toThrow()
  })
})

describe("HOSTING_SCENARIOS", () => {
  it("marks every India scenario as residency-compliant", () => {
    expect(HOSTING_SCENARIOS["india-indiaai"].residencyCompliant).toBe(true)
    expect(HOSTING_SCENARIOS["india-spot"].residencyCompliant).toBe(true)
    expect(HOSTING_SCENARIOS["india-neocloud"].residencyCompliant).toBe(true)
    expect(HOSTING_SCENARIOS["india-reserved"].residencyCompliant).toBe(true)
  })

  it("marks every global scenario as not residency-compliant", () => {
    expect(HOSTING_SCENARIOS["global-ondemand"].residencyCompliant).toBe(false)
    expect(HOSTING_SCENARIOS["global-spot"].residencyCompliant).toBe(false)
  })
})

describe("TIER_GPU_COUNT", () => {
  it("gives the executor 1 GPU and every other tier 8 (estimate)", () => {
    expect(TIER_GPU_COUNT.executor).toBe(1)
    expect(TIER_GPU_COUNT.conductor).toBe(8)
    expect(TIER_GPU_COUNT.reasoner).toBe(8)
    expect(TIER_GPU_COUNT.oracle).toBe(8)
  })
})

