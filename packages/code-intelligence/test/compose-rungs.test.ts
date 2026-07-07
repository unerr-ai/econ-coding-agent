/**
 * Tests for composeExtraRungs (OL-7.3b) — the combinator that folds the optional
 * RM rung and the optional judge rung into the verifier ladder's single extraRung
 * slot, in ladder order (RM first, judge on RM abstain).
 */

import { describe, it, expect } from "bun:test"
import { composeExtraRungs } from "../src/compose-rungs.js"
import type { ExtraRungFn, ExtraRungVerdict, SoundVerdict, BehaviorResult, SliceTrajectory } from "../src/verifier.js"

// A ladder ctx the injected rungs ignore — they return a fixed verdict.
const ctx: { sound: SoundVerdict; behavior: BehaviorResult; trajectory: SliceTrajectory } = {
  sound: { rung: "sound", pass: false, applicable: false, failures: [] },
  behavior: { suspicious: false, flags: [] },
  trajectory: { events: [] },
}

function rung(verdict: ExtraRungVerdict | undefined, calls: { n: number }): ExtraRungFn {
  return async () => {
    calls.n++
    return verdict
  }
}

describe("composeExtraRungs — matrix", () => {
  it("neither → undefined (no extension rung at all)", () => {
    expect(composeExtraRungs(undefined, undefined)).toBeUndefined()
  })

  it("rm-only → the rm rung itself (identity, no wrapper)", async () => {
    const calls = { n: 0 }
    const rm = rung({ rung: "rm", pass: true }, calls)
    const composed = composeExtraRungs(rm, undefined)
    expect(composed).toBe(rm)
    expect(await composed!(ctx)).toEqual({ rung: "rm", pass: true })
  })

  it("judge-only → the judge rung itself (identity, byte-identical to pre-RM path)", async () => {
    const calls = { n: 0 }
    const judge = rung({ rung: "judge", pass: false }, calls)
    const composed = composeExtraRungs(undefined, judge)
    expect(composed).toBe(judge)
    expect(await composed!(ctx)).toEqual({ rung: "judge", pass: false })
  })

  it("both, rm returns a verdict → rm wins and judge is never called (ladder order)", async () => {
    const rmCalls = { n: 0 }
    const judgeCalls = { n: 0 }
    const composed = composeExtraRungs(
      rung({ rung: "rm", pass: false }, rmCalls),
      rung({ rung: "judge", pass: true }, judgeCalls),
    )
    const verdict = await composed!(ctx)
    expect(verdict).toEqual({ rung: "rm", pass: false })
    expect(rmCalls.n).toBe(1)
    expect(judgeCalls.n).toBe(0)
  })

  it("both, rm abstains → falls through to judge", async () => {
    const rmCalls = { n: 0 }
    const judgeCalls = { n: 0 }
    const composed = composeExtraRungs(
      rung(undefined, rmCalls),
      rung({ rung: "judge", pass: true }, judgeCalls),
    )
    const verdict = await composed!(ctx)
    expect(verdict).toEqual({ rung: "judge", pass: true })
    expect(rmCalls.n).toBe(1)
    expect(judgeCalls.n).toBe(1)
  })

  it("both abstain → the composed rung abstains too (undefined)", async () => {
    const composed = composeExtraRungs(rung(undefined, { n: 0 }), rung(undefined, { n: 0 }))
    expect(await composed!(ctx)).toBeUndefined()
  })
})
