/**
 * Decomposition-quality eval runner (OL-7.4) — scores each case's canned
 * conductor todos through the real `todosToLoopSlices` + `allocateSlice`
 * pipeline (dry-run, no model call).
 * @sem domain=eval role=harness
 */

import type { DecompCase, DecompResult } from "./decomp-types.js"
import { scoreDecompCase } from "./decomp-scorer.js"

/**
 * Runs the decomposition-quality eval over a set of cases. Each case's
 * `mockTodos` stands in for a live conductor decomposition (dry-run mode) —
 * a live conductor-emission source would be a drop-in replacement for the
 * `mockTodos` fed into `scoreDecompCase`.
 */
export async function runDecompEval(cases: DecompCase[]): Promise<DecompResult[]> {
  const results: DecompResult[] = []
  for (const c of cases) results.push(await scoreDecompCase(c))
  return results
}
