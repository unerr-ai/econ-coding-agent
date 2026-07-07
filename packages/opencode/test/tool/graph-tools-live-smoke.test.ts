/**
 * Live smoke for every registered graph tool: executes recon, get_references,
 * search, file_outline, and note_save end-to-end against THIS repo's real
 * graph (warm from the persisted graph.db, cold-indexed if absent). Guards the
 * whole model-facing surface against silent breakage — empty results, "still
 * indexing" fallbacks on a ready graph, or hangs (each test carries a hard
 * timeout).
 */
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "../../src/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import {
  GraphReconTool,
  GraphGetReferencesTool,
  GraphSearchCodeTool,
  GraphFileOutlineTool,
  GraphNoteSaveTool,
} from "../../src/tool/graph-tools"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer, Ripgrep.defaultLayer))

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_livesmoke"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const TIMEOUT = 60_000

describe("graph tools — live execute smoke (real repo graph)", () => {
  it.instance(
    "search(mode:'symbol') resolves a real class",
    () =>
      Effect.gen(function* () {
        const tool = yield* (yield* GraphSearchCodeTool).init()
        const result = yield* tool.execute({ query: "BunSqliteGraph", mode: "symbol" }, ctx)
        expect(result.output).not.toContain("still indexing")
        expect(result.output).toContain("BunSqliteGraph")
      }),
    TIMEOUT,
  )

  it.instance(
    "search with a task phrase ranks the right entity",
    () =>
      Effect.gen(function* () {
        const tool = yield* (yield* GraphSearchCodeTool).init()
        const result = yield* tool.execute({ query: "where is turn risk probed" }, ctx)
        expect(result.output).not.toContain("still indexing")
        expect(result.output.length).toBeGreaterThan(0)
        expect(result.output).toContain("TurnRisk")
      }),
    TIMEOUT,
  )

  it.instance(
    "recon(task) returns a bundle with entities",
    () =>
      Effect.gen(function* () {
        const tool = yield* (yield* GraphReconTool).init()
        const result = yield* tool.execute({ task: "add a note to the code graph" }, ctx)
        expect(result.output).not.toContain("still indexing")
        expect(result.output.length).toBeGreaterThan(0)
      }),
    TIMEOUT,
  )

  it.instance(
    "get_references(entity) lists callers of planRaiseForTurn",
    () =>
      Effect.gen(function* () {
        const tool = yield* (yield* GraphGetReferencesTool).init()
        const result = yield* tool.execute({ entity: "planRaiseForTurn", direction: "callers" }, ctx)
        expect(result.output).not.toContain("still indexing")
        expect(result.output).toContain("tier-router")
      }),
    TIMEOUT,
  )

  it.instance(
    "file_outline returns entities for a large source file",
    () =>
      Effect.gen(function* () {
        const tool = yield* (yield* GraphFileOutlineTool).init()
        // file_path resolves against the instance directory (packages/opencode
        // under bun test), matching read/edit tool semantics — not the repo root.
        const result = yield* tool.execute({ file_path: "src/tool/graph-tools.ts" }, ctx)
        expect(result.output).not.toContain("still indexing")
        expect(result.output).toContain("getGraph")
      }),
    TIMEOUT,
  )

  it.instance(
    "note_save persists a wire-format note and rejects a malformed one",
    () =>
      Effect.gen(function* () {
        const tool = yield* (yield* GraphNoteSaveTool).init()
        const ok = yield* tool.execute(
          { note: "fct|f:packages/code-intelligence/src/bun-sqlite-graph.ts|+|live smoke: graph tool surface verified" },
          ctx,
        )
        expect(ok.output.toLowerCase()).not.toContain("invalid")
        const bad = yield* tool.execute({ note: "zzz|f:whatever|+|nope" }, ctx)
        expect(bad.output).toContain("Invalid")
      }),
    TIMEOUT,
  )
})
