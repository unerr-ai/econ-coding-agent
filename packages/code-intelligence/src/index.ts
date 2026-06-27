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

// econ S4.3 specialists · S4.2/S4.4 fan-out
export {
  SPECIALISTS,
  TIER_AGENT,
  DIGEST_CONTRACT,
  getSpecialist,
  specialistsForTier,
  listSpecialists,
  dispatchSpecialist,
  type SpecialistTier,
  type Specialist,
  type SpecialistInvocation,
} from "./specialists.js"
export {
  BATCH_THEN_FANOUT_RULE,
  isReadOnly,
  callsConflict,
  planWaves,
  isSingleWave,
  type FanoutCall,
} from "./fanout.js"

// econ S6.3 governance gate (guardrail + edit-impact + boundary, lifted from unerr-cli)
export {
  evaluateEdit,
  createGuardrailState,
  DEFAULT_GUARDRAIL_CONFIG,
  type GuardrailVerdict,
  type GuardrailInput,
  type AdvisoryCheck,
  type GuardrailConfig,
  type GuardrailState,
  type GuardrailDecision,
} from "./guardrail.js"
export {
  computeEditImpact,
  detectSignatureChange,
  renderInlineBlastRadius,
  toCallerAtRisk,
  buildSuggestion,
  isTestFilePath,
  DEFAULT_EDIT_IMPACT_CONFIG,
  type CallerAtRisk,
  type CascadeWarning,
  type SignatureChangeType,
  type EditImpactGraph,
  type EditImpactConfig,
} from "./edit-impact.js"
export {
  computeBoundaryViolations,
  parseImports,
  resolveImportPath,
  DEFAULT_LAYER_RULES,
  DEFAULT_BOUNDARY_CHECK_CONFIG,
  type BoundaryViolation,
  type LayerRule,
  type BoundaryCheckConfig,
} from "./boundary.js"

// econ S6.1/6.2/6.4/6.5/6.6 — deferred unerr-runtime surface (scaffolds behind CodeIntelligence)
export {
  parseSentinels,
  InMemoryMemoryStore,
  type NoteKind,
  type Polarity,
  type AnchoredNote,
  type FourMoment,
  type MemoryStore,
} from "./memory.js"
export { detectConventions, type ConventionRule, type ConventionDetector } from "./conventions.js"
export { decayConfidence, DEFAULT_DECAY_CONFIG, type DecayConfig } from "./decay.js"
export { buildResumeStrip, type SessionStateLike, type ResumeStrip } from "./continuity.js"

// econ S7.1 telemetry · S7.3 savings receipt (the proof surface)
export {
  TelemetryStore,
  emitUsageEvent,
  installUsageSink,
  inferTier,
  type UsageEvent,
  type UsageEventTokens,
  type UsageTier,
  type UsageTotals,
  type StatusSnapshot,
  type RawUsage,
} from "./telemetry.js"
export {
  buildReceipt,
  formatReceipt,
  type SavingsReceipt,
  type ReceiptInput,
  type ReceiptCatch,
  type FrontierBaseline,
  type TierSplitRow,
} from "./receipt.js"

// econ S5.1 checkpoint-writer · S5.2 task-tree · S5.3 goal-judge (long-horizon)
export {
  DEFAULT_CHECKPOINT_CONFIG,
  createCheckpointState,
  shouldCheckpoint,
  buildCheckpoint,
  checkpointIfNeeded,
  type CheckpointConfig,
  type CheckpointSnapshot,
  type CheckpointState,
} from "./checkpoint.js"
export {
  createTaskTree,
  addTask,
  updateStatus,
  setDecision,
  findNode,
  collectDecisions,
  serializeTaskTree,
  deserializeTaskTree,
  renderTaskTree,
  type TaskStatus,
  type TaskNode,
  type TaskTree,
} from "./task-tree.js"
export {
  DEFAULT_GOAL_JUDGE_CONFIG,
  createGoalJudgeState,
  makeStubJudge,
  runUntilGoal,
  type GoalContext,
  type Judge,
  type GoalJudgeConfig,
  type GoalJudgeState,
  type GoalOutcome,
} from "./goal-judge.js"

// econ S8.1 in-region inference + data residency
export {
  DEFAULT_RESIDENCY_POLICY,
  DEFAULT_REGION_CONFIG,
  parseRegionConfig,
  resolveTierChain,
  checkResidency,
  selectEndpoint,
  type Region,
  type EconTier,
  type DataClass,
  type ResidencyMode,
  type RegionEndpoint,
  type ResidencyPolicy,
  type RegionConfig,
  type ResidencyCheck,
} from "./region.js"
