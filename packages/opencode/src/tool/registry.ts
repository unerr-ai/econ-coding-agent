import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/layer-node-platform"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { PlanExitTool } from "./plan"
import { Session } from "@/session/session"
import { QuestionTool } from "./question"
import { ShellTool } from "./shell"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { ReadTool } from "./read"
import { TaskTool } from "./task"
import { Database } from "@opencode-ai/core/database/database"
import { TodoWriteTool } from "./todo"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import { SkillTool } from "./skill"
// Z1 — econ graph tools (S1.2); remove this comment block when graduated
import { GraphReconTool, GraphGetReferencesTool, GraphSearchCodeTool, GraphFileOutlineTool } from "./graph-tools"
import { CompactionRefetchTool } from "./compaction-refetch"
import { ToolJsonSchema } from "./json-schema"
// Z2.3 — webfetch-compress folded into the webfetch tool (Sprint 6.2)
import * as Tool from "./tool"
import { Config } from "@/config/config"
import { type ToolContext as PluginToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import type { JSONSchema7, JSONSchema7Definition } from "@ai-sdk/provider"
import { Schema } from "effect"
import z from "zod"
import { Plugin } from "../plugin"
import { Provider } from "@/provider/provider"

import { WebSearchTool } from "./websearch"
import { LspTool } from "./lsp"
import * as Truncate from "./truncate"
import { ApplyPatchTool } from "./apply_patch"
import { Glob } from "@opencode-ai/core/util/glob"
import path from "path"
import { pathToFileURL } from "url"
import { Effect, Layer, Context } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Format } from "../format"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import { Question } from "../question"
import { Todo } from "../session/todo"
import { LSP } from "@/lsp/lsp"
import { Instruction } from "../session/instruction"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Agent } from "../agent/agent"
import { Skill } from "../skill"
import { Permission } from "@/permission"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

export function webSearchEnabled(providerID: ProviderV2.ID, flags = { exa: false, parallel: false }) {
  return providerID === ProviderV2.ID.opencode || flags.exa || flags.parallel
}

type TaskDef = Tool.InferDef<typeof TaskTool>
type ReadDef = Tool.InferDef<typeof ReadTool>

type State = {
  custom: Tool.Def[]
  builtin: Tool.Def[]
  task: TaskDef
  read: ReadDef
}

export interface Interface {
  readonly ids: () => Effect.Effect<string[]>
  readonly all: () => Effect.Effect<Tool.Def[]>
  readonly named: () => Effect.Effect<{ task: TaskDef; read: ReadDef }>
  readonly tools: (model: {
    providerID: ProviderV2.ID
    modelID: ModelV2.ID
    agent: Agent.Info
  }) => Effect.Effect<Tool.Def[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ToolRegistry") {}

// Sprint 4 Phase-1: tool ids hidden from the model-facing advertised list.
// These remain in all() — still executable by id at zero cost, just filtered from
// the model's advertised list. recon/get_references/grep/glob all fold into the
// unified `search` tool (modes: default / refs / literal|regex / glob). webfetch is
// now the compressed impl (Sprint 6), so it is advertised — no longer hidden.
export const HIDDEN_FROM_MODEL = new Set<string>([
  GraphReconTool.id,           // "recon"          → search (default task bundle)
  GraphGetReferencesTool.id,   // "get_references" → search (mode:refs)
  GrepTool.id,                 // "grep"           → search (mode:literal|regex)
  GlobTool.id,                 // "glob"           → search (mode:glob)
])

// AC-7.1 — progressive tool-schema disclosure. Heavier/less-frequently-used tools that
// still get advertised unconditionally (unlike websearch/apply_patch/lsp/plan, which are
// already gated by flags/model by design — left untouched here). When
// `RuntimeFlags.experimentalCompactToolCatalog` is on, `tools()` shrinks each of these to
// a one-line description + name/type-only parameter schema; `expand_tool_schema` resolves
// the full contract on demand. Always-on core tools (read/edit/write/shell/task/todo/
// search/webfetch) are deliberately excluded so the model can call them immediately.
export const CATALOG_TOOL_IDS = new Set<string>([
  SkillTool.id,
  QuestionTool.id,
  GraphFileOutlineTool.id,
  CompactionRefetchTool.id,
  InvalidTool.id,
])

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const plugin = yield* Plugin.Service
    const agents = yield* Agent.Service
    const truncate = yield* Truncate.Service
    const flags = yield* RuntimeFlags.Service

    const invalid = yield* InvalidTool
    const task = yield* TaskTool
    const read = yield* ReadTool
    const question = yield* QuestionTool
    const todo = yield* TodoWriteTool
    const lsptool = yield* LspTool
    const plan = yield* PlanExitTool
    const webfetch = yield* WebFetchTool
    const websearch = yield* WebSearchTool
    const shell = yield* ShellTool
    const globtool = yield* GlobTool
    const writetool = yield* WriteTool
    const edit = yield* EditTool
    const greptool = yield* GrepTool
    const patchtool = yield* ApplyPatchTool
    const skilltool = yield* SkillTool
    const agent = yield* Agent.Service
    // Z1 — econ graph tools
    const graphRecon = yield* GraphReconTool
    const graphGetRefs = yield* GraphGetReferencesTool
    const graphSearchCode = yield* GraphSearchCodeTool
    const graphFileOutline = yield* GraphFileOutlineTool
    // AC-6.2 — recoverable transcript: read-only, cheap, always available.
    const compactionRefetch = yield* CompactionRefetchTool

    const state = yield* InstanceState.make<State>(
      Effect.fn("ToolRegistry.state")(function* (ctx) {
        const custom: Tool.Def[] = []

        function fromPlugin(id: string, def: ToolDefinition): Tool.Def {
          // Plugin tools still expose Zod args publicly; keep that compatibility
          // boxed at the registry boundary and give the LLM the original JSON Schema.
          // Normalize missing args to `{}` once — pre-1.14.49 the code was
          // `z.object(def.args)` and Zod silently tolerated undefined (#27451, #27630).
          const args = def.args ?? {}
          const entries = Object.entries(args)
          const allZod = entries.every((entry) => isZodType(entry[1]))
          const zodParams = allZod ? z.object(args) : undefined
          const jsonSchema = zodParams ? zodJsonSchema(zodParams) : legacyJsonSchema(entries)
          const parameters = zodParams
            ? Schema.declare<unknown>((u): u is unknown => zodParams.safeParse(u).success)
            : Schema.Unknown
          return {
            id,
            parameters,
            jsonSchema,
            description: def.description,
            execute: (args, toolCtx) =>
              Effect.gen(function* () {
                // Bridge the host's Effect-based `ask` into a Promise-returning
                // function for the plugin to make sure context persists
                const bridge = yield* EffectBridge.make()
                const pluginCtx: PluginToolContext = {
                  ...toolCtx,
                  ask: (req) => bridge.promise(toolCtx.ask(req)),
                  directory: ctx.directory,
                  worktree: ctx.worktree,
                }
                const result = yield* Effect.promise(() => def.execute(args as any, pluginCtx))
                const output = typeof result === "string" ? result : result.output
                const metadata = typeof result === "string" ? {} : (result.metadata ?? {})
                const attachments = typeof result === "string" ? undefined : result.attachments
                const info = yield* agent.get(toolCtx.agent)
                const out = yield* truncate.output(output, {}, info)
                return {
                  title: typeof result === "string" ? "" : (result.title ?? ""),
                  output: out.truncated ? out.content : output,
                  attachments,
                  metadata: {
                    ...metadata,
                    truncated: out.truncated,
                    ...(out.truncated && { outputPath: out.outputPath }),
                  },
                }
              }).pipe(
                Effect.withSpan("Tool.execute", {
                  attributes: {
                    "tool.name": id,
                    "session.id": toolCtx.sessionID,
                    "message.id": toolCtx.messageID,
                    ...(toolCtx.callID ? { "tool.call_id": toolCtx.callID } : {}),
                  },
                }),
              ),
          }
        }

        const dirs = yield* config.directories()
        const matches = dirs.flatMap((dir) =>
          Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: dir, absolute: true, dot: true, symlink: true }),
        )
        if (matches.length) yield* config.waitForDependencies()
        for (const match of matches) {
          const namespace = path.basename(match, path.extname(match))
          // `match` is an absolute filesystem path from `Glob.scanSync(..., { absolute: true })`.
          // Import it as `file://` so Node on Windows accepts the dynamic import.
          const mod = yield* Effect.promise(() => import(pathToFileURL(match).href))
          for (const [id, def] of Object.entries(mod)) {
            if (!isPluginTool(def)) continue
            custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def))
          }
        }

        const plugins = yield* plugin.list()
        for (const p of plugins) {
          for (const [id, def] of Object.entries(p.tool ?? {})) {
            custom.push(fromPlugin(id, def))
          }
        }

        yield* config.get()
        const questionEnabled = ["app", "cli", "desktop"].includes(flags.client) || flags.enableQuestionTool

        const tool = yield* Effect.all({
          invalid: Tool.init(invalid),
          shell: Tool.init(shell),
          read: Tool.init(read),
          glob: Tool.init(globtool),
          grep: Tool.init(greptool),
          edit: Tool.init(edit),
          write: Tool.init(writetool),
          task: Tool.init(task),
          fetch: Tool.init(webfetch),
          todo: Tool.init(todo),
          search: Tool.init(websearch),
          skill: Tool.init(skilltool),
          patch: Tool.init(patchtool),
          question: Tool.init(question),
          lsp: Tool.init(lsptool),
          plan: Tool.init(plan),
          // Z1 — econ graph tools (S1.2)
          recon: Tool.init(graphRecon),
          getReferences: Tool.init(graphGetRefs),
          searchCode: Tool.init(graphSearchCode),
          fileOutline: Tool.init(graphFileOutline),
          compactionRefetch: Tool.init(compactionRefetch),
        })

        // AC-7.1 — meta-tool that resolves a catalog-compacted tool's full JSON Schema
        // + description on demand. Built as a raw Tool.Def (bypassing Tool.define/
        // Tool.init, same as fromPlugin above) since it only needs a read-only lookup
        // over the tools already constructed in this scope.
        const toolById = new Map<string, Tool.Def>([...Object.values(tool), ...custom].map((t) => [t.id, t]))
        const ExpandToolSchemaParameters = Schema.Struct({
          tool: Schema.String.annotate({ description: "The tool id shown in its compact catalog entry." }),
        })
        const expandToolSchema: Tool.Def<typeof ExpandToolSchemaParameters> = {
          id: "expand_tool_schema",
          description:
            "Return the full parameter JSON Schema and description for a tool that appears in " +
            "compact-catalog form (one-line summary, no parameter schema). Call this before " +
            "invoking a compact-catalog tool whose argument names or types aren't obvious from " +
            "its compact entry.",
          parameters: ExpandToolSchemaParameters,
          execute: (args) =>
            Effect.sync(() => {
              const target = toolById.get(args.tool)
              if (!target) {
                return { title: "unknown tool", output: `No tool registered with id "${args.tool}".`, metadata: {} }
              }
              return {
                title: target.id,
                output: JSON.stringify(
                  { id: target.id, description: target.description, parameters: ToolJsonSchema.fromTool(target) },
                  null,
                  2,
                ),
                metadata: {},
              }
            }),
        }

        return {
          custom,
          builtin: [
            tool.invalid,
            ...(questionEnabled ? [tool.question] : []),
            tool.shell,
            tool.read,
            tool.glob,
            tool.grep,
            tool.edit,
            tool.write,
            tool.task,
            tool.fetch,
            tool.todo,
            tool.search,
            tool.skill,
            tool.patch,
            ...(flags.experimentalLspTool ? [tool.lsp] : []),
            ...(flags.experimentalPlanMode && flags.client === "cli" ? [tool.plan] : []),
            // Z1 — econ graph tools always available (S1.2)
            tool.recon,
            tool.getReferences,
            tool.searchCode,
            tool.fileOutline,
            // AC-6.2 — recoverable transcript: read-only, cheap, always available.
            tool.compactionRefetch,
            // AC-7.1 — only advertised once the compact catalog is actually in play.
            ...(flags.experimentalCompactToolCatalog ? [expandToolSchema] : []),
          ],
          task: tool.task,
          read: tool.read,
        }
      }),
    )

    const all: Interface["all"] = Effect.fn("ToolRegistry.all")(function* () {
      const s = yield* InstanceState.get(state)
      return [...s.builtin, ...s.custom] as Tool.Def[]
    })

    const ids: Interface["ids"] = Effect.fn("ToolRegistry.ids")(function* () {
      return (yield* all()).map((tool) => tool.id)
    })

    const describeTask = Effect.fn("ToolRegistry.describeTask")(function* (agent: Agent.Info) {
      const items = (yield* agents.list()).filter((item) => item.mode !== "primary")
      const filtered = items.filter(
        (item) => Permission.evaluate("task", item.name, agent.permission).action !== "deny",
      )
      const list = filtered.toSorted((a, b) => a.name.localeCompare(b.name))
      const description = list
        .map(
          (item) =>
            `- ${item.name}: ${item.description ?? "This subagent should only be called manually by the user."}`,
        )
        .join("\n")
      return ["Available agent types and the tools they have access to:", description].join("\n")
    })

    const tools: Interface["tools"] = Effect.fn("ToolRegistry.tools")(function* (input) {
      const filtered = (yield* all()).filter((tool) => {
        // Phase-1 de-registration: keep in all(), hide from model prompt.
        if (HIDDEN_FROM_MODEL.has(tool.id)) return false

        if (tool.id === WebSearchTool.id) {
          return webSearchEnabled(input.providerID, { exa: flags.enableExa, parallel: flags.enableParallel })
        }

        const usePatch =
          input.modelID.includes("gpt-") && !input.modelID.includes("oss") && !input.modelID.includes("gpt-4")
        if (tool.id === ApplyPatchTool.id) return usePatch
        if (tool.id === EditTool.id || tool.id === WriteTool.id) return !usePatch

        return true
      })

      return yield* Effect.forEach(
        filtered,
        Effect.fnUntraced(function* (tool: Tool.Def) {
          const output = {
            description: tool.description,
            parameters: tool.parameters,
            jsonSchema: tool.jsonSchema,
          }
          yield* plugin.trigger("tool.definition", { toolID: tool.id }, output)
          const jsonSchema =
            output.parameters === tool.parameters || output.jsonSchema !== tool.jsonSchema
              ? output.jsonSchema
              : undefined
          const description = [
            output.description,
            tool.id === TaskTool.id ? yield* describeTask(input.agent) : undefined,
          ]
            .filter(Boolean)
            .join("\n")

          // AC-7.1 — progressive tool-schema disclosure: shrink catalog-eligible tools to
          // a one-line description + name/type-only schema. Off by default; a plugin
          // override (jsonSchema set above) always wins over this compaction.
          if (flags.experimentalCompactToolCatalog && CATALOG_TOOL_IDS.has(tool.id)) {
            return {
              id: tool.id,
              description: compactDescription(description, tool.id),
              parameters: output.parameters,
              jsonSchema: compactJsonSchema(jsonSchema ?? ToolJsonSchema.fromTool(tool)),
              execute: tool.execute,
              formatValidationError: tool.formatValidationError,
            }
          }

          return {
            id: tool.id,
            description,
            parameters: output.parameters,
            jsonSchema,
            execute: tool.execute,
            formatValidationError: tool.formatValidationError,
          }
        }),
        { concurrency: "unbounded" },
      )
    })

    const named: Interface["named"] = Effect.fn("ToolRegistry.named")(function* () {
      const s = yield* InstanceState.get(state)
      return { task: s.task, read: s.read }
    })

    return Service.of({ ids, all, named, tools })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer
    .pipe(
      Layer.provide(Config.defaultLayer),
      Layer.provide(Plugin.defaultLayer),
      Layer.provide(Question.defaultLayer),
      Layer.provide(Todo.defaultLayer),
      Layer.provide(Skill.defaultLayer),
      Layer.provide(Agent.defaultLayer),
      Layer.provide(Session.defaultLayer),
      Layer.provide(BackgroundJob.defaultLayer),
      Layer.provide(Provider.defaultLayer),
      Layer.provide(LSP.defaultLayer),
      Layer.provide(Instruction.defaultLayer),
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(EventV2Bridge.defaultLayer),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(Format.defaultLayer),
      Layer.provide(CrossSpawnSpawner.defaultLayer),
      Layer.provide(Truncate.defaultLayer),
    )
    .pipe(Layer.provide(Database.defaultLayer), Layer.provide(RuntimeFlags.defaultLayer)),
)

function isZodType(value: unknown): value is z.ZodType {
  return typeof value === "object" && value !== null && "_zod" in value
}

function isPluginTool(value: unknown): value is ToolDefinition {
  return typeof value === "object" && value !== null && "args" in value && "description" in value && "execute" in value
}

function isJsonSchemaDefinition(value: unknown): value is JSONSchema7Definition {
  return typeof value === "boolean" || (typeof value === "object" && value !== null && !Array.isArray(value))
}

function legacyJsonSchema(entries: [string, unknown][]): JSONSchema7 {
  const properties = Object.fromEntries(
    entries.filter((entry): entry is [string, JSONSchema7Definition] => isJsonSchemaDefinition(entry[1])),
  )
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
  }
}

function zodJsonSchema(schema: z.ZodType): JSONSchema7 {
  const result = normalizeZodJsonSchema(z.toJSONSchema(schema, { io: "input", metadata: zodMetadataRegistry(schema) }))
  if (!isJsonSchemaObject(result)) throw new Error("plugin tool Zod schema produced a non-object JSON Schema")
  const { $defs, ...rest } = result
  return (
    $defs && isJsonSchemaObject($defs) ? { ...rest, definitions: $defs as JSONSchema7["definitions"] } : rest
  ) as JSONSchema7
}

function zodMetadataRegistry(schema: z.ZodType) {
  const registry = z.registry<Record<string, unknown>>()
  const seen = new WeakSet<object>()
  const collect = (value: unknown) => {
    if (typeof value !== "object" || value === null) return
    if (seen.has(value)) return
    seen.add(value)

    if (isZodType(value)) {
      const metadata = typeof value.meta === "function" ? value.meta() : undefined
      const description = typeof value.description === "string" ? value.description : undefined
      const merged = {
        ...(metadata && typeof metadata === "object" ? metadata : {}),
        ...(description ? { description } : {}),
      }
      if (Object.keys(merged).length) registry.add(value, merged)
      collect(value._zod.def)
      return
    }

    for (const item of Object.values(value)) collect(item)
  }
  collect(schema)
  return registry
}

function normalizeZodJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeZodJsonSchema(item))
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry) =>
        (entry[0] === "exclusiveMaximum" || entry[0] === "exclusiveMinimum") && typeof entry[1] === "boolean"
          ? false
          : true,
      )
      .map(([key, item]) => [key, normalizeZodJsonSchema(item)]),
  )
}

function isJsonSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// AC-7.1 — collapse a tool's full JSON Schema to its top-level {name: type} contract:
// drops nested $defs/enums/per-property descriptions (the bulk of the token cost) while
// keeping property names, `required`, and top-level types so the model can still form a
// syntactically valid call without a round trip through expand_tool_schema.
function compactJsonSchema(schema: JSONSchema7): JSONSchema7 {
  const properties = schema.properties
  if (!properties) return { type: "object", additionalProperties: true }
  const compactProperties: Record<string, JSONSchema7Definition> = Object.fromEntries(
    Object.entries(properties).map(([key, def]): [string, JSONSchema7Definition] =>
      typeof def === "boolean" ? [key, def] : [key, { type: def.type } as JSONSchema7],
    ),
  )
  return {
    type: "object",
    properties: compactProperties,
    ...(schema.required ? { required: schema.required } : {}),
    additionalProperties: true,
  }
}

function compactDescription(description: string, id: string): string {
  const firstLine = description.split("\n")[0]?.trim() || description.trim()
  return `${firstLine} [compact catalog entry — call expand_tool_schema({tool:"${id}"}) for the full parameter schema before using unfamiliar arguments]`
}

export const node = LayerNode.make(layer.pipe(Layer.provide(Ripgrep.defaultLayer)), [
  Config.node,
  Plugin.node,
  Question.node,
  Todo.node,
  Agent.node,
  Skill.node,
  Session.node,
  BackgroundJob.node,
  Provider.node,
  LSP.node,
  Instruction.node,
  FSUtil.node,
  EventV2Bridge.node,
  httpClient,
  CrossSpawnSpawner.node,
  Format.node,
  Truncate.node,
  RuntimeFlags.node,
  Database.node,
])

export * as ToolRegistry from "./registry"
