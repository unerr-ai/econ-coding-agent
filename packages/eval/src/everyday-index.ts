/**
 * CLI entrypoint for the everyday-capability eval (OL-7.12) — the honesty
 * gate against SWE-bench-style deltas. Scores EVERYDAY_CASES against their
 * canned/mock fields (offline, no network, no live model call) and prints
 * the pass/fail flip-gate summary CP-D can cite for the OL-7.6 default-flip
 * criterion.
 *
 * Usage:
 *   bun run packages/eval/src/everyday-index.ts
 *
 * Exit code 0 = flip gate passes. Exit code 1 = flip gate fails.
 * @sem domain=eval role=entrypoint
 */

import { EVERYDAY_CASES } from "./everyday-cases.js"
import { runEverydayFlipGate } from "./everyday-harness.js"
import { renderEverydayReport } from "./everyday-scorer.js"

async function main() {
  const summary = await runEverydayFlipGate(EVERYDAY_CASES)
  console.log(renderEverydayReport(summary))
  process.exit(summary.pass ? 0 : 1)
}

main().catch((err) => {
  console.error("everyday eval fatal error:", err)
  process.exit(2)
})
