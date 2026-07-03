/**
 * Loop-adherence eval runner — scores each case's trace and returns
 * per-case results. `runLoopEval` scores the canned `mockTrace` (dry-run,
 * no model call); `runLoopEvalLive` scores a real trace pulled from a
 * caller-supplied trace source, sharing the same `scoreLoopCase` scorer.
 * @sem domain=eval role=harness
 */

import type { LoopCase, LoopResult, LoopTrace } from "./loop-types.js"
import { scoreLoopCase } from "./loop-scorer.js"

/**
 * Runs the loop-adherence eval over a set of cases. Each case's mockTrace
 * stands in for a live conductor-turn trace (dry-run mode) — swapping in a
 * real trace source is a drop-in replacement for `scoreLoopCase`'s second arg.
 */
export async function runLoopEval(cases: LoopCase[]): Promise<LoopResult[]> {
  return cases.map((c) => scoreLoopCase(c, c.mockTrace))
}

/** Produces a real LoopTrace for one case (e.g. by running a live conductor turn). */
export type LiveTraceSource = (loopCase: LoopCase) => Promise<LoopTrace>

/**
 * Runs the loop-adherence eval against a live trace source instead of each
 * case's canned mockTrace — same `scoreLoopCase` scorer as `runLoopEval`,
 * so a case that passes the dry-run must still explain what changed if it
 * fails here. Cases run sequentially (each is a real subprocess call, not
 * free), so results stay in case order.
 */
export async function runLoopEvalLive(cases: LoopCase[], traceSource: LiveTraceSource): Promise<LoopResult[]> {
  const results: LoopResult[] = []
  for (const c of cases) {
    const trace = await traceSource(c)
    results.push(scoreLoopCase(c, trace))
  }
  return results
}
