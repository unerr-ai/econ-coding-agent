/**
 * Manual/opt-in live-runner for the everyday-capability eval (OL-7.12) —
 * scores EVERYDAY_CASES against real traces from the built `opencode` binary
 * instead of canned mock fields. Requires the built binary
 * (packages/opencode/dist/...) plus live model credentials, AND the explicit
 * env gate `ECON_EVAL_LIVE=1` (refuses to spawn anything otherwise — see
 * everyday-live-source.ts). NOT part of default test/CI — run explicitly via
 * `bun run everyday-live`.
 *
 * Usage:
 *   ECON_EVAL_LIVE=1 bun run packages/eval/src/everyday-live.ts [path-to-opencode-binary]
 *
 * Exit code 0 = flip gate passes. Exit code 1 = flip gate fails. Exit code 3
 * = env gate not set (nothing was run).
 * @sem domain=eval role=entrypoint
 */

import { EVERYDAY_CASES } from "./everyday-cases.js"
import { runEverydayEvalLive } from "./everyday-harness.js"
import { evaluateFlipGate, renderEverydayReport } from "./everyday-scorer.js"
import { DEFAULT_BINARY_PATH, liveEverydaySource, liveRunEnabled } from "./everyday-live-source.js"

async function main() {
  if (!liveRunEnabled()) {
    console.error("everyday-live: refusing to run — set ECON_EVAL_LIVE=1 to opt in to live model/binary calls.")
    process.exit(3)
  }

  const binaryPath = process.argv[2] ?? DEFAULT_BINARY_PATH
  const results = await runEverydayEvalLive(EVERYDAY_CASES, (c) => liveEverydaySource(c, binaryPath))
  const summary = evaluateFlipGate(EVERYDAY_CASES, results)
  console.log(renderEverydayReport(summary))
  process.exit(summary.pass ? 0 : 1)
}

main().catch((err) => {
  console.error("everyday-live eval fatal error:", err)
  process.exit(2)
})
