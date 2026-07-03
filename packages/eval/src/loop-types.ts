/**
 * Types for the loop-adherence eval — scores whether a conductor turn
 * followed the orchestration loop (meta-plan, task list, delegation,
 * verification) from an observable trace of assistant text + tool calls.
 * @sem domain=eval role=types
 */

/** One tool invocation as recorded in the session's message/tool record. */
export interface ToolCallRecord {
  /** Tool name, e.g. "todowrite", "task". */
  name: string
  /** Tool input, when available — used to look for verification intent. */
  input?: Record<string, unknown>
}

/**
 * The observable trace of one conductor turn: the ordered assistant text
 * segments and the tool calls it made. Mirrors what the session's
 * message/tool record already exposes — no new telemetry required.
 */
export interface LoopTrace {
  /** Assistant text parts in emission order (first entry = opening text). */
  textParts: string[]
  /** All tool calls made during the turn, in call order. */
  toolCalls: ToolCallRecord[]
}

/** The four loop-adherence signals the eval scores per case. */
export interface LoopSignals {
  has_meta_plan: boolean
  used_task_list: boolean
  delegated_when_expected: boolean
  verified_nontrivial: boolean
}

/**
 * A loop-adherence case: a prompt, which loop behaviours it expects, a
 * canned trace standing in for a live conductor run (dry-run — no model
 * call needed), and the score threshold it must clear to pass.
 */
export interface LoopCase {
  id: string
  prompt: string
  /** Whether this turn is non-trivial — gates has_meta_plan/used_task_list. */
  nontrivial: boolean
  /** Whether this task should trigger delegation via the `task` tool. */
  expectDelegation: boolean
  /** Whether this task's non-trivial work should be verified before done. */
  expectVerification: boolean
  /** Canned trace standing in for a live conductor run (dry-run mode). */
  mockTrace: LoopTrace
  /** Minimum weighted score (0-1) this case must clear to pass. */
  threshold: number
}

/** Per-case scoring result. */
export interface LoopResult {
  caseId: string
  signals: LoopSignals
  weightedScore: number
  threshold: number
  pass: boolean
}
