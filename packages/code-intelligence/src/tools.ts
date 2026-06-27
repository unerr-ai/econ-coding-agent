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
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

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
 *
 * @sem domain=intelligence role=tools
 */
export function makeGetReferencesTool(graph: CodeIntelligence): GraphToolDef {
  return {
    id: "get_references",
    description:
      "Return the caller list (fan-in) or callee list (outgoing imports/calls) for a named entity. " +
      "Use direction='callers' to see blast radius; use 'callees' to see dependencies.",
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
      },
      required: ["entity"],
    },
    execute: async (input) => {
      const inp = input as { entity?: unknown; direction?: unknown }
      const entityKey = String(inp.entity ?? "")
      const direction = String(inp.direction ?? "callers")

      const refs =
        direction === "callees"
          ? await graph.getReferences(entityKey)
          : await graph.getCallers(entityKey)

      return JSON.stringify(refs, null, 2)
    },
  }
}
