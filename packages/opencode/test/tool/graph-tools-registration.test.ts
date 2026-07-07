/**
 * Registration + readiness tests for the econ graph tools (graph uplift,
 * task #3). Verifies the four graph-backed tools (recon, get_references,
 * search, file_outline) carry the ids the tool registry wires them under,
 * and that a graph tool's execute path awaits the initial index before
 * querying — a cold, un-awaited query would return empty and send the model
 * shelling out to grep.
 */
import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
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
} from "../../src/tool/graph-tools"
import { HIDDEN_FROM_MODEL, CATALOG_TOOL_IDS } from "../../src/tool/registry"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer, Ripgrep.defaultLayer))

// Small toy fixture (shared with graph-tools-turnrisk.test.ts) instead of the
// real package tree — keeps the index fast and deterministic for a cold-query test.
// getGraph() canonicalizes to the nearest .git root, so chdir-ing into a fixture
// INSIDE this monorepo would index the whole repo; copy it to a temp dir with its
// own .git marker so the fixture is treated as a standalone repo root.
const COUPLING_FIXTURE_SRC = join(import.meta.dir, "fixtures/ol79-coupling")
function makeStandaloneFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "econ-graphreg-"))
  mkdirSync(join(dir, ".git"))
  cpSync(COUPLING_FIXTURE_SRC, join(dir, "src"), { recursive: true })
  return dir
}

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_graphreg"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

describe("graph tools — registration", () => {
  test("recon/get_references/search/file_outline carry the ids the registry wires them under", () => {
    expect(GraphReconTool.id).toBe("recon")
    expect(GraphGetReferencesTool.id).toBe("get_references")
    expect(GraphSearchCodeTool.id).toBe("search")
    expect(GraphFileOutlineTool.id).toBe("file_outline")
  })

  test("recon/get_references fold into the unified search tool (hidden from the model); search/file_outline stay advertised", () => {
    expect(HIDDEN_FROM_MODEL.has(GraphReconTool.id)).toBe(true)
    expect(HIDDEN_FROM_MODEL.has(GraphGetReferencesTool.id)).toBe(true)
    expect(HIDDEN_FROM_MODEL.has(GraphSearchCodeTool.id)).toBe(false)
    expect(CATALOG_TOOL_IDS.has(GraphFileOutlineTool.id)).toBe(true)
  })
})

describe("graph tools — readiness gate (cold first query)", () => {
  it.instance(
    "search(mode:'symbol') awaits the initial index and returns real entities instead of an empty/timeout result",
    () =>
      Effect.gen(function* () {
        const originalCwd = process.cwd()
        // getGraph() indexes the canonical repo root of process.cwd() lazily on
        // first call — point it at a standalone temp copy of the fixture (with
        // its own .git marker) so this stays fast and deterministic.
        const fixtureRepo = makeStandaloneFixtureRepo()
        process.chdir(fixtureRepo)
        try {
          const info = yield* GraphSearchCodeTool
          const tool = yield* info.init()
          // First touch of the module-singleton graph in this process — a genuinely
          // cold query. Without the ensureGraphReadyBounded() gate this would race
          // the background index and come back empty.
          const result = yield* tool.execute({ query: "centralHub", mode: "symbol" }, ctx)

          expect(result.output).not.toContain("still indexing")
          expect(result.output).toContain("centralHub")
        } finally {
          process.chdir(originalCwd)
          rmSync(fixtureRepo, { recursive: true, force: true })
        }
      }),
    20_000,
  )
})
