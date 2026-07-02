// AC-6.3 — execution-frontier checkpoint: a small typed record of where work
// stands in a session, distinct from the lossy prose summary compaction
// already produces. Derived cheaply (one pass over existing parts, no LLM
// call) from files modified/touched, the latest todowrite plan, tool errors,
// and the already-computed compaction summary text. Persisted via the
// existing S1.3 canonical-state store's generic scratchpad kind under a
// reserved key (mirrors S5.2's task-tree `__task_tree__` convention) — no new
// storage infra. `rehydrate` reloads it so a resumed session can skip
// re-reading unchanged files and repeating rejected approaches.
export * as ExecutionFrontier from "./execution-frontier"

import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { SessionCanonicalState } from "@opencode-ai/core/session/canonical-state"
import type { SessionID } from "./schema"
import { Effect } from "effect"

// Reserved canonical-state scratchpad key this checkpoint round-trips under.
export const EXECUTION_FRONTIER_KEY = "__execution_frontier__"

// Mirrors compaction.ts's own READ_TOOLS/WRITE_TOOLS split — kept as a local
// copy (both are tiny, stable, private lists) rather than exporting them out
// of compaction.ts for one caller.
const READ_TOOLS = ["read"]
const WRITE_TOOLS = ["edit", "write"]

// Keeps the snapshot a bounded frontier, not a second transcript (plan §10).
const MAX_FILES = 50
const MAX_APPROACHES = 5
const MAX_TODOS = 20

export interface ExecutionFrontierApproach {
  readonly description: string
  readonly rejected: boolean
}

export interface ExecutionFrontierTodo {
  readonly content: string
  readonly status: string
}

export interface ExecutionFrontierSnapshot {
  readonly filesModified: readonly string[]
  readonly filesTouched: readonly string[]
  // Files read but never superseded by a later touch — safe for a resumed
  // session to trust without re-reading.
  readonly readCache: readonly string[]
  readonly approachesTried: readonly ExecutionFrontierApproach[]
  readonly decisions: string | undefined
  readonly lastError: string | undefined
  readonly todos: readonly ExecutionFrontierTodo[]
  readonly capturedAt: number
}

function toolFilePath(part: SessionV1.ToolPart): string | undefined {
  const input = part.state.input
  const value = input?.filePath ?? input?.path
  return typeof value === "string" && value ? value : undefined
}

// Cheap, deterministic derivation from a session's existing tool parts — no
// LLM call, no second pass over raw output bodies. `decisions` is passed in
// by the caller (compact() already has the latest compaction summary text
// via `completedCompactions()`) rather than re-derived here.
export function buildExecutionFrontier(input: {
  messages: readonly SessionV1.WithParts[]
  decisions?: string
}): ExecutionFrontierSnapshot {
  const modified = new Set<string>()
  // Chronological (oldest→newest) read/write touches, the same shape
  // compaction.ts's pruneStaleReads uses, so "still fresh" can reuse its
  // supersede check.
  const touches: { path: string; isRead: boolean }[] = []
  const approaches: ExecutionFrontierApproach[] = []
  let lastError: string | undefined
  let todos: ExecutionFrontierTodo[] = []

  for (const msg of input.messages) {
    for (const part of msg.parts) {
      if (part.type !== "tool") continue

      const filePath = toolFilePath(part)
      if (filePath) {
        const isRead = READ_TOOLS.includes(part.tool)
        const isWrite = WRITE_TOOLS.includes(part.tool)
        if (isRead || isWrite) touches.push({ path: filePath, isRead })
        if (isWrite && part.state.status === "completed") modified.add(filePath)
      }

      if (part.tool === "todowrite") {
        const items = part.state.input?.todos
        if (Array.isArray(items)) {
          todos = items
            .filter((item): item is { content: unknown; status: unknown } => typeof item?.content === "string")
            .map((item) => ({
              content: item.content as string,
              status: typeof item.status === "string" ? item.status : "pending",
            }))
        }
      }

      if (part.state.status === "error") {
        lastError = `${part.tool}${filePath ? ` ${filePath}` : ""}: ${part.state.error}`
        approaches.push({ description: `${part.tool}${filePath ? ` ${filePath}` : ""}`, rejected: true })
      }
    }
  }

  const touched = [...new Set(touches.map((t) => t.path))]
  const readCache = touches
    .filter((touch, index) => touch.isRead && !touches.slice(index + 1).some((later) => later.path === touch.path))
    .map((touch) => touch.path)

  return {
    filesModified: [...modified].slice(0, MAX_FILES),
    filesTouched: touched.slice(0, MAX_FILES),
    readCache: [...new Set(readCache)].slice(0, MAX_FILES),
    approachesTried: approaches.slice(-MAX_APPROACHES),
    decisions: input.decisions,
    lastError,
    todos: todos.filter((todo) => todo.status !== "completed").slice(0, MAX_TODOS),
    capturedAt: Date.now(),
  }
}

// Persists via the existing S1.3 canonical-state scratchpad (upsert
// semantics, last-write-wins per session) — no new table/storage.
export const persistExecutionFrontier = Effect.fn("ExecutionFrontier.persist")(function* (input: {
  sessionID: SessionID
  snapshot: ExecutionFrontierSnapshot
  canonicalState: SessionCanonicalState.Interface
}) {
  yield* input.canonicalState.setScratchpad(input.sessionID, EXECUTION_FRONTIER_KEY, input.snapshot)
})

// Resume path: undefined when nothing has been checkpointed yet for this
// session.
export const rehydrateExecutionFrontier = Effect.fn("ExecutionFrontier.rehydrate")(function* (input: {
  sessionID: SessionID
  canonicalState: SessionCanonicalState.Interface
}) {
  const state = yield* input.canonicalState.load(input.sessionID)
  return state.scratchpad[EXECUTION_FRONTIER_KEY] as ExecutionFrontierSnapshot | undefined
})
