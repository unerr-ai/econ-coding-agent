/**
 * Regression test — the turn-level ambiguity trigger (task #52).
 *
 * The per-slice difficulty floor (allocation.ts) only fires once the conductor
 * has decomposed a turn into typed slices — a turn it handles inline (no
 * decomposition) never reaches it and gets authored at the conductor's cheap
 * baseline despite being flagged ambiguous or hard. This floors the
 * conductor's OWN reasoning at reasoner-grade ("high") for every
 * non-housekeeping step of a turn the arming decision flagged, without
 * swapping which model serves the turn
 * (packages/opencode/src/session/llm/request.ts `prepare()`, guarded by
 * `getArmingDecision`).
 *
 * No live model call is made — we drive `LLMRequestPrep.prepare` directly,
 * seed the session's arming decision via `setArmingDecision`, and inspect the
 * prepared `params.options`.
 */
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { ModelMessage } from "ai"
import { LLMRequestPrep } from "@/session/llm/request"
import { setArmingDecision } from "@/session/arming-store"
import type { ArmingDecision } from "@/session/arming-judge"

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
    id: "msg_user-arming-turn-floor-test",
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

// An "ordinary" mid-session step — trailing successful bash result — so the
// pre-existing adaptive gate (reasoning-gate.ts) reads neither plan, recovery,
// nor contradiction and stays a no-op, isolating the turn-ambiguity floor under
// test. A single trailing user message would always read as a "plan" step and
// un-mute on its own regardless of arming.
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

// Mirrors the main-loop (non-housekeeping) authoring-step shape: small:false —
// the turn-ambiguity floor is the only thing that can un-mute it.
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

describe("LLMRequestPrep.prepare — turn-level ambiguity floor (task #52)", () => {
  test("floors a muted conductor to reasoningEffort:high when the turn is armed ambiguous", async () => {
    const sessionID = "test-arming-turn-floor-ambiguous"
    setArmingDecision(sessionID, {
      armLocalization: false,
      hardness: "moderate",
      ambiguity: "ambiguous",
    } satisfies ArmingDecision)
    const result = await prepare(sessionID, "none")
    expect(result.params.options.reasoningEffort).toBe("high")
  })

  test("floors a muted conductor to reasoningEffort:high when the turn is armed hard", async () => {
    const sessionID = "test-arming-turn-floor-hard"
    setArmingDecision(sessionID, { armLocalization: false, hardness: "hard" } satisfies ArmingDecision)
    const result = await prepare(sessionID, "none")
    expect(result.params.options.reasoningEffort).toBe("high")
  })

  test("a clear + trivial turn stays muted (unchanged)", async () => {
    const sessionID = "test-arming-turn-floor-clear"
    setArmingDecision(sessionID, {
      armLocalization: false,
      hardness: "trivial",
      ambiguity: "clear",
    } satisfies ArmingDecision)
    const result = await prepare(sessionID, "none")
    expect(result.params.options.reasoningEffort).toBe("none")
  })

  test("no arming decision recorded for the session leaves the baseline untouched", async () => {
    const sessionID = "test-arming-turn-floor-unseeded"
    const result = await prepare(sessionID, "none")
    expect(result.params.options.reasoningEffort).toBe("none")
  })

  test("one-way floor: a turn already raised (e.g. by the OL-7.5 plan-raise) is left untouched, never lowered", async () => {
    const sessionID = "test-arming-turn-floor-already-high"
    setArmingDecision(sessionID, {
      armLocalization: false,
      hardness: "hard",
      ambiguity: "ambiguous",
    } satisfies ArmingDecision)
    const result = await prepare(sessionID, "high")
    expect(result.params.options.reasoningEffort).toBe("high")
  })

  test("small housekeeping calls (triage/arming judge) are never touched by the turn floor", async () => {
    const sessionID = "test-arming-turn-floor-small-excluded"
    setArmingDecision(sessionID, {
      armLocalization: false,
      hardness: "hard",
      ambiguity: "ambiguous",
    } satisfies ArmingDecision)
    const result = await prepare(sessionID, "none", true)
    expect(result.params.options.reasoningEffort).toBe("none")
  })
})
