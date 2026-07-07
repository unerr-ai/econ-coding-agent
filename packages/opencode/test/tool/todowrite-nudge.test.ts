import { describe, expect, it } from "bun:test"
import { claimNudge, clear, standaloneTodowriteSuffix } from "../../src/tool/todowrite-nudge"

const NUDGE =
  "\n[econ-nudge] previous step was a standalone todowrite — flip statuses in the same step as the work, not as their own step."

describe("todowrite-nudge", () => {
  describe("standaloneTodowriteSuffix", () => {
    it("fires when the prior step's only tool part is a todowrite", () => {
      const parts = [{ type: "tool", tool: "todowrite" }]
      expect(standaloneTodowriteSuffix(parts)).toBe(NUDGE)
    })

    it("fires when the prior step had only text alongside the lone todowrite", () => {
      const parts = [{ type: "text" }, { type: "tool", tool: "todowrite" }, { type: "reasoning" }]
      expect(standaloneTodowriteSuffix(parts)).toBe(NUDGE)
    })

    it("stays silent when the todowrite rode along with real tool calls", () => {
      const parts = [
        { type: "tool", tool: "todowrite" },
        { type: "tool", tool: "bash" },
      ]
      expect(standaloneTodowriteSuffix(parts)).toBe("")
    })

    it("stays silent when the prior step's lone tool call was not a todowrite", () => {
      const parts = [{ type: "tool", tool: "bash" }, { type: "text" }]
      expect(standaloneTodowriteSuffix(parts)).toBe("")
    })

    it("stays silent on a text-only prior step (final summaries stay unnudged)", () => {
      const parts = [{ type: "text" }, { type: "reasoning" }]
      expect(standaloneTodowriteSuffix(parts)).toBe("")
    })

    it("stays silent when there is no prior step", () => {
      expect(standaloneTodowriteSuffix(undefined)).toBe("")
    })
  })

  describe("claimNudge (once-guard)", () => {
    it("fires once per offending message", () => {
      clear()
      expect(claimNudge("session-a", "msg-1")).toBe(true)
    })

    it("stays silent on a second call for the same offending message", () => {
      clear()
      expect(claimNudge("session-a", "msg-1")).toBe(true)
      expect(claimNudge("session-a", "msg-1")).toBe(false)
    })

    it("fires again for a new offending message in the same session", () => {
      clear()
      expect(claimNudge("session-a", "msg-1")).toBe(true)
      expect(claimNudge("session-a", "msg-2")).toBe(true)
    })

    it("tracks sessions independently", () => {
      clear()
      expect(claimNudge("session-a", "msg-1")).toBe(true)
      expect(claimNudge("session-b", "msg-1")).toBe(true)
    })

    it("clear() resets guard state", () => {
      clear()
      expect(claimNudge("session-a", "msg-1")).toBe(true)
      expect(claimNudge("session-a", "msg-1")).toBe(false)
      clear()
      expect(claimNudge("session-a", "msg-1")).toBe(true)
    })
  })
})
