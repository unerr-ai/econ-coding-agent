/**
 * Claim–evidence contract — the shared kernel behind the verification gates
 * (gap-closure-plan §2.7). An agent claim ("fixed", "no regressions", "done")
 * is a typed object carrying the scope it asserts over; evidence carries what
 * was actually checked; the one generic question every gate asks is "does the
 * evidence's scope cover the claim's scope?". New failure classes become new
 * scope entries, not new bespoke gate mechanisms.
 *
 * Pure and I/O-free: callers gather evidence (test runs, witness executions,
 * deliverable probes) and this module only judges coverage. Differential
 * attribution (env-red vs model-red) is built in via `baseline`.
 *
 * @sem domain=fidelity role=gate
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The claim shapes gates currently police. @sem domain=fidelity role=gate */
export type ClaimKind = "fixed" | "no_regressions" | "done" | "addresses_issue"

/**
 * What a scope's items denote — issue witnesses (H1), test ids (H2/H8), or
 * deliverable artifacts/checks (H4).
 *
 * @sem domain=fidelity role=gate
 */
export type ScopeKind = "witnesses" | "tests" | "deliverables"

/**
 * The finite set of named obligations a claim asserts over. A claim whose
 * scope lists three witnesses is only covered by evidence passing all three —
 * a strict subset is never promotion-worthy.
 *
 * @sem domain=fidelity role=gate
 */
export interface ClaimScope {
  readonly kind: ScopeKind
  /** Stable ids: witness keys, test ids, or deliverable paths/commands. */
  readonly items: readonly string[]
}

/** A typed agent claim awaiting verification. @sem domain=fidelity role=gate */
export interface Claim {
  readonly kind: ClaimKind
  readonly scope: ClaimScope
}

/**
 * One checked obligation. `unverified` marks an item the checker selected but
 * could not execute — it blocks coverage exactly like an absent item, so a
 * gate can never silently promote on partial execution.
 *
 * @sem domain=fidelity role=gate
 */
export interface EvidenceItem {
  readonly id: string
  readonly verdict: "pass" | "fail" | "unverified"
  /** Short machine-or-human detail (failure line, artifact probe output). */
  readonly detail?: string
}

/**
 * What was actually verified. `scope` states the checker's reach (it may be
 * wider or narrower than the claim's); `baseline` lists item ids that were
 * already failing BEFORE the change — the differential-attribution input
 * (new_reds = post_reds − pre_reds), reported as environment facts and never
 * attributed to the change.
 *
 * @sem domain=fidelity role=gate
 */
export interface Evidence {
  readonly scope: ClaimScope
  readonly items: readonly EvidenceItem[]
  readonly baseline?: readonly string[]
}

/**
 * The generic gate verdict. `covered` requires every claim-scope item to have
 * passing evidence and no non-baseline failure anywhere in the evidence.
 * `verifiedScope` is the honest one-line statement of what was checked —
 * gates surface it instead of an implied "no regressions".
 *
 * @sem domain=fidelity role=gate
 */
export interface CoverageVerdict {
  readonly covered: boolean
  /** Claim-scope items with no passing evidence (absent or unverified). */
  readonly missing: readonly string[]
  /** Items that failed and are NOT in the baseline — attributable reds. */
  readonly failing: readonly string[]
  /** Items that failed but were already red pre-change — env facts. */
  readonly preExisting: readonly string[]
  /** e.g. "5/7 witnesses verified (2 unchecked)" — scope-stated, never wider. */
  readonly verifiedScope: string
}

// ---------------------------------------------------------------------------
// checkClaimCoverage
// ---------------------------------------------------------------------------

/**
 * Judge whether evidence covers a claim. Deterministic and total: duplicate
 * evidence ids resolve worst-verdict-wins (fail > unverified > pass) so a
 * flaky pass can never mask a recorded failure, and an empty claim scope with
 * failing evidence still refuses coverage — a green stamp needs both "all
 * claimed items pass" and "nothing new broke in what was checked".
 *
 * @sem domain=fidelity role=gate
 */
export function checkClaimCoverage(claim: Claim, evidence: Evidence): CoverageVerdict {
  const rank = { fail: 2, unverified: 1, pass: 0 } as const
  const worst = new Map<string, EvidenceItem["verdict"]>()
  for (const item of evidence.items) {
    const prev = worst.get(item.id)
    if (prev === undefined || rank[item.verdict] > rank[prev]) worst.set(item.id, item.verdict)
  }

  const baseline = new Set(evidence.baseline ?? [])
  const missing: string[] = []
  for (const id of claim.scope.items) {
    if (worst.get(id) !== "pass") missing.push(id)
  }

  const failing: string[] = []
  const preExisting: string[] = []
  for (const [id, verdict] of worst) {
    if (verdict !== "fail") continue
    if (baseline.has(id)) preExisting.push(id)
    else failing.push(id)
  }

  const claimed = claim.scope.items.length
  const passed = claim.scope.items.filter((id) => worst.get(id) === "pass").length
  const unchecked = claim.scope.items.filter((id) => !worst.has(id) || worst.get(id) === "unverified").length
  const parts = [`${passed}/${claimed} ${claim.scope.kind} verified`]
  if (unchecked > 0) parts.push(`${unchecked} unchecked`)
  if (failing.length > 0) parts.push(`${failing.length} failing`)
  if (preExisting.length > 0) parts.push(`${preExisting.length} pre-existing (env)`)
  const verifiedScope = parts.length > 1 ? `${parts[0]} (${parts.slice(1).join(", ")})` : parts[0]

  return {
    covered: missing.length === 0 && failing.length === 0,
    missing,
    failing,
    preExisting,
    verifiedScope,
  }
}
