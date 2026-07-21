import { describe, expect, test } from "bun:test"
import { planRaiseForTurn, isEconTierAgent, ECON_TIER_AGENTS } from "../../src/session/tier-router"

// Turn-level tier routing was demoted 2026-07-06: the lead never swaps at
// turn-open; escalation is slice-level (allocateSlice + the escalation ladder). This module now
// owns only tier-agent identity and the OL-7.5 plan-reasoning raise.
describe("tier-router", () => {
  test("isEconTierAgent recognises the four tiers and rejects others", () => {
    for (const t of ["conductor", "executor", "oracle", "reasoner"]) expect(isEconTierAgent(t)).toBe(true)
    expect(isEconTierAgent("title")).toBe(false)
    expect(isEconTierAgent("general")).toBe(false)
    expect(ECON_TIER_AGENTS.size).toBe(4)
  })

  test("light prompt, no risk → no plan raise (conductor stays at baseline effort)", () => {
    expect(planRaiseForTurn({ prompt: "what is 2 + 2?" })).toBe(false)
    expect(planRaiseForTurn({ prompt: "rename this local variable", risk: 0 })).toBe(false)
  })

  test("heavy prompt raises plan reasoning regardless of risk", () => {
    expect(planRaiseForTurn({ prompt: "migrate all callers across every file to the new API" })).toBe(true)
    expect(planRaiseForTurn({ prompt: "refactor across multiple files", risk: 0 })).toBe(true)
  })

  test("structural risk at/above the mid-band floor raises plan reasoning on a light prompt", () => {
    expect(planRaiseForTurn({ prompt: "tweak the merge helper", risk: 45 })).toBe(true)
    expect(planRaiseForTurn({ prompt: "tweak the merge helper", risk: 10 })).toBe(false)
  })
})
