/**
 * The deferral response ladder (docs/design/escalation-economics.md §10 Step 1)
 * — what a hard-tail arming signal is actually COMPLAINING about, and the
 * cheapest response that answers that complaint.
 *
 * Every one of the eight arms is a deterministic detector of *suspicion*, never
 * of a wrong fix (§2): they fire on "I did not verify this", not on "this is
 * broken". Dispatching an oracle at that evidence answers a verification
 * request with the most expensive AUTHOR we have, which is why the measured
 * conversion was zero source edits 6/6 (§1.1). This module keeps escalation for
 * the case that needs it — a cheap response was already tried and the signal
 * fired again — and answers everything else in place.
 *
 * Language/framework-agnostic by construction: the table is keyed on the signal
 * NAME alone. No path, extension, runner, or ecosystem is consulted, so a new
 * language is zero rows here.
 *
 * @sem domain=routing role=policy
 */

/**
 * What an arming signal is complaining about — the axis the response is chosen
 * on. Distinct from the signal name, because several signals share a complaint.
 *
 * @sem domain=routing role=type
 */
export type DeferralComplaint = "verification" | "knowledge" | "corrected" | "capability"

/**
 * The response the ladder selects. `none` declines without spending the turn's
 * deferral budget; `escalate` is the only one that costs an oracle draw.
 *
 * @sem domain=routing role=type
 */
export type DeferralResponse = "none" | "verify-inline" | "knowledge-fetch" | "escalate"

/**
 * How many non-escalating rungs a single turn may spend before the ladder stops
 * offering cheap answers and escalates. One — deliberately the same bound the
 * one-shot deferral budget enforced before this ladder existed, so the worst
 * case stays "one extra rung, then the loud path" rather than one rung per
 * complaint class.
 *
 * @sem domain=routing role=config
 */
export const CHEAP_RESPONSE_BUDGET = 1

/**
 * Signal name → what it complains about. An UNLISTED signal deliberately falls
 * through to `capability` (escalate), so a newly added arm fails safe — loud
 * and expensive — rather than being silently swallowed by this table.
 *
 * @sem domain=routing role=config
 */
export const COMPLAINT_BY_SIGNAL: Record<string, DeferralComplaint> = {
  // Lagging indicator of an ALREADY-SOLVED problem: it means "the agent tried
  // the wrong layer twice and the deterministic hub gate corrected it". On
  // 11964 the correct root-layer fix was on disk ~250 log lines before this
  // armed, and the oracle spent 42 turns re-deriving it (§1.2).
  hub_bounce_repeat: "corrected",

  // "I did not verify this" — the check exists (or is discoverable); run it.
  probe_gate_exhausted: "verification",
  unverified_finish: "verification",
  seen_red_unresolved: "verification",
  fidelity_finish_reject: "verification",
  promoted_pin_green: "verification",
  oracle_inversion: "verification",
  regression_red: "verification",
}

/**
 * Evidence the ladder decides on. `priorResponses` is this session's record of
 * what has already been tried for the SAME complaint — the exhaustion memory
 * that makes a second firing mean something the first did not.
 *
 * @sem domain=routing role=type
 */
export interface DeferralPolicyInput {
  /** The deterministic signal that armed — `DeferralBrief.signal`. */
  readonly signal: string
  /**
   * Non-escalating rungs already spent this turn, across ALL complaint classes.
   * Before this ladder existed the deferral budget (`markDeferralUsed`) was a
   * hard one-rung bound on the whole turn; making cheap rungs free removed that
   * bound, letting each complaint class buy its own rung. `CHEAP_RESPONSE_BUDGET`
   * restores it.
   */
  readonly cheapResponsesSpent: number
  /** Responses already spent this session, per complaint class. */
  readonly priorResponses: Readonly<Partial<Record<DeferralComplaint, readonly DeferralResponse[]>>>
  /**
   * The turn's failing evidence is an unrecognized or dependency-rooted error
   * (error-search.ts's own trigger shape) — the agent is confounded about the
   * WORLD, not about its own change, so a version-pinned lookup beats a bigger
   * model. Overrides the table.
   */
  readonly knowledgeGap?: boolean
}

/**
 * The chosen response plus the reason it was chosen, for telemetry and for the
 * trigger-rate invariant (§10 Step 3).
 *
 * @sem domain=routing role=type
 */
export interface DeferralPolicyVerdict {
  readonly complaint: DeferralComplaint
  readonly response: DeferralResponse
  readonly reason: string
  /**
   * True only when `response === "escalate"`. The orchestration gate consumes
   * this instead of the raw arming signal, which is what breaks the §4
   * circularity: the signal that armed can no longer also serve as proof the
   * escalation earned its dispatch.
   */
  readonly escalationEarned: boolean
}

/**
 * Choose the cheapest response that answers this signal's complaint, escalating
 * only once a cheaper response for the same complaint has already been spent
 * and the signal fired anyway.
 *
 * @sem domain=routing role=gate
 */
export function decideDeferralResponse(input: DeferralPolicyInput): DeferralPolicyVerdict {
  const complaint: DeferralComplaint = input.knowledgeGap
    ? "knowledge"
    : (COMPLAINT_BY_SIGNAL[input.signal] ?? "capability")

  const spent = input.priorResponses[complaint] ?? []
  const escalated = (verdictReason: string): DeferralPolicyVerdict => ({
    complaint,
    response: "escalate",
    reason: verdictReason,
    escalationEarned: true,
  })
  // The turn-wide rung bound, checked before any complaint-specific cheap
  // answer. `corrected` is exempt: it returns `none`, which costs no rung at
  // all, so capping it would convert a free decline into an escalation.
  const cheapBudgetSpent = input.cheapResponsesSpent >= CHEAP_RESPONSE_BUDGET

  switch (complaint) {
    case "corrected":
      // Never escalates, on any firing. The condition it reports is the
      // deterministic hub gate having ALREADY redirected the edit to the
      // defining site it named (shouldArmHubBounceDeferral additionally
      // requires landed source edits), so there is nothing left to buy.
      return {
        complaint,
        response: "none",
        reason: "lagging indicator of a correction the deterministic hub gate already made",
        escalationEarned: false,
      }

    case "knowledge":
      // One version-pinned lookup at the conductor first; a second confounded
      // turn means the lookup did not settle it.
      if (spent.includes("knowledge-fetch")) return escalated("knowledge-fetch already spent; still confounded")
      if (cheapBudgetSpent) return escalated("turn's cheap-response budget already spent")
      return {
        complaint,
        response: "knowledge-fetch",
        reason: "unrecognized/dependency-rooted error — version-pinned lookup before any tier change",
        escalationEarned: false,
      }

    case "verification":
      // The complaint is an ABSENT check, so run the check. Only a repeat
      // firing — the check ran and the signal persists — is evidence the
      // conductor cannot close this out.
      if (spent.includes("verify-inline")) return escalated("verify-inline already spent; signal fired again")
      if (cheapBudgetSpent) return escalated("turn's cheap-response budget already spent")
      return {
        complaint,
        response: "verify-inline",
        reason: "verification gap — run the discovered check at the conductor, no tier change",
        escalationEarned: false,
      }

    case "capability":
      // Unlisted signal, or an explicit capability complaint: fail safe.
      return escalated("capability complaint — no cheaper response answers it")
  }
}

/**
 * Fold a verdict into the session's response ledger so the next firing of the
 * same complaint sees what was already tried. Pure — the caller owns storage.
 *
 * @sem domain=routing role=helper
 */
export function recordDeferralResponse(
  ledger: Readonly<Partial<Record<DeferralComplaint, readonly DeferralResponse[]>>>,
  verdict: DeferralPolicyVerdict,
): Partial<Record<DeferralComplaint, readonly DeferralResponse[]>> {
  const prior = ledger[verdict.complaint] ?? []
  if (prior.includes(verdict.response)) return { ...ledger }
  return { ...ledger, [verdict.complaint]: [...prior, verdict.response] }
}
