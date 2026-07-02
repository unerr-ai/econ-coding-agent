import { expect, test } from "bun:test"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"

test("compaction describes tool media without embedding base64", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const serialized = SessionCompaction.serializeToolContent([
    { type: "text", text: "Image read successfully" },
    {
      type: "file",
      uri: `data:image/png;base64,${base64}`,
      mime: "image/png",
      name: "pixel.png",
    },
  ])

  expect(serialized).toBe("Image read successfully\n[Attached image/png: pixel.png]")
  expect(serialized).not.toContain(base64)
})

test("buildPrompt instructs an in-place merge, not a re-summary, when a previous summary exists", () => {
  const previousSummary = "## Goal\n- ship the thing"
  const prompt = SessionCompaction.buildPrompt({ previousSummary, context: ["[User]: continue"] })

  expect(prompt).toContain("Update the typed state snapshot below in place")
  expect(prompt).toContain("never produce a summary of a summary")
  expect(prompt).toContain(`<previous-summary>\n${previousSummary}\n</previous-summary>`)
})

test("buildPrompt asks for a fresh snapshot when there is no previous summary", () => {
  const prompt = SessionCompaction.buildPrompt({ context: ["[User]: start"] })

  expect(prompt).toContain("Create a new typed state snapshot from the conversation history.")
  expect(prompt).not.toContain("<previous-summary>")
})
