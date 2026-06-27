/**
 * Unit tests for reasoner.ts: decideReasoner — hard-step routing.
 * Also verifies that routeTurn (router.ts) correctly activates/suppresses the
 * reasoner tier based on the hardStep signal.
 *
 * Pure function tests: no I/O, no mocks.
 */

import { describe, it, expect } from "bun:test"
import { decideReasoner } from "../src/reasoner.js"
import { routeTurn, defaultRouterState, defaultRouterConfig, type RouterState } from "../src/router.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const conductorState: RouterState = { tier: "conductor" }
const cfg = defaultRouterConfig // escalateAbove=70, deescalateBelow=40

// ---------------------------------------------------------------------------
// decideReasoner — core hard-step decision
// ---------------------------------------------------------------------------

describe("decideReasoner — easy step", () => {
  it("returns conductor for an easy step (hardStep=false)", () => {
    const result = decideReasoner({ risk: 55, hardStep: false, alreadyTriedReasoner: false })
    expect(result.tier).toBe("conductor")
    expect(result.reason).toContain("easy step")
  })

  it("returns conductor even when alreadyTriedReasoner=true if hardStep=false", () => {
    const result = decideReasoner({ risk: 55, hardStep: false, alreadyTriedReasoner: true })
    expect(result.tier).toBe("conductor")
  })

  it("reason mentions no CoT", () => {
    const result = decideReasoner({ risk: 0, hardStep: false, alreadyTriedReasoner: false })
    expect(result.reason).toContain("no CoT")
  })
})

describe("decideReasoner — hard step, first attempt", () => {
  it("returns reasoner for a hard step (hardStep=true, not yet tried)", () => {
    const result = decideReasoner({ risk: 55, hardStep: true, alreadyTriedReasoner: false })
    expect(result.tier).toBe("reasoner")
    expect(result.reason).toContain("chain-of-thought")
  })

  it("returns reasoner regardless of low risk when hardStep=true", () => {
    const result = decideReasoner({ risk: 10, hardStep: true, alreadyTriedReasoner: false })
    expect(result.tier).toBe("reasoner")
  })

  it("returns reasoner even at mid-band risk when hardStep=true", () => {
    const result = decideReasoner({ risk: 55, hardStep: true, alreadyTriedReasoner: false })
    expect(result.tier).toBe("reasoner")
  })
})

describe("decideReasoner — hard step, reasoner already tried", () => {
  it("escalates to oracle when hardStep=true and alreadyTriedReasoner=true", () => {
    const result = decideReasoner({ risk: 55, hardStep: true, alreadyTriedReasoner: true })
    expect(result.tier).toBe("oracle")
    expect(result.reason).toContain("escalating to oracle")
  })

  it("escalates to oracle at any risk when alreadyTriedReasoner=true", () => {
    const result = decideReasoner({ risk: 0, hardStep: true, alreadyTriedReasoner: true })
    expect(result.tier).toBe("oracle")
  })
})

// ---------------------------------------------------------------------------
// routeTurn — reasoner integration (S3.7)
// ---------------------------------------------------------------------------

describe("routeTurn — reasoner activation via hardStep", () => {
  it("selects reasoner for a hard step at mid-band risk", () => {
    const result = routeTurn({ risk: 55, state: conductorState, hardStep: true }, cfg)
    expect(result.tier).toBe("reasoner")
    expect(result.state.tier).toBe("reasoner")
    expect(result.reason).toContain("chain-of-thought")
  })

  it("selects reasoner for a hard step at low risk (hardStep overrides low-risk conductor path)", () => {
    const result = routeTurn({ risk: 10, state: conductorState, hardStep: true }, cfg)
    expect(result.tier).toBe("reasoner")
  })

  it("selects oracle (not reasoner) when risk > escalateAbove even with hardStep=true", () => {
    // High-risk always overrides hardStep: oracle via risk band, not reasoner.
    const result = routeTurn({ risk: 80, state: conductorState, hardStep: true }, cfg)
    expect(result.tier).toBe("oracle")
    expect(result.reason).toContain("escalating to oracle")
  })

  it("escalates to oracle when hardStep=true and alreadyTriedReasoner=true", () => {
    const result = routeTurn({ risk: 55, state: conductorState, hardStep: true, alreadyTriedReasoner: true }, cfg)
    expect(result.tier).toBe("oracle")
    expect(result.reason).toContain("escalating to oracle")
  })
})

// ---------------------------------------------------------------------------
// routeTurn — NO CoT tax on normal turns (key invariant)
// ---------------------------------------------------------------------------

describe("routeTurn — no CoT on normal turns", () => {
  it("does NOT select reasoner when hardStep is absent (low risk)", () => {
    const result = routeTurn({ risk: 10, state: conductorState }, cfg)
    expect(result.tier).toBe("conductor")
    expect(result.tier).not.toBe("reasoner")
  })

  it("does NOT select reasoner when hardStep is absent (mid-band, from conductor)", () => {
    const result = routeTurn({ risk: 55, state: conductorState }, cfg)
    expect(result.tier).toBe("conductor")
    expect(result.tier).not.toBe("reasoner")
  })

  it("does NOT select reasoner when hardStep=false explicitly", () => {
    const result = routeTurn({ risk: 55, state: conductorState, hardStep: false }, cfg)
    expect(result.tier).toBe("conductor")
    expect(result.tier).not.toBe("reasoner")
  })

  it("a previous reasoner state de-escalates to conductor in mid-band without hardStep", () => {
    // After a hard step, if the next turn has no hardStep signal, de-escalate.
    const reasonerState: RouterState = { tier: "reasoner" }
    const result = routeTurn({ risk: 55, state: reasonerState }, cfg)
    expect(result.tier).toBe("conductor")
    expect(result.state.tier).toBe("conductor")
    expect(result.reason).toContain("hysteresis band")
  })
})
