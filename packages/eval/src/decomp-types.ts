/**
 * Types for the decomposition-quality eval (OL-7.4) — scores whether a
 * conductor's typed slice DAG (OL-7.1/7.9) is well-formed and whether the
 * real per-slice allocator (OL-7.2) places each slice in the matrix cell a
 * hand-labeled fixture expects. Pure/offline: scoring runs the real
 * `todosToLoopSlices` + `allocateSlice` against canned conductor todos — no
 * model call needed.
 * @sem domain=eval role=types
 */

import type { Coupling, EconTier, SliceType, TestStrength, VerifierRung } from "@opencode-ai/code-intelligence"
import type { OrchestrationTodo } from "opencode/session/slice-orchestrator"

/** Re-exported so case/scorer files import one canonical todo shape. */
export type { OrchestrationTodo }

/**
 * Hand-labeled ground truth for one slice a case's `mockTodos` should
 * decompose into. `content` matches the todo's `content` field (the string
 * `todosToLoopSlices` derives the slice id from).
 */
export interface ExpectedSlice {
  content: string
  sliceType: SliceType
  /** Expected dependency edges, by the referenced slice's `content`. */
  deps?: string[]
  coupling: Coupling
  testStrength: TestStrength
  /** The (coupling × test-strength) matrix cell this slice must land in (OL-7.2). */
  tier: EconTier
  verification: VerifierRung
  /**
   * True when this slice's todo carries an over-eager `need` hint (e.g.
   * "oracle" on a testable slice) that allocation must NOT honor — the
   * safety-net invariant (OL-7.2) overrides it.
   */
  needHintShouldBeIgnored?: boolean
}

/** The five decomposition-quality signals the eval scores per case (OL-7.4). */
export interface DecompSignals {
  /** Every produced slice's sliceType matches its hand-labeled expectation. */
  slice_types_valid: boolean
  /** The DAG has no missed/unresolved dependency and no cycle (planWaves succeeds, deps match). */
  deps_sane: boolean
  /** The produced slice count matches the expected count (no over- or under-fragmentation). */
  no_over_fragmentation: boolean
  /** An over-eager `need` hint never raises a testable slice's tier (OL-7.2 safety-net invariant). */
  need_not_over_escalating: boolean
  /** Every slice's real `allocateSlice` output (tier + verifier rung) matches its expected matrix cell. */
  allocation_matches_cell: boolean
}

/**
 * A decomposition-quality case: a task prompt, the conductor's typed todo
 * output standing in for a live decomposition (dry-run — no model call
 * needed), and the hand-labeled expected slice DAG it must match.
 */
export interface DecompCase {
  id: string
  prompt: string
  /** Canned conductor output (typed todos) standing in for a live decomposition. */
  mockTodos: OrchestrationTodo[]
  /** Hand-labeled expected slice structure, keyed by todo content. */
  expectedSlices: ExpectedSlice[]
  /** Minimum weighted score (0-1) this case must clear to pass. */
  threshold: number
}

/** Per-case scoring result. */
export interface DecompResult {
  caseId: string
  signals: DecompSignals
  weightedScore: number
  threshold: number
  pass: boolean
  /** Diagnostic detail for any failing signal — empty when every signal passes. */
  notes: string[]
}
