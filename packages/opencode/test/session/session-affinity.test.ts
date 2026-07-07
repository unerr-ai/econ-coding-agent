/**
 * OL-9.2b — litellm gateway cache-affinity header
 *
 * The litellm gateway's upstream honors `x-session-affinity` for prompt-cache
 * routing: pinning a session's successive calls to one replica. W8 (2026-07-06)
 * proved this is not universally beneficial — a live probe found it helps the
 * conductor but actively breaks the reasoner's cache + latency — so the header
 * is now registry-driven per model (model-registry.ts's `sessionAffinity`)
 * rather than sent unconditionally for the litellm provider. Verifies the
 * header carries the opencode session id when the current model's registry
 * entry allows it, is withheld when the registry says no, defaults on for a
 * model absent from the registry, and is absent for other providers — openai's
 * ws-pool (plugin/openai/ws-pool.ts) keys off the same header name for an
 * unrelated purpose, so this must stay scoped to litellm only.
 *
 * No live model call is made — we inspect the Prepared payload directly.
 * Model ids are read from ECON_TIER_BINDING (never hard-coded).
 */
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { ModelMessage } from "ai"
import { LLMRequestPrep } from "@/session/llm/request"
import { ECON_TIER_BINDING } from "@opencode-ai/code-intelligence"

const sessionID = "test-session-affinity"

function mockModel(providerID: string, npm: string, modelID: string) {
  return {
    id: modelID,
    providerID,
    api: {
      id: modelID,
      url: "https://example.test",
      npm,
    },
    name: "Test Model",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0 },
    limit: { context: 128_000, output: 4_096 },
    status: "active",
    options: {},
    headers: {},
  } as any
}

const mockAgent = {
  name: "test-agent",
  mode: "primary",
  options: {},
  permission: [],
} as any

function mockUser(providerID: string, modelID: string) {
  return {
    id: "msg_user-affinity-test",
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "test-agent",
    model: { providerID, modelID, variant: undefined },
  } as any
}

const mockFlags = { outputTokenMax: 32_000, client: "test" } as any

const mockPlugin = {
  trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output),
  list: () => Effect.succeed([]),
  init: () => Effect.void,
} as any

function prepare(providerID: string, npm: string, modelID = "test-model") {
  return Effect.runPromise(
    LLMRequestPrep.prepare({
      user: mockUser(providerID, modelID),
      sessionID,
      model: mockModel(providerID, npm, modelID),
      agent: mockAgent,
      system: ["You are a helpful assistant."],
      messages: [{ role: "user", content: "Hello" }] as ModelMessage[],
      tools: {},
      provider: { id: providerID, options: {} } as any,
      auth: undefined,
      plugin: mockPlugin,
      flags: mockFlags,
      isWorkflow: false,
    }),
  )
}

describe("LLMRequestPrep.prepare — x-session-affinity (OL-9.2b)", () => {
  test("attaches x-session-affinity for the litellm provider on a model absent from the registry (default ON)", async () => {
    const result = await prepare("litellm", "@ai-sdk/openai-compatible")
    expect(result.headers["x-session-affinity"]).toBe(sessionID)
  })

  test("does not attach x-session-affinity for a non-litellm provider", async () => {
    const result = await prepare("openai", "@ai-sdk/openai")
    expect(result.headers["x-session-affinity"]).toBeUndefined()
  })

  test("attaches x-session-affinity for the conductor model (registry sessionAffinity: true)", async () => {
    const result = await prepare("litellm", "@ai-sdk/openai-compatible", ECON_TIER_BINDING.conductor)
    expect(result.headers["x-session-affinity"]).toBe(sessionID)
  })

  test("withholds x-session-affinity for the reasoner model (registry sessionAffinity: false — W8 probe)", async () => {
    const result = await prepare("litellm", "@ai-sdk/openai-compatible", ECON_TIER_BINDING.reasoner)
    expect(result.headers["x-session-affinity"]).toBeUndefined()
  })
})
