/**
 * Feature-08 signal bus — the trace contract (one `[signal]` line per publish,
 * flattened evidence keys), the per-session ring buffer, the tail filter, the
 * once-per-turn deferral budget, and fresh-turn reset semantics.
 */
import { describe, expect, test } from "bun:test"
import {
  deferralAvailable,
  deferralBreakdownFor,
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

describe("deferralBreakdownFor — §10 Step 3 receipt telemetry", () => {
  test("empty session has zero total and a zero escalation rate", () => {
    const sessionID = freshSession()
    expect(deferralBreakdownFor(sessionID)).toEqual({ byComplaint: {}, byResponse: {}, escalationRate: 0 })
  })

  test("counts each consumer-record signal by its complaint (from evidence) and its response", () => {
    const sessionID = freshSession()
    publishSignal(
      signal(sessionID, {
        name: "deferral_verify_inline",
        severity: "tail",
        decision: "defer",
        evidence: { consumed: "unverified_finish", complaint: "verification", reason: "verification gap" },
      }),
    )
    publishSignal(
      signal(sessionID, {
        name: "deferral_declined",
        severity: "tail",
        decision: "surface",
        evidence: { consumed: "hub_bounce_repeat", complaint: "corrected", reason: "already corrected" },
      }),
    )
    const breakdown = deferralBreakdownFor(sessionID)
    expect(breakdown.byComplaint).toEqual({ verification: 1, corrected: 1 })
    expect(breakdown.byResponse).toEqual({ "verify-inline": 1, none: 1 })
    expect(breakdown.escalationRate).toBe(0)
  })

  test("deferral_armed counts as escalate and drives the escalation rate", () => {
    const sessionID = freshSession()
    publishSignal(
      signal(sessionID, {
        name: "deferral_verify_inline",
        severity: "tail",
        decision: "defer",
        evidence: { consumed: "unverified_finish", complaint: "verification", reason: "verification gap" },
      }),
    )
    publishSignal(
      signal(sessionID, {
        name: "deferral_armed",
        severity: "tail",
        decision: "defer",
        evidence: { consumed: "unverified_finish" },
      }),
    )
    const breakdown = deferralBreakdownFor(sessionID)
    expect(breakdown.byResponse).toEqual({ "verify-inline": 1, escalate: 1 })
    expect(breakdown.escalationRate).toBeCloseTo(0.5)
  })

  test("non-deferral signals are ignored", () => {
    const sessionID = freshSession()
    publishSignal(signal(sessionID)) // "probe_gate_reject" — not a deferral consumer-record signal
    expect(deferralBreakdownFor(sessionID)).toEqual({ byComplaint: {}, byResponse: {}, escalationRate: 0 })
  })
})
