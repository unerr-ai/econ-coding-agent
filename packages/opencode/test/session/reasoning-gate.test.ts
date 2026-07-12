import { describe, expect, test } from "bun:test"
import { guardReasoningEffort } from "../../src/session/llm/reasoning-gate"

// E0 (native-loop-gap.md): the conductor is never muted, and the mute marker
// is never deleted either — "none" rewrites to the bounded "high", because an
// absent param means unbounded server-side thinking (one 2,453s step on
// django-11964, e0-mini10-r1). Small housekeeping one-shots mute instead;
// bounded efforts pass through untouched.
describe("reasoning-gate", () => {
  test("'none' rewrites to bounded 'high' on ordinary requests", () => {
    const options: Record<string, any> = { reasoningEffort: "none" }
    expect(guardReasoningEffort(options, false)).toBe("bounded")
    expect(options.reasoningEffort).toBe("high")
  })

  test("'low' (executor) passes through untouched", () => {
    const options: Record<string, any> = { reasoningEffort: "low" }
    expect(guardReasoningEffort(options, false)).toBeUndefined()
    expect(options.reasoningEffort).toBe("low")
  })

  test("'high' (oracle/reasoner) passes through untouched", () => {
    const options: Record<string, any> = { reasoningEffort: "high" }
    expect(guardReasoningEffort(options, false)).toBeUndefined()
    expect(options.reasoningEffort).toBe("high")
  })

  test("an absent param is never invented", () => {
    const options: Record<string, any> = {}
    expect(guardReasoningEffort(options, false)).toBeUndefined()
    expect(options.reasoningEffort).toBeUndefined()
  })

  test("a small call with a pinned effort mutes to 'none'", () => {
    const options: Record<string, any> = { reasoningEffort: "high" }
    expect(guardReasoningEffort(options, true)).toBe("muted")
    expect(options.reasoningEffort).toBe("none")
  })

  test("a small call already muted or unset stays untouched", () => {
    const muted: Record<string, any> = { reasoningEffort: "none" }
    expect(guardReasoningEffort(muted, true)).toBeUndefined()
    expect(muted.reasoningEffort).toBe("none")
    const unset: Record<string, any> = {}
    expect(guardReasoningEffort(unset, true)).toBeUndefined()
    expect(unset.reasoningEffort).toBeUndefined()
  })
})
