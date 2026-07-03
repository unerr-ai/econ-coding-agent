/**
 * Manual/opt-in live-runner for the loop-adherence eval — scores LOOP_CASES
 * against real conductor traces from the built `opencode` binary instead of
 * canned mockTrace. Requires the built binary (packages/opencode/dist/...)
 * plus live model credentials; NOT part of default test/CI — run explicitly
 * via `bun run loop-live`.
 *
 * Usage:
 *   bun run packages/eval/src/loop-live.ts [path-to-opencode-binary]
 *
 * Exit code 0 = every case cleared its threshold. Exit code 1 = one or more failed.
 * @sem domain=eval role=entrypoint
 */

import { LOOP_CASES } from "./loop-cases.js"
import { runLoopEvalLive } from "./loop-harness.js"
import { renderLoopReport } from "./loop-scorer.js"
import { binaryTraceSource, DEFAULT_BINARY_PATH } from "./loop-live-source.js"

async function main() {
  const binaryPath = process.argv[2] ?? DEFAULT_BINARY_PATH
  const results = await runLoopEvalLive(LOOP_CASES, (c) => binaryTraceSource(c, binaryPath))
  console.log(renderLoopReport(results))

  const anyFailing = results.some((r) => !r.pass)
  process.exit(anyFailing ? 1 : 0)
}

main().catch((err) => {
  console.error("loop-live eval fatal error:", err)
  process.exit(2)
})
