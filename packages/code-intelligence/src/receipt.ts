/**
 * End-of-turn savings receipt — the headline of econ's proof surface.
 *
 * Reads the recorded `UsageEvent`s (telemetry.ts) plus the double-pay ledger
 * (double-pay.ts) and produces an HONEST savings figure: it counts what was
 * actually spent, prices the same token volume at a frontier baseline, then
 * subtracts the wasted cheap-attempt cost of escalated turns via the ledger's
 * `effectiveSavings`. We report a number we can stand behind, not a promise.
 *
 * The headline reduction metric follows econ's principle: reduction ≈
 * 1 − the large-tier TOKEN share. The dollar figure is baseline − actual with
 * double-pay removed; both are shown so the receipt is auditable.
 *
 * double-pay.ts is imported READ-ONLY (type position) — this module never
 * constructs or mutates the ledger; it only reads a snapshot and calls
 * `effectiveSavings`.
 *
 * @sem domain=observability role=accounting
 */

import type { DoublePayLedger } from "./double-pay.js"
import type { TelemetryStore, UsageTier, UsageEventTokens } from "./telemetry.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-million-token prices for the frontier model we baseline against — the
 * "what Claude/GPT would have cost" reference. Cache-read pricing is optional;
 * when omitted, cache-read tokens are priced at the input rate.
 */
export interface FrontierBaseline {
  /** Frontier model id, for display. */
  model: string
  inputPerMTok: number
  outputPerMTok: number
  /** Defaults to `inputPerMTok` when omitted. */
  cacheReadPerMTok?: number
}

/** A named risk catch the router escalated — rendered in the receipt's catch list. */
export interface ReceiptCatch {
  /** Short label, e.g. the entity or file that tripped the risk gate. */
  name: string
  /** Tier the catch was escalated to. */
  tier: UsageTier
  /** Why it escalated (blast-radius / fan-in / centrality / abstention). */
  reason: string
}

/** Inputs to {@link buildReceipt}. */
export interface ReceiptInput {
  /** The session's recorded usage events. */
  store: TelemetryStore
  /** The double-pay ledger (read-only) for the wasted-cost subtraction. */
  ledger: DoublePayLedger
  /** Frontier reference pricing; omit to skip the dollar figure (token-share only). */
  baseline?: FrontierBaseline
  /** Named risk catches to surface; optional. */
  catches?: ReceiptCatch[]
  /** Tiers counted as "large" for the reduction metric. Default: oracle, reasoner, frontier. */
  largeTiers?: UsageTier[]
  /** Currency label for display. Default "USD". */
  currency?: string
}

/** One row of the tier split — token + cost share for a tier. */
export interface TierSplitRow {
  tier: UsageTier
  turns: number
  totalTokens: number
  cost: number
  /** This tier's share of all tokens (0..1). */
  tokenShare: number
}

/** The computed receipt. */
export interface SavingsReceipt {
  turns: number
  tierSplit: TierSplitRow[]
  /** Combined token share of the large tiers (0..1). */
  largeTierTokenShare: number
  /** econ's headline metric: 1 − largeTierTokenShare. */
  estimatedReduction: number
  cacheHitRatio: number
  /** Real dollars spent across all recorded turns. */
  actualCost: number
  /** What the same token volume would have cost at the frontier baseline. */
  frontierBaselineCost?: number
  /** baseline − actual, before the double-pay subtraction (the optimistic figure). */
  grossSavings?: number
  /** Double-pay penalty pulled from the ledger. */
  doublePay: { escalations: number; wastedCost: number }
  /** HONEST savings: grossSavings − wastedCost, via ledger.effectiveSavings. */
  netSavings?: number
  catches: ReceiptCatch[]
  currency: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_LARGE_TIERS: UsageTier[] = ["oracle", "reasoner", "frontier"]

/** Price one turn's tokens at the frontier baseline (per-million-token rates). */
function frontierCostOf(tokens: UsageEventTokens, b: FrontierBaseline): number {
  const cacheReadRate = b.cacheReadPerMTok ?? b.inputPerMTok
  return (
    (tokens.input * b.inputPerMTok +
      tokens.cacheRead * cacheReadRate +
      (tokens.output + tokens.reasoning) * b.outputPerMTok) /
    1_000_000
  )
}

// ---------------------------------------------------------------------------
// buildReceipt
// ---------------------------------------------------------------------------

/**
 * Compute the end-of-turn savings receipt from real recorded usage.
 *
 * Dollar math (only when a `baseline` is supplied):
 *   grossSavings = Σ (frontierCostOf(turn.tokens) − turn.cost)
 *   netSavings   = ledger.effectiveSavings(grossSavings)   // − wastedCost
 *
 * The gross figure naively treats a discarded cheap attempt as savings (its
 * frontier-priced tokens exceed its cheap cost); routing through
 * `effectiveSavings` subtracts the ledger's `totalWastedCost`, removing that
 * phantom saving and the real waste — this is what makes the receipt honest.
 *
 * @sem domain=observability role=accounting
 */
export function buildReceipt(input: ReceiptInput): SavingsReceipt {
  const { store, ledger, baseline, catches = [] } = input
  const largeTiers = new Set(input.largeTiers ?? DEFAULT_LARGE_TIERS)
  const currency = input.currency ?? "USD"

  const totals = store.totals()
  const denom = totals.totalTokens

  const tierSplit: TierSplitRow[] = Object.entries(totals.byTier)
    .map(([tier, t]) => ({
      tier,
      turns: t.turns,
      totalTokens: t.totalTokens,
      cost: t.cost,
      tokenShare: denom > 0 ? t.totalTokens / denom : 0,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens)

  const largeTierTokenShare = tierSplit
    .filter((r) => largeTiers.has(r.tier))
    .reduce((acc, r) => acc + r.tokenShare, 0)

  const snapshot = ledger.snapshot()
  const doublePay = { escalations: snapshot.escalations, wastedCost: snapshot.totalWastedCost }

  const receipt: SavingsReceipt = {
    turns: totals.turns,
    tierSplit,
    largeTierTokenShare,
    estimatedReduction: 1 - largeTierTokenShare,
    cacheHitRatio: store.cacheHitRatio(),
    actualCost: totals.cost,
    doublePay,
    catches,
    currency,
  }

  if (baseline) {
    let frontierBaselineCost = 0
    for (const e of store.all()) frontierBaselineCost += frontierCostOf(e.tokens, baseline)
    const grossSavings = frontierBaselineCost - totals.cost
    receipt.frontierBaselineCost = frontierBaselineCost
    receipt.grossSavings = grossSavings
    receipt.netSavings = ledger.effectiveSavings(grossSavings)
  }

  return receipt
}

// ---------------------------------------------------------------------------
// formatReceipt
// ---------------------------------------------------------------------------

const money = (n: number, currency: string): string =>
  `${n < 0 ? "-" : ""}${currency === "USD" ? "$" : ""}${Math.abs(n).toFixed(4)}${currency === "USD" ? "" : " " + currency}`

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`

/**
 * Render a {@link SavingsReceipt} as a compact multi-line block for the
 * end-of-turn surface. Pure string formatting — no I/O.
 *
 * @sem domain=observability role=formatting
 */
export function formatReceipt(r: SavingsReceipt): string {
  const lines: string[] = []
  lines.push("econ savings receipt")
  lines.push(`  turns:        ${r.turns}`)
  lines.push(
    `  tier split:   ${r.tierSplit.map((t) => `${t.tier} ${pct(t.tokenShare)}`).join("  ") || "(none)"}`,
  )
  lines.push(
    `  reduction:    ${pct(r.estimatedReduction)}  (1 − large-tier token share ${pct(r.largeTierTokenShare)})`,
  )
  lines.push(`  cache hit:    ${pct(r.cacheHitRatio)}`)
  lines.push(`  spent:        ${money(r.actualCost, r.currency)}`)
  if (r.frontierBaselineCost !== undefined) {
    lines.push(`  vs frontier:  ${money(r.frontierBaselineCost, r.currency)}`)
    lines.push(`  gross saved:  ${money(r.grossSavings ?? 0, r.currency)}`)
  }
  lines.push(
    `  double-pay:   −${money(r.doublePay.wastedCost, r.currency)} (${r.doublePay.escalations} escalation${r.doublePay.escalations === 1 ? "" : "s"})`,
  )
  if (r.netSavings !== undefined) {
    lines.push(`  NET SAVED:    ${money(r.netSavings, r.currency)}  (double-pay subtracted)`)
  }
  if (r.catches.length > 0) {
    lines.push(`  catches:`)
    for (const c of r.catches) lines.push(`    • ${c.name} → ${c.tier} (${c.reason})`)
  }
  return lines.join("\n")
}
