/**
 * Retrieval-augmented slice wiring (OL-7.7, plan §4.5): resolves a slice's
 * identifier-shaped tokens to graph entities — the same source OL-3.3's
 * probeTurnRisk uses — and renders each with its callers/blast-radius and
 * signature so a child session gets the coupling instead of guessing it.
 * Hard token-capped and greedy-truncated with an explicit marker: context
 * dilution degrades accuracy even with perfect retrieval (plan F11), so this
 * is a bounded fact sheet, never a document dump. Never throws — a cold
 * graph or any lookup error yields an empty wiring block.
 *
 * @sem domain=intelligence role=utilities
 */

import { estimateTokens } from "./trim.js"
import type { Entity, Reference } from "./index.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Minimal graph surface assembleSliceWiring needs. Satisfied by
 * BunSqliteGraph (and any richer CodeIntelligence backend) without importing
 * the full port interface — keeps this module's dependency surface narrow.
 */
export interface SliceWiringGraph {
  search(query: string, limit?: number): Promise<Entity[]>
  getCallers(entityKey: string): Promise<Reference[]>
}

/** Inputs describing one slice to wire up with deterministic graph facts. */
export interface SliceWiringInput {
  /** The slice's task/prompt text — tokenized to find candidate entities. */
  readonly text: string
  /** File paths named by the slice; basenames are tokenized too. */
  readonly files?: readonly string[]
  /** Entity names/keys named by the slice — searched directly, ranked first. */
  readonly entities?: readonly string[]
  /** Target token budget for the rendered wiring block (default 2 500). */
  readonly tokenBudget?: number
  /**
   * Unknowns the caller flags as needing an external (web) lookup rather
   * than a graph fact. Rendered as a bounded placeholder instructing the
   * child to do its own bounded web lookup — this module never performs
   * the lookup itself.
   */
  readonly externalUnknowns?: readonly string[]
}

/** Rendered wiring block plus size accounting. */
export interface SliceWiringResult {
  /** Compact wiring text block; empty string when nothing resolved. */
  readonly text: string
  /** Estimated tokens in `text`. */
  readonly estimatedTokens: number
  /** True when entities/callers were dropped to fit the token budget. */
  readonly truncated: boolean
  /** Count of entities included in the rendered block. */
  readonly entityCount: number
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** Default hard cap on the rendered wiring block (plan §6 OL-7.7: ~2-3k tokens). */
export const DEFAULT_WIRING_TOKEN_BUDGET = 2_500

/** Top entities the wiring assembler resolves for one slice. */
const WIRING_ENTITY_LIMIT = 8
/** Callers rendered per entity before collapsing into a "+N more" tail. */
const WIRING_CALLERS_PER_ENTITY = 5
/** Prompt tokens below this length aren't worth a graph lookup. */
const WIRING_TOKEN_MIN_LEN = 4
/** Bound the number of tokens the assembler searches, capping cost. */
const WIRING_MAX_TOKENS = 16
/** External unknowns rendered before collapsing into a "+N more" tail. */
const WIRING_EXTERNAL_UNKNOWN_LIMIT = 5

/**
 * Generic english/coding words that would match unrelated hubs and inflate
 * the wiring for slices that don't actually name dangerous code. Mirrors the
 * OL-3.3 risk-probe stoplist so slice text and turn-risk prompts tokenize
 * the same way.
 */
const WIRING_TOKEN_STOPLIST = new Set([
  "this", "that", "then", "with", "from", "into", "your", "there", "here", "when", "what", "which",
  "please", "make", "change", "update", "refactor", "implement", "function", "class", "method",
  "file", "files", "code", "test", "tests", "type", "types", "value", "return", "async", "await",
])

/**
 * Identifier-shaped tokens worth resolving against the graph. Splits on
 * non-identifier characters and dotted refs (Tool.define → Tool, define),
 * drops short tokens and the stoplist, dedupes case-insensitively, and caps
 * the count — graph.search matches symbol names, not sentences.
 *
 * @sem domain=intelligence role=utilities
 */
function candidateWiringTokens(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.split(/[^A-Za-z0-9_.]+/)) {
    for (const tok of raw.split(".")) {
      const t = tok.trim()
      if (t.length < WIRING_TOKEN_MIN_LEN) continue
      const lower = t.toLowerCase()
      if (WIRING_TOKEN_STOPLIST.has(lower) || seen.has(lower)) continue
      seen.add(lower)
      out.push(t)
      if (out.length >= WIRING_MAX_TOKENS) return out
    }
  }
  return out
}

/** Strips directory + extension so a file path can seed a name search. */
function basenameToken(filePath: string): string {
  const file = filePath.split("/").pop() ?? filePath
  return file.replace(/\.[A-Za-z0-9]+$/, "")
}

/**
 * Resolve the slice's explicit entities/files and its tokenized text against
 * the graph, deduping by entity key and capping at WIRING_ENTITY_LIMIT.
 * Explicit `entities`/`files` are searched first so a caller-named target
 * always ranks ahead of an incidental text mention.
 */
async function resolveEntities(graph: SliceWiringGraph, input: SliceWiringInput): Promise<Entity[]> {
  const byKey = new Map<string, Entity>()
  const seedTokens = [
    ...(input.entities ?? []),
    ...(input.files ?? []).map(basenameToken),
    ...candidateWiringTokens(input.text),
  ]
  for (const tok of seedTokens) {
    if (byKey.size >= WIRING_ENTITY_LIMIT) break
    if (!tok) continue
    const matches = await graph.search(tok, 3)
    for (const e of matches) {
      if (!byKey.has(e.key)) byKey.set(e.key, e)
      if (byKey.size >= WIRING_ENTITY_LIMIT) break
    }
  }
  return [...byKey.values()]
}

/**
 * Dedupe caller edges before counting: one caller file can contribute BOTH a
 * file-level import edge (fromEntity="") and a named call edge for the same
 * target, which describe the same dependency, not two callers. Drops the
 * import-only edge when a named call edge from the same file is present;
 * distinct named callers within one file are preserved.
 */
function dedupeCallerRefs(refs: Reference[]): Reference[] {
  const byFile = new Map<string, Map<string, Reference>>()
  for (const ref of refs) {
    let group = byFile.get(ref.fromFile)
    if (!group) {
      group = new Map()
      byFile.set(ref.fromFile, group)
    }
    if (!group.has(ref.fromEntity)) group.set(ref.fromEntity, ref)
  }
  const out: Reference[] = []
  for (const group of byFile.values()) {
    const hasNamedCaller = [...group.keys()].some((k) => k !== "")
    for (const [fromEntity, ref] of group) {
      if (hasNamedCaller && fromEntity === "") continue
      out.push(ref)
    }
  }
  return out
}

function renderCallers(callers: Reference[]): string {
  if (callers.length === 0) return "Callers: none found"
  const shown = callers.slice(0, WIRING_CALLERS_PER_ENTITY)
  const rendered = shown.map((c) => `${c.fromEntity} (${c.fromFile})`).join(", ")
  const extra = callers.length - shown.length
  return `Callers (${callers.length}): ${rendered}${extra > 0 ? ` [+${extra} more]` : ""}`
}

async function renderEntityBlock(graph: SliceWiringGraph, entity: Entity): Promise<string> {
  const lines = [`### ${entity.kind} \`${entity.name}\` — ${entity.filePath}:${entity.lineStart}-${entity.lineEnd}`]
  if (entity.signature) lines.push(`Signature: ${entity.signature}`)
  if (entity.domain) lines.push(`Domain: ${entity.domain}`)
  let callers: Reference[] = []
  try {
    // Deduped: one caller file can contribute both an import edge and a call
    // edge for the same target, which is one dependency, not two.
    callers = dedupeCallerRefs(await graph.getCallers(entity.key))
  } catch {
    callers = []
  }
  lines.push(renderCallers(callers))
  return lines.join("\n")
}

function renderExternalUnknowns(unknowns: readonly string[]): string {
  const shown = unknowns.slice(0, WIRING_EXTERNAL_UNKNOWN_LIMIT)
  const lines = [
    "## External Unknowns",
    "The graph has no facts for these — do your own bounded web lookup before guessing:",
    ...shown.map((u) => `- ${u}`),
  ]
  const extra = unknowns.length - shown.length
  if (extra > 0) lines.push(`- [+${extra} more, unlisted]`)
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// assembleSliceWiring
// ---------------------------------------------------------------------------

/**
 * Assemble the deterministic-wiring block for one slice: resolve its
 * identifier-shaped tokens to graph entities, render each with its
 * callers/blast-radius and signature, greedily fit the rendered blocks into
 * a hard token cap, and truncate with an explicit `[wiring truncated]`
 * marker rather than dumping the whole graph neighbourhood. Never throws —
 * a cold graph, an index that isn't ready, or any lookup error all degrade
 * to an empty wiring block so the caller's fallback (today's un-wired
 * behavior) always has a safe value to fall back to.
 *
 * @sem domain=intelligence role=utilities
 */
export async function assembleSliceWiring(
  input: SliceWiringInput,
  graph: SliceWiringGraph,
): Promise<SliceWiringResult> {
  try {
    const budget = Math.max(input.tokenBudget ?? DEFAULT_WIRING_TOKEN_BUDGET, 200)
    const entities = await resolveEntities(graph, input)

    const blocks: string[] = []
    let used = 0
    let truncated = false
    let includedCount = 0
    for (const entity of entities) {
      let block: string
      try {
        block = await renderEntityBlock(graph, entity)
      } catch {
        continue
      }
      const blockTokens = estimateTokens(block)
      if (used + blockTokens > budget) {
        truncated = true
        break
      }
      blocks.push(block)
      used += blockTokens
      includedCount++
    }
    if (includedCount < entities.length) truncated = true

    const parts: string[] = []
    if (blocks.length > 0) parts.push("## Wiring (deterministic graph facts)", blocks.join("\n\n"))
    if (truncated) parts.push("[wiring truncated — token cap reached, remaining entities omitted]")
    if (input.externalUnknowns && input.externalUnknowns.length > 0) {
      parts.push(renderExternalUnknowns(input.externalUnknowns))
    }

    const text = parts.join("\n\n")
    return { text, estimatedTokens: estimateTokens(text), truncated, entityCount: includedCount }
  } catch {
    return { text: "", estimatedTokens: 0, truncated: false, entityCount: 0 }
  }
}
