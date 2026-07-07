/**
 * rm-verifier.ts unit tests — flag-off byte-identical no-op, abstain-on-error
 * clean degrade, and the veto/accept paths with an injected client double.
 */

import { describe, it, expect } from "bun:test"
import {
  createRmVerifierRung,
  RmVerifierLedger,
  RM_ACCEPT_THRESHOLD,
  type RmClient,
  type RmMeterEvent,
} from "../src/rm-verifier.ts"
import { resolveVerifierTier } from "../src/model-registry.ts"
import type { SoundVerdict, BehaviorResult, SliceTrajectory } from "../src/verifier.ts"

const sound: SoundVerdict = { rung: "sound", pass: true, failures: [], applicable: false }
const behavior: BehaviorResult = { suspicious: false, flags: [] }
const trajectory: SliceTrajectory = { events: [] }
const ctx = { sound, behavior, trajectory }

describe("resolveVerifierTier", () => {
  it("is disabled when unset (default off)", () => {
    expect(resolveVerifierTier(undefined)).toEqual({ enabled: false })
  })

  it("is disabled for the literal string 'off'", () => {
    expect(resolveVerifierTier("off")).toEqual({ enabled: false })
  })

  it("is enabled with the endpoint for any other value", () => {
    expect(resolveVerifierTier("https://rm.example.com/score")).toEqual({
      enabled: true,
      endpoint: "https://rm.example.com/score",
    })
  })
})

describe("createRmVerifierRung — flag off ⇒ byte-identical no-op", () => {
  it("never calls the client and returns undefined when the tier is disabled", async () => {
    let called = false
    const client: RmClient = async () => {
      called = true
      return { score: 1 }
    }
    const rung = createRmVerifierRung(resolveVerifierTier(undefined), client)
    const verdict = await rung(ctx)
    expect(verdict).toBeUndefined()
    expect(called).toBe(false)
  })
})

describe("createRmVerifierRung — abstain on error (clean degrade)", () => {
  it("returns undefined and meters a degrade event when the client throws", async () => {
    const client: RmClient = async () => {
      throw new Error("endpoint unreachable")
    }
    const events: RmMeterEvent[] = []
    const rung = createRmVerifierRung(
      resolveVerifierTier("https://rm.example.com/score"),
      client,
      (e) => events.push(e),
    )
    const verdict = await rung(ctx)
    expect(verdict).toBeUndefined()
    expect(events).toHaveLength(1)
    expect(events[0]!.kind).toBe("degrade")
    expect(events[0]!.detail).toBe("endpoint unreachable")
  })

  it("returns undefined and meters a degrade event when the client's promise rejects (timeout)", async () => {
    const client: RmClient = () => Promise.reject(new Error("timeout"))
    const events: RmMeterEvent[] = []
    const rung = createRmVerifierRung(
      resolveVerifierTier("https://rm.example.com/score"),
      client,
      (e) => events.push(e),
    )
    const verdict = await rung(ctx)
    expect(verdict).toBeUndefined()
    expect(events[0]!.kind).toBe("degrade")
  })
})

describe("createRmVerifierRung — accept/reject with an injected client", () => {
  it("accepts when the score is at or above the threshold", async () => {
    const client: RmClient = async () => ({ score: RM_ACCEPT_THRESHOLD, detail: "looks correct" })
    const events: RmMeterEvent[] = []
    const rung = createRmVerifierRung(
      resolveVerifierTier("https://rm.example.com/score"),
      client,
      (e) => events.push(e),
    )
    const verdict = await rung(ctx)
    expect(verdict).toEqual({ rung: "rm", pass: true, detail: "looks correct" })
    expect(events[0]!.kind).toBe("accept")
  })

  it("rejects (vetoes) when the score is below the threshold", async () => {
    const client: RmClient = async () => ({ score: RM_ACCEPT_THRESHOLD - 0.1, detail: "wrong approach" })
    const events: RmMeterEvent[] = []
    const rung = createRmVerifierRung(
      resolveVerifierTier("https://rm.example.com/score"),
      client,
      (e) => events.push(e),
    )
    const verdict = await rung(ctx)
    expect(verdict).toEqual({ rung: "rm", pass: false, detail: "wrong approach" })
    expect(events[0]!.kind).toBe("reject")
  })
})

describe("RmVerifierLedger", () => {
  it("accumulates accept/reject/degrade counts and snapshots them", () => {
    const ledger = new RmVerifierLedger()
    ledger.add({ kind: "accept", timestamp: 1 })
    ledger.add({ kind: "accept", timestamp: 2 })
    ledger.add({ kind: "reject", timestamp: 3 })
    ledger.add({ kind: "degrade", timestamp: 4 })
    expect(ledger.snapshot).toEqual({ accepts: 2, rejects: 1, degrades: 1 })
  })
})
