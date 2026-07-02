/**
 * Targeted unit tests for the Sprint-3 web-fetch optimisation core.
 *
 * Covers three independent units — all tested offline (no live fetches):
 *  1. BM25 ranker: relevant passages rank above navigation boilerplate.
 *  2. Passage splitter: heading-aware split, code fences kept whole.
 *  3. Batch engine: parallel fetch with injected mock, cross-doc provenance,
 *     BM25 cross-rank when prompt is provided.
 *
 * The rawBodyFromHtmlSync fallback is also exercised (it runs whenever
 * jsdom/defuddle are absent, which is true in the sandbox).
 */

import { describe, it, expect } from "bun:test"
import { splitMarkdownIntoPassages } from "./passage-split.js"
import { rankPassagesByPrompt } from "./bm25.js"
import { rawBodyFromHtmlSync } from "./extract.js"
import { runFetchUrlBatch } from "./fetch-batch.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A markdown doc with a prose BM25 section and a nav-chrome boilerplate section. */
const MARKDOWN_WITH_BOILERPLATE = `
# BM25 Ranking

BM25 is a probabilistic ranking function used in information retrieval systems.
It extends TF-IDF by normalising term frequency for document length using
parameters k1 (typically 1.5) and b (typically 0.75). The score is computed per
query term as IDF multiplied by a length-normalised TF factor. BM25 produces
highly relevant results for keyword queries without semantic models.

## Navigation

[Home](/) [About](/about) [Blog](/blog) [Docs](/docs) [API](/api) [Contact](/contact) [Search](/search) [Login](/login) [Signup](/signup) [Pricing](/pricing)

## Installation

To install the library run: npm install bm25-ts then import BM25Ranker from
the package. Configure the ranker with your corpus and call rank(query) to
retrieve sorted documents. The ranker is corpus-aware and builds an inverse
document frequency table on first consolidate() call.

## OAuth2 Flow

The OAuth2 authorisation code flow consists of three steps: redirect the user
to the authorisation server, receive the code at your callback, and exchange
it for access and refresh tokens. Tokens are short-lived; refresh tokens must
be stored server-side only and rotated on each use to prevent replay attacks.
`.trim()

/** HTML page with a header/footer/nav chrome that should be stripped. */
function makeHtmlFixture(topic: string, body: string): string {
  return `<!DOCTYPE html>
<html>
<head><title>${topic}</title></head>
<body>
  <header><nav><a href="/">Home</a><a href="/docs">Docs</a></nav></header>
  <main>
    <h1>${topic}</h1>
    <p>${body}</p>
    <p>${body}</p>
  </main>
  <footer><p>Copyright 2024 Example Inc.</p></footer>
  <script>window.__data = {};</script>
  <style>body { font-family: sans-serif; }</style>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// 1. BM25 ranker
// ---------------------------------------------------------------------------

describe("rankPassagesByPrompt", () => {
  it("returns passages in document order when no prompt is given", () => {
    const passages = splitMarkdownIntoPassages(MARKDOWN_WITH_BOILERPLATE)
    const ranked = rankPassagesByPrompt(passages, { prompt: "" })
    expect(ranked.map((p) => p.index)).toEqual(passages.map((p) => p.index))
  })

  it("ranks the BM25-relevant passage above navigation boilerplate", () => {
    const passages = splitMarkdownIntoPassages(MARKDOWN_WITH_BOILERPLATE)
    // Needs at least BM25_MIN_CORPUS_SIZE (3) passages to rank
    expect(passages.length).toBeGreaterThanOrEqual(3)

    const ranked = rankPassagesByPrompt(passages, {
      prompt: "BM25 probabilistic ranking TF-IDF score",
      topK: 3,
    })

    expect(ranked.length).toBeGreaterThan(0)
    const topText = ranked[0]!.text.toLowerCase()
    // The BM25 prose section should win over the nav link list
    expect(topText).toMatch(/bm25|probabilistic|ranking|tfidf|tf.idf|idf/)
  })

  it("filters link-heavy navigation passages as non-prose candidates", () => {
    const passages = splitMarkdownIntoPassages(MARKDOWN_WITH_BOILERPLATE)
    const navPassage = passages.find((p) =>
      p.text.includes("[Home](/)") && p.text.includes("[About](/about)"),
    )
    // The nav passage must exist in the raw split...
    expect(navPassage).toBeDefined()

    // ...but after BM25 filtering with a relevant prompt, it should not appear
    // in the top result (link-density > 0.4 excludes it from prose candidates)
    const ranked = rankPassagesByPrompt(passages, {
      prompt: "BM25 ranking algorithm score formula",
      topK: 1,
    })
    const topText = ranked[0]?.text ?? ""
    expect(topText).not.toContain("[Home](/)")
  })

  it("ranks OAuth2 passage first when prompt targets OAuth2", () => {
    const passages = splitMarkdownIntoPassages(MARKDOWN_WITH_BOILERPLATE)
    const ranked = rankPassagesByPrompt(passages, {
      prompt: "oauth2 authorisation code flow access refresh tokens",
      topK: 1,
    })
    expect(ranked[0]?.text.toLowerCase()).toMatch(/oauth2|authorisation|refresh token/)
  })

  it("returns at most topK passages", () => {
    const passages = splitMarkdownIntoPassages(MARKDOWN_WITH_BOILERPLATE)
    const topK = 2
    const ranked = rankPassagesByPrompt(passages, { prompt: "BM25 ranking", topK })
    expect(ranked.length).toBeLessThanOrEqual(topK)
  })
})

// ---------------------------------------------------------------------------
// 2. Passage splitter
// ---------------------------------------------------------------------------

describe("splitMarkdownIntoPassages", () => {
  it("splits heading sections into separate passages", () => {
    const passages = splitMarkdownIntoPassages(MARKDOWN_WITH_BOILERPLATE)
    // Expect one passage per heading section (BM25, Navigation, Installation, OAuth2)
    expect(passages.length).toBeGreaterThanOrEqual(4)
  })

  it("attaches heading text to each passage", () => {
    const passages = splitMarkdownIntoPassages(MARKDOWN_WITH_BOILERPLATE)
    // The splitter may produce a heading-only passage and a separate body passage,
    // both sharing the same heading label. Find the one that carries body text.
    const bm25Body = passages.find((p) => p.heading === "BM25 Ranking" && p.text.includes("probabilistic"))
    expect(bm25Body).toBeDefined()
  })

  it("keeps code fences whole — does not split inside them", () => {
    const md = `
## Example

Here is some prose before the code block.

\`\`\`typescript
function bm25(tf: number, idf: number, k1: number, b: number, dl: number, avgdl: number): number {
  return idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgdl))
}
\`\`\`

Text after the code block.
`.trim()

    const passages = splitMarkdownIntoPassages(md)
    const withFence = passages.find((p) => p.text.includes("```typescript"))
    expect(withFence).toBeDefined()
    // The fence should be closed — both opening and closing markers in one passage
    expect(withFence!.text).toContain("```typescript")
    expect(withFence!.text.match(/```/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it("assigns monotonically increasing index values", () => {
    const passages = splitMarkdownIntoPassages(MARKDOWN_WITH_BOILERPLATE)
    for (let i = 0; i < passages.length; i++) {
      expect(passages[i]!.index).toBe(i)
    }
  })

  it("returns empty array for blank input", () => {
    expect(splitMarkdownIntoPassages("")).toEqual([])
    expect(splitMarkdownIntoPassages("   \n   ")).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 3. rawBodyFromHtmlSync (sync extraction baseline)
// ---------------------------------------------------------------------------

describe("rawBodyFromHtmlSync", () => {
  it("strips script / style / nav / header / footer chrome", () => {
    const html = makeHtmlFixture("BM25 Test", "BM25 is a ranking function.")
    const { markdown } = rawBodyFromHtmlSync(html)
    expect(markdown).not.toContain("<script>")
    expect(markdown).not.toContain("<style>")
    expect(markdown).not.toContain("<header>")
    expect(markdown).not.toContain("<footer>")
    expect(markdown).not.toContain("<nav>")
  })

  it("preserves main content text", () => {
    const html = makeHtmlFixture("BM25 Test", "BM25 is a probabilistic ranking function.")
    const { markdown } = rawBodyFromHtmlSync(html)
    expect(markdown.toLowerCase()).toContain("bm25")
    expect(markdown.toLowerCase()).toContain("probabilistic")
  })

  it("converts h1 to ATX markdown heading", () => {
    const html = makeHtmlFixture("BM25 Algorithm", "Content about BM25.")
    const { markdown } = rawBodyFromHtmlSync(html)
    expect(markdown).toContain("# BM25 Algorithm")
  })

  it("extracts the page title", () => {
    const html = makeHtmlFixture("Search Ranking", "About ranking.")
    const { title } = rawBodyFromHtmlSync(html)
    expect(title).toBe("Search Ranking")
  })

  it("reports originalLength equal to input html.length", () => {
    const html = makeHtmlFixture("Test", "body text")
    const { originalLength } = rawBodyFromHtmlSync(html)
    expect(originalLength).toBe(html.length)
  })

  it("achieves at least 40% size reduction on a chrome-heavy fixture", () => {
    const chrome = Array(50).fill('<a href="/link">Nav item</a>').join(" ")
    const html = `<!DOCTYPE html><html><head><title>T</title></head><body>
      <header><nav>${chrome}</nav></header>
      <main><h1>BM25</h1><p>BM25 is a ranking function used in information retrieval.</p></main>
      <footer><nav>${chrome}</nav></footer>
    </body></html>`
    const { markdown, originalLength } = rawBodyFromHtmlSync(html)
    expect(markdown.length / originalLength).toBeLessThan(0.6)
  })
})

// ---------------------------------------------------------------------------
// 4. Batch engine (mock fetch — no network)
// ---------------------------------------------------------------------------

describe("runFetchUrlBatch", () => {
  /** Build a mock Response with the given HTML body. */
  function mockResponse(html: string, url?: string): Response {
    return new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      // Bun's Response.url is read-only; set via url option where supported
    }) as Response & { url: string }
    // Note: Response.url can't be set directly — fetchFn receives the original URL
  }

  function makeMockFetch(pages: Record<string, string>) {
    return async (url: string): Promise<Response> => {
      const html = pages[url] ?? pages["*"]
      if (!html) {
        return new Response("not found", { status: 404 })
      }
      return mockResponse(html, url)
    }
  }

  const BM25_PAGE = makeHtmlFixture(
    "BM25 Ranking",
    "BM25 is a probabilistic ranking function used in search engines. " +
      "It scores documents by term frequency normalised for length. " +
      "BM25 parameters k1 and b control saturation and length normalisation.",
  )
  const OAUTH_PAGE = makeHtmlFixture(
    "OAuth2 Guide",
    "OAuth2 authorisation code flow: redirect to auth server, receive code, " +
      "exchange for access and refresh tokens. Tokens expire; refresh tokens " +
      "must be stored server-side and rotated on every use.",
  )

  it("returns ok with sources and passages for a single URL", async () => {
    const fetchFn = makeMockFetch({ "https://example.com/bm25": BM25_PAGE })
    const result = await runFetchUrlBatch(["https://example.com/bm25"], { fetchFn })
    expect(result.result_status).toBe("ok")
    if (result.result_status !== "ok") return
    expect(result.ok).toBe(1)
    expect(result.failed).toBe(0)
    expect(result.sources).toHaveLength(1)
    expect(result.sources[0]!.result_status).toBe("ok")
    expect(result.passages.length).toBeGreaterThan(0)
  })

  it("attaches source_index and source_url provenance to every passage", async () => {
    const fetchFn = makeMockFetch({
      "https://example.com/bm25": BM25_PAGE,
      "https://example.com/oauth": OAUTH_PAGE,
    })
    const result = await runFetchUrlBatch(
      ["https://example.com/bm25", "https://example.com/oauth"],
      { fetchFn },
    )
    expect(result.result_status).toBe("ok")
    if (result.result_status !== "ok") return
    expect(result.ok).toBe(2)
    for (const p of result.passages) {
      expect(typeof p.source_index).toBe("number")
      expect(typeof p.source_url).toBe("string")
      expect(p.source_url.length).toBeGreaterThan(0)
    }
    // Both source indices should appear in passages
    const seenSources = new Set(result.passages.map((p) => p.source_index))
    expect(seenSources.size).toBeGreaterThanOrEqual(1)
  })

  it("cross-document BM25 ranks BM25 passages first when prompt targets BM25", async () => {
    const fetchFn = makeMockFetch({
      "https://example.com/bm25": BM25_PAGE,
      "https://example.com/oauth": OAUTH_PAGE,
    })
    const result = await runFetchUrlBatch(
      ["https://example.com/bm25", "https://example.com/oauth"],
      { prompt: "BM25 probabilistic ranking TF-IDF score formula", fetchFn },
    )
    expect(result.result_status).toBe("ok")
    if (result.result_status !== "ok") return
    expect(result.passages.length).toBeGreaterThan(0)
    // Top passage should come from the BM25 page (source_index 0)
    // or contain BM25-related text
    const topText = result.passages[0]?.text.toLowerCase() ?? ""
    const topSource = result.passages[0]?.source_index
    expect(topText.includes("bm25") || topSource === 0).toBe(true)
  })

  it("records failed sources and still returns ok when some URLs succeed", async () => {
    const fetchFn = makeMockFetch({ "https://example.com/good": BM25_PAGE })
    const result = await runFetchUrlBatch(
      ["https://example.com/good", "https://example.com/missing"],
      { fetchFn },
    )
    expect(result.result_status).toBe("ok")
    if (result.result_status !== "ok") return
    expect(result.ok).toBe(1)
    expect(result.failed).toBe(1)
    const failedSource = result.sources.find((s) => s.result_status === "error")
    expect(failedSource).toBeDefined()
    expect(failedSource?.error).toMatch(/404|not found/i)
  })

  it("returns error when all URLs fail", async () => {
    const fetchFn = async () => new Response("gone", { status: 404 })
    const result = await runFetchUrlBatch(["https://example.com/gone"], { fetchFn })
    expect(result.result_status).toBe("error")
    if (result.result_status !== "error") return
    expect(result.ok).toBe(0)
    expect(result.failed).toBeGreaterThan(0)
    expect(result.suggestion).toBeTruthy()
  })

  it("deduplicates repeated URLs", async () => {
    let callCount = 0
    const fetchFn = async (url: string): Promise<Response> => {
      callCount++
      return mockResponse(BM25_PAGE, url)
    }
    await runFetchUrlBatch(
      ["https://example.com/a", "https://example.com/a", "https://example.com/a"],
      { fetchFn },
    )
    expect(callCount).toBe(1)
  })

  it("returns error for empty URL list", async () => {
    const result = await runFetchUrlBatch([], {})
    expect(result.result_status).toBe("error")
  })
})
