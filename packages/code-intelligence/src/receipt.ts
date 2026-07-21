/**
 * End-of-turn econ receipt — the honest usage/cost surface.
 *
 * Reads the recorded `UsageEvent`s (telemetry.ts) plus the double-pay ledger
 * (double-pay.ts) and reports what was actually spent and how: overall and
 * per-tier cost, tokens, cache reads/writes, tool calls, and context size. It
 * counts real spend — it does not price a frontier baseline or promise a
 * savings figure. Task-level comparisons against other agents live in the
 * ../unerr-benchmarks repo, not in the product.
 *
 * The headline `estimatedReduction` metric follows econ's principle:
 * reduction ≈ 1 − the large-tier TOKEN share — self-referential, no external
 * price reference.
 *
 * double-pay.ts is imported READ-ONLY (type position) — this module never
 * constructs or mutates the ledger; it only reads a snapshot.
 *
 * U6: optional goals/evaluations/contained trace sections (§1.8, §6 of
 * ORCHESTRATION_MECHANISM.md) pass through unchanged when the caller supplies
 * them, already folded across root + child slices upstream — additive, no
 * shape change to the existing per-tier drilldown. The optional `deferrals`
 * section (escalation-economics.md §10 Step 3) follows the same idiom: the
 * deferral ladder's own decision counts (by complaint class and by response),
 * reported as-is — never re-derived or gated on here.
 *
 * @sem domain=observability role=accounting
 */

import type { DoublePayLedger } from "./double-pay.js"
import type { TelemetryStore, UsageTier, UsageEventTokens } from "./telemetry.js"
import { contextWindow, tierProfile } from "./model-registry.js"
import type { EconTier } from "./region.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A named risk catch the router escalated — rendered in the receipt's catch list. */
export interface ReceiptCatch {
  /** Short label, e.g. the entity or file that tripped the risk gate. */
  name: string
  /** Tier the catch was escalated to. */
  tier: UsageTier
  /** Why it escalated (blast-radius / fan-in / centrality / abstention). */
  reason: string
}

/** One triaged goal from turn-open — the split-and-track outcome (U6, §1.1/§1.2). */
export interface ReceiptGoal {
  /** Short, possibly-truncated quote of the goal as triaged. */
  summary: string
  /** The turn-shape label assigned to this goal. */
  shape: string
}

/** One pre-dispatch evaluator verdict for a slice (U6, §6 U4). */
export interface ReceiptEvaluation {
  sliceId: string
  /** Tier the evaluator picked for this slice. */
  tier: UsageTier
  /** Whether the slice ran inline on the caller's session or as a dispatched child. */
  venue: "inline" | "child"
  /** Why this tier was picked — difficulty / blast-radius / verifiability / history / cache signals. */
  reasons: string[]
}

/** One contained (reverted) slice attempt (U6, §6 U3). */
export interface ReceiptContainment {
  sliceId: string
  /** Tier the failed attempt ran on. */
  fromTier: UsageTier
  /** Tier the slice escalated to on re-dispatch, when it did. */
  toTier?: UsageTier
  /** Which verify rung rejected the attempt and why. */
  rungReason: string
  /** Whether the failed attempt's edits were actually reverted (the snapshot restore fired). */
  reverted: boolean
}

/**
 * Escalation-decision breakdown for one run — counts by complaint class
 * ("verification" | "knowledge" | "corrected" | "capability") and by response
 * ("none" | "verify-inline" | "knowledge-fetch" | "escalate"), plus the
 * resulting escalation rate. This is the receipt-side surface for the H9
 * trigger-rate invariant (escalation-economics.md §10 Step 3) — it reports
 * what the deferral ladder (`deferral-policy.ts`) actually decided, unchanged.
 *
 * @sem domain=observability role=accounting
 */
export interface ReceiptDeferralBreakdown {
  byComplaint: Record<string, number>
  byResponse: Record<string, number>
  /** escalate count / total decisions this run; 0 when there were none. */
  escalationRate: number
}

/** Inputs to {@link buildReceipt}. */
export interface ReceiptInput {
  /** The session's recorded usage events. */
  store: TelemetryStore
  /** The double-pay ledger (read-only) for the double-pay line. */
  ledger: DoublePayLedger
  /** Named risk catches to surface; optional. */
  catches?: ReceiptCatch[]
  /** Triaged goals for the internal trace; optional, already folded across root + child slices. */
  goals?: ReceiptGoal[]
  /** Pre-dispatch evaluator verdicts for the internal trace; optional, already folded across root + child slices. */
  evaluations?: ReceiptEvaluation[]
  /** Contained (reverted) attempts for the internal trace; optional, already folded across root + child slices. */
  contained?: ReceiptContainment[]
  /** Escalation-decision breakdown for the internal trace; optional, same pass-through idiom as goals/evaluations/contained (§10 Step 3). */
  deferrals?: ReceiptDeferralBreakdown
  /** Tiers counted as "large" for the reduction metric. Default: oracle, reasoner, frontier. */
  largeTiers?: UsageTier[]
  /** Currency label for display. Default "USD". */
  currency?: string
}

/** One row of the per-tier drilldown. */
export interface TierSplitRow {
  tier: UsageTier
  turns: number
  tokens: UsageEventTokens
  totalTokens: number
  /** Share of all tokens (0..1). */
  tokenShare: number
  cost: number
  /** Share of total spend (0..1); 0 when total cost is 0. */
  costShare: number
  cacheHitRatio: number
  toolCalls: number
  peakContextTokens: number
  /** Context window of the tier's bound model (from the model registry) — only for the four econ tiers. */
  contextLimit?: number
}

/** The computed receipt. */
export interface EconReceipt {
  turns: number
  toolCalls: number
  tokens: UsageEventTokens
  totalTokens: number
  actualCost: number
  cacheHitRatio: number
  peakContextTokens: number
  tierSplit: TierSplitRow[]
  /** Combined token share of the large tiers (0..1). */
  largeTierTokenShare: number
  /** econ's headline metric: 1 − largeTierTokenShare (token-share based, self-referential — no external price reference). */
  estimatedReduction: number
  doublePay: { escalations: number; wastedCost: number }
  catches: ReceiptCatch[]
  currency: string
  /** Triaged goals — internal trace only, present only when the caller supplied them (U6). */
  goals?: ReceiptGoal[]
  /** Pre-dispatch evaluator verdicts — internal trace only, present only when the caller supplied them (U6). */
  evaluations?: ReceiptEvaluation[]
  /** Contained (reverted) attempts — internal trace only, present only when the caller supplied them (U6). */
  contained?: ReceiptContainment[]
  /** Escalation-decision breakdown — internal trace only, present only when the caller supplied it (H9 trigger-rate invariant, §10 Step 3). */
  deferrals?: ReceiptDeferralBreakdown
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_LARGE_TIERS: UsageTier[] = ["oracle", "reasoner", "frontier"]

/** The four econ tiers whose bound model has a registry-tracked context window. */
const ECON_RECEIPT_TIERS = new Set<UsageTier>(["conductor", "executor", "reasoner", "oracle"])

/**
 * Tiers on the default routing path — excluded from the receipt's "ran above
 * conductor" routing line. Executor covers its persona sub-agents too (they
 * all roll up into the "executor" tier key), so they're noise for this line,
 * not an escalation signal.
 */
const NOISE_ROUTING_TIERS = new Set<UsageTier>(["conductor", "executor"])

/** Context window of a tier's bound model, or undefined for a non-econ tier label. */
function contextLimitForTier(tier: UsageTier): number | undefined {
  if (!ECON_RECEIPT_TIERS.has(tier)) return undefined
  return contextWindow(tier as EconTier)
}

/** Registry cache-accounting mode of a tier's bound model, or undefined for a non-econ tier label. */
function cacheAccountingFor(tier: UsageTier): "stream" | "nonstream-only" | "none" | undefined {
  if (!ECON_RECEIPT_TIERS.has(tier)) return undefined
  return tierProfile(tier as EconTier).cacheAccounting
}

// ---------------------------------------------------------------------------
// buildReceipt
// ---------------------------------------------------------------------------

/**
 * Compute the end-of-turn econ receipt from real recorded usage: overall
 * totals plus a per-tier drilldown, straight off `store.totals()` and
 * `store.cacheHitRatio()`, carrying through the optional goals/evaluations/
 * contained/deferrals trace sections unchanged when the caller supplies them
 * (already folded across root + child slices upstream, same idiom as
 * `catches`). No baseline pricing, no savings math — the double-pay line is
 * the ledger's own accounting, not a subtraction from a frontier-derived
 * figure.
 *
 * @sem domain=observability role=accounting
 */
export function buildReceipt(input: ReceiptInput): EconReceipt {
  const { store, ledger, catches = [] } = input
  const largeTiers = new Set(input.largeTiers ?? DEFAULT_LARGE_TIERS)
  const currency = input.currency ?? "USD"

  const totals = store.totals()
  const tokenDenom = totals.totalTokens
  const costDenom = totals.cost

  const tierSplit: TierSplitRow[] = Object.entries(totals.byTier)
    .map(([tier, t]) => ({
      tier: tier as UsageTier,
      turns: t.turns,
      tokens: t.tokens,
      totalTokens: t.totalTokens,
      tokenShare: tokenDenom > 0 ? t.totalTokens / tokenDenom : 0,
      cost: t.cost,
      costShare: costDenom > 0 ? t.cost / costDenom : 0,
      cacheHitRatio: t.cacheHitRatio,
      toolCalls: t.toolCalls,
      peakContextTokens: t.peakContextTokens,
      contextLimit: contextLimitForTier(tier as UsageTier),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens)

  const largeTierTokenShare = tierSplit
    .filter((r) => largeTiers.has(r.tier))
    .reduce((acc, r) => acc + r.tokenShare, 0)

  const snapshot = ledger.snapshot()
  const doublePay = { escalations: snapshot.escalations, wastedCost: snapshot.totalWastedCost }

  const receipt: EconReceipt = {
    turns: totals.turns,
    toolCalls: totals.toolCalls,
    tokens: totals.tokens,
    totalTokens: totals.totalTokens,
    actualCost: totals.cost,
    cacheHitRatio: store.cacheHitRatio(),
    peakContextTokens: totals.peakContextTokens,
    tierSplit,
    largeTierTokenShare,
    estimatedReduction: 1 - largeTierTokenShare,
    doublePay,
    catches,
    currency,
  }
  // U6 trace sections: additive-only — present only when the caller supplies
  // them (already folded across root + child slices upstream), so an omitted
  // section keeps today's shape exactly (no key at all, not an empty array).
  if (input.goals !== undefined) receipt.goals = input.goals
  if (input.evaluations !== undefined) receipt.evaluations = input.evaluations
  if (input.contained !== undefined) receipt.contained = input.contained
  // §10 Step 3 — same idiom: present only when the caller supplies it.
  if (input.deferrals !== undefined) receipt.deferrals = input.deferrals
  return receipt
}

// ---------------------------------------------------------------------------
// formatReceipt
// ---------------------------------------------------------------------------

const money = (n: number, currency: string): string =>
  `${n < 0 ? "-" : ""}${currency === "USD" ? "$" : ""}${Math.abs(n).toFixed(4)}${currency === "USD" ? "" : " " + currency}`

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`

/** Compact token count: 1234 → "1.2k", 1234567 → "1.23M". */
const fmtTokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return `${n}`
}

/**
 * Avg tool calls per assistant message ("turns" here = assistant messages) —
 * the L1 batching health metric (>1.0 means batching is happening). Pure
 * ratio, 2 decimals; "—" when there are no messages to divide by.
 */
const batchPerMsg = (toolCalls: number, turns: number): string =>
  turns > 0 ? (toolCalls / turns).toFixed(2) : "—"

/**
 * Render an {@link EconReceipt} as a compact multi-line block for the
 * end-of-turn surface: overall totals, a routing line naming which tiers ran
 * above conductor (when any did — double-pay alone only counts mid-turn
 * escalation, not a turn that opened directly on a large tier), then a
 * per-tier drilldown. Pure string formatting — no I/O.
 *
 * @sem domain=observability role=formatting
 */
export function formatReceipt(r: EconReceipt): string {
  const lines: string[] = []
  lines.push("econ receipt")
  lines.push(`  turns:      ${r.turns} · tool calls: ${r.toolCalls} · batch ${batchPerMsg(r.toolCalls, r.turns)}/msg`)
  lines.push(
    `  tokens:     ${fmtTokens(r.totalTokens)} — in ${fmtTokens(r.tokens.input)} · out ${fmtTokens(r.tokens.output)} · think ${fmtTokens(r.tokens.reasoning)} · cache r ${fmtTokens(r.tokens.cacheRead)} / w ${fmtTokens(r.tokens.cacheWrite)}`,
  )
  // Honesty over precision: some deployments cache but omit cache fields from
  // streamed usage (registry cacheAccounting "nonstream-only"), so the overall
  // ratio only counts tiers that actually report.
  const anyUnreported = r.tierSplit.some((t) => cacheAccountingFor(t.tier) === "nonstream-only")
  lines.push(`  cache hit:  ${pct(r.cacheHitRatio)}${anyUnreported ? " (reported tiers only)" : ""}`)
  lines.push(`  context:    peak ${fmtTokens(r.peakContextTokens)}`)
  lines.push(`  spent:      ${money(r.actualCost, r.currency)}`)
  lines.push(
    `  reduction:  ${pct(r.estimatedReduction)}  (1 − large-tier token share ${pct(r.largeTierTokenShare)})`,
  )
  lines.push(
    `  double-pay: −${money(r.doublePay.wastedCost, r.currency)} (${r.doublePay.escalations} escalation${r.doublePay.escalations === 1 ? "" : "s"})`,
  )
  // Turn-open routing: which tiers ran above the default conductor/executor
  // path, and how much. double-pay only counts mid-turn escalation (a cheap
  // turn redone on oracle) — a turn that opened directly on reasoner/oracle
  // shows 0 escalations there even at 100% large-tier usage; this line closes
  // that blind spot. Omitted entirely when every turn ran on conductor/executor.
  const routingRows = r.tierSplit.filter((t) => !NOISE_ROUTING_TIERS.has(t.tier) && t.turns > 0)
  const turnsAboveConductor = routingRows.reduce((acc, t) => acc + t.turns, 0)
  if (turnsAboveConductor > 0) {
    const parts = routingRows.map((t) => `${t.tier}: ${t.turns}·${money(t.cost, r.currency)}`).join(", ")
    lines.push(`  routing:    ${turnsAboveConductor} of ${r.turns} turns ran above conductor (${parts})`)
  }
  if (r.tierSplit.length > 0) {
    lines.push(`  tiers:`)
    const nameWidth = Math.max(...r.tierSplit.map((t) => t.tier.length))
    for (const t of r.tierSplit) {
      const ctx = t.contextLimit !== undefined ? `${fmtTokens(t.peakContextTokens)}/${fmtTokens(t.contextLimit)}` : fmtTokens(t.peakContextTokens)
      // A hollow 0% from a tier whose stream omits cache fields is "not
      // reported" (n/r); a tier whose provider never caches is "n/a".
      const acct = cacheAccountingFor(t.tier)
      const cacheCell =
        acct === "none" ? "n/a" : acct === "nonstream-only" && t.cacheHitRatio === 0 ? "n/r" : pct(t.cacheHitRatio)
      lines.push(
        `    ${t.tier.padEnd(nameWidth)}  ${t.turns} turn${t.turns === 1 ? "" : "s"} · ${fmtTokens(t.totalTokens)} tok (${pct(t.tokenShare)}) · ${money(t.cost, r.currency)} (${pct(t.costShare)}) · cache ${cacheCell} · ${t.toolCalls} tool${t.toolCalls === 1 ? "" : "s"} (${batchPerMsg(t.toolCalls, t.turns)}/msg) · ctx ${ctx}`,
      )
    }
  }
  if (r.catches.length > 0) {
    lines.push(`  catches:`)
    for (const c of r.catches) lines.push(`    • ${c.name} → ${c.tier} (${c.reason})`)
  }
  return lines.join("\n")
}
