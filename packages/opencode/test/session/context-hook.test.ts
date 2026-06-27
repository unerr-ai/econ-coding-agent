/**
 * Z3-econ S2.0 — context.assemble.before hook
 *
 * Verifies that the hook fires before the LLM sees the prompt and that any
 * messages pushed into `output.messages` appear in the final assembled
 * message list (between the system turn and the conversation history).
 *
 * No live model call is made — we inspect the Prepared payload directly.
 */
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { ModelMessage } from "ai"
import { LLMRequestPrep } from "@/session/llm/request"

// ---------------------------------------------------------------------------
// Shared fixtures (minimal shape — only fields used by prepare())
// ---------------------------------------------------------------------------

const sessionID = "test-session-hook"

const mockModel = {
  id: "anthropic/claude-3-5-sonnet",
  providerID: "anthropic",
  api: {
    id: "claude-3-5-sonnet-20241022",
    url: "https://api.anthropic.com",
    npm: "@ai-sdk/anthropic",
  },
  name: "Claude 3.5 Sonnet",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: true },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0.003, output: 0.015, cache: { read: 0.0003, write: 0.00375 } },
  limit: { context: 200_000, output: 8_192 },
  status: "active",
  options: {},
  headers: {},
} as any

const mockAgent = {
  name: "test-agent",
  mode: "primary",
  options: {},
  permission: [],
} as any

const mockUser = {
  id: "msg_user-hook-test",
  sessionID,
  role: "user",
  time: { created: Date.now() },
  agent: "test-agent",
  model: { providerID: "anthropic", modelID: "claude-3-5-sonnet-20241022", variant: undefined },
} as any

const mockProvider = {
  id: "anthropic",
  options: {},
} as any

const mockFlags = { outputTokenMax: 32_000, client: "test" } as any

/**
 * Build a mock Plugin.Interface whose trigger() implementation calls the
 * registered hook function if name matches, then returns the (possibly
 * mutated) output object.
 */
function makePlugin(hooks: Record<string, (input: any, output: any) => Promise<void>>) {
  return {
    trigger: (name: string, input: unknown, output: unknown) =>
      Effect.promise(async () => {
        const fn = hooks[name]
        if (fn) await fn(input, output)
        return output
      }),
    list: () => Effect.succeed([]),
    init: () => Effect.void,
  } as any
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("context.assemble.before hook — S2.0", () => {
  test("hook fires before assembly and injection appears in prepared messages", async () => {
    let hookFired = false
    let capturedSessionID: string | undefined

    const plugin = makePlugin({
      "context.assemble.before": async (input, output) => {
        hookFired = true
        capturedSessionID = input.sessionID
        // Push a synthetic memory/recon injection
        output.messages.push({
          role: "user",
          content: "[injected memory context]",
        })
      },
    })

    const result = await Effect.runPromise(
      LLMRequestPrep.prepare({
        user: mockUser,
        sessionID,
        model: mockModel,
        agent: mockAgent,
        system: ["You are a helpful assistant."],
        messages: [{ role: "user", content: "Hello" }] as ModelMessage[],
        tools: {},
        provider: mockProvider,
        auth: undefined,
        plugin,
        flags: mockFlags,
        isWorkflow: false,
      }),
    )

    // Hook must have been called before the model payload was assembled
    expect(hookFired).toBe(true)
    expect(capturedSessionID).toBe(sessionID)

    // The injected message must appear in prepared.messages, before the
    // original conversation history ("Hello") but after system turns.
    const roles = result.messages.map((m) => m.role)
    const contents = result.messages.map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    )

    // Confirm ordering: system → injected → original user turn
    const systemIdx = roles.indexOf("system")
    const injectedIdx = contents.indexOf("[injected memory context]")
    const userIdx = contents.indexOf("Hello")

    expect(injectedIdx).toBeGreaterThan(-1)
    expect(userIdx).toBeGreaterThan(-1)
    expect(systemIdx).toBeLessThan(injectedIdx)
    expect(injectedIdx).toBeLessThan(userIdx)
  })

  test("hook with no registered handler leaves messages unchanged", async () => {
    const plugin = makePlugin({}) // no context.assemble.before registered

    const result = await Effect.runPromise(
      LLMRequestPrep.prepare({
        user: mockUser,
        sessionID,
        model: mockModel,
        agent: mockAgent,
        system: ["You are a helpful assistant."],
        messages: [{ role: "user", content: "Hello" }] as ModelMessage[],
        tools: {},
        provider: mockProvider,
        auth: undefined,
        plugin,
        flags: mockFlags,
        isWorkflow: false,
      }),
    )

    const contents = result.messages.map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    )
    // Only the system turn and the original user turn — no injection
    expect(contents).toContain("Hello")
    // Nothing unexpected between system and history
    const userIdx = contents.indexOf("Hello")
    const systemIdx = result.messages.map((m) => m.role).indexOf("system")
    expect(userIdx).toBe(systemIdx + 1)
  })

  test("hook can also push additional system strings via output.system", async () => {
    const plugin = makePlugin({
      "context.assemble.before": async (_input, output) => {
        output.system.push("Additional context from recon.")
      },
    })

    const result = await Effect.runPromise(
      LLMRequestPrep.prepare({
        user: mockUser,
        sessionID,
        model: mockModel,
        agent: mockAgent,
        system: ["Base system prompt."],
        messages: [{ role: "user", content: "Hello" }] as ModelMessage[],
        tools: {},
        provider: mockProvider,
        auth: undefined,
        plugin,
        flags: mockFlags,
        isWorkflow: false,
      }),
    )

    // The system array should contain the injected string
    expect(result.system).toContain("Additional context from recon.")
  })
})
