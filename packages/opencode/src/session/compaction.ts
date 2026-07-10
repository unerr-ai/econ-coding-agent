import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Session } from "./session"
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"
import { Token } from "@/util/token"
import { SessionProcessor } from "./processor"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { NotFoundError } from "@/storage/storage"

import { Effect, Layer, Context } from "effect"
import * as DateTime from "effect/DateTime"
import { InstanceState } from "@/effect/instance-state"
import { isOverflow as overflow, usable } from "./overflow"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { EventV2 } from "@opencode-ai/core/event"
import { buildPrompt } from "@opencode-ai/core/session/compaction"
import { Glob } from "@opencode-ai/core/util/glob"
import { SessionCanonicalState } from "@opencode-ai/core/session/canonical-state"
import { Database } from "@opencode-ai/core/database/database"
import { ExecutionFrontier } from "./execution-frontier"

export const Event = {
  Compacted: EventV2.define({
    type: "session.compacted",
    schema: {
      sessionID: SessionID,
    },
  }),
}

export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
// L2.1 — step-recency protection: prune() never touches parts in the most
// recent K assistant messages (steps). Replaces the dead user-turn gate
// (`turns < 2`), which never fired in single-user-turn `opencode run`
// sessions. Composes with PRUNE_PROTECT (token recency) and PRUNE_MINIMUM
// (eviction amortization) — gate first, then token budget on the older region.
export const PRUNE_PROTECT_STEPS = 5
// L2.2 — mask-eviction amortization floor, same rationale as PRUNE_MINIMUM:
// implicit caching has $0 writes, so an eviction's only penalty is a one-time
// re-ingest of the post-edit suffix at ~5× the cached-read price — masking
// must reclaim at least this many tokens per pass to pay for that re-ingest.
export const MASK_MINIMUM = 10_000
// L2.2 — in-loop $0-compaction cadence (prompt.ts step loop): fire the
// deterministic passes (mask → stale-read drop → prune) every
// STEP_COMPACT_INTERVAL steps, or as soon as the estimated live context
// crosses the economic ceiling — whichever comes first. Run sessions have
// exactly one user turn and end it when the task is done, so the turn-end
// and 524k-overflow triggers never fire mid-run without this.
export const STEP_COMPACT_INTERVAL = 10
export const STEP_CTX_ECONOMIC_CEILING = 40_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const PRUNE_PROTECTED_TOOLS = ["skill"]
// AC-1.3: canonical single-file read/write tool ids for unerr-graph-aware staleness
// detection — kept minimal (excludes grep/glob/apply_patch, whose `path`/patch text
// isn't a single exact file match) to stay a precise, low-false-positive heuristic.
const READ_TOOLS = ["read"]
const WRITE_TOOLS = ["edit", "write"]
const DEFAULT_TAIL_TURNS = 2
const MIN_PRESERVE_RECENT_TOKENS = 2_000
const MAX_PRESERVE_RECENT_TOKENS = 8_000
// AC-1.2/1.6/1.7 defaults — mirrored in packages/core/src/v1/config/config.ts descriptions.
const DEFAULT_KEEP_RAW_TOOL_RESULTS = 5
const DEFAULT_MIN_REDUCTION = 8_000
const DEFAULT_MIN_GAP_MESSAGES = 8
// AC-1.8 default — mirrored in packages/core/src/v1/config/config.ts description.
const DEFAULT_MIN_TURNS_BEFORE_COMPACT = 3
// Bounded window (in trigger count) of auto-compaction fires with no intervening
// progress before we give up and surface a hard error instead of looping forever.
const COMPACTION_DOOM_LOOP_THRESHOLD = 3
// AC-6.1 — protected/pinned region guardrail: pins/paths/plan crowding out more
// than this share of the model's usable budget only logs a warning (plan §10
// over-pinning risk) — never a hard fail.
const PROTECTED_TOKEN_WARN_FRACTION = 0.5
type Turn = {
  start: number
  end: number
  id: MessageID
}

type Tail = {
  start: number
  id: MessageID
}

type CompletedCompaction = {
  userIndex: number
  assistantIndex: number
  summary: string | undefined
}

function summaryText(message: SessionV1.WithParts) {
  const text = message.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return text || undefined
}

function completedCompactions(messages: SessionV1.WithParts[]) {
  const users = new Map<MessageID, number>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (!msg.parts.some((part) => part.type === "compaction")) continue
    users.set(msg.info.id, i)
  }

  return messages.flatMap((msg, assistantIndex): CompletedCompaction[] => {
    if (msg.info.role !== "assistant") return []
    if (!msg.info.summary || !msg.info.finish || msg.info.error) return []
    const userIndex = users.get(msg.info.parentID)
    if (userIndex === undefined) return []
    return [{ userIndex, assistantIndex, summary: summaryText(msg) }]
  })
}

// AC-4.4: flattens a message batch to the {messageID, partIDs} shape the
// pre-compaction diff event reports for its drop/keep sets.
function diffEntries(messages: SessionV1.WithParts[]) {
  return messages.map((msg) => ({
    messageID: msg.info.id,
    partIDs: msg.parts.map((part) => part.id),
  }))
}

function preserveRecentBudget(input: { cfg: ConfigV1.Info; model: Provider.Model }) {
  return (
    input.cfg.compaction?.preserve_recent_tokens ??
    Math.min(MAX_PRESERVE_RECENT_TOKENS, Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable(input) * 0.25)))
  )
}

function turns(messages: SessionV1.WithParts[]) {
  const result: Turn[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (msg.parts.some((part) => part.type === "compaction")) continue
    result.push({
      start: i,
      end: messages.length,
      id: msg.info.id,
    })
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i].end = result[i + 1].start
  }
  return result
}

function splitTurn(input: {
  messages: SessionV1.WithParts[]
  turn: Turn
  model: Provider.Model
  budget: number
  estimate: (input: { messages: SessionV1.WithParts[]; model: Provider.Model }) => Effect.Effect<number>
}) {
  return Effect.gen(function* () {
    if (input.budget <= 0) return undefined
    if (input.turn.end - input.turn.start <= 1) return undefined
    for (let start = input.turn.start + 1; start < input.turn.end; start++) {
      const size = yield* input.estimate({
        messages: input.messages.slice(start, input.turn.end),
        model: input.model,
      })
      if (size > input.budget) continue
      return {
        start,
        id: input.messages[start]!.info.id,
      } satisfies Tail
    }
    return undefined
  })
}

// AC-1.2/1.4: a short, deterministic, $0 stand-in for a completed tool result —
// keeps the tool name, status and a size/first-line hint so the model still knows
// roughly what happened without paying for the raw output tokens again. AC-6.2:
// names the `compaction_refetch` tool alongside the pointer so the model knows
// it can surgically pull the retained raw body back on demand.
function observationSynthesis(part: SessionV1.ToolPart, sessionID: SessionID, messageID: MessageID) {
  if (part.state.status !== "completed") return `${part.tool} (${part.state.status})`
  const output = part.state.output
  const lines = output.split("\n").length
  const input = part.state.input
  const hint = [input?.filePath, input?.path, input?.pattern, input?.command].find((v) => typeof v === "string") as
    | string
    | undefined
  const label = hint ? `${part.tool} ${hint}` : part.tool
  const size = lines > 1 ? `${lines} lines` : `${output.length} chars`
  return `${label} (${size}) [pointer: ${sessionID}/${messageID}/${part.id} — re-fetch via compaction_refetch]`
}

// AC-6.1 — PROTECTED region: content compaction must never prune, mask,
// stale-drop, or summarize, and must always land in the re-injected
// (post-compaction) payload verbatim. "Protected" (part-level) = an
// explicitly PINNED tool part, the active plan (the latest `todowrite` call),
// a `task` sub-agent digest (already the compressed form of a child
// session's work — masking it again defeats its purpose), or a path
// matching `cfg.protected.paths`. `cfg.protected.keep_all_user_messages`
// (default true) is satisfied structurally, not via this helper: none of
// prune/maskObservations/pruneStaleReads ever touch a `text` part, only
// completed `tool` parts, so raw user message text is already never pruned,
// masked, or dropped — and compaction is non-destructive (raw stays in the
// DB), so it always survives verbatim regardless of what the summarizer does
// with it.
function isPinnedPart(part: SessionV1.Part): boolean {
  return part.type === "tool" && part.state.status !== "pending" && part.state.metadata?.pinned === true
}

function protectedPathMatch(filePath: unknown, patterns: readonly string[] | undefined): boolean {
  if (!patterns?.length || typeof filePath !== "string" || !filePath) return false
  return patterns.some((pattern) => Glob.match(pattern, filePath))
}

function isProtectedToolPart(part: SessionV1.ToolPart, cfg: ConfigV1.Info, planPartId: PartID | undefined): boolean {
  if (isPinnedPart(part)) return true
  if (cfg.protected?.plan !== false && part.tool === "todowrite" && part.id === planPartId) return true
  // A `task` digest is already the compressed form of a child session's work —
  // masking it again defeats its purpose, so it is never pruned/masked/stale-dropped.
  if (part.tool === "task") return true
  if (part.state.status === "pending") return false
  return protectedPathMatch(part.state.input?.filePath ?? part.state.input?.path, cfg.protected?.paths)
}

// The active plan is the LAST todowrite write, not every historical revision.
function latestPlanPartId(messages: SessionV1.WithParts[]): PartID | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i]!.parts
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j]!
      if (part.type === "tool" && part.tool === "todowrite") return part.id
    }
  }
  return undefined
}

// Earliest message index carrying protected part-level content — the floor
// `select()` uses to keep protected content out of `head` (never summarized).
function earliestProtectedIndex(
  messages: SessionV1.WithParts[],
  cfg: ConfigV1.Info,
  planPartId: PartID | undefined,
): number | undefined {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.parts.some((part) => part.type === "tool" && isProtectedToolPart(part, cfg, planPartId))) {
      return i
    }
  }
  return undefined
}

function fmtTokens(n: number): string {
  const rounded = Math.max(0, Math.round(n))
  return rounded >= 1000 ? `${Math.round(rounded / 1000)}k` : String(rounded)
}

function fmtCost(n: number): string {
  return `$${Math.max(0, n).toFixed(4)}`
}

// AC-5.1 — compaction receipt: one line summarizing what a compaction pass
// reclaimed, routed through econ's existing per-turn usage sink
// (`packages/core/src/session/runner/publish-llm-event.ts`'s `__econUsageSink`
// process-level global — reused here directly, matching that file's own
// dependency-free pattern, rather than adding a new telemetry transport). A
// RawUsage-typed sink ignores the extra `compaction` field, so this stays
// compatible with the existing sink while a compaction-aware sink (or a test
// stub) gets the full before/after/reclaimed picture. Also logged via the
// existing Effect logging channel compaction already uses.
const emitCompactionReceipt = Effect.fn("SessionCompaction.receipt")(function* (input: {
  sessionID: SessionID
  turnId: string
  model: string
  beforeTokens: number
  afterTokens: number
  reclaimedByPrune: number
  reclaimedBySummary: number
  summaryCost: number
}) {
  const deltaPct =
    input.beforeTokens > 0 ? Math.round(((input.afterTokens - input.beforeTokens) / input.beforeTokens) * 100) : 0
  const text = `compacted ${fmtTokens(input.beforeTokens)} → ${fmtTokens(input.afterTokens)} (${deltaPct <= 0 ? "−" : "+"}${Math.abs(deltaPct)}%) · prune ${fmtCost(0)} + summary ${fmtCost(input.summaryCost)} · ${input.model}`
  yield* Effect.logInfo("compaction receipt", {
    text,
    sessionID: input.sessionID,
    beforeTokens: input.beforeTokens,
    afterTokens: input.afterTokens,
    reclaimedByPrune: input.reclaimedByPrune,
    reclaimedBySummary: input.reclaimedBySummary,
    summaryCost: input.summaryCost,
    model: input.model,
  })
  ;(globalThis as { __econUsageSink?: (raw: Record<string, unknown>) => void }).__econUsageSink?.({
    sessionID: input.sessionID,
    turnId: input.turnId,
    model: input.model,
    cost: input.summaryCost,
    tokens: { input: input.beforeTokens, output: input.afterTokens, reasoning: 0, cache: { read: 0, write: 0 } },
    compaction: {
      beforeTokens: input.beforeTokens,
      afterTokens: input.afterTokens,
      reclaimedByPrune: input.reclaimedByPrune,
      reclaimedBySummary: input.reclaimedBySummary,
      summaryCost: input.summaryCost,
      deltaPct,
      text,
    },
  })
})

// AC-4.4 — pre-compaction diff: emitted right before Tier-2's LLM summarize
// call replaces `selected.head`, so a UI can show what is about to DROP (and
// let the user pin something first) before an auto compaction commits.
// Reuses the exact dependency-free process-global sink pattern
// emitCompactionReceipt already established (no new transport) — a UI
// subscribes to `globalThis.__econCompactionDiffSink` the same way a savings
// receipt sink subscribes to `__econUsageSink`. Fires unconditionally and
// never blocks: auto-compaction always proceeds regardless of whether
// anything observes the event.
const emitCompactionDiff = Effect.fn("SessionCompaction.diff")(function* (input: {
  sessionID: SessionID
  turnId: string
  drop: { messageID: MessageID; partIDs: PartID[] }[]
  keep: { messageID: MessageID; partIDs: PartID[] }[]
  dropTokens: number
  keepTokens: number
}) {
  yield* Effect.logInfo("compaction pre-diff", {
    sessionID: input.sessionID,
    turnId: input.turnId,
    dropCount: input.drop.length,
    keepCount: input.keep.length,
    dropTokens: input.dropTokens,
    keepTokens: input.keepTokens,
  })
  ;(
    globalThis as { __econCompactionDiffSink?: (diff: Record<string, unknown>) => void }
  ).__econCompactionDiffSink?.({
    sessionID: input.sessionID,
    turnId: input.turnId,
    drop: input.drop,
    keep: input.keep,
    dropTokens: input.dropTokens,
    keepTokens: input.keepTokens,
  })
})

export interface Interface {
  readonly isOverflow: (input: {
    tokens: SessionV1.Assistant["tokens"]
    model: Provider.Model
  }) => Effect.Effect<boolean>
  readonly prune: (input: { sessionID: SessionID }) => Effect.Effect<void>
  readonly maskObservations: (input: { sessionID: SessionID }) => Effect.Effect<void>
  readonly pruneStaleReads: (input: { sessionID: SessionID }) => Effect.Effect<void>
  // AC-6.1: server-side pin toggle — the data mechanism a future TUI `/pin`
  // command calls, and that the agent uses to self-pin its own plan.
  readonly setPinned: (input: {
    sessionID: SessionID
    messageID: MessageID
    partID: PartID
    pinned: boolean
  }) => Effect.Effect<SessionV1.ToolPart | undefined>
  readonly process: (input: {
    parentID: MessageID
    messages: SessionV1.WithParts[]
    sessionID: SessionID
    auto: boolean
    overflow?: boolean
    // AC-4.5: optional `/compact [focus]` free text, appended to the summary prompt.
    focus?: string
  }) => Effect.Effect<"continue" | "stop">
  readonly compact: (input: {
    parentID: MessageID
    messages: SessionV1.WithParts[]
    sessionID: SessionID
    auto: boolean
    overflow?: boolean
    // AC-4.5: optional `/compact [focus]` free text, appended to the summary prompt.
    focus?: string
  }) => Effect.Effect<"continue" | "stop">
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    auto: boolean
    overflow?: boolean
    // AC-4.5: optional `/compact [focus]` free text, persisted on the task
    // marker (like `tail_start_id`) so process()/compact() can read it later.
    focus?: string
  }) => Effect.Effect<void>
  // AC-6.3: reload the execution-frontier checkpoint compact() persists —
  // undefined when nothing has been checkpointed yet for this session.
  readonly rehydrateExecutionFrontier: (input: {
    sessionID: SessionID
  }) => Effect.Effect<ExecutionFrontier.ExecutionFrontierSnapshot | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const plugin = yield* Plugin.Service
    const processors = yield* SessionProcessor.Service
    const provider = yield* Provider.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    // AC-6.3: the existing S1.3 canonical-state store — composed with rather
    // than a new storage transport (see execution-frontier.ts).
    const canonicalState = yield* SessionCanonicalState.Service

    // AC-1.6: serialize — at most one compaction runs per session at a time.
    const running = new Set<SessionID>()

    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: SessionV1.Assistant["tokens"]
      model: Provider.Model
    }) {
      return overflow({
        cfg: yield* config.get(),
        tokens: input.tokens,
        model: input.model,
        outputTokenMax: flags.outputTokenMax,
      })
    })

    const estimate = Effect.fn("SessionCompaction.estimate")(function* (input: {
      messages: SessionV1.WithParts[]
      model: Provider.Model
    }) {
      const msgs = yield* MessageV2.toModelMessagesEffect(input.messages, input.model)
      return Token.estimate(JSON.stringify(msgs))
    })

    const select = Effect.fn("SessionCompaction.select")(function* (input: {
      messages: SessionV1.WithParts[]
      cfg: ConfigV1.Info
      model: Provider.Model
    }) {
      // AC-6.1: protected content (pinned parts, the active plan, cfg.protected.paths)
      // must never land in `head` — compute the earliest protected message index
      // once and use it as a floor on the tail boundary below, no matter which
      // branch decides that boundary.
      const planId = latestPlanPartId(input.messages)
      const guardIndex = earliestProtectedIndex(input.messages, input.cfg, planId)

      const finalize = (naturalStart: number | undefined, naturalId: MessageID | undefined) =>
        Effect.gen(function* () {
          let start = naturalStart
          let tailId = naturalId
          if (guardIndex !== undefined && (start === undefined || guardIndex < start)) {
            // AC-6.1 guardrail: warn (never hard-fail) when protecting this
            // content pulls in more than a sane share of the usable budget.
            const extra = input.messages.slice(guardIndex, start ?? input.messages.length)
            const extraTokens = yield* estimate({ messages: extra, model: input.model })
            const budget = usable({ cfg: input.cfg, model: input.model, outputTokenMax: flags.outputTokenMax })
            if (budget > 0 && extraTokens > budget * PROTECTED_TOKEN_WARN_FRACTION) {
              yield* Effect.logWarning("compaction: protected content is crowding out live context", {
                extraTokens,
                budget,
              })
            }
            start = guardIndex
            tailId = input.messages[guardIndex]!.info.id
          }
          if (start === undefined) return { head: input.messages, tail_start_id: undefined }
          return { head: input.messages.slice(0, start), tail_start_id: tailId }
        })

      const limit = input.cfg.compaction?.tail_turns ?? DEFAULT_TAIL_TURNS
      if (limit <= 0) return yield* finalize(undefined, undefined)
      const budget = preserveRecentBudget({ cfg: input.cfg, model: input.model })
      const all = turns(input.messages)
      if (!all.length) return yield* finalize(undefined, undefined)
      const recent = all.slice(-limit)
      const sizes = yield* Effect.forEach(
        recent,
        (turn) =>
          estimate({
            messages: input.messages.slice(turn.start, turn.end),
            model: input.model,
          }),
        { concurrency: 1 },
      )

      let total = 0
      let keep: Tail | undefined
      for (let i = recent.length - 1; i >= 0; i--) {
        const turn = recent[i]!
        const size = sizes[i]
        if (total + size <= budget) {
          total += size
          keep = { start: turn.start, id: turn.id }
          continue
        }
        const remaining = budget - total
        const split = yield* splitTurn({
          messages: input.messages,
          turn,
          model: input.model,
          budget: remaining,
          estimate,
        })
        if (split) keep = split
        else if (!keep) {
          yield* Effect.logInfo("tail fallback", { budget, size, total })
        }
        break
      }

      return yield* finalize(keep && keep.start !== 0 ? keep.start : undefined, keep?.id)
    })

    // goes backwards through parts until there are PRUNE_PROTECT tokens worth of tool
    // calls, then erases output of older tool calls to free context space
    const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
      const cfg = yield* config.get()
      // AC-1.1: prune now defaults ON (only an explicit `false` disables it).
      if (cfg.compaction?.prune === false) return
      yield* Effect.logInfo("pruning")

      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return

      let total = 0
      let pruned = 0
      const toPrune: SessionV1.ToolPart[] = []
      // L2.1 — step-recency protection: count assistant messages (steps)
      // while walking backwards and protect every part in the most recent
      // PRUNE_PROTECT_STEPS of them. The old user-turn gate (`turns < 2`)
      // was dead in single-user-turn run sessions (one user message ⇒ the
      // gate never opened ⇒ 0 parts ever pruned).
      let steps = 0
      // AC-6.1: pinned/plan/protected-path parts must never be pruned.
      const planId = latestPlanPartId(msgs)

      loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
        const msg = msgs[msgIndex]
        if (msg.info.role === "assistant") steps++
        if (steps <= PRUNE_PROTECT_STEPS) continue
        if (msg.info.role === "assistant" && msg.info.summary) break loop
        for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
          const part = msg.parts[partIndex]
          if (part.type !== "tool") continue
          if (part.state.status !== "completed") continue
          if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
          if (isProtectedToolPart(part, cfg, planId)) continue
          if (part.state.time.compacted) break loop
          const estimate = Token.estimate(part.state.output)
          total += estimate
          if (total <= PRUNE_PROTECT) continue
          pruned += estimate
          toPrune.push(part)
        }
      }

      yield* Effect.logInfo("found", { pruned, total })
      if (pruned > PRUNE_MINIMUM) {
        for (const part of toPrune) {
          if (part.state.status === "completed") {
            part.state.time.compacted = Date.now()
            yield* session.updatePart(part)
          }
        }
        yield* Effect.logInfo("pruned", { count: toPrune.length })
      }
    })

    // AC-1.3: unerr-graph-aware pruning — econ's semantic-staleness moat that
    // age/token-budget pruners (prune()) lack. Walks completed tool parts once, in
    // chronological order, and tags a `read` tool's cached body `time.compacted`
    // (identical to prune()'s non-destructive tag — raw output stays in the DB row,
    // never modified) when a *later* tool part in the session touches the same
    // file: either an edit/write (the cached read is now stale) or another read of
    // the same path (DEDUPE — only the latest raw read survives). The "graph" here
    // is the within-session tool-part timeline — a $0, deterministic stand-in for a
    // live file-mtime probe. Reuses prune()'s `compaction.prune` gate; no new
    // config key.
    const pruneStaleReads = Effect.fn("SessionCompaction.pruneStaleReads")(function* (input: {
      sessionID: SessionID
    }) {
      const cfg = yield* config.get()
      if (cfg.compaction?.prune === false) return

      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return

      // AC-6.1: pinned/plan/protected-path reads must never be stale-dropped.
      const planId = latestPlanPartId(msgs)

      // Chronological (oldest→newest) flat list of completed read/write-family tool
      // parts, each tagged with the file path it touched.
      const touches: { part: SessionV1.ToolPart; path: string; isRead: boolean }[] = []
      for (const msg of msgs) {
        for (const part of msg.parts) {
          if (part.type !== "tool") continue
          if (part.state.status !== "completed") continue
          if (part.state.time.compacted) continue
          const isRead = READ_TOOLS.includes(part.tool)
          const isWrite = WRITE_TOOLS.includes(part.tool)
          if (!isRead && !isWrite) continue
          const filePath = part.state.input?.filePath
          if (typeof filePath !== "string" || !filePath) continue
          touches.push({ part, path: filePath, isRead })
        }
      }

      let pruned = 0
      for (let i = 0; i < touches.length; i++) {
        const touch = touches[i]!
        if (!touch.isRead) continue
        if (isProtectedToolPart(touch.part, cfg, planId)) continue
        // Stale (superseded by a later edit/write of the same path) and duplicate
        // (superseded by a later read of the same path) collapse to the same test:
        // is there ANY later touch of this path at all.
        const superseded = touches.slice(i + 1).some((later) => later.path === touch.path)
        if (!superseded) continue
        if (touch.part.state.status !== "completed") continue
        touch.part.state.time.compacted = Date.now()
        yield* session.updatePart(touch.part)
        pruned++
      }
      if (pruned) yield* Effect.logInfo("pruned stale/duplicate reads", { count: pruned })
    })

    // AC-1.2/1.4: replaces the body of CONSUMED completed tool results (there is a
    // later step after them) with a one-line synthesis, keeping only the most
    // recent `keep_raw_tool_results` raw. Deterministic, $0, no LLM call — distinct
    // from prune() (which blanks by token-tail budget): masking is closer to the
    // tail and purely count-based. The raw output is preserved in the part's
    // metadata (never sent to the model) rather than destroyed.
    const maskObservations = Effect.fn("SessionCompaction.maskObservations")(function* (input: {
      sessionID: SessionID
    }) {
      const cfg = yield* config.get()
      if (cfg.compaction?.observation_masking === false) return
      const keepRaw = cfg.compaction?.keep_raw_tool_results ?? DEFAULT_KEEP_RAW_TOOL_RESULTS

      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return

      // AC-6.1: pinned/plan/protected-path parts must never be masked.
      const planId = latestPlanPartId(msgs)

      // L2.2 collect-then-apply: gather the would-be-masked parts first so the
      // reclaim floor can be checked against the whole batch before any write.
      let seen = 0
      const toMask: { part: SessionV1.ToolPart; messageID: MessageID }[] = []
      let reclaimable = 0
      loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
        const msg = msgs[msgIndex]
        if (msg.info.role === "assistant" && msg.info.summary) break loop
        for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
          const part = msg.parts[partIndex]
          if (part.type !== "tool") continue
          if (part.state.status !== "completed") continue
          if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
          if (isProtectedToolPart(part, cfg, planId)) continue
          if (part.state.time.compacted) continue
          if (part.state.metadata?.masked) continue
          seen++
          if (seen <= keepRaw) continue
          reclaimable += Token.estimate(part.state.output)
          toMask.push({ part, messageID: msg.info.id })
        }
      }

      // L2.2 — eviction-amortization floor (MASK_MINIMUM, same rationale as
      // PRUNE_MINIMUM): masking evicts the cached prefix, and with implicit
      // caching's $0 writes the eviction cost is one re-ingest of the suffix
      // at ~5× the cached-read price — so evict in chunks, never dribbles.
      if (reclaimable < MASK_MINIMUM) return

      let masked = 0
      for (const { part, messageID } of toMask) {
        if (part.state.status !== "completed") continue
        const raw = part.state.output
        const synthesis = observationSynthesis(part, input.sessionID, messageID)
        masked++
        yield* session.updatePart({
          ...part,
          state: {
            ...part.state,
            output: synthesis,
            metadata: {
              ...part.state.metadata,
              masked: {
                at: Date.now(),
                rawChars: raw.length,
                pointer: { sessionID: input.sessionID, messageID, partID: part.id },
                raw,
              },
            },
          },
        })
      }
      if (masked) yield* Effect.logInfo("masked observations", { count: masked, keepRaw, reclaimable })
    })

    // AC-1.7 routing: the compaction summarizer always resolves to the cheap tier —
    // an explicit `compaction.model` override, else the project's `small_model`,
    // else the existing default (the compaction agent's own model, or the
    // triggering user message's model) — never the oracle/primary model.
    const resolveSummaryModel = Effect.fn("SessionCompaction.resolveSummaryModel")(function* (input: {
      agentModel: { providerID: ProviderV2.ID; modelID: ModelV2.ID } | undefined
      userMessage: SessionV1.User
      cfg: ConfigV1.Info
    }) {
      const fallback = input.agentModel
        ? provider.getModel(input.agentModel.providerID, input.agentModel.modelID).pipe(Effect.orDie)
        : provider.getModel(input.userMessage.model.providerID, input.userMessage.model.modelID).pipe(Effect.orDie)

      const override = input.cfg.compaction?.model ?? input.cfg.small_model
      if (!override) return yield* fallback

      const parsed = Provider.parseModel(override)
      const resolved = yield* provider
        .getModel(parsed.providerID, parsed.modelID)
        .pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (resolved) return resolved
      yield* Effect.logWarning("compaction summarizer model override not found, falling back", { override })
      return yield* fallback
    })

    const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
      parentID: MessageID
      messages: SessionV1.WithParts[]
      sessionID: SessionID
      auto: boolean
      overflow?: boolean
      // AC-5.1: pre-summarize baseline from compact()'s prune-first ladder, so
      // the receipt can attribute reclaimed tokens to prune vs. summarize.
      receiptBase?: { beforeTokens: number; postPruneTokens: number }
      // AC-4.5: optional `/compact [focus]` free text, appended to the summary prompt.
      focus?: string
    }) {
      const parent = input.messages.findLast((m) => m.info.id === input.parentID)
      if (!parent || parent.info.role !== "user") {
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      }
      const userMessage = parent.info
      const compactionPart = parent.parts.find((part): part is SessionV1.CompactionPart => part.type === "compaction")

      let messages = input.messages
      let replay:
        | {
            info: SessionV1.User
            parts: SessionV1.Part[]
          }
        | undefined
      if (input.overflow) {
        const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
        for (let i = idx - 1; i >= 0; i--) {
          const msg = input.messages[i]
          if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
            replay = { info: msg.info, parts: msg.parts }
            messages = input.messages.slice(0, i)
            break
          }
        }
        const hasContent =
          replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
        if (!hasContent) {
          replay = undefined
          messages = input.messages
        }
      }

      const agent = yield* agents.get("compaction")
      const cfg = yield* config.get()
      const model = yield* resolveSummaryModel({ agentModel: agent.model, userMessage, cfg })
      const history = compactionPart && messages.at(-1)?.info.id === input.parentID ? messages.slice(0, -1) : messages
      const prior = completedCompactions(history)
      const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]))
      const previousSummary = prior.at(-1)?.summary
      const filtered = history.filter((_, index) => !hidden.has(index))
      const selected = yield* select({
        messages: filtered,
        cfg,
        model,
      })

      // AC-4.4: pre-compaction diff — before Tier-2's LLM call replaces
      // `selected.head` with a summary, compute + emit what will DROP (the
      // head, about to be overwritten) vs what will be KEPT (protected
      // content, the tail turns, and any prior summary) so a UI can show it
      // and the user can pin something first. Non-blocking: the auto path
      // always proceeds regardless of whether anything observes this.
      const kept = filtered.slice(selected.head.length)
      const dropTokens = yield* estimate({ messages: selected.head, model })
      const keepTokens = yield* estimate({ messages: kept, model })
      yield* emitCompactionDiff({
        sessionID: input.sessionID,
        turnId: input.parentID,
        drop: diffEntries(selected.head),
        keep: diffEntries(kept),
        dropTokens,
        keepTokens,
      })

      // Allow plugins to inject context or replace compaction prompt.
      const compacting = yield* plugin.trigger(
        "experimental.session.compacting",
        { sessionID: input.sessionID },
        { context: [], prompt: undefined },
      )
      // AC-4.5: an optional free-text `/compact [focus]` argument — read from
      // the explicit `input.focus` if the caller passed one directly, else
      // from the task marker's own `focus` (how the real runner delivers it:
      // create() persists it on the CompactionPart, the same way it already
      // persists `tail_start_id`). Appended as one more `context` entry
      // (buildPrompt already accepts an array there), so this needs no
      // signature change in core's buildPrompt.
      const focus = input.focus ?? compactionPart?.focus
      const promptContext = focus ? [...compacting.context, `emphasize: ${focus}`] : compacting.context
      const nextPrompt = compacting.prompt ?? buildPrompt({ previousSummary, context: promptContext })
      const msgs = structuredClone(selected.head)
      yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
      const modelMessages = yield* MessageV2.toModelMessagesEffect(msgs, model, {
        stripMedia: true,
        toolOutputMaxChars: TOOL_OUTPUT_MAX_CHARS,
      })
      const tailIndex = selected.tail_start_id
        ? history.findIndex((message) => message.info.id === selected.tail_start_id)
        : -1
      const recent =
        tailIndex < 0
          ? ""
          : JSON.stringify(
              yield* MessageV2.toModelMessagesEffect(history.slice(tailIndex), model, {
                stripMedia: true,
                toolOutputMaxChars: TOOL_OUTPUT_MAX_CHARS,
              }),
            )
      const ctx = yield* InstanceState.context
      const msg: SessionV1.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: input.parentID,
        sessionID: input.sessionID,
        mode: "compaction",
        agent: "compaction",
        variant: userMessage.model.variant,
        summary: true,
        path: {
          cwd: ctx.directory,
          root: ctx.worktree,
        },
        cost: 0,
        tokens: {
          output: 0,
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: model.id,
        providerID: model.providerID,
        time: {
          created: Date.now(),
        },
      }
      yield* session.updateMessage(msg)
      const processor = yield* processors.create({
        assistantMessage: msg,
        sessionID: input.sessionID,
        model,
      })
      const result = yield* processor.process({
        user: userMessage,
        agent,
        sessionID: input.sessionID,
        tools: {},
        system: [],
        messages: [
          ...modelMessages,
          {
            role: "user",
            content: [{ type: "text", text: nextPrompt }],
          },
        ],
        model,
      })

      if (result === "compact") {
        processor.message.error = new SessionV1.ContextOverflowError({
          message: replay
            ? "Conversation history too large to compact - exceeds model context limit"
            : "Session too large to compact - context exceeds model limit even after stripping media",
        }).toObject()
        processor.message.finish = "error"
        yield* session.updateMessage(processor.message)
        return "stop"
      }

      // AC-1.7(a) anti-loop: abort (don't retry this turn) if the produced summary
      // didn't free at least `min_reduction` tokens off the head it replaces. Only
      // evaluated when the head was itself large enough to plausibly matter — a
      // trivial head can never have caused a real overflow, so there is nothing to
      // protect against there.
      let summary: string | undefined
      if (result === "continue") {
        summary = summaryText(
          (yield* session.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)).find(
            (item) => item.info.id === msg.id,
          ) ?? { info: msg, parts: [] },
        )
        const minReduction = cfg.compaction?.min_reduction ?? DEFAULT_MIN_REDUCTION
        const headTokens = yield* estimate({ messages: selected.head, model })
        const summaryTokens = summary ? Token.estimate(summary) : 0
        if (headTokens >= minReduction && headTokens - summaryTokens < minReduction) {
          yield* Effect.logWarning("compaction min-reduction abort", {
            sessionID: input.sessionID,
            headTokens,
            summaryTokens,
            minReduction,
          })
          processor.message.error = new SessionV1.ContextOverflowError({
            message: "Context full — the compaction summary didn't shrink the conversation enough to continue.",
          }).toObject()
          processor.message.finish = "error"
          yield* session.updateMessage(processor.message)
          yield* events.publish(Session.Event.Error, { sessionID: input.sessionID, error: processor.message.error })
          return "stop"
        }

        // AC-5.1: Tier-2 summarize exit — combine what the cheap tiers already
        // reclaimed (receiptBase, present when reached via compact()'s
        // prune-first ladder) with what this LLM summarize step reclaimed.
        if (input.receiptBase) {
          const reclaimedBySummary = headTokens - summaryTokens
          yield* emitCompactionReceipt({
            sessionID: input.sessionID,
            turnId: msg.id,
            model: model.id,
            beforeTokens: input.receiptBase.beforeTokens,
            afterTokens: input.receiptBase.postPruneTokens - reclaimedBySummary,
            reclaimedByPrune: input.receiptBase.beforeTokens - input.receiptBase.postPruneTokens,
            reclaimedBySummary,
            summaryCost: msg.cost,
          })
        }
      }

      if (compactionPart && selected.tail_start_id && compactionPart.tail_start_id !== selected.tail_start_id) {
        yield* session.updatePart({
          ...compactionPart,
          tail_start_id: selected.tail_start_id,
        })
      }

      if (result === "continue" && input.auto) {
        if (replay) {
          const original = replay.info
          const replayMsg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: input.sessionID,
            time: { created: Date.now() },
            agent: original.agent,
            model: original.model,
            format: original.format,
            tools: original.tools,
            system: original.system,
          })
          for (const part of replay.parts) {
            if (part.type === "compaction") continue
            const replayPart =
              part.type === "file" && MessageV2.isMedia(part.mime)
                ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
                : part
            yield* session.updatePart({
              ...replayPart,
              id: PartID.ascending(),
              messageID: replayMsg.id,
              sessionID: input.sessionID,
            })
          }
        }

        if (!replay) {
          const info = yield* provider.getProvider(userMessage.model.providerID)
          if (
            (yield* plugin.trigger(
              "experimental.compaction.autocontinue",
              {
                sessionID: input.sessionID,
                agent: userMessage.agent,
                model: yield* provider
                  .getModel(userMessage.model.providerID, userMessage.model.modelID)
                  .pipe(Effect.orDie),
                provider: {
                  source: info.source,
                  info,
                  options: info.options,
                },
                message: userMessage,
                overflow: input.overflow === true,
              },
              { enabled: true },
            )).enabled
          ) {
            const continueMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: userMessage.agent,
              model: userMessage.model,
            })
            const text =
              (input.overflow
                ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
                : "") +
              "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: continueMsg.id,
              sessionID: input.sessionID,
              type: "text",
              // Internal marker for auto-compaction followups so provider plugins
              // can distinguish them from manual post-compaction user prompts.
              // This is not a stable plugin contract and may change or disappear.
              metadata: { compaction_continue: true },
              synthetic: true,
              text,
              time: {
                start: Date.now(),
                end: Date.now(),
              },
            })
          }
        }
      }

      if (processor.message.error) return "stop"
      if (result === "continue") {
        if (flags.experimentalEventSystem) {
          if (summary)
            yield* events.publish(SessionEvent.Compaction.Ended, {
              sessionID: input.sessionID,
              messageID: SessionMessage.ID.make(input.parentID),
              timestamp: DateTime.makeUnsafe(Date.now()),
              reason: input.auto ? "auto" : "manual",
              text: summary ?? "",
              recent,
            })
        }
        yield* events.publish(Event.Compacted, { sessionID: input.sessionID })
      }
      return result
    })

    // AC-1.1 Tier-1-resolved-it finalize: closes out a pending compaction task
    // without an LLM call by writing a terminal (finished, non-summary) assistant
    // message. `latest()` treats any finished assistant after the compaction
    // marker as "task done", so the runLoop resumes the original conversation on
    // its next iteration — no synthetic replay/continue prompt is needed since
    // history was never rewritten, only tagged/masked.

    // AC-6.1: server-side pin toggle — the data mechanism a future TUI `/pin`
    // command calls, and that the agent uses to self-pin its own plan. Stores
    // the flag on the tool part's `state.metadata.pinned` (already a free-form
    // bag on every non-pending ToolState) so no schema change is needed.
    const setPinned = Effect.fn("SessionCompaction.setPinned")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
      partID: PartID
      pinned: boolean
    }) {
      const part = yield* session.getPart({
        sessionID: input.sessionID,
        messageID: input.messageID,
        partID: input.partID,
      })
      if (!part || part.type !== "tool" || part.state.status === "pending") return undefined
      return yield* session.updatePart({
        ...part,
        state: { ...part.state, metadata: { ...part.state.metadata, pinned: input.pinned } },
      })
    })

    // AC-6.3 — execution-frontier checkpoint: a small typed record of where
    // work stands (files touched, open TODOs, last error, decisions), fired
    // at every compact() exit that actually closed the task (cheap-tier
    // resolved or LLM-summarized) so a resumed session can rehydrate it
    // instead of re-reading files or repeating rejected approaches. Not fired
    // on doom-loop/min-gap/min-turns skips, where nothing changed. `decisions`
    // reuses the compaction summary text already produced by this pass rather
    // than re-deriving it.
    const checkpointExecutionFrontier = Effect.fn("SessionCompaction.checkpointExecutionFrontier")(function* (input: {
      sessionID: SessionID
    }) {
      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return
      const decisions = completedCompactions(msgs).at(-1)?.summary
      const snapshot = ExecutionFrontier.buildExecutionFrontier({ messages: msgs, decisions })
      yield* ExecutionFrontier.persistExecutionFrontier({ sessionID: input.sessionID, snapshot, canonicalState })
    })

    const rehydrateExecutionFrontier = Effect.fn("SessionCompaction.rehydrateExecutionFrontier")(function* (input: {
      sessionID: SessionID
    }) {
      return yield* ExecutionFrontier.rehydrateExecutionFrontier({ sessionID: input.sessionID, canonicalState })
    })

    const skipSummary = Effect.fn("SessionCompaction.skipSummary")(function* (input: {
      parentID: MessageID
      sessionID: SessionID
      userMessage: SessionV1.User
    }) {
      const ctx = yield* InstanceState.context
      yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: input.parentID,
        sessionID: input.sessionID,
        mode: "compaction",
        agent: "compaction",
        variant: input.userMessage.model.variant,
        path: { cwd: ctx.directory, root: ctx.worktree },
        cost: 0,
        tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: input.userMessage.model.modelID,
        providerID: input.userMessage.model.providerID,
        time: { created: Date.now(), completed: Date.now() },
        finish: "stop",
      })
      yield* events.publish(Event.Compacted, { sessionID: input.sessionID })
    })

    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      auto: boolean
      overflow?: boolean
      // AC-4.5: optional `/compact [focus]` free text, persisted on the task
      // marker (like `tail_start_id`) so process()/compact() can read it later.
      focus?: string
    }) {
      // AC-1.7(c) hard doom counter: if the last COMPACTION_DOOM_LOOP_THRESHOLD
      // auto triggers are all bunched within one min-gap-sized window, compaction
      // is not making progress — surface a hard error instead of looping forever.
      if (input.auto) {
        const cfg = yield* config.get()
        const minGap = cfg.compaction?.min_gap_messages ?? DEFAULT_MIN_GAP_MESSAGES
        const msgs = yield* session
          .messages({ sessionID: input.sessionID })
          .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
        if (msgs) {
          const window = msgs.slice(-Math.max(minGap, 1) * COMPACTION_DOOM_LOOP_THRESHOLD)
          const triggers = window.filter(
            (m) => m.info.role === "user" && m.parts.some((p) => p.type === "compaction" && p.auto),
          ).length
          if (triggers >= COMPACTION_DOOM_LOOP_THRESHOLD) {
            yield* Effect.logWarning("compaction doom loop detected — aborting", {
              sessionID: input.sessionID,
              triggers,
            })
            yield* events.publish(Session.Event.Error, {
              sessionID: input.sessionID,
              error: new SessionV1.ContextOverflowError({
                message:
                  "Context keeps overflowing after repeated compaction attempts. Start a new session or reduce context manually.",
              }).toObject(),
            })
            return
          }
        }
      }

      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
        focus: input.focus,
      })
      if (flags.experimentalEventSystem) {
        yield* events.publish(SessionEvent.Compaction.Started, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.make(msg.id),
          timestamp: DateTime.makeUnsafe(Date.now()),
          reason: input.auto ? "auto" : "manual",
        })
      }
    })

    // AC-1.1: the prune-first ladder. Tier 0 (media-driven overflow) reuses the
    // existing stripMedia + replay path inside processCompaction unchanged — no
    // cheap tier applies to a single oversized attachment. Otherwise: Tier 1 runs
    // the $0 deterministic passes (mask, then prune) and re-checks isOverflow; if
    // that alone resolved it, the task is finalized WITHOUT an LLM call. Only then
    // does Tier 2 (processCompaction) summarize.
    const compact = Effect.fn("SessionCompaction.compact")(function* (input: {
      parentID: MessageID
      messages: SessionV1.WithParts[]
      sessionID: SessionID
      auto: boolean
      overflow?: boolean
      // AC-4.5: optional `/compact [focus]` free text, forwarded to processCompaction.
      focus?: string
    }) {
      const cfg = yield* config.get()

      // AC-1.6: serialize — skip if this session is already mid-compaction.
      if (running.has(input.sessionID)) {
        yield* Effect.logInfo("compaction already in flight, skipping", { sessionID: input.sessionID })
        return "continue" as const
      }

      const parent = input.messages.findLast((m) => m.info.id === input.parentID)
      if (!parent || parent.info.role !== "user") {
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      }
      const userMessage = parent.info

      // AC-1.6: min-gap guard — refuse rapid re-fire on auto triggers.
      if (input.auto) {
        const minGap = cfg.compaction?.min_gap_messages ?? DEFAULT_MIN_GAP_MESSAGES
        const last = completedCompactions(input.messages).at(-1)
        if (last !== undefined && input.messages.length - 1 - last.assistantIndex < minGap) {
          yield* Effect.logInfo("compaction min-gap guard: skipping", { sessionID: input.sessionID })
          return "continue" as const
        }
      }

      // Tier 0: media-driven overflow — handled entirely by the existing
      // stripMedia + replay path below; the cheap tiers don't apply.
      if (input.overflow) return yield* processCompaction(input)

      running.add(input.sessionID)
      return yield* Effect.gen(function* () {
        const model = yield* provider
          .getModel(userMessage.model.providerID, userMessage.model.modelID)
          .pipe(Effect.orDie)
        // AC-5.1: baseline size before any cheap-tier pass touches the session,
        // so the receipt can attribute what prune/mask/pruneStaleReads reclaimed
        // vs. what the LLM summarize step reclaimed on top.
        const hiddenBefore = new Set(
          completedCompactions(input.messages).flatMap((item) => [item.userIndex, item.assistantIndex]),
        )
        const beforeTokens = yield* estimate({
          messages: input.messages.filter((_, index) => !hiddenBefore.has(index)),
          model,
        })

        yield* maskObservations({ sessionID: input.sessionID })
        yield* prune({ sessionID: input.sessionID })
        yield* pruneStaleReads({ sessionID: input.sessionID })

        const refreshed = yield* session
          .messages({ sessionID: input.sessionID })
          .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(input.messages)))
        const hidden = new Set(
          completedCompactions(refreshed).flatMap((item) => [item.userIndex, item.assistantIndex]),
        )
        const size = yield* estimate({ messages: refreshed.filter((_, index) => !hidden.has(index)), model })
        if (size < usable({ cfg, model, outputTokenMax: flags.outputTokenMax })) {
          yield* Effect.logInfo("compaction: cheap tiers alone resolved overflow, skipping LLM summarize", {
            sessionID: input.sessionID,
            size,
          })
          // AC-5.1: Tier-1-resolved-it exit — no LLM call, so summary cost is $0.
          yield* emitCompactionReceipt({
            sessionID: input.sessionID,
            turnId: input.parentID,
            model: model.id,
            beforeTokens,
            afterTokens: size,
            reclaimedByPrune: beforeTokens - size,
            reclaimedBySummary: 0,
            summaryCost: 0,
          })
          yield* skipSummary({ parentID: input.parentID, sessionID: input.sessionID, userMessage })
          yield* checkpointExecutionFrontier({ sessionID: input.sessionID })
          return "continue" as const
        }

        // AC-1.8: refuse to spend an LLM summarize call on a brand-new
        // session — the min-gap guard above only rate-limits SUBSEQUENT auto
        // triggers, this catches the very first one. Cheap tiers (mask/
        // prune/pruneStaleReads) already ran above and stand; only the
        // summarize step is suppressed. Auto-triggered only, matching the
        // config description ("before auto-compaction is allowed") — an
        // explicit manual /compact always proceeds.
        const minTurnsBeforeCompact = cfg.compaction?.min_turns_before_compact ?? DEFAULT_MIN_TURNS_BEFORE_COMPACT
        if (input.auto && turns(refreshed).length < minTurnsBeforeCompact) {
          yield* Effect.logInfo("compaction: session too new for auto-compaction, skipping LLM summarize", {
            sessionID: input.sessionID,
            turns: turns(refreshed).length,
            minTurnsBeforeCompact,
          })
          yield* skipSummary({ parentID: input.parentID, sessionID: input.sessionID, userMessage })
          return "continue" as const
        }

        const result = yield* processCompaction({
          ...input,
          messages: refreshed,
          receiptBase: { beforeTokens, postPruneTokens: size },
        })
        if (result === "continue") yield* checkpointExecutionFrontier({ sessionID: input.sessionID })
        return result
      }).pipe(Effect.ensuring(Effect.sync(() => running.delete(input.sessionID))))
    })

    return Service.of({
      isOverflow,
      prune,
      maskObservations,
      pruneStaleReads,
      setPinned,
      process: processCompaction,
      compact,
      create,
      rehydrateExecutionFrontier,
    })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(SessionProcessor.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(RuntimeFlags.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(SessionCanonicalState.defaultLayer),
  ),
)

// SessionCanonicalState has no `.node` of its own (its `layer` needs only
// Database.Service) — wrap it locally the same way agent.ts wraps
// LocationServiceMap.layer, rather than editing canonical-state.ts.
const canonicalStateNode = LayerNode.make(SessionCanonicalState.layer, [Database.node])

export const node = LayerNode.make(layer, [
  Config.node,
  Session.node,
  Agent.node,
  Plugin.node,
  SessionProcessor.node,
  Provider.node,
  EventV2Bridge.node,
  RuntimeFlags.node,
  canonicalStateNode,
])

export * as SessionCompaction from "./compaction"
