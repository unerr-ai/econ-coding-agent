/**
 * Bounds the reasoning channel at the request seam, in both directions. An
 * ordinary request never ships the mute marker: a config-pinned
 * `reasoningEffort:"none"` is rewritten to the bounded "high" — never
 * deleted, because omitting the param means UNBOUNDED server-side thinking
 * (one observed 2,453s step). A small housekeeping
 * one-shot is muted instead: thinking starves/slows its JSON output, so any
 * pinned effort collapses to the minimal VALID level "low". It is NOT muted to
 * "none": the small_model (gpt-oss-120b) rejects reasoningEffort "none" on
 * Fireworks with a 400 ("Invalid reasoning effort: none") — "none" is not one
 * of its trained levels, so the housekeeping call (title/summary) errored out.
 * "low" is the floor of thinking every reasoning model accepts, so it mutes
 * without breaking the call; an incoming stale "none" is rewritten too (it
 * would 400 the same). Requests already at "low" pass through untouched.
 *
 * @sem domain=routing role=gate
 */
export function guardReasoningEffort(options: Record<string, any>, small: boolean): "muted" | "bounded" | undefined {
  if (small) {
    if (options.reasoningEffort === undefined || options.reasoningEffort === "low") return undefined
    options.reasoningEffort = "low"
    return "muted"
  }
  // "none" is the deepseek-flash-era conductor mute; no live config pins it
  // anymore (E0 pins "high"), so this only fires on a stale or legacy config.
  if (options.reasoningEffort !== "none") return undefined
  options.reasoningEffort = "high"
  return "bounded"
}
