/**
 * Unit tests for abstention.ts: detectAbstention + escalationFromAbstention,
 * and their integration with routeTurn's forceTier hook.
 * Pure function tests: no I/O, no mocks beyond the input shape.
 */

import { describe, it, expect } from "bun:test"
import {
  detectAbstention,
  escalationFromAbstention,
  CONFIDENCE_THRESHOLD,
  type ConductorResult,
  type AbstentionResult,
} from "../src/abstention.js"
import { routeTurn, defaultRouterState, type RouterState } from "../src/router.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const conductorState: RouterState = { tier: "conductor" }
const LOW_RISK = 20   // well below escalateAbove=70, below deescalateBelow=40
const MID_RISK = 55   // mid-band (40–70); holds current tier without forceTier

// ---------------------------------------------------------------------------
// detectAbstention — explicit flag
// ---------------------------------------------------------------------------

describe("detectAbstention — explicit abstain flag", () => {
  it("returns abstained=true when abstain=true", () => {
    const result = detectAbstention({ abstain: true })
    expect(result.abstained).toBe(true)
    expect(result.reason).toContain("abstain=true")
  })

  it("includes confidence when provided alongside abstain flag", () => {
    const result = detectAbstention({ abstain: true, confidence: 0.2 })
    expect(result.abstained).toBe(true)
    expect(result.confidence).toBe(0.2)
  })
})

// ---------------------------------------------------------------------------
// detectAbstention — sentinel tokens
// ---------------------------------------------------------------------------

describe("detectAbstention — sentinel tokens in text", () => {
  it("detects [[ABSTAIN]] token", () => {
    const result = detectAbstention({ text: "I am not confident. [[ABSTAIN]]" })
    expect(result.abstained).toBe(true)
    expect(result.reason).toContain("[[ABSTAIN]]")
  })

  it("detects [[UNSURE]] token", () => {
    const result = detectAbstention({ text: "[[UNSURE]] — escalate this." })
    expect(result.abstained).toBe(true)
    expect(result.reason).toContain("[[UNSURE]]")
  })

  it("is case-insensitive on the token name (brackets required)", () => {
    const result = detectAbstention({ text: "[[abstain]]" })
    expect(result.abstained).toBe(true)
  })

  it("does not trigger on partial bracket match", () => {
    // "ABSTAIN" without brackets must NOT trigger
    const result = detectAbstention({ text: "I abstain from answering" })
    expect(result.abstained).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// detectAbstention — low confidence
// ---------------------------------------------------------------------------

describe("detectAbstention — low confidence field", () => {
  it("abstains when confidence is strictly below threshold", () => {
    const result = detectAbstention({ confidence: CONFIDENCE_THRESHOLD - 0.01 })
    expect(result.abstained).toBe(true)
    expect(result.confidence).toBe(CONFIDENCE_THRESHOLD - 0.01)
    expect(result.reason).toContain("threshold")
  })

  it("does NOT abstain when confidence equals threshold (boundary)", () => {
    const result = detectAbstention({ confidence: CONFIDENCE_THRESHOLD })
    expect(result.abstained).toBe(false)
  })

  it("does NOT abstain when confidence is above threshold", () => {
    const result = detectAbstention({ confidence: 0.9 })
    expect(result.abstained).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// detectAbstention — no signal
// ---------------------------------------------------------------------------

describe("detectAbstention — no abstention signal", () => {
  it("returns abstained=false for an empty result", () => {
    const result = detectAbstention({})
    expect(result.abstained).toBe(false)
  })

  it("returns abstained=false for a confident text result", () => {
    const result = detectAbstention({ text: "Here is the answer.", confidence: 0.95 })
    expect(result.abstained).toBe(false)
  })

  it("explicit abstain=false does not trigger abstention", () => {
    const result = detectAbstention({ abstain: false })
    expect(result.abstained).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// escalationFromAbstention
// ---------------------------------------------------------------------------

describe("escalationFromAbstention", () => {
  it("returns forceTier='oracle' when abstained=true", () => {
    const abstention: AbstentionResult = { abstained: true, reason: "test" }
    const hook = escalationFromAbstention(abstention)
    expect(hook.forceTier).toBe("oracle")
  })

  it("returns empty object (no override) when abstained=false", () => {
    const abstention: AbstentionResult = { abstained: false, reason: "no signal" }
    const hook = escalationFromAbstention(abstention)
    expect(hook.forceTier).toBeUndefined()
    expect(Object.keys(hook)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// End-to-end: abstention → forceTier → routeTurn
// ---------------------------------------------------------------------------

describe("abstention → oracle escalation via routeTurn", () => {
  it("low risk + explicit abstain routes to oracle", () => {
    // Conductor emits explicit abstain on a structurally safe turn.
    const conductorResult: ConductorResult = { abstain: true }
    const abstention = detectAbstention(conductorResult)
    const { forceTier } = escalationFromAbstention(abstention)

    // forceTier must be present for routeTurn to override risk.
    expect(forceTier).toBe("oracle")

    const routing = routeTurn({ risk: LOW_RISK, state: conductorState, forceTier })
    expect(routing.tier).toBe("oracle")
    expect(routing.reason).toContain("forceTier")
    expect(routing.state.tier).toBe("oracle")
  })

  it("low risk + [[ABSTAIN]] sentinel routes to oracle", () => {
    const conductorResult: ConductorResult = { text: "I cannot answer this. [[ABSTAIN]]" }
    const abstention = detectAbstention(conductorResult)
    const { forceTier } = escalationFromAbstention(abstention)

    const routing = routeTurn({ risk: LOW_RISK, state: conductorState, forceTier })
    expect(routing.tier).toBe("oracle")
  })

  it("low risk + low confidence routes to oracle", () => {
    const conductorResult: ConductorResult = { confidence: 0.1 }
    const abstention = detectAbstention(conductorResult)
    const { forceTier } = escalationFromAbstention(abstention)

    const routing = routeTurn({ risk: LOW_RISK, state: conductorState, forceTier })
    expect(routing.tier).toBe("oracle")
  })

  it("low risk + confident result stays on conductor", () => {
    // No abstention signal → no forceTier → risk-band logic applies → conductor.
    const conductorResult: ConductorResult = { text: "Here is my answer.", confidence: 0.95 }
    const abstention = detectAbstention(conductorResult)
    const { forceTier } = escalationFromAbstention(abstention)

    expect(forceTier).toBeUndefined()

    const routing = routeTurn({ risk: LOW_RISK, state: conductorState, forceTier })
    expect(routing.tier).toBe("conductor")
  })

  it("mid-band risk + confident result holds conductor (no flap)", () => {
    // Mid-band risk with no abstention should hold the existing conductor tier.
    const conductorResult: ConductorResult = { confidence: 0.8 }
    const abstention = detectAbstention(conductorResult)
    const { forceTier } = escalationFromAbstention(abstention)

    const routing = routeTurn({ risk: MID_RISK, state: conductorState, forceTier })
    expect(routing.tier).toBe("conductor")
    expect(routing.reason).toContain("hysteresis band")
  })
})
