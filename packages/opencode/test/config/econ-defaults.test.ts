/**
 * econ-defaults.ts drift guard (FIX-10) — locks the in-code base config layer against the operative
 * opencode.json and the code-intelligence registry, so the embedded defaults that make econ work
 * from any working directory can never silently diverge from the one source of truth. Complements
 * packages/code-intelligence/test/model-registry.test.ts (which ties opencode.json ↔ registry): this
 * ties econDefaultConfig() ↔ opencode.json.
 */

import { describe, it, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { econDefaultConfig } from "../../src/config/econ-defaults"
import { ConfigParse } from "../../src/config/parse"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ECON_MODELS, ECON_PERSONAS, tierModelRef } from "../../../code-intelligence/src/model-registry"
import { ECON_COST_MATRIX } from "../../../code-intelligence/src/econ-cost"

// Repo root is four levels up from packages/opencode/test/config/.
const OPENCODE_JSON_PATH = join(import.meta.dir, "..", "..", "..", "..", "opencode.json")

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

// opencode.json refs are "<providerID>/<ECON_MODELS key>" (the key itself contains a slash), so
// strip only the leading provider segment.
const toModelKey = (ref: string): string => {
  const i = ref.indexOf("/")
  return i === -1 ? ref : ref.slice(i + 1)
}
const isEconModel = (ref: string): boolean => ECON_MODELS[toModelKey(ref)] !== undefined

// OL-9.6i: opencode.json deliberately omits `cost` per litellm model (single literal source is
// ECON_COST_MATRIX, econ-cost.ts) — strips it from both sides before the byte-identical mirror
// comparison below so the two stay comparable regardless of which side does or doesn't carry it.
const stripCost = (models: Record<string, any>): Record<string, any> =>
  Object.fromEntries(
    Object.entries(models).map(([key, model]) => {
      const { cost, ...rest } = model
      return [key, rest]
    }),
  )

describe("econDefaultConfig — every model reference is a tool-capable econ model", () => {
  const defaults = econDefaultConfig()

  it("top-level `model` and `small_model` resolve to an econ model", () => {
    expect(isEconModel(defaults.model!)).toBe(true)
    expect(isEconModel(defaults.small_model!)).toBe(true)
  })

  it("every enabled tier agent pins an econ model", () => {
    for (const [name, agent] of Object.entries<any>(defaults.agent!)) {
      if (agent?.disable === true) continue
      expect(typeof agent.model, `agent "${name}" must pin a model`).toBe("string")
      expect(isEconModel(agent.model), `agent "${name}" model "${agent.model}" must be an econ model`).toBe(true)
    }
  })

  it("every provider model key is an econ model", () => {
    for (const key of Object.keys(defaults.provider!.litellm.models!)) {
      expect(ECON_MODELS[key], `provider model "${key}" must be in ECON_MODELS`).toBeDefined()
    }
  })
})

describe("econDefaultConfig vs opencode.json (drift guard — one source of truth)", () => {
  const config = loadOpencodeJson()
  const defaults = econDefaultConfig()

  it("top-level pins match opencode.json", () => {
    expect(defaults.model).toBe(config.model)
    expect(defaults.small_model).toBe(config.small_model)
    expect(defaults.default_agent).toBe(config.default_agent)
  })

  // The embedded default must carry the SAME permission floor as opencode.json, or a headless
  // `opencode run` OUTSIDE the econ repo (arena, a user's repo) silently loses bash/edit/web —
  // matched no rule → evaluate() default `ask` → the headless backstop denies it. This ties them.
  it("root permission floor is byte-identical to opencode.json (bash danger floor + edit/web capability)", () => {
    expect(defaults.permission).toEqual(config.permission)
  })

  it("each tier agent model pin matches opencode.json", () => {
    for (const name of ["conductor", "oracle", "reasoner", "executor"]) {
      expect((defaults.agent as any)[name].model).toBe(config.agent[name].model)
    }
  })

  it("provider.litellm.models is byte-identical to opencode.json (names, limits, reasoning, options; cost excluded — see below)", () => {
    expect(stripCost(defaults.provider!.litellm.models as Record<string, any>)).toEqual(
      stripCost(config.provider.litellm.models),
    )
  })

  // OL-9.6i: opencode.json deliberately carries no `cost` key (single literal source is
  // econ-cost.ts) — the byte-identical mirror above excludes cost for that reason, so this test is
  // the sole proof that econDefaultConfig()'s derived `cost` block matches the authoritative
  // Fireworks serverless rate card in ECON_COST_MATRIX (econ-cost.ts). The shape must be
  // ConfigV1's FLAT cost keys (cache_read/cache_write), which provider.ts maps to the nested
  // Model.cost.cache at load. cache_write is asserted as 0 (Fireworks bills no separate
  // cache-write price), NOT ECON_COST_MATRIX's cacheWrite field (a BYOK-path accounting stand-in).
  it("each provider model's cost matches ECON_COST_MATRIX in ConfigV1's flat shape (cache_write pinned to 0 per the serverless rate card)", () => {
    // gap-closure-plan §4.4: ECON_COST_MATRIX also carries the direct-to-Anthropic frontier-patch
    // oracle profile (claude-opus-4-8, providerID "anthropic"), which econDefaultConfig() does not
    // mirror into provider.litellm.models by design — scope this loop to litellm-provider keys.
    for (const [key, rate] of Object.entries(ECON_COST_MATRIX)) {
      if (ECON_MODELS[key]?.providerID !== "litellm") continue
      const entry = (defaults.provider!.litellm.models as any)[key]
      expect(entry, `provider model "${key}" must be declared`).toBeDefined()
      expect(entry.cost).toEqual({
        input: rate.input,
        output: rate.output,
        cache_read: rate.cachedInput,
        cache_write: 0,
      })
    }
  })

  // #51 regression (2026-07-06): the cost block rides the CONFIG layer, which loadConfig
  // schema-normalizes via ConfigParse.schema(ConfigV1.Info, …). The original provider-shaped
  // nested `cache:{read,write}` block passed the type-check but was silently STRIPPED by that
  // decode, so the server DB-priced every cached token at $0 (run-20/21: 2.33x receipt-vs-DB
  // drift on the conductor — the only tier with cache hits). Push econDefaultConfig() through
  // the exact same decode and assert the cache rates survive it.
  it("cost cache rates survive the ConfigV1 schema decode loadConfig applies (the #51 stripping regression)", () => {
    const decoded = ConfigParse.schema(
      ConfigV1.Info,
      JSON.parse(JSON.stringify(econDefaultConfig())),
      "econ-defaults.test",
    ) as any
    // gap-closure-plan §4.4: scope to litellm-provider keys for the same reason as above — the
    // frontier-patch oracle profile isn't part of this config layer's litellm provider block.
    for (const [key, rate] of Object.entries(ECON_COST_MATRIX)) {
      if (ECON_MODELS[key]?.providerID !== "litellm") continue
      const cost = decoded.provider?.litellm?.models?.[key]?.cost
      expect(cost, `decoded provider model "${key}" must keep its cost block`).toBeDefined()
      expect(cost.cache_read, `decoded "${key}" cache_read must survive the schema pass`).toBe(rate.cachedInput)
      expect(cost.cache_write).toBe(0)
      expect(cost.input).toBe(rate.input)
      expect(cost.output).toBe(rate.output)
    }
  })

  it("native model-less primary agents (build/plan) are disabled", () => {
    expect((defaults.agent as any).build.disable).toBe(true)
    expect((defaults.agent as any).plan.disable).toBe(true)
  })

  it("every persona is present and its model pin matches opencode.json", () => {
    for (const persona of ECON_PERSONAS) {
      expect((defaults.agent as any)[persona], `persona "${persona}" must be declared`).toBeDefined()
      expect((defaults.agent as any)[persona].model).toBe(config.agent[persona].model)
    }
  })

  it("every persona description matches opencode.json", () => {
    for (const persona of ECON_PERSONAS) {
      expect((defaults.agent as any)[persona].description).toBe(config.agent[persona].description)
    }
  })

  it("every persona permission ruleset matches opencode.json", () => {
    for (const persona of ECON_PERSONAS) {
      expect((defaults.agent as any)[persona].permission).toEqual(config.agent[persona].permission)
    }
  })

  it("every persona tools record matches opencode.json (OL-9.4a physical toolset)", () => {
    for (const persona of ECON_PERSONAS) {
      expect((defaults.agent as any)[persona].tools).toEqual(config.agent[persona].tools)
    }
  })

  it("the executor tier agent tools record matches opencode.json (OL-9.5e todowrite trim)", () => {
    expect((defaults.agent as any).executor.tools).toEqual(config.agent.executor.tools)
  })
})

describe("econ persona agents (OL-9.1c/9.3d)", () => {
  const defaults = econDefaultConfig()

  it("all six personas are bound to the executor tier model", () => {
    for (const persona of ECON_PERSONAS) {
      expect((defaults.agent as any)[persona].model).toBe(tierModelRef("executor"))
    }
  })

  it("no persona (and not the executor agent) carries task or question", () => {
    for (const name of [...ECON_PERSONAS, "executor"]) {
      const permission = (defaults.agent as any)[name].permission ?? {}
      expect(permission.task, `${name} must not carry task`).toBe("deny")
      expect(permission.question, `${name} must not carry question`).toBe("deny")
    }
  })

  it("every persona is a hidden subagent", () => {
    for (const persona of ECON_PERSONAS) {
      expect((defaults.agent as any)[persona].mode).toBe("subagent")
      expect((defaults.agent as any)[persona].hidden).toBe(true)
    }
  })

  it("every persona's tools record also drops task and question (OL-9.4a belt over the permission suspenders)", () => {
    for (const persona of ECON_PERSONAS) {
      const tools = (defaults.agent as any)[persona].tools ?? {}
      expect(tools.task, `${persona} tools must drop task`).toBe(false)
      expect(tools.question, `${persona} tools must drop question`).toBe(false)
    }
  })

  it("every persona (and the executor tier agent) drops todowrite from its physical toolset (OL-9.5e)", () => {
    for (const name of [...ECON_PERSONAS, "executor"]) {
      const tools = (defaults.agent as any)[name].tools ?? {}
      expect(tools.todowrite, `${name} tools must drop todowrite`).toBe(false)
    }
  })

  it("every persona's tools record is exactly {task:false, question:false, todowrite:false} — no persona drops edit/bash/web", () => {
    for (const persona of ECON_PERSONAS) {
      expect((defaults.agent as any)[persona].tools).toEqual({ task: false, question: false, todowrite: false })
    }
  })

  it("every persona's permission record is exactly {task:deny, question:deny} — no persona-specific edit/bash/web overrides", () => {
    for (const persona of ECON_PERSONAS) {
      expect((defaults.agent as any)[persona].permission).toEqual({ task: "deny", question: "deny" })
    }
  })
})

// Websearch-wiring lock (2026-07-16): the tool went default-advertised elsewhere (registry.ts /
// websearch.ts / runtime-flags), so this guards the other half — that every econ seat can actually
// invoke it once advertised. Ties the permission floor + every tier agent + every persona
// (ECON_PERSONAS-derived, never a hardcoded name list) to allow, mirroring the existing webfetch
// coverage above so a future persona/tier addition can't silently narrow websearch off.
describe("websearch reaches every seat (4 tiers + 6 personas)", () => {
  const defaults = econDefaultConfig()

  it("the permission floor carries both websearch and webfetch as allow", () => {
    expect(defaults.permission!.websearch).toBe("allow")
    expect(defaults.permission!.webfetch).toBe("allow")
  })

  it("no tier agent narrows websearch off its physical toolset or permission", () => {
    for (const [name, agent] of Object.entries<any>(defaults.agent!)) {
      if (agent?.disable === true) continue
      expect(agent.tools?.websearch, `agent "${name}" tools must not set websearch:false`).not.toBe(false)
      const perm = agent.permission?.websearch
      expect(perm === undefined || perm === "allow", `agent "${name}" permission.websearch must not deny/ask (got "${perm}")`).toBe(true)
    }
  })

  it("no persona narrows websearch off its physical toolset or permission (ECON_PERSONAS-derived)", () => {
    for (const persona of ECON_PERSONAS) {
      const agent = (defaults.agent as any)[persona]
      expect(agent.tools?.websearch, `persona "${persona}" tools must not set websearch:false`).not.toBe(false)
      const perm = agent.permission?.websearch
      expect(perm === undefined || perm === "allow", `persona "${persona}" permission.websearch must not deny/ask (got "${perm}")`).toBe(true)
    }
  })
})
