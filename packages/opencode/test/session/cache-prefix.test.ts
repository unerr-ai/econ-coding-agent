import { describe, expect } from "bun:test"
import crypto from "node:crypto"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SystemPrompt } from "@/session/system"
import { SessionTools } from "@/session/tools"
import { ToolRegistry } from "@/tool/registry"
import type { Provider } from "@/provider/provider"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

// AC-7.2/AC-8.3 — cache-stable prefix ordering + golden-hash CI guard. This test pins
// the byte shape of the LLM request prefix (system prompt + tool list) that providers
// cache, so an accidental change to its wording, block order, or tool-set ordering
// shows up as a failing test instead of silently busting everyone's cache hit-rate.

function createModel(): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: { context: 100_000, output: 32_000 },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { id: "test-model", npm: "@ai-sdk/anthropic" },
    options: {},
  } as Provider.Model
}

const root = LayerNode.group([SystemPrompt.node, ToolRegistry.node, Agent.node])
const replacements = [
  LayerNode.replace(Config.node, TestConfig.layer()),
  LayerNode.replace(RuntimeFlags.node, RuntimeFlags.layer()),
]

const it = testEffect(LayerNode.buildLayer(root, { replacements }))

// The `Working directory` / `Workspace root folder` / `Platform` lines are per-machine
// and per-test-instance (tmpdir path, host OS) — hashing them raw would make the
// committed golden constant unreproducible across dev machines and CI runners. Same
// treatment as the documented `Today's date` line in system.ts: normalized to a fixed
// placeholder before hashing, and (for the date) asserted separately against its shape.
// Everything else — prompt wording, block order, the tool-usage section, tool-id
// ordering — is hashed byte-for-byte, which is what actually catches prefix drift.
function normalizeVolatileLines(text: string): { normalized: string; dateLine?: string } {
  let dateLine: string | undefined
  const lines = text.split("\n").flatMap((line) => {
    if (line.startsWith("  Today's date: ")) {
      dateLine = line
      return []
    }
    if (line.startsWith("  Working directory: ")) return ["  Working directory: <DIRECTORY>"]
    if (line.startsWith("  Workspace root folder: ")) return ["  Workspace root folder: <DIRECTORY>"]
    if (line.startsWith("  Platform: ")) return ["  Platform: <PLATFORM>"]
    return [line]
  })
  return { normalized: lines.join("\n"), dateLine }
}

const DATE_LINE_SHAPE = /^ {2}Today's date: [A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} \d{4}$/

const getBuildAgent = Effect.gen(function* () {
  const agent = yield* Agent.Service
  const build = yield* agent.get("build")
  if (!build) throw new Error("build agent not found")
  return build
})

// Mirrors how session/prompt.ts assembles the cached prefix: SystemPrompt.select()
// (provider/tier base prompt) + SystemPrompt.Service.environment() (the <env> block),
// with skills appended when present — instructions/history are turn content, not part
// of the stable cached prefix, so they're intentionally left out here.
const buildPrefix = Effect.fn("test.buildPrefix")(function* (model: Provider.Model) {
  const sys = yield* SystemPrompt.Service
  const agentInfo = yield* getBuildAgent
  const base = SystemPrompt.select(model, agentInfo)
  const env = (yield* sys.environment(model)).filter((block): block is string => block !== undefined)
  const skills = yield* sys.skills(agentInfo)
  return [...base, ...env, ...(skills ? [skills] : [])].join("\n\n")
})

// Regenerate intentionally when the system prompt changes; an unintended change here
// means a cache-busting prefix drift.
const GOLDEN_PREFIX_HASH = "5f8351c2e3bc8bea5c93708eb8d30d5aec2f627dc6b6e553b3fdb0733c678426"

describe("session.cache-prefix", () => {
  it.instance("system-prompt prefix is byte-identical across turns in the same session", () =>
    Effect.gen(function* () {
      const model = createModel()
      const first = yield* buildPrefix(model)
      const second = yield* buildPrefix(model)

      const normalizedFirst = normalizeVolatileLines(first)
      const normalizedSecond = normalizeVolatileLines(second)

      expect(normalizedFirst.normalized).toBe(normalizedSecond.normalized)
      expect(normalizedFirst.dateLine).toBeDefined()
      expect(normalizedFirst.dateLine).toMatch(DATE_LINE_SHAPE)
    }),
  )

  it.instance("system-prompt prefix golden-hashes to a committed constant", () =>
    Effect.gen(function* () {
      const model = createModel()
      const prefix = yield* buildPrefix(model)
      const { normalized } = normalizeVolatileLines(prefix)
      const hash = crypto.createHash("sha256").update(normalized).digest("hex")
      expect(hash).toBe(GOLDEN_PREFIX_HASH)
    }),
  )

  it.instance("tool ordering is stable and sorted by id for a fixed enabled-tool set", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const build = yield* getBuildAgent
      const input = {
        providerID: ProviderV2.ID.make("test"),
        modelID: ModelV2.ID.make("test-model"),
        agent: build,
      }

      const firstList = yield* registry.tools(input)
      const secondList = yield* registry.tools(input)
      expect(firstList.map((tool) => tool.id)).toEqual(secondList.map((tool) => tool.id))

      const asRecord = (list: typeof firstList) => {
        const record: Record<string, (typeof list)[number]> = {}
        for (const tool of list) record[tool.id] = tool
        return record
      }
      const orderedFirst = Object.keys(SessionTools.orderToolsForCache(asRecord(firstList)))
      const orderedSecond = Object.keys(SessionTools.orderToolsForCache(asRecord(secondList)))

      expect(orderedFirst).toEqual(orderedSecond)
      expect(orderedFirst).toEqual([...orderedFirst].sort())
    }),
  )
})
