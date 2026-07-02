import type { Config as SdkConfig } from "@opencode-ai/sdk/v2"

// Mirrors packages/opencode/src/provider/transform.ts (OUTPUT_TOKEN_MAX) and
// packages/opencode/src/session/overflow.ts (COMPACTION_BUFFER). Duplicated
// here because the TUI has no import path into the server's session/provider
// modules — keep these two constants in sync if either source changes.
const OUTPUT_TOKEN_MAX = 32_000
const COMPACTION_BUFFER = 20_000

export type ContextUsageModel = {
  limit: {
    context: number
    input?: number
    output: number
  }
}

export type ContextTokens = {
  input: number
  output: number
  reasoning: number
}

export type ContextFullness = {
  /** Current single-request context size (input + output + reasoning). */
  tokens: number
  limit: number | undefined
  usable: number | undefined
  reserved: number | undefined
  /** % of the raw context window occupied by `tokens`. */
  percentOfWindow: number | null
  /** % of usable() reached; auto-compaction fires once this hits 100. */
  percentOfUsable: number | null
  /** % of the window left before auto-compaction fires. */
  percentUntilCompact: number | null
  /** % of the raw window at which auto-compaction fires (usable / limit). */
  compactsAtPercent: number | null
}

/**
 * Current single-request context size: input + output + reasoning tokens of
 * one assistant message. Excludes cumulative cache.read/write, matching
 * `SessionCompaction.isOverflow` — the reconciled definition of "how full is
 * the window right now" (see packages/opencode/src/session/overflow.ts).
 * @sem domain=frontend
 */
export function currentContextTokens(tokens: ContextTokens): number {
  return tokens.input + tokens.output + tokens.reasoning
}

/**
 * How many tokens of the model's window are usable before auto-compaction
 * fires. Mirrors `usable()` in packages/opencode/src/session/overflow.ts,
 * duplicated client-side because the TUI has no import path into the
 * server's session module — keep in sync if that formula changes.
 * @sem domain=frontend
 */
export function usableTokens(model: ContextUsageModel, compaction: SdkConfig["compaction"]): number {
  const context = model.limit.context
  if (!context) return 0
  const reserved = reservedTokens(model, compaction)
  return model.limit.input ? Math.max(0, model.limit.input - reserved) : Math.max(0, context - maxOutputTokens(model))
}

function maxOutputTokens(model: ContextUsageModel): number {
  return Math.min(model.limit.output, OUTPUT_TOKEN_MAX) || OUTPUT_TOKEN_MAX
}

function reservedTokens(model: ContextUsageModel, compaction: SdkConfig["compaction"]): number {
  return compaction?.reserved ?? Math.min(COMPACTION_BUFFER, maxOutputTokens(model))
}

/**
 * Reconciled context-fullness numbers shared by the sidebar panel, the
 * footer countdown and /context: all percentages besides `percentOfWindow`
 * are relative to usable() (the auto-compaction threshold), not the raw
 * window.
 * @sem domain=frontend
 */
export function getContextFullness(input: {
  tokens: ContextTokens
  model: ContextUsageModel | undefined
  compaction: SdkConfig["compaction"]
}): ContextFullness {
  const tokens = currentContextTokens(input.tokens)
  const limit = input.model?.limit.context
  if (!input.model || !limit) {
    return {
      tokens,
      limit,
      usable: undefined,
      reserved: undefined,
      percentOfWindow: null,
      percentOfUsable: null,
      percentUntilCompact: null,
      compactsAtPercent: null,
    }
  }
  const usable = usableTokens(input.model, input.compaction)
  const reserved = reservedTokens(input.model, input.compaction)
  const percentOfWindow = Math.round((tokens / limit) * 100)
  const percentOfUsable = usable > 0 ? Math.round((tokens / usable) * 100) : null
  const percentUntilCompact = percentOfUsable === null ? null : Math.max(0, 100 - percentOfUsable)
  const compactsAtPercent = Math.round((usable / limit) * 100)
  return { tokens, limit, usable, reserved, percentOfWindow, percentOfUsable, percentUntilCompact, compactsAtPercent }
}

/**
 * Whether context fill has crossed the proactive-nudge threshold
 * (`compaction.nudge_pct`, default 0.80 of the auto-compaction usable
 * window) — the trigger for offering /compact, a checkpoint, or narrowing
 * scope before auto-compaction or context rot hits (AC-4.3).
 * @sem domain=frontend
 */
export function shouldNudgeCompaction(fullness: ContextFullness, compaction: SdkConfig["compaction"]): boolean {
  if (fullness.percentOfUsable === null) return false
  const nudgePct = compaction?.nudge_pct ?? 0.8
  return fullness.percentOfUsable >= nudgePct * 100
}
