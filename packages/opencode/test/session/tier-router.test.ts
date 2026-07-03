import { describe, expect, test } from "bun:test"
import { resolveTier, clearTierState, isEconTierAgent } from "../../src/session/tier-router"

// OL-3.1/3.2/3.3 adapter: turn-open routing (triage + hysteresis + injected code-structural risk).
describe("tier-router", () => {
  test("isEconTierAgent recognises the four tiers and rejects others", () => {
    for (const t of ["conductor", "executor", "oracle", "reasoner"]) expect(isEconTierAgent(t)).toBe(true)
    expect(isEconTierAgent("title")).toBe(false)
    expect(isEconTierAgent("general")).toBe(false)
  })

  test("first turn with a light prompt is triaged to the cheap conductor", () => {
    const sid = "s-light"
    clearTierState(sid)
    const d = resolveTier({ sessionID: sid, prompt: "what is 2 + 2?" })
    expect(d.tier).toBe("conductor")
    expect(d.reason).toContain("triage")
  })

  test("a heavy first prompt skips triage and escalates to the reasoner", () => {
    const sid = "s-heavy"
    clearTierState(sid)
    const d = resolveTier({ sessionID: sid, prompt: "migrate all callers across every file to the new API" })
    expect(d.tier).toBe("reasoner")
  })

  test("hysteresis: after a heavy turn, a light follow-up de-escalates to conductor", () => {
    const sid = "s-hyst"
    clearTierState(sid)
    expect(resolveTier({ sessionID: sid, prompt: "refactor across multiple files" }).tier).toBe("reasoner")
    // light follow-up (not first turn, no hard signal) → risk < deescalateBelow → conductor
    expect(resolveTier({ sessionID: sid, prompt: "rename this local variable" }).tier).toBe("conductor")
  })

  test("OL-3.5: a prior-turn abstention force-escalates to the oracle, overriding triage", () => {
    const sid = "s-abstain"
    clearTierState(sid)
    // First turn would normally triage a light prompt to conductor — but the prior turn abstained.
    const d = resolveTier({ sessionID: sid, prompt: "what is 2 + 2?", priorAbstained: true })
    expect(d.tier).toBe("oracle")
    expect(d.reason).toContain("abstain")
  })

  test("no abstention → normal routing (light prompt stays conductor)", () => {
    const sid = "s-noabstain"
    clearTierState(sid)
    expect(resolveTier({ sessionID: sid, prompt: "what is 2 + 2?", priorAbstained: false }).tier).toBe("conductor")
  })

  test("OL-3.3: high code-structural risk lifts an otherwise light-looking prompt to the oracle", () => {
    const sid = "s-risk-high"
    clearTierState(sid)
    // Warm past turn 0 (triage's cheap-bias only applies on the first turn; the graph is cold there
    // anyway). Then a short prompt whose named entities are high-blast-radius: risk > escalateAbove +
    // stickinessMargin (70 + 10) escalates straight to the oracle despite the light-looking text.
    resolveTier({ sessionID: sid, prompt: "hello", risk: 0 })
    const d = resolveTier({ sessionID: sid, prompt: "tweak the config loader", risk: 85 })
    expect(d.tier).toBe("oracle")
  })

  test("OL-3.3: high risk on the FIRST turn overrides the triage cheap-bias → oracle", () => {
    const sid = "s-risk-first"
    clearTierState(sid)
    // Fresh session, light-looking first prompt that triage would normally pin to conductor — but the
    // named entity is a high-blast-radius hub (risk > 70). Structural risk wins over the turn-0 bias.
    const d = resolveTier({ sessionID: sid, prompt: "tweak the config loader", risk: 85 })
    expect(d.tier).toBe("oracle")
  })

  test("OL-3.3: low risk leaves a light non-first turn on the cheap conductor", () => {
    const sid = "s-risk-low"
    clearTierState(sid)
    // Warm the session past turn 0 so triage no longer applies, then a low-risk light turn.
    resolveTier({ sessionID: sid, prompt: "refactor across multiple files" })
    const d = resolveTier({ sessionID: sid, prompt: "rename a local", risk: 10 })
    expect(d.tier).toBe("conductor")
  })

  test("OL-3.3: omitted risk defaults to 0 (behaviour unchanged from before the graph wire)", () => {
    const sid = "s-risk-default"
    clearTierState(sid)
    const withZero = resolveTier({ sessionID: sid, prompt: "what is 2 + 2?", risk: 0 })
    clearTierState(sid)
    const omitted = resolveTier({ sessionID: sid, prompt: "what is 2 + 2?" })
    expect(omitted.tier).toBe(withZero.tier)
    expect(omitted.tier).toBe("conductor")
  })

  test("sessions hold independent hysteresis state", () => {
    const a = "s-a"
    const b = "s-b"
    clearTierState(a)
    clearTierState(b)
    resolveTier({ sessionID: a, prompt: "add authentication and payment handling" }) // heavy → reasoner on A
    const db = resolveTier({ sessionID: b, prompt: "print hello" }) // fresh B, light → conductor
    expect(db.tier).toBe("conductor")
  })
})
