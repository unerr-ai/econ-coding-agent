import { describe, expect, test } from "bun:test"
import { applyAdaptiveReasoning } from "../../src/session/llm/reasoning-gate"

// The conductor is never suppressed (native-loop-gap.md E0): the gate always
// strips reasoningEffort:"none" so the provider default (the model's own
// thinking) applies. Every other tier's reasoningEffort passes through.
describe("reasoning-gate", () => {
  test("reasoningEffort 'none' (conductor) is always deleted", () => {
    const options: Record<string, any> = { reasoningEffort: "none" }
    const result = applyAdaptiveReasoning(options)
    expect(result).toBe(true)
    expect(options.reasoningEffort).toBeUndefined()
  })

  test("reasoningEffort 'low' (executor) passes through untouched", () => {
    const options: Record<string, any> = { reasoningEffort: "low" }
    const result = applyAdaptiveReasoning(options)
    expect(result).toBe(false)
    expect(options.reasoningEffort).toBe("low")
  })

  test("reasoningEffort 'high' (oracle/reasoner) passes through untouched", () => {
    const options: Record<string, any> = { reasoningEffort: "high" }
    const result = applyAdaptiveReasoning(options)
    expect(result).toBe(false)
    expect(options.reasoningEffort).toBe("high")
  })

  test("reasoningEffort absent passes through untouched", () => {
    const options: Record<string, any> = {}
    const result = applyAdaptiveReasoning(options)
    expect(result).toBe(false)
    expect(options.reasoningEffort).toBeUndefined()
  })
})
