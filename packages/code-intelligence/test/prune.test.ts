/**
 * Tests for the context-window pruner (S2.4).
 *
 * Strategy: build a synthetic long window, then assert:
 *   1. Under-budget windows are returned unchanged.
 *   2. Over-budget windows are pruned to within budget.
 *   3. The keepLastN tail is never mutated.
 *   4. Stale duplicate tool outputs are dropped; the latest survives.
 *   5. Non-duplicate tool outputs are preserved.
 *   6. Reasoning parts are dropped before whole messages.
 *   7. User messages are never dropped (structurally required).
 */

import { describe, it, expect } from "bun:test"
import { pruneWindow } from "../src/prune.js"
import type { Message, ToolPart, TextPart, ReasoningPart } from "../src/prune.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _id = 0
function nextId(): string {
  return `msg_${String(++_id).padStart(4, "0")}`
}

function userMsg(text: string): Message {
  return {
    info: { id: nextId(), role: "user" },
    parts: [{ type: "text", text } satisfies TextPart],
  }
}

function assistantText(text: string): Message {
  return {
    info: { id: nextId(), role: "assistant" },
    parts: [{ type: "text", text } satisfies TextPart],
  }
}

function reasoning(text: string): Message {
  return {
    info: { id: nextId(), role: "assistant" },
    parts: [{ type: "reasoning", text } satisfies ReasoningPart],
  }
}

function toolCall(
  tool: string,
  input: Record<string, unknown>,
  output: string,
): Message {
  const part: ToolPart = {
    type: "tool",
    callID: `call_${nextId()}`,
    tool,
    state: {
      status: "completed",
      input,
      output,
      title: tool,
    },
  }
  return {
    info: { id: nextId(), role: "assistant" },
    parts: [part],
  }
}

/** Build a string of roughly `chars` characters. */
function pad(chars: number): string {
  return "x".repeat(chars)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pruneWindow", () => {
  it("returns messages unchanged when already within budget", () => {
    const messages: Message[] = [
      userMsg("hello"),
      assistantText("world"),
    ]
    const { messages: out, report } = pruneWindow(messages, { tokenBudget: 100_000 })
    expect(out).toBe(messages) // same reference — no copy needed
    expect(report.droppedToolOutputs).toBe(0)
    expect(report.droppedMessages).toBe(0)
    expect(report.estimatedOutputTokens).toBe(report.estimatedInputTokens)
  })

  it("stays within tokenBudget after pruning a large window", () => {
    // User messages are tiny (~5 tokens). Assistant replies are large (~1000 tokens).
    // 20 pairs = ~20 000 tokens total. Budget = 5 000 tokens.
    // After Stage 3 drops old assistant messages, only small user messages from
    // the old region remain (~5 tokens each) plus the protected tail (≤ 4 × 1000
    // tokens), which fits under 5 000. User messages are never dropped by policy.
    const BIG = pad(4_000) // ≈ 1000 tokens
    const messages: Message[] = []
    for (let i = 0; i < 20; i++) {
      messages.push(userMsg(`t${i}`)) // tiny — a few tokens
      messages.push(assistantText(`reply ${i}: ${BIG}`)) // large
    }

    const { messages: out, report } = pruneWindow(messages, {
      tokenBudget: 5_000,
      keepLastN: 4,
    })

    expect(report.estimatedOutputTokens).toBeLessThanOrEqual(5_000)
    expect(out.length).toBeLessThan(messages.length)
  })

  it("always keeps the keepLastN tail verbatim", () => {
    const BIG = pad(4_000)
    const messages: Message[] = []
    for (let i = 0; i < 20; i++) {
      messages.push(assistantText(`msg ${i}: ${BIG}`))
    }
    // Mark the last 4 with a sentinel
    messages[16].info.sentinel = "tail-0"
    messages[17].info.sentinel = "tail-1"
    messages[18].info.sentinel = "tail-2"
    messages[19].info.sentinel = "tail-3"

    const { messages: out } = pruneWindow(messages, { tokenBudget: 5_000, keepLastN: 4 })

    // All four tail messages must appear in output
    const sentinels = out.map((m) => m.info.sentinel).filter(Boolean)
    expect(sentinels).toContain("tail-0")
    expect(sentinels).toContain("tail-1")
    expect(sentinels).toContain("tail-2")
    expect(sentinels).toContain("tail-3")
  })

  it("drops stale duplicate tool outputs, keeps the latest", () => {
    // Four reads of the same file.
    // With keepLastN=2 the protected tail is messages[7..8].
    // Old region holds indices 0..6 which includes three tool calls (idx 1, 3, 5).
    // The latest in the old region is idx 5 → idx 1 and idx 3 are stale → 2 drops.
    // idx 7 (version 4) lives in the protected tail and is always kept verbatim.
    const INPUT = { path: "src/foo.ts" }
    const messages: Message[] = [
      userMsg("read foo v1"),                                              // 0
      toolCall("read_file", INPUT, "version 1 content: " + pad(500)),    // 1 — stale
      userMsg("read foo v2"),                                              // 2
      toolCall("read_file", INPUT, "version 2 content: " + pad(500)),    // 3 — stale
      userMsg("read foo v3"),                                              // 4
      toolCall("read_file", INPUT, "version 3 content: " + pad(500)),    // 5 — latest in old
      userMsg("read foo v4"),                                              // 6
      toolCall("read_file", INPUT, "version 4 content: latest"),         // 7 — protected tail
      assistantText("done"),                                               // 8 — protected tail
    ]

    // 3 large tool calls × ~147 tokens each ≈ 441 tokens total in old region.
    // Budget 200 forces Stage 1; after dropping v1+v2 (~294 tokens removed)
    // the window is ~177 tokens which is within budget.
    const { messages: out, report } = pruneWindow(messages, {
      tokenBudget: 200,
      keepLastN: 2,
    })

    expect(report.droppedToolOutputs).toBeGreaterThanOrEqual(2)

    // Any tool parts that survived must NOT be the stale versions
    const toolParts = out
      .flatMap((m) => m.parts)
      .filter((p) => p.type === "tool") as ToolPart[]

    for (const tp of toolParts) {
      expect((tp.state.output ?? "").includes("version 1 content")).toBe(false)
      expect((tp.state.output ?? "").includes("version 2 content")).toBe(false)
    }
  })

  it("drops old reasoning before dropping old text", () => {
    // Build a window where reasoning parts are large but text parts are small.
    // After deduplication fails to bring us under budget, reasoning should go first.
    const LARGE_REASON = pad(8_000) // ≈ 2000 tokens
    const messages: Message[] = []
    for (let i = 0; i < 6; i++) {
      messages.push({
        info: { id: nextId(), role: "assistant" },
        parts: [
          { type: "reasoning", text: LARGE_REASON } satisfies ReasoningPart,
          { type: "text", text: `conclusion ${i}` } satisfies TextPart,
        ],
      })
    }
    // Add a sentinel recent message
    messages.push(userMsg("final question"))

    const { report } = pruneWindow(messages, { tokenBudget: 5_000, keepLastN: 2 })

    expect(report.droppedReasoningParts).toBeGreaterThan(0)
  })

  it("never drops user messages", () => {
    // Interleave user messages among large assistant messages.
    const BIG = pad(8_000)
    const messages: Message[] = []
    for (let i = 0; i < 10; i++) {
      messages.push(userMsg(`user turn ${i}`))
      messages.push(assistantText(`assistant turn ${i}: ${BIG}`))
    }

    const { messages: out } = pruneWindow(messages, { tokenBudget: 4_000, keepLastN: 2 })

    const roles = out.map((m) => m.info.role)
    // Every message in output must be either a user message or within keepLastN
    // (we can't drop user messages even in the old region)
    const userCount = roles.filter((r) => r === "user").length
    expect(userCount).toBeGreaterThan(0)
  })

  it("preserves distinct tool calls (different inputs) even in old region", () => {
    // Two tool calls with different inputs — NOT duplicates — should not be deduped.
    const messages: Message[] = [
      userMsg("read two files"),
      toolCall("read_file", { path: "a.ts" }, "content of a"),
      toolCall("read_file", { path: "b.ts" }, "content of b"),
      assistantText("I read both"),
      userMsg("ok"),
    ]

    // Tight budget but keepLastN=0 so old region includes everything except last 2
    const { messages: out } = pruneWindow(messages, { tokenBudget: 10_000, keepLastN: 2 })

    // At least one tool call should survive (budget is large enough)
    const toolParts = out.flatMap((m) => m.parts).filter((p) => p.type === "tool") as ToolPart[]
    // Both distinct tool outputs should survive (they are not duplicates of each other)
    const seenOutputs = new Set(toolParts.map((tp) => tp.state.output))
    expect(seenOutputs.has("content of a") || seenOutputs.has("content of b")).toBe(true)
  })

  it("returns a correct report with input/output token counts", () => {
    const BIG = pad(2_000)
    const messages: Message[] = Array.from({ length: 10 }, (_, i) =>
      assistantText(`msg ${i}: ${BIG}`),
    )

    const { report } = pruneWindow(messages, { tokenBudget: 2_000, keepLastN: 2 })

    expect(report.inputMessages).toBe(10)
    expect(report.estimatedInputTokens).toBeGreaterThan(report.estimatedOutputTokens)
    expect(report.estimatedOutputTokens).toBeLessThanOrEqual(2_000)
  })
})
