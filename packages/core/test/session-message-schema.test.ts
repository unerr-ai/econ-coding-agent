import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionMessage } from "@opencode-ai/core/session/message"

// task #56 Part A: AssistantText gained an optional providerMetadata field so
// generator logprobs can ride the persisted message pipeline. These tests
// pin the schema round-trip on both sides of that optionality.
describe("SessionMessage.AssistantText providerMetadata", () => {
  test("round-trips through the schema with a providerMetadata value", () => {
    const providerMetadata = { openai: { logprobs: [{ token: "a", logprob: -0.1 }] } }
    const instance = new SessionMessage.AssistantText({
      type: "text",
      id: "text-1",
      text: "hello",
      providerMetadata,
    })

    const encoded = Schema.encodeSync(SessionMessage.AssistantText)(instance)
    const decoded = Schema.decodeUnknownSync(SessionMessage.AssistantText)(encoded)

    expect(decoded.text).toBe("hello")
    expect(decoded.providerMetadata).toEqual(providerMetadata)
  })

  test("round-trips through the schema without providerMetadata (backward-compatible)", () => {
    const instance = new SessionMessage.AssistantText({ type: "text", id: "text-2", text: "hello" })

    const encoded = Schema.encodeSync(SessionMessage.AssistantText)(instance)
    const decoded = Schema.decodeUnknownSync(SessionMessage.AssistantText)(encoded)

    expect(decoded.text).toBe("hello")
    expect(decoded.providerMetadata).toBeUndefined()

    // A pre-existing persisted message (no providerMetadata key at all) must
    // still parse — this is the backward-compat case the optional field exists for.
    const legacy = Schema.decodeUnknownSync(SessionMessage.AssistantText)({
      type: "text",
      id: "text-legacy",
      text: "hello",
    })
    expect(legacy.providerMetadata).toBeUndefined()
  })
})
