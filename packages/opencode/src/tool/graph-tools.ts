/**
 * Econ graph tools — wraps the code-intelligence BunSqliteGraph into the
 * opencode Tool.define() shape so the agent loop can call recon, file_read,
 * and get_references natively without blind filesystem reads.
 *
 * Z1: isolated econ addition. Cross-package imports use relative paths so no
 * `bun install` is required during development. Add
 * `"@opencode-ai/code-intelligence": "workspace:*"` to package.json
 * dependencies before shipping to production.
 *
 * @sem domain=intelligence role=tools
 */

// Z1 — resolved via tsconfig paths alias (no bun install needed during dev;
// add "workspace:*" dep to package.json before shipping)
import { BunSqliteGraph, makeReconTool, makeFileReadTool, makeGetReferencesTool } from "@opencode-ai/code-intelligence"

import * as Tool from "./tool"
import { Effect, Schema } from "effect"

// ---------------------------------------------------------------------------
// Lazy singleton graph — indexed once against process.cwd() on first call.
// ---------------------------------------------------------------------------

let _graph: BunSqliteGraph | null = null

function getGraph(): BunSqliteGraph {
  if (!_graph) {
    const root = process.cwd()
    _graph = new BunSqliteGraph(":memory:", root)
    // Fire-and-forget background index; graph answers queries from the
    // empty DB until indexing completes (returns empty results initially).
    _graph.index(root).catch(() => {})
  }
  return _graph
}

// ---------------------------------------------------------------------------
// recon
// ---------------------------------------------------------------------------

const ReconParameters = Schema.Struct({
  task: Schema.String.annotate({
    description:
      "Natural-language task phrase describing what you need to do. " +
      "Returns entities + references + notes in one shot.",
  }),
})

/**
 * `recon` tool: graph-backed task-phrase → bundle. Replaces the fan-out of
 * multiple search+read calls with a single tool invocation.
 *
 * @sem domain=intelligence role=tools
 */
export const GraphReconTool = Tool.define(
  "recon",
  Effect.succeed({
    description:
      "Return a recon bundle for a natural-language task phrase: the most relevant " +
      "code entities, their references, and anchored notes in one shot — replacing " +
      "the search→read→search fan-out.",
    parameters: ReconParameters,
    execute: (input: Schema.Schema.Type<typeof ReconParameters>, _ctx: Tool.Context) =>
      Effect.promise(() =>
        makeReconTool(getGraph())
          .execute(input as Record<string, unknown>)
          .then((output: string) => ({
            title: "recon",
            metadata: {} as Record<string, unknown>,
            output,
          })),
      ),
  }),
)

// ---------------------------------------------------------------------------
// graph_file_read
// ---------------------------------------------------------------------------

const FileReadParameters = Schema.Struct({
  path: Schema.String.annotate({
    description: "File path (absolute or relative to the repo root).",
  }),
  entity: Schema.optional(Schema.String).annotate({
    description:
      "Optional entity name. If provided, returns the entity profile (signature, " +
      "kind, lines) from the graph instead of raw file content.",
  }),
})

/**
 * `graph_file_read` tool: reads a source file with line numbers or returns
 * an entity profile from the in-process graph.
 *
 * @sem domain=intelligence role=tools
 */
export const GraphFileReadTool = Tool.define(
  "graph_file_read",
  Effect.succeed({
    description:
      "Read a source file from disk (with 1-based line numbers) or retrieve an " +
      "entity profile (signature, kind, lines) from the in-process graph by entity name.",
    parameters: FileReadParameters,
    execute: (input: Schema.Schema.Type<typeof FileReadParameters>, _ctx: Tool.Context) =>
      Effect.promise(() => {
        const root = process.cwd()
        return makeFileReadTool(getGraph(), root)
          .execute(input as Record<string, unknown>)
          .then((output: string) => ({
            title: "graph_file_read",
            metadata: {} as Record<string, unknown>,
            output,
          }))
      }),
  }),
)

// ---------------------------------------------------------------------------
// get_references
// ---------------------------------------------------------------------------

const GetReferencesParameters = Schema.Struct({
  entity: Schema.String.annotate({
    description: "Entity name or stable key (<filePath>:<name>:<kind>).",
  }),
  direction: Schema.optional(
    Schema.Literals(["callers", "callees"]).annotate({
      description:
        "callers = who calls/imports this entity (fan-in, default); " +
        "callees = what this entity calls/imports.",
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed("callers" as const))),
})

/**
 * `get_references` tool: returns the caller list (blast radius) or callee
 * list for a named entity, backed by the in-process SQLite graph.
 *
 * @sem domain=intelligence role=tools
 */
export const GraphGetReferencesTool = Tool.define(
  "get_references",
  Effect.succeed({
    description:
      "Return the caller list (fan-in) or callee list (outgoing imports/calls) for a " +
      "named entity. Use direction='callers' to see blast radius; 'callees' for dependencies.",
    parameters: GetReferencesParameters,
    execute: (
      input: Schema.Schema.Type<typeof GetReferencesParameters>,
      _ctx: Tool.Context,
    ) =>
      Effect.promise(() =>
        makeGetReferencesTool(getGraph())
          .execute(input as Record<string, unknown>)
          .then((output: string) => ({
            title: "get_references",
            metadata: {} as Record<string, unknown>,
            output,
          })),
      ),
  }),
)
