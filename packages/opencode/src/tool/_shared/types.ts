/**
 * Shared output contract for econ tool results — carries the structured payload,
 * rendered content string, and token-optimization metadata so callers can
 * surface savings and wire cache-ref pagination without per-tool boilerplate.
 *
 * @sem domain=intelligence role=tools
 */

import { estimateTokens } from "../../../../code-intelligence/src/trim"

// ---------------------------------------------------------------------------
// Output contract
// ---------------------------------------------------------------------------

/**
 * Per-call token-optimization metadata appended to every tool result.
 * Mirrors the unerr-cli §4 accounting fields (shell-compression-log.ts) so
 * the two stacks can share the same dashboard path later.
 */
export interface ToolMeta {
  /** Estimated token count of the raw (pre-truncation) content. */
  raw_tokens: number
  /** Estimated token count of what was actually returned to the model. */
  returned_tokens: number
  /** returned_tokens / raw_tokens — lower means more was compressed away. */
  ratio: number
  /** Present when the call stored pageable items; pass back as cache_ref to page. */
  cache_ref?: string
  /** Total items in the cached collection when cache_ref is set. */
  total?: number
  /** True when more items remain beyond the current slice. */
  more?: boolean
}

/**
 * Canonical tool result envelope used by all econ-side tools.
 * `content` is the model-facing string; `structured` carries a typed payload
 * for callers that want to process the result programmatically.
 */
export interface ToolResult<T = unknown> {
  /** Typed payload — present when the tool produces a parseable structure. */
  structured?: T
  /** The string the model sees (may be a truncated/compressed view of `structured`). */
  content: string
  /** Token-optimization metadata for telemetry and cache-ref pagination. */
  meta: ToolMeta
}

// ---------------------------------------------------------------------------
// withMeta helper
// ---------------------------------------------------------------------------

/**
 * Compute ToolMeta from raw and returned content strings.
 * Uses the content-aware estimateTokens heuristic from code-intelligence/trim
 * (accurate to ±10–20% for code and prose, no external deps).
 * Returned ratio = returned_tokens / raw_tokens; 1.0 when raw is empty.
 */
export function withMeta(rawContent: string, returnedContent: string): ToolMeta {
  const raw_tokens = estimateTokens(rawContent)
  const returned_tokens = estimateTokens(returnedContent)
  const ratio = raw_tokens > 0 ? returned_tokens / raw_tokens : 1
  return { raw_tokens, returned_tokens, ratio }
}
