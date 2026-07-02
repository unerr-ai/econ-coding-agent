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
import { BunSqliteGraph, makeReconTool, makeGetReferencesTool, makeSearchCodeTool, makeFileOutlineTool } from "@opencode-ai/code-intelligence"

import * as Tool from "./tool"
import { Effect, Schema } from "effect"
import { withMeta, hashInputs, getSlice, recordToolCall } from "./_shared"
import { enrichEntities } from "./graph-tools-enrich"
import type { LeanEntity } from "./graph-tools-enrich"
// Sprint 4: glob mode uses Glob.scanSync (sync, no Effect service needed)
import { Glob } from "@opencode-ai/core/util/glob"
import path from "path"
import { Ripgrep } from "@opencode-ai/core/ripgrep"

// ---------------------------------------------------------------------------
// Lazy singleton graph — indexed once against process.cwd() on first call.
// ---------------------------------------------------------------------------

let _graph: BunSqliteGraph | null = null

export function getGraph(): BunSqliteGraph {
  if (!_graph) {
    const root = process.cwd()
    _graph = new BunSqliteGraph(":memory:", root)
    // Kick off the background index and keep the promise so callers can await
    // readiness (see ensureGraphReady). The catch keeps a failed index from
    // turning into an unhandled rejection.
    _indexReady = _graph.index(root).catch(() => {})
  }
  return _graph
}

let _indexReady: Promise<unknown> | undefined

/**
 * Resolve once the in-memory graph has finished its initial index, then hand
 * back the graph. The read tools await this so the first query returns real
 * results instead of an empty cold-graph hit — without it the model sees an
 * empty result and falls back to shelling out, which it must never do.
 *
 * @sem domain=intelligence role=query
 */
export async function ensureGraphReady(): Promise<BunSqliteGraph> {
  const graph = getGraph()
  if (_indexReady) await _indexReady
  return graph
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
  cache_ref: Schema.optional(Schema.String).annotate({
    description:
      "Hash from a prior `ur|cache-ref` / `_meta.cache_ref` marker — returns the " +
      "withheld full-body slice from local cache (~0ms recompute).",
  }),
  offset: Schema.optional(Schema.Number).annotate({
    description: "0-based slice offset when using cache_ref (default 0).",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Max entities in the lean index (default 10); page size for cache_ref.",
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
      "Return a lean recon bundle for a natural-language task phrase: entities with " +
      "signature + 15-line preview + caller_count, their references, and anchored notes. " +
      "Full bodies are cached — follow up with cache_ref to page them in without recompute. " +
      "ur|rsk lines are emitted for chokepoint entities (fan-in ≥ 10).",
    parameters: ReconParameters,
    execute: (input: Schema.Schema.Type<typeof ReconParameters>, _ctx: Tool.Context) => {
      // cache_ref fast-path: return a withheld body slice without recomputing.
      if (input.cache_ref) {
        return Effect.promise(async () => {
          const offset = input.offset ?? 0
          const lim = input.limit ?? 5
          const slice = getSlice(input.cache_ref!, offset, lim)
          if (!slice) {
            return {
              title: "recon",
              metadata: {} as Record<string, unknown>,
              output: JSON.stringify({ error: "cache_ref not found; resubmit the original query to recompute" }),
            }
          }
          return {
            title: "recon",
            metadata: {} as Record<string, unknown>,
            output: JSON.stringify(
              { cache_ref: input.cache_ref, offset, total: slice.total, more: slice.more, items: slice.slice },
              null,
              2,
            ),
          }
        })
      }

      const root = process.cwd()
      return Effect.promise(async () => {
        const rawOutput = await makeReconTool(await ensureGraphReady()).execute(input as Record<string, unknown>)

        let parsed: unknown
        try { parsed = JSON.parse(rawOutput) } catch {
          const meta = withMeta(rawOutput, rawOutput)
          recordToolCall({ tool: "recon", ...meta })
          return { title: "recon", metadata: { meta } as Record<string, unknown>, output: rawOutput }
        }

        const bundle = parsed as { entities?: unknown[]; references?: unknown[]; notes?: unknown[] }
        const entityList: LeanEntity[] = Array.isArray(bundle?.entities)
          ? (bundle.entities as LeanEntity[])
          : []

        const queryCacheKey = hashInputs(String(input.task), "recon")
        const { lean, cacheKey, total, signals } = await enrichEntities(entityList, root, queryCacheKey)

        const leanBundle = { ...bundle, entities: lean }
        const leanJson = JSON.stringify(
          { ...leanBundle, _meta: { cache_ref: cacheKey, total, more: false } },
          null,
          2,
        )
        const signalBlock = signals.length > 0 ? "\n\n" + signals.join("\n") : ""
        const output = leanJson + signalBlock

        const meta = withMeta(rawOutput, output)
        recordToolCall({ tool: "recon", ...meta })
        return {
          title: "recon",
          metadata: { meta } as Record<string, unknown>,
          output,
        }
      })
    },
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
  limit: Schema.optional(Schema.Number).annotate({
    description: "Max references to return (default 25).",
  }),
  include_text_occurrences: Schema.optional(Schema.Boolean).annotate({
    description:
      "Default false. Set true for a RENAME — also returns word-boundary literal matches of " +
      "the entity name the call graph cannot see. Only applies with direction:'callers'.",
  }),
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
      Effect.promise(async () => {
        const root = process.cwd()
        return makeGetReferencesTool(await ensureGraphReady(), root)
          .execute(input as Record<string, unknown>)
          .then((output: string) => {
            const meta = withMeta(output, output)
            recordToolCall({ tool: "get_references", ...meta })
            return {
              title: "get_references",
              metadata: { meta } as Record<string, unknown>,
              output,
            }
          })
      }),
  }),
)

// ---------------------------------------------------------------------------
// search (symbol / literal / regex / task-phrase modes)
// ---------------------------------------------------------------------------

const SearchCodeParameters = Schema.Struct({
  query: Schema.String.annotate({
    description:
      "Symbol name, task phrase, or search pattern. " +
      "Returns lean index by default (signatures, line ranges, caller counts, 15-line preview; no full source). " +
      "Full bodies are cached — follow up with cache_ref to page them in without recompute.",
  }),
  cache_ref: Schema.optional(Schema.String).annotate({
    description:
      "Hash from a prior `_meta.cache_ref` marker — returns the withheld full-body slice " +
      "from local cache (~0ms recompute). Pair with offset/limit to page.",
  }),
  offset: Schema.optional(Schema.Number).annotate({
    description: "0-based slice offset when using cache_ref (default 0).",
  }),
  mode: Schema.optional(Schema.String).annotate({
    description:
      "symbol = ranked name matches; literal = exact string search; regex = regex search; " +
      "glob = filename-pattern matching (query is the glob pattern, path sets the root); " +
      "refs = callers/callees of a named entity (pair with direction). " +
      "Omit for default task-phrase recon.",
  }),
  kind: Schema.optional(Schema.String).annotate({
    description: "Entity kind filter (symbol mode): function | class | type | variable | method | interface.",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Max results (default 20); page size when using cache_ref; cap for refs mode (default 25).",
  }),
  context: Schema.optional(Schema.Number).annotate({
    description: "Context lines per match for literal/regex mode (default 2, max 6).",
  }),
  include_body: Schema.optional(Schema.Boolean).annotate({
    description: "Include full source body for each matched entity (symbol mode).",
  }),
  want: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Attach callers/callees/imports to each result (symbol/task mode).",
  }),
  // glob mode
  path: Schema.optional(Schema.String).annotate({
    description: "Directory to search within (glob mode; defaults to cwd). Absolute or cwd-relative.",
  }),
  // refs mode
  direction: Schema.optional(Schema.String).annotate({
    description: "callers (default) | callees — which direction to traverse the call graph (refs mode).",
  }),
  include_text_occurrences: Schema.optional(Schema.Boolean).annotate({
    description:
      "Also return word-boundary literal matches the call graph cannot see (refs mode, direction=callers). " +
      "Use for RENAME tasks.",
  }),
})

/**
 * `search` tool: unified code-navigation entry point — symbol name
 * matches, content search (literal/regex), filename glob, caller/callee refs,
 * or task-phrase recon bundle. Subsumes recon, grep, glob, and get_references.
 *
 * @sem domain=intelligence role=tools
 */
export const GraphSearchCodeTool = Tool.define(
  "search",
  Effect.gen(function* () {
    const ripgrep = yield* Ripgrep.Service
    return {
    description:
      "Unified code search and navigation. Modes:\n" +
      "  (default) task-phrase recon — entities + callers + notes in one bundle\n" +
      "  symbol    — ranked name matches with signatures and caller counts\n" +
      "  literal   — exact string search with context lines (replaces grep)\n" +
      "  regex     — regex search with context lines (replaces grep)\n" +
      "  glob      — filename-pattern matching; query is the glob pattern (replaces glob tool)\n" +
      "  refs      — callers/callees of a named entity; pair with direction (replaces get_references)\n" +
      "Returns lean index by default — signatures, line ranges, caller counts, 15-line preview. " +
      "Full bodies are cached under _meta.cache_ref; supply cache_ref+offset to page them in. " +
      "ur|rsk lines are emitted for chokepoint entities (fan-in ≥ 10).",
    parameters: SearchCodeParameters,
    execute: (input: Schema.Schema.Type<typeof SearchCodeParameters>, _ctx: Tool.Context) => {
      // cache_ref fast-path: return a withheld full-body slice without recomputing.
      if (input.cache_ref) {
        return Effect.promise(async () => {
          const offset = input.offset ?? 0
          const lim = input.limit ?? 5
          const slice = getSlice(input.cache_ref!, offset, lim)
          if (!slice) {
            return {
              title: "search",
              metadata: {} as Record<string, unknown>,
              output: JSON.stringify({ error: "cache_ref not found; resubmit the original query to recompute" }),
            }
          }
          return {
            title: "search",
            metadata: {} as Record<string, unknown>,
            output: JSON.stringify(
              { cache_ref: input.cache_ref, offset, total: slice.total, more: slice.more, items: slice.slice },
              null,
              2,
            ),
          }
        })
      }

      const root = process.cwd()

      // -----------------------------------------------------------------------
      // glob mode: filename-pattern matching via Glob.scanSync.
      // Subsumes the standalone GlobTool. Does not filter by .gitignore
      // (use searchCode mode:'regex' with an include pattern for that).
      // -----------------------------------------------------------------------
      if (input.mode === "glob") {
        return Effect.promise(async () => {
          const searchDir = input.path ?? root
          const files = Glob.scanSync(input.query, { cwd: searchDir, absolute: true, dot: true })
          const cap = 100
          const truncated = files.length > cap
          const listed = files.slice(0, cap)
          const output =
            listed.length === 0
              ? "No files found"
              : listed.join("\n") +
                (truncated
                  ? `\n\n(Showing first ${cap} of ${files.length} matches. Use a more specific pattern.)`
                  : "")
          const meta = withMeta(output, output)
          recordToolCall({ tool: "search", ...meta })
          return {
            title: "search",
            metadata: { meta, mode: "glob", count: files.length, truncated } as Record<string, unknown>,
            output,
          }
        })
      }

      // -----------------------------------------------------------------------
      // refs mode: callers/callees of a named entity via the in-process graph.
      // Subsumes the standalone GraphGetReferencesTool.
      // -----------------------------------------------------------------------
      if (input.mode === "refs") {
        return Effect.promise(async () => {
          const refsInput: Record<string, unknown> = {
            entity: input.query,
            direction: input.direction ?? "callers",
            limit: input.limit ?? 25,
            include_text_occurrences: input.include_text_occurrences ?? false,
          }
          const output = await makeGetReferencesTool(await ensureGraphReady(), root).execute(refsInput)
          const meta = withMeta(output, output)
          recordToolCall({ tool: "search", ...meta })
          return {
            title: "search",
            metadata: { meta, mode: "refs" } as Record<string, unknown>,
            output,
          }
        })
      }

      return Effect.promise(async () => {
        const rawOutput = await makeSearchCodeTool(await ensureGraphReady(), root).execute(
          input as Record<string, unknown>,
        )

        // Literal/regex modes: content search — try indexed files first, fall back to ripgrep.
        const mode = input.mode
        if (mode === "literal" || mode === "regex") {
          // Trigger ripgrep fallback when the indexed search returned no matches
          let isIndexedEmpty = false
          try {
            const parsed = JSON.parse(rawOutput)
            if (Array.isArray(parsed)) isIndexedEmpty = parsed.length === 0
          } catch { /* rawOutput not JSON */ }
          if (!isIndexedEmpty) isIndexedEmpty = !rawOutput || rawOutput.trim() === ""

          if (isIndexedEmpty) {
            const cwd = input.path ?? root
            const pattern =
              mode === "literal"
                ? input.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
                : input.query
            try {
              const rgResult = await Effect.runPromise(
                ripgrep.grep({ cwd, pattern, limit: 100 }),
              )
              if (rgResult.length > 0) {
                const rows = rgResult.map((item) => ({
                  path: path.resolve(cwd, item.entry.path),
                  line: item.line,
                  text: item.text,
                }))
                const truncated = rows.length === 100
                const lines = [
                  `Found ${rows.length} matches${truncated ? " (more available)" : ""} [ripgrep fallback]`,
                ]
                let current = ""
                for (const match of rows) {
                  if (current !== match.path) {
                    if (current !== "") lines.push("")
                    current = match.path
                    lines.push(`${match.path}:`)
                  }
                  lines.push(`  Line ${match.line}: ${match.text}`)
                }
                if (truncated) lines.push("\n(Results truncated. Use a more specific pattern.)")
                const output = lines.join("\n")
                const meta = withMeta(rawOutput, output)
                recordToolCall({ tool: "search", ...meta })
                return {
                  title: "search",
                  metadata: { meta, mode, fallback: "ripgrep" } as Record<string, unknown>,
                  output,
                }
              }
            } catch { /* ripgrep unavailable — return indexed output */ }
          }

          const meta = withMeta(rawOutput, rawOutput)
          recordToolCall({ tool: "search", ...meta })
          return {
            title: "search",
            metadata: { meta } as Record<string, unknown>,
            output: rawOutput,
          }
        }

        // Symbol / task-phrase modes: enrich entity list with lean-index projection.
        let parsed: unknown
        try { parsed = JSON.parse(rawOutput) } catch {
          const meta = withMeta(rawOutput, rawOutput)
          recordToolCall({ tool: "search", ...meta })
          return { title: "search", metadata: { meta } as Record<string, unknown>, output: rawOutput }
        }

        const isBundle =
          parsed !== null &&
          typeof parsed === "object" &&
          !Array.isArray(parsed) &&
          "entities" in (parsed as object)
        const entityList: LeanEntity[] = isBundle
          ? ((parsed as { entities: unknown[] }).entities as LeanEntity[])
          : Array.isArray(parsed)
            ? (parsed as LeanEntity[])
            : []

        if (entityList.length === 0) {
          const meta = withMeta(rawOutput, rawOutput)
          recordToolCall({ tool: "search", ...meta })
          return { title: "search", metadata: { meta } as Record<string, unknown>, output: rawOutput }
        }

        const queryCacheKey = hashInputs(String(input.query), mode ?? "task")
        const { lean, cacheKey, total, signals } = await enrichEntities(entityList, root, queryCacheKey)

        const leanParsed = isBundle ? { ...(parsed as object), entities: lean } : lean
        const leanJson = JSON.stringify(
          { ...leanParsed, _meta: { cache_ref: cacheKey, total, more: false } },
          null,
          2,
        )
        const signalBlock = signals.length > 0 ? "\n\n" + signals.join("\n") : ""
        const output = leanJson + signalBlock

        const meta = withMeta(rawOutput, output)
        recordToolCall({ tool: "search", ...meta })
        return {
          title: "search",
          metadata: { meta } as Record<string, unknown>,
          output,
        }
      })
    },
  }
  }),
)

// ---------------------------------------------------------------------------
// file_outline
// ---------------------------------------------------------------------------

const FileOutlineParameters = Schema.Struct({
  file_path: Schema.String.annotate({
    description: "File path (absolute or relative to the repo root).",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Max entities to return (default 30, max 100).",
  }),
  token_budget: Schema.optional(Schema.Number).annotate({
    description: "Max response tokens (default 400).",
  }),
})

/**
 * `file_outline` tool: structural outline of a source file — entities (name,
 * kind, line range), import/export list. Backed by the in-process graph with
 * AST fallback during background indexing.
 *
 * @sem domain=intelligence role=tools
 */
export const GraphFileOutlineTool = Tool.define(
  "file_outline",
  Effect.succeed({
    description:
      "Structural outline of a source file — entities (name, kind, line range), import/export list. " +
      "Call before reading large files; pair with read(entity:) for targeted access.",
    parameters: FileOutlineParameters,
    execute: (input: Schema.Schema.Type<typeof FileOutlineParameters>, _ctx: Tool.Context) => {
      const root = process.cwd()
      return Effect.promise(async () =>
        makeFileOutlineTool(await ensureGraphReady(), root)
          .execute(input as Record<string, unknown>)
          .then((output: string) => {
            const meta = withMeta(output, output)
            recordToolCall({ tool: "file_outline", ...meta })
            return {
              title: "file_outline",
              metadata: { meta } as Record<string, unknown>,
              output,
            }
          }),
      )
    },
  }),
)
