/**
 * Deletes the conductor tier's `reasoningEffort:"none"` marker on every
 * request so the provider default — the model's own, un-suppressed thinking
 * — always applies; the conductor is never muted. Every other tier's
 * reasoningEffort ("low" for executor, "high" for oracle/reasoner) is left
 * untouched.
 *
 * @sem domain=routing role=gate
 */
export function applyAdaptiveReasoning(options: Record<string, any>): boolean {
  // Only the conductor tier ships reasoningEffort:"none" (executor uses "low",
  // oracle/reasoner "high") — anything else passes through untouched.
  if (options.reasoningEffort !== "none") return false
  delete options.reasoningEffort
  return true
}
