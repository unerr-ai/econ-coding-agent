import { FinishReason, LLMEvent, ProviderMetadata, ToolResultValue } from "@opencode-ai/llm"
import { Effect, Schema } from "effect"
import { type streamText } from "ai"
import { errorMessage } from "@/util/error"

type Result = Awaited<ReturnType<typeof streamText>>
type AISDKEvent = Result["fullStream"] extends AsyncIterable<infer T> ? T : never

export function adapterState() {
  return {
    step: 0,
    text: 0,
    reasoning: 0,
    currentTextID: undefined as string | undefined,
    currentReasoningID: undefined as string | undefined,
    toolNames: {} as Record<string, string>,
    copilotTotalNanoAiu: undefined as number | undefined,
  }
}

function finishReason(value: string | undefined): FinishReason {
  return Schema.is(FinishReason)(value) ? value : "unknown"
}

function providerMetadata(value: unknown): ProviderMetadata | undefined {
  if (value == null) return undefined
  return Schema.is(ProviderMetadata)(value) ? value : undefined
}

// Temporary AI SDK bridge: Copilot billing survives only in raw provider chunks here.
// Move this extraction into @opencode-ai/llm when Copilot is handled by the native runtime.
function copilotTotalNanoAiu(value: unknown) {
  if (!value || typeof value !== "object") return
  const raw = value as Record<string, unknown>
  const response =
    raw.response && typeof raw.response === "object" ? (raw.response as Record<string, unknown>) : undefined
  const usage = raw.copilot_usage ?? response?.copilot_usage
  if (!usage || typeof usage !== "object") return
  const total = (usage as Record<string, unknown>).total_nano_aiu
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) return
  return total
}

// Wire-derived usage numbers (gateways fronting many OSS models, e.g.
// LiteLLM) can arrive as floats, null, negative, or otherwise inconsistent.
// The persisted session schema requires NonNegativeInt, so every value this
// module emits is coerced here at the boundary: non-number/NaN/±Infinity/
// null drops the entry entirely (treated as "unknown", not zero), negative
// clamps to 0, and a float rounds to the nearest integer.
function sanitizeTokenCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  if (value < 0) return 0
  return Math.round(value)
}

// W8: some gateways surface prompt-cache hits only in the raw provider usage
// JSON (the nested OpenAI/Fireworks `prompt_tokens_details.cached_tokens`, or
// the flat OpenAI-compat `cache_read_input_tokens`) without the AI SDK having
// normalized it into `inputTokenDetails.cacheReadTokens` / `cachedInputTokens`
// for that particular transport. Reads the raw payload as a last-resort
// fallback so reasoner/oracle turns still report a real cache-read count on
// whichever path (streamed or non-streamed) the usage arrived on. Runs
// through the same sanitize guard as every other usage field.
function rawCacheReadTokens(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const item = raw as {
    prompt_tokens_details?: { cached_tokens?: unknown }
    cache_read_input_tokens?: unknown
  }
  const nested = sanitizeTokenCount(item.prompt_tokens_details?.cached_tokens)
  if (nested !== undefined) return nested
  return sanitizeTokenCount(item.cache_read_input_tokens)
}

function usage(value: unknown) {
  if (!value || typeof value !== "object") return undefined
  const item = value as {
    inputTokens?: unknown
    outputTokens?: unknown
    totalTokens?: unknown
    reasoningTokens?: unknown
    cachedInputTokens?: unknown
    inputTokenDetails?: { cacheReadTokens?: unknown; cacheWriteTokens?: unknown }
    outputTokenDetails?: { reasoningTokens?: unknown }
    raw?: unknown
  }
  const entries = Object.entries({
    inputTokens: sanitizeTokenCount(item.inputTokens),
    outputTokens: sanitizeTokenCount(item.outputTokens),
    totalTokens: sanitizeTokenCount(item.totalTokens),
    reasoningTokens: sanitizeTokenCount(item.outputTokenDetails?.reasoningTokens ?? item.reasoningTokens),
    cacheReadInputTokens: sanitizeTokenCount(
      item.inputTokenDetails?.cacheReadTokens ?? item.cachedInputTokens ?? rawCacheReadTokens(item.raw),
    ),
    cacheWriteInputTokens: sanitizeTokenCount(item.inputTokenDetails?.cacheWriteTokens),
  }).filter((entry) => entry[1] !== undefined)
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

function currentTextID(state: ReturnType<typeof adapterState>, id: string | undefined) {
  state.currentTextID = id ?? state.currentTextID ?? `text-${state.text++}`
  return state.currentTextID
}

function currentReasoningID(state: ReturnType<typeof adapterState>, id: string | undefined) {
  state.currentReasoningID = id ?? state.currentReasoningID ?? `reasoning-${state.reasoning++}`
  return state.currentReasoningID
}

export function toLLMEvents(
  state: ReturnType<typeof adapterState>,
  event: AISDKEvent,
): Effect.Effect<ReadonlyArray<LLMEvent>, unknown> {
  switch (event.type) {
    case "start":
      return Effect.succeed([])

    case "start-step":
      return Effect.succeed([LLMEvent.stepStart({ index: state.step })])

    case "finish-step":
      return Effect.sync(() => {
        const original = providerMetadata(event.providerMetadata)
        const metadata =
          state.copilotTotalNanoAiu === undefined
            ? original
            : {
                ...original,
                copilot: {
                  ...original?.copilot,
                  totalNanoAiu: state.copilotTotalNanoAiu,
                },
              }
        state.copilotTotalNanoAiu = undefined
        return [
          LLMEvent.stepFinish({
            index: state.step++,
            reason: finishReason(event.finishReason),
            usage: usage(event.usage),
            providerMetadata: metadata,
          }),
        ]
      })

    case "finish":
      return Effect.sync(() => {
        const events = [
          LLMEvent.finish({
            reason: finishReason(event.finishReason),
            usage: usage(event.totalUsage),
            providerMetadata: "providerMetadata" in event ? providerMetadata(event.providerMetadata) : undefined,
          }),
        ]
        // Reset so the adapter can be reused for a follow-up stream without leaking
        // counters or block IDs. adapterState() is the single source of truth for shape.
        Object.assign(state, adapterState())
        return events
      })

    case "text-start":
      return Effect.sync(() => {
        state.currentTextID = currentTextID(state, event.id)
        return [
          LLMEvent.textStart({
            id: state.currentTextID,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "text-delta":
      return Effect.succeed([
        LLMEvent.textDelta({
          id: currentTextID(state, event.id),
          text: event.text,
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])

    case "text-end":
      return Effect.sync(() => {
        const id = currentTextID(state, event.id)
        state.currentTextID = undefined
        return [
          LLMEvent.textEnd({
            id,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "reasoning-start":
      return Effect.sync(() => {
        state.currentReasoningID = currentReasoningID(state, event.id)
        return [
          LLMEvent.reasoningStart({
            id: state.currentReasoningID,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "reasoning-delta":
      return Effect.succeed([
        LLMEvent.reasoningDelta({
          id: currentReasoningID(state, event.id),
          text: event.text,
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])

    case "reasoning-end":
      return Effect.sync(() => {
        const id = currentReasoningID(state, event.id)
        state.currentReasoningID = undefined
        return [
          LLMEvent.reasoningEnd({
            id,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-input-start":
      return Effect.sync(() => {
        state.toolNames[event.id] = event.toolName
        return [
          LLMEvent.toolInputStart({
            id: event.id,
            name: event.toolName,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-input-delta":
      return Effect.succeed([
        LLMEvent.toolInputDelta({
          id: event.id,
          name: state.toolNames[event.id] ?? "unknown",
          text: event.delta ?? "",
        }),
      ])

    case "tool-input-end":
      return Effect.succeed([
        LLMEvent.toolInputEnd({
          id: event.id,
          name: state.toolNames[event.id] ?? "unknown",
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])

    case "tool-call":
      return Effect.sync(() => {
        state.toolNames[event.toolCallId] = event.toolName
        return [
          LLMEvent.toolCall({
            id: event.toolCallId,
            name: event.toolName,
            input: event.input,
            providerExecuted: "providerExecuted" in event ? event.providerExecuted : undefined,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-result":
      return Effect.sync(() => {
        const name = state.toolNames[event.toolCallId] ?? "unknown"
        delete state.toolNames[event.toolCallId]
        return [
          LLMEvent.toolResult({
            id: event.toolCallId,
            name,
            result: ToolResultValue.make(event.output),
            providerExecuted: "providerExecuted" in event ? event.providerExecuted : undefined,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-error":
      return Effect.sync(() => {
        const name = state.toolNames[event.toolCallId] ?? ("toolName" in event ? event.toolName : "unknown")
        delete state.toolNames[event.toolCallId]
        return [
          LLMEvent.toolError({
            id: event.toolCallId,
            name,
            message: errorMessage(event.error),
            error: event.error,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "error":
      return Effect.fail(event.error)

    case "abort":
    case "source":
    case "file":
    case "tool-output-denied":
    case "tool-approval-request":
      return Effect.succeed([])

    case "raw":
      return Effect.sync(() => {
        state.copilotTotalNanoAiu = copilotTotalNanoAiu(event.rawValue) ?? state.copilotTotalNanoAiu
        return []
      })

    default: {
      const _exhaustive: never = event
      void _exhaustive
      return Effect.succeed([])
    }
  }
}

export * as LLMAISDK from "./ai-sdk"
