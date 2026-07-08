/**
 * Regression test — locks in the explicit `unmuteReasoning` wiring
 * (packages/opencode/src/session/llm/request.ts `prepare()`, commit c3613a5bd).
 *
 * The conductor tier ships muted (`options.reasoningEffort: "none"`). A `small`
 * one-shot call normally stays muted entirely (the reasoning-gate.ts regression:
 * "triage null on every real turn" when thinking leaked into a stateless
 * one-shot). `armingDispatch` (prompt.ts) is a small one-shot that STILL needs
 * the conductor to reason through grounding strength, so it explicitly passes
 * `unmuteReasoning: true` to drop the mute for just that call; `triageDispatch`
 * does not set it and must stay muted.
 *
 * No live model call is made — we drive `LLMRequestPrep.prepare` directly and
 * inspect the prepared `params.options`, so a regression in the
 * `unmuteReasoning && options.reasoningEffort === "none"` guard fails loudly
 * here instead of silently degrading arming back to `heuristicArming` in prod.
 */
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { ModelMessage } from "ai"
import { LLMRequestPrep } from "@/session/llm/request"

const sessionID = "test-arming-unmute"

function mockModel(reasoningEffort: string | undefined) {
  return {
    id: "test-model",
    providerID: "litellm",
    api: {
      id: "test-model",
      url: "https://example.test",
      npm: "@ai-sdk/openai-compatible",
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
    options: reasoningEffort === undefined ? {} : { reasoningEffort },
    headers: {},
  } as any
}

const mockAgent = {
  name: "test-agent",
  mode: "primary",
  options: {},
  permission: [],
} as any

const mockUser = {
  id: "msg_user-arming-unmute-test",
  sessionID,
  role: "user",
  time: { created: Date.now() },
  agent: "test-agent",
  model: { providerID: "litellm", modelID: "test-model", variant: undefined },
} as any

const mockFlags = { outputTokenMax: 32_000, client: "test" } as any

const mockPlugin = {
  trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output),
  list: () => Effect.succeed([]),
  init: () => Effect.void,
} as any

// Mirrors the `small: true` one-shot shape armingDispatch/triageDispatch build in prompt.ts.
function prepare(reasoningEffort: string | undefined, unmuteReasoning?: boolean) {
  return Effect.runPromise(
    LLMRequestPrep.prepare({
      user: mockUser,
      sessionID,
      model: mockModel(reasoningEffort),
      agent: mockAgent,
      system: ["You are a helpful assistant."],
      messages: [{ role: "user", content: "Hello" }] as ModelMessage[],
      small: true,
      unmuteReasoning,
      tools: {},
      provider: { id: "litellm", options: {} } as any,
      auth: undefined,
      plugin: mockPlugin,
      flags: mockFlags,
      isWorkflow: false,
    }),
  )
}

describe("LLMRequestPrep.prepare — explicit unmuteReasoning (arming judge, c3613a5bd)", () => {
  test("un-mutes a muted conductor (reasoningEffort: none) when unmuteReasoning is set (armingDispatch)", async () => {
    const result = await prepare("none", true)
    expect(result.params.options.reasoningEffort).toBeUndefined()
  })

  test("stays muted on a plain small call without unmuteReasoning (triageDispatch)", async () => {
    const result = await prepare("none", false)
    expect(result.params.options.reasoningEffort).toBe("none")
  })

  test("stays muted when unmuteReasoning is entirely absent (undefined, the default)", async () => {
    const result = await prepare("none", undefined)
    expect(result.params.options.reasoningEffort).toBe("none")
  })

  test("is a no-op when the model's effort is not none (only the muted conductor un-mutes)", async () => {
    const result = await prepare("low", true)
    expect(result.params.options.reasoningEffort).toBe("low")
  })
})
