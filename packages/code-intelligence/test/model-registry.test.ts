/**
 * model-registry.ts unit tests — guards ECON_MODELS / ECON_TIER_BINDING against
 * drift from opencode.json (the operative runtime config), region.ts
 * (DEFAULT_REGION_CONFIG), and infra/litellm/config.yaml (the gateway's model
 * catalog), plus exercises the lookup API surface.
 */

import { describe, it, expect } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  ECON_MODELS,
  ECON_TIER_BINDING,
  modelProfile,
  tierProfile,
  tierModelRef,
  supportsReasoning,
  tiersForModel,
  resolveVerifierTier,
  resolveJudgeTier,
  resolveFrontierHatch,
  resolveTierModelRef,
  sessionAffinityFor,
} from "../src/model-registry.ts"
import { DEFAULT_REGION_CONFIG } from "../src/region.ts"
import type { EconTier } from "../src/region.ts"
import { ECON_COST_MATRIX } from "../src/econ-cost.ts"

// Repo root is three levels up from packages/code-intelligence/test/.
const OPENCODE_JSON_PATH = join(import.meta.dir, "..", "..", "..", "opencode.json")

function loadOpencodeJson(): any {
  const raw = readFileSync(OPENCODE_JSON_PATH, "utf-8")
  // Strip `//`-to-end-of-line comments (JSONC), string-aware: a naive regex would
  // truncate string values containing "//" (e.g. the litellm baseURL "https://…").
  let stripped = ""
  let inString = false
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!
    if (inString) {
      stripped += c
      if (c === "\\") stripped += raw[++i] ?? ""
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      stripped += c
      continue
    }
    if (c === "/" && raw[i + 1] === "/") {
      while (i < raw.length && raw[i] !== "\n") i++
      stripped += "\n"
      continue
    }
    stripped += c
  }
  return JSON.parse(stripped)
}

describe("ECON_MODELS vs opencode.json (drift guard)", () => {
  const config = loadOpencodeJson()
  const models = config.provider.litellm.models

  for (const [key, profile] of Object.entries(ECON_MODELS)) {
    it(`${key} capability fields match opencode.json`, () => {
      const entry = models[profile.modelID]
      expect(entry).toBeDefined()
      expect(profile.contextWindow).toBe(entry.limit.context)
      expect(profile.maxOutput).toBe(entry.limit.output)
      expect(profile.reasoning).toBe(entry.reasoning === true)
    })

    // OL-9.6i: opencode.json intentionally carries NO `cost` key for a litellm model — cost has a
    // single literal source (ECON_COST_MATRIX, econ-cost.ts) and reaches the effective config via
    // econ-defaults.ts's derived `cost` block, deep-merged on top of the project config at runtime
    // (config.ts's econ-defaults merge layer + provider.ts's per-field cost fallback). This guards
    // against the four hardcoded `cost` blocks (OL-9.6h) creeping back into opencode.json.
    it(`${key} carries no cost key in opencode.json (single literal source is econ-cost.ts)`, () => {
      const entry = models[profile.modelID]
      expect(entry.cost).toBeUndefined()
    })

    // opencode.json has no field to drift against for these two — they're gateway
    // routing/accounting behaviors probed live (W8), not static capabilities the
    // runtime config declares — so this just guards the manifest shape.
    it(`${key} declares cacheAccounting and sessionAffinity`, () => {
      expect(["stream", "nonstream-only", "none"]).toContain(profile.cacheAccounting)
      expect(typeof profile.sessionAffinity).toBe("boolean")
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

describe("infra/litellm/config.yaml vs ECON_MODELS (drift guard — OL-8.B2)", () => {
  // 2026-07-19: the gateway infra (incl. config.yaml) moved out of this repo into the sibling
  // unerr-benchmarks checkout. Repo root is three levels up from packages/code-intelligence/test/
  // (same as OPENCODE_JSON_PATH above); one more level up + across into the sibling repo's
  // infra/litellm/. Dependency-free line parse (no yaml lib in this package) is sufficient:
  // config.yaml's `model_name:` and `litellm_params.model:` values never span multiple lines.
  const LITELLM_CONFIG_PATH = join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "..",
    "unerr-benchmarks",
    "infra",
    "litellm",
    "config.yaml",
  )

  if (!existsSync(LITELLM_CONFIG_PATH)) {
    it.skip(
      "gateway config lives in sibling repo unerr-benchmarks — checkout missing, drift guard skipped",
      () => {},
    )
    return
  }

  const configText = readFileSync(LITELLM_CONFIG_PATH, "utf-8")
  const modelNames = [...configText.matchAll(/^\s*-\s*model_name:\s*(\S+)\s*$/gm)].map((m) => m[1]!)
  const upstreamModels = [...configText.matchAll(/^\s*model:\s*(\S+)\s*$/gm)].map((m) => m[1]!)

  it("gateway model_name set matches ECON_MODELS keys exactly (catches a gateway-side rename/addition)", () => {
    expect(new Set(modelNames)).toEqual(new Set(Object.keys(ECON_MODELS)))
  })

  for (const model of upstreamModels) {
    it(`litellm_params.model "${model}" is pinned to a fireworks_ai upstream (dumb-pipe invariant)`, () => {
      expect(model.startsWith("fireworks_ai/")).toBe(true)
    })
  }

  // 2026-07-06: the gateway carries per-token rates so litellm's response-cost /
  // key-spend apply the cached-token discount (the default fireworks_ai cost map
  // has no cache-read rate → discount was always 0.0). Those rates must mirror
  // ECON_COST_MATRIX exactly (USD per 1M ÷ 1e6) — one source of truth, enforced
  // here. Block parse: split on model_name entries, read the three cost keys.
  const blocks = configText.split(/^\s*-\s*model_name:\s*/m).slice(1)
  const rateOf = (block: string, key: string): number | undefined => {
    const m = block.match(new RegExp(`^\\s*${key}:\\s*([\\d.eE+-]+)\\s*$`, "m"))
    return m ? Number(m[1]) : undefined
  }
  for (const block of blocks) {
    const name = block.split(/\s/)[0]!
    it(`gateway rates for "${name}" mirror ECON_COST_MATRIX`, () => {
      const rate = ECON_COST_MATRIX[name]
      expect(rate).toBeDefined()
      expect(rateOf(block, "input_cost_per_token")).toBeCloseTo(rate!.input / 1e6, 12)
      expect(rateOf(block, "output_cost_per_token")).toBeCloseTo(rate!.output / 1e6, 12)
      expect(rateOf(block, "cache_read_input_token_cost")).toBeCloseTo(rate!.cachedInput / 1e6, 12)
    })
  }
})

describe("API", () => {
  it("tierProfile resolves the conductor model", () => {
    expect(tierProfile("conductor").modelID).toBe("minimax/minimax-m3")
  })

  it("supportsReasoning is false for conductor", () => {
    expect(supportsReasoning("conductor")).toBe(false)
  })

  it("supportsReasoning is true for executor, reasoner, oracle", () => {
    expect(supportsReasoning("executor")).toBe(true)
    expect(supportsReasoning("reasoner")).toBe(true)
    expect(supportsReasoning("oracle")).toBe(true)
  })

  it("tiersForModel finds only oracle for glm-5.2 (OL-8.B4+: no longer shared with reasoner)", () => {
    const tiers = tiersForModel("z-ai/glm-5.2")
    expect(tiers).toContain("oracle")
    expect(tiers).not.toContain("reasoner")
  })

  it("tierModelRef builds the provider/model reference for oracle", () => {
    expect(tierModelRef("oracle")).toBe("litellm/z-ai/glm-5.2")
  })

  it("modelProfile returns undefined for an unknown key", () => {
    expect(modelProfile("nonexistent")).toBeUndefined()
  })
})

describe("OL-7.8a / OL-7.10 — flag-off byte-identical (registry snapshot equality)", () => {
  it("ECON_TIER_BINDING is unchanged by the optional verifier/frontier additions", () => {
    expect(ECON_TIER_BINDING).toEqual({
      conductor: "minimax/minimax-m3",
      executor: "openai/gpt-oss-120b",
      reasoner: "deepseek/deepseek-v4-pro",
      oracle: "z-ai/glm-5.2",
    })
  })

  it("tierModelRef resolution for every live tier is unaffected", () => {
    for (const tier of Object.keys(ECON_TIER_BINDING) as EconTier[]) {
      expect(resolveTierModelRef(tier, resolveFrontierHatch(undefined))).toBe(tierModelRef(tier))
      expect(resolveTierModelRef(tier, resolveFrontierHatch("off"))).toBe(tierModelRef(tier))
    }
  })
})

describe("FIX-8 — model-selection surface guard (no unpinned catalog-top leak)", () => {
  // Root cause of the gemini-3-pro-image-preview routing bug: OpenCode's
  // provider.defaultModel() (provider.ts) falls back to the models.dev OpenRouter
  // catalog TOP — an image model — for any turn that resolves a model-less agent
  // when no top-level `model` is pinned. A tool-using turn then dies with
  // "No endpoints found that support tool use". The fix is config-level: pin the
  // whole model-selection surface to econ tier models so nothing ever reaches the
  // catalog fallback. This guard locks that surface — the drift tests above only
  // cover the tier bindings, not the top-level pins that actually block the leak.
  const config = loadOpencodeJson()
  // opencode.json refs are "<providerID>/<ECON_MODELS key>" (the key itself may
  // contain a slash), so strip only the leading provider segment.
  const toModelKey = (ref: string): string => {
    const i = ref.indexOf("/")
    return i === -1 ? ref : ref.slice(i + 1)
  }
  const isEconModel = (ref: string): boolean => ECON_MODELS[toModelKey(ref)] !== undefined

  it("top-level default `model` is pinned to a tool-capable econ model", () => {
    expect(typeof config.model).toBe("string")
    expect(isEconModel(config.model)).toBe(true)
  })

  it("`small_model` is pinned to an econ model", () => {
    expect(typeof config.small_model).toBe("string")
    expect(isEconModel(config.small_model)).toBe(true)
  })

  it("every configured agent is either disabled or pinned to an econ model (none falls back to the catalog)", () => {
    for (const [name, agent] of Object.entries<any>(config.agent)) {
      if (agent?.disable === true) continue
      expect(typeof agent.model, `agent "${name}" must pin a model`).toBe("string")
      expect(isEconModel(agent.model), `agent "${name}" model "${agent.model}" must be an econ model`).toBe(true)
    }
  })

  it("native model-less primary agents (build/plan) are disabled", () => {
    expect(config.agent.build?.disable).toBe(true)
    expect(config.agent.plan?.disable).toBe(true)
  })
})

describe("cacheAccounting (W8 — client-side cached_tokens mapping fix, 2026-07-06)", () => {
  it("no model is left nonstream-only — the client-side mapping gap that motivated the label is fixed", () => {
    for (const [key, profile] of Object.entries(ECON_MODELS)) {
      expect(profile.cacheAccounting, `${key} should be stream-accounted post-W8`).not.toBe("nonstream-only")
    }
  })
})

describe("sessionAffinityFor (OL-9.2b — W8 registry-driven x-session-affinity)", () => {
  it("conductor is affinity-ON (probe 2026-07-06: proven beneficial)", () => {
    expect(sessionAffinityFor(ECON_TIER_BINDING.conductor)).toBe(true)
  })

  it("reasoner is affinity-OFF (probe 2026-07-06: proven harmful — cache miss + 18.86s spike)", () => {
    expect(sessionAffinityFor(ECON_TIER_BINDING.reasoner)).toBe(false)
  })

  it("oracle and executor default to affinity-ON (untested by the probe, provisional)", () => {
    expect(sessionAffinityFor(ECON_TIER_BINDING.oracle)).toBe(true)
    expect(sessionAffinityFor(ECON_TIER_BINDING.executor)).toBe(true)
  })

  it("defaults to true (the historical always-on-for-litellm behavior) for a model absent from the registry", () => {
    expect(sessionAffinityFor("some/unpinned-model")).toBe(true)
  })
})

describe("resolveVerifierTier (OL-7.8a)", () => {
  it("defaults to disabled when unset", () => {
    expect(resolveVerifierTier(undefined)).toEqual({ enabled: false })
  })

  it("is disabled for the literal 'off'", () => {
    expect(resolveVerifierTier("off")).toEqual({ enabled: false })
  })

  it("is enabled with the endpoint for any other value", () => {
    expect(resolveVerifierTier("https://rm.example.com")).toEqual({
      enabled: true,
      endpoint: "https://rm.example.com",
    })
  })
})

describe("resolveJudgeTier (OL-7.8)", () => {
  it("defaults to enabled on the reasoner when unset (the judge is the untestable-slice safety net)", () => {
    expect(resolveJudgeTier(undefined)).toEqual({ enabled: true, tier: "reasoner" })
  })

  it("is disabled for the literal 'off'", () => {
    expect(resolveJudgeTier("off")).toEqual({ enabled: false, tier: "reasoner" })
  })

  it("a valid tier name overrides the judge tier", () => {
    for (const tier of Object.keys(ECON_TIER_BINDING) as EconTier[]) {
      expect(resolveJudgeTier(tier)).toEqual({ enabled: true, tier })
    }
  })

  it("an unrecognized value falls back to the default rather than disabling the rung", () => {
    expect(resolveJudgeTier("bogus")).toEqual({ enabled: true, tier: "reasoner" })
    expect(resolveJudgeTier("")).toEqual({ enabled: true, tier: "reasoner" })
  })
})

describe("resolveFrontierHatch / resolveTierModelRef (OL-7.10)", () => {
  it("defaults to off when unset", () => {
    expect(resolveFrontierHatch(undefined)).toEqual({ mode: "off" })
  })

  it("fails safe to off for an unrecognized value", () => {
    expect(resolveFrontierHatch("bogus")).toEqual({ mode: "off" })
  })

  it("resolves 'api' and 'human' modes", () => {
    expect(resolveFrontierHatch("api")).toEqual({ mode: "api" })
    expect(resolveFrontierHatch("human")).toEqual({ mode: "human" })
  })

  it("api mode overrides the ref with the injected frontier model id", () => {
    expect(
      resolveTierModelRef("oracle", resolveFrontierHatch("api"), "openrouter/frontier/pinned-later"),
    ).toBe("openrouter/frontier/pinned-later")
  })

  it("api mode with no frontier model id injected returns undefined", () => {
    expect(resolveTierModelRef("oracle", resolveFrontierHatch("api"))).toBeUndefined()
  })

  it("human mode returns undefined regardless of an injected model id", () => {
    expect(
      resolveTierModelRef("oracle", resolveFrontierHatch("human"), "openrouter/frontier/pinned-later"),
    ).toBeUndefined()
  })

  it("off mode is byte-identical to tierModelRef", () => {
    expect(resolveTierModelRef("conductor", resolveFrontierHatch("off"))).toBe(tierModelRef("conductor"))
  })
})
