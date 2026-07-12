/**
 * Bounds the reasoning channel at the request seam, in both directions. An
 * ordinary request never ships the mute marker: a config-pinned
 * `reasoningEffort:"none"` is rewritten to the bounded "high" — never
 * deleted, because omitting the param means UNBOUNDED server-side thinking
 * (one 2,453s step on django-11964, e0-mini10-r1). A small housekeeping
 * one-shot is muted instead: thinking starves/slows its JSON output, so any
 * pinned effort collapses to "none". Requests already shipping a bounded
 * effort pass through untouched.
 *
 * @sem domain=routing role=gate
 */
export function guardReasoningEffort(options: Record<string, any>, small: boolean): "muted" | "bounded" | undefined {
  if (small) {
    if (options.reasoningEffort === undefined || options.reasoningEffort === "none") return undefined
    options.reasoningEffort = "none"
    return "muted"
  }
  // "none" is the deepseek-flash-era conductor mute; no live config pins it
  // anymore (E0 pins "high"), so this only fires on a stale or legacy config.
  if (options.reasoningEffort !== "none") return undefined
  options.reasoningEffort = "high"
  return "bounded"
}
