/**
 * Task #7 (econ graph uplift): read.ts's entity-enrichment branch now gates on
 * ensureGraphReadyBounded() instead of the unbounded ensureGraphReady() — a
 * cold/not-yet-ready graph (or an unresolvable entity) must fall through to
 * the raw file read rather than stall the tool call. Exercises that fallback
 * end-to-end through ReadTool, mirroring read.test.ts's harness conventions.
 */
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LSP } from "@/lsp/lsp"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { SessionID, MessageID } from "../../src/session/schema"
import { Instruction } from "../../src/session/instruction"
import { ReadTool } from "../../src/tool/read"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_readgraphgate"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const readLayer = Layer.mergeAll(
  Agent.defaultLayer,
  FSUtil.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  Instruction.defaultLayer,
  LSP.defaultLayer,
  Ripgrep.defaultLayer,
  Truncate.defaultLayer,
)

const it = testEffect(Layer.mergeAll(readLayer, testInstanceStoreLayer))

const run = Effect.fn("ReadEntityGateTest.run")(function* (args: Tool.InferParameters<typeof ReadTool>) {
  const info = yield* ReadTool
  const tool = yield* info.init()
  return yield* tool.execute(args, ctx)
})

const exec = Effect.fn("ReadEntityGateTest.exec")(function* (dir: string, args: Tool.InferParameters<typeof ReadTool>) {
  return yield* provideInstance(dir)(run(args))
})

describe("read tool — entity path falls back through the bounded readiness gate", () => {
  it.live(
    "returns the raw file (not an entity profile) for an unresolvable entity, and never hangs",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true })
        const filePath = path.join(dir, "sample.ts")
        yield* Effect.promise(() => Bun.write(filePath, "export function sampleFn() { return 1 }\n"))

        const started = Date.now()
        const result = yield* exec(dir, { filePath, entity: "definitelyNotAKnownEntityXyz123" })
        const elapsedMs = Date.now() - started

        expect(result.output).toContain("export function sampleFn")
        expect(elapsedMs).toBeLessThan(20_000)
      }),
    25_000,
  )
})
