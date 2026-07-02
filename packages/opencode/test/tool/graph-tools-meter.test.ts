/**
 * Meter integration tests for graph tools.
 * Verifies that invoking a graph tool records a ToolCallRecord in the in-process
 * meter — i.e. that withMeta + recordToolCall are called on every execute path.
 *
 * Strategy: the meter write happens inside the Effect.promise() callback, which
 * resolves before the Tool.wrap truncation step runs. We capture the Exit value
 * so that a truncation failure (InstanceRef not provided in test env) does not
 * mask the meter assertion — we only care that recordToolCall fired.
 */
import { describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "../../src/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { getRecords, clearRecords } from "../../src/tool/_shared"
import { GraphFileOutlineTool } from "../../src/tool/graph-tools"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer))

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_meter"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

// Path relative to the opencode package root (process.cwd() during tests).
const GRAPH_TOOLS_PATH = "src/tool/graph-tools.ts"

describe("graph tools — meter integration", () => {
  it.effect("file_outline: invoking the tool records a meter entry with tool='file_outline'", () =>
    Effect.gen(function* () {
      clearRecords()

      const info = yield* GraphFileOutlineTool
      const tool = yield* info.init()
      // Capture Exit: meter write happens before truncation; we ignore any
      // subsequent truncation error from the minimal test layer.
      yield* tool.execute({ file_path: GRAPH_TOOLS_PATH }, ctx).pipe(Effect.exit)

      const records = getRecords()
      const rec = records.find((r) => r.tool === "file_outline")
      expect(rec).toBeDefined()
      expect(typeof rec!.raw_tokens).toBe("number")
      expect(typeof rec!.returned_tokens).toBe("number")
      expect(typeof rec!.ratio).toBe("number")
    }),
  )

})
