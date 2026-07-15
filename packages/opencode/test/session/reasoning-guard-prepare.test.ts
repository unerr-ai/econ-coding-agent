/**
 * Regression test — the reasoning-effort guard at the request seam
 * (packages/opencode/src/session/llm/request.ts `prepare()` →
 * reasoning-gate.ts `guardReasoningEffort`).
 *
 * E0 (native-loop-gap.md): an ordinary request never ships the mute marker —
 * a stale config-pinned "none" is rewritten to the bounded "high", never
 * deleted, because omitting the param means unbounded server-side thinking
 * (one 2,453s step on django-11964, e0-mini10-r1). Small housekeeping
 * one-shots are muted instead: thinking starves/slows their JSON output.
 *
 * No live model call is made — we drive `LLMRequestPrep.prepare` directly
 * and inspect the prepared `params.options`.
 */
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { ModelMessage } from "ai"
import { LLMRequestPrep } from "@/session/llm/request"

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
  name: "conductor",
  mode: "primary",
  options: {},
  permission: [],
} as any

function mockUser(sessionID: string) {
  return {
    id: "msg_user-reasoning-guard-test",
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "conductor",
    model: { providerID: "litellm", modelID: "test-model", variant: undefined },
  } as any
}

const mockFlags = { outputTokenMax: 32_000, client: "test" } as any

const mockPlugin = {
  trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output),
  list: () => Effect.succeed([]),
  init: () => Effect.void,
} as any

// An ordinary mid-session step shape; the guard never inspects messages, only
// the merged options, so one representative transcript covers every case.
const ORDINARY_STEP_MESSAGES = [
  { role: "user", content: "run the migration" },
  { role: "assistant", content: "running" },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "1",
        toolName: "bash",
        output: { type: "text", value: "Tests: 30 passed, 30 total" },
      },
    ],
  },
] as unknown as ModelMessage[]

function prepare(sessionID: string, reasoningEffort: string | undefined, small = false) {
  return Effect.runPromise(
    LLMRequestPrep.prepare({
      user: mockUser(sessionID),
      sessionID,
      model: mockModel(reasoningEffort),
      agent: mockAgent,
      system: ["You are a helpful assistant."],
      messages: ORDINARY_STEP_MESSAGES,
      small,
      tools: {},
      provider: { id: "litellm", options: {} } as any,
      auth: undefined,
      plugin: mockPlugin,
      flags: mockFlags,
      isWorkflow: false,
    }),
  )
}

describe("LLMRequestPrep.prepare — reasoning-effort guard (E0)", () => {
  test("a stale config-pinned 'none' is rewritten to bounded 'high' on ordinary steps", async () => {
    const result = await prepare("test-reasoning-guard-stale-none", "none")
    expect(result.params.options.reasoningEffort).toBe("high")
  })

  test("a bounded config effort passes through untouched", async () => {
    const result = await prepare("test-reasoning-guard-bounded", "high")
    expect(result.params.options.reasoningEffort).toBe("high")
  })

  test("an absent reasoning param is never invented", async () => {
    const result = await prepare("test-reasoning-guard-absent", undefined)
    expect(result.params.options.reasoningEffort).toBeUndefined()
  })

  test("a small housekeeping call with a pinned effort is muted to 'low'", async () => {
    const result = await prepare("test-reasoning-guard-small-high", "high", true)
    expect(result.params.options.reasoningEffort).toBe("low")
  })

  test("a small housekeeping call with no pinned effort stays untouched", async () => {
    const result = await prepare("test-reasoning-guard-small-absent", undefined, true)
    expect(result.params.options.reasoningEffort).toBeUndefined()
  })
})
