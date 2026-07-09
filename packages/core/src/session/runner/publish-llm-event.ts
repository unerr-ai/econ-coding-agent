import { ToolOutput, type LLMEvent, type ProviderMetadata, type ToolResultValue, type Usage } from "@opencode-ai/llm"
import { recordCacheHit, inferTier } from "@opencode-ai/code-intelligence"
import { DateTime, Effect } from "effect"
import { EventV2 } from "../../event"
import { ModelV2 } from "../../model"
import { SessionEvent } from "../event"
import { SessionMessage } from "../message"
import { SessionSchema } from "../schema"

type Input = {
  readonly sessionID: SessionSchema.ID
  readonly agent: string
  readonly model: ModelV2.Ref
}

// econ S7.1: per-turn usage → telemetry sink.
// The runner forwards each completed turn's usage (cost + tokens + model) to an
// optional process-level sink so econ's proof surface (telemetry store, status
// line, savings receipt) can record it. Kept dependency-free — a plain global
// hook rather than an import — so `@opencode-ai/core` stays decoupled from the
// observability package; `installUsageSink` (code-intelligence/telemetry.ts)
// registers the sink at app bootstrap. No-op until a sink is installed.
type EconUsagePayload = {
  sessionID: string
  turnId?: string
  model: string
  cost?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
}
const econUsageSink = (): ((raw: EconUsagePayload) => void) | undefined =>
  (globalThis as { __econUsageSink?: (raw: EconUsagePayload) => void }).__econUsageSink

const safe = (value: number | undefined) => Math.max(0, Number.isFinite(value) ? (value ?? 0) : 0)

const tokens = (usage: Usage | undefined) => {
  const reasoning = safe(usage?.reasoningTokens)
  const read = safe(usage?.cacheReadInputTokens)
  const write = safe(usage?.cacheWriteInputTokens)
  return {
    input: safe(usage?.nonCachedInputTokens),
    output: safe(usage?.visibleOutputTokens),
    reasoning,
    cache: { read, write },
  }
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : { value }

const message = (value: unknown) => {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

type SettledOutput =
  | { readonly structured: Record<string, unknown>; readonly content: ToolOutput["content"] }
  | { readonly error: { readonly type: "unknown"; readonly message: string } }

const settledOutput = (value: ToolOutput | undefined, result: ToolResultValue): SettledOutput => {
  if (result.type === "error") return { error: { type: "unknown", message: message(result.value) } }
  const settled = value ?? ToolOutput.fromResultValue(result)
  if (!settled) throw new Error(`Unsupported tool result: ${message(result)}`)
  return { structured: record(settled.structured), content: settled.content }
}

/** Persist one provider turn without executing tools or starting a continuation turn. */
export const createLLMEventPublisher = (events: EventV2.Interface, input: Input) => {
  const tools = new Map<
    string,
    {
      readonly assistantMessageID: SessionMessage.ID
      readonly name: string
      inputEnded: boolean
      called: boolean
      settled: boolean
      providerExecuted: boolean
      providerMetadata?: ProviderMetadata
    }
  >()
  const timestamp = DateTime.now
  let assistantMessageID: SessionMessage.ID | undefined
  let assistantActive = false
  let assistantFailed = false
  let providerFailed = false
  // AC-0.4: count finished turns so recordCacheHit can tell a cold first
  // turn (no warm cache to hit yet) from a later turn that should be warm.
  let turnsFinished = 0

  const startAssistant = Effect.fnUntraced(function* () {
    if (assistantMessageID !== undefined) return assistantMessageID
    assistantMessageID = SessionMessage.ID.create()
    assistantActive = true
    yield* events.publish(SessionEvent.Step.Started, {
      ...input,
      assistantMessageID,
      timestamp: yield* timestamp,
    })
    return assistantMessageID
  })
  const currentAssistantMessageID = () =>
    assistantMessageID === undefined
      ? Effect.die("Tool event before assistant step start")
      : Effect.succeed(assistantMessageID)

  const fragments = (
    name: string,
    ended: (id: string, value: string, providerMetadata?: ProviderMetadata) => Effect.Effect<void>,
  ) => {
    const chunks = new Map<string, string[]>()
    const start = (id: string) =>
      Effect.suspend(() => {
        if (chunks.has(id)) return Effect.die(`Duplicate ${name} start: ${id}`)
        chunks.set(id, [])
        return Effect.void
      })
    const append = (id: string, value: string) =>
      Effect.suspend(() => {
        const current = chunks.get(id)
        if (!current) return Effect.die(`${name} delta before start: ${id}`)
        current.push(value)
        return Effect.void
      })
    const end = Effect.fnUntraced(function* (id: string, providerMetadata?: ProviderMetadata) {
      const current = chunks.get(id)
      if (!current) return yield* Effect.die(`${name} end before start: ${id}`)
      yield* ended(id, current.join(""), providerMetadata)
      chunks.delete(id)
    })
    const flush = Effect.fnUntraced(function* () {
      for (const id of chunks.keys()) yield* end(id)
    })
    return { start, append, end, flush }
  }

  const text = fragments("text", (textID, value, providerMetadata) =>
    Effect.gen(function* () {
      yield* events.publish(SessionEvent.Text.Ended, {
        sessionID: input.sessionID,
        assistantMessageID: yield* currentAssistantMessageID(),
        timestamp: yield* timestamp,
        textID,
        text: value,
        providerMetadata,
      })
    }),
  )
  const reasoning = fragments("reasoning", (reasoningID, value, providerMetadata) =>
    Effect.gen(function* () {
      yield* events.publish(SessionEvent.Reasoning.Ended, {
        sessionID: input.sessionID,
        assistantMessageID: yield* currentAssistantMessageID(),
        timestamp: yield* timestamp,
        reasoningID,
        text: value,
        providerMetadata,
      })
    }),
  )
  const toolInput = fragments("tool input", (callID, value) =>
    Effect.gen(function* () {
      const tool = tools.get(callID)
      if (!tool) return yield* Effect.die(`Tool input end before start: ${callID}`)
      yield* events.publish(SessionEvent.Tool.Input.Ended, {
        sessionID: input.sessionID,
        timestamp: yield* timestamp,
        assistantMessageID: tool.assistantMessageID,
        callID,
        text: value,
      })
      tool.inputEnded = true
    }),
  )

  const flushFragments = Effect.fnUntraced(function* () {
    yield* text.flush()
    yield* reasoning.flush()
    yield* toolInput.flush()
  })

  const startToolInput = Effect.fnUntraced(function* (event: { readonly id: string; readonly name: string }) {
    if (tools.has(event.id)) return yield* Effect.die(`Duplicate tool input start: ${event.id}`)
    const assistantMessageID = yield* startAssistant()
    tools.set(event.id, {
      assistantMessageID,
      name: event.name,
      inputEnded: false,
      called: false,
      settled: false,
      providerExecuted: false,
    })
    yield* toolInput.start(event.id)
    yield* events.publish(SessionEvent.Tool.Input.Started, {
      sessionID: input.sessionID,
      timestamp: yield* timestamp,
      assistantMessageID,
      callID: event.id,
      name: event.name,
    })
  })

  const endToolInput = Effect.fnUntraced(function* (event: { readonly id: string; readonly name: string }) {
    const tool = tools.get(event.id)
    if (!tool) return yield* Effect.die(`Tool input end before start: ${event.id}`)
    if (tool.name !== event.name)
      return yield* Effect.die(`Tool input name changed for ${event.id}: ${tool.name} -> ${event.name}`)
    if (tool.inputEnded) return yield* Effect.die(`Duplicate tool input end: ${event.id}`)
    yield* toolInput.end(event.id)
  })

  const flush = Effect.fn("SessionRunner.flush")(function* () {
    yield* flushFragments()
  })

  const failAssistant = Effect.fnUntraced(function* (message: string) {
    if (assistantFailed) return
    yield* flush()
    const assistantMessageID = yield* startAssistant()
    assistantActive = false
    assistantFailed = true
    yield* events.publish(SessionEvent.Step.Failed, {
      sessionID: input.sessionID,
      timestamp: yield* timestamp,
      assistantMessageID,
      error: { type: "unknown", message },
    })
  })

  const failUnsettledTools = Effect.fn("SessionRunner.failUnsettledTools")(function* (
    message: string,
    hostedOnly = false,
  ) {
    for (const [callID, tool] of tools) {
      if (tool.settled || (hostedOnly && !tool.providerExecuted)) continue
      tool.settled = true
      yield* events.publish(SessionEvent.Tool.Failed, {
        sessionID: input.sessionID,
        timestamp: yield* timestamp,
        assistantMessageID: tool.assistantMessageID,
        callID,
        error: { type: "unknown", message },
        provider: {
          executed: tool.providerExecuted,
          ...(tool.providerMetadata === undefined ? {} : { metadata: tool.providerMetadata }),
        },
      })
    }
  })

  const assistantMessageIDForTool = (callID: string) => {
    const tool = tools.get(callID)
    return tool ? Effect.succeed(tool.assistantMessageID) : Effect.die(`Unknown tool call: ${callID}`)
  }

  const publish = Effect.fn("SessionRunner.publishLLMEvent")(function* (
    event: LLMEvent,
    outputPaths: ReadonlyArray<string> = [],
  ) {
    switch (event.type) {
      case "step-start":
        return
      case "text-start":
        yield* text.start(event.id)
        yield* events.publish(SessionEvent.Text.Started, {
          sessionID: input.sessionID,
          assistantMessageID: yield* startAssistant(),
          timestamp: yield* timestamp,
          textID: event.id,
        })
        return
      case "text-delta":
        yield* text.append(event.id, event.text)
        yield* events.publish(SessionEvent.Text.Delta, {
          sessionID: input.sessionID,
          assistantMessageID: yield* currentAssistantMessageID(),
          timestamp: yield* timestamp,
          textID: event.id,
          delta: event.text,
        })
        return
      case "text-end":
        yield* text.end(event.id, event.providerMetadata)
        return
      case "reasoning-start":
        yield* reasoning.start(event.id)
        yield* events.publish(SessionEvent.Reasoning.Started, {
          sessionID: input.sessionID,
          assistantMessageID: yield* startAssistant(),
          timestamp: yield* timestamp,
          reasoningID: event.id,
          providerMetadata: event.providerMetadata,
        })
        return
      case "reasoning-delta":
        yield* reasoning.append(event.id, event.text)
        yield* events.publish(SessionEvent.Reasoning.Delta, {
          sessionID: input.sessionID,
          assistantMessageID: yield* currentAssistantMessageID(),
          timestamp: yield* timestamp,
          reasoningID: event.id,
          delta: event.text,
        })
        return
      case "reasoning-end":
        yield* reasoning.end(event.id, event.providerMetadata)
        return
      case "tool-input-start":
        yield* startToolInput(event)
        return
      case "tool-input-delta": {
        const tool = tools.get(event.id)
        if (!tool) return yield* Effect.die(`Tool input delta before start: ${event.id}`)
        if (tool.name !== event.name)
          return yield* Effect.die(`Tool input name changed for ${event.id}: ${tool.name} -> ${event.name}`)
        if (tool.inputEnded) return yield* Effect.die(`Tool input delta after end: ${event.id}`)
        yield* toolInput.append(event.id, event.text)
        yield* events.publish(SessionEvent.Tool.Input.Delta, {
          sessionID: input.sessionID,
          timestamp: yield* timestamp,
          assistantMessageID: tool.assistantMessageID,
          callID: event.id,
          delta: event.text,
        })
        return
      }
      case "tool-input-end":
        yield* endToolInput(event)
        return
      case "tool-call": {
        if (!tools.has(event.id)) yield* startToolInput(event)
        const tool = tools.get(event.id)!
        if (!tool.inputEnded) yield* endToolInput(event)
        if (tool.name !== event.name)
          return yield* Effect.die(`Tool call name changed for ${event.id}: ${tool.name} -> ${event.name}`)
        if (tool.called) return yield* Effect.die(`Duplicate tool call: ${event.id}`)
        tool.called = true
        tool.providerExecuted = event.providerExecuted === true
        tool.providerMetadata = event.providerMetadata
        yield* events.publish(SessionEvent.Tool.Called, {
          sessionID: input.sessionID,
          timestamp: yield* timestamp,
          assistantMessageID: tool.assistantMessageID,
          callID: event.id,
          tool: event.name,
          input: record(event.input),
          provider: {
            executed: tool.providerExecuted,
            ...(event.providerMetadata === undefined ? {} : { metadata: event.providerMetadata }),
          },
        })
        return
      }
      case "tool-result": {
        const tool = tools.get(event.id)
        if (!tool?.called) return yield* Effect.die(`Tool result before call: ${event.id}`)
        if (tool.name !== event.name)
          return yield* Effect.die(`Tool result name changed for ${event.id}: ${tool.name} -> ${event.name}`)
        if (tool.settled) {
          if (event.result.type === "error") return
          return yield* Effect.die(`Duplicate tool result: ${event.id}`)
        }
        tool.settled = true
        const result = settledOutput(event.output, event.result)
        const provider = {
          executed: event.providerExecuted === true || tool.providerExecuted,
          ...(event.providerMetadata === undefined ? {} : { metadata: event.providerMetadata }),
        }
        if ("error" in result) {
          yield* events.publish(SessionEvent.Tool.Failed, {
            sessionID: input.sessionID,
            timestamp: yield* timestamp,
            assistantMessageID: tool.assistantMessageID,
            callID: event.id,
            error: result.error,
            result: event.result,
            provider,
          })
          return
        }
        yield* events.publish(SessionEvent.Tool.Success, {
          sessionID: input.sessionID,
          timestamp: yield* timestamp,
          assistantMessageID: tool.assistantMessageID,
          callID: event.id,
          ...result,
          outputPaths,
          ...(provider.executed ? { result: event.result } : {}),
          provider,
        })
        return
      }
      case "tool-error": {
        const tool = tools.get(event.id)
        if (!tool?.called) return yield* Effect.die(`Tool error before call: ${event.id}`)
        if (tool.name !== event.name)
          return yield* Effect.die(`Tool error name changed for ${event.id}: ${tool.name} -> ${event.name}`)
        if (tool.settled) return yield* Effect.die(`Duplicate tool error: ${event.id}`)
        tool.settled = true
        yield* events.publish(SessionEvent.Tool.Failed, {
          sessionID: input.sessionID,
          timestamp: yield* timestamp,
          assistantMessageID: tool.assistantMessageID,
          callID: event.id,
          error: { type: "unknown", message: event.message },
          provider: {
            executed: tool.providerExecuted,
            ...(event.providerMetadata === undefined ? {} : { metadata: event.providerMetadata }),
          },
        })
        return
      }
      case "step-finish": {
        yield* flush()
        assistantActive = false
        const turnAssistantID = yield* startAssistant()
        const turnTokens = tokens(event.usage)
        yield* events.publish(SessionEvent.Step.Ended, {
          sessionID: input.sessionID,
          timestamp: yield* timestamp,
          assistantMessageID: turnAssistantID,
          finish: event.reason,
          cost: event.usage?.cost ?? 0,
          tokens: turnTokens,
        })
        // econ S7.1: forward this turn's usage to the telemetry sink (no-op when
        // unregistered). Tier is left to the sink (inferTier / router tag).
        econUsageSink()?.({
          sessionID: input.sessionID,
          turnId: turnAssistantID,
          model: `${input.model.providerID}/${input.model.id}`,
          cost: event.usage?.cost ?? 0,
          tokens: {
            input: turnTokens.input,
            output: turnTokens.output,
            reasoning: turnTokens.reasoning,
            cache: { read: turnTokens.cache.read, write: turnTokens.cache.write },
          },
        })
        // AC-0.4: measure this turn's cache-hit rate and WARN when a
        // warm-cache-eligible turn (not the first) falls below 80%.
        // AC-8.4: tag the turn's tier so TierCacheRollup (cache-meter.ts) can
        // aggregate hit-rate/cost per tier and detect cross-tier transitions.
        // `inferTier` is the same name-heuristic fallback `emitUsageEvent`
        // already uses when the router hasn't tagged a turn — it is the best
        // signal available at this call site today.
        // TODO(AC-8.x): once the S3.2 router tags turns with an authoritative
        // tier (model.ts), thread that through `Input` and prefer it here
        // instead of inferring from the model id.
        turnsFinished += 1
        recordCacheHit({
          sessionID: input.sessionID,
          turnId: turnAssistantID,
          tokens: {
            cacheRead: turnTokens.cache.read,
            cacheWrite: turnTokens.cache.write,
            input: turnTokens.input,
          },
          isFirstTurn: turnsFinished === 1,
          tier: inferTier(`${input.model.providerID}/${input.model.id}`),
          modelID: `${input.model.providerID}/${input.model.id}`,
          cost: event.usage?.cost ?? 0,
        })
        return
      }
      case "finish":
        return
      case "provider-error":
        providerFailed = true
        yield* failAssistant(event.message)
        return
    }
  })

  return {
    publish,
    flush,
    failAssistant,
    failUnsettledTools,
    hasActiveAssistant: () => assistantActive,
    hasAssistantStarted: () => assistantMessageID !== undefined,
    hasProviderError: () => providerFailed,
    assistantMessageID: assistantMessageIDForTool,
  }
}
