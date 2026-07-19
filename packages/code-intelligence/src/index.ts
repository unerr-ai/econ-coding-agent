/**
 * Port boundary for in-process code intelligence: graph queries, risk signals,
 * recon bundles, and context compression — all without native addons.
 *
 * @sem domain=intelligence role=interface
 */

import type { AnchoredNote } from "./memory.js"

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
  /** Prose summary from the entity's doc comment (what + why); undefined when empty or a name-echo. */
  summary?: string
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
  /** Anchored notes surfaced from the notes store for the matched file anchors. */
  notes: AnchoredNote[]
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

  /**
   * Return all entities whose source file matches filePath. Accepts relative
   * (resolved against indexed root) or absolute paths.
   *
   * @sem domain=intelligence role=query
   */
  getEntitiesInFile(filePath: string): Promise<Entity[]>

  /**
   * Fetch all anchored notes whose anchor matches one of the given anchor
   * strings (e.g. "f:src/foo.ts", "e:myFunction"). Returns an empty array
   * when no matching notes exist in the store.
   *
   * @sem domain=intelligence role=query
   */
  getNotesForAnchors(anchors: string[]): Promise<AnchoredNote[]>

  /**
   * Persist a single anchored note to the backing store. Upserts on
   * (anchor, kind, content) so re-saves are idempotent.
   *
   * @sem domain=intelligence role=indexing
   */
  upsertNote(note: AnchoredNote): Promise<void>

  /** Release resources (close DB connection). */
  close(): void
}

// ---------------------------------------------------------------------------
// Re-exports for consumers
// ---------------------------------------------------------------------------
export { BunSqliteGraph } from "./bun-sqlite-graph.js"
export { makeReconTool, makeFileReadTool, makeGetReferencesTool, makeSearchCodeTool, makeFileOutlineTool, makeNoteSaveTool } from "./tools.js"
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
export * from "./allocation.js"
export * from "./qe.js"
export * from "./verifier.js"
export * from "./claim-evidence.js"
export * from "./plan-reasoning.js"
export * from "./triage.js"
export * from "./reasoner.js"
export * from "./brief.js"
export * from "./double-pay.js"
export * from "./model-registry.js"
export * from "./rm-verifier.js"
export * from "./judge.js"
export * from "./compose-rungs.js"
export * from "./slice-loop.js"
export * from "./posterior-uncertainty.js"
export * from "./evaluator.js"
export * from "./resolution-phase.js"

// econ OL-7.7: retrieval-augmented slice wiring — deterministic graph facts
// (callers/blast-radius, entity summaries, signatures) woven into a slice's
// child-session brief, hard token-capped.
export {
  assembleSliceWiring,
  DEFAULT_WIRING_TOKEN_BUDGET,
  type SliceWiringGraph,
  type SliceWiringInput,
  type SliceWiringResult,
} from "./slice-wiring.js"

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
  planFanoutWaves,
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
  detectBreakingChanges,
  renderBreakingChangeWarning,
  type CallerAtRisk,
  type CascadeWarning,
  type SignatureChangeType,
  type EditImpactGraph,
  type EditImpactConfig,
  type BreakingChange,
} from "./edit-impact.js"
// G3 — post-edit breaking-change scan needs a single-file re-parse without a
// full re-index; ast-extractor's regex extractor is that entry point.
export { extractEntities, detectLanguage, type ExtractedEntity } from "./ast-extractor.js"
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

// econ S7.1 telemetry · S7.3 usage receipt (the proof surface)
// econ AC-5.2 efficiency metrics loop (tokens-per-task, re-read rate, post-compaction signal)
export {
  TelemetryStore,
  emitUsageEvent,
  installUsageSink,
  inferTier,
  tierFromAgent,
  attributeTier,
  EfficiencyMetrics,
  type UsageEvent,
  type UsageEventTokens,
  type UsageTier,
  type UsageTotals,
  type TierUsage,
  type StatusSnapshot,
  type RawUsage,
  type EfficiencyMetricsSnapshot,
  type CompactionOutcomeEvent,
} from "./telemetry.js"
export {
  buildReceipt,
  formatReceipt,
  type EconReceipt,
  type ReceiptInput,
  type ReceiptCatch,
  type ReceiptGoal,
  type ReceiptEvaluation,
  type ReceiptContainment,
  type TierSplitRow,
} from "./receipt.js"
// econ AC-0.4 cache-hit-rate meter + AC-8.4 per-tier rollup / cross-tier transitions
export {
  computeCacheHitRate,
  recordCacheHit,
  TierCacheRollup,
  TIER_CACHE_HIT_TARGET,
  type CacheHitEvent,
  type CacheHitInput,
  type CrossTierTransitionEvent,
  type TierCacheStats,
  type TierCacheSnapshot,
  type TierCacheRollupSignal,
} from "./cache-meter.js"

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
