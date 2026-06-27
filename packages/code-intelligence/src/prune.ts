/**
 * Context-window pruner for the conductor: drops stale tool outputs,
 * superseded reasoning, and duplicate results so the window stays bounded
 * across a long multi-tool turn. Pure function — no I/O, no imports from
 * opencode packages.
 *
 * @sem domain=context-management role=pruner
 */

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------
// Try to import estimateTokens from trim.ts (sibling S2.2). If that module
// does not exist yet, fall back to the char/4 heuristic which is accurate
// enough for budget gating.

type EstimateFn = (text: string) => number

function charDiv4(text: string): number {
  return Math.ceil(text.length / 4)
}

function loadEstimator(): EstimateFn {
  try {
    // Bun supports require() in ES module context for same-workspace packages.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("./trim") as { estimateTokens?: EstimateFn }
    if (typeof mod?.estimateTokens === "function") return mod.estimateTokens
  } catch {
    // trim.ts not present yet (S2.2 sibling task) — charDiv4 fallback is fine.
  }
  return charDiv4
}

const estimateTokens: EstimateFn = loadEstimator()

// ---------------------------------------------------------------------------
// Lightweight message types — mirror packages/core/src/v1/session.ts shapes
// without importing that package so prune.ts is dependency-free.
// ---------------------------------------------------------------------------

export interface TextPart {
  type: "text"
  text: string
  [key: string]: unknown
}

export interface ReasoningPart {
  type: "reasoning"
  text: string
  [key: string]: unknown
}

export interface ToolState {
  status: "pending" | "running" | "completed" | "error"
  input?: Record<string, unknown>
  output?: string
  title?: string
  [key: string]: unknown
}

export interface ToolPart {
  type: "tool"
  callID: string
  tool: string
  state: ToolState
  [key: string]: unknown
}

/** Any part that doesn't need special pruning treatment. */
export interface GenericPart {
  type: string
  [key: string]: unknown
}

export type Part = TextPart | ReasoningPart | ToolPart | GenericPart

export interface MessageInfo {
  id: string
  role: "user" | "assistant"
  [key: string]: unknown
}

/** A full conversation message (info envelope + ordered parts). */
export interface Message {
  info: MessageInfo
  parts: Part[]
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PruneOptions {
  /**
   * Maximum tokens allowed in the output window.
   * @default 80_000
   */
  tokenBudget?: number
  /**
   * Number of most-recent messages that are always kept verbatim regardless of
   * any other heuristic.
   * @default 6
   */
  keepLastN?: number
}

export interface PruneReport {
  inputMessages: number
  outputMessages: number
  droppedToolOutputs: number
  droppedReasoningParts: number
  droppedMessages: number
  estimatedInputTokens: number
  estimatedOutputTokens: number
}

export interface PruneResult {
  messages: Message[]
  report: PruneReport
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Deduplication key for a completed tool call: tool name + stable JSON of
 * input so two calls to "read_file" on the same path collide.
 */
function toolKey(tp: ToolPart): string {
  return `${tp.tool}:${JSON.stringify(tp.state.input ?? {})}`
}

function estimatePartTokens(part: Part): number {
  switch (part.type) {
    case "text":
    case "reasoning":
      return estimateTokens((part as TextPart | ReasoningPart).text ?? "")
    case "tool": {
      const tp = part as ToolPart
      const inputStr = JSON.stringify(tp.state.input ?? {})
      const outputStr = typeof tp.state.output === "string" ? tp.state.output : ""
      // tool name + call overhead approximation
      return estimateTokens(tp.tool) + estimateTokens(inputStr) + estimateTokens(outputStr) + 8
    }
    default:
      return estimateTokens(JSON.stringify(part))
  }
}

function estimateMessageTokens(msg: Message): number {
  // role overhead (~4 tokens)
  return msg.parts.reduce((sum, p) => sum + estimatePartTokens(p), 4)
}

// ---------------------------------------------------------------------------
// pruneWindow — the main export
// ---------------------------------------------------------------------------

/**
 * Prunes a conversation window to stay within `tokenBudget` while preserving
 * load-bearing content.
 *
 * Prune policy (applied in order, stopping once under budget):
 *  Stage 1 — Deduplicate completed tool outputs: for each (tool, input) pair
 *             appearing in the old region, drop all but the most recent result.
 *  Stage 2 — Drop reasoning parts from messages outside the protected tail.
 *  Stage 3 — Drop entire old assistant messages from oldest to newest until
 *             the window fits.
 *
 * The most recent `keepLastN` messages are always kept verbatim and are never
 * subject to any pruning stage.
 *
 * @param messages — ordered conversation (oldest first)
 * @param options  — budget + keepLastN controls
 * @returns pruned message list + a structured drop report
 */
export function pruneWindow(messages: Message[], options: PruneOptions = {}): PruneResult {
  const { tokenBudget = 80_000, keepLastN = 6 } = options

  // Fast path: already within budget
  const inputTokens = messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0)
  if (inputTokens <= tokenBudget) {
    return {
      messages,
      report: {
        inputMessages: messages.length,
        outputMessages: messages.length,
        droppedToolOutputs: 0,
        droppedReasoningParts: 0,
        droppedMessages: 0,
        estimatedInputTokens: inputTokens,
        estimatedOutputTokens: inputTokens,
      },
    }
  }

  // Split into the "old" region (eligible for pruning) and the protected tail.
  const protectedStart = Math.max(0, messages.length - keepLastN)
  const oldMessages = messages.slice(0, protectedStart)
  const recentMessages = messages.slice(protectedStart)

  let runningTokens = inputTokens
  let droppedToolOutputs = 0
  let droppedReasoningParts = 0
  let droppedMessages = 0

  // -------------------------------------------------------------------------
  // Stage 1: Deduplicate completed tool outputs in old messages
  // -------------------------------------------------------------------------
  // Walk old messages to find the LAST occurrence index for each (tool, input).
  const latestIdx = new Map<string, number>()
  for (let i = 0; i < oldMessages.length; i++) {
    const msg = oldMessages[i]
    if (msg.info.role !== "assistant") continue
    for (const part of msg.parts) {
      if (part.type !== "tool") continue
      const tp = part as ToolPart
      if (tp.state.status !== "completed") continue
      latestIdx.set(toolKey(tp), i)
    }
  }

  // Build pruned old-message list, dropping stale tool outputs.
  const afterStage1: Message[] = []
  for (let i = 0; i < oldMessages.length; i++) {
    const msg = oldMessages[i]
    const newParts: Part[] = []

    for (const part of msg.parts) {
      if (part.type === "tool") {
        const tp = part as ToolPart
        if (tp.state.status === "completed" && latestIdx.get(toolKey(tp)) !== i) {
          // Stale duplicate — drop it
          runningTokens -= estimatePartTokens(tp)
          droppedToolOutputs++
          continue
        }
      }
      newParts.push(part)
    }

    if (newParts.length > 0) {
      afterStage1.push({ info: msg.info, parts: newParts })
    } else if (msg.info.role === "user") {
      // User messages are always structurally required even when empty after pruning
      afterStage1.push({ info: msg.info, parts: [] })
    } else {
      runningTokens -= 4 // role overhead
      droppedMessages++
    }
  }

  // -------------------------------------------------------------------------
  // Stage 2: Drop reasoning parts from the pruned old region
  // -------------------------------------------------------------------------
  if (runningTokens > tokenBudget) {
    for (const msg of afterStage1) {
      if (msg.info.role !== "assistant") continue
      const filtered: Part[] = []
      for (const part of msg.parts) {
        if (part.type === "reasoning") {
          runningTokens -= estimatePartTokens(part)
          droppedReasoningParts++
        } else {
          filtered.push(part)
        }
      }
      msg.parts = filtered
    }
  }

  // -------------------------------------------------------------------------
  // Stage 3: Drop entire old assistant messages (oldest first)
  // -------------------------------------------------------------------------
  const afterStage3: Message[] = []
  if (runningTokens > tokenBudget) {
    for (const msg of afterStage1) {
      if (runningTokens > tokenBudget && msg.info.role === "assistant") {
        runningTokens -= estimateMessageTokens(msg)
        droppedMessages++
        // skip (don't push)
      } else {
        afterStage3.push(msg)
      }
    }
  } else {
    afterStage3.push(...afterStage1)
  }

  const result: Message[] = [...afterStage3, ...recentMessages]
  const outputTokens = result.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0)

  return {
    messages: result,
    report: {
      inputMessages: messages.length,
      outputMessages: result.length,
      droppedToolOutputs,
      droppedReasoningParts,
      droppedMessages,
      estimatedInputTokens: inputTokens,
      estimatedOutputTokens: outputTokens,
    },
  }
}
