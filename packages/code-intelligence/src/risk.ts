/**
 * Code-structural risk scorer: 0–100 score derived purely from the live call
 * graph — blast-radius, fan-in, centrality, and body complexity. No
 * prompt-text classification. The router (S3.2) escalates when
 * computeTurnRisk exceeds its threshold.
 *
 * Lifted from unerr-cli's blast-radius-protocol / edit-impact pattern and
 * adapted for the bun:sqlite graph surface.
 *
 * @sem domain=intelligence role=analysis
 */

import type { Entity, Reference } from "./index.js"

// ---------------------------------------------------------------------------
// Graph surface
// ---------------------------------------------------------------------------

/**
 * Minimal graph surface the risk scorer requires. BunSqliteGraph satisfies
 * this structurally (it has all four methods); tests may pass a lightweight
 * mock instead.
 *
 * @sem domain=intelligence role=interface
 */
export interface RiskGraph {
  getEntity(key: string): Promise<Entity | null>
  getCallers(entityKey: string): Promise<Reference[]>
  getReferences(entityKey: string): Promise<Reference[]>
  /** Return all entities whose source file matches filePath (relative or absolute). */
  getEntitiesInFile(filePath: string): Promise<Entity[]>
}

// ---------------------------------------------------------------------------
// Factor ceilings — at or above these raw values the factor contributes its
// full weight; below they scale linearly.
// ---------------------------------------------------------------------------

/** Direct callers: ≥15 = large fan-in. */
const FAN_IN_CEIL = 15
/** Transitive caller files: ≥30 = most of the repo depends transitively on this. */
const BLAST_RADIUS_CEIL = 30
/** Connectivity (fanIn + fanOut): ≥20 = highly connected hub. */
const CENTRALITY_CEIL = 20
/** Body line count: ≥100 lines = large, complex body. */
const CX_CEIL = 100
/** BFS depth cap — keeps transitive traversal O(depth × frontier). */
const MAX_BFS_DEPTH = 5

// ---------------------------------------------------------------------------
// Factor weights (must sum exactly to 1.0)
// ---------------------------------------------------------------------------
// fanIn and blastRadius split the majority because direct + transitive
// dependents are the strongest break-risk signal. centrality captures hub
// status (high in + out edges). cx is a small tiebreaker for large functions.
// ---------------------------------------------------------------------------
const W_FAN_IN = 0.35
const W_BLAST = 0.35
const W_CENTRALITY = 0.20
const W_CX = 0.10

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Raw (un-normalized) factor values before scoring. All counts are ≥ 0. */
export interface RiskFactors {
  /** Unique caller-file count reachable transitively via BFS. */
  blastRadius: number
  /** Distinct direct callers (deduped: an import edge + a call edge from
   *  the same file describe one dependency, not two). */
  fanIn: number
  /** Connectivity proxy: fanIn + direct fanOut. */
  centrality: number
  /** Body complexity proxy: entity body line count (lineEnd − lineStart). */
  cx: number
}

/** Risk score and factor breakdown for a single entity. */
export interface RiskResult {
  /** Aggregate code-structural risk: 0 (safe) – 100 (high risk). */
  score: number
  /** Raw factor values (un-normalized). */
  factors: RiskFactors
  /**
   * Whether fanIn/blastRadius/centrality above reflect real edge resolution
   * for the entity's language, or read low by construction because no
   * import resolver exists for it yet (P6, §7.1) — "unknown" is a coupling-
   * blind route, never a risk-free one. "measured" when the caller passed no
   * coverage data at all (today's only wired path: Python/TS via
   * computeTurnRisk/riskScore), so existing behavior is unchanged.
   */
  coverage: "measured" | "unknown"
}

/** Per-entity risk result with its entity reference. */
export interface EntityRisk {
  entity: Entity
  result: RiskResult
}

/**
 * Aggregate turn-level risk: the worst-case score across all entities a
 * turn touches, plus the per-entity breakdown for router inspection.
 *
 * @sem domain=intelligence role=analysis
 */
export interface TurnRiskResult {
  /** Highest risk score across all entities in this turn (0–100). */
  score: number
  /** Entity carrying the highest risk score. */
  topEntity: Entity
  /** All entity scores, sorted descending by score. */
  perEntity: EntityRisk[]
}

// ---------------------------------------------------------------------------
// Caller dedup
// ---------------------------------------------------------------------------

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

/**
 * Coupling floor (P6, §7.1): below this resolved-import ratio, treat a
 * language's coupling data as unmeasured rather than genuinely low-risk. Set
 * at 0.10 because it exactly separates the two populations we've measured —
 * a zero-resolver language (Go/Java/Rust/C/C++) always lands at 0% resolved,
 * while Python (~77%) and TypeScript (~84%) sit far above it, so no real
 * resolver can cross this floor and misfire.
 */
const COVERAGE_CONFIDENCE_FLOOR = 0.1

/**
 * Whether coverage counts for one language are trustworthy enough to read
 * computeRisk's fan-in/blast-radius factors as meaningful, or whether they
 * read zero purely because that language has no import resolver yet.
 * "unknown" when: coverage is missing entirely (nothing measured for this
 * language); the language has ≥2 indexed files but extracted zero import
 * edges at all (the go/java/rust/c/cpp extraction gap, P6 §7.1 — a single
 * file is too thin to tell "no resolver" from "this file genuinely imports
 * nothing", so it stays "measured"); or its resolved-import ratio is below
 * COVERAGE_CONFIDENCE_FLOOR. "measured" otherwise. INTERIM: the zero-imports
 * branch only exists to cover languages ast-extractor's extractEdges has no
 * import extractor for yet — once wave G's G1a adds generic import
 * extraction those languages produce imports > 0 and the ratio rule alone
 * covers them; G5 then retires this branch.
 *
 * @sem domain=intelligence role=analysis
 */
export function couplingConfidence(
  coverage: { files: number; imports: number; resolvedImports: number } | undefined
): "measured" | "unknown" {
  if (!coverage) return "unknown"
  if (coverage.files >= 2 && coverage.imports === 0) return "unknown"
  if (coverage.imports > 0 && coverage.resolvedImports / coverage.imports < COVERAGE_CONFIDENCE_FLOOR) {
    return "unknown"
  }
  return "measured"
}

// ---------------------------------------------------------------------------
// Core scorer
// ---------------------------------------------------------------------------

/**
 * Compute a 0–100 code-structural risk score for a single entity.
 *
 * Factors and weights:
 *   fanIn 35%  — distinct direct callers (immediate break risk)
 *   blastRadius 35%  — transitive caller-file count (cascade risk)
 *   centrality 20%  — connectivity proxy (fanIn + fanOut, hub detection)
 *   cx 10%  — body line count (surface area for mistakes)
 *
 * Each factor is normalized to [0, 1] against its ceiling before weighting.
 * An optional `coverage` argument (the entity's language's import counts)
 * tags the result via couplingConfidence; omitting it defaults the result to
 * "measured" so callers that don't pass coverage data see unchanged behavior.
 *
 * @sem domain=intelligence role=analysis
 */
export async function computeRisk(
  graph: RiskGraph,
  target: Entity,
  coverage?: { files: number; imports: number; resolvedImports: number }
): Promise<RiskResult> {
  // Direct callers (fan-in) — pass the full key so BunSqliteGraph scopes
  // the query to this entity's own file (two same-named entities in
  // different files must not share callers/callees). Deduped: one caller
  // file can contribute both an import edge and a call edge for the same
  // relationship, which must count once, not twice.
  const callerRefs = dedupeCallerRefs(await graph.getCallers(target.key))
  const fanIn = callerRefs.length

  // Direct callees (fan-out) — contributes to centrality
  const calleeRefs = await graph.getReferences(target.key)
  const fanOut = calleeRefs.length

  // Transitive blast radius: unique caller files reachable via BFS
  const blastRadius = await computeTransitiveCallers(graph, target)

  // Centrality: connectivity proxy = fanIn + fanOut
  const centrality = fanIn + fanOut

  // Complexity: body line count
  const cx = Math.max(0, target.lineEnd - target.lineStart)

  // Normalize each factor to [0, 1]
  const nFanIn = Math.min(fanIn / FAN_IN_CEIL, 1)
  const nBlast = Math.min(blastRadius / BLAST_RADIUS_CEIL, 1)
  const nCentrality = Math.min(centrality / CENTRALITY_CEIL, 1)
  const nCx = Math.min(cx / CX_CEIL, 1)

  // Weighted sum → clamp to [0, 100]
  const raw = W_FAN_IN * nFanIn + W_BLAST * nBlast + W_CENTRALITY * nCentrality + W_CX * nCx
  const score = Math.max(0, Math.min(100, Math.round(raw * 100)))

  return {
    score,
    factors: { blastRadius, fanIn, centrality, cx },
    coverage: coverage === undefined ? "measured" : couplingConfidence(coverage),
  }
}

// ---------------------------------------------------------------------------
// Transitive caller BFS (file-level)
// ---------------------------------------------------------------------------

/**
 * BFS through the caller graph up to MAX_BFS_DEPTH levels, accumulating
 * unique caller files. Returns the count of unique caller files (the entity's
 * own file is excluded from the count — it's not a caller of itself).
 */
async function computeTransitiveCallers(
  graph: RiskGraph,
  entity: Entity
): Promise<number> {
  const visitedFiles = new Set<string>([entity.filePath])
  // frontier = entity keys whose callers we'll probe this BFS level (full
  // keys, not bare names, so getCallers resolves each one to its own file
  // and never cross-contaminates with a same-named entity elsewhere)
  let frontier: string[] = [entity.key]

  for (let depth = 0; depth < MAX_BFS_DEPTH && frontier.length > 0; depth++) {
    const nextEntityKeys: string[] = []
    for (const key of frontier) {
      const refs = await graph.getCallers(key)
      for (const ref of refs) {
        const f = ref.fromFile
        if (f && !visitedFiles.has(f)) {
          visitedFiles.add(f)
          // Continue BFS from entities in this newly discovered caller file
          const fileEntities = await graph.getEntitiesInFile(f)
          for (const e of fileEntities) {
            nextEntityKeys.push(e.key)
          }
        }
      }
    }
    frontier = nextEntityKeys
  }

  // visitedFiles includes the entity's own file; exclude it from the count
  return visitedFiles.size - 1
}

// ---------------------------------------------------------------------------
// Turn-level aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate risk score for a turn that touches multiple entities. Returns the
 * maximum entity score (worst-case escalation signal) and all individual
 * scores so the router can inspect the breakdown. Returns null for an empty
 * entity list.
 *
 * S3.2 usage: call computeTurnRisk(graph, entitiesInTurn) at the start of
 * each routing decision; escalate to a stronger model when result.score ≥
 * the configured threshold (e.g. 60).
 *
 * @sem domain=intelligence role=analysis
 */
export async function computeTurnRisk(
  graph: RiskGraph,
  entities: Entity[]
): Promise<TurnRiskResult | null> {
  if (entities.length === 0) return null

  const perEntity: EntityRisk[] = await Promise.all(
    entities.map(async (entity) => ({
      entity,
      result: await computeRisk(graph, entity),
    }))
  )

  perEntity.sort((a, b) => b.result.score - a.result.score)
  const top = perEntity[0]!

  return { score: top.result.score, topEntity: top.entity, perEntity }
}
