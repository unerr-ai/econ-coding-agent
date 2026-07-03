/**
 * CLI entrypoint for the loop-adherence eval.
 *
 * Usage:
 *   bun run packages/eval/src/loop-index.ts
 *
 * Exit code 0 = every case cleared its threshold. Exit code 1 = one or more failed.
 * @sem domain=eval role=entrypoint
 */

import { LOOP_CASES } from "./loop-cases.js"
import { runLoopEval } from "./loop-harness.js"
import { renderLoopReport } from "./loop-scorer.js"

async function main() {
  const results = await runLoopEval(LOOP_CASES)
  console.log(renderLoopReport(results))

  const anyFailing = results.some((r) => !r.pass)
  process.exit(anyFailing ? 1 : 0)
}

main().catch((err) => {
  console.error("loop eval fatal error:", err)
  process.exit(2)
})
