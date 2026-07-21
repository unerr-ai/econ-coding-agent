/**
 * escalation-economics.md §10 Step 1 — the deferral response ladder.
 * Unit coverage for the pure policy (`decideDeferralResponse`) and its
 * ledger fold (`recordDeferralResponse`): per-complaint response choice, the
 * verification complaint's terminal contract (never escalates, at any repeat
 * count — confirmed live: escalation-economics.md §1.1),
 * the knowledge/capability exhaustion transitions to escalate, the
 * unknown-signal fail-safe, and the turn-wide `CHEAP_RESPONSE_BUDGET` bound
 * (now scoped to the knowledge complaint only — verification is exempt from
 * it, and capability has no cheap answer to spend in the first place).
 */
import { describe, expect, test } from "bun:test"
import {
  CHEAP_RESPONSE_BUDGET,
  COMPLAINT_BY_SIGNAL,
  decideDeferralResponse,
  recordDeferralResponse,
  type DeferralComplaint,
  type DeferralPolicyVerdict,
  type DeferralResponse,
} from "../../src/session/deferral-policy"

describe("decideDeferralResponse — corrected complaint (hub_bounce_repeat)", () => {
  test("never escalates on the first firing", () => {
    const verdict = decideDeferralResponse({ signal: "hub_bounce_repeat", priorResponses: {}, cheapResponsesSpent: 0 })
    expect(verdict.complaint).toBe("corrected")
    expect(verdict.response).toBe("none")
    expect(verdict.escalationEarned).toBe(false)
  })

  test("never escalates even on a repeat firing with a full response history — the lagging-indicator complaint has no exhaustion path", () => {
    const priorResponses: Partial<Record<DeferralComplaint, readonly DeferralResponse[]>> = {
      corrected: ["none", "none", "none"],
    }
    const verdict = decideDeferralResponse({ signal: "hub_bounce_repeat", priorResponses, cheapResponsesSpent: 0 })
    expect(verdict.response).toBe("none")
    expect(verdict.escalationEarned).toBe(false)
  })
})

describe("decideDeferralResponse — verification complaint", () => {
  const VERIFICATION_SIGNALS = [
    "probe_gate_exhausted",
    "unverified_finish",
    "seen_red_unresolved",
    "fidelity_finish_reject",
    "promoted_pin_green",
    "oracle_inversion",
    "regression_red",
  ] as const

  test("every verification-mapped signal answers with verify-inline on the first firing, never escalating", () => {
    for (const signal of VERIFICATION_SIGNALS) {
      const verdict = decideDeferralResponse({ signal, priorResponses: {}, cheapResponsesSpent: 0 })
      expect(verdict.complaint).toBe("verification")
      expect(verdict.response).toBe("verify-inline")
      expect(verdict.escalationEarned).toBe(false)
    }
  })

  test("terminal: a repeat firing after verify-inline was already spent declines with none, never escalate — asking once and then declining ends the ladder instead of re-nudging (a repeated verify-inline would re-loop the finish gate forever, prompt.ts:3678); confirmed live that the OLD escalated path converted zero source edits across up to 4 repeat firings (escalation-economics.md §1.1)", () => {
    const priorResponses = { verification: ["verify-inline"] as readonly DeferralResponse[] }
    const verdict = decideDeferralResponse({ signal: "unverified_finish", priorResponses, cheapResponsesSpent: 1 })
    expect(verdict.complaint).toBe("verification")
    expect(verdict.response).toBe("none")
    expect(verdict.escalationEarned).toBe(false)
  })

  test("a DIFFERENT verification signal also stays terminal once verify-inline was spent for the shared complaint class", () => {
    const priorResponses = { verification: ["verify-inline"] as readonly DeferralResponse[] }
    const verdict = decideDeferralResponse({ signal: "regression_red", priorResponses, cheapResponsesSpent: 1 })
    expect(verdict.response).toBe("none")
    expect(verdict.escalationEarned).toBe(false)
  })

  test("never escalates no matter how many times the same complaint fires or how spent the turn's cheap-response budget is — verification is exempt from CHEAP_RESPONSE_BUDGET, unlike knowledge; a repeat firing declines with none rather than re-asking", () => {
    const priorResponses = { verification: ["verify-inline"] as readonly DeferralResponse[] }
    const verdict = decideDeferralResponse({
      signal: "seen_red_unresolved",
      priorResponses,
      cheapResponsesSpent: CHEAP_RESPONSE_BUDGET + 5,
    })
    expect(verdict.response).toBe("none")
    expect(verdict.escalationEarned).toBe(false)
  })
})

describe("decideDeferralResponse — knowledge complaint (knowledgeGap override)", () => {
  test("knowledgeGap:true overrides the signal table on the first firing, even for a signal mapped elsewhere", () => {
    const verdict = decideDeferralResponse({
      signal: "hub_bounce_repeat", // normally "corrected"
      priorResponses: {},
      cheapResponsesSpent: 0,
      knowledgeGap: true,
    })
    expect(verdict.complaint).toBe("knowledge")
    expect(verdict.response).toBe("knowledge-fetch")
    expect(verdict.escalationEarned).toBe(false)
  })

  test("exhaustion transition: a second knowledge-gap firing after knowledge-fetch was already spent escalates", () => {
    const priorResponses = { knowledge: ["knowledge-fetch"] as readonly DeferralResponse[] }
    const verdict = decideDeferralResponse({
      signal: "unverified_finish",
      priorResponses,
      cheapResponsesSpent: 1,
      knowledgeGap: true,
    })
    expect(verdict.complaint).toBe("knowledge")
    expect(verdict.response).toBe("escalate")
    expect(verdict.escalationEarned).toBe(true)
  })

  test("knowledgeGap:false (or absent) falls back to the signal table unchanged", () => {
    const verdict = decideDeferralResponse({
      signal: "hub_bounce_repeat",
      priorResponses: {},
      cheapResponsesSpent: 0,
      knowledgeGap: false,
    })
    expect(verdict.complaint).toBe("corrected")
  })
})

describe("decideDeferralResponse — capability complaint (fail-safe)", () => {
  test("an unlisted signal falls through to capability and escalates immediately — a new arm fails LOUD, never silently swallowed", () => {
    const verdict = decideDeferralResponse({
      signal: "some_future_arm_not_in_the_table",
      priorResponses: {},
      cheapResponsesSpent: 0,
    })
    expect(verdict.complaint).toBe("capability")
    expect(verdict.response).toBe("escalate")
    expect(verdict.escalationEarned).toBe(true)
  })

  test("capability escalates even with an empty ledger — no cheaper response exists to try first", () => {
    const verdict = decideDeferralResponse({ signal: "totally_unknown", priorResponses: {}, cheapResponsesSpent: 0 })
    expect(verdict.response).toBe("escalate")
  })
})

// escalation-economics.md follow-up (coordinator fix) — CHEAP_RESPONSE_BUDGET
// restores the one-rung-per-TURN bound `markDeferralUsed` used to enforce
// before this ladder existed. `cheapResponsesSpent` is turn-wide, counted
// across every complaint class — not per-complaint like `priorResponses`.
describe("decideDeferralResponse — CHEAP_RESPONSE_BUDGET turn-wide bound", () => {
  test("CHEAP_RESPONSE_BUDGET is 1 — the same one-rung bound markDeferralUsed enforced before this ladder existed", () => {
    expect(CHEAP_RESPONSE_BUDGET).toBe(1)
  })

  test("a DIFFERENT complaint class escalates once the turn's cheap-response budget is spent — it does not buy its own rung", () => {
    // First firing: a verification-mapped signal spends the turn's one cheap
    // rung (verify-inline, escalationEarned:false) — mirrors armDeferral's
    // own sequence of decide → record.
    const first = decideDeferralResponse({ signal: "unverified_finish", priorResponses: {}, cheapResponsesSpent: 0 })
    expect(first.response).toBe("verify-inline")
    const ledger = recordDeferralResponse({}, first)

    // Second firing this SAME turn: a knowledge-gap complaint — a DIFFERENT
    // complaint class, so priorResponses.knowledge is empty and would
    // ordinarily also answer knowledge-fetch — but cheapResponsesSpent now
    // reflects the rung already spent above, so it must escalate instead of
    // buying a second cheap rung.
    const second = decideDeferralResponse({
      signal: "hub_bounce_repeat", // irrelevant here — overridden by knowledgeGap
      priorResponses: ledger,
      cheapResponsesSpent: 1,
      knowledgeGap: true,
    })
    expect(second.complaint).toBe("knowledge")
    expect(second.response).toBe("escalate")
    expect(second.escalationEarned).toBe(true)
  })

  test("corrected still declines for free even when the cheap-response budget is already spent — it costs no rung, so the cap does not apply to it", () => {
    const verdict = decideDeferralResponse({
      signal: "hub_bounce_repeat",
      priorResponses: {},
      cheapResponsesSpent: CHEAP_RESPONSE_BUDGET,
    })
    expect(verdict.complaint).toBe("corrected")
    expect(verdict.response).toBe("none")
    expect(verdict.escalationEarned).toBe(false)
  })

  test("boundary (knowledge complaint): cheapResponsesSpent one below the budget still buys the cheap response; at the budget it escalates — verification no longer has this boundary (it is exempt, see the verification describe block), so knowledge is the only complaint left to exercise it", () => {
    const underBudget = decideDeferralResponse({
      signal: "hub_bounce_repeat", // irrelevant — overridden by knowledgeGap
      priorResponses: {},
      cheapResponsesSpent: CHEAP_RESPONSE_BUDGET - 1,
      knowledgeGap: true,
    })
    expect(underBudget.response).toBe("knowledge-fetch")

    const atBudget = decideDeferralResponse({
      signal: "hub_bounce_repeat",
      priorResponses: {},
      cheapResponsesSpent: CHEAP_RESPONSE_BUDGET,
      knowledgeGap: true,
    })
    expect(atBudget.response).toBe("escalate")
  })

  test("verification ignores this bound entirely — at/above the budget it still answers verify-inline, never escalate (contrast with the knowledge boundary above)", () => {
    const atBudget = decideDeferralResponse({
      signal: "regression_red",
      priorResponses: {},
      cheapResponsesSpent: CHEAP_RESPONSE_BUDGET,
    })
    expect(atBudget.response).toBe("verify-inline")
    expect(atBudget.escalationEarned).toBe(false)
  })
})

describe("COMPLAINT_BY_SIGNAL — table shape", () => {
  test("hub_bounce_repeat is the only signal mapped to corrected", () => {
    const corrected = Object.entries(COMPLAINT_BY_SIGNAL).filter(([, c]) => c === "corrected")
    expect(corrected).toEqual([["hub_bounce_repeat", "corrected"]])
  })

  test("no signal maps to knowledge — that complaint is reached only via the knowledgeGap override", () => {
    const knowledge = Object.values(COMPLAINT_BY_SIGNAL).filter((c) => c === "knowledge")
    expect(knowledge).toHaveLength(0)
  })
})

describe("recordDeferralResponse — ledger fold", () => {
  test("appends a new response under its complaint class", () => {
    const verdict: DeferralPolicyVerdict = {
      complaint: "verification",
      response: "verify-inline",
      reason: "test",
      escalationEarned: false,
    }
    const next = recordDeferralResponse({}, verdict)
    expect(next).toEqual({ verification: ["verify-inline"] })
  })

  test("is additive across complaint classes — recording one complaint never disturbs another", () => {
    const ledger: Partial<Record<DeferralComplaint, readonly DeferralResponse[]>> = {
      knowledge: ["knowledge-fetch"],
    }
    const verdict: DeferralPolicyVerdict = {
      complaint: "verification",
      response: "verify-inline",
      reason: "test",
      escalationEarned: false,
    }
    const next = recordDeferralResponse(ledger, verdict)
    expect(next).toEqual({ knowledge: ["knowledge-fetch"], verification: ["verify-inline"] })
  })

  test("does not duplicate the same response recorded twice for the same complaint", () => {
    const ledger: Partial<Record<DeferralComplaint, readonly DeferralResponse[]>> = {
      verification: ["verify-inline"],
    }
    const verdict: DeferralPolicyVerdict = {
      complaint: "verification",
      response: "verify-inline",
      reason: "repeat",
      escalationEarned: false,
    }
    const next = recordDeferralResponse(ledger, verdict)
    expect(next).toEqual({ verification: ["verify-inline"] })
  })

  test("never mutates the input ledger (pure)", () => {
    const ledger: Partial<Record<DeferralComplaint, readonly DeferralResponse[]>> = { corrected: ["none"] }
    const verdict: DeferralPolicyVerdict = {
      complaint: "capability",
      response: "escalate",
      reason: "test",
      escalationEarned: true,
    }
    recordDeferralResponse(ledger, verdict)
    expect(ledger).toEqual({ corrected: ["none"] })
  })
})
