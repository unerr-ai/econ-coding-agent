/**
 * Sprint 0 shared primitives for econ tool token-optimization.
 * Import from this barrel rather than the individual files so the internal
 * layout can change without touching every consumer.
 *
 * @sem domain=intelligence role=tools
 */

export type { ToolMeta, ToolResult } from "./types"
export { withMeta } from "./types"

export type { SliceResult } from "./cache"
export { hashInputs, put, getSlice, clearCache } from "./cache"

export type { ToolCallRecord } from "./meter"
export { recordToolCall, getRecords, clearRecords } from "./meter"

export type { ReadDedupResult, ContentHashResult } from "./read-dedup"
export {
  hashContent,
  checkReadDedup,
  clearReadDedup,
  seedReadDedup,
  computeContentHash,
  IncrementalLineHasher,
  READ_MAX_LINE_LENGTH,
  READ_MAX_BYTES,
} from "./read-dedup"
