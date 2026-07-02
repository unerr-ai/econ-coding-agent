/**
 * Unit tests for region.ts: region-routing scaffold (Sprint 8.1).
 * Pure function tests: no I/O, no mocks, no network — all inputs are inline fixtures.
 */

import { describe, it, expect } from "bun:test"
import {
  DEFAULT_RESIDENCY_POLICY,
  DEFAULT_REGION_CONFIG,
  parseRegionConfig,
  resolveTierChain,
  checkResidency,
  selectEndpoint,
  type RegionEndpoint,
  type RegionConfig,
  type ResidencyPolicy,
} from "./region.js"

// ---------------------------------------------------------------------------
// Helpers / fixtures
// ---------------------------------------------------------------------------

const IN_EP: RegionEndpoint = { providerId: "test-in", model: "m-in", region: "in" }
const GLOBAL_EP: RegionEndpoint = { providerId: "test-gl", model: "m-global", region: "global" }

/** Build a minimal RegionConfig for one tier with a custom chain, inheriting all other defaults. */
function withConductorChain(
  chain: RegionEndpoint[],
  overridePolicy?: Partial<ResidencyPolicy>,
): RegionConfig {
  return {
    residency: { ...DEFAULT_RESIDENCY_POLICY, ...overridePolicy },
    tiers: { ...DEFAULT_REGION_CONFIG.tiers, conductor: chain },
  }
}

// ---------------------------------------------------------------------------
// DEFAULT_REGION_CONFIG — correct model ids for all 4 tiers
// ---------------------------------------------------------------------------

describe("DEFAULT_REGION_CONFIG — tier model ids", () => {
  it("conductor has the right global model", () => {
    expect(DEFAULT_REGION_CONFIG.tiers.conductor).toHaveLength(1)
    expect(DEFAULT_REGION_CONFIG.tiers.conductor[0]!.model).toBe("qwen/qwen3.7-plus")
    expect(DEFAULT_REGION_CONFIG.tiers.conductor[0]!.region).toBe("global")
    expect(DEFAULT_REGION_CONFIG.tiers.conductor[0]!.providerId).toBe("openrouter")
  })

  it("oracle has the right global model", () => {
    expect(DEFAULT_REGION_CONFIG.tiers.oracle).toHaveLength(1)
    expect(DEFAULT_REGION_CONFIG.tiers.oracle[0]!.model).toBe("z-ai/glm-5.2")
    expect(DEFAULT_REGION_CONFIG.tiers.oracle[0]!.region).toBe("global")
    expect(DEFAULT_REGION_CONFIG.tiers.oracle[0]!.providerId).toBe("openrouter")
  })

  it("reasoner has the right global model", () => {
    expect(DEFAULT_REGION_CONFIG.tiers.reasoner).toHaveLength(1)
    expect(DEFAULT_REGION_CONFIG.tiers.reasoner[0]!.model).toBe("z-ai/glm-5.2")
    expect(DEFAULT_REGION_CONFIG.tiers.reasoner[0]!.region).toBe("global")
    expect(DEFAULT_REGION_CONFIG.tiers.reasoner[0]!.providerId).toBe("openrouter")
  })

  it("executor has the right global model", () => {
    expect(DEFAULT_REGION_CONFIG.tiers.executor).toHaveLength(1)
    expect(DEFAULT_REGION_CONFIG.tiers.executor[0]!.model).toBe("openai/gpt-oss-20b")
    expect(DEFAULT_REGION_CONFIG.tiers.executor[0]!.region).toBe("global")
    expect(DEFAULT_REGION_CONFIG.tiers.executor[0]!.providerId).toBe("openrouter")
  })

  it("default residency mode is preferred", () => {
    expect(DEFAULT_REGION_CONFIG.residency.mode).toBe("preferred")
  })
})

// ---------------------------------------------------------------------------
// resolveTierChain — ordering
// ---------------------------------------------------------------------------

describe("resolveTierChain — in-region before global", () => {
  it("reorders [global, in] to [in, global] in preferred mode", () => {
    const config = withConductorChain([GLOBAL_EP, IN_EP])
    const chain = resolveTierChain(config, "conductor")
    expect(chain[0]!.region).toBe("in")
    expect(chain[1]!.region).toBe("global")
  })

  it("reorders [global, global, in] to [in, global, global] stably", () => {
    const g1: RegionEndpoint = { providerId: "p", model: "g1", region: "global" }
    const g2: RegionEndpoint = { providerId: "p", model: "g2", region: "global" }
    const config = withConductorChain([g1, g2, IN_EP])
    const chain = resolveTierChain(config, "conductor")
    expect(chain[0]!.region).toBe("in")
    expect(chain[1]!.model).toBe("g1")
    expect(chain[2]!.model).toBe("g2")
  })

  it("preserves original order when mode is off", () => {
    const config = withConductorChain([GLOBAL_EP, IN_EP], { mode: "off" })
    const chain = resolveTierChain(config, "conductor")
    expect(chain[0]!.region).toBe("global")
    expect(chain[1]!.region).toBe("in")
  })

  it("returns a copy — mutations do not affect the config", () => {
    const config = withConductorChain([IN_EP, GLOBAL_EP])
    const chain = resolveTierChain(config, "conductor")
    chain.pop()
    expect(config.tiers.conductor).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// checkResidency
// ---------------------------------------------------------------------------

describe("checkResidency", () => {
  it("returns ok:true when mode is off regardless of region", () => {
    const policy: ResidencyPolicy = { ...DEFAULT_RESIDENCY_POLICY, mode: "off" }
    expect(checkResidency(GLOBAL_EP, policy, "secret").ok).toBe(true)
    expect(checkResidency(IN_EP, policy, "code").ok).toBe(true)
  })

  it("returns ok:true when endpoint.region is in allow list", () => {
    const result = checkResidency(IN_EP, DEFAULT_RESIDENCY_POLICY, "code")
    expect(result.ok).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it("returns ok:false with a reason when endpoint.region is not in allow list", () => {
    const result = checkResidency(GLOBAL_EP, DEFAULT_RESIDENCY_POLICY, "secret")
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("secret")
    expect(result.reason).toContain("global")
  })

  it("allows global for telemetry (the only default exception)", () => {
    expect(checkResidency(GLOBAL_EP, DEFAULT_RESIDENCY_POLICY, "telemetry").ok).toBe(true)
    expect(checkResidency(IN_EP, DEFAULT_RESIDENCY_POLICY, "telemetry").ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// selectEndpoint — strict mode
// ---------------------------------------------------------------------------

describe("selectEndpoint — strict mode", () => {
  it("returns undefined when no endpoint is compliant for secret", () => {
    // Default config has only global endpoints; secret allow=["in"] → none compliant
    const config = withConductorChain([GLOBAL_EP], { mode: "strict" })
    const result = selectEndpoint(config, "conductor", "secret")
    expect(result).toBeUndefined()
  })

  it("skips a non-compliant in-region endpoint and returns the compliant global one", () => {
    // Strict mode with allow[code]=["global"] only — in-region ep is non-compliant
    const strictGlobalOnlyForCode: ResidencyPolicy = {
      mode: "strict",
      allow: {
        code: ["global"],
        prompt: ["in"],
        completion: ["in"],
        secret: ["in"],
        telemetry: ["in", "global"],
      },
    }
    // Chain [GLOBAL_EP, IN_EP] → resolve reorders to [IN_EP, GLOBAL_EP]
    // IN_EP region "in" not in ["global"] → skip; GLOBAL_EP region "global" in ["global"] → return
    const config: RegionConfig = {
      residency: strictGlobalOnlyForCode,
      tiers: { ...DEFAULT_REGION_CONFIG.tiers, conductor: [GLOBAL_EP, IN_EP] },
    }
    const result = selectEndpoint(config, "conductor", "code")
    expect(result).toBe(GLOBAL_EP)
  })

  it("returns the first compliant in-region endpoint when it is present", () => {
    const config: RegionConfig = {
      residency: { ...DEFAULT_RESIDENCY_POLICY, mode: "strict" },
      tiers: { ...DEFAULT_REGION_CONFIG.tiers, conductor: [GLOBAL_EP, IN_EP] },
    }
    // code allow=["in"] → IN_EP passes; resolveTierChain puts IN_EP first
    const result = selectEndpoint(config, "conductor", "code")
    expect(result).toBe(IN_EP)
  })

  it("returns undefined for an empty chain", () => {
    const config = withConductorChain([], { mode: "strict" })
    expect(selectEndpoint(config, "conductor", "code")).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// selectEndpoint — preferred mode
// ---------------------------------------------------------------------------

describe("selectEndpoint — preferred mode", () => {
  it("returns a compliant in-region endpoint when one exists", () => {
    const config: RegionConfig = {
      residency: { ...DEFAULT_RESIDENCY_POLICY, mode: "preferred" },
      tiers: { ...DEFAULT_REGION_CONFIG.tiers, conductor: [GLOBAL_EP, IN_EP] },
    }
    const result = selectEndpoint(config, "conductor", "code")
    expect(result).toBe(IN_EP)
  })

  it("falls back to first endpoint in chain when none are compliant", () => {
    // Chain has only global; secret allow=["in"] → none compliant; preferred falls back
    const config: RegionConfig = {
      residency: { ...DEFAULT_RESIDENCY_POLICY, mode: "preferred" },
      tiers: { ...DEFAULT_REGION_CONFIG.tiers, conductor: [GLOBAL_EP] },
    }
    const result = selectEndpoint(config, "conductor", "secret")
    // resolveTierChain([GLOBAL_EP]) in preferred mode → [GLOBAL_EP]; fallback = GLOBAL_EP
    expect(result).toBe(GLOBAL_EP)
  })

  it("falls back to first in resolved chain order when no compliant and mode is preferred", () => {
    const g1: RegionEndpoint = { providerId: "p", model: "first-global", region: "global" }
    const g2: RegionEndpoint = { providerId: "p", model: "second-global", region: "global" }
    const config: RegionConfig = {
      residency: { ...DEFAULT_RESIDENCY_POLICY, mode: "preferred" },
      tiers: { ...DEFAULT_REGION_CONFIG.tiers, conductor: [g1, g2] },
    }
    // secret allow=["in"]; no in-region eps; fallback = first in resolved chain = g1
    const result = selectEndpoint(config, "conductor", "secret")
    expect(result).toBe(g1)
  })
})

// ---------------------------------------------------------------------------
// selectEndpoint — off mode
// ---------------------------------------------------------------------------

describe("selectEndpoint — off mode", () => {
  it("returns the first endpoint in the original chain order", () => {
    // off mode: resolveTierChain preserves order → GLOBAL_EP is first
    const config = withConductorChain([GLOBAL_EP, IN_EP], { mode: "off" })
    expect(selectEndpoint(config, "conductor", "code")).toBe(GLOBAL_EP)
  })

  it("ignores residency restrictions entirely", () => {
    // Even though secret allow=["in"], off mode returns GLOBAL_EP
    const config = withConductorChain([GLOBAL_EP], { mode: "off" })
    expect(selectEndpoint(config, "conductor", "secret")).toBe(GLOBAL_EP)
  })

  it("returns undefined when chain is empty", () => {
    const config = withConductorChain([], { mode: "off" })
    expect(selectEndpoint(config, "conductor", "code")).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// parseRegionConfig
// ---------------------------------------------------------------------------

describe("parseRegionConfig — garbage input returns default clone", () => {
  it("returns a deep clone of DEFAULT_REGION_CONFIG for null", () => {
    const result = parseRegionConfig(null)
    expect(result.residency.mode).toBe("preferred")
    expect(result.tiers.conductor[0]!.model).toBe("qwen/qwen3.7-plus")
    expect(result).not.toBe(DEFAULT_REGION_CONFIG)
  })

  it("returns defaults for undefined", () => {
    const result = parseRegionConfig(undefined)
    expect(result.residency.mode).toBe("preferred")
    expect(result.tiers.oracle[0]!.model).toBe("z-ai/glm-5.2")
  })

  it("returns defaults for a number", () => {
    const result = parseRegionConfig(42)
    expect(result.tiers.executor[0]!.model).toBe("openai/gpt-oss-20b")
  })

  it("returns defaults for a string", () => {
    const result = parseRegionConfig("bad")
    expect(result.tiers.reasoner[0]!.model).toBe("z-ai/glm-5.2")
  })

  it("returns defaults for an array", () => {
    const result = parseRegionConfig([{ tiers: {} }])
    expect(result.residency.mode).toBe("preferred")
  })
})

describe("parseRegionConfig — partial overlays", () => {
  it("overlays tiers for a specific tier without affecting others", () => {
    const customEp: RegionEndpoint = { providerId: "custom", model: "custom-m", region: "in" }
    const result = parseRegionConfig({ tiers: { conductor: [customEp] } })
    expect(result.tiers.conductor[0]).toEqual(customEp)
    // Other tiers remain default
    expect(result.tiers.oracle[0]!.model).toBe("z-ai/glm-5.2")
    expect(result.tiers.reasoner[0]!.model).toBe("z-ai/glm-5.2")
    expect(result.tiers.executor[0]!.model).toBe("openai/gpt-oss-20b")
  })

  it("overlays residency.mode without changing allow lists", () => {
    const result = parseRegionConfig({ residency: { mode: "strict" } })
    expect(result.residency.mode).toBe("strict")
    expect(result.residency.allow.code).toEqual(["in"])
    expect(result.residency.allow.telemetry).toEqual(["in", "global"])
  })

  it("overlays residency.allow for a specific data class", () => {
    const result = parseRegionConfig({
      residency: { allow: { code: ["in", "global"] } },
    })
    expect(result.residency.allow.code).toEqual(["in", "global"])
    // Others unchanged
    expect(result.residency.allow.secret).toEqual(["in"])
    expect(result.residency.mode).toBe("preferred")
  })

  it("ignores non-array tier values", () => {
    const result = parseRegionConfig({ tiers: { conductor: "not-an-array" } })
    // Falls back to default chain for conductor
    expect(result.tiers.conductor[0]!.model).toBe("qwen/qwen3.7-plus")
  })

  it("does not mutate DEFAULT_REGION_CONFIG when overlaying", () => {
    const customEp: RegionEndpoint = { providerId: "custom", model: "c", region: "in" }
    parseRegionConfig({ tiers: { conductor: [customEp] } })
    // DEFAULT_REGION_CONFIG must be unchanged
    expect(DEFAULT_REGION_CONFIG.tiers.conductor[0]!.model).toBe("qwen/qwen3.7-plus")
    expect(DEFAULT_REGION_CONFIG.tiers.conductor).toHaveLength(1)
  })

  it("does not mutate DEFAULT_RESIDENCY_POLICY when overlaying residency", () => {
    parseRegionConfig({ residency: { mode: "strict", allow: { code: ["global"] } } })
    expect(DEFAULT_RESIDENCY_POLICY.mode).toBe("preferred")
    expect(DEFAULT_RESIDENCY_POLICY.allow.code).toEqual(["in"])
  })

  it("ignores invalid region values in allow list", () => {
    // "invalid" is not a Region; should fall back to default for that data class
    const result = parseRegionConfig({ residency: { allow: { code: ["invalid"] } } })
    // filtered regions = []; fall back to default
    expect(result.residency.allow.code).toEqual(["in"])
  })
})
