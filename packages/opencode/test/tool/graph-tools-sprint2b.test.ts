/**
 * Sprint 2B graph-tools tests: lean-index enrichment, cache_ref pagination,
 * and ur|rsk signal emission. Tests the enrichEntities helper and _shared
 * cache primitives directly — no Effect runtime needed.
 */
import { describe, it, expect, beforeEach } from "bun:test"
import { join } from "node:path"
import { enrichEntities, RSK_CALLER_THRESHOLD } from "../../src/tool/graph-tools-enrich"
import { hashInputs, put, getSlice, clearCache } from "../../src/tool/_shared"

// ---------------------------------------------------------------------------
// Fixture directory (reuse code-intelligence fixtures — same repo)
// ---------------------------------------------------------------------------

const FIXTURE_DIR = join(import.meta.dir, "../../../code-intelligence/test/fixture")

// ---------------------------------------------------------------------------
// _shared cache primitives
// ---------------------------------------------------------------------------

describe("_shared cache — put + getSlice", () => {
  beforeEach(() => { clearCache() })

  it("hashInputs produces a stable 16-char hex key", () => {
    const key = hashInputs("foo", "bar")
    expect(typeof key).toBe("string")
    expect(key.length).toBe(16)
    expect(/^[0-9a-f]+$/.test(key)).toBe(true)
    // Stable: same inputs → same key
    expect(hashInputs("foo", "bar")).toBe(key)
    // Different inputs → different key
    expect(hashInputs("foo", "baz")).not.toBe(key)
  })

  it("put + getSlice round-trips items", () => {
    const key = hashInputs("test-query", "full_bodies")
    const items = [
      { key: "a.ts:greet:function", body: "function greet(...) {}" },
      { key: "b.ts:Calculator:class", body: "class Calculator {}" },
    ]
    put(key, items)

    const slice = getSlice(key, 0, 10)
    expect(slice).not.toBeNull()
    expect(slice!.total).toBe(2)
    expect(slice!.more).toBe(false)
    expect(slice!.slice.length).toBe(2)
  })

  it("getSlice paginates correctly", () => {
    const key = hashInputs("page-test", "full_bodies")
    const items = Array.from({ length: 5 }, (_, i) => ({ key: `e${i}`, body: `body ${i}` }))
    put(key, items)

    const page0 = getSlice(key, 0, 2)
    expect(page0!.slice.length).toBe(2)
    expect(page0!.more).toBe(true)
    expect(page0!.total).toBe(5)

    const page1 = getSlice(key, 2, 2)
    expect(page1!.slice.length).toBe(2)
    expect(page1!.more).toBe(true)

    const page2 = getSlice(key, 4, 2)
    expect(page2!.slice.length).toBe(1)
    expect(page2!.more).toBe(false)
  })

  it("getSlice returns null on cache miss", () => {
    expect(getSlice("nonexistent-key-xyz", 0, 5)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// enrichEntities — lean projection + cache storage + ur|rsk signals
// ---------------------------------------------------------------------------

describe("enrichEntities", () => {
  beforeEach(() => { clearCache() })

  it("returns lean entity with preview from real fixture file", async () => {
    const entities = [
      {
        key: "a.ts:greet:function",
        name: "greet",
        kind: "function",
        filePath: "a.ts",
        lineStart: 2,
        lineEnd: 4,
        caller_count: 1,
      },
    ]
    const { lean, cacheKey, total, signals } = await enrichEntities(entities, FIXTURE_DIR, "test-greet")

    expect(lean.length).toBe(1)
    expect(lean[0]).toHaveProperty("preview")
    expect(typeof lean[0]!.preview).toBe("string")
    expect((lean[0]!.preview as string).length).toBeGreaterThan(0)
    expect((lean[0]!.preview as string).split("\n").length).toBeLessThanOrEqual(15)
    // No full body in lean output
    expect((lean[0] as { body?: unknown }).body).toBeUndefined()

    expect(typeof cacheKey).toBe("string")
    expect(cacheKey.length).toBe(16)
    expect(total).toBe(1)
    expect(signals).toEqual([]) // caller_count=1 < threshold
  })

  it("stores full body in cache under cacheKey", async () => {
    clearCache()
    const entities = [
      {
        key: "a.ts:greet:function",
        name: "greet",
        kind: "function",
        filePath: "a.ts",
        lineStart: 2,
        lineEnd: 4,
        caller_count: 0,
      },
    ]
    const { cacheKey } = await enrichEntities(entities, FIXTURE_DIR, "cache-test")

    // getSlice should return the stored body
    const slice = getSlice(cacheKey, 0, 10)
    expect(slice).not.toBeNull()
    expect(slice!.total).toBe(1)
    const stored = slice!.slice[0] as { key: string; body: string }
    expect(stored.key).toBe("a.ts:greet:function")
    expect(stored.body).toContain("greet")
  })

  it("emits ur|rsk signal for entity with caller_count >= threshold", async () => {
    const entities = [
      {
        key: "hot.ts:hotFunction:function",
        name: "hotFunction",
        kind: "function",
        filePath: "a.ts", // use existing fixture file so readFile succeeds
        lineStart: 1,
        lineEnd: 5,
        caller_count: RSK_CALLER_THRESHOLD, // exactly at threshold
      },
    ]
    const { signals } = await enrichEntities(entities, FIXTURE_DIR, "rsk-test")

    expect(signals.length).toBeGreaterThanOrEqual(1)
    const signal = signals[0]!
    expect(signal).toContain("ur|rsk")
    expect(signal).toContain("hotFunction")
    expect(signal).toContain(String(RSK_CALLER_THRESHOLD))
  })

  it("does NOT emit ur|rsk for entity below threshold", async () => {
    const entities = [
      {
        key: "a.ts:greet:function",
        name: "greet",
        kind: "function",
        filePath: "a.ts",
        lineStart: 2,
        lineEnd: 4,
        caller_count: RSK_CALLER_THRESHOLD - 1,
      },
    ]
    const { signals } = await enrichEntities(entities, FIXTURE_DIR, "no-rsk-test")
    expect(signals.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// cache_ref pagination end-to-end simulation
// ---------------------------------------------------------------------------

describe("cache_ref pagination end-to-end", () => {
  beforeEach(() => { clearCache() })

  it("enrichEntities → getSlice returns withheld full body by cache_ref", async () => {
    const entities = [
      { key: "a.ts:greet:function", name: "greet", kind: "function", filePath: "a.ts", lineStart: 2, lineEnd: 4, caller_count: 0 },
      { key: "b.ts:Calculator:class", name: "Calculator", kind: "class", filePath: "b.ts", lineStart: 2, lineEnd: 13, caller_count: 0 },
    ]

    const { cacheKey, total } = await enrichEntities(entities, FIXTURE_DIR, "e2e-page")
    expect(total).toBe(2)

    // Page 0: one item
    const page0 = getSlice(cacheKey, 0, 1)
    expect(page0).not.toBeNull()
    expect(page0!.slice.length).toBe(1)
    expect(page0!.more).toBe(true)
    const item0 = page0!.slice[0] as { key: string; body: string }
    expect(item0.body).toContain("greet")

    // Page 1: second item
    const page1 = getSlice(cacheKey, 1, 1)
    expect(page1).not.toBeNull()
    expect(page1!.slice.length).toBe(1)
    expect(page1!.more).toBe(false)
    const item1 = page1!.slice[0] as { key: string; body: string }
    expect(item1.body).toContain("Calculator")
  })
})
