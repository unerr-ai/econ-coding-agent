/**
 * Unit tests for router.ts: routeTurn — hysteresis, override hooks.
 * Pure function tests: no I/O, no mocks beyond the input shape.
 */

import { describe, it, expect } from "bun:test"
import {
  routeTurn,
  defaultRouterState,
  defaultRouterConfig,
  type RouterState,
  type RouterConfig,
} from "../src/router.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const conductorState: RouterState = { tier: "conductor" }
const oracleState: RouterState = { tier: "oracle" }

const cfg: RouterConfig = defaultRouterConfig // escalateAbove=70, deescalateBelow=40

// ---------------------------------------------------------------------------
// High-risk → oracle
// ---------------------------------------------------------------------------

describe("routeTurn — high risk", () => {
  it("escalates to oracle when risk is clearly high (from conductor)", () => {
    const result = routeTurn({ risk: 95, state: conductorState }, cfg)
    expect(result.tier).toBe("oracle")
    expect(result.state.tier).toBe("oracle")
    expect(result.reason).toContain("escalating to oracle")
  })

  it("stays oracle when already oracle and risk > 70", () => {
    const result = routeTurn({ risk: 90, state: oracleState }, cfg)
    expect(result.tier).toBe("oracle")
  })

  it("escalates when risk = 100", () => {
    const result = routeTurn({ risk: 100, state: conductorState }, cfg)
    expect(result.tier).toBe("oracle")
  })
})

// ---------------------------------------------------------------------------
// AC-8.5 — cache-warm stickiness: a borderline escalation off a warm
// (non-oracle) tier holds instead of flipping; a genuine high-risk turn
// (past the stickiness margin) still escalates unconditionally.
// ---------------------------------------------------------------------------

describe("routeTurn — AC-8.5 cache-warm stickiness", () => {
  it("holds conductor at risk = 71 (borderline, within default stickinessMargin=10)", () => {
    const result = routeTurn({ risk: 71, state: conductorState }, cfg)
    expect(result.tier).toBe("conductor")
    expect(result.state.tier).toBe("conductor")
    expect(result.reason).toContain("holding tier")
  })

  it("holds conductor at risk = 80 (at the edge of the stickiness margin)", () => {
    const result = routeTurn({ risk: 80, state: conductorState }, cfg)
    expect(result.tier).toBe("conductor")
  })

  it("escalates once risk clears the stickiness margin (risk = 81)", () => {
    const result = routeTurn({ risk: 81, state: conductorState }, cfg)
    expect(result.tier).toBe("oracle")
    expect(result.reason).toContain("escalating to oracle")
  })

  it("does not dampen escalation when already on oracle (nothing warm to protect)", () => {
    const result = routeTurn({ risk: 71, state: oracleState }, cfg)
    expect(result.tier).toBe("oracle")
  })

  it("stickinessMargin: 0 disables the dampening (pre-AC-8.5 behavior)", () => {
    const result = routeTurn({ risk: 71, state: conductorState }, { ...cfg, stickinessMargin: 0 })
    expect(result.tier).toBe("oracle")
  })
})

// ---------------------------------------------------------------------------
// Low-risk → conductor
// ---------------------------------------------------------------------------

describe("routeTurn — low risk", () => {
  it("stays on conductor when risk < 40 (from conductor)", () => {
    const result = routeTurn({ risk: 20, state: conductorState }, cfg)
    expect(result.tier).toBe("conductor")
    expect(result.state.tier).toBe("conductor")
    expect(result.reason).toContain("using conductor")
  })

  it("de-escalates to conductor when risk < 40 (from oracle)", () => {
    const result = routeTurn({ risk: 10, state: oracleState }, cfg)
    expect(result.tier).toBe("conductor")
  })

  it("de-escalates at risk = 39 (threshold boundary)", () => {
    const result = routeTurn({ risk: 39, state: oracleState }, cfg)
    expect(result.tier).toBe("conductor")
  })

  it("stays conductor when risk = 0", () => {
    const result = routeTurn({ risk: 0, state: conductorState }, cfg)
    expect(result.tier).toBe("conductor")
  })
})

// ---------------------------------------------------------------------------
// Mid-band: no flap
// ---------------------------------------------------------------------------

describe("routeTurn — hysteresis mid-band (40–70)", () => {
  it("holds conductor when risk = 55 starting from conductor", () => {
    const result = routeTurn({ risk: 55, state: conductorState }, cfg)
    expect(result.tier).toBe("conductor")
    expect(result.reason).toContain("hysteresis band")
  })

  it("holds oracle when risk = 55 starting from oracle", () => {
    const result = routeTurn({ risk: 55, state: oracleState }, cfg)
    expect(result.tier).toBe("oracle")
    expect(result.reason).toContain("hysteresis band")
  })

  it("holds at exact lower boundary risk = 40", () => {
    const fromConductor = routeTurn({ risk: 40, state: conductorState }, cfg)
    const fromOracle = routeTurn({ risk: 40, state: oracleState }, cfg)
    expect(fromConductor.tier).toBe("conductor")
    expect(fromOracle.tier).toBe("oracle")
  })

  it("holds at exact upper boundary risk = 70", () => {
    const fromConductor = routeTurn({ risk: 70, state: conductorState }, cfg)
    const fromOracle = routeTurn({ risk: 70, state: oracleState }, cfg)
    expect(fromConductor.tier).toBe("conductor")
    expect(fromOracle.tier).toBe("oracle")
  })

  it("does NOT flap across a sequence: conductor → mid → mid → mid stays conductor", () => {
    // Sequence: low risk, then three mid-band turns — should never switch.
    let state: RouterState = { tier: "conductor" }

    // Turn 1: low risk → conductor confirmed
    state = routeTurn({ risk: 20, state }, cfg).state
    expect(state.tier).toBe("conductor")

    // Turns 2–4: mid-band (risk = 55) — should hold conductor throughout
    for (let i = 0; i < 3; i++) {
      const out = routeTurn({ risk: 55, state }, cfg)
      expect(out.tier).toBe("conductor")
      state = out.state
    }
  })

  it("does NOT flap: oracle → mid → mid → mid stays oracle", () => {
    let state: RouterState = { tier: "oracle" }

    // Escalate first
    state = routeTurn({ risk: 80, state }, cfg).state
    expect(state.tier).toBe("oracle")

    // Three mid-band turns — should hold oracle
    for (let i = 0; i < 3; i++) {
      const out = routeTurn({ risk: 55, state }, cfg)
      expect(out.tier).toBe("oracle")
      state = out.state
    }
  })
})

// ---------------------------------------------------------------------------
// forceTier override (S3.5 hook)
// ---------------------------------------------------------------------------

describe("routeTurn — forceTier override", () => {
  it("forces oracle regardless of low risk", () => {
    const result = routeTurn({ risk: 5, state: conductorState, forceTier: "oracle" }, cfg)
    expect(result.tier).toBe("oracle")
    expect(result.reason).toContain("forceTier")
  })

  it("forces conductor regardless of high risk", () => {
    const result = routeTurn({ risk: 95, state: oracleState, forceTier: "conductor" }, cfg)
    expect(result.tier).toBe("conductor")
    expect(result.reason).toContain("forceTier")
  })

  it("updates state to the forced tier", () => {
    const result = routeTurn({ risk: 5, state: conductorState, forceTier: "oracle" }, cfg)
    expect(result.state.tier).toBe("oracle")
  })
})

// ---------------------------------------------------------------------------
// abstain override (S3.3 hook)
// ---------------------------------------------------------------------------

describe("routeTurn — abstain override", () => {
  it("holds conductor when abstain=true even if risk > 70", () => {
    const result = routeTurn({ risk: 90, state: conductorState, abstain: true }, cfg)
    expect(result.tier).toBe("conductor")
    expect(result.reason).toContain("abstain")
  })

  it("holds oracle when abstain=true even if risk < 40", () => {
    const result = routeTurn({ risk: 5, state: oracleState, abstain: true }, cfg)
    expect(result.tier).toBe("oracle")
  })

  it("forceTier takes precedence over abstain", () => {
    // forceTier is evaluated before abstain in the current spec — if both set,
    // forceTier wins. (Documented behaviour; S3.3/S3.5 can revise if needed.)
    const result = routeTurn({ risk: 5, state: oracleState, abstain: true, forceTier: "conductor" }, cfg)
    expect(result.tier).toBe("conductor")
  })
})

// ---------------------------------------------------------------------------
// Custom config
// ---------------------------------------------------------------------------

describe("routeTurn — custom config", () => {
  it("respects custom escalateAbove band", () => {
    // stickinessMargin: 0 isolates the band test from AC-8.5 stickiness (default 10).
    const custom: RouterConfig = { escalateAbove: 50, deescalateBelow: 20, stickinessMargin: 0 }
    const result = routeTurn({ risk: 60, state: conductorState }, custom)
    expect(result.tier).toBe("oracle") // would be mid-band at default config
  })

  it("respects custom deescalateBelow band", () => {
    const custom: RouterConfig = { escalateAbove: 90, deescalateBelow: 60 }
    const result = routeTurn({ risk: 55, state: oracleState }, custom)
    expect(result.tier).toBe("conductor") // would be mid-band at default config
  })
})

// ---------------------------------------------------------------------------
// defaultRouterState
// ---------------------------------------------------------------------------

describe("defaultRouterState", () => {
  it("starts on conductor", () => {
    expect(defaultRouterState.tier).toBe("conductor")
  })

  it("new session with risk=0 stays conductor", () => {
    const result = routeTurn({ risk: 0, state: defaultRouterState }, cfg)
    expect(result.tier).toBe("conductor")
  })
})
