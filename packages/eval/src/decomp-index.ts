/**
 * CLI entrypoint for the decomposition-quality eval (OL-7.4).
 *
 * Usage:
 *   bun run packages/eval/src/decomp-index.ts
 *
 * Exit code 0 = every case cleared its threshold. Exit code 1 = one or more failed.
 * @sem domain=eval role=entrypoint
 */

import { DECOMP_CASES } from "./decomp-cases.js"
import { runDecompEval } from "./decomp-harness.js"
import { renderDecompReport } from "./decomp-scorer.js"

async function main() {
  const results = await runDecompEval(DECOMP_CASES)
  console.log(renderDecompReport(results))

  const anyFailing = results.some((r) => !r.pass)
  process.exit(anyFailing ? 1 : 0)
}

main().catch((err) => {
  console.error("decomp eval fatal error:", err)
  process.exit(2)
})
