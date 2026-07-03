/**
 * model-registry.ts unit tests — guards ECON_MODELS / ECON_TIER_BINDING against
 * drift from opencode.json (the operative runtime config) and region.ts
 * (DEFAULT_REGION_CONFIG), plus exercises the lookup API surface.
 */

import { describe, it, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  ECON_MODELS,
  ECON_TIER_BINDING,
  modelProfile,
  tierProfile,
  tierModelRef,
  supportsReasoning,
  tiersForModel,
} from "../src/model-registry.ts"
import { DEFAULT_REGION_CONFIG } from "../src/region.ts"
import type { EconTier } from "../src/region.ts"

// Repo root is three levels up from packages/code-intelligence/test/.
const OPENCODE_JSON_PATH = join(import.meta.dir, "..", "..", "..", "opencode.json")

function loadOpencodeJson(): any {
  const raw = readFileSync(OPENCODE_JSON_PATH, "utf-8")
  // Strip `//`-to-end-of-line comments (JSONC). Naive but sufficient for this
  // file: none of its string values contain "//".
  const stripped = raw.replace(/\/\/.*$/gm, "")
  return JSON.parse(stripped)
}

describe("ECON_MODELS vs opencode.json (drift guard)", () => {
  const config = loadOpencodeJson()
  const models = config.provider.openrouter.models

  for (const [key, profile] of Object.entries(ECON_MODELS)) {
    it(`${key} capability fields match opencode.json`, () => {
      const entry = models[profile.modelID]
      expect(entry).toBeDefined()
      expect(profile.contextWindow).toBe(entry.limit.context)
      expect(profile.maxOutput).toBe(entry.limit.output)
      expect(profile.reasoning).toBe(entry.reasoning === true)
    })
  }
})

describe("ECON_TIER_BINDING vs DEFAULT_REGION_CONFIG", () => {
  for (const tier of Object.keys(ECON_TIER_BINDING) as EconTier[]) {
    it(`${tier} binding matches region.ts`, () => {
      expect(ECON_TIER_BINDING[tier]).toBe(DEFAULT_REGION_CONFIG.tiers[tier][0]!.model)
    })
  }
})

describe("referential integrity", () => {
  for (const tier of Object.keys(ECON_TIER_BINDING) as EconTier[]) {
    it(`${tier} binding resolves to a manifest entry with defined cost`, () => {
      const key = ECON_TIER_BINDING[tier]
      expect(ECON_MODELS[key]).toBeDefined()
      expect(ECON_MODELS[key]!.cost).toBeDefined()
    })
  }
})

describe("API", () => {
  it("tierProfile resolves the conductor model", () => {
    expect(tierProfile("conductor").modelID).toBe("deepseek/deepseek-v4-flash")
  })

  it("supportsReasoning is false for conductor", () => {
    expect(supportsReasoning("conductor")).toBe(false)
  })

  it("supportsReasoning is true for executor, reasoner, oracle", () => {
    expect(supportsReasoning("executor")).toBe(true)
    expect(supportsReasoning("reasoner")).toBe(true)
    expect(supportsReasoning("oracle")).toBe(true)
  })

  it("tiersForModel finds both reasoner and oracle for glm-5.2", () => {
    const tiers = tiersForModel("z-ai/glm-5.2")
    expect(tiers).toContain("reasoner")
    expect(tiers).toContain("oracle")
  })

  it("tierModelRef builds the provider/model reference for oracle", () => {
    expect(tierModelRef("oracle")).toBe("openrouter/z-ai/glm-5.2")
  })

  it("modelProfile returns undefined for an unknown key", () => {
    expect(modelProfile("nonexistent")).toBeUndefined()
  })
})
