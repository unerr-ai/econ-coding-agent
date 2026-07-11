/**
 * Unit tests for orchestration-fsm.ts — the pure squeeze-then-climb slice
 * reducer and the stuck supervisor. Everything is deterministic (no clock,
 * no randomness): the tier ladder, retry budgets, and climb ceiling are all
 * injected via `SliceTransitionCtx`, so every transition is table-tested
 * without a live model or shell.
 *
 * Covers `sliceTransition`: accept-first, reject→squeeze→accept (escalated),
 * unchanged-signature stall skips the squeeze, the same-tier retry budget,
 * a read-only slice never squeezing/climbing, a critical slice bounded by
 * the same maxClimbs as any other slice (no extra forced climbs) that
 * settles unverified LOUD for review on exhaustion, plain ladder
 * exhaustion, budget-exhausted → abandoned, and the terminal-is-absorbing
 * re-dispatch guard (run-8).
 *
 * Covers `createStuckSupervisor`: test-edit priority, repeated-red
 * (tolerating interleaved non-command steps), repeated-tool, a changing
 * signature never firing, no-progress after stagnant fingerprints, and
 * reset() clearing all internal counters.
 */

import { describe, it, expect } from "bun:test"
import {
  sliceTransition,
  initialSliceState,
  createStuckSupervisor,
  type SliceTransitionCtx,
  type SliceMachineState,
  type SliceEvent,
  type StuckSupervisorConfig,
} from "../src/orchestration-fsm.js"
import type { EconTier } from "../src/region.js"

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** A small, deterministic tier ladder: executor → conductor → reasoner → oracle. */
const LADDER: EconTier[] = ["executor", "conductor", "reasoner", "oracle"]

/**
 * Builds a `SliceTransitionCtx` over `LADDER`. `sliceCeiling` is the tier at
 * which `escalate` stops returning a next tier (the slice's own allowed cap,
 * which may sit below the global ladder top).
 */
function makeCtx(opts: {
  sliceCeiling?: EconTier
  sameTierRetryBudget?: number
  maxClimbs?: number
  maxAttempts?: number
  isReadOnly?: boolean
  isCritical?: boolean
}): SliceTransitionCtx {
  const sliceCeiling = opts.sliceCeiling ?? "oracle"
  const ceilingIdx = LADDER.indexOf(sliceCeiling)
  return {
    sameTierRetryBudget: opts.sameTierRetryBudget ?? 2,
    maxClimbs: opts.maxClimbs ?? 1,
    maxAttempts: opts.maxAttempts ?? 8,
    isReadOnly: opts.isReadOnly ?? false,
    isCritical: opts.isCritical ?? false,
    escalate: (tier: EconTier) => {
      const i = LADDER.indexOf(tier)
      if (i >= ceilingIdx) return undefined
      return LADDER[i + 1]
    },
  }
}

const reject = (signature: string): SliceEvent => ({
  type: "verdict",
  verdict: { accepted: false, signature },
})
const accept = (signature = "ok"): SliceEvent => ({
  type: "verdict",
  verdict: { accepted: true, signature },
})

// ---------------------------------------------------------------------------
// sliceTransition
// ---------------------------------------------------------------------------

describe("sliceTransition", () => {
  it("accepts on the first verdict → terminal accepted", () => {
    const ctx = makeCtx({})
    const state = initialSliceState("executor")
    const next = sliceTransition(state, accept(), ctx)
    expect(next.phase).toBe("settled")
    expect(next.terminal?.outcome).toBe("accepted")
    expect(next.terminal?.atTier).toBe("executor")
    expect(next.terminal?.attempts).toBe(1)
  })

  it("reject (new signature) then accept → terminal escalated, phase went through squeezing", () => {
    const ctx = makeCtx({})
    let state = initialSliceState("executor")
    state = sliceTransition(state, reject("sig-1"), ctx)
    expect(state.phase).toBe("squeezing")
    expect(state.terminal).toBeUndefined()

    state = sliceTransition(state, accept(), ctx)
    expect(state.phase).toBe("settled")
    expect(state.terminal?.outcome).toBe("escalated")
    expect(state.terminal?.atTier).toBe("executor")
    expect(state.terminal?.attempts).toBe(2)
  })

  it("reject with an unchanged signature (stall) does not squeeze again — climbs instead", () => {
    const ctx = makeCtx({})
    let state = initialSliceState("executor")
    state = sliceTransition(state, reject("same-sig"), ctx)
    expect(state.phase).toBe("squeezing")
    expect(state.sameTierRetries).toBe(1)

    // same signature again — no new evidence, so the squeeze budget is not consumed
    state = sliceTransition(state, reject("same-sig"), ctx)
    expect(state.phase).toBe("climbing")
    expect(state.atTier).toBe("conductor")
    expect(state.climbs).toBe(1)
    expect(state.sameTierRetries).toBe(0) // reset on climb
  })

  it("respects sameTierRetryBudget — squeezes at most that many times before climbing", () => {
    const ctx = makeCtx({ sameTierRetryBudget: 2, maxClimbs: 1 })
    let state = initialSliceState("executor")

    state = sliceTransition(state, reject("a"), ctx)
    expect(state.phase).toBe("squeezing")
    expect(state.sameTierRetries).toBe(1)

    state = sliceTransition(state, reject("b"), ctx)
    expect(state.phase).toBe("squeezing")
    expect(state.sameTierRetries).toBe(2)

    // third reject: budget (2) exhausted even though the signature is still changing
    state = sliceTransition(state, reject("c"), ctx)
    expect(state.phase).toBe("climbing")
    expect(state.atTier).toBe("conductor")
    expect(state.attempts).toBe(4)
  })

  it("a read-only slice (isReadOnly, maxClimbs:0) never squeezes or climbs — settles unverified immediately", () => {
    const ctx = makeCtx({ isReadOnly: true, maxClimbs: 0 })
    const state = initialSliceState("executor")
    const next = sliceTransition(state, reject("sig"), ctx)

    expect(next.phase).toBe("settled")
    expect(next.terminal?.outcome).toBe("unverified")
    expect(next.terminal?.atTier).toBe("executor")
    expect(next.terminal?.attempts).toBe(1)
  })

  it("a critical slice is bounded by maxClimbs like any other slice — climbs once then settles unverified/critical-unverified-review", () => {
    // sliceCeiling ("reasoner") sits well above maxClimbs' bound (1), so this
    // proves the cap is maxClimbs, not the slice's own escalate() ceiling —
    // criticality buys no extra climb over a non-critical slice.
    const ctx = makeCtx({
      sliceCeiling: "reasoner",
      maxClimbs: 1,
      sameTierRetryBudget: 0, // never squeeze — isolate the climb behavior
      isCritical: true,
    })
    let state = initialSliceState("executor")

    state = sliceTransition(state, reject("s"), ctx)
    expect(state.phase).toBe("climbing")
    expect(state.atTier).toBe("conductor")
    expect(state.climbs).toBe(1)

    // climbs (1) now equals maxClimbs (1) — no further climb allowed, even
    // though the slice's own ceiling ("reasoner") is still above it.
    state = sliceTransition(state, reject("s"), ctx)
    expect(state.phase).toBe("settled")
    expect(state.climbs).toBe(1) // never exceeds maxClimbs
    expect(state.terminal?.outcome).toBe("unverified")
    expect(state.terminal?.atTier).toBe("conductor")
    expect(state.terminal?.reason).toBe("critical-unverified-review")
  })

  it("non-critical exhaustion settles unverified with reason ladder-exhausted", () => {
    const ctx = makeCtx({ maxClimbs: 1, sameTierRetryBudget: 0 })
    let state = initialSliceState("executor")

    state = sliceTransition(state, reject("s"), ctx)
    expect(state.phase).toBe("climbing")
    expect(state.atTier).toBe("conductor")

    // climbs (1) now equals maxClimbs (1) — no further climb allowed
    state = sliceTransition(state, reject("s"), ctx)
    expect(state.phase).toBe("settled")
    expect(state.terminal?.outcome).toBe("unverified")
    expect(state.terminal?.atTier).toBe("conductor")
    expect(state.terminal?.reason).toBe("ladder-exhausted")
  })

  it("a budget-exhausted event settles abandoned, with and without an explicit reason", () => {
    const ctx = makeCtx({})
    const withReason = sliceTransition(
      initialSliceState("executor"),
      { type: "budget-exhausted", reason: "overall-loop-timeout" },
      ctx,
    )
    expect(withReason.terminal?.outcome).toBe("abandoned")
    expect(withReason.terminal?.reason).toBe("overall-loop-timeout")

    const withoutReason = sliceTransition(
      initialSliceState("executor"),
      { type: "budget-exhausted" },
      ctx,
    )
    expect(withoutReason.terminal?.outcome).toBe("abandoned")
    expect(withoutReason.terminal?.reason).toBe("budget-exhausted")
  })

  it("a terminal state is absorbing — re-applying any event returns it unchanged (run-8 re-dispatch guard)", () => {
    const ctx = makeCtx({})
    const settled = sliceTransition(initialSliceState("executor"), accept(), ctx)
    expect(settled.terminal).toBeDefined()

    const reapplied1 = sliceTransition(settled, accept(), ctx)
    const reapplied2 = sliceTransition(settled, reject("anything"), ctx)
    const reapplied3 = sliceTransition(settled, { type: "budget-exhausted" }, ctx)

    expect(reapplied1).toBe(settled) // same reference — no new object allocated
    expect(reapplied2).toBe(settled)
    expect(reapplied3).toBe(settled)
  })
})

// ---------------------------------------------------------------------------
// createStuckSupervisor
// ---------------------------------------------------------------------------

describe("createStuckSupervisor", () => {
  const DEFAULT: StuckSupervisorConfig = { repeatThreshold: 3, noopThreshold: 3, rereadThreshold: 5 }

  it("a test-edit observation fires immediately — highest priority, overrides everything else", () => {
    const sup = createStuckSupervisor(DEFAULT)
    const signal = sup.observe({
      toolSignature: "edit|args-1",
      resultSignature: "0|clean", // would not otherwise be enough to fire on its own
      editedTestFile: "src/foo.test.ts",
    })
    expect(signal).toEqual({ reason: "test-edit", signature: "src/foo.test.ts", count: 1 })
  })

  it("the same resultSignature seen repeatThreshold times fires repeated-red, tolerating interleaved non-command steps", () => {
    const sup = createStuckSupervisor(DEFAULT)

    expect(sup.observe({ toolSignature: "t1", resultSignature: "1|fail" })).toBeUndefined()
    // a non-command step (no resultSignature) interleaved — must not reset the red tally
    expect(sup.observe({ toolSignature: "t2" })).toBeUndefined()
    expect(sup.observe({ toolSignature: "t3", resultSignature: "1|fail" })).toBeUndefined()
    expect(sup.observe({ toolSignature: "t4" })).toBeUndefined()

    const signal = sup.observe({ toolSignature: "t5", resultSignature: "1|fail" })
    expect(signal).toEqual({ reason: "repeated-red", signature: "1|fail", count: 3 })
  })

  it("reclassifies repeated-red as environment-slow when any run in the streak carries the slow-command signal", () => {
    const sup = createStuckSupervisor(DEFAULT)

    // only the 1st and 3rd runs are flagged slow — one slow run in the streak is enough
    expect(sup.observe({ toolSignature: "t1", resultSignature: "1|fail", slowCommand: true })).toBeUndefined()
    expect(sup.observe({ toolSignature: "t2", resultSignature: "1|fail" })).toBeUndefined()

    const signal = sup.observe({ toolSignature: "t3", resultSignature: "1|fail", slowCommand: true })
    expect(signal).toEqual({ reason: "environment-slow", signature: "1|fail", count: 3 })
  })

  it("the same toolSignature repeated repeatThreshold times fires repeated-tool", () => {
    const sup = createStuckSupervisor(DEFAULT)

    expect(sup.observe({ toolSignature: "read|foo.ts" })).toBeUndefined()
    expect(sup.observe({ toolSignature: "read|foo.ts" })).toBeUndefined()

    const signal = sup.observe({ toolSignature: "read|foo.ts" })
    expect(signal).toEqual({ reason: "repeated-tool", signature: "read|foo.ts", count: 3 })
  })

  it("no-op fires after noopThreshold empty (no-operation) steps in a row", () => {
    const sup = createStuckSupervisor(DEFAULT)
    // an empty signature = the step performed no operation at all
    expect(sup.observe({ toolSignature: "" })).toBeUndefined()
    expect(sup.observe({ toolSignature: "" })).toBeUndefined()
    const signal = sup.observe({ toolSignature: "" })
    expect(signal).toEqual({ reason: "no-op", signature: "", count: 3 })
  })

  it("a real operation between empty steps resets the no-op run", () => {
    const sup = createStuckSupervisor(DEFAULT)
    expect(sup.observe({ toolSignature: "" })).toBeUndefined()
    expect(sup.observe({ toolSignature: "" })).toBeUndefined()
    expect(sup.observe({ toolSignature: "read:a#h1" })).toBeUndefined() // a real op resets the no-op run
    expect(sup.observe({ toolSignature: "" })).toBeUndefined()
    expect(sup.observe({ toolSignature: "" })).toBeUndefined()
    // only 2 consecutive empties since the reset → still no fire
    expect(sup.observe({ toolSignature: "read:b#h2" })).toBeUndefined()
  })

  it("a changing signature never fires — no premature stuck signal", () => {
    const sup = createStuckSupervisor(DEFAULT)
    for (let i = 0; i < 5; i++) {
      const signal = sup.observe({ toolSignature: `tool-${i}`, resultSignature: `${i}|out` })
      expect(signal).toBeUndefined()
    }
  })

  it("excessive-reread fires when one file is read rereadThreshold times without progress", () => {
    const sup = createStuckSupervisor(DEFAULT) // rereadThreshold 5
    // distinct signatures (different offsets) so exact-duplicate cannot fire first —
    // isolates the per-file reread tally
    for (let i = 0; i < 4; i++) {
      expect(sup.observe({ toolSignature: `read:foo.ts#h${i}`, readFiles: ["foo.ts"] })).toBeUndefined()
    }
    const signal = sup.observe({ toolSignature: "read:foo.ts#h5", readFiles: ["foo.ts"] })
    expect(signal).toEqual({ reason: "excessive-reread", signature: "foo.ts", count: 5 })
  })

  it("a productive step (progressed) clears the reread tally — re-verifying reads never fire", () => {
    const sup = createStuckSupervisor(DEFAULT)
    for (let i = 0; i < 4; i++) {
      expect(sup.observe({ toolSignature: `read:foo.ts#h${i}`, readFiles: ["foo.ts"] })).toBeUndefined()
    }
    // an edit lands → the reread tally clears
    expect(sup.observe({ toolSignature: "edit:foo.ts#e1", progressed: true })).toBeUndefined()
    // reads resume from zero → four more do not fire
    for (let i = 0; i < 4; i++) {
      expect(sup.observe({ toolSignature: `read:foo.ts#g${i}`, readFiles: ["foo.ts"] })).toBeUndefined()
    }
  })

  it("reading DIFFERENT files never trips excessive-reread", () => {
    const sup = createStuckSupervisor(DEFAULT)
    for (let i = 0; i < 8; i++) {
      expect(sup.observe({ toolSignature: `read:f${i}.ts#h${i}`, readFiles: [`f${i}.ts`] })).toBeUndefined()
    }
  })

  it("reset() clears all internal counters", () => {
    const sup = createStuckSupervisor(DEFAULT)

    // build up state on every counter without tripping any of them
    expect(sup.observe({ toolSignature: "tool-x", resultSignature: "red-x" })).toBeUndefined()
    expect(sup.observe({ toolSignature: "tool-x", resultSignature: "red-x" })).toBeUndefined()

    sup.reset()

    // if state were not cleared, this next identical observation would tip the
    // (pre-reset) count of 2 to 3 and fire — asserting undefined proves the reset
    expect(sup.observe({ toolSignature: "tool-x", resultSignature: "red-x" })).toBeUndefined()
  })
})
