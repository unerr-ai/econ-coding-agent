/**
 * Port boundary for in-process code intelligence: graph queries, risk signals,
 * recon bundles, and context compression — all without native addons.
 *
 * @sem domain=intelligence role=interface
 */

// ---------------------------------------------------------------------------
// Shared value types
// ---------------------------------------------------------------------------

/** A single code entity (function, class, method, interface, variable). */
export interface Entity {
  /** Stable key: "<filePath>:<name>:<kind>" */
  key: string
  /** Human-readable name as it appears in source. */
  name: string
  /** Entity kind: function | class | method | interface | variable */
  kind: string
  /** File path relative to the indexed root. */
  filePath: string
  /** One-based start line. */
  lineStart: number
  /** One-based end line (best-effort). */
  lineEnd: number
  /** Short parameter list / return type extracted from source. */
  signature: string
  /** Owning class name for methods. */
  parentClass?: string
  /** SHA-256 prefix of entity body for change detection. */
  contentHash: string
  /** Semantic domain tag from a `@sem domain=<tag>` annotation in the entity's doc comment. */
  domain?: string
  /** Semantic role tag from a `@sem role=<tag>` annotation in the entity's doc comment. */
  role?: string
}

/** A directed reference edge between two entities or files. */
export interface Reference {
  /** Entity key of the caller / importing site. */
  fromEntity: string
  /** File path of the caller / importing file. */
  fromFile: string
  /** Entity name being referenced (callee / import). */
  toEntity: string
  /** Edge kind: "import" | "call" | "extends" | "reference" */
  kind: string
}

/** Lightweight recon bundle returned for a natural-language task phrase. */
export interface ReconBundle {
  /** Matched entities most relevant to the task. */
  entities: Entity[]
  /** References among the matched entities. */
  references: Reference[]
  /** Prose notes / conventions anchored to matched files. */
  notes: string[]
}

// ---------------------------------------------------------------------------
// Port interface
// ---------------------------------------------------------------------------

/**
 * In-process code graph port: implemented by BunSqliteGraph for the graph-
 * query and risk-signal subset; recon and compress are extended by richer
 * backends (unerr brain UDS proxy).
 *
 * @sem domain=intelligence role=interface
 */
export interface CodeIntelligence {
  /**
   * Look up an entity by its stable key or by bare name (first match wins).
   * Returns null when nothing is indexed under that key.
   *
   * @sem domain=intelligence role=query
   */
  getEntity(key: string): Promise<Entity | null>

  /**
   * Return all outgoing references from the given entity key — i.e. the
   * entities it calls, imports, or extends.
   *
   * @sem domain=intelligence role=query
   */
  getReferences(entityKey: string): Promise<Reference[]>

  /**
   * Return all callers of the given entity key — the inverse of getReferences.
   * Fan-in count here is the primary input to riskScore.
   *
   * @sem domain=intelligence role=query
   */
  getCallers(entityKey: string): Promise<Reference[]>

  /**
   * Full-text search across entity names and kinds. Returns ranked matches
   * up to the given limit (default 20).
   *
   * @sem domain=intelligence role=query
   */
  search(query: string, limit?: number): Promise<Entity[]>

  /**
   * Risk signal for an impending edit to filePath: 0 (safe) to 1 (high risk).
   * Derived from the combined fan-in (caller count) of entities in the file.
   *
   * @sem domain=intelligence role=analysis
   */
  riskScore(filePath: string): Promise<number>

  /**
   * Recon bundle for a natural-language task phrase: returns the most
   * relevant entities + their references + anchored notes in one shot,
   * replacing the search→read→search fan-out.
   *
   * @sem domain=intelligence role=analysis
   */
  recon(task: string): Promise<ReconBundle>

  /**
   * Trim and rank content to fit within a token budget. Returns the highest-
   * value slice of content (entities sorted by fan-in, prose truncated).
   *
   * @sem domain=intelligence role=utilities
   */
  compress(content: string, budget: number): string

  /**
   * Index (or re-index) all supported source files under repoPath, storing
   * entities and edges into the backing store. Idempotent — upserts by
   * (filePath, name, kind).
   *
   * @sem domain=intelligence role=indexing
   */
  index(repoPath: string): Promise<{ files: number; entities: number; edges: number }>

  /** Release resources (close DB connection). */
  close(): void
}

// ---------------------------------------------------------------------------
// Re-exports for consumers
// ---------------------------------------------------------------------------
export { BunSqliteGraph } from "./bun-sqlite-graph.js"
export { makeReconTool, makeFileReadTool, makeGetReferencesTool } from "./tools.js"
export type { GraphToolDef } from "./tools.js"

// econ S3.1: risk scoring
export {
  computeRisk,
  computeTurnRisk,
  type RiskGraph,
  type RiskFactors,
  type RiskResult,
  type EntityRisk,
  type TurnRiskResult,
} from "./risk.js"

// econ S3.2: risk-escalation router (incl. S3.7 reasoner tier)
export {
  routeTurn,
  defaultRouterState,
  defaultRouterConfig,
  type Tier,
  type RouterState,
  type RouterConfig,
  type RouterInput,
  type RouterOutput,
} from "./router.js"

// econ S3.3 abstention · S3.4 compiled brief · S3.5 triage · S3.6 double-pay · S3.7 reasoner
// Router/oracle decision surface — the modules feeding routeTurn's hooks and the
// oracle escalation path. (S2 compression modules stay path-internal to the plugins.)
export * from "./abstention.js"
export * from "./triage.js"
export * from "./reasoner.js"
export * from "./brief.js"
export * from "./double-pay.js"
