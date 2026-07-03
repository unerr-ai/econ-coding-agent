/**
 * Scores a LoopTrace against a LoopCase's expectations — detects the four
 * loop-adherence signals from observable tool calls / text and combines
 * the ones the case expects into a weighted score gated by its threshold.
 * @sem domain=eval role=scoring
 */

import type { LoopCase, LoopResult, LoopSignals, LoopTrace } from "./loop-types.js"

/** Minimum char length for the opening text to be considered for a meta-plan. */
const META_PLAN_MIN_CHARS = 40
const NUMBERED_LIST_RE = /(^|\n)\s*(\d+[.)]|[-*])\s+\S/
const PLAN_KEYWORD_RE = /\b(plan|steps?|first|then|approach|going to|I'll|I will)\b/i

/** Lightweight heuristic: does the assistant's opening text read like a meta-plan? */
function hasMetaPlan(trace: LoopTrace): boolean {
  const opening = trace.textParts[0]?.trim() ?? ""
  if (opening.length < META_PLAN_MIN_CHARS) return false
  return NUMBERED_LIST_RE.test(opening) || PLAN_KEYWORD_RE.test(opening)
}

/** A `todowrite` tool call occurred anywhere in the trace. */
function usedTaskList(trace: LoopTrace): boolean {
  return trace.toolCalls.some((tc) => tc.name === "todowrite")
}

/** Any `task` tool call occurred anywhere in the trace. */
function calledTask(trace: LoopTrace): boolean {
  return trace.toolCalls.some((tc) => tc.name === "task")
}

/** A `task` call whose input mentions verification intent (description/prompt text). */
function calledVerifyTask(trace: LoopTrace): boolean {
  return trace.toolCalls.some((tc) => {
    if (tc.name !== "task") return false
    const fields = Object.values(tc.input ?? {}).filter((v): v is string => typeof v === "string")
    return fields.some((v) => /verify|typecheck|test/i.test(v))
  })
}

/** Computes the four boolean signals for one trace against its case's expectations. */
export function detectSignals(loopCase: LoopCase, trace: LoopTrace): LoopSignals {
  return {
    has_meta_plan: hasMetaPlan(trace),
    used_task_list: usedTaskList(trace),
    delegated_when_expected: loopCase.expectDelegation ? calledTask(trace) : true,
    verified_nontrivial: loopCase.expectVerification ? calledVerifyTask(trace) : true,
  }
}

/**
 * Scores one case's trace: equal-weights the signals the case actually
 * expects (has_meta_plan/used_task_list only for non-trivial cases,
 * delegation/verification only when the case flags them), then compares
 * the weighted average to the case's threshold. A case that expects
 * nothing (fully trivial) vacuously scores 1.
 */
export function scoreLoopCase(loopCase: LoopCase, trace: LoopTrace): LoopResult {
  const signals = detectSignals(loopCase, trace)

  const applicable: (keyof LoopSignals)[] = []
  if (loopCase.nontrivial) applicable.push("has_meta_plan", "used_task_list")
  if (loopCase.expectDelegation) applicable.push("delegated_when_expected")
  if (loopCase.expectVerification) applicable.push("verified_nontrivial")

  const weightedScore =
    applicable.length === 0
      ? 1
      : applicable.reduce((sum, key) => sum + (signals[key] ? 1 : 0), 0) / applicable.length

  return {
    caseId: loopCase.id,
    signals,
    weightedScore,
    threshold: loopCase.threshold,
    pass: weightedScore >= loopCase.threshold,
  }
}

/** Renders a human-readable report for a set of loop-eval results. */
export function renderLoopReport(results: LoopResult[]): string {
  const lines: string[] = []
  lines.push("\necon eval — loop adherence")
  lines.push("=".repeat(60))
  for (const r of results) {
    const icon = r.pass ? "✓" : "✗"
    lines.push(`  ${icon} ${r.caseId}  score=${r.weightedScore.toFixed(2)} (threshold=${r.threshold})`)
    lines.push(
      `       meta_plan=${r.signals.has_meta_plan} task_list=${r.signals.used_task_list} ` +
        `delegated=${r.signals.delegated_when_expected} verified=${r.signals.verified_nontrivial}`,
    )
  }
  lines.push("")
  return lines.join("\n")
}
