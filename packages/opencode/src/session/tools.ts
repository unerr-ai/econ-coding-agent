import { Agent } from "@/agent/agent"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Tool } from "@/tool/tool"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Token } from "@/util/token"

import { Plugin } from "@/plugin"
import type { TaskPromptOps } from "@/tool/task"
import { claimNudge, standaloneTodowriteSuffix } from "@/tool/todowrite-nudge"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions, asSchema } from "ai"
import { Effect, Option } from "effect"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import { SessionProcessor } from "./processor"
import { PartID } from "./schema"
import { EffectBridge } from "@/effect/bridge"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { isRecord } from "@/util/record"
import { dropReadDedup } from "@/tool/_shared/read-dedup"

const LIST_MCP_RESOURCES_TOOL = "list_mcp_resources"
const READ_MCP_RESOURCE_TOOL = "read_mcp_resource"
const MAX_MCP_RESOURCE_BLOB_BYTES = 10 * 1024 * 1024
const SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])

export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {
  agent: Agent.Info
  model: Provider.Model
  session: Session.Info
  processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
  bypassAgentCheck: boolean
  messages: SessionV1.WithParts[]
  promptOps: TaskPromptOps
}) {
  const tools: Record<string, AITool> = {}
  const run = yield* EffectBridge.make()
  const plugin = yield* Plugin.Service
  const permission = yield* Permission.Service
  const registry = yield* ToolRegistry.Service
  const mcp = yield* MCP.Service
  const truncate = yield* Truncate.Service

  // Best-effort: decorates the next tool call of any kind (not specifically
  // the next todowrite — flips alternate with work steps, so a
  // todowrite-only trigger never fires) when the session's previous
  // assistant step was a standalone todowrite. Never decorates todowrite
  // itself (flipping again isn't the fix) or task (child digests stay
  // pristine); the once-guard claim keeps parallel tool calls in one step to
  // exactly one decorated output. Session.Service is resolved inside this
  // nested generator (run only via the `run.promise` bridge below), not at
  // `resolve`'s own top level — hoisting it there would add Session.Service
  // to `resolve`'s inferred requirements, which breaks callers pinned to
  // `Effect.Effect<..., never>` (e.g. SessionPrompt.run's runLoop).
  const nudgeStandaloneTodowrite = <T extends Tool.ExecuteResult>(toolID: string, ctx: Tool.Context, output: T) =>
    Effect.gen(function* () {
      if (toolID === "todowrite" || toolID === "task") return output
      const sessions = yield* Session.Service
      const prior = yield* sessions.findMessage(
        ctx.sessionID,
        (msg) => msg.info.role === "assistant" && msg.info.id < ctx.messageID,
      )
      if (Option.isNone(prior)) return output
      const suffix = standaloneTodowriteSuffix(prior.value.parts)
      if (!suffix) return output
      if (!claimNudge(ctx.sessionID, prior.value.info.id)) return output
      return { ...output, output: `${output.output}${suffix}` }
    }).pipe(Effect.catch(() => Effect.succeed(output)))

  const context = (args: Record<string, unknown>, options: ToolExecutionOptions): Tool.Context => ({
    sessionID: input.session.id,
    abort: options.abortSignal!,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck, promptOps: input.promptOps },
    agent: input.agent.name,
    messages: input.messages,
    metadata: (val) =>
      input.processor.updateToolCall(options.toolCallId, (match) => {
        if (!["running", "pending"].includes(match.state.status)) return match
        return {
          ...match,
          state: {
            title: val.title,
            metadata: val.metadata,
            status: "running",
            input: args,
            time: { start: Date.now() },
          },
        }
      }),
    ask: (req) =>
      permission
        .ask({
          ...req,
          sessionID: input.session.id,
          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
          ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
        })
        .pipe(Effect.orDie),
  })

  for (const item of yield* registry.tools({
    modelID: ModelV2.ID.make(input.model.api.id),
    providerID: input.model.providerID,
    agent: input.agent,
  })) {
    const schema = ProviderTransform.schema(input.model, ToolJsonSchema.fromTool(item))
    tools[item.id] = tool({
      description: item.description,
      inputSchema: jsonSchema(schema),
      execute(args, options) {
        return run.promise(
          Effect.gen(function* () {
            const ctx = context(args, options)
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
              { args },
            )
            // L3.1 green-test memo (see the memo block below): a repeat of an
            // already-green test command short-circuits to a stub; on a miss,
            // mutating tools/commands drop the session memo before running.
            const memoStub = greenMemoBefore({ toolID: item.id, sessionID: ctx.sessionID, args })
            const result = memoStub ?? (yield* item.execute(args, ctx))
            if (!memoStub)
              greenMemoAfter({ toolID: item.id, sessionID: ctx.sessionID, messageID: ctx.messageID, args, result })
            const output = {
              ...result,
              attachments: result.attachments?.map((attachment) => ({
                ...attachment,
                id: PartID.ascending(),
                sessionID: ctx.sessionID,
                messageID: input.processor.message.id,
              })),
            }
            const nudged = yield* nudgeStandaloneTodowrite(item.id, ctx, output)
            const decorated = withStepBudget(item.id, ctx, nudged)
            // L3.2 guard (docs/design/turn-cache-economics.md §5-L3 item 2): if the
            // ceiling/step budget above cut a read result, the read-dedup memo's
            // just-recorded range no longer matches what the model actually saw —
            // drop the file's ranges so the next identical read re-delivers instead
            // of stubbing toward truncated data. metadata.display.path is the
            // resolved path read.ts keyed the memo with (the raw filePath arg may
            // be relative); only the raw-content read path carries it, and only
            // that path records ranges.
            if (item.id === "read" && decorated.output !== nudged.output) {
              const display = isRecord(nudged.metadata) ? nudged.metadata["display"] : undefined
              if (isRecord(display) && typeof display["path"] === "string") {
                dropReadDedup(ctx.sessionID, display["path"])
              }
            }
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
              decorated,
            )
            if (options.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(options.toolCallId, decorated)
            }
            return decorated
          }),
        )
      },
    })
  }

  const hasMcpResourceServer = Object.values(yield* mcp.clients()).some(
    (client) => !!client.getServerCapabilities()?.resources,
  )
  if (hasMcpResourceServer) {
    tools[LIST_MCP_RESOURCES_TOOL] = tool({
      description:
        "Lists resources provided by connected MCP servers. Resources provide context such as files, database schemas, or application-specific information.",
      inputSchema: jsonSchema(
        ProviderTransform.schema(input.model, {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: "Optional MCP server name. When omitted, lists resources from every connected server.",
            },
          },
          additionalProperties: false,
        }),
      ),
      execute(args, opts) {
        return run.promise(
          Effect.gen(function* () {
            const parsed = parseListMcpResourcesArgs(args)
            const ctx = context(toRecord(args), opts)
            const clients = yield* mcp.clients()
            const resourceServers = Object.entries(clients)
              .filter((entry) => !!entry[1].getServerCapabilities()?.resources)
              .map((entry) => entry[0])
              .sort((a, b) => a.localeCompare(b))
            if (parsed.server && !resourceServers.includes(parsed.server)) {
              throw new Error(
                resourceServers.length === 0
                  ? `MCP server "${parsed.server}" does not support resources`
                  : `MCP server "${parsed.server}" does not support resources. Available resource servers: ${resourceServers.join(", ")}`,
              )
            }
            const permissionPatterns = parsed.server
              ? [`mcp:${parsed.server}:*`]
              : resourceServers.map((server) => `mcp:${server}:*`)
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: LIST_MCP_RESOURCES_TOOL, sessionID: ctx.sessionID, callID: opts.toolCallId },
              { args },
            )
            yield* ctx.ask({
              permission: "read",
              metadata: parsed.server ? { server: parsed.server } : {},
              patterns: permissionPatterns,
              always: permissionPatterns,
            })

            const resources = Object.values(yield* mcp.resources(parsed.server))
            const filtered = resources
              .filter((resource) => !parsed.server || resource.client === parsed.server)
              .toSorted((a, b) =>
                (a.client + "\u0000" + a.name + "\u0000" + a.uri).localeCompare(
                  b.client + "\u0000" + b.name + "\u0000" + b.uri,
                ),
              )
            const content = JSON.stringify({ resources: filtered.map(formatMcpResource) }, null, 2)
            const truncated = yield* truncate.output(content, {}, input.agent)
            const output = withStepBudget(LIST_MCP_RESOURCES_TOOL, ctx, {
              title: parsed.server ? `MCP resources: ${parsed.server}` : "MCP resources",
              metadata: {
                count: filtered.length,
                servers: resourceServers,
                ...(parsed.server ? { server: parsed.server } : {}),
                truncated: truncated.truncated,
                ...(truncated.truncated && { outputPath: truncated.outputPath }),
              },
              output: truncated.content,
            })
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: LIST_MCP_RESOURCES_TOOL, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
              output,
            )
            if (opts.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(opts.toolCallId, output)
            }
            return output
          }),
        )
      },
    })

    tools[READ_MCP_RESOURCE_TOOL] = tool({
      description:
        "Read a specific resource from an MCP server using the server name and resource URI. The URI is an MCP identifier and does not need to be a file URL.",
      inputSchema: jsonSchema(
        ProviderTransform.schema(input.model, {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: "MCP server name exactly as returned by list_mcp_resources.",
            },
            uri: {
              type: "string",
              description: "Resource URI to read. Use the exact URI string returned by list_mcp_resources.",
            },
          },
          required: ["server", "uri"],
          additionalProperties: false,
        }),
      ),
      execute(args, opts) {
        return run.promise(
          Effect.gen(function* () {
            const parsed = parseReadMcpResourceArgs(args)
            const ctx = context(toRecord(args), opts)
            const clients = yield* mcp.clients()
            const client = clients[parsed.server]
            if (!client) {
              throw new Error(`MCP server "${parsed.server}" is not connected`)
            }
            if (!client.getServerCapabilities()?.resources) {
              throw new Error(`MCP server "${parsed.server}" does not support resources`)
            }
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: READ_MCP_RESOURCE_TOOL, sessionID: ctx.sessionID, callID: opts.toolCallId },
              { args },
            )
            yield* ctx.ask({
              permission: "read",
              metadata: { server: parsed.server, uri: parsed.uri },
              patterns: [`mcp:${parsed.server}:${parsed.uri}`],
              always: [`mcp:${parsed.server}:*`],
            })

            const content = yield* mcp.readResource(parsed.server, parsed.uri)
            if (!content) throw new Error(`Failed to read MCP resource: ${parsed.server}/${parsed.uri}`)

            const formatted = formatMcpResourceContent(parsed.server, parsed.uri, content)
            const truncated = yield* truncate.output(formatted.text, {}, input.agent)
            const output = withStepBudget(READ_MCP_RESOURCE_TOOL, ctx, {
              title: `MCP resource: ${parsed.uri}`,
              metadata: {
                server: parsed.server,
                uri: parsed.uri,
                contents: formatted.contents,
                attachments: formatted.attachments.length,
                truncated: truncated.truncated,
                ...(truncated.truncated && { outputPath: truncated.outputPath }),
              },
              output: truncated.content,
              attachments: formatted.attachments.map((attachment) => ({
                ...attachment,
                id: PartID.ascending(),
                sessionID: ctx.sessionID,
                messageID: input.processor.message.id,
              })),
            })
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: READ_MCP_RESOURCE_TOOL, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
              output,
            )
            if (opts.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(opts.toolCallId, output)
            }
            return output
          }),
        )
      },
    })
  }

  for (const [key, item] of Object.entries(yield* mcp.tools())) {
    const execute = item.execute
    if (!execute) continue

    const schema = yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
    const transformed = ProviderTransform.schema(input.model, { ...schema, properties: schema.properties ?? {} })
    item.inputSchema = jsonSchema(transformed)
    item.execute = (args, opts) =>
      run.promise(
        Effect.gen(function* () {
          const ctx = context(args, opts)
          // Same memo, invalidation only (toolID is never "bash" here): an MCP tool with an
          // edit/patch-shaped id (e.g. a server's file_edit) mutates files without passing
          // through the registry loop above, so it must drop the green-test memo too.
          greenMemoBefore({ toolID: key, sessionID: ctx.sessionID, args })
          yield* plugin.trigger(
            "tool.execute.before",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId },
            { args },
          )
          const result: Awaited<ReturnType<NonNullable<typeof execute>>> = yield* Effect.gen(function* () {
            yield* ctx.ask({ permission: key, metadata: {}, patterns: ["*"], always: ["*"] })
            return yield* Effect.promise(() => execute(args, opts))
          }).pipe(
            Effect.withSpan("Tool.execute", {
              attributes: {
                "tool.name": key,
                "tool.call_id": opts.toolCallId,
                "session.id": ctx.sessionID,
                "message.id": input.processor.message.id,
              },
            }),
          )
          yield* plugin.trigger(
            "tool.execute.after",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
            result,
          )

          const textParts: string[] = []
          const attachments: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[] = []
          for (const contentItem of result.content) {
            if (contentItem.type === "text") textParts.push(contentItem.text)
            else if (contentItem.type === "image") {
              attachments.push({
                type: "file",
                mime: contentItem.mimeType,
                url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
              })
            } else if (contentItem.type === "resource") {
              const { resource } = contentItem
              if (resource.text) textParts.push(resource.text)
              if (resource.blob) {
                const mime = resource.mimeType ?? "application/octet-stream"
                const size = base64Size(resource.blob)
                if (!SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
                  textParts.push(
                    `[Binary MCP resource omitted: ${resource.uri} (${mime}, ${formatBytes(size)}) is not a supported attachment type]`,
                  )
                  continue
                }
                if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
                  textParts.push(
                    `[Binary MCP resource omitted: ${resource.uri} (${mime}, ${formatBytes(size)}) exceeds ${formatBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
                  )
                  continue
                }
                attachments.push({
                  type: "file",
                  mime,
                  url: `data:${mime};base64,${resource.blob}`,
                  filename: resource.uri,
                })
              }
            }
          }

          const truncated = yield* truncate.output(textParts.join("\n\n"), {}, input.agent)
          const metadata = {
            ...result.metadata,
            truncated: truncated.truncated,
            ...(truncated.truncated && { outputPath: truncated.outputPath }),
          }

          const output = withStepBudget(key, ctx, {
            title: "",
            metadata,
            output: truncated.content,
            attachments: attachments.map((attachment) => ({
              ...attachment,
              id: PartID.ascending(),
              sessionID: ctx.sessionID,
              messageID: input.processor.message.id,
            })),
            content: result.content,
          })
          if (opts.abortSignal?.aborted) {
            yield* input.processor.completeToolCall(opts.toolCallId, output)
          }
          return output
        }),
      )
    tools[key] = item
  }

  return tools
})

// L1.3 guardrail (docs/design/turn-cache-economics.md §5-L1 sub-move 3): aggregate
// tool-result token budget per assistant message (step), so a batched fan-out cannot
// stuff the context it was meant to save. Once a step's combined results exceed the
// budget, each SUBSEQUENT result in the same message is cut to its first
// STEP_RESULT_TRUNCATE_LINES lines with a self-describing marker — truncation is
// visible, never silent. The call that crosses the boundary is kept whole; only later
// calls are cut. Exempt tools (mutating/bookkeeping) are never truncated — governance
// fires at the edit and plan state must stay intact — but their tokens still count
// toward the step total.
export const STEP_RESULT_BUDGET = 20_000
const STEP_RESULT_TRUNCATE_LINES = 40
const STEP_BUDGET_EXEMPT = new Set(["edit", "write", "skill", "todowrite", "todoread"])

// One accumulator per session, pinned to that session's current assistant message; a
// new messageID replaces the old entry, so stale steps drop without timers.
const stepResultTokens = new Map<string, { messageID: string; tokens: number }>()

// L2.4 unified per-RESULT ceiling (docs/design/turn-cache-economics.md §5-L2 item 4):
// finishes what M3's per-tool search caps started — one hard token ceiling on EVERY
// individual tool result at the same wrapper sites the L1.3 aggregate covers, applied
// BEFORE the aggregate accounting so a single 70k blob enters the step ledger at ≤6k
// instead of instantly breaching it. Grounded decision on oversize handling: the
// design doc's "spills to cache_ref pagination" path was checked and NOT taken —
// graph-tools/webfetch/websearch page *arrays of items* (tool/_shared/cache.ts
// put/getSlice) behind each tool's own `cache_ref` parameter; there is no generic
// paging entry point at this layer, and withStepBudget is the last transform before
// the part is persisted, so the full output is not retrievable later either. Reusing
// it would mean new pagination infrastructure (a paging tool or a cache_ref param on
// every tool), so oversize results are cut at a line boundary with a self-describing
// marker steering the model to narrow — the M3/L1.3 pattern.
export const RESULT_TOKEN_CEILING = 6_000

export function applyResultCeiling(input: { toolID: string; output: string }): string {
  // Same exempt set as L1.3: mutating/bookkeeping results are never cut.
  if (STEP_BUDGET_EXEMPT.has(input.toolID)) return input.output
  const raw = Token.estimate(input.output)
  if (raw <= RESULT_TOKEN_CEILING) return input.output
  // Proportional cut (exact for any linear Token.estimate), snapped back to the last
  // full line so the kept text never ends mid-line.
  const slice = input.output.slice(0, Math.floor(input.output.length * (RESULT_TOKEN_CEILING / raw)))
  const lastBreak = slice.lastIndexOf("\n")
  const kept = lastBreak > 0 ? slice.slice(0, lastBreak) : slice
  return `${kept}\n[result ceiling: ~${Math.round(raw / 1000)}k-token output truncated to ~${Math.round(RESULT_TOKEN_CEILING / 1000)}k. This is a partial view — do not treat it as complete; narrow the call (tighter pattern, smaller range, offset/limit) to see the rest.]`
}

export function applyStepResultBudget(input: {
  sessionID: string
  messageID: string
  toolID: string
  output: string
}): string {
  let entry = stepResultTokens.get(input.sessionID)
  if (!entry || entry.messageID !== input.messageID) {
    entry = { messageID: input.messageID, tokens: 0 }
    stepResultTokens.set(input.sessionID, entry)
  }
  const breached = entry.tokens > STEP_RESULT_BUDGET
  entry.tokens += Token.estimate(input.output)
  if (!breached || STEP_BUDGET_EXEMPT.has(input.toolID)) return input.output
  const lines = input.output.split("\n")
  if (lines.length <= STEP_RESULT_TRUNCATE_LINES) return input.output
  const kept = lines.slice(0, STEP_RESULT_TRUNCATE_LINES).join("\n")
  const total = Math.round(entry.tokens / 1000)
  return `${kept}\n[step result budget reached — output truncated to ${STEP_RESULT_TRUNCATE_LINES} lines. Total this step: ~${total}k tokens. Re-run narrower, or continue in the next message.]`
}

// Last transform on every wrapper's result, so the persisted part, the after-hook
// payload, and the model all see the same value. Compose order is ceiling-first
// (L2.4), then the L1.3 aggregate ledger sees the post-ceiling size. The markers
// never stack: a post-breach aggregate cut keeps only the first 40 lines, which
// drops a trailing ceiling marker, and a ceiling-cut result short enough to survive
// the 40-line rule keeps only its own marker — exactly one marker per result. The
// L3.1 green-memo stub (metadata.green_memo) is already a tiny self-describing
// marker and skips the ceiling outright; its tokens still count in the ledger.
const withStepBudget = <T extends { output: string; metadata?: unknown }>(
  toolID: string,
  ctx: Pick<Tool.Context, "sessionID" | "messageID">,
  result: T,
): T => {
  const memoStub = isRecord(result.metadata) && result.metadata["green_memo"] === true
  const ceiled = memoStub ? result.output : applyResultCeiling({ toolID, output: result.output })
  return {
    ...result,
    output: applyStepResultBudget({
      sessionID: ctx.sessionID,
      messageID: ctx.messageID,
      toolID,
      output: ceiled,
    }),
  } as T
}

// L3.1 green-test memo (docs/design/turn-cache-economics.md §5-L3 item 1): hard runs spend
// 12–21 steps re-running test commands that already passed with nothing changed in between
// (11964 ran the same suite variants 12×, 11885 21×), and most of that re-verification buys
// nothing. When the model re-issues a test-ish bash command that already exited 0 and no
// file has been modified since, the wrapper short-circuits execution and returns a stub that
// is unmistakably a memo — never impersonating fresh output — with the last result's tail.
// One memo per session; entries persist across steps (that is the point) and the WHOLE
// session memo drops on any possible mutation (conservative: when unsure, invalidate). Like
// stepResultTokens above, entries are replaced/deleted lazily — no timers.
//
// §7 "Sound-rung verification" hard rule — bypass by construction: OL-7.9 verify commands
// never route through the session bash tool. They execute via makeShellCommandRunner
// (slice-orchestrator.ts), which spawns `sh -c <command>` directly through Bun.spawn (wired
// in prompt.ts as `runner: makeShellCommandRunner({ cwd })`), so the rung's verdict always
// re-executes; this memo can only ever answer the model's own bash tool calls.
export const GREEN_MEMO_COMMANDS = /runtests\.py|pytest|bun test|npm (run )?test|yarn test|tsc\b|eslint|ruff|mypy/

// Mutation heuristic for bash text: any hit clears the session memo (and marks the command
// itself ineligible to memoize — `pytest > out.log` writes a file; `make test` builds).
// `>(?!&)` catches file redirects (`> out`, `>> log`, `2> err`) while exempting the
// fd-duplication `2>&1` that test invocations legitimately carry. Read-only bash
// (grep/cat/ls/git log/git diff/git status/python -c print) must not match.
export const MUTATING_BASH =
  /sed\s+-i|>(?!&)|\btee\b|\bmv\b|\brm\b|\bcp\b|\btouch\b|\bgit\s+(checkout|stash|apply|reset|revert|clean|cherry-pick|merge|rebase)\b|\bpip\s+install\b|\bmake\b|python\S*\s+setup\.py/

// File-mutating tools clear the memo BEFORE they execute (strictly more conservative than
// on-completion: a patch that throws halfway may already have written). `file_edit` is
// matched loosely so an MCP server's edit tool invalidates too.
const MEMO_INVALIDATING_TOOLS = /^(edit|write|apply_patch|patch)$|file_edit/

// sessionID → normalized command key → last green result.
const greenTestMemo = new Map<string, Map<string, { messageID: string; tail: string }>>()

const GREEN_MEMO_TAIL_LINES = 10

// Normalization: collapse whitespace + trim. `workdir` participates in the key when set —
// the same command in two directories is two different results.
function greenMemoKey(args: unknown): string | undefined {
  if (!isRecord(args) || typeof args["command"] !== "string") return undefined
  const normalized = args["command"].replace(/\s+/g, " ").trim()
  if (!normalized) return undefined
  const workdir = args["workdir"]
  return typeof workdir === "string" && workdir ? `${workdir} ${normalized}` : normalized
}

// Pre-execution hook, called by every wrapper before the tool runs. Returns a memo stub to
// short-circuit execution (bash only, exact key hit), or undefined to run the tool. On a
// miss it applies invalidation: a bash command matching MUTATING_BASH, or any file-mutating
// tool, drops the whole session memo. Lookup runs first, so a bash command that IS the
// memoized command never invalidates before its own hit.
export function greenMemoBefore(input: {
  toolID: string
  sessionID: string
  args: unknown
}): Tool.ExecuteResult | undefined {
  if (input.toolID !== "bash") {
    if (MEMO_INVALIDATING_TOOLS.test(input.toolID)) greenTestMemo.delete(input.sessionID)
    return undefined
  }
  const key = greenMemoKey(input.args)
  if (!key) return undefined
  const hit = greenTestMemo.get(input.sessionID)?.get(key)
  if (hit) {
    const command = (input.args as Record<string, unknown>)["command"] as string
    return {
      title: command,
      metadata: { green_memo: true, memoStep: hit.messageID },
      output: `[green-test memo] unchanged since step ${hit.messageID} — this exact command already passed and no file has been modified since. Last result tail:\n${hit.tail}\nTo force a real re-run, change the command text (e.g. add -v).`,
    }
  }
  if (MUTATING_BASH.test(key)) greenTestMemo.delete(input.sessionID)
  return undefined
}

// Post-execution hook: memoize a green result. Green means the shell tool reported
// `metadata.exit === 0` — the exit code the bash tool puts on every result (tool/shell.ts);
// null (abort/timeout) is not green. Eligibility is a recognized test/check command carrying
// no mutation shape; anything else is never stored.
export function greenMemoAfter(input: {
  toolID: string
  sessionID: string
  messageID: string
  args: unknown
  result: Pick<Tool.ExecuteResult, "output" | "metadata">
}): void {
  if (input.toolID !== "bash") return
  if (!isRecord(input.args) || typeof input.args["command"] !== "string") return
  const command = input.args["command"]
  if (!GREEN_MEMO_COMMANDS.test(command) || MUTATING_BASH.test(command)) return
  if (input.result.metadata["exit"] !== 0) return
  const key = greenMemoKey(input.args)
  if (!key) return
  let memo = greenTestMemo.get(input.sessionID)
  if (!memo) {
    memo = new Map()
    greenTestMemo.set(input.sessionID, memo)
  }
  memo.set(key, {
    messageID: input.messageID,
    tail: input.result.output.split("\n").slice(-GREEN_MEMO_TAIL_LINES).join("\n"),
  })
}

// Sorts an assembled tool map by id so the same enabled-tool set always serializes to
// the same key order in the model request, independent of the async resolution order
// its sources produced this turn (custom-tool glob scan, MCP client connect order,
// MCP.tools() concurrency). Callers apply this once, right before the tools object is
// handed to the model — after any turn-specific additions (e.g. StructuredOutput).
//
// @sem domain=session role=cache-stability
export function orderToolsForCache<T>(tools: Record<string, T>): Record<string, T> {
  const ordered: Record<string, T> = {}
  for (const id of Object.keys(tools).sort()) ordered[id] = tools[id]!
  return ordered
}

function toRecord(value: unknown) {
  if (isRecord(value)) return value
  return {}
}

function parseListMcpResourcesArgs(value: unknown) {
  const args = toRecord(value)
  return { server: optionalString(args, "server") }
}

function parseReadMcpResourceArgs(value: unknown) {
  const args = toRecord(value)
  return { server: requiredString(args, "server"), uri: requiredString(args, "uri") }
}

function optionalString(args: Record<string, unknown>, key: string) {
  const value = args[key]
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string") throw new Error(`${key} must be a string`)
  return value
}

function requiredString(args: Record<string, unknown>, key: string) {
  const value = optionalString(args, key)
  if (value) return value
  throw new Error(`${key} is required`)
}

function formatMcpResource(resource: MCP.Resource) {
  const result = Object.fromEntries(Object.entries(resource).filter((entry) => entry[0] !== "client"))
  return { ...result, server: resource.client }
}

function formatMcpResourceContent(server: string, uri: string, content: { contents: unknown }) {
  const items = (Array.isArray(content.contents) ? content.contents : [content.contents]).filter(isRecord)
  const text: string[] = []
  const attachments: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[] = []

  for (const item of items) {
    const itemUri = typeof item.uri === "string" ? item.uri : uri
    const mime = typeof item.mimeType === "string" ? item.mimeType : "application/octet-stream"
    if (typeof item.text === "string") {
      text.push(`Resource: ${itemUri}\nMIME: ${mime}\n${item.text}`)
      continue
    }
    if (typeof item.blob === "string") {
      const size = base64Size(item.blob)
      if (!SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
        text.push(
          `[Binary MCP resource omitted: ${itemUri} (${mime}, ${formatBytes(size)}) is not a supported attachment type]`,
        )
        continue
      }
      if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
        text.push(
          `[Binary MCP resource omitted: ${itemUri} (${mime}, ${formatBytes(size)}) exceeds ${formatBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
        )
        continue
      }
      text.push(`[Binary MCP resource attached: ${itemUri} (${mime})]`)
      attachments.push({
        type: "file",
        mime,
        url: `data:${mime};base64,${item.blob}`,
        filename: itemUri,
      })
      continue
    }
    text.push(`[MCP resource content without text or blob: ${itemUri}]`)
  }

  return {
    contents: items.length,
    attachments,
    text: text.join("\n\n") || `MCP resource ${uri} from ${server} returned no contents.`,
  }
}

function base64Size(value: string) {
  const trimmed = value.replace(/\s/g, "")
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding)
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${Math.ceil(value / (1024 * 1024))} MB`
}

export * as SessionTools from "./tools"
