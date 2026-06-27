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
  /** Direct caller count (edge count where to_entity = this entity's name). */
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
// Core scorer
// ---------------------------------------------------------------------------

/**
 * Compute a 0–100 code-structural risk score for a single entity.
 *
 * Factors and weights:
 *   fanIn 35%  — direct callers (immediate break risk)
 *   blastRadius 35%  — transitive caller-file count (cascade risk)
 *   centrality 20%  — connectivity proxy (fanIn + fanOut, hub detection)
 *   cx 10%  — body line count (surface area for mistakes)
 *
 * Each factor is normalized to [0, 1] against its ceiling before weighting.
 *
 * @sem domain=intelligence role=analysis
 */
export async function computeRisk(
  graph: RiskGraph,
  target: Entity
): Promise<RiskResult> {
  // Direct callers (fan-in)
  const callerRefs = await graph.getCallers(target.name)
  const fanIn = callerRefs.length

  // Direct callees (fan-out) — contributes to centrality
  const calleeRefs = await graph.getReferences(target.name)
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
  // frontier = entity names whose callers we'll probe this BFS level
  let frontier: string[] = [entity.name]

  for (let depth = 0; depth < MAX_BFS_DEPTH && frontier.length > 0; depth++) {
    const nextEntityNames: string[] = []
    for (const name of frontier) {
      const refs = await graph.getCallers(name)
      for (const ref of refs) {
        const f = ref.fromFile
        if (f && !visitedFiles.has(f)) {
          visitedFiles.add(f)
          // Continue BFS from entities in this newly discovered caller file
          const fileEntities = await graph.getEntitiesInFile(f)
          for (const e of fileEntities) {
            nextEntityNames.push(e.name)
          }
        }
      }
    }
    frontier = nextEntityNames
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
