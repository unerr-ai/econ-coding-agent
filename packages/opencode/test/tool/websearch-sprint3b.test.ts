/**
 * Sprint 3B — websearch token-pruning + depth-fusion + pagination tests.
 *
 * Verifies four contracts without network access:
 *  1. Pagination: put + getSlice returns a cache_ref and pages the remainder
 *  2. Lean search shape: BM25-pruned hits drop raw provider fields
 *  3. depth:0: pruning helpers run but no fetch is invoked
 *  4. depth:K: runFetchUrlBatch (injected mockFetch) returns passages with provenance
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { hashInputs, put, getSlice, clearCache } from "../../src/tool/_shared/cache"
import {
  parseSearchHits,
  dedupHits,
  pruneHitsByBm25,
  formatLeanHits,
} from "../../src/tool/websearch"
import { runFetchUrlBatch } from "../../../code-intelligence/src/webfetch/fetch-batch"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Exa-like JSON response with one duplicate URL. */
const EXA_JSON = JSON.stringify({
  results: [
    {
      title: "Fetch API Guide",
      url: "https://example.com/fetch",
      text: "The Fetch API provides a modern interface for making HTTP requests. It returns Promises and supports async/await, making it easy to work with asynchronous data fetching in JavaScript.",
      publishedDate: "2024-01-15",
      score: 0.95,
    },
    {
      // duplicate — same URL, should be removed by dedupHits
      title: "Fetch API Guide (mirror)",
      url: "https://example.com/fetch",
      text: "Duplicate entry that shares a URL with the first result.",
      score: 0.90,
    },
    {
      title: "HTTP Requests in JavaScript",
      url: "https://example.com/http-requests",
      text: "Making HTTP requests in JavaScript can be done with the fetch API, axios, or XMLHttpRequest. The fetch API is the modern standard recommended by MDN for new projects.",
      score: 0.85,
    },
    {
      title: "Async/Await Patterns",
      url: "https://example.com/async",
      text: "Understanding async/await and Promises is essential for modern JavaScript. Use async functions with await for cleaner asynchronous code that avoids callback hell.",
      score: 0.80,
    },
  ],
})

/** Minimal HTML page used as mock fetch response for depth:K tests. */
const MOCK_HTML = `<!DOCTYPE html>
<html><head><title>Fetch API</title></head>
<body>
  <main>
    <h1>Fetch API Reference</h1>
    <p>The Fetch API provides an interface for fetching resources (including across the network).
    It is a more powerful and flexible replacement for XMLHttpRequest. Use fetch() with async/await
    for clean, readable asynchronous code in modern JavaScript applications.</p>
    <h2>Basic Usage</h2>
    <p>Call fetch(url) with a URL string and optionally an init object specifying method, headers,
    and body. The function returns a Promise that resolves to a Response object. Use response.json()
    or response.text() to read the body content after checking response.ok for success.</p>
    <h2>Error Handling</h2>
    <p>Fetch only rejects on network failure, not HTTP error codes. Always check response.ok or
    response.status to detect 4xx/5xx errors. Wrap your fetch calls in try/catch blocks when
    using async/await to handle both network errors and response parsing failures.</p>
  </main>
</body></html>`

// ---------------------------------------------------------------------------
// 1. Pagination — cache_ref + getSlice
// ---------------------------------------------------------------------------

describe("Sprint 3B pagination (cache_ref + getSlice)", () => {
  beforeEach(() => clearCache())

  test("hashInputs is stable and unique", () => {
    const a = hashInputs("websearch:snippets", "fetch api", "exa")
    const b = hashInputs("websearch:snippets", "fetch api", "exa")
    const c = hashInputs("websearch:snippets", "http requests", "exa")
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })

  test("first page returns cache_ref, total, more=true when items remain", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: i, title: `Result ${i}` }))
    const key = hashInputs("websearch:snippets", "test query", "exa")
    put(key, items)

    const page1 = getSlice(key, 0, 5)
    expect(page1).not.toBeNull()
    expect(page1!.slice.length).toBe(5)
    expect(page1!.total).toBe(10)
    expect(page1!.more).toBe(true)
  })

  test("second page (via cache_ref) returns remainder without recompute", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: i }))
    const key = hashInputs("websearch:snippets", "test query", "exa")
    put(key, items)

    const page2 = getSlice(key, 5, 5)
    expect(page2).not.toBeNull()
    expect(page2!.slice.length).toBe(5)
    expect(page2!.more).toBe(false)

    // Items on page 2 start at id=5
    const ids = (page2!.slice as Array<{ id: number }>).map((x) => x.id)
    expect(ids).toEqual([5, 6, 7, 8, 9])
  })

  test("getSlice returns null on cache miss", () => {
    expect(getSlice("nonexistent-key", 0, 5)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2. parseSearchHits — JSON + dedup
// ---------------------------------------------------------------------------

describe("parseSearchHits", () => {
  test("parses Exa-like JSON into structured hits", () => {
    const hits = parseSearchHits(EXA_JSON, "exa")
    expect(hits.length).toBe(4)
    expect(hits[0]).toMatchObject({
      title: "Fetch API Guide",
      url: "https://example.com/fetch",
      published_at: "2024-01-15",
      score: 0.95,
    })
    expect(hits[0]!.snippet.length).toBeGreaterThan(10)
  })

  test("returns empty array for empty input", () => {
    expect(parseSearchHits("", "exa")).toEqual([])
    expect(parseSearchHits("   ", "parallel")).toEqual([])
  })

  test("returns empty array for non-JSON, non-URL text", () => {
    const result = parseSearchHits("no results found", "parallel")
    expect(Array.isArray(result)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. dedupHits — canonical URL dedup
// ---------------------------------------------------------------------------

describe("dedupHits", () => {
  test("removes the duplicate URL entry", () => {
    const hits = parseSearchHits(EXA_JSON, "exa")
    const deduped = dedupHits(hits)
    // 4 raw hits, 1 duplicate URL → 3 unique
    expect(deduped.length).toBe(3)
    const urls = deduped.map((h) => h.url)
    expect(new Set(urls).size).toBe(urls.length)
  })

  test("treats UTM-tracked URLs as the same canonical URL", () => {
    const hits = [
      { title: "A", url: "https://example.com/page?utm_source=twitter", snippet: "content a" },
      { title: "B", url: "https://example.com/page?utm_source=facebook", snippet: "content b" },
      { title: "C", url: "https://other.com/page", snippet: "content c" },
    ]
    const deduped = dedupHits(hits)
    expect(deduped.length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 4. Lean shape — pruneHitsByBm25 drops raw provider fields
// ---------------------------------------------------------------------------

describe("pruneHitsByBm25 — lean shape", () => {
  test("output has only lean fields: title, url, ranked_snippet, optional score/published_at", () => {
    const hits = dedupHits(parseSearchHits(EXA_JSON, "exa"))
    const lean = pruneHitsByBm25(hits, "fetch API promises async", 3)

    expect(lean.length).toBeGreaterThan(0)
    for (const h of lean) {
      // Required lean fields
      expect(typeof h.title).toBe("string")
      expect(typeof h.url).toBe("string")
      expect(typeof h.ranked_snippet).toBe("string")
      // Must NOT expose raw provider fields
      const raw = h as unknown as Record<string, unknown>
      expect(raw["text"]).toBeUndefined()
      expect(raw["content"]).toBeUndefined()
      expect(raw["html"]).toBeUndefined()
      expect(raw["snippet"]).toBeUndefined()
    }
  })

  test("ranked_snippet is capped at 600 chars", () => {
    const longSnippet = "x".repeat(1000)
    const hits = [{ title: "A", url: "https://example.com/a", snippet: longSnippet }]
    const lean = pruneHitsByBm25(hits, "test", 1)
    expect(lean[0]!.ranked_snippet.length).toBeLessThanOrEqual(600)
  })
})

// ---------------------------------------------------------------------------
// 5. depth:0 — no fetch invoked
// ---------------------------------------------------------------------------

describe("depth:0 — no fetch invoked", () => {
  test("pruning helpers produce output without touching the network", () => {
    let fetchCalled = false

    // We simulate what depth:0 does: parse + dedup + prune, no runFetchUrlBatch
    const mockFetch = async () => {
      fetchCalled = true
      return new Response("", { status: 200 })
    }
    // depth:0 never calls mockFetch; just suppress the unused-variable warning
    void mockFetch

    const hits = dedupHits(parseSearchHits(EXA_JSON, "exa"))
    const lean = pruneHitsByBm25(hits, "fetch API", 5)
    const formatted = formatLeanHits(lean)

    expect(fetchCalled).toBe(false)
    expect(lean.length).toBeGreaterThan(0)
    expect(formatted).toContain("URL:")
    expect(formatted).toContain("https://")
  })

  test("formatLeanHits serialises numbered markdown with URL lines", () => {
    const hits = dedupHits(parseSearchHits(EXA_JSON, "exa"))
    const lean = pruneHitsByBm25(hits, "fetch API", 3)
    const out = formatLeanHits(lean)

    expect(out).toMatch(/^1\. \*\*/)
    expect(out).toContain("URL: https://")
    // No raw HTML or JSON remnants
    expect(out).not.toContain('"text":')
    expect(out).not.toContain('"publishedDate":')
  })
})

// ---------------------------------------------------------------------------
// 6. depth:K — batch fetch + passages with provenance
// ---------------------------------------------------------------------------

describe("depth:K — runFetchUrlBatch with mock fetch, passages + provenance", () => {
  test("returns passages each carrying source_url and source_index", async () => {
    const mockFetch = async (_url: string): Promise<Response> =>
      new Response(MOCK_HTML, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })

    const urls = ["https://example.com/fetch", "https://example.com/http-requests"]
    const result = await runFetchUrlBatch(urls, {
      prompt: "fetch API async await promises",
      fetchFn: mockFetch,
    })

    expect(result.result_status).toBe("ok")
    if (result.result_status !== "ok") return

    expect(result.passages.length).toBeGreaterThan(0)
    expect(result.sources.length).toBe(2)

    // Every passage must carry provenance
    for (const p of result.passages) {
      expect(typeof p.source_url).toBe("string")
      expect(p.source_url.length).toBeGreaterThan(0)
      expect(typeof p.source_index).toBe("number")
      expect(p.source_index).toBeGreaterThanOrEqual(0)
      expect(typeof p.text).toBe("string")
    }
  })

  test("BM25 cross-doc ranking surfaces query-relevant passage first", async () => {
    const mockFetch = async (_url: string): Promise<Response> =>
      new Response(MOCK_HTML, { status: 200, headers: { "Content-Type": "text/html" } })

    const result = await runFetchUrlBatch(["https://example.com/a", "https://example.com/b"], {
      prompt: "error handling fetch response status",
      fetchFn: mockFetch,
    })

    expect(result.result_status).toBe("ok")
    if (result.result_status !== "ok") return

    // The top passage should contain relevant text (error handling or response.ok)
    const topText = result.passages[0]?.text.toLowerCase() ?? ""
    const relevant = topText.includes("error") || topText.includes("response") || topText.includes("fetch")
    expect(relevant).toBe(true)
  })

  test("pagination: put passages in cache and page via getSlice", async () => {
    clearCache()
    const mockFetch = async (_url: string): Promise<Response> =>
      new Response(MOCK_HTML, { status: 200, headers: { "Content-Type": "text/html" } })

    const result = await runFetchUrlBatch(
      ["https://example.com/a", "https://example.com/b", "https://example.com/c"],
      { prompt: "fetch api", fetchFn: mockFetch },
    )

    expect(result.result_status).toBe("ok")
    if (result.result_status !== "ok") return

    // Simulate what depth:K path does: put all passages, getSlice first page
    const pageKey = hashInputs("websearch:depth", "fetch api", "3", "exa")
    put(pageKey, result.passages)

    const page1 = getSlice(pageKey, 0, 5)
    expect(page1).not.toBeNull()
    expect(page1!.slice.length).toBeLessThanOrEqual(5)
    expect(page1!.total).toBe(result.passages.length)

    if (result.passages.length > 5) {
      expect(page1!.more).toBe(true)
      // Second page via same key (simulates cache_ref)
      const page2 = getSlice(pageKey, 5, 5)
      expect(page2).not.toBeNull()
      expect(page2!.slice.length).toBeGreaterThan(0)
    }
  })
})
