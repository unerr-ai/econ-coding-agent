/**
 * Corpus harness for Sprint 0 shared tool primitives.
 * Covers: withMeta ratio computation, cache_ref array pagination.
 */
import { describe, expect, test, beforeEach } from "bun:test"
import { withMeta } from "../../../src/tool/_shared/types"
import { hashInputs, put, getSlice, clearCache } from "../../../src/tool/_shared/cache"
import { SAMPLE_ITEMS } from "./fixtures/sample-items"

// ---------------------------------------------------------------------------
// withMeta — ratio correctness
// ---------------------------------------------------------------------------

describe("withMeta", () => {
  test("ratio is 1 when raw and returned are the same string", () => {
    const content = "function foo() { return 42; }"
    const meta = withMeta(content, content)
    expect(meta.raw_tokens).toBe(meta.returned_tokens)
    expect(meta.ratio).toBe(1)
  })

  test("ratio < 1 when returned is shorter than raw", () => {
    const raw = "function foo() { return 42; }\n".repeat(20)
    const returned = "function foo() { return 42; }"
    const meta = withMeta(raw, returned)
    expect(meta.raw_tokens).toBeGreaterThan(meta.returned_tokens)
    expect(meta.ratio).toBeGreaterThan(0)
    expect(meta.ratio).toBeLessThan(1)
  })

  test("ratio is 1 when raw is empty (no divide-by-zero)", () => {
    const meta = withMeta("", "")
    expect(meta.ratio).toBe(1)
    expect(meta.raw_tokens).toBe(0)
    expect(meta.returned_tokens).toBe(0)
  })

  test("raw_tokens and returned_tokens are non-negative integers", () => {
    const meta = withMeta("hello world", "hello")
    expect(meta.raw_tokens).toBeGreaterThanOrEqual(0)
    expect(meta.returned_tokens).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(meta.ratio)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// cache_ref — pagination
// ---------------------------------------------------------------------------

describe("cache: hashInputs + put + getSlice", () => {
  beforeEach(() => {
    clearCache()
  })

  test("hashInputs returns a 16-char hex string", () => {
    const key = hashInputs("tool:read", "/some/file.ts")
    expect(key).toMatch(/^[0-9a-f]{16}$/)
  })

  test("hashInputs is deterministic", () => {
    const a = hashInputs("tool:read", "/some/file.ts")
    const b = hashInputs("tool:read", "/some/file.ts")
    expect(a).toBe(b)
  })

  test("hashInputs distinguishes order of parts", () => {
    const a = hashInputs("a", "bc")
    const b = hashInputs("ab", "c")
    expect(a).not.toBe(b)
  })

  test("getSlice returns null on cache miss", () => {
    const result = getSlice("no-such-key", 0, 5)
    expect(result).toBeNull()
  })

  test("put + getSlice: first page", () => {
    const key = hashInputs("fixture")
    put(key, SAMPLE_ITEMS)
    const result = getSlice(key, 0, 4)
    expect(result).not.toBeNull()
    expect(result!.total).toBe(10)
    expect(result!.slice).toHaveLength(4)
    expect(result!.more).toBe(true)
  })

  test("put + getSlice: last page has more=false", () => {
    const key = hashInputs("fixture")
    put(key, SAMPLE_ITEMS)
    const result = getSlice(key, 8, 4)
    expect(result).not.toBeNull()
    expect(result!.slice).toHaveLength(2) // only items 8 and 9 remain
    expect(result!.more).toBe(false)
  })

  test("put + getSlice: full collection in one shot", () => {
    const key = hashInputs("fixture")
    put(key, SAMPLE_ITEMS)
    const result = getSlice(key, 0, 100)
    expect(result!.slice).toHaveLength(10)
    expect(result!.more).toBe(false)
  })

  test("getSlice with offset beyond total returns empty slice", () => {
    const key = hashInputs("fixture")
    put(key, SAMPLE_ITEMS)
    const result = getSlice(key, 20, 5)
    expect(result!.slice).toHaveLength(0)
    expect(result!.more).toBe(false)
  })
})
