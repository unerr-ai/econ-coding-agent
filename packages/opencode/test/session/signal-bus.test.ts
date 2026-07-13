/**
 * Feature-08 signal bus — the trace contract (one `[signal]` line per publish,
 * flattened evidence keys), the per-session ring buffer, the tail filter, the
 * once-per-turn deferral budget, and fresh-turn reset semantics.
 */
import { describe, expect, test } from "bun:test"
import {
  deferralAvailable,
  markDeferralUsed,
  publishSignal,
  resetSignals,
  signalSummary,
  signalsFor,
  summaryLogLine,
  tailSignals,
  type EconSignal,
} from "../../src/session/signal-bus"

let counter = 0
function freshSession(): string {
  counter += 1
  return `ses_signal_bus_test_${counter}`
}

function signal(sessionID: string, overrides: Partial<EconSignal> = {}): EconSignal {
  return {
    name: "probe_gate_reject",
    sessionID,
    step: 7,
    severity: "info",
    decision: "convert",
    evidence: { probe: "python repro_issue.py", exitCode: 1 },
    ...overrides,
  }
}

describe("publishSignal", () => {
  test("records the signal and returns the one [signal] trace line with flattened evidence", () => {
    const sessionID = freshSession()
    const line = publishSignal(signal(sessionID))
    expect(line.message).toBe("[signal] probe_gate_reject")
    expect(line.payload["session.id"]).toBe(sessionID)
    expect(line.payload["severity"]).toBe("info")
    expect(line.payload["decision"]).toBe("convert")
    expect(line.payload["step"]).toBe(7)
    expect(line.payload["evidence.probe"]).toBe("python repro_issue.py")
    expect(line.payload["evidence.exitCode"]).toBe(1)
    expect(signalsFor(sessionID)).toHaveLength(1)
    expect(signalsFor(sessionID)[0]?.name).toBe("probe_gate_reject")
  })

  test("missing step logs as null (grep-stable payload shape)", () => {
    const sessionID = freshSession()
    const line = publishSignal(signal(sessionID, { step: undefined }))
    expect(line.payload["step"]).toBeNull()
  })

  test("ring buffer drops the OLDEST signals past the cap, never grows unbounded", () => {
    const sessionID = freshSession()
    for (let i = 0; i < 205; i++) publishSignal(signal(sessionID, { evidence: { i } }))
    const buffered = signalsFor(sessionID)
    expect(buffered).toHaveLength(200)
    expect(buffered[0]?.evidence["i"]).toBe(5)
    expect(buffered[199]?.evidence["i"]).toBe(204)
  })

  test("sessions are isolated", () => {
    const a = freshSession()
    const b = freshSession()
    publishSignal(signal(a))
    expect(signalsFor(a)).toHaveLength(1)
    expect(signalsFor(b)).toHaveLength(0)
  })
})

describe("tailSignals", () => {
  test("filters to the hard-tail subset the deferral consumer routes on", () => {
    const sessionID = freshSession()
    publishSignal(signal(sessionID))
    publishSignal(signal(sessionID, { name: "probe_gate_exhausted", severity: "tail", decision: "defer" }))
    publishSignal(signal(sessionID, { name: "hub_bounce_repeat", severity: "tail", decision: "defer" }))
    const tail = tailSignals(sessionID)
    expect(tail).toHaveLength(2)
    expect(tail.map((s) => s.name)).toEqual(["probe_gate_exhausted", "hub_bounce_repeat"])
  })
})

describe("deferral budget", () => {
  test("available once per turn, spent by markDeferralUsed, restored by resetSignals", () => {
    const sessionID = freshSession()
    expect(deferralAvailable(sessionID)).toBe(true)
    markDeferralUsed(sessionID)
    expect(deferralAvailable(sessionID)).toBe(false)
    resetSignals(sessionID)
    expect(deferralAvailable(sessionID)).toBe(true)
  })
})

describe("resetSignals", () => {
  test("clears the buffer at fresh-turn open", () => {
    const sessionID = freshSession()
    publishSignal(signal(sessionID))
    resetSignals(sessionID)
    expect(signalsFor(sessionID)).toHaveLength(0)
  })
})

describe("turn summary", () => {
  test("counts by name and reports the deferral budget", () => {
    const sessionID = freshSession()
    publishSignal(signal(sessionID))
    publishSignal(signal(sessionID))
    publishSignal(signal(sessionID, { name: "unverified_finish" }))
    expect(signalSummary(sessionID)).toEqual({ probe_gate_reject: 2, unverified_finish: 1 })
    const line = summaryLogLine(sessionID)
    expect(line.message).toBe("[signal] turn_summary")
    expect(line.payload["counts"]).toEqual({ probe_gate_reject: 2, unverified_finish: 1 })
    expect(line.payload["deferralAvailable"]).toBe(true)
  })
})
