/**
 * In-process SHA-256 hash cache for compressed web-fetch results.
 *
 * Cache key = URL + SHA-256(html content) + prompt + topK, so the same URL
 * with identical content and query parameters returns the cached ranked
 * passages without re-running extraction or BM25. The cache is intentionally
 * in-process (Map) rather than file-backed to avoid I/O dependencies; it
 * survives across tool calls within one agent session.
 *
 * @sem domain=intelligence role=webfetch
 */

import { createHash } from "node:crypto"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A cached compression result: pre-ranked passages as a formatted string plus
 * the ratio of output-to-input length.
 *
 * @sem domain=intelligence role=webfetch
 */
export interface CacheEntry {
  /** Formatted passage output (ready to return as tool output). */
  passages: string
  /** output.length / original HTML length — used for size-reduction reporting. */
  compressionRatio: number
  /** Number of ranked passages included. */
  passageCount: number
}

// ---------------------------------------------------------------------------
// Internal store
// ---------------------------------------------------------------------------

const _store = new Map<string, CacheEntry>()

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute a short SHA-256 digest of arbitrary string input. Used to
 * fingerprint the raw HTML so cache misses are detected when the page changes.
 *
 * @sem domain=intelligence role=webfetch
 */
export function contentHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16)
}

/**
 * Build a composite cache key from all request dimensions so distinct prompts
 * or topK values on the same URL are cached independently.
 *
 * @sem domain=intelligence role=webfetch
 */
export function buildCacheKey(url: string, htmlHash: string, prompt: string, topK: number): string {
  return `${url}\x00${htmlHash}\x00${prompt}\x00${topK}`
}

/**
 * Look up a previously computed result. Returns undefined on cache miss.
 *
 * @sem domain=intelligence role=webfetch
 */
export function getCached(key: string): CacheEntry | undefined {
  return _store.get(key)
}

/**
 * Store a compression result under the given key.
 *
 * @sem domain=intelligence role=webfetch
 */
export function setCached(key: string, entry: CacheEntry): void {
  _store.set(key, entry)
}

/**
 * Clear the entire in-process cache. Used in tests to ensure isolation.
 *
 * @sem domain=intelligence role=webfetch
 */
export function clearCache(): void {
  _store.clear()
}

/**
 * Return the number of entries currently held in cache.
 *
 * @sem domain=intelligence role=webfetch
 */
export function cacheSize(): number {
  return _store.size
}
