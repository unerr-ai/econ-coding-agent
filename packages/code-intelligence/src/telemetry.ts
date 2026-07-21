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
 * U6 adds one-shot orchestration decode events (turn triage, evaluator
 * verdict, slice containment, escalation provenance) — minimal structural
 * types decoupled from the triage/evaluator modules that will produce them.
 *
 * @sem domain=observability role=ingestion
 */

import { ECON_MODELS, ECON_PERSONAS, modelProfile, tiersForModel } from "./model-registry"
import type { EconTier } from "./region"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Pricing/capability tier a turn ran on. Kept a free string (not the router's
 * `Tier`) so telemetry stays decoupled from the router module; the conventional
 * values are "conductor" | "executor" | "reasoner" | "oracle" (econ's four
 * agents — no longer collapsed to "cheap"), plus "frontier" for a hatch-turn
 * baseline, "cheap" (the foreign-small-model heuristic bucket), and "unknown".
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
  /** Tier the turn ran on ("conductor" | "executor" | "reasoner" | "oracle" | "frontier" | "cheap"). */
  tier: UsageTier
  /** Computed dollar cost for this turn (`Usage.cost`). */
  cost: number
  /** Token counts for this turn. */
  tokens: UsageEventTokens
  /** Number of tool calls made during this turn. */
  toolCalls: number
}

/** Per-tier usage rollup — the receipt's per-tier drilldown row. */
export interface TierUsage {
  turns: number
  cost: number
  tokens: UsageEventTokens
  totalTokens: number
  toolCalls: number
  /** Peak prompt-side context across this tier's turns: max(input + cacheRead + cacheWrite). */
  peakContextTokens: number
  /** cacheRead / (cacheRead + input + cacheWrite) for this tier; 0 when the denominator is 0. */
  cacheHitRatio: number
}

/** Aggregate totals over a set of usage events, with a per-tier breakdown. */
export interface UsageTotals {
  turns: number
  cost: number
  tokens: UsageEventTokens
  /** Sum of every token field — the denominator for share calculations. */
  totalTokens: number
  toolCalls: number
  /** Peak prompt-side context across all turns: max(input + cacheRead + cacheWrite). */
  peakContextTokens: number
  /** Per-tier rollup, keyed by tier label. */
  byTier: Record<UsageTier, TierUsage>
}

/** Live status data for the status line — derived from the latest + running totals. */
export interface StatusSnapshot {
  /** Tier the most recent turn ran on, or undefined when no turn recorded yet. */
  tier?: UsageTier
  /** Model id of the most recent turn. */
  model?: string
  /** Cumulative cache-hit ratio: cacheRead / (cacheRead + input + cacheWrite), 0 when the denominator is 0. */
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

/** Prompt-side context size for one turn — the peakContextTokens input. */
const contextTokens = (t: UsageEventTokens): number => t.input + t.cacheRead + t.cacheWrite

/** cacheRead / (cacheRead + input + cacheWrite); 0 when the denominator is 0. cacheWrite
 * is a prompt token that MISSED the cache, so it counts toward the denominator as a miss. */
const cacheHitRatioOf = (cacheRead: number, input: number, cacheWrite: number): number => {
  const denom = cacheRead + input + cacheWrite
  return denom > 0 ? cacheRead / denom : 0
}

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

/** Higher-tier-wins rank for collapsing a model's econ tiers to one UsageTier. */
const ECON_TIER_RANK: Record<EconTier, number> = { conductor: 0, executor: 0, reasoner: 1, oracle: 2 }

/**
 * Resolve a raw model id (bare key, model ref with provider prefix, or the
 * exact key) to its ECON_MODELS key, or undefined when it isn't an econ
 * pinned model. `modelIDLower` must already be lower-cased.
 */
function resolveEconModelKey(modelIDLower: string): string | undefined {
  if (modelProfile(modelIDLower)) return modelIDLower
  return Object.keys(ECON_MODELS).find(
    (key) => modelIDLower.endsWith(key) || modelIDLower.includes(key),
  )
}

/**
 * Tier label from an agent name alone. The agent name is a routing claim, not a
 * billing fact — a mislabeled agent can run another tier's model — so this is a
 * disambiguator/fallback for `attributeTier`, never the primary source. Returns
 * the agent name itself for econ's four tiers (conductor and executor are no
 * longer merged into "cheap"); every ECON_PERSONAS agent runs on the executor
 * model, so it attributes to "executor". Returns "unknown" for anything else.
 *
 * @sem domain=observability role=ingestion
 */
export function tierFromAgent(agent: string): UsageTier {
  switch (agent) {
    case "conductor":
      return "conductor"
    case "executor":
      return "executor"
    case "reasoner":
      return "reasoner"
    case "oracle":
      return "oracle"
    default:
      return (ECON_PERSONAS as readonly string[]).includes(agent) ? "executor" : "unknown"
  }
}

/**
 * Best-effort tier label from a model id alone. Econ-pinned models resolve
 * authoritatively through the registry (a tier swap in ECON_TIER_BINDING needs
 * no edit here); foreign models fall to the generic name heuristic — applied
 * only after the registry, because econ's own ids can contain colliding
 * substrings (a cheap-tier id matching a large-family hint, or a large-tier id
 * matching no hint at all). Returns "unknown" when nothing matches so the
 * receipt never guesses.
 *
 * @sem domain=observability role=ingestion
 */
export function inferTier(model: string): UsageTier {
  const m = model.toLowerCase()
  const econKey = resolveEconModelKey(m)
  if (econKey) {
    const tiers = tiersForModel(econKey)
    if (tiers.length > 0) {
      // A model may back more than one tier — pick the highest so the receipt's
      // large-tier share stays conservative. (attributeTier disambiguates with
      // the agent name before falling back to this rank.)
      const best = tiers.reduce((a, b) => (ECON_TIER_RANK[b] > ECON_TIER_RANK[a] ? b : a))
      return best
    }
  }
  // Foreign (non-econ) model: "cheap" here is the generic small-model heuristic bucket, distinct
  // from econ's "conductor"/"executor" tiers above.
  if (ORACLE_HINTS.some((h) => m.includes(h))) return "oracle"
  if (REASONER_HINTS.some((h) => m.includes(h))) return "reasoner"
  if (CHEAP_HINTS.some((h) => m.includes(h))) return "cheap"
  return "unknown"
}

/**
 * The one attribution entry point for usage events: which tier does a turn's
 * spend belong to. Model-id-first — billing follows the model, so a registry
 * match on the model id is ground truth even when the dispatching agent's name
 * claims another tier (an "oracle"-named agent running the reasoner's model is
 * reasoner spend). The agent name is consulted only to disambiguate a model
 * that backs multiple tiers, or when the model id resolves to nothing.
 *
 * @sem domain=observability role=ingestion
 */
export function attributeTier(model: string, agent?: string): UsageTier {
  const econKey = resolveEconModelKey(model.toLowerCase())
  const tiers = econKey ? tiersForModel(econKey) : []
  if (tiers.length === 1) return tiers[0]!
  const fromAgent = agent ? tierFromAgent(agent) : "unknown"
  if (tiers.length > 1) {
    if ((tiers as UsageTier[]).includes(fromAgent)) return fromAgent
    return tiers.reduce((a, b) => (ECON_TIER_RANK[b] > ECON_TIER_RANK[a] ? b : a))
  }
  if (fromAgent !== "unknown") return fromAgent
  return inferTier(model)
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
  /** Tool calls made during this turn; clamped nonNeg, defaults to 0. */
  toolCalls?: number
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
    toolCalls: nonNeg(raw.toolCalls),
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

  /** Aggregate totals with a per-tier breakdown (tokens, tool calls, peak context, cache-hit ratio). */
  totals(): UsageTotals {
    const tokens = emptyTokens()
    let cost = 0
    let toolCalls = 0
    let peakContextTokens = 0
    const rawByTier = new Map<
      UsageTier,
      { turns: number; cost: number; tokens: UsageEventTokens; toolCalls: number; peakContextTokens: number }
    >()
    for (const e of this._events) {
      tokens.input += e.tokens.input
      tokens.output += e.tokens.output
      tokens.reasoning += e.tokens.reasoning
      tokens.cacheRead += e.tokens.cacheRead
      tokens.cacheWrite += e.tokens.cacheWrite
      cost += e.cost
      toolCalls += e.toolCalls
      const ctx = contextTokens(e.tokens)
      if (ctx > peakContextTokens) peakContextTokens = ctx

      const bucket = rawByTier.get(e.tier) ?? {
        turns: 0,
        cost: 0,
        tokens: emptyTokens(),
        toolCalls: 0,
        peakContextTokens: 0,
      }
      bucket.turns += 1
      bucket.cost += e.cost
      bucket.tokens.input += e.tokens.input
      bucket.tokens.output += e.tokens.output
      bucket.tokens.reasoning += e.tokens.reasoning
      bucket.tokens.cacheRead += e.tokens.cacheRead
      bucket.tokens.cacheWrite += e.tokens.cacheWrite
      bucket.toolCalls += e.toolCalls
      if (ctx > bucket.peakContextTokens) bucket.peakContextTokens = ctx
      rawByTier.set(e.tier, bucket)
    }
    const byTier: UsageTotals["byTier"] = {}
    for (const [tier, bucket] of rawByTier) {
      byTier[tier] = {
        turns: bucket.turns,
        cost: bucket.cost,
        tokens: bucket.tokens,
        totalTokens: sumTokens(bucket.tokens),
        toolCalls: bucket.toolCalls,
        peakContextTokens: bucket.peakContextTokens,
        cacheHitRatio: cacheHitRatioOf(bucket.tokens.cacheRead, bucket.tokens.input, bucket.tokens.cacheWrite),
      }
    }
    return {
      turns: this._events.length,
      cost,
      tokens,
      totalTokens: sumTokens(tokens),
      toolCalls,
      peakContextTokens,
      byTier,
    }
  }

  /**
   * Cumulative cache-hit ratio: cacheRead / (cacheRead + input + cacheWrite).
   * Returns 0 when the denominator is 0. Cache-write tokens are prompt tokens
   * that MISSED the cache, so they count toward the denominator as a miss —
   * the write's dollar cost is priced separately in econ-cost.ts.
   */
  cacheHitRatio(): number {
    let read = 0
    let input = 0
    let write = 0
    for (const e of this._events) {
      read += e.tokens.cacheRead
      input += e.tokens.input
      write += e.tokens.cacheWrite
    }
    return cacheHitRatioOf(read, input, write)
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

// ---------------------------------------------------------------------------
// AC-5.2 — efficiency metrics loop
// ---------------------------------------------------------------------------

/** Session-level snapshot of the AC-5.2 efficiency counters — the roll-up the
 * receipt reads to answer "did the context engineering actually help". Cache-
 * hit rate is intentionally not duplicated here: read it from
 * `TelemetryStore.cacheHitRatio()` or the AC-8.4 `TierCacheRollup` snapshot
 * (cache-meter.ts) and merge at the call site — one meter, reused. */
export interface EfficiencyMetricsSnapshot {
  tasksRecorded: number
  totalTaskTokens: number
  /** totalTaskTokens / tasksRecorded, 0 when no task has been recorded yet. */
  tokensPerTask: number
  totalFileReads: number
  /** File reads beyond each path's first — reads that should have been a context/cache reuse. */
  reReadCount: number
  /** reReadCount / totalFileReads, 0 when no reads recorded yet. */
  reReadRate: number
  compactions: number
  productiveCompactions: number
  /** productiveCompactions / compactions; undefined when no compaction has fired yet. */
  postCompactionSuccessRate?: number
}

/** One post-compaction continuation signal — a plain counted boolean, not an
 * LLM judge (AC-5.2 explicitly rules out judged success). */
export interface CompactionOutcomeEvent {
  sessionID: string
  timestamp: number
  /** True when the session recorded at least one more productive turn after the compaction fired. */
  productiveContinuation: boolean
}

/**
 * In-memory accumulator for the AC-5.2 efficiency metrics: tokens-per-task,
 * file re-read rate, and post-compaction continuation. Pure counters — no
 * I/O, no LLM judgement — so the receipt can prove the context-engineering
 * layer helped instead of assuming it did. Mirrors `TelemetryStore` /
 * `DoublePayLedger`'s accumulate-then-`snapshot` shape.
 *
 * @sem domain=observability role=accounting
 */
export class EfficiencyMetrics {
  private _taskTokens = 0
  private _tasksRecorded = 0
  private _fileReads = new Map<string, number>()
  private _compactions = 0
  private _productiveCompactions = 0

  /** Record one completed task's total token spend. */
  recordTask(tokens: number): void {
    this._taskTokens += nonNeg(tokens)
    this._tasksRecorded += 1
  }

  /** Record one file read; a path seen again this session is a re-read. */
  recordFileRead(path: string): void {
    this._fileReads.set(path, (this._fileReads.get(path) ?? 0) + 1)
  }

  /**
   * Record whether the session kept making progress after a compaction
   * fired, and optionally forward the event to a telemetry sink (same
   * injected-`emit` convention as `recordCacheHit` / `recordEscalation`).
   */
  recordCompactionOutcome(
    input: { sessionID: string; productiveContinuation: boolean; timestamp?: number },
    emit?: (event: CompactionOutcomeEvent) => void,
  ): CompactionOutcomeEvent {
    this._compactions += 1
    if (input.productiveContinuation) this._productiveCompactions += 1
    const event: CompactionOutcomeEvent = {
      sessionID: input.sessionID,
      timestamp: input.timestamp ?? Date.now(),
      productiveContinuation: input.productiveContinuation,
    }
    emit?.(event)
    return event
  }

  /** Point-in-time snapshot of all AC-5.2 counters — safe to log or fold into the receipt. */
  snapshot(): EfficiencyMetricsSnapshot {
    let totalFileReads = 0
    let reReadCount = 0
    for (const count of this._fileReads.values()) {
      totalFileReads += count
      if (count > 1) reReadCount += count - 1
    }
    return {
      tasksRecorded: this._tasksRecorded,
      totalTaskTokens: this._taskTokens,
      tokensPerTask: this._tasksRecorded > 0 ? this._taskTokens / this._tasksRecorded : 0,
      totalFileReads,
      reReadCount,
      reReadRate: totalFileReads > 0 ? reReadCount / totalFileReads : 0,
      compactions: this._compactions,
      productiveCompactions: this._productiveCompactions,
      postCompactionSuccessRate:
        this._compactions > 0 ? this._productiveCompactions / this._compactions : undefined,
    }
  }
}

// ---------------------------------------------------------------------------
// U6 — orchestration decode events (ORCHESTRATION_MECHANISM.md §1.8, §6 U6)
// ---------------------------------------------------------------------------
//
// One-shot facts from the new mechanism's stages (triage, evaluator, containment,
// escalation), each a minimal structural type — no import from the evaluator/
// triage modules that produce them (those land in a later wiring pass). Mirrors
// `emitUsageEvent`'s shape: build from a raw input, stamp a default timestamp,
// forward to an optional sink, return the built event.

/** Turn-triage verdict: the goals a prompt was split into (U1). */
export interface TurnTriageEvent {
  type: "turn_triage"
  sessionID: string
  timestamp: number
  goals: Array<{ summary: string; shape: string }>
}

/** Pre-dispatch evaluator verdict for one slice (U4). */
export interface EvaluatorVerdictEvent {
  type: "evaluator_verdict"
  sessionID: string
  timestamp: number
  sliceId: string
  tier: UsageTier
  venue: "inline" | "child"
  reasons: string[]
}

/** A failed slice attempt contained by the snapshot bracket (U3). */
export interface SliceContainedEvent {
  type: "slice_contained"
  sessionID: string
  timestamp: number
  sliceId: string
  fromTier: UsageTier
  toTier?: UsageTier
  rungReason: string
  reverted: boolean
}

/** Why an escalation fired — the decode gap U3 logs at INFO. */
export interface EscalationProvenanceEvent {
  type: "escalation_provenance"
  sessionID: string
  timestamp: number
  sliceId: string
  fromTier: UsageTier
  toTier: UsageTier
  reason: string
}

/**
 * Build a `TurnTriageEvent` and optionally forward it to a sink.
 *
 * @sem domain=observability role=ingestion
 */
export function emitTurnTriageEvent(
  raw: { sessionID: string; goals: Array<{ summary: string; shape: string }>; timestamp?: number },
  sink?: (event: TurnTriageEvent) => void,
): TurnTriageEvent {
  const event: TurnTriageEvent = {
    type: "turn_triage",
    sessionID: raw.sessionID,
    timestamp: raw.timestamp ?? Date.now(),
    goals: raw.goals,
  }
  sink?.(event)
  return event
}

/**
 * Build an `EvaluatorVerdictEvent` and optionally forward it to a sink.
 *
 * @sem domain=observability role=ingestion
 */
export function emitEvaluatorVerdictEvent(
  raw: {
    sessionID: string
    sliceId: string
    tier: UsageTier
    venue: "inline" | "child"
    reasons: string[]
    timestamp?: number
  },
  sink?: (event: EvaluatorVerdictEvent) => void,
): EvaluatorVerdictEvent {
  const event: EvaluatorVerdictEvent = {
    type: "evaluator_verdict",
    sessionID: raw.sessionID,
    timestamp: raw.timestamp ?? Date.now(),
    sliceId: raw.sliceId,
    tier: raw.tier,
    venue: raw.venue,
    reasons: raw.reasons,
  }
  sink?.(event)
  return event
}

/**
 * Build a `SliceContainedEvent` and optionally forward it to a sink.
 *
 * @sem domain=observability role=ingestion
 */
export function emitSliceContainedEvent(
  raw: {
    sessionID: string
    sliceId: string
    fromTier: UsageTier
    toTier?: UsageTier
    rungReason: string
    reverted: boolean
    timestamp?: number
  },
  sink?: (event: SliceContainedEvent) => void,
): SliceContainedEvent {
  const event: SliceContainedEvent = {
    type: "slice_contained",
    sessionID: raw.sessionID,
    timestamp: raw.timestamp ?? Date.now(),
    sliceId: raw.sliceId,
    fromTier: raw.fromTier,
    toTier: raw.toTier,
    rungReason: raw.rungReason,
    reverted: raw.reverted,
  }
  sink?.(event)
  return event
}

/**
 * Build an `EscalationProvenanceEvent` and optionally forward it to a sink.
 *
 * @sem domain=observability role=ingestion
 */
export function emitEscalationProvenanceEvent(
  raw: { sessionID: string; sliceId: string; fromTier: UsageTier; toTier: UsageTier; reason: string; timestamp?: number },
  sink?: (event: EscalationProvenanceEvent) => void,
): EscalationProvenanceEvent {
  const event: EscalationProvenanceEvent = {
    type: "escalation_provenance",
    sessionID: raw.sessionID,
    timestamp: raw.timestamp ?? Date.now(),
    sliceId: raw.sliceId,
    fromTier: raw.fromTier,
    toTier: raw.toTier,
    reason: raw.reason,
  }
  sink?.(event)
  return event
}
