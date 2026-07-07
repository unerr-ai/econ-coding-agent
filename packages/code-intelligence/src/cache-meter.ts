/**
 * Per-turn cache-hit-rate meter (AC-0.4) plus the AC-8.4 per-tier rollup — a
 * warm prompt cache is the single biggest cost lever on cheap models, so this
 * module measures it every turn instead of assuming it, then aggregates by
 * `tier` to catch a cold-running tier and count cross-tier cache flushes.
 * Mirrors `double-pay.ts`'s `emit` callback / `DoublePayLedger` `add`+
 * `snapshot` convention (no new transport): the caller wires the returned
 * event into whatever telemetry sink it already has (e.g. `installUsageSink`'s
 * forward), and feeds the same event into `TierCacheRollup.add`.
 *
 * @sem domain=observability role=ingestion
 */

import type { UsageEventTokens, UsageTier } from "./telemetry.js"

/** Below this cache-hit rate on a warm turn, the turn is flagged for WARN. */
const CACHE_HIT_WARN_THRESHOLD = 0.8

/** One measured cache-hit sample for a turn. */
export interface CacheHitEvent {
  sessionID: string
  turnId?: string
  timestamp: number
  /** Pricing/capability tier the turn ran on, when known — AC-8.4 rollup key. */
  tier?: UsageTier
  /** Model id that served the turn, when known — AC-8.4 rollup key. */
  modelID?: string
  cacheRead: number
  cacheWrite: number
  input: number
  cacheHitRate: number
  /** true when hitRate < 0.80 on a turn that should have hit a warm cache. */
  warn: boolean
  /** Dollar cost for this turn, when known — AC-8.4 per-tier cost rollup; 0 when omitted. */
  cost: number
}

/** Inputs to `recordCacheHit` — the token counts plus enough turn context to
 * decide whether a low hit rate is expected (first turn) or a regression. */
export interface CacheHitInput {
  sessionID: string
  turnId?: string
  tokens: Pick<UsageEventTokens, "cacheRead" | "cacheWrite" | "input">
  /** True for the session's first turn, which has no warm cache to hit yet. */
  isFirstTurn: boolean
  tier?: UsageTier
  modelID?: string
  /** Dollar cost for this turn, when known — AC-8.4 per-tier cost rollup. */
  cost?: number
  /** Override the recorded timestamp (defaults to Date.now()); injectable for tests. */
  timestamp?: number
}

/**
 * Cache-hit rate for one turn: `cacheRead / (cacheRead + input + cacheWrite)`,
 * clamped to 0 when the denominator is zero. cacheWrite tokens are prompt
 * tokens that MISSED the cache, so they count toward the denominator as a
 * miss. Pure — no I/O — so it is safe to call from both the recorder below
 * and any future per-tier rollup.
 *
 * @sem domain=observability role=ingestion
 */
export function computeCacheHitRate(
  tokens: Pick<UsageEventTokens, "cacheRead" | "input" | "cacheWrite">,
): number {
  const denom = tokens.cacheRead + tokens.input + tokens.cacheWrite
  return denom > 0 ? tokens.cacheRead / denom : 0
}

/**
 * Compute one turn's cache-hit rate, WARN-log it when it falls below 80% on a
 * turn that isn't the session's first (a cold first turn has nothing to warm
 * yet), and forward the resulting `CacheHitEvent` through the caller-supplied
 * `emit` callback — reusing the same injected-sink pattern as `emitUsageEvent`
 * / `recordEscalation` rather than a new transport.
 *
 * @sem domain=observability role=ingestion
 */
export function recordCacheHit(
  input: CacheHitInput,
  emit?: (event: CacheHitEvent) => void,
): CacheHitEvent {
  const cacheHitRate = computeCacheHitRate(input.tokens)
  const warn = !input.isFirstTurn && cacheHitRate < CACHE_HIT_WARN_THRESHOLD
  const event: CacheHitEvent = {
    sessionID: input.sessionID,
    turnId: input.turnId,
    timestamp: input.timestamp ?? Date.now(),
    tier: input.tier,
    modelID: input.modelID,
    cacheRead: input.tokens.cacheRead,
    cacheWrite: input.tokens.cacheWrite,
    input: input.tokens.input,
    cacheHitRate,
    warn,
    cost: input.cost ?? 0,
  }
  if (warn) {
    console.warn(
      `[cache-meter] low cache-hit rate ${(cacheHitRate * 100).toFixed(1)}% on turn ${
        event.turnId ?? "?"
      } (session ${event.sessionID})`,
    )
  }
  emit?.(event)
  return event
}

// ---------------------------------------------------------------------------
// AC-8.4 — per-tier cache-hit-rate + cross-tier transition rollup
// ---------------------------------------------------------------------------

/** Below this cumulative per-tier hit rate, `TierCacheRollup` flags the tier for WARN. */
const TIER_CACHE_HIT_FLAG_THRESHOLD = 0.7

/** Target sustained per-tier cache-hit rate (informational reference point, not enforced). */
export const TIER_CACHE_HIT_TARGET = 0.85

/** One pair of consecutive turns that ran on a different tier — the target
 * model's warm KV cache is gone, so the next turn on that tier cold-starts. */
export interface CrossTierTransitionEvent {
  sessionID: string
  timestamp: number
  fromTier: UsageTier
  toTier: UsageTier
}

/** Running per-tier totals plus the derived cumulative hit rate. */
export interface TierCacheStats {
  tier: UsageTier
  turns: number
  cacheRead: number
  cacheWrite: number
  input: number
  cost: number
  hitRate: number
  /** true when hitRate < 70% (`TIER_CACHE_HIT_FLAG_THRESHOLD`) — AC-8.4 WARN. */
  flagged: boolean
}

/** Point-in-time snapshot of a `TierCacheRollup` — safe to log, fold into the receipt, or assert on in tests. */
export interface TierCacheSnapshot {
  byTier: Record<string, TierCacheStats>
  crossTierTransitions: number
  transitions: readonly CrossTierTransitionEvent[]
}

/** One signal a `TierCacheRollup.add` call can raise, discriminated by `kind`. */
export type TierCacheRollupSignal =
  | { kind: "transition"; event: CrossTierTransitionEvent }
  | { kind: "flag"; stats: TierCacheStats }

/**
 * Session-scoped accumulator that folds `CacheHitEvent`s into per-tier
 * hit-rate + cost totals and counts COLD cross-tier transitions — each time
 * consecutive turns run on a different tier, the target model's warm cache is
 * gone and the next turn on that tier starts cold. WARNs (and forwards, via
 * the optional `emit`) the moment a tier's cumulative hit rate drops below
 * 70%. Mirrors `DoublePayLedger`'s `add` + `snapshot` shape.
 *
 * @sem domain=observability role=accounting
 */
export class TierCacheRollup {
  private _byTier = new Map<
    UsageTier,
    { turns: number; cacheRead: number; cacheWrite: number; input: number; cost: number }
  >()
  private _lastTier?: UsageTier
  private _transitions: CrossTierTransitionEvent[] = []

  /** Fold one turn's cache-hit event into the per-tier totals and transition count. */
  add(event: CacheHitEvent, emit?: (signal: TierCacheRollupSignal) => void): void {
    const tier = event.tier ?? "unknown"
    if (this._lastTier !== undefined && this._lastTier !== tier) {
      const transition: CrossTierTransitionEvent = {
        sessionID: event.sessionID,
        timestamp: event.timestamp,
        fromTier: this._lastTier,
        toTier: tier,
      }
      this._transitions.push(transition)
      emit?.({ kind: "transition", event: transition })
    }
    this._lastTier = tier

    const bucket = this._byTier.get(tier) ?? { turns: 0, cacheRead: 0, cacheWrite: 0, input: 0, cost: 0 }
    bucket.turns += 1
    bucket.cacheRead += event.cacheRead
    bucket.cacheWrite += event.cacheWrite
    bucket.input += event.input
    bucket.cost += event.cost
    this._byTier.set(tier, bucket)

    const hitRate = computeCacheHitRate({
      cacheRead: bucket.cacheRead,
      input: bucket.input,
      cacheWrite: bucket.cacheWrite,
    })
    const flagged = hitRate < TIER_CACHE_HIT_FLAG_THRESHOLD
    if (flagged) {
      const stats: TierCacheStats = {
        tier,
        turns: bucket.turns,
        cacheRead: bucket.cacheRead,
        cacheWrite: bucket.cacheWrite,
        input: bucket.input,
        cost: bucket.cost,
        hitRate,
        flagged,
      }
      console.warn(
        `[cache-meter] tier "${tier}" cumulative cache-hit rate ${(hitRate * 100).toFixed(1)}% is below the 70% flag threshold (session ${event.sessionID})`,
      )
      emit?.({ kind: "flag", stats })
    }
  }

  /** Number of cold cross-tier transitions recorded this session. */
  get crossTierTransitions(): number {
    return this._transitions.length
  }

  /** Point-in-time snapshot — per-tier stats plus the transition count/list. */
  snapshot(): TierCacheSnapshot {
    const byTier: Record<string, TierCacheStats> = {}
    for (const [tier, bucket] of this._byTier) {
      const hitRate = computeCacheHitRate({
        cacheRead: bucket.cacheRead,
        input: bucket.input,
        cacheWrite: bucket.cacheWrite,
      })
      byTier[tier] = {
        tier,
        turns: bucket.turns,
        cacheRead: bucket.cacheRead,
        cacheWrite: bucket.cacheWrite,
        input: bucket.input,
        cost: bucket.cost,
        hitRate,
        flagged: hitRate < TIER_CACHE_HIT_FLAG_THRESHOLD,
      }
    }
    return { byTier, crossTierTransitions: this._transitions.length, transitions: this._transitions }
  }
}
