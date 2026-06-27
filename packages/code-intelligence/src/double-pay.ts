/**
 * Double-pay accounting for escalated turns — tracks the cost of cheap
 * conductor attempts that are discarded when the oracle is invoked, so the
 * savings receipt can report an honest net figure rather than a gross one.
 *
 * All state is in-memory; telemetry routing is injected via the `emit`
 * callback so this module has no coupling to unerr or any provider SDK.
 *
 * @sem domain=router role=accounting
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Which pricing tier a model call belongs to. */
export type ModelTier = "cheap" | "oracle"

/** Token counts for one model call within a turn. */
export interface TurnTokens {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

/**
 * Cost record for one model call within a turn.
 *
 * Mirrors the `Usage.cost` / token fields surfaced by S0.3 without importing
 * the LLM package — callers extract what they need from `Usage` and pass the
 * plain values here.
 *
 * @sem domain=router role=accounting
 */
export interface TurnModelCost {
  tier: ModelTier
  model: string
  cost: number
  tokens: TurnTokens
}

/**
 * Full accounting record for one escalated turn.
 *
 * `wastedCost` is the cheap conductor spend that was discarded — money burned
 * on the failed cheap attempt before escalation fired.  `totalCost` is the
 * honest per-turn bill: cheap + oracle.  The two are always related by
 * `totalCost = cheap.cost + oracle.cost` and `wastedCost = cheap.cost`.
 *
 * @sem domain=router role=accounting
 */
export interface EscalationCost {
  turnId: string
  cheap: TurnModelCost
  oracle: TurnModelCost
  /** cheap.cost + oracle.cost — the true per-turn bill when escalation fires. */
  totalCost: number
  /** cheap.cost — money spent on the attempt that was discarded on escalation. */
  wastedCost: number
}

// ---------------------------------------------------------------------------
// recordEscalation
// ---------------------------------------------------------------------------

/** Input for one escalated turn. `tier` is set automatically by the function. */
export interface EscalationInput {
  turnId: string
  cheap: { model: string; cost: number; tokens: TurnTokens }
  oracle: { model: string; cost: number; tokens: TurnTokens }
  /**
   * Optional sink — called synchronously after the record is built.
   * Inject `emitSavingsEvent` here when wiring to unerr telemetry (S7).
   */
  emit?: (record: EscalationCost) => void
}

/**
 * Build an `EscalationCost` record for one escalated turn and optionally
 * forward it to a pluggable telemetry sink.
 *
 * The S3.2 router calls this inside the escalation branch, after the oracle
 * response arrives, so both cost figures are known.  Keeping the function
 * pure (no I/O) makes it trivially testable and replayable.
 *
 * @sem domain=router role=accounting
 */
export function recordEscalation({
  turnId,
  cheap: cheapIn,
  oracle: oracleIn,
  emit,
}: EscalationInput): EscalationCost {
  const cheap: TurnModelCost = { tier: "cheap", ...cheapIn }
  const oracle: TurnModelCost = { tier: "oracle", ...oracleIn }
  const record: EscalationCost = {
    turnId,
    cheap,
    oracle,
    totalCost: cheapIn.cost + oracleIn.cost,
    wastedCost: cheapIn.cost,
  }
  emit?.(record)
  return record
}

// ---------------------------------------------------------------------------
// DoublePayLedger
// ---------------------------------------------------------------------------

/** Point-in-time snapshot of the ledger totals. */
export interface LedgerSnapshot {
  escalations: number
  totalWastedCost: number
}

/**
 * In-memory aggregator that accumulates `EscalationCost` records and exposes
 * session-level totals for the savings receipt.
 *
 * `effectiveSavings(grossSavings)` subtracts accumulated `wastedCost` from
 * the caller-supplied gross savings figure (oracle price minus cheap price,
 * summed over non-escalated turns), yielding the honest net savings.
 *
 * @sem domain=router role=accounting
 */
export class DoublePayLedger {
  private _escalations = 0
  private _totalWastedCost = 0

  /** Accumulate one escalation record into the running totals. */
  add(record: EscalationCost): void {
    this._escalations += 1
    this._totalWastedCost += record.wastedCost
  }

  /** Number of turns that escalated this session. */
  get escalations(): number {
    return this._escalations
  }

  /**
   * Total cheap-attempt cost that was discarded across all escalated turns.
   * This is the double-pay penalty the savings receipt must subtract.
   */
  get totalWastedCost(): number {
    return this._totalWastedCost
  }

  /**
   * Adjust a gross savings figure by subtracting the wasted escalation cost.
   *
   * `grossSavings` = Σ (oracle_ref_price − cheap_price) for turns that
   * succeeded on the cheap model.  Subtracting `totalWastedCost` accounts for
   * the turns where the cheap attempt was discarded — those contributed cost,
   * not savings.
   */
  effectiveSavings(grossSavings: number): number {
    return grossSavings - this._totalWastedCost
  }

  /** Point-in-time snapshot of running totals — safe to log or serialise. */
  snapshot(): LedgerSnapshot {
    return {
      escalations: this._escalations,
      totalWastedCost: this._totalWastedCost,
    }
  }
}
