/**
 * Per-turn usage telemetry — the ingestion side of econ's proof surface.
 *
 * Each provider turn surfaces a computed `cost` plus token counts (S0.3); this
 * module normalises those into a `UsageEvent`, accumulates them in an in-memory
 * `TelemetryStore`, and derives the live status data (context fill, cache-hit
 * ratio, tier in use) the status line renders. We count what actually happened
 * rather than promising savings up front — the receipt (receipt.ts) reads this
 * store to produce the honest end-of-turn figure.
 *
 * All state is in-memory; forwarding to unerr telemetry is injected via the
 * `emit` sink so this module stays free of any provider or unerr SDK coupling
 * (mirrors double-pay.ts's emit pattern).
 *
 * @sem domain=observability role=ingestion
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Pricing/capability tier a turn ran on. Kept a free string (not the router's
 * `Tier`) so telemetry stays decoupled from the router module; the conventional
 * values are "cheap" | "oracle" | "reasoner", plus "frontier" for a baseline.
 */
export type UsageTier = string

/** Token counts for one turn — mirrors the Step.Ended `tokens` shape (S0.3). */
export interface UsageEventTokens {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

/** One normalised usage record: the unit the store accumulates. */
export interface UsageEvent {
  /** Session the turn belongs to. */
  sessionID: string
  /** Assistant message / turn id, when known. */
  turnId?: string
  /** Epoch millis the event was recorded. */
  timestamp: number
  /** Model id that served the turn. */
  model: string
  /** Tier the turn ran on ("cheap" | "oracle" | "reasoner" | "frontier"). */
  tier: UsageTier
  /** Computed dollar cost for this turn (`Usage.cost`). */
  cost: number
  /** Token counts for this turn. */
  tokens: UsageEventTokens
}

/** Aggregate totals over a set of usage events, with a per-tier breakdown. */
export interface UsageTotals {
  turns: number
  cost: number
  tokens: UsageEventTokens
  /** Sum of every token field — the denominator for share calculations. */
  totalTokens: number
  /** Per-tier rollup, keyed by tier label. */
  byTier: Record<UsageTier, { turns: number; cost: number; totalTokens: number }>
}

/** Live status data for the status line — derived from the latest + running totals. */
export interface StatusSnapshot {
  /** Tier the most recent turn ran on, or undefined when no turn recorded yet. */
  tier?: UsageTier
  /** Model id of the most recent turn. */
  model?: string
  /** Cumulative cache-hit ratio: cacheRead / (cacheRead + input), 0 when no input. */
  cacheHitRatio: number
  /** Fraction of the context window filled by the latest turn, when a limit is given. */
  contextFill?: number
  /** Latest turn's total token count (the numerator for contextFill). */
  latestTokens: number
  /** Running cumulative cost across all recorded turns. */
  cumulativeCost: number
  turns: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const nonNeg = (value: number | undefined): number =>
  Math.max(0, Number.isFinite(value) ? (value as number) : 0)

const sumTokens = (t: UsageEventTokens): number =>
  t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite

const emptyTokens = (): UsageEventTokens => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
})

// ---------------------------------------------------------------------------
// inferTier
// ---------------------------------------------------------------------------

/** Substrings that mark a frontier-class / oracle model. */
const ORACLE_HINTS = ["opus", "gpt-4", "gpt4", "gpt-5", "o1", "o3", "sonnet-4", "ultra"]
/** Substrings that mark the cheap small-model tier. */
const CHEAP_HINTS = ["haiku", "mini", "nano", "flash", "qwen", "8b", "7b", "small", "lite"]
/** Substrings that mark the mid reasoner tier. */
const REASONER_HINTS = ["32b", "reason", "r1", "sonnet", "medium", "70b", "deepseek"]

/**
 * Best-effort tier label from a model id when the router has not tagged the turn
 * directly. A name heuristic only — the authoritative tier is the router's S3.2
 * decision; wire that through `RawUsage.tier` once the router is on the turn
 * path. Returns "unknown" when no hint matches so the receipt never lies about
 * which tier ran.
 *
 * @sem domain=observability role=ingestion
 */
export function inferTier(model: string): UsageTier {
  const m = model.toLowerCase()
  if (ORACLE_HINTS.some((h) => m.includes(h))) return "oracle"
  if (REASONER_HINTS.some((h) => m.includes(h))) return "reasoner"
  if (CHEAP_HINTS.some((h) => m.includes(h))) return "cheap"
  return "unknown"
}

// ---------------------------------------------------------------------------
// emitUsageEvent
// ---------------------------------------------------------------------------

/** Raw shape accepted by the writer — the nested `cache` form matches the
 * Step.Ended payload so the runner can hand it across verbatim. */
export interface RawUsage {
  sessionID: string
  turnId?: string
  model: string
  /** Authoritative router tier; when omitted it is inferred from `model`. */
  tier?: UsageTier
  cost?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
  /** Override the recorded timestamp (defaults to Date.now()); injectable for tests. */
  timestamp?: number
}

/**
 * Normalise a raw per-turn usage payload into a `UsageEvent`, append it to the
 * store, and optionally forward it to a telemetry sink. This is econ's
 * `emitSavingsEvent`-style writer — the single entry point the session runner
 * calls once per turn (done-when for S7.1).
 *
 * Negative / non-finite token and cost values are clamped to zero so a noisy
 * provider payload cannot poison the running totals.
 *
 * @sem domain=observability role=ingestion
 */
export function emitUsageEvent(
  store: TelemetryStore,
  raw: RawUsage,
  sink?: (event: UsageEvent) => void,
): UsageEvent {
  const event: UsageEvent = {
    sessionID: raw.sessionID,
    turnId: raw.turnId,
    timestamp: raw.timestamp ?? Date.now(),
    model: raw.model,
    tier: raw.tier ?? inferTier(raw.model),
    cost: nonNeg(raw.cost),
    tokens: {
      input: nonNeg(raw.tokens?.input),
      output: nonNeg(raw.tokens?.output),
      reasoning: nonNeg(raw.tokens?.reasoning),
      cacheRead: nonNeg(raw.tokens?.cache?.read),
      cacheWrite: nonNeg(raw.tokens?.cache?.write),
    },
  }
  store.append(event)
  sink?.(event)
  return event
}

// ---------------------------------------------------------------------------
// Process-level sink — the seam the session runner forwards to
// ---------------------------------------------------------------------------

/** Global key under which the runner looks up the optional usage sink. */
const SINK_KEY = "__econUsageSink"

interface SinkGlobal {
  [SINK_KEY]?: (raw: RawUsage) => void
}

/**
 * Install a process-level usage sink that appends every forwarded turn into
 * `store` (and an optional downstream `forward`, e.g. unerr telemetry).
 *
 * The session runner (publish-llm-event.ts) forwards each turn's usage to this
 * sink WITHOUT a compile-time import of this package — keeping `@opencode-ai/
 * core` free of an observability dependency. Call this once at app bootstrap;
 * returns a disposer that removes the sink.
 *
 * @sem domain=observability role=ingestion
 */
export function installUsageSink(
  store: TelemetryStore,
  forward?: (event: UsageEvent) => void,
): () => void {
  const g = globalThis as SinkGlobal
  g[SINK_KEY] = (raw) => emitUsageEvent(store, raw, forward)
  return () => {
    if ((globalThis as SinkGlobal)[SINK_KEY]) delete (globalThis as SinkGlobal)[SINK_KEY]
  }
}

// ---------------------------------------------------------------------------
// TelemetryStore
// ---------------------------------------------------------------------------

/**
 * In-memory accumulator of `UsageEvent`s for one session (or process). Exposes
 * running totals, the cumulative cache-hit ratio, and a status snapshot for the
 * status line. Append-only; `clear()` resets between sessions.
 *
 * @sem domain=observability role=store
 */
export class TelemetryStore {
  private _events: UsageEvent[] = []

  /** Append one normalised event. Use `emitUsageEvent` to build + append in one call. */
  append(event: UsageEvent): void {
    this._events.push(event)
  }

  /** All recorded events in arrival order (read-only view). */
  all(): readonly UsageEvent[] {
    return this._events
  }

  /** Most recently appended event, or undefined when empty. */
  latest(): UsageEvent | undefined {
    return this._events[this._events.length - 1]
  }

  /** Number of recorded turns. */
  get count(): number {
    return this._events.length
  }

  /** Aggregate totals with a per-tier breakdown. */
  totals(): UsageTotals {
    const tokens = emptyTokens()
    const byTier: UsageTotals["byTier"] = {}
    let cost = 0
    for (const e of this._events) {
      tokens.input += e.tokens.input
      tokens.output += e.tokens.output
      tokens.reasoning += e.tokens.reasoning
      tokens.cacheRead += e.tokens.cacheRead
      tokens.cacheWrite += e.tokens.cacheWrite
      cost += e.cost
      const bucket = (byTier[e.tier] ??= { turns: 0, cost: 0, totalTokens: 0 })
      bucket.turns += 1
      bucket.cost += e.cost
      bucket.totalTokens += sumTokens(e.tokens)
    }
    return { turns: this._events.length, cost, tokens, totalTokens: sumTokens(tokens), byTier }
  }

  /**
   * Cumulative cache-hit ratio: cacheRead / (cacheRead + non-cached input).
   * Returns 0 when no billable input has been seen. Cache-write is excluded —
   * it is a cost, not a hit.
   */
  cacheHitRatio(): number {
    let read = 0
    let input = 0
    for (const e of this._events) {
      read += e.tokens.cacheRead
      input += e.tokens.input
    }
    const denom = read + input
    return denom > 0 ? read / denom : 0
  }

  /**
   * Build the live status snapshot for the status line. Pass the active model's
   * context-window `contextLimit` to populate `contextFill`; omit it and the
   * field is left undefined.
   */
  status(contextLimit?: number): StatusSnapshot {
    const latest = this.latest()
    const latestTokens = latest ? sumTokens(latest.tokens) : 0
    const totals = this.totals()
    return {
      tier: latest?.tier,
      model: latest?.model,
      cacheHitRatio: this.cacheHitRatio(),
      contextFill:
        contextLimit && contextLimit > 0 ? latestTokens / contextLimit : undefined,
      latestTokens,
      cumulativeCost: totals.cost,
      turns: totals.turns,
    }
  }

  /** Drop all events — resets the store between sessions. */
  clear(): void {
    this._events = []
  }
}
