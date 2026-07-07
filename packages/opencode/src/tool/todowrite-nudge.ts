/**
 * Nudge text to append to the NEXT tool call's result (of any kind) when the
 * session's PREVIOUS assistant step ran a todowrite as its only tool call —
 * the conductor prompt asks for status flips to ride along with the work
 * they record, not run as their own step. It rides on the next tool call of
 * any kind, not specifically the next todowrite, because flips alternate
 * with work steps — a todowrite-only trigger never fires. The previous step
 * is judged (not the current one) because tools execute mid-stream: the
 * current step's sibling tool parts may not be persisted yet when this call
 * runs, and a same-step count would false-fire on a correctly-batched
 * leading flip.
 *
 * @sem domain=routing role=standalone-todo-nudge
 */
export function standaloneTodowriteSuffix(priorParts: readonly { type: string; tool?: string }[] | undefined): string {
  if (!priorParts) return ""
  const toolParts = priorParts.filter((part) => part.type === "tool")
  if (toolParts.length !== 1 || toolParts[0].tool !== "todowrite") return ""
  return "\n[econ-nudge] previous step was a standalone todowrite — flip statuses in the same step as the work, not as their own step."
}

// Once-guard: at most one tool call decorates a given offending prior
// message per session. Parallel tool calls in one step share the same prior
// messageID — claimNudge is a synchronous compare-and-set, so only the first
// claimant wins even when several tool executes race for the same offending
// message.
const lastNudgedMessageID = new Map<string, string>()

/**
 * Atomically claims the right to append the standalone-todowrite nudge for
 * `messageID` in `sessionID`. Returns true the first time a given message is
 * claimed and false on every later attempt for that same message — callers
 * must claim before appending, not after, so parallel tool executes settle
 * on exactly one decorated output.
 *
 * @sem domain=routing role=standalone-todo-nudge-guard
 */
export function claimNudge(sessionID: string, messageID: string): boolean {
  if (lastNudgedMessageID.get(sessionID) === messageID) return false
  lastNudgedMessageID.set(sessionID, messageID)
  return true
}

/** Test-only: resets once-guard state between test cases. */
export function clear(): void {
  lastNudgedMessageID.clear()
}
