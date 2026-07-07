/**
 * Unit tests for plan-reasoning.ts: planReasoningEffort — OL-7.5 adaptive plan-time reasoning.
 *
 * Pure function tests: no I/O, no mocks.
 */

import { describe, it, expect } from "bun:test"
import { planReasoningEffort } from "../src/plan-reasoning.js"

describe("planReasoningEffort — trivial turns hold the baseline", () => {
  it("holds baseline for a light, low-risk turn", () => {
    const result = planReasoningEffort({ heavy: false, risk: 0 })
    expect(result.raise).toBe(false)
    expect(result.reason).toContain("routine turn")
  })

  it("holds baseline just below the default risk floor (risk = 39)", () => {
    const result = planReasoningEffort({ heavy: false, risk: 39 })
    expect(result.raise).toBe(false)
  })
})

describe("planReasoningEffort — heavy prompt always raises", () => {
  it("raises for a heavy prompt even at risk = 0", () => {
    const result = planReasoningEffort({ heavy: true, risk: 0 })
    expect(result.raise).toBe(true)
    expect(result.reason).toContain("heavy prompt")
  })
})

describe("planReasoningEffort — risk floor", () => {
  it("raises at the default risk floor (risk = 40)", () => {
    const result = planReasoningEffort({ heavy: false, risk: 40 })
    expect(result.raise).toBe(true)
    expect(result.reason).toContain("risk 40 >= riskFloor 40")
  })

  it("raises above the default risk floor (risk = 71)", () => {
    const result = planReasoningEffort({ heavy: false, risk: 71 })
    expect(result.raise).toBe(true)
  })

  it("respects a custom riskFloor", () => {
    const low = planReasoningEffort({ heavy: false, risk: 20, riskFloor: 10 })
    expect(low.raise).toBe(true)

    const high = planReasoningEffort({ heavy: false, risk: 20, riskFloor: 60 })
    expect(high.raise).toBe(false)
  })
})
