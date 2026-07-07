/**
 * OL-7.8a execution-free reward-model verifier rung: scores a slice's
 * trajectory + patch through a hosted judge with no tests required, and
 * plugs into the verifier ladder's `ExtraRungFn` extension point ahead of
 * QE. Off by default (`ECON_VERIFIER_RM=off`); the endpoint client is
 * injected so no live HTTP happens in unit tests. Endpoint error/timeout is
 * a clean degrade — the rung abstains (falls through to the next rung)
 * rather than vetoing or accepting on the slice's behalf, and every call
 * (accept/reject/degrade) is metered the same way `double-pay.ts` meters
 * escalation cost: a pluggable `emit` sink plus a small in-memory ledger for
 * session totals.
 *
 * @sem domain=routing role=verify-ladder
 */

import type { ExtraRungFn, ExtraRungVerdict, SliceTrajectory, SoundVerdict, BehaviorResult } from "./verifier.js"
import type { VerifierTierConfig } from "./model-registry.js"

// ---------------------------------------------------------------------------
// RM client — injected, no live HTTP in unit tests
// ---------------------------------------------------------------------------

/** One RM scoring call's input — the same shape the ladder's extra rung sees. */
export interface RmScoreInput {
  trajectory: SliceTrajectory
  sound: SoundVerdict
  behavior: BehaviorResult
}

/** The RM endpoint's raw response — a 0-1 correctness score with optional explanation. */
export interface RmScoreResponse {
  score: number
  detail?: string
}

/** Injectable client for the hosted RM endpoint — a real fetch-based impl in prod, a stub in tests. */
export type RmClient = (endpoint: string, input: RmScoreInput) => Promise<RmScoreResponse>

/** Score at or above which the RM rung accepts the slice. */
export const RM_ACCEPT_THRESHOLD = 0.5

// ---------------------------------------------------------------------------
// Metering — mirrors the double-pay ledger shape (emit sink + running totals)
// ---------------------------------------------------------------------------

/** RM rung event kinds metered per the OL-7.8a done-when (catch/false-accept feed off `accept`/`reject`; degrade is its own line). */
export type RmMeterEventKind = "accept" | "reject" | "degrade"

/** One metered RM rung outcome. */
export interface RmMeterEvent {
  kind: RmMeterEventKind
  score?: number
  detail?: string
  timestamp: number
}

/** Point-in-time snapshot of the RM ledger totals. */
export interface RmLedgerSnapshot {
  accepts: number
  rejects: number
  degrades: number
}

/**
 * In-memory aggregator that accumulates `RmMeterEvent`s and exposes
 * session-level totals for the savings receipt / eval tooling — the RM
 * counterpart to `DoublePayLedger` in `double-pay.ts`.
 *
 * @sem domain=routing role=accounting
 */
export class RmVerifierLedger {
  private _accepts = 0
  private _rejects = 0
  private _degrades = 0

  /** Accumulate one RM rung event into the running totals. */
  add(event: RmMeterEvent): void {
    if (event.kind === "accept") this._accepts += 1
    else if (event.kind === "reject") this._rejects += 1
    else this._degrades += 1
  }

  /** Point-in-time snapshot of running totals — safe to log or serialise. */
  get snapshot(): RmLedgerSnapshot {
    return { accepts: this._accepts, rejects: this._rejects, degrades: this._degrades }
  }
}

// ---------------------------------------------------------------------------
// The rung
// ---------------------------------------------------------------------------

/**
 * Build the RM verifier rung as an `ExtraRungFn`. Skips entirely (returns
 * `undefined`, no client call) when the verifier tier is disabled — the
 * clean-degrade path that keeps flag-off behavior byte-identical. When
 * enabled, scores the slice through the injected client and translates the
 * 0-1 score into a pass/fail verdict; a client error or rejected promise
 * (timeout) is caught and treated as an abstain, never a throw, with the
 * degrade metered through `emit`.
 *
 * @sem domain=routing role=verify-ladder
 */
export function createRmVerifierRung(
  tier: VerifierTierConfig,
  client: RmClient,
  emit?: (event: RmMeterEvent) => void,
): ExtraRungFn {
  return async (ctx) => {
    if (!tier.enabled || !tier.endpoint) return undefined

    let response: RmScoreResponse
    try {
      response = await client(tier.endpoint, {
        trajectory: ctx.trajectory,
        sound: ctx.sound,
        behavior: ctx.behavior,
      })
    } catch (err) {
      emit?.({
        kind: "degrade",
        detail: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      })
      return undefined
    }

    const pass = response.score >= RM_ACCEPT_THRESHOLD
    emit?.({
      kind: pass ? "accept" : "reject",
      score: response.score,
      detail: response.detail,
      timestamp: Date.now(),
    })
    const verdict: ExtraRungVerdict = { rung: "rm", pass, detail: response.detail }
    return verdict
  }
}
