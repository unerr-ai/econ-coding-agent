/**
 * Aggregate per-step tool-result budget (L1.3). Caps the COMBINED estimated
 * tokens of one assistant step's tool results, trimming the largest first with a
 * visible recovery marker, so a batched or fan-out step can't stuff the context
 * the batching was meant to save. Complements — never replaces — the per-tool
 * line/byte caps in tool/truncate.ts.
 *
 * @sem domain=intelligence role=tools
 */

import { estimateTokens } from "../../../code-intelligence/src/trim"

/**
 * Default aggregate ceiling for one assistant step's combined tool results,
 * in estimated tokens. Token-based analogue of Claude Code's 200k-char/turn
 * aggregate cap; see docs/design/turn-cache-economics.md §5-L1.3.
 */
export const STEP_TOOL_RESULT_BUDGET = 20_000

/** Inline tag every elision marker starts with; stable for seams/tests to match. */
export const STEP_BUDGET_MARKER_TAG = "[econ step-budget"

/** Tokens reserved on each trimmed result so head + marker stays within its cap. */
const MARKER_TOKEN_RESERVE = 120

/** One tool result considered by the step budget. */
export interface StepToolResult {
  /** Stable id (tool part id / callID) used to map a trim back to its part. */
  id: string
  /** The model-facing output string of this tool result. */
  output: string
}

/** A single result after budget enforcement. */
export interface TrimmedStepResult {
  id: string
  /** Output, possibly trimmed with an inline recovery marker appended. */
  output: string
  /** Estimated tokens removed from this result (0 when untouched). */
  reclaimed: number
  /** True when this result was trimmed. */
  trimmed: boolean
}

/** Outcome of enforcing the aggregate budget across a step's results. */
export interface StepBudgetResult {
  results: TrimmedStepResult[]
  /** Total estimated tokens reclaimed across the step. */
  reclaimed: number
  /** Total estimated tokens before enforcement. */
  before: number
  /** Total estimated tokens after enforcement. */
  after: number
}

/**
 * Enforce the aggregate per-step tool-result budget. When the combined
 * estimated tokens exceed `budget`, the largest results are trimmed first
 * (water-filling to a shared cap) down to the budget; each trimmed portion is
 * cut at a line boundary and replaced with an explicit recovery marker. Results
 * whose combined size is at or under budget are returned untouched.
 */
export function enforceStepBudget(
  results: readonly StepToolResult[],
  budget: number = STEP_TOOL_RESULT_BUDGET,
): StepBudgetResult {
  const sized = results.map((r) => ({ id: r.id, output: r.output, tokens: estimateTokens(r.output) }))
  const before = sized.reduce((sum, r) => sum + r.tokens, 0)

  if (sized.length === 0 || before <= budget) {
    return {
      results: sized.map((r) => untouched(r)),
      reclaimed: 0,
      before,
      after: before,
    }
  }

  const cap = waterFillCap(
    sized.map((r) => r.tokens),
    budget,
  )
  const trimmed = sized.map((r) => (r.tokens > cap ? trimOne(r, cap, budget) : untouched(r)))
  const after = trimmed.reduce((sum, r) => sum + estimateTokens(r.output), 0)
  const reclaimed = trimmed.reduce((sum, r) => sum + r.reclaimed, 0)
  return { results: trimmed, reclaimed, before, after }
}

function untouched(r: { id: string; output: string }): TrimmedStepResult {
  return { id: r.id, output: r.output, reclaimed: 0, trimmed: false }
}

/**
 * Largest cap C such that sum(min(tokens_i, C)) <= budget — i.e. shave the
 * tallest results down to a shared ceiling until the total fits. Integer binary
 * search over [0, max(tokens)].
 */
function waterFillCap(tokens: number[], budget: number): number {
  let lo = 0
  let hi = tokens.reduce((m, t) => Math.max(m, t), 0)
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    const fitted = tokens.reduce((sum, t) => sum + Math.min(t, mid), 0)
    if (fitted <= budget) lo = mid
    else hi = mid - 1
  }
  return lo
}

function trimOne(
  r: { id: string; output: string; tokens: number },
  cap: number,
  budget: number,
): TrimmedStepResult {
  const lines = r.output.split("\n")
  const bodyCeiling = Math.max(cap - MARKER_TOKEN_RESERVE, 0)
  // Proportional first cut by chars (whole-string token estimate is already
  // known), then tighten line-by-line so the kept head never exceeds the body
  // ceiling. Cutting only at line boundaries keeps the head a faithful prefix.
  const charBudget = r.tokens > 0 ? Math.floor((r.output.length * bodyCeiling) / r.tokens) : 0
  const head: string[] = []
  let chars = 0
  for (let i = 0; i < lines.length; i++) {
    const add = lines[i].length + (i > 0 ? 1 : 0)
    if (chars + add > charBudget && head.length > 0) break
    head.push(lines[i])
    chars += add
  }
  while (head.length > 1 && estimateTokens(head.join("\n")) > bodyCeiling) head.pop()

  const headText = head.join("\n")
  const elidedLines = lines.length - head.length
  if (elidedLines <= 0) return untouched(r) // single-line/untrimmable blob — leave intact, don't mangle
  const reclaimed = Math.max(r.tokens - estimateTokens(headText), 0)
  return { id: r.id, output: headText + marker(reclaimed, elidedLines, budget), reclaimed, trimmed: true }
}

function marker(reclaimed: number, elidedLines: number, budget: number): string {
  return (
    `\n\n${STEP_BUDGET_MARKER_TAG} — ~${reclaimed} tokens (${elidedLines} line${elidedLines === 1 ? "" : "s"}) ` +
    `elided here for step economy: this step's combined tool results exceeded the ${budget}-token per-step ` +
    `ceiling, so the largest were trimmed at this line boundary. Recover the omitted tail by re-running this ` +
    `tool with a narrower scope, or page it via the result's cache_ref when one is provided.]`
  )
}
