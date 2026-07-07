/**
 * Word-boundary-safe matcher for test/verify/build shell commands (jest, vitest,
 * mocha, pytest, go test, cargo test/check, bun/npm/yarn/pnpm test, tsc/typecheck) —
 * the trigger `noteVerifyCommand` checks each shell invocation against.
 *
 * @sem domain=routing role=verify-tail-detector
 */
export const TEST_COMMAND_RE =
  /\b(jest|vitest|mocha|pytest|go\s+test|cargo\s+test|cargo\s+check|bun\s+test|npm\s+test|yarn\s+test|pnpm\s+test|tsc|typecheck)\b/

interface VerifyWindow {
  count: number
  lastAt: number
}

const WINDOW_MS = 15 * 60 * 1000

const windows = new Map<string, VerifyWindow>()

/**
 * Tracks how many test/verify commands the conductor has run inline in a session
 * (15-minute rolling window) and returns a nudge at the 3rd and 8th to push the
 * remaining verification matrix onto a runner side-task instead of grinding through
 * it turn by turn.
 *
 * @sem domain=routing role=verify-tail-nudge
 */
export function noteVerifyCommand(sessionID: string, agent: string, command: string, now: number = Date.now()): string | null {
  if (agent !== "conductor" || !TEST_COMMAND_RE.test(command)) return null

  const prev = windows.get(sessionID)
  const count = prev && now - prev.lastAt <= WINDOW_MS ? prev.count + 1 : 1
  windows.set(sessionID, { count, lastAt: now })

  if (count !== 3 && count !== 8) return null
  return `[econ-nudge] verify-tail: this is test/build run #${count} this window — hand the remaining verification matrix to ONE runner side-task (task tool, subagent_type:"runner", with the exact commands in order and the report format you expect), then continue non-overlapping work.`
}
