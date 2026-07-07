/**
 * Types for the everyday-capability eval (OL-7.12) — the honesty gate that
 * scores what everyday users feel on test-poor real repos (little/no test
 * coverage, so the verifier ladder leans on QE/judge rungs) instead of
 * SWE-bench-style test-pass deltas, per
 * docs/architecture/DECOMPOSITION_ORCHESTRATION_PLAN.md §6/§8 (OL-7.12).
 * @sem domain=eval role=types
 */

/** Reuses the loop-eval's tool-call shape — no new telemetry needed. */
export interface ToolCallRecord {
  name: string
  input?: Record<string, unknown>
}

/** One turn's observable assistant output: text + tool calls + wall latency. */
export interface EverydayTurn {
  textParts: string[]
  toolCalls: ToolCallRecord[]
  latencyMs: number
}

/**
 * A fixture mini-repo with little/no test coverage — the harness scans its
 * file layout from disk (see `test-poor-repos.ts`) so the "test-poor" claim
 * is verified, not merely asserted in a config object.
 */
export interface TestPoorRepo {
  id: string
  /** Path relative to packages/eval/, e.g. "fixtures/test-poor-repos/tiny-cli-tool". */
  relPath: string
  /** One-line description of the repo's shape, used in reports. */
  description: string
}

export type EverydayMetric = "trivial_latency" | "clarify_vs_guess" | "multiturn_coherence"

/**
 * Trivial-turn latency-delta case: decomposition ceremony must not tax a
 * simple turn. `maxDeltaMs` is the flip-gate ceiling on
 * (decomposeLatencyMs - baselineLatencyMs).
 */
export interface LatencyCase {
  id: string
  metric: "trivial_latency"
  /** Optional test-poor repo this trivial prompt is scoped to (repo context, not repo edits). */
  repoId?: string
  prompt: string
  /** Recorded (or canned) latency in ms on the legacy whole-turn risk-veto path. */
  baselineLatencyMs: number
  /** Recorded (or canned) latency in ms on the decompose path for the same trivial prompt. */
  decomposeLatencyMs: number
  /** Max acceptable (decompose - baseline) delta in ms — the flip-gate ceiling. */
  maxDeltaMs: number
}

/**
 * Clarify-vs-guess case: on a test-poor repo (no tests to catch a wrong
 * guess), an ambiguous prompt should produce a clarifying question rather
 * than a silent guess; an unambiguous control prompt should NOT clarify.
 */
export interface ClarifyCase {
  id: string
  metric: "clarify_vs_guess"
  repoId: string
  prompt: string
  /** True: prompt is genuinely ambiguous (correct behavior = clarify). False: unambiguous control (correct behavior = proceed). */
  ambiguous: boolean
  /** Canned assistant turn standing in for a live run (dry-run mode). */
  mockTrace: EverydayTurn
  threshold: number
}

/**
 * Multi-turn-coherence case: a fact established in an early turn must
 * survive a context-compaction boundary and still be honored by the turn
 * scored (`compactionAtTurn`), on a test-poor repo where nothing but the
 * conversation itself carries the fact.
 */
export interface CoherenceCase {
  id: string
  metric: "multiturn_coherence"
  repoId: string
  /** User-turn prompts sent in order across the session. */
  turnPrompts: string[]
  /** Index into turnPrompts/mockTurns of the turn immediately after compaction — this is the turn that is scored. */
  compactionAtTurn: number
  /** Canned assistant responses standing in for a live run, one per turnPrompts entry (dry-run mode). */
  mockTurns: EverydayTurn[]
  /** Substring (case-insensitive) that must appear in the scored turn's text if the fact survived compaction. */
  factToRecall: string
  threshold: number
}

export type EverydayCase = LatencyCase | ClarifyCase | CoherenceCase

/** Per-case scoring result. */
export interface EverydayResult {
  caseId: string
  metric: EverydayMetric
  score: number
  threshold: number
  pass: boolean
  detail: string
}

/** The combined pass/fail verdict CP-D cites — one line per metric plus the overall gate. */
export interface FlipGateSummary {
  pass: boolean
  perMetric: Record<EverydayMetric, { pass: boolean; passRate: number; count: number }>
  includesTestPoorRepo: boolean
  results: EverydayResult[]
}
