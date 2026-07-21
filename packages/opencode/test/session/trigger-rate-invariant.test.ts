/**
 * H9 trigger-rate audit, made a tracked invariant (escalation-economics.md
 * §10 Step 3) — the same move G4b made for per-language graph coverage
 * (packages/code-intelligence/test/coverage-invariant.test.ts): a vendored,
 * known-exact fixture corpus plus a test that fails loudly the moment the
 * invariant regresses, instead of relying on a one-off audit that (per §4.5)
 * was specified but never actually run against a live fleet.
 *
 * The corpus below is not synthetic — it is the V2 clean-room fleet's ACTUAL
 * observed arming census (escalation-economics.md §1, §2): ten instances, six
 * of which armed exactly once each (`fidelity_finish_reject` x2,
 * `unverified_finish` x2, `hub_bounce_repeat` x2 — §2's table), four of which
 * never armed at all. Each instance's firing sequence is replayed through
 * `decideDeferralResponse` + `recordDeferralResponse` — the exact per-session
 * state machine `armDeferral` (prompt.ts) drives in production — so this
 * suite tests the real ladder, not a re-implementation of it.
 *
 * The V2 corpus above was structurally blind to a real production shape: the
 * SAME arm firing MULTIPLE times for one instance. Live observation hit
 * exactly that — six escalations, all verification-class, all following
 * firing #1 -> nothing, firing #2 -> cheap rung, firing #3 -> budget
 * exhausted -> escalate -> the SAME complaint keeps firing (up to 3 more
 * times) unresolved — which is why this file also carries
 * `V3_REPEAT_FIRING_CENSUS`, the actual observed multi-firing counts for the
 * 4 instances that reproduced it.
 */
import { describe, it, expect } from "bun:test"
import {
  CHEAP_RESPONSE_BUDGET,
  decideDeferralResponse,
  recordDeferralResponse,
  type DeferralComplaint,
  type DeferralResponse,
} from "../../src/session/deferral-policy"

/** H9's own stated bar (escalation-economics.md §4.5, §10 Step 3): "trigger-rate audit ... must stay rare — target ≤15% extra escalations." */
const H9_TRIGGER_RATE_BAR = 0.15

/** One arming firing observed in the V2 fleet log for one instance, in order. */
interface CensusFiring {
  readonly signal: string
}

interface CensusInstance {
  /** Instance identifier — readability only, not consumed by the policy. */
  readonly id: string
  /** This instance's arming firings exactly as logged (§1's "arming trigger" column). Empty = never armed. */
  readonly firings: readonly CensusFiring[]
}

// escalation-economics.md §1 — the measured result table, all ten instances.
// Six armed (one firing each, per §1's single "arming trigger" column); four
// never armed. §2 corroborates the same six signals: fidelity_finish_reject
// x2, unverified_finish x2, hub_bounce_repeat x2 — "six firings on ten
// instances".
const V2_FLEET_CENSUS: readonly CensusInstance[] = [
  { id: "11790", firings: [] },
  { id: "11815", firings: [{ signal: "fidelity_finish_reject" }] },
  { id: "11848", firings: [{ signal: "unverified_finish" }] },
  { id: "11880", firings: [{ signal: "unverified_finish" }] },
  { id: "11885", firings: [] },
  { id: "11951", firings: [] },
  { id: "11964", firings: [{ signal: "hub_bounce_repeat" }] },
  { id: "11999", firings: [{ signal: "hub_bounce_repeat" }] },
  { id: "12039", firings: [{ signal: "fidelity_finish_reject" }] },
  { id: "12050", firings: [] },
]

/**
 * The actual repeat-firing census (escalation-economics.md
 * §1.1's live evidence) — the shape `V2_FLEET_CENSUS` above cannot represent:
 * the SAME arm firing multiple times for the SAME instance. Observed
 * per-instance counts: `unverified_finish` x4, `seen_red_unresolved` x6,
 * `seen_red_unresolved` x5, `fidelity_finish_reject` x3.
 * Every arm here is verification-class — this is the exact corpus the
 * terminal-verification fix (deferral-policy.ts) exists to hold at zero
 * escalations, no matter the repeat count.
 */
const V3_REPEAT_FIRING_CENSUS: readonly CensusInstance[] = [
  { id: "11790", firings: Array.from({ length: 4 }, () => ({ signal: "unverified_finish" })) },
  { id: "11815", firings: Array.from({ length: 6 }, () => ({ signal: "seen_red_unresolved" })) },
  { id: "11848", firings: Array.from({ length: 5 }, () => ({ signal: "seen_red_unresolved" })) },
  { id: "12039", firings: Array.from({ length: 3 }, () => ({ signal: "fidelity_finish_reject" })) },
]

/**
 * Replay one instance's firing sequence through the response ladder, folding
 * the session ledger between firings exactly as `armDeferral` does — a
 * session's single deferral budget means production stops arming further
 * signals once one escalates, so this mirrors that by stopping at the first
 * `escalate` verdict.
 */
function replayUnderPolicy(firings: readonly CensusFiring[]): boolean {
  let ledger: Partial<Record<DeferralComplaint, readonly DeferralResponse[]>> = {}
  let cheapResponsesSpent = 0
  for (const firing of firings) {
    const verdict = decideDeferralResponse({ signal: firing.signal, priorResponses: ledger, cheapResponsesSpent })
    if (verdict.response === "escalate") return true
    if (verdict.response === "verify-inline" || verdict.response === "knowledge-fetch") cheapResponsesSpent++
    ledger = recordDeferralResponse(ledger, verdict)
  }
  return false
}

/** Old (pre-fix) behavior: the first arm to fire escalated unconditionally (§0, §2) — no ladder, no cheaper response tried first. */
function replayUnderOldBehavior(firings: readonly CensusFiring[]): boolean {
  return firings.length > 0
}

/**
 * The pre-fix LADDER behavior for the verification complaint specifically —
 * what `decideDeferralResponse` did before the terminal-verification fix:
 * escalate once verify-inline was already spent for the complaint, OR once
 * the turn's shared `CHEAP_RESPONSE_BUDGET` was already spent. Reproduced
 * locally (not imported — the fix deleted this path from the module) purely
 * to prove `V3_REPEAT_FIRING_CENSUS` has teeth for the exact regression this
 * change closes: the census this file's V2 corpus was structurally blind to.
 */
function replayUnderPreFixVerificationLadder(firings: readonly CensusFiring[]): boolean {
  let verifyInlineSpent = false
  let cheapResponsesSpent = 0
  for (const firing of firings) {
    if (verifyInlineSpent || cheapResponsesSpent >= CHEAP_RESPONSE_BUDGET) return true
    verifyInlineSpent = true
    cheapResponsesSpent++
  }
  return false
}

describe("H9 trigger-rate invariant — V2 fleet census replay (escalation-economics.md §10 Step 3)", () => {
  it(`decideDeferralResponse holds H9's own bar (<=${H9_TRIGGER_RATE_BAR * 100}%) over the census that measured 60% pre-fix`, () => {
    const escalated = V2_FLEET_CENSUS.filter((instance) => replayUnderPolicy(instance.firings))
    const rate = escalated.length / V2_FLEET_CENSUS.length
    expect(rate).toBeLessThanOrEqual(H9_TRIGGER_RATE_BAR)
  })

  it("regression-direction guard: the OLD (pre-fix) behavior fails this same bar on this same census — proves the test has teeth", () => {
    const oldEscalated = V2_FLEET_CENSUS.filter((instance) => replayUnderOldBehavior(instance.firings))
    const oldRate = oldEscalated.length / V2_FLEET_CENSUS.length
    // escalation-economics.md §0/§1: "escalated on 6 of 10 instances (60%)".
    expect(oldRate).toBeCloseTo(0.6)
    expect(oldRate).toBeGreaterThan(H9_TRIGGER_RATE_BAR)
  })

  it("none of the six real firings escalate on their first (and only observed) occurrence — each complaint's cheaper response absorbs it", () => {
    for (const instance of V2_FLEET_CENSUS.filter((i) => i.firings.length > 0)) {
      expect(replayUnderPolicy(instance.firings)).toBe(false)
    }
  })
})

describe("V3 repeat-firing invariant — terminal verification holds at ZERO escalations under repeat firings (escalation-economics.md §1.1)", () => {
  it("repeated verification firings across actual multi-firing instances produce ZERO escalations (unverified_finish x4, seen_red_unresolved x6, seen_red_unresolved x5, fidelity_finish_reject x3)", () => {
    const escalated = V3_REPEAT_FIRING_CENSUS.filter((instance) => replayUnderPolicy(instance.firings))
    expect(escalated).toHaveLength(0)
  })

  it("regression guard: the pre-fix ladder (verification escalated once verify-inline or the turn's cheap-response budget was already spent) WOULD have escalated all 4 of these instances — proving this census would have caught the V3 regression the V2 single-firing corpus above could not see", () => {
    const oldEscalated = V3_REPEAT_FIRING_CENSUS.filter((instance) => replayUnderPreFixVerificationLadder(instance.firings))
    expect(oldEscalated).toHaveLength(V3_REPEAT_FIRING_CENSUS.length)
  })
})
