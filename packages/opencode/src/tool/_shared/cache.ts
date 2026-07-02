/**
 * In-memory, hash-keyed reversible cache for pageable tool results.
 * Mirrors the pattern from unerr-cli/src/proxy/reversible-cache.ts but
 * targets array pagination (getSlice) rather than character-range slicing,
 * which is the dominant access pattern for tool results (passages, entities,
 * lines).
 *
 * @sem domain=intelligence role=cache
 */

import { createHash } from "node:crypto"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hex chars in the emitted cache key (16 = 64 bits — collision-safe for in-process use). */
const CACHE_HASH_LENGTH = 16

/** Maximum live entries before oldest is silently evicted. */
const MAX_ENTRIES = 256

// ---------------------------------------------------------------------------
// Internal store
// ---------------------------------------------------------------------------

interface CacheEntry {
  items: unknown[]
}

/** Module-level LRU store (Map preserves insertion order for eviction). */
const store = new Map<string, CacheEntry>()

function evict(): void {
  if (store.size <= MAX_ENTRIES) return
  const oldest = store.keys().next()
  if (!oldest.done) store.delete(oldest.value)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Derive a stable cache key from one or more string parts.
 * Parts are hashed in order with a null-byte separator so
 * `hashInputs("a", "bc")` !== `hashInputs("ab", "c")`.
 */
export function hashInputs(...parts: string[]): string {
  const h = createHash("sha256")
  for (const part of parts) {
    h.update(part, "utf8")
    h.update("\0", "utf8")
  }
  return h.digest("hex").slice(0, CACHE_HASH_LENGTH)
}

/**
 * Store an array under `key`. Silently overwrites an existing entry with the
 * same key (last-write-wins; content-addressed callers use hashInputs so
 * identical content always maps to the same key anyway).
 */
export function put(key: string, items: unknown[]): void {
  store.delete(key) // refresh position for LRU
  store.set(key, { items })
  evict()
}

/** Return type for getSlice — a single page plus pagination signals. */
export interface SliceResult {
  /** The requested subarray `items[offset..offset+limit]`. */
  slice: unknown[]
  /** Total items in the cached collection. */
  total: number
  /** True when items remain beyond the end of this slice. */
  more: boolean
}

/**
 * Return a paginated slice of the cached array at `key`.
 * Returns null on a cache miss (caller should recompute).
 * `offset` is 0-based; `limit` caps the page size.
 */
export function getSlice(key: string, offset: number, limit: number): SliceResult | null {
  const entry = store.get(key)
  if (!entry) return null

  // Refresh LRU position on hit.
  store.delete(key)
  store.set(key, entry)

  const { items } = entry
  const total = items.length
  const start = Math.max(0, offset)
  const end = Math.min(total, start + Math.max(0, limit))
  return { slice: items.slice(start, end), total, more: end < total }
}

/**
 * Evict all entries — intended for tests and process-exit cleanup.
 * Not needed in normal operation; the module-level store is process-scoped.
 */
export function clearCache(): void {
  store.clear()
}
