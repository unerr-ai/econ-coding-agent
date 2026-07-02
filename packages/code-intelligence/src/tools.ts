/**
 * Framework-agnostic econ graph-tool definitions: recon, file_read,
 * get_references. Each builder accepts a CodeIntelligence instance and
 * returns a plain object ({id, description, inputSchema, execute}) so any
 * host framework can wrap it into its own tool registration format without
 * importing from opencode or Effect.
 *
 * @sem domain=intelligence role=tools
 */

import type { CodeIntelligence } from "./index.js"
import { readFile, readdir } from "node:fs/promises"
import { resolve, join, relative } from "node:path"
import { detectLanguage, extractEntities } from "./ast-extractor.js"

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".turbo", "out", "coverage"])

/** Walk source files (same filter as BunSqliteGraph.index) for content search. */
async function walkSourceFiles(dir: string, results: string[]): Promise<void> {
  let entries: import("node:fs").Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const name = String(entry.name)
    if (name.startsWith(".") || SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    if (entry.isDirectory()) {
      await walkSourceFiles(full, results)
    } else if (entry.isFile() && detectLanguage(name) !== null) {
      results.push(full)
    }
  }
}

// ---------------------------------------------------------------------------
// Shared interface (no external deps)
// ---------------------------------------------------------------------------

/**
 * Minimal framework-agnostic tool definition. Host frameworks (e.g. opencode)
 * wrap this into their own Tool.define() shape.
 *
 * @sem domain=intelligence role=interface
 */
export interface GraphToolDef {
  readonly id: string
  readonly description: string
  readonly inputSchema: {
    readonly type: string
    readonly properties: Record<string, unknown>
    readonly required?: string[]
  }
  readonly execute: (input: Record<string, unknown>) => Promise<string>
}

// ---------------------------------------------------------------------------
// recon
// ---------------------------------------------------------------------------

/**
 * Build the `recon` tool definition backed by the given graph. Returns the
 * recon bundle (entities + references + notes) for a natural-language task phrase.
 *
 * @sem domain=intelligence role=tools
 */
export function makeReconTool(graph: CodeIntelligence): GraphToolDef {
  return {
    id: "recon",
    description:
      "Return a recon bundle for a natural-language task phrase: the most relevant " +
      "code entities, their references, and anchored notes in one shot — replacing " +
      "the search→read→search fan-out.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Natural-language task phrase describing what you need to do.",
        },
      },
      required: ["task"],
    },
    execute: async (input) => {
      const task = String((input as { task?: unknown }).task ?? "")
      const bundle = await graph.recon(task)
      return JSON.stringify(bundle, null, 2)
    },
  }
}

// ---------------------------------------------------------------------------
// file_read
// ---------------------------------------------------------------------------

/**
 * Build the `file_read` tool definition. If entity is given, returns the
 * entity profile from the graph; otherwise reads raw file content from disk
 * with cat-n style line numbers.
 *
 * @sem domain=intelligence role=tools
 */
export function makeFileReadTool(graph: CodeIntelligence, repoRoot: string): GraphToolDef {
  return {
    id: "file_read",
    description:
      "Read a source file from disk (with 1-based line numbers) or retrieve an entity's " +
      "profile (signature, lines, kind) from the in-process graph by entity name.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path (absolute or relative to the repo root).",
        },
        entity: {
          type: "string",
          description:
            "Optional entity name; if provided returns the entity profile instead of raw source.",
        },
      },
      required: ["path"],
    },
    execute: async (input) => {
      const inp = input as { path?: unknown; entity?: unknown }
      const filePath = String(inp.path ?? "")
      const entity = inp.entity ? String(inp.entity) : undefined

      if (entity) {
        const e = await graph.getEntity(entity)
        if (e) return JSON.stringify(e, null, 2)
        return `Entity not found in graph: ${entity}`
      }

      const abs = filePath.startsWith("/") ? filePath : resolve(repoRoot, filePath)
      const content = await readFile(abs, "utf8")
      // cat -n style output: 1-based line numbers separated by tab
      return content
        .split("\n")
        .map((line, i) => `${String(i + 1).padStart(4)}\t${line}`)
        .join("\n")
    },
  }
}

// ---------------------------------------------------------------------------
// get_references
// ---------------------------------------------------------------------------

/**
 * Build the `get_references` tool definition. Returns the caller list
 * (direction='callers', the default) or callee list for a named entity.
 * Optional `repoRoot` enables `include_text_occurrences` (word-boundary
 * literal scan across source files, for rename workflows).
 *
 * @sem domain=intelligence role=tools
 */
export function makeGetReferencesTool(graph: CodeIntelligence, repoRoot?: string): GraphToolDef {
  return {
    id: "get_references",
    description:
      "Return the caller list (fan-in) or callee list (outgoing imports/calls) for a named entity. " +
      "Use direction='callers' to see blast radius; use 'callees' to see dependencies. " +
      "Set include_text_occurrences=true for a rename to also surface word-boundary text matches " +
      "the call graph cannot see (test strings, config keys, dynamic dispatch).",
    inputSchema: {
      type: "object",
      properties: {
        entity: {
          type: "string",
          description: "Entity name or stable key (<filePath>:<name>:<kind>).",
        },
        direction: {
          type: "string",
          enum: ["callers", "callees"],
          description:
            "callers = who calls/imports this entity (fan-in); callees = what this entity calls/imports.",
        },
        limit: {
          type: "number",
          description: "Max references to return (default 25).",
        },
        include_text_occurrences: {
          type: "boolean",
          description:
            "Default false. Set true for a RENAME — also returns word-boundary literal matches of " +
            "the entity name that the call graph cannot see. Only applies with direction:'callers'.",
        },
      },
      required: ["entity"],
    },
    execute: async (input) => {
      const inp = input as {
        entity?: unknown
        direction?: unknown
        limit?: unknown
        include_text_occurrences?: unknown
      }
      const entityKey = String(inp.entity ?? "")
      const direction = String(inp.direction ?? "callers")
      const limit = inp.limit ? Number(inp.limit) : 25
      const includeText = Boolean(inp.include_text_occurrences)

      const allRefs =
        direction === "callees"
          ? await graph.getReferences(entityKey)
          : await graph.getCallers(entityKey)

      const refs = allRefs.slice(0, limit)

      if (includeText && direction === "callers" && repoRoot && entityKey) {
        // Strip key format to bare name for word-boundary search
        const entityName = entityKey.includes(":")
          ? (entityKey.split(":")[1] ?? entityKey)
          : entityKey
        let re: RegExp
        try {
          re = new RegExp(`\\b${entityName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`)
        } catch {
          return JSON.stringify({ references: refs, text_occurrences: [] }, null, 2)
        }

        const files: string[] = []
        await walkSourceFiles(repoRoot, files)

        const textOccurrences: Array<{ file: string; line: number; text: string }> = []
        for (const file of files) {
          const content = await readFile(file, "utf8").catch(() => "")
          const lines = content.split("\n")
          for (let i = 0; i < lines.length; i++) {
            re.lastIndex = 0
            if (re.test(lines[i] ?? "")) {
              textOccurrences.push({
                file: relative(repoRoot, file),
                line: i + 1,
                text: (lines[i] ?? "").trim().slice(0, 200),
              })
            }
          }
        }

        return JSON.stringify({ references: refs, text_occurrences: textOccurrences }, null, 2)
      }

      return JSON.stringify(refs, null, 2)
    },
  }
}

// ---------------------------------------------------------------------------
// search_code
// ---------------------------------------------------------------------------

/**
 * Build the `search_code` tool definition. Supports four modes:
 * - default (no mode): natural-language task phrase → recon bundle
 * - "symbol": ranked entity name/partial matches with optional kind filter
 * - "literal": exact string content search across indexed files
 * - "regex": regex content search across indexed files
 * Symbol and task modes support `want` (callers/callees/imports) and `include_body`.
 *
 * @sem domain=intelligence role=tools
 */
export function makeSearchCodeTool(graph: CodeIntelligence, repoRoot: string): GraphToolDef {
  return {
    id: "search_code",
    description:
      "Search code by symbol name (mode:'symbol'), exact string (mode:'literal'), regex pattern " +
      "(mode:'regex'), or natural-language task phrase (default, no mode). " +
      "Symbol/task modes support want:['callers','callees','imports'] and include_body. " +
      "Literal/regex modes return each match with surrounding context lines.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Symbol name, task phrase, or search pattern (for literal/regex mode).",
        },
        mode: {
          type: "string",
          enum: ["symbol", "literal", "regex"],
          description:
            "symbol = ranked entity name matches; literal = exact string search; regex = regex search. " +
            "Omit for default task-phrase recon.",
        },
        kind: {
          type: "string",
          enum: ["function", "class", "type", "variable", "method", "interface"],
          description: "Filter by entity kind (symbol mode only).",
        },
        limit: {
          type: "number",
          description: "Max results (default 20).",
        },
        context: {
          type: "number",
          description: "Context lines per match for literal/regex mode (default 2, max 6).",
        },
        include_body: {
          type: "boolean",
          description: "Include full source body for each matched entity (symbol mode).",
          default: false,
        },
        want: {
          type: "array",
          items: { type: "string", enum: ["callers", "callees", "imports"] },
          description: "Attach callers/callees/file-imports to each result entity (symbol/task mode).",
        },
      },
      required: ["query"],
    },
    execute: async (input) => {
      const inp = input as {
        query?: unknown
        mode?: unknown
        kind?: unknown
        limit?: unknown
        context?: unknown
        include_body?: unknown
        want?: unknown
      }
      const query = String(inp.query ?? "")
      const mode = inp.mode ? String(inp.mode) : undefined
      const kind = inp.kind ? String(inp.kind) : undefined
      const limit = inp.limit ? Number(inp.limit) : 20
      const contextLines = Math.min(inp.context ? Number(inp.context) : 2, 6)
      const includeBody = Boolean(inp.include_body)
      const want: string[] = Array.isArray(inp.want) ? (inp.want as string[]) : []

      // -----------------------------------------------------------------------
      // Symbol mode: ranked entity name/partial matches
      // -----------------------------------------------------------------------
      if (mode === "symbol") {
        let entities = await graph.search(query, limit)
        if (kind) entities = entities.filter((e) => e.kind === kind)

        const results = await Promise.all(
          entities.map(async (e) => {
            const extra: Record<string, unknown> = {}

            // Always read source file once — used for preview, body, and imports.
            const abs = e.filePath.startsWith("/") ? e.filePath : join(repoRoot, e.filePath)
            const fileContent = await readFile(abs, "utf8").catch(() => "")
            const fileLines = fileContent.split("\n")
            const entityLines = fileLines.slice(e.lineStart - 1, e.lineEnd)

            // Lean-index P0: always include caller count + first-15-line preview.
            const callers = await graph.getCallers(e.name)
            extra.caller_count = callers.length
            extra.preview = entityLines.slice(0, 15).join("\n")

            // Full body only when explicitly requested.
            if (includeBody) {
              extra.body = entityLines.join("\n")
            }
            if (want.includes("callers")) {
              extra.callers = callers
            }
            if (want.includes("callees")) {
              extra.callees = await graph.getReferences(e.name)
            }
            if (want.includes("imports")) {
              extra.imports = fileContent
                .split("\n")
                .slice(0, 200)
                .filter((l) => /^import\s/.test(l.trim()))
                .slice(0, 30)
            }
            return { ...e, ...extra }
          }),
        )
        return JSON.stringify(results, null, 2)
      }

      // -----------------------------------------------------------------------
      // Content-search modes: literal and regex
      // -----------------------------------------------------------------------
      if (mode === "literal" || mode === "regex") {
        const pattern =
          mode === "literal" ? query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : query
        let re: RegExp
        try {
          re = new RegExp(pattern)
        } catch {
          return JSON.stringify({ error: `Invalid regex: ${query}` }, null, 2)
        }

        const files: string[] = []
        await walkSourceFiles(repoRoot, files)

        const matches: Array<{
          file: string
          line: number
          match: string
          context: string[]
        }> = []

        for (const file of files) {
          if (matches.length >= limit) break
          const content = await readFile(file, "utf8").catch(() => "")
          const lines = content.split("\n")
          for (let i = 0; i < lines.length; i++) {
            re.lastIndex = 0
            if (!re.test(lines[i] ?? "")) continue
            const start = Math.max(0, i - contextLines)
            const end = Math.min(lines.length - 1, i + contextLines)
            const ctx: string[] = []
            for (let j = start; j <= end; j++) {
              ctx.push(`${j + 1}${j === i ? " →" : "  "}\t${lines[j] ?? ""}`)
            }
            matches.push({
              file: relative(repoRoot, file),
              line: i + 1,
              match: lines[i] ?? "",
              context: ctx,
            })
            if (matches.length >= limit) break
          }
        }

        return JSON.stringify(matches, null, 2)
      }

      // -----------------------------------------------------------------------
      // Default: task-phrase recon bundle — enrich entities with lean-index fields
      // -----------------------------------------------------------------------
      const bundle = await graph.recon(query)

      // Lean-index P0: enrich each bundle entity with caller_count + preview.
      const enrichedEntities = await Promise.all(
        bundle.entities.slice(0, limit).map(async (e) => {
          const abs = e.filePath.startsWith("/") ? e.filePath : join(repoRoot, e.filePath)
          const fileContent = await readFile(abs, "utf8").catch(() => "")
          const fileLines = fileContent.split("\n")
          const entityLines = fileLines.slice(e.lineStart - 1, e.lineEnd)
          const callers = await graph.getCallers(e.name)
          return {
            ...e,
            caller_count: callers.length,
            preview: entityLines.slice(0, 15).join("\n"),
          }
        }),
      )
      const enrichedBundle = { ...bundle, entities: enrichedEntities }

      if (want.length > 0) {
        const extras: Record<string, unknown> = { ...enrichedBundle }
        if (want.includes("callers")) {
          const callersMap: Record<string, unknown> = {}
          for (const e of enrichedEntities) {
            callersMap[e.name] = await graph.getCallers(e.name)
          }
          extras.callers = callersMap
        }
        if (want.includes("callees")) {
          const calleesMap: Record<string, unknown> = {}
          for (const e of enrichedEntities) {
            calleesMap[e.name] = await graph.getReferences(e.name)
          }
          extras.callees = calleesMap
        }
        return JSON.stringify(extras, null, 2)
      }

      return JSON.stringify(enrichedBundle, null, 2)
    },
  }
}

// ---------------------------------------------------------------------------
// file_outline
// ---------------------------------------------------------------------------

/**
 * Build the `file_outline` tool definition. Returns a structural outline:
 * entities (name, kind, line range), imports, and exports. Uses graph-backed
 * entities when available; falls back to AST extraction during background indexing.
 *
 * @sem domain=intelligence role=tools
 */
export function makeFileOutlineTool(graph: CodeIntelligence, repoRoot: string): GraphToolDef {
  return {
    id: "file_outline",
    description:
      "Structural outline of a source file — entities (name, kind, line range), import/export list. " +
      "Call before reading large files; pair with graph_file_read(entity:) to drill into one entity.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "File path (absolute or relative to the repo root).",
        },
        limit: {
          type: "number",
          description: "Max entities to return (default 30, max 100).",
        },
        token_budget: {
          type: "integer",
          description: "Max response tokens (default 400).",
        },
      },
      required: ["file_path"],
    },
    execute: async (input) => {
      const inp = input as { file_path?: unknown; limit?: unknown }
      const filePath = String(inp.file_path ?? "")
      const maxEntities = Math.min(inp.limit ? Number(inp.limit) : 30, 100)

      const abs = filePath.startsWith("/") ? filePath : resolve(repoRoot, filePath)
      const rel = filePath.startsWith("/") ? relative(repoRoot, filePath) : filePath

      const content = await readFile(abs, "utf8").catch(() => null)
      if (content === null) return `File not found: ${filePath}`

      const fileLines = content.split("\n")
      const total_lines = fileLines.length

      // Prefer graph entities (enriched with risk/callers); fall back to AST
      const graphEntities = await graph.getEntitiesInFile(abs)

      let entityRows: Array<{ name: string; kind: string; lines: [number, number] }>
      if (graphEntities.length > 0) {
        entityRows = graphEntities
          .sort((a, b) => a.lineStart - b.lineStart || a.name.localeCompare(b.name))
          .slice(0, maxEntities)
          .map((e) => ({ name: e.name, kind: e.kind, lines: [e.lineStart, e.lineEnd] as [number, number] }))
      } else {
        const lang = detectLanguage(rel) ?? "unknown"
        if (lang !== "unknown") {
          const extracted = extractEntities(content, rel)
          entityRows = extracted
            .slice(0, maxEntities)
            .map((e) => ({ name: e.name, kind: e.kind, lines: [e.lineStart, e.lineEnd] as [number, number] }))
        } else {
          entityRows = []
        }
      }

      // Collect import and export statements from the first 400 lines
      const imports: string[] = []
      const exports: string[] = []
      const scan = Math.min(fileLines.length, 400)
      for (let i = 0; i < scan; i++) {
        const t = (fileLines[i] ?? "").trim()
        if (/^import\s/.test(t)) imports.push(t.slice(0, 160))
        else if (/^export\s/.test(t)) exports.push(t.slice(0, 160))
      }

      return JSON.stringify(
        {
          file_path: rel,
          total_lines,
          entities: entityRows,
          imports: imports.slice(0, 40),
          exports: exports.slice(0, 40),
        },
        null,
        2,
      )
    },
  }
}
