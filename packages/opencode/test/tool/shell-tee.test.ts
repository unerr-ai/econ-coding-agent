import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Config } from "@/config/config"
import { Shell } from "@opencode-ai/core/shell"
import { ShellTool } from "../../src/tool/shell"
import { provideInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Plugin } from "../../src/plugin"
import { testEffect } from "../lib/effect"
import { Tool } from "@/tool/tool"
import { RuntimeFlags } from "@/effect/runtime-flags"

const shellLayer = Layer.mergeAll(
  CrossSpawnSpawner.defaultLayer,
  FSUtil.defaultLayer,
  Plugin.defaultLayer,
  Truncate.defaultLayer,
  Config.defaultLayer,
  Agent.defaultLayer,
  RuntimeFlags.defaultLayer,
  testInstanceStoreLayer,
)
const it = testEffect(shellLayer)

const initShell = Effect.fn("ShellTeeTest.init")(function* () {
  const info = yield* ShellTool
  return yield* info.init()
})

const run = Effect.fn("ShellTeeTest.run")(function* (args: Tool.InferParameters<typeof ShellTool>) {
  const bash = yield* initShell()
  return yield* bash.execute(args, ctx)
})

const runIn = <A, E, R>(directory: string, self: Effect.Effect<A, E, R>) => self.pipe(provideInstance(directory))

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

Shell.acceptable.reset()
const quote = (text: string) => `"${text}"`
const squote = (text: string) => `'${text}'`
const projectRoot = path.join(__dirname, "../..")
const bin = quote(process.execPath.replaceAll("\\", "/"))
const PS = new Set(["pwsh", "powershell"])
const sh = () => Shell.name(Shell.acceptable())
const evalarg = (text: string) => (sh() === "cmd" ? quote(text) : squote(text))

// Highly repetitive, non-tabular/non-log-shaped content: three distinct patterns cycled
// many times over. Not recognized by any command-name or content-heuristic classifier, so
// it lands in the low-confidence branch and gets deduped hard by the omni fallback (>=30%
// of tokens dropped) while staying comfortably under the truncation line/byte caps.
const duplicateOutput = (lines: number) => {
  const code =
    'console.log(Array.from({length:Number(Bun.argv[1])},(_,i)=>["alpha","beta","gamma"][i%3]+" repeated line padded to reach a decent size 1234567890").join(String.fromCharCode(10)))'
  const text = `${bin} -e ${evalarg(code)} ${lines}`
  if (PS.has(sh())) return `& ${text}`
  return text
}

describe("tool.shell raw-output recovery (tee)", () => {
  it.live("saves the full raw output and points at the file when compression is lossy", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        // 300 lines * ~70 bytes >> 1KB, well under Truncate.MAX_LINES/MAX_BYTES so the
        // existing truncation safety net does not fire on its own.
        const result = yield* run({
          command: duplicateOutput(300),
        })
        expect(result.metadata.exit).toBe(0)
        expect((result.metadata as { truncated?: boolean }).truncated).toBe(false)

        expect(result.output).toMatch(/\[output compressed — full output: \S+\]/)
        expect(result.output).not.toMatch(/\.\.\.output truncated\.\.\./)

        const filepath = (result.metadata as { outputPath?: string }).outputPath
        expect(filepath).toBeTruthy()

        const saved = yield* (yield* FSUtil.Service).readFileString(filepath!)
        const lines = saved.trim().split(/\r?\n/)
        expect(lines.length).toBe(300)
        expect(lines[0]).toBe("alpha repeated line padded to reach a decent size 1234567890")
        expect(lines[299]).toBe("gamma repeated line padded to reach a decent size 1234567890")
      }),
    ),
  )

  it.live("does not append a file line for small, uncompressed output", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const result = yield* run({
          command: "echo hi",
        })
        expect(result.metadata.exit).toBe(0)
        expect((result.metadata as { truncated?: boolean }).truncated).toBe(false)
        expect((result.metadata as { outputPath?: string }).outputPath).toBeUndefined()
        expect(result.output).not.toMatch(/\[output compressed/)
        expect(result.output).not.toMatch(/\.\.\.output truncated\.\.\./)
      }),
    ),
  )
})
