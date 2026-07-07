/**
 * Everyday-capability eval runner (OL-7.12). `runEverydayEval` scores each
 * case's canned mock fields (dry-run, no model call, no network);
 * `runEverydayEvalLive` scores a case after substituting real measurements
 * from a caller-supplied live source, sharing the same `scoreEverydayCase`
 * scorer — mirrors the loop-eval's mock/live split in loop-harness.ts.
 * @sem domain=eval role=harness
 */

import type { EverydayCase, EverydayResult } from "./everyday-types.js"
import { evaluateFlipGate, scoreEverydayCase } from "./everyday-scorer.js"
import type { FlipGateSummary } from "./everyday-types.js"

/**
 * Runs the everyday-capability eval over a set of cases using each case's
 * canned/mock fields (latency numbers, mockTrace, mockTurns) — fully offline.
 */
export async function runEverydayEval(cases: EverydayCase[]): Promise<EverydayResult[]> {
  return cases.map(scoreEverydayCase)
}

/** Produces a live-measured version of one case (e.g. by running the built binary). */
export type LiveEverydaySource = (c: EverydayCase) => Promise<EverydayCase>

/**
 * Runs the everyday-capability eval against a live source instead of each
 * case's canned fields — same `scoreEverydayCase` scorer as `runEverydayEval`.
 * Cases run sequentially (each may be a real subprocess call), so results
 * stay in case order.
 */
export async function runEverydayEvalLive(cases: EverydayCase[], liveSource: LiveEverydaySource): Promise<EverydayResult[]> {
  const results: EverydayResult[] = []
  for (const c of cases) {
    const liveCase = await liveSource(c)
    results.push(scoreEverydayCase(liveCase))
  }
  return results
}

/** Convenience: runs the offline eval and rolls it up into the flip-gate verdict in one call. */
export async function runEverydayFlipGate(cases: EverydayCase[]): Promise<FlipGateSummary> {
  const results = await runEverydayEval(cases)
  return evaluateFlipGate(cases, results)
}
