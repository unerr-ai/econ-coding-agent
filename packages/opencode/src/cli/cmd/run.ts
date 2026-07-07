import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { FSUtil } from "@opencode-ai/core/fs-util"
// CLI entry point for `opencode run` and `opencode --mini`.
//
// Handles three modes:
//   1. Non-interactive (default): sends a single prompt, streams events to
//      stdout, and exits when the session goes idle.
//   2. Interactive local (`opencode --mini`): boots the split-footer direct mode
//      with an in-process server (no external HTTP).
//   3. Interactive attach (`opencode --mini --attach`): connects to a running
//      opencode server and runs interactive mode against it.
//
// Also supports `--command` for slash-command execution, `--format json` for
// raw event streaming, `--continue` / `--session` for session resumption,
// and `--fork` for forking before continuing.
import type { Argv } from "yargs"
import path from "path"
import { pathToFileURL } from "url"
import { open } from "node:fs/promises"
import { Effect } from "effect"
import { UI } from "../ui"
import { effectCmd } from "../effect-cmd"
import { EOL } from "os"
import { Filesystem } from "@/util/filesystem"
import { createOpencodeClient, type OpencodeClient, type ToolPart } from "@opencode-ai/sdk/v2"
import { FormatError, FormatUnknownError } from "../error"
import { INTERACTIVE_INPUT_ERROR, resolveInteractiveStdin } from "./run/runtime.stdin"
import { econStepCost, econModelLabel, type EconTokens } from "../../../../code-intelligence/src/econ-cost"
import { computeCacheHitRate } from "../../../../code-intelligence/src/cache-meter"
import { TelemetryStore, emitUsageEvent, attributeTier } from "../../../../code-intelligence/src/telemetry"
import { DoublePayLedger } from "../../../../code-intelligence/src/double-pay"
import { buildReceipt, formatReceipt } from "../../../../code-intelligence/src/receipt"

type ModelInput = Parameters<OpencodeClient["session"]["prompt"]>[0]["model"]

function pick(value: string | undefined): ModelInput | undefined {
  if (!value) return undefined
  const [providerID, ...rest] = value.split("/")
  return {
    providerID,
    modelID: rest.join("/"),
  } as ModelInput
}

function resolveRunInput(value?: string, piped?: string): string | undefined {
  if (!value) {
    return piped
  }

  if (!piped) {
    return value
  }

  return value + "\n" + piped
}

type FilePart = {
  type: "file"
  url: string
  filename: string
  mime: string
}

const ATTACH_FILE_MAX_BYTES = 10 * 1024 * 1024

type Inline = {
  icon: string
  title: string
  description?: string
}

type SessionInfo = {
  id: string
  title?: string
  directory?: string
}

function inline(info: Inline) {
  const suffix = info.description ? UI.Style.TEXT_DIM + ` ${info.description}` + UI.Style.TEXT_NORMAL : ""
  UI.println(UI.Style.TEXT_NORMAL + info.icon, UI.Style.TEXT_NORMAL + info.title + suffix)
}

function block(info: Inline, output?: string) {
  UI.empty()
  inline(info)
  if (!output?.trim()) return
  UI.println(output)
  UI.empty()
}

function formatRunError(error: unknown) {
  return FormatError(error) ?? FormatUnknownError(error)
}

async function tool(part: ToolPart) {
  try {
    const { toolInlineInfo } = await import("./run/tool")
    const next = toolInlineInfo(part)
    if (next.mode === "block") {
      block(next, next.body)
      return
    }

    inline(next)
  } catch {
    inline({
      icon: "\u2699",
      title: part.tool,
    })
  }
}

async function toolError(part: ToolPart) {
  try {
    const { toolInlineInfo } = await import("./run/tool")
    const next = toolInlineInfo(part)
    inline({
      icon: "✗",
      title: `${next.title} failed`,
      ...(next.description && { description: next.description }),
    })
    return
  } catch {
    inline({
      icon: "✗",
      title: `${part.tool} failed`,
    })
  }
}

export const RunCommand = effectCmd({
  command: "run [message..]",
  describe: "run opencode with a message",
  // --attach connects to a remote server (no local instance needed); the
  // default path runs an in-process server and needs the project instance.
  instance: (args) => !args.attach,
  // For --dir without --attach, load instance for the resolved target dir.
  // The handler also chdirs (preserving the legacy order: chdir → file resolution).
  directory: (args) => (args.dir && !args.attach ? path.resolve(process.cwd(), args.dir) : process.cwd()),
  builder: (yargs: Argv) =>
    yargs
      .positional("message", {
        describe: "message to send",
        type: "string",
        array: true,
        default: [],
      })
      .option("command", {
        describe: "the command to run, use message for args",
        type: "string",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        describe: "session id to continue",
        type: "string",
      })
      .option("fork", {
        describe: "fork the session before continuing (requires --continue or --session)",
        type: "boolean",
      })
      .option("share", {
        type: "boolean",
        describe: "share the session",
      })
      .option("format", {
        type: "string",
        choices: ["default", "json"],
        default: "default",
        describe: "format: default (formatted) or json (raw JSON events)",
      })
      .option("file", {
        alias: ["f"],
        type: "string",
        array: true,
        describe: "file(s) to attach to message",
      })
      .option("title", {
        type: "string",
        describe: "title for the session (uses truncated prompt if no value provided)",
      })
      .option("attach", {
        type: "string",
        describe: "attach to a running opencode server (e.g., http://localhost:4096)",
      })
      .option("password", {
        alias: ["p"],
        type: "string",
        describe: "basic auth password (defaults to OPENCODE_SERVER_PASSWORD)",
      })
      .option("username", {
        alias: ["u"],
        type: "string",
        describe: "basic auth username (defaults to OPENCODE_SERVER_USERNAME or 'opencode')",
      })
      .option("dir", {
        type: "string",
        describe: "directory to run in, path on remote server if attaching",
      })
      .option("port", {
        type: "number",
        describe: "port for the local server (defaults to random port if no value provided)",
      })
      .option("variant", {
        type: "string",
        describe: "model variant (provider-specific reasoning effort, e.g., high, max, minimal)",
      })
      .option("thinking", {
        type: "boolean",
        describe: "show thinking blocks",
      })
      .option("mini", {
        type: "boolean",
        hidden: true,
        default: false,
      })
      .option("replay", {
        type: "boolean",
        default: true,
        hidden: true,
        describe: "replay interactive session history on resume and after resize (use --no-replay to disable)",
      })
      .option("replay-limit", {
        type: "number",
        hidden: true,
        describe: "cap visible interactive replay to the newest N messages",
      })
      .option("dangerously-skip-permissions", {
        type: "boolean",
        describe: "auto-approve permissions that are not explicitly denied (dangerous!)",
        default: false,
      })
      .option("demo", {
        type: "boolean",
        default: false,
        hidden: true,
        describe: "enable direct interactive demo slash commands; pass one as the message to run it immediately",
      }),
  handler: Effect.fn("Cli.run")(function* (args) {
    const { Agent } = yield* Effect.promise(() => import("@/agent/agent"))
    const { RuntimeFlags } = yield* Effect.promise(() => import("@/effect/runtime-flags"))
    const { InstanceRef } = yield* Effect.promise(() => import("@/effect/instance-ref"))
    const { ServerAuth } = yield* Effect.promise(() => import("@/server/auth"))
    const agentSvc = yield* Agent.Service
    const flags = yield* RuntimeFlags.Service
    const localInstance = yield* InstanceRef
    yield* Effect.promise(async () => {
      const rawMessage = [...args.message, ...(args["--"] || [])].join(" ")
      const interactive = args.mini
      // OL-9.0b headless backstop: permission/index.ts's ask() reads this marker
      // to auto-reject any "ask" instead of parking forever on a Deferred nobody
      // headless will ever resolve. Only the non-interactive `opencode run` path
      // sets it — `--mini` (interactive) leaves it unset so approval prompts are
      // unaffected, and `--dangerously-skip-permissions` leaves it unset too (that
      // flag's own auto-approve loop in the event stream below still owns the root
      // session; this backstop is for the asks nothing else answers). Server +
      // ask() run in this same process, so one process-wide marker covers every
      // session depth (parent, task subagents, future paths).
      if (!interactive && !args["dangerously-skip-permissions"]) process.env["OPENCODE_HEADLESS"] = "1"
      const thinking = interactive ? (args.thinking ?? true) : (args.thinking ?? false)
      const die = (message: string): never => {
        UI.error(message)
        process.exit(1)
      }
      const dieInteractive = (error: unknown): never => {
        if (error instanceof Error && error.message === INTERACTIVE_INPUT_ERROR) {
          die(error.message)
        }

        throw error
      }

      let message = [...args.message, ...(args["--"] || [])]
        .map((arg) => (arg.includes(" ") ? `"${arg.replace(/"/g, '\\"')}"` : arg))
        .join(" ")

      if (interactive && args.command) {
        die("--mini cannot be used with --command")
      }

      if (interactive && args._?.[0] !== "mini") {
        die("--mini must be used without the run subcommand")
      }

      if (args.demo && !interactive) {
        die("--demo requires --mini")
      }

      if (interactive && args.format === "json") {
        die("--mini cannot be used with --format json")
      }

      if (args["replay-limit"] !== undefined && !interactive) {
        die("--replay-limit requires --mini")
      }

      if (
        args["replay-limit"] !== undefined &&
        (!Number.isInteger(args["replay-limit"]) || args["replay-limit"] <= 0)
      ) {
        die("--replay-limit must be a positive integer")
      }

      if (interactive && !process.stdout.isTTY) {
        die("--mini requires a TTY stdout")
      }

      if (interactive) {
        try {
          resolveInteractiveStdin().cleanup?.()
        } catch (error) {
          dieInteractive(error)
        }
      }

      const replay = args.replay === false ? false : args.replay || args["replay-limit"] !== undefined

      const root = Filesystem.resolve(process.env.PWD ?? process.cwd())
      const directory = (() => {
        if (!args.dir) return args.attach ? undefined : root
        if (args.attach) return args.dir

        try {
          process.chdir(path.isAbsolute(args.dir) ? args.dir : path.join(root, args.dir))
          return process.cwd()
        } catch {
          UI.error("Failed to change directory to " + args.dir)
          process.exit(1)
        }
      })()
      const attachHeaders = args.attach
        ? ServerAuth.headers({ password: args.password, username: args.username })
        : undefined
      const attachSDK = (dir?: string) => {
        return createOpencodeClient({
          baseUrl: args.attach!,
          directory: dir,
          headers: attachHeaders,
        })
      }

      const files: FilePart[] = []
      if (args.file) {
        const list = Array.isArray(args.file) ? args.file : [args.file]

        for (const filePath of list) {
          const resolvedPath = path.resolve(args.attach ? root : (directory ?? root), filePath)
          if (!(await Filesystem.exists(resolvedPath))) {
            UI.error(`File not found: ${filePath}`)
            process.exit(1)
          }

          const stat = Filesystem.stat(resolvedPath)
          const isDirectory = stat?.isDirectory() ?? false
          if (args.attach && isDirectory) {
            UI.error(`Cannot attach local directory without a shared filesystem: ${filePath}`)
            process.exit(1)
          }

          const content = await (async () => {
            if (!args.attach) return
            const handle = await open(resolvedPath, "r")
            try {
              const opened = await handle.stat()
              if (!opened.isFile() || Number(opened.size) > ATTACH_FILE_MAX_BYTES) {
                UI.error(`Cannot attach local file larger than 10 MiB or a special file: ${filePath}`)
                process.exit(1)
              }
              if (opened.size === 0) return Buffer.alloc(0)
              const buffer = Buffer.alloc(Number(opened.size))
              let offset = 0
              while (offset < buffer.length) {
                const read = await handle.read(buffer, offset, buffer.length - offset, offset)
                if (read.bytesRead === 0) break
                offset += read.bytesRead
              }
              return buffer.subarray(0, offset)
            } finally {
              await handle.close()
            }
          })()
          const detected = FSUtil.mimeType(resolvedPath)
          const text = content?.toString("utf8")
          const mime = !args.attach
            ? isDirectory
              ? "application/x-directory"
              : "text/plain"
            : content && text !== undefined && Buffer.from(text, "utf8").equals(content)
              ? "text/plain"
              : detected

          files.push({
            type: "file",
            url: content ? `data:${mime};base64,${content.toString("base64")}` : pathToFileURL(resolvedPath).href,
            filename: path.basename(resolvedPath),
            mime,
          })
        }
      }

      const piped = process.stdin.isTTY ? undefined : await Bun.stdin.text()
      message = resolveRunInput(message, piped) ?? ""
      const initialInput = resolveRunInput(rawMessage, piped)

      if (message.trim().length === 0 && !args.command && !interactive) {
        UI.error("You must provide a message or a command")
        process.exit(1)
      }

      if (args.fork && !args.continue && !args.session) {
        UI.error("--fork requires --continue or --session")
        process.exit(1)
      }

      const rules: PermissionV1.Ruleset = interactive
        ? []
        : [
            {
              permission: "question",
              action: "deny",
              pattern: "*",
            },
            {
              permission: "plan_enter",
              action: "deny",
              pattern: "*",
            },
            {
              permission: "plan_exit",
              action: "deny",
              pattern: "*",
            },
          ]

      function title() {
        if (args.title === undefined) return
        if (args.title !== "") return args.title
        return message.slice(0, 50) + (message.length > 50 ? "..." : "")
      }

      async function session(sdk: OpencodeClient): Promise<SessionInfo | undefined> {
        if (args.session) {
          const current = await sdk.session
            .get({
              sessionID: args.session,
            })
            .catch(() => undefined)

          if (!current?.data) {
            UI.error("Session not found")
            process.exit(1)
          }

          if (args.fork) {
            const forked = await sdk.session.fork({
              sessionID: args.session,
            })
            const id = forked.data?.id
            if (!id) {
              return
            }

            return {
              id,
              title: forked.data?.title ?? current.data.title,
              directory: forked.data?.directory ?? current.data.directory,
            }
          }

          return {
            id: current.data.id,
            title: current.data.title,
            directory: current.data.directory,
          }
        }

        const base = args.continue ? (await sdk.session.list()).data?.find((item) => !item.parentID) : undefined

        if (base && args.fork) {
          const forked = await sdk.session.fork({
            sessionID: base.id,
          })
          const id = forked.data?.id
          if (!id) {
            return
          }

          return {
            id,
            title: forked.data?.title ?? base.title,
            directory: forked.data?.directory ?? base.directory,
          }
        }

        if (base) {
          return {
            id: base.id,
            title: base.title,
            directory: base.directory,
          }
        }

        const name = title()
        const result = await sdk.session.create({
          title: name,
          permission: [...rules],
        })
        const id = result.data?.id
        if (!id) {
          return
        }

        return {
          id,
          title: result.data?.title ?? name,
          directory: result.data?.directory,
        }
      }

      async function share(sdk: OpencodeClient, sessionID: string) {
        const cfg = await sdk.config.get()
        if (!cfg.data) return
        if (cfg.data.share !== "auto" && !flags.autoShare && !args.share) return
        const res = await sdk.session.share({ sessionID }).catch((error) => {
          if (error instanceof Error && error.message.includes("disabled")) {
            UI.println(UI.Style.TEXT_DANGER_BOLD + "!  " + error.message)
          }
          return { error }
        })
        if (!res.error && "data" in res && res.data?.share?.url) {
          UI.println(UI.Style.TEXT_INFO_BOLD + "~  " + res.data.share.url)
        }
      }

      async function createFreshSession(
        sdk: OpencodeClient,
        input: { agent: string | undefined; model: ModelInput | undefined; variant: string | undefined },
      ): Promise<SessionInfo> {
        const result = await sdk.session.create({
          title: args.title !== undefined && args.title !== "" ? args.title : undefined,
          agent: input.agent,
          model: input.model
            ? {
                providerID: input.model.providerID,
                id: input.model.modelID,
                variant: input.variant,
              }
            : undefined,
          permission: [...rules],
        })
        const id = result.data?.id
        if (!id) {
          throw new Error("Failed to create session")
        }

        void share(sdk, id).catch(() => {})
        return {
          id,
          title: result.data?.title,
        }
      }

      async function current(sdk: OpencodeClient): Promise<string> {
        if (!args.attach) {
          return directory ?? root
        }

        const next = await sdk.path
          .get()
          .then((x) => x.data?.directory)
          .catch(() => undefined)
        if (next) {
          return next
        }

        UI.error("Failed to resolve remote directory")
        process.exit(1)
      }

      // OL-4.1: --agent/--model are no longer user-settable CLI flags — econ picks
      // agent/model internally (config default lead + slice-level allocation), so
      // these resolvers always defer to the default (undefined).
      async function localAgent() {
        return undefined
      }

      async function pickAgent(_sdk: OpencodeClient) {
        return localAgent()
      }

      async function execute(sdk: OpencodeClient) {
        const sess = await session(sdk)
        if (!sess?.id) {
          UI.error("Session not found")
          process.exit(1)
        }
        const sessionID = sess.id

        function emit(type: string, data: Record<string, unknown>) {
          if (args.format === "json") {
            process.stdout.write(
              JSON.stringify({
                type,
                timestamp: Date.now(),
                sessionID,
                ...data,
              }) + EOL,
            )
            return true
          }
          return false
        }

        // Consume one subscribed event stream for the active session and mirror it
        // to stdout/UI. `client` is passed explicitly because attach mode may
        // rebind the SDK to the session's directory after the subscription is
        // created, and replies issued from inside the loop must use that client.
        async function loop(client: OpencodeClient, events: Awaited<ReturnType<typeof sdk.event.subscribe>>) {
          const toggles = new Map<string, boolean>()
          // Latest tokens/model seen per assistant messageID, econ's own per-model
          // breakdown alongside upstream step_finish events (which carry no model id).
          const messageModels = new Map<
            string,
            { providerID: string; modelID: string; tokens: EconTokens; agent?: string }
          >()
          // Tool-call ids seen per assistant messageID, deduped (a part can update
          // more than once) — folded into the usage receipt's per-model toolCalls.
          const toolParts = new Map<string, Set<string>>()
          // OL-0.1: turn-phase telemetry state (turn_phase events below) — a step
          // counter and the last-seen agent, both derived from events already on
          // this stream, so no new server-side event type is needed.
          let turnStep = 0
          let lastAgent: string | undefined
          let error: string | undefined
          // OL-9.6b: track the last assistant finish reason so a run that ends
          // on an output-cap truncation (finish=length) is reported honestly —
          // run 9 exited 0 with a success receipt after a truncated turn.
          let lastAssistantFinish: string | undefined
          // OL-3.6: cheap-tier spend discarded when a turn escalates and has to
          // be re-run on a higher tier (double-pay). The current router only
          // escalates at turn-open (no intra-turn re-run), so nothing on this
          // stream increments it yet — it stays 0 until a later slice (QE veto
          // / abstention re-run) emits an escalation this loop can fold in
          // here. Wired now so cost_breakdown's net figure needs no second
          // migration when that lands.
          let discarded = 0

          // econ visibility — live streaming. The Fireworks reasoning models put
          // their substance in reasoning_content + tool_calls and leave visible
          // `content` near-empty, so painting text/reasoning only at part.time.end
          // left the terminal on the agent header for many seconds while tokens
          // were actively flowing. streamedLen tracks how much of each part is
          // already on screen so message.part.updated can paint just the delta.
          const streamedLen = new Map<string, number>()
          let openStream: { id: string; kind: "text" | "reasoning" } | undefined
          function streamDelta(id: string, kind: "text" | "reasoning", full: string) {
            const shown = streamedLen.get(id) ?? 0
            if (full.length <= shown) return
            if (openStream && openStream.id !== id) streamFlush()
            if (!openStream) {
              UI.empty()
              if (kind === "reasoning" && process.stdout.isTTY)
                process.stdout.write(`${UI.Style.TEXT_DIM}[3m`)
              openStream = { id, kind }
            }
            process.stdout.write(full.slice(shown))
            streamedLen.set(id, full.length)
          }
          function streamFlush() {
            if (!openStream) return
            if (openStream.kind === "reasoning" && process.stdout.isTTY)
              process.stdout.write(`[0m${UI.Style.TEXT_NORMAL}`)
            process.stdout.write(EOL)
            openStream = undefined
          }

          // econ visibility — slice progress. Decomposition runs each slice in a
          // CHILD session whose parts are dropped by the sessionID guard below, so
          // the long orchestration looked frozen. Track this turn's child sessions
          // and surface each child tool call as one condensed dim line for motion.
          const childSessions = new Set<string>()
          const childToolSeen = new Set<string>()
          function sliceProgress(part: { type: string; id: string; tool?: string; state?: { status?: string; input?: unknown } }) {
            if (part.type !== "tool") return
            const status = part.state?.status
            if (status !== "running" && status !== "completed") return
            if (childToolSeen.has(part.id)) return
            childToolSeen.add(part.id)
            const input = (part.state?.input ?? {}) as Record<string, unknown>
            const raw = input["filePath"] ?? input["path"] ?? input["command"] ?? input["pattern"] ?? ""
            const short = String(raw).split("/").slice(-2).join("/").slice(0, 60)
            streamFlush()
            UI.println(`${UI.Style.TEXT_DIM}  ↳ slice · ${part.tool ?? "?"}${short ? " " + short : ""}${UI.Style.TEXT_NORMAL}`)
          }

          for await (const event of events.stream) {
            if (
              (event.type === "session.created" || event.type === "session.updated") &&
              "info" in event.properties &&
              (event.properties.info as { parentID?: string }).parentID === sessionID
            ) {
              childSessions.add((event.properties.info as { id: string }).id)
            }

            if (event.type === "message.updated" && event.properties.info.role === "assistant") {
              const info = event.properties.info
              const isRoot = event.properties.sessionID === sessionID
              // #51: the receipt covers the WHOLE turn — child slice sessions bill real
              // tokens on their own tiers (run-21: root-only $0.28 vs $1.84 with slices),
              // so their assistant messages join the same per-model fold as the root's.
              if (isRoot || childSessions.has(event.properties.sessionID)) {
                messageModels.set(info.id, {
                  providerID: info.providerID,
                  modelID: info.modelID,
                  tokens: info.tokens,
                  agent: info.agent,
                })
              }
              if (!isRoot) continue
              lastAssistantFinish = (info as { finish?: string }).finish ?? lastAssistantFinish

              if (args.format !== "json" && toggles.get("start") !== true) {
                UI.empty()
                UI.println(`> ${info.agent} · ${info.modelID}`)
                UI.empty()
                toggles.set("start", true)
              }
            }

            // OL-0.1: agent tier switches already publish this event (see
            // createUserMessage in session/prompt.ts) — surface it as a turn_phase
            // "switch" instead of adding a second signal for the same fact. Only a
            // real switch (a prior agent on this stream) is a "switch" — the first
            // agent assignment on a fresh session isn't one.
            if (event.type === "session.next.agent.switched" && event.properties.sessionID === sessionID) {
              const toAgent = event.properties.agent
              if (lastAgent !== undefined && lastAgent !== toAgent) {
                emit("turn_phase", {
                  phase: "switch",
                  step: turnStep,
                  fromAgent: lastAgent,
                  toAgent,
                })
              }
              lastAgent = toAgent
            }

            if (event.type === "message.part.updated") {
              const part = event.properties.part
              if (part.sessionID !== sessionID) {
                if (childSessions.has(part.sessionID)) {
                  // #51: fold child tool calls into the receipt's per-model toolCalls
                  // (their messageIDs are in messageModels via the child fold above).
                  if (part.type === "tool" && (part.state.status === "completed" || part.state.status === "error")) {
                    const seen = toolParts.get(part.messageID) ?? new Set<string>()
                    seen.add(part.id)
                    toolParts.set(part.messageID, seen)
                  }
                  // Surface child tool activity as condensed progress on the parent
                  // view instead of dropping it silently.
                  if (args.format !== "json") sliceProgress(part)
                }
                continue
              }

              if (part.type === "tool" && part.tool === "task" && part.state.status === "completed") {
                // No dedicated "verify" tool — same text-field heuristic as
                // packages/eval/src/loop-scorer.ts calledVerifyTask.
                const fields = Object.values(part.state.input ?? {}).filter((v): v is string => typeof v === "string")
                const isVerify = fields.some((v) => /verify|typecheck|test/i.test(v))
                const known = messageModels.get(part.messageID)
                emit("turn_phase", {
                  phase: isVerify ? "verify" : "delegate",
                  step: turnStep,
                  agent: known?.agent,
                  model: known?.modelID,
                  tool: part.tool,
                })
              }

              if (part.type === "tool" && (part.state.status === "completed" || part.state.status === "error")) {
                streamFlush() // close any open live stream before block/inline tool UI
                const seen = toolParts.get(part.messageID) ?? new Set<string>()
                seen.add(part.id)
                toolParts.set(part.messageID, seen)
                if (emit("tool_use", { part })) continue
                if (part.state.status === "completed") {
                  await tool(part)
                  continue
                }
                await toolError(part)
                UI.error(part.state.error)
              }

              if (
                part.type === "tool" &&
                part.tool === "task" &&
                part.state.status === "running" &&
                args.format !== "json"
              ) {
                if (toggles.get(part.id) === true) continue
                await tool(part)
                toggles.set(part.id, true)
              }

              if (part.type === "step-start") {
                streamFlush() // close any open live stream at a step boundary
                // A step only exists once the model call actually starts, so
                // gating turn_phase here (not on message.updated) keeps a request
                // that errors before any step runs (e.g. an unresolvable model)
                // from emitting a phase the turn never reached.
                turnStep++
                const known = messageModels.get(part.messageID)
                emit("turn_phase", {
                  phase: turnStep === 1 ? "plan" : "execute",
                  step: turnStep,
                  agent: known?.agent,
                  model: known?.modelID,
                })
                if (emit("step_start", { part })) continue
              }

              if (part.type === "step-finish") {
                const model = messageModels.get(part.messageID)
                const enriched = model
                  ? {
                      providerID: model.providerID,
                      modelID: model.modelID,
                      econCost: econStepCost({
                        modelID: model.modelID,
                        providerID: model.providerID,
                        tokens: part.tokens,
                      }),
                    }
                  : {}
                if (emit("step_finish", { part, ...enriched })) continue
              }

              if (part.type === "text") {
                // json: one structured event per completed part (contract unchanged).
                if (args.format === "json") {
                  if (part.time?.end) emit("text", { part })
                  continue
                }
                // human: paint the delta live so the answer appears as it is written
                // rather than in one burst at part completion. Wait for the first
                // non-whitespace before opening (these models emit "\n\n" content).
                if (part.text.trim()) streamDelta(part.id, "text", part.text)
                if (part.time?.end) streamFlush()
                continue
              }

              if (part.type === "reasoning") {
                if (args.format === "json") {
                  if (part.time?.end) emit("reasoning", { part })
                  continue
                }
                // human: stream reasoning live (dim) — the reasoning models front-load
                // a long reasoning phase, so this is what turns the frozen agent header
                // into visible motion. Gated by --thinking (interactive default: on).
                if (!thinking) continue
                streamDelta(part.id, "reasoning", part.text)
                if (part.time?.end) streamFlush()
                continue
              }

              if (false) {
                const line = ``
                if (process.stdout.isTTY) {
                  UI.empty()
                  UI.println(`${UI.Style.TEXT_DIM}\u001b[3m${line}\u001b[0m${UI.Style.TEXT_NORMAL}`)
                  UI.empty()
                  continue
                }
                process.stdout.write(line + EOL)
              }
            }

            if (event.type === "session.error") {
              streamFlush() // close any open live stream before the error prints
              const props = event.properties
              if (props.sessionID !== sessionID || !props.error) continue
              let err = String(props.error.name)
              if ("data" in props.error && props.error.data && "message" in props.error.data) {
                err = String(props.error.data.message)
              }
              error = error ? error + EOL + err : err
              if (emit("error", { error: props.error })) continue
              UI.error(err)
            }

            if (
              event.type === "session.status" &&
              event.properties.sessionID === sessionID &&
              event.properties.status.type === "idle"
            ) {
              streamFlush() // close any open live stream before the receipt prints
              break
            }

            if (event.type === "permission.asked") {
              const permission = event.properties
              if (permission.sessionID !== sessionID) continue

              if (args["dangerously-skip-permissions"]) {
                await client.permission.reply({
                  requestID: permission.id,
                  reply: "once",
                })
              } else {
                UI.println(
                  UI.Style.TEXT_WARNING_BOLD + "!",
                  UI.Style.TEXT_NORMAL +
                    `permission requested: ${permission.permission} (${permission.patterns.join(", ")}); auto-rejecting`,
                )
                await client.permission.reply({
                  requestID: permission.id,
                  reply: "reject",
                })
              }
            }
          }

          // OL-9.6b: the loop above breaks on idle regardless of WHY the session
          // stopped. If the final assistant message ended on finish=length the
          // answer was cut off by the output cap (continuations exhausted) —
          // surface it and fail the run instead of printing a success receipt.
          if (lastAssistantFinish === "length") {
            const msg =
              "run ended on an output-cap truncation (finish=length): the final response was cut off and the task may be incomplete"
            error = error ? error + EOL + msg : msg
            if (!emit("error", { error: { name: "TruncatedResponse", data: { message: msg } } })) UI.error(msg)
          }

          if (messageModels.size > 0) {
            const zeroTokens = (): EconTokens => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
            const addTokens = (target: EconTokens, tokens: EconTokens) => {
              target.input += tokens.input
              target.output += tokens.output
              target.reasoning += tokens.reasoning
              target.cache.read += tokens.cache.read
              target.cache.write += tokens.cache.write
            }

            const models: Record<
              string,
              { label: string; tokens: EconTokens; cost: number; cacheHitRate: number; toolCalls: number }
            > = {}
            const cumulative = { tokens: zeroTokens(), cost: 0, toolCalls: 0 }
            // Mirror the per-model buckets into a TelemetryStore as we go, so
            // the human-readable path can render the real usage receipt
            // (buildReceipt/formatReceipt) without a second pass over
            // messageModels.
            const telemetryStore = new TelemetryStore()
            for (const [messageID, { modelID, providerID, tokens, agent }] of messageModels.entries()) {
              const cost = econStepCost({ modelID, providerID, tokens })
              const toolCalls = toolParts.get(messageID)?.size ?? 0
              const bucket =
                models[modelID] ??
                { label: econModelLabel(modelID), tokens: zeroTokens(), cost: 0, cacheHitRate: 0, toolCalls: 0 }
              addTokens(bucket.tokens, tokens)
              bucket.cost += cost
              bucket.toolCalls += toolCalls
              models[modelID] = bucket
              addTokens(cumulative.tokens, tokens)
              cumulative.cost += cost
              cumulative.toolCalls += toolCalls
              // Tier attribution is model-id-first (billing follows the model); the agent name
              // only disambiguates a multi-tier model or an unknown model id — an agent whose
              // name claims one tier while running another tier's model must not relabel spend.
              emitUsageEvent(telemetryStore, {
                sessionID,
                model: modelID,
                tier: attributeTier(modelID, agent),
                cost,
                toolCalls,
                tokens: {
                  input: tokens.input,
                  output: tokens.output,
                  reasoning: tokens.reasoning,
                  cache: { read: tokens.cache.read, write: tokens.cache.write },
                },
              })
            }
            // OL-3.7: oracle cache-hit-rate — the one cost lever on a tier whose
            // per-token price can't be shopped down, so compute it for every
            // tier (not just the oracle) once each bucket's tokens are final.
            for (const bucket of Object.values(models)) {
              bucket.cacheHitRate = computeCacheHitRate({
                cacheRead: bucket.tokens.cache.read,
                input: bucket.tokens.input,
                cacheWrite: bucket.tokens.cache.write,
              })
            }
            // OL-3.6: net = cumulative spend minus cheap-tier spend discarded by
            // mid-turn escalations (`discarded`, 0 today — see declaration above).
            const net = cumulative.cost - discarded

            if (!emit("cost_breakdown", { cumulative, models, tiers: telemetryStore.totals().byTier, discarded, net })) {
              // The machine-readable `cost_breakdown` NDJSON event above is
              // unchanged (--format json never reaches this branch); only the
              // human-readable surface below renders the formatted usage
              // receipt (overall + per-tier drilldown).
              const ledger = new DoublePayLedger()
              const receipt = buildReceipt({ store: telemetryStore, ledger })
              UI.empty()
              for (const line of formatReceipt(receipt).split("\n")) {
                UI.println(UI.Style.TEXT_DIM + line + UI.Style.TEXT_NORMAL)
              }
              UI.empty()
            }
          }

          return error
        }
        const cwd = args.attach ? (directory ?? sess.directory ?? (await current(sdk))) : (directory ?? root)
        const client = args.attach ? attachSDK(cwd) : sdk

        // Validate agent if specified
        const agent = await pickAgent(client)

        await share(client, sessionID)

        if (!interactive) {
          const events = await client.event.subscribe()
          const completed = loop(client, events).catch((e) => {
            console.error(e)
            process.exitCode = 1
          })
          async function finish() {
            if (args.attach) return
            const error = await completed
            if (error) process.exitCode = 1
          }

          if (args.command) {
            const result = await client.session.command({
              sessionID,
              agent,
              // OL-4.1: no user-facing --model flag; router auto-selects.
              model: undefined,
              command: args.command,
              arguments: message,
              variant: args.variant,
            })
            if (result.error) {
              if (!emit("error", { error: result.error })) UI.error(formatRunError(result.error))
              process.exitCode = 1
              return
            }
            await finish()
            return
          }

          // OL-4.1: no user-facing --model flag; router auto-selects.
          const model = pick(undefined)
          const result = await client.session.prompt({
            sessionID,
            agent,
            model,
            variant: args.variant,
            parts: [...files, { type: "text", text: message }],
          })
          if (result.error) {
            if (!emit("error", { error: result.error })) UI.error(formatRunError(result.error))
            process.exitCode = 1
            return
          }
          await finish()
          return
        }

        // OL-4.1: no user-facing --model flag; router auto-selects.
        const model = pick(undefined)
        const { runInteractiveMode } = await import("./run/runtime")
        try {
          await runInteractiveMode({
            sdk: client,
            directory: cwd,
            sessionID,
            sessionTitle: sess.title,
            resume: Boolean(args.session || args.continue) && !args.fork,
            replay,
            replayLimit: args["replay-limit"],
            agent,
            model,
            variant: args.variant,
            files,
            initialInput,
            createSession: createFreshSession,
            thinking,
            backgroundSubagents: flags.experimentalBackgroundSubagents,
            demo: args.demo,
          })
        } catch (error) {
          dieInteractive(error)
        }
        return
      }

      if (interactive && !args.attach && !args.session && !args.continue) {
        // OL-4.1: no user-facing --model flag; router auto-selects.
        const model = pick(undefined)
        const { runInteractiveLocalMode } = await import("./run/runtime")
        const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const { Server } = await import("@/server/server")
          const request = new Request(input, init)
          const headers = new Headers(request.headers)
          const auth = ServerAuth.header()
          if (auth) headers.set("Authorization", auth)
          return Server.Default().app.fetch(new Request(request, { headers }))
        }) as typeof globalThis.fetch

        try {
          return await runInteractiveLocalMode({
            directory: directory ?? root,
            fetch: fetchFn,
            resolveAgent: localAgent,
            session,
            share,
            createSession: createFreshSession,
            // OL-4.1: no user-facing --agent flag; router auto-selects.
            agent: undefined,
            model,
            variant: args.variant,
            replay,
            replayLimit: args["replay-limit"],
            files,
            initialInput,
            thinking,
            backgroundSubagents: flags.experimentalBackgroundSubagents,
            demo: args.demo,
          })
        } catch (error) {
          dieInteractive(error)
        }
      }

      if (args.attach) {
        const sdk = attachSDK(directory)
        return await execute(sdk)
      }

      const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const { Server } = await import("@/server/server")
        const request = new Request(input, init)
        const headers = new Headers(request.headers)
        const auth = ServerAuth.header()
        if (auth) headers.set("Authorization", auth)
        return Server.Default().app.fetch(new Request(request, { headers }))
      }) as typeof globalThis.fetch
      const sdk = createOpencodeClient({
        baseUrl: "http://opencode.internal",
        fetch: fetchFn,
        directory,
      })
      await execute(sdk)
    })
  }),
})

type MiniCommandInput = {
  directory?: string
  attach?: string
  password?: string
  username?: string
  continue?: boolean
  session?: string
  fork?: boolean
  model?: string
  agent?: string
  prompt?: string
  replay?: boolean
  replayLimit?: number
  demo?: boolean
}

export async function runMini(input: MiniCommandInput) {
  if (!RunCommand.handler) throw new Error("Mini command handler is unavailable")
  await RunCommand.handler({
    $0: "opencode",
    _: ["mini"],
    message: input.prompt ? [input.prompt] : [],
    command: undefined,
    continue: input.continue,
    session: input.session,
    fork: input.fork,
    share: undefined,
    // OL-4.1: RunCommand no longer accepts a user-facing model/agent — the
    // router auto-selects; MiniCommandInput.model/agent are kept for source
    // compatibility with internal callers but are no longer forwarded here.
    format: "default",
    file: undefined,
    title: undefined,
    attach: input.attach,
    password: input.password,
    username: input.username,
    dir: input.directory,
    port: undefined,
    variant: undefined,
    thinking: undefined,
    mini: true,
    replay: input.replay ?? true,
    "replay-limit": input.replayLimit,
    replayLimit: input.replayLimit,
    "dangerously-skip-permissions": false,
    dangerouslySkipPermissions: false,
    demo: input.demo ?? false,
  })
}
