/**
 * Sprint 2B lean-index enrichment: reads entity source files to build body
 * previews, caches full bodies for cache_ref pagination, and derives ur|rsk
 * signals from caller counts. Separated from graph-tools.ts (which carries
 * Effect) so the logic can be unit-tested without the Effect runtime.
 *
 * @sem domain=intelligence role=tools
 */
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { hashInputs, put } from "./_shared"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Caller count at or above which a ur|rsk chokepoint signal is emitted. */
export const RSK_CALLER_THRESHOLD = 10

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal entity shape expected from code-intelligence lean output. */
export interface LeanEntity {
  key?: string
  name: string
  kind: string
  filePath: string
  lineStart: number
  lineEnd: number
  /** Already computed by tools.ts lean projection (caller count). */
  caller_count?: number
  /** Already computed by tools.ts lean projection (15-line preview). */
  preview?: string
  [k: string]: unknown
}

/** Result of a single enrichEntities call. */
export interface EnrichResult {
  /** Entity list with preview ensured; full body NOT included. */
  lean: LeanEntity[]
  /** Cache key for the _shared full-body store — expose as `_meta.cache_ref`. */
  cacheKey: string
  /** Count of entity bodies stored (= `lean.length` when all files readable). */
  total: number
  /** `ur|` signal lines to append after the JSON output. */
  signals: string[]
}

// ---------------------------------------------------------------------------
// enrichEntities
// ---------------------------------------------------------------------------

/**
 * Enrich a lean entity list for token-optimised output: ensures each entity
 * has a `preview` (first 15 source lines), stores full bodies in the _shared
 * cache keyed by `hashInputs(queryCacheKey, "full_bodies")` for cache_ref
 * pagination, and emits a `ur|rsk` line for every entity whose caller_count
 * meets or exceeds RSK_CALLER_THRESHOLD.
 *
 * @sem domain=intelligence role=tools
 */
export async function enrichEntities(
  entities: LeanEntity[],
  root: string,
  queryCacheKey: string,
): Promise<EnrichResult> {
  const signals: string[] = []

  // Collected per entity and assembled AFTER the Promise.all — pushing from
  // inside the async callbacks would order pages by file-read completion,
  // making cache_ref pagination nondeterministic under load.
  const bodyByIndex: Array<{ key: string; body: string }> = new Array(entities.length)

  const lean = await Promise.all(
    entities.map(async (e, index) => {
      const abs = (e.filePath ?? "").startsWith("/")
        ? e.filePath
        : join(root, e.filePath ?? "")

      const content = await readFile(abs, "utf8").catch(() => "")
      const lines = content.split("\n")
      const entityLines = lines.slice(Math.max(0, (e.lineStart ?? 1) - 1), e.lineEnd ?? 0)
      const body = entityLines.join("\n")

      // tools.ts already computes preview; compute here as fallback.
      const preview = (typeof e.preview === "string" && e.preview.length > 0)
        ? e.preview
        : entityLines.slice(0, 15).join("\n")

      const entityKey = typeof e.key === "string" && e.key.length > 0
        ? e.key
        : `${e.filePath}:${e.name}:${e.kind}`
      bodyByIndex[index] = { key: entityKey, body }

      const callerCount = typeof e.caller_count === "number" ? e.caller_count : 0
      if (callerCount >= RSK_CALLER_THRESHOLD) {
        signals.push(
          `ur|rsk [chokepoint] e:${e.name} has ${callerCount} callers — high blast radius; call get_references before editing`,
        )
      }

      // Return lean entity: preview present, full body excluded.
      const { body: _dropBody, ...rest } = { ...e, body: undefined } as Record<string, unknown>
      void _dropBody
      return { ...rest, preview } as LeanEntity
    }),
  )

  const fullBodies = bodyByIndex.filter(Boolean)
  const cacheKey = hashInputs(queryCacheKey, "full_bodies")
  put(cacheKey, fullBodies)

  return { lean, cacheKey, total: fullBodies.length, signals }
}

// ---------------------------------------------------------------------------
// get_references row building (G1 — direct model-facing callers/callees)
// ---------------------------------------------------------------------------

/** Row cap applied when the caller passes no explicit `limit`. */
export const REFS_ROW_CAP_DEFAULT = 25
/** Hop-1 rows expanded into a depth-2 walk — bounds total graph queries a depth:2 call makes (mirrors the F20 hop-file cap in session/regression-neighbors.ts). */
export const REFS_HOP_EXPAND_CAP = 8

/** Minimal entity shape a get_references row is built from — a code-intelligence `Entity` satisfies this structurally. */
export interface RefEntity {
  name: string
  kind: string
  filePath: string
  lineStart: number
  domain?: string
  role?: string
  summary?: string
}

/** A single reference edge — a code-intelligence `Reference` satisfies this structurally. */
export interface RefEdge {
  fromEntity: string
  fromFile: string
  toEntity: string
  kind: string
}

/** Graph port `buildReferenceRows` needs; `BunSqliteGraph` satisfies this structurally, kept local so this stays unit-testable without the Effect runtime or a real graph. */
export interface RefGraphPort {
  getEntity(key: string): Promise<RefEntity | null>
  getEntitiesInFile(filePath: string): Promise<RefEntity[]>
  getCallers(entityKey: string): Promise<RefEdge[]>
  getReferences(entityKey: string): Promise<RefEdge[]>
}

/** One resolved get_references output row. */
export interface ReferenceRow {
  file: string
  line: number
  name: string
  kind: string
  fan_in: number
  domain?: string
  role?: string
  summary?: string
  chokepoint?: boolean
  hop: 1 | 2
}

/**
 * Drops a duplicate import+call edge pair from the same file/name — one
 * caller file can contribute both edge kinds for the same relationship,
 * which is one caller, not two. An unnamed module-level import edge
 * (`fromEntity === ""`) is dropped once a named caller from the same file is
 * present. Mirrors the per-file `dedupeCallerRefs` helper duplicated across
 * code-intelligence's fan-in call sites (tools.ts, risk.ts, edit-impact.ts,
 * slice-wiring.ts) — kept local rather than imported to preserve this file's
 * no-code-intelligence-import decoupling.
 */
function dedupeRefEdges(refs: RefEdge[]): RefEdge[] {
  const byFile = new Map<string, Map<string, RefEdge>>()
  for (const ref of refs) {
    let group = byFile.get(ref.fromFile)
    if (!group) {
      group = new Map()
      byFile.set(ref.fromFile, group)
    }
    if (!group.has(ref.fromEntity)) group.set(ref.fromEntity, ref)
  }
  const out: RefEdge[] = []
  for (const group of byFile.values()) {
    const hasNamedCaller = [...group.keys()].some((k) => k !== "")
    for (const [fromEntity, ref] of group) {
      if (hasNamedCaller && fromEntity === "") continue
      out.push(ref)
    }
  }
  return out
}

/**
 * Builds the get_references model-facing row set: resolves each caller/callee
 * edge to its full entity (file:line, kind, semantic fields), computes that
 * entity's own fan-in for a chokepoint marker (>= RSK_CALLER_THRESHOLD), and
 * — for depth:2 — walks one more hop from a capped subset of hop-1 entities.
 * A visited-set (by entity key) is the cycle guard; a hard row cap bounds
 * total output regardless of depth. An unresolved entity or a graph query
 * failure degrades that row/hop to empty rather than throwing.
 *
 * @sem domain=intelligence role=tools
 */
export async function buildReferenceRows(opts: {
  graph: RefGraphPort
  entityKey: string
  direction: "callers" | "callees"
  depth?: number
  limit?: number
}): Promise<{ rows: ReferenceRow[]; truncated: boolean; signals: string[] }> {
  const { graph, entityKey, direction } = opts
  const depth = Math.min(Math.max(opts.depth ?? 1, 1), 2)
  const rowCap = Math.max(1, opts.limit ?? REFS_ROW_CAP_DEFAULT)

  // Cycle guard: every entity key already emitted (seeded with the origin so
  // a caller/callee cycle that loops back to the queried entity is dropped).
  const visited = new Set<string>()
  const origin = await graph.getEntity(entityKey).catch(() => null)
  if (origin) visited.add(`${origin.filePath}:${origin.name}:${origin.kind}`)

  const rows: ReferenceRow[] = []
  const signals: string[] = []
  let truncated = false

  async function resolve(name: string, file: string | undefined): Promise<RefEntity | null> {
    if (file) {
      const inFile = await graph.getEntitiesInFile(file).catch(() => [])
      const hit = inFile.find((e) => e.name === name)
      if (hit) return hit
    }
    // callees carry no `toFile` (the edge table doesn't record it) — best-effort bare-name lookup.
    return graph.getEntity(name).catch(() => null)
  }

  async function fanInFor(entity: RefEntity): Promise<number> {
    const key = `${entity.filePath}:${entity.name}:${entity.kind}`
    const callers = await graph.getCallers(key).catch(() => [])
    return dedupeRefEdges(callers).length
  }

  function toRow(entity: RefEntity, edgeKind: string, fanIn: number, hop: 1 | 2): ReferenceRow {
    const row: ReferenceRow = {
      file: entity.filePath,
      line: entity.lineStart,
      name: entity.name,
      kind: entity.kind || edgeKind,
      fan_in: fanIn,
      hop,
    }
    if (entity.domain) row.domain = entity.domain
    if (entity.role) row.role = entity.role
    if (entity.summary) row.summary = entity.summary
    if (fanIn >= RSK_CALLER_THRESHOLD) {
      row.chokepoint = true
      signals.push(
        `ur|rsk [chokepoint] e:${entity.name} has ${fanIn} callers — high blast radius; call get_references before editing`,
      )
    }
    return row
  }

  async function edgesFor(key: string): Promise<RefEdge[]> {
    if (direction === "callers") return dedupeRefEdges(await graph.getCallers(key).catch(() => []))
    // Callee edges all share the from side (getReferences filters on the queried
    // entity's own from_entity/from_file), so the caller-shaped dedupe above would
    // collapse every callee into one slot. Dedupe by target instead: an import +
    // call edge pair to the same toEntity is one callee, not two.
    const raw = await graph.getReferences(key).catch(() => [])
    const byTarget = new Map<string, RefEdge>()
    for (const ref of raw) if (!byTarget.has(ref.toEntity)) byTarget.set(ref.toEntity, ref)
    return [...byTarget.values()]
  }

  const hop1Entities: RefEntity[] = []

  for (const edge of await edgesFor(entityKey)) {
    if (rows.length >= rowCap) {
      truncated = true
      break
    }
    // An empty name is a real, un-attributed edge (e.g. a module-level import with
    // no enclosing named function) — kept as a file-level row (entity resolution
    // below naturally misses on "" and falls to the raw-edge fallback) rather than
    // dropped, so a file that merely imports the entity still shows up in blast radius.
    const name = direction === "callers" ? edge.fromEntity : edge.toEntity
    const file = direction === "callers" ? edge.fromFile : undefined
    const entity = await resolve(name, file)
    const vkey = entity ? `${entity.filePath}:${entity.name}:${entity.kind}` : `${file ?? ""}:${name}`
    if (visited.has(vkey)) continue
    visited.add(vkey)
    if (entity) {
      rows.push(toRow(entity, edge.kind, await fanInFor(entity), 1))
      if (hop1Entities.length < REFS_HOP_EXPAND_CAP) hop1Entities.push(entity)
    } else {
      rows.push({ file: file ?? "", line: 0, name, kind: edge.kind, fan_in: 0, hop: 1 })
    }
  }

  if (depth >= 2 && !truncated) {
    hop2: for (const hop1Entity of hop1Entities) {
      const key = `${hop1Entity.filePath}:${hop1Entity.name}:${hop1Entity.kind}`
      for (const edge of await edgesFor(key)) {
        if (rows.length >= rowCap) {
          truncated = true
          break hop2
        }
        const name = direction === "callers" ? edge.fromEntity : edge.toEntity
        const file = direction === "callers" ? edge.fromFile : undefined
        const entity = await resolve(name, file)
        const vkey = entity ? `${entity.filePath}:${entity.name}:${entity.kind}` : `${file ?? ""}:${name}`
        if (visited.has(vkey)) continue
        visited.add(vkey)
        rows.push(
          entity
            ? toRow(entity, edge.kind, await fanInFor(entity), 2)
            : { file: file ?? "", line: 0, name, kind: edge.kind, fan_in: 0, hop: 2 },
        )
      }
    }
  }

  return { rows, truncated, signals }
}
