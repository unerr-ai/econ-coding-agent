/**
 * S2.3 webfetch-compress pipeline test.
 *
 * Verifies three things:
 *  1. htmlToMarkdown + splitMarkdownIntoPassages + rankPassagesByPrompt
 *     reduces a large HTML document to a fraction of the original size.
 *  2. The hash cache returns the same result on a second call without
 *     re-running the extraction pipeline.
 *  3. BM25 ranking with a targeted prompt surfaces a passage whose heading
 *     matches the query better than a random passage would.
 */

import { describe, it, expect, beforeEach } from "bun:test"
import { htmlToMarkdown } from "../src/webfetch/extract.js"
import { splitMarkdownIntoPassages } from "../src/webfetch/passage-split.js"
import { rankPassagesByPrompt } from "../src/webfetch/bm25.js"
import { contentHash, buildCacheKey, getCached, setCached, clearCache, cacheSize } from "../src/webfetch/cache.js"

// ---------------------------------------------------------------------------
// Fixture: large HTML page (~18 KB) with multiple sections
// ---------------------------------------------------------------------------

function makeHtmlDoc(): string {
  const sections = [
    { heading: "Introduction", body: "This guide explains how to configure the authentication system. It covers OAuth2, API keys, and session tokens. Authentication is the process of verifying user identity before granting access to protected resources. A robust authentication strategy combines multiple factors and fallback mechanisms." },
    { heading: "Installation", body: "Run `npm install @example/auth` to add the package. Then import AuthClient from the library and call AuthClient.init() with your credentials. The init function accepts a configuration object with clientId, clientSecret, and optional scopes. Make sure to store credentials securely and never commit them to version control." },
    { heading: "Configuration", body: "Configuration can be provided via environment variables or a JSON config file. The following keys are required: AUTH_CLIENT_ID, AUTH_CLIENT_SECRET, and AUTH_REDIRECT_URI. Optional keys include AUTH_SCOPE, AUTH_TIMEOUT, and AUTH_MAX_RETRIES. Environment variables take precedence over the config file at runtime." },
    { heading: "BM25 Ranking Algorithm", body: "BM25 is a probabilistic ranking function used in full-text search engines. It extends TF-IDF by normalising for document length. The BM25 score is computed per term as IDF multiplied by a TF normalisation factor. Parameters k1 (typically 1.5) and b (typically 0.75) control term-frequency saturation and length normalisation respectively." },
    { heading: "OAuth2 Flow", body: "The OAuth2 authorisation code flow consists of three steps: redirect the user to the authorisation server, receive the authorisation code at your callback URL, and exchange the code for access and refresh tokens. Tokens should be stored securely server-side and refreshed before expiry. Never expose refresh tokens in client-side code." },
    { heading: "Session Management", body: "Sessions are stored in a Redis-backed store by default. Each session expires after the TTL configured in AUTH_SESSION_TTL (default 3600 seconds). Use AuthClient.logout() to invalidate a session explicitly. For distributed deployments, ensure all nodes share the same Redis instance to avoid session inconsistencies." },
    { heading: "Error Handling", body: "The library throws AuthError for all authentication failures. Use try/catch around AuthClient.login() and AuthClient.refresh(). Common error codes include AUTH_INVALID_CREDENTIALS, AUTH_TOKEN_EXPIRED, and AUTH_NETWORK_ERROR. Implement exponential back-off for retry logic to avoid overwhelming the auth server under failure conditions." },
    { heading: "Logging", body: "Enable debug logging by setting AUTH_LOG_LEVEL=debug. Logs are emitted via the standard console interface and can be redirected to any logging framework. Sensitive fields such as tokens and passwords are automatically redacted before logging. Log output includes request IDs so you can correlate entries across distributed traces." },
    { heading: "Testing", body: "Use AuthClient.mock() in test environments to bypass real authentication. Pass mock tokens directly to avoid network calls in unit tests. Integration tests should use a dedicated test tenant to avoid polluting production credentials. Reset mock state between tests with AuthClient.resetMock() to prevent state leakage." },
    { heading: "Changelog", body: "Version 3.2.0 adds PKCE support for public clients. Version 3.1.0 introduces the refresh token rotation policy. Version 3.0.0 is a breaking change: the init() signature changed from positional arguments to a config object. See the migration guide at docs/migrate-v3.md for step-by-step instructions." },
  ]

  // Pad each section body to ensure the total HTML is large (~18KB)
  const paddedSections = sections.map((s) => {
    const padded = s.body + " ".repeat(50) + Array(8).fill(s.body.slice(0, 80)).join(" ")
    return { heading: s.heading, body: padded }
  })

  const content = paddedSections
    .map(
      (s) => `
    <section>
      <h2>${s.heading}</h2>
      <p>${s.body}</p>
      <p>${s.body.split(" ").reverse().join(" ")}</p>
    </section>`,
    )
    .join("\n")

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Authentication Library Docs</title>
  <style>body { font-family: sans-serif; } nav { display: flex; }</style>
  <script>window.__INIT__ = true; console.log("loaded");</script>
</head>
<body>
  <header><nav><a href="/">Home</a><a href="/docs">Docs</a><a href="/api">API</a></nav></header>
  <main>
    <h1>Authentication Library — Full Guide</h1>
    ${content}
  </main>
  <footer>
    <p>Copyright 2024 Example Inc. All rights reserved.</p>
    <nav>${Array(20).fill('<a href="/link">Link</a>').join(" ")}</nav>
  </footer>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("S2.3 webfetch-compress pipeline", () => {
  beforeEach(() => clearCache())

  // ── 1. Size reduction ────────────────────────────────────────────────────

  it("reduces a large HTML doc to < 40% of its original size after extract+split+rank", async () => {
    const html = makeHtmlDoc()
    expect(html.length).toBeGreaterThan(10_000) // fixture is large

    const { markdown, originalLength } = await htmlToMarkdown(html)
    const passages = splitMarkdownIntoPassages(markdown)
    const ranked = rankPassagesByPrompt(passages, { prompt: "BM25 ranking algorithm", topK: 3 })

    const output = ranked.map((p) => p.text).join("\n\n---\n\n")

    const ratio = output.length / originalLength
    expect(ratio).toBeLessThan(0.40) // at least 60% reduction
    expect(output.length).toBeGreaterThan(0)

    // Markdown output must omit the <script> and <style> blocks
    expect(output).not.toContain("<script>")
    expect(output).not.toContain("<style>")
  })

  // ── 2. BM25 relevance ───────────────────────────────────────────────────

  it("BM25-ranked top passage heading relates to the query", async () => {
    const html = makeHtmlDoc()
    const { markdown } = await htmlToMarkdown(html)
    const passages = splitMarkdownIntoPassages(markdown)

    const ranked = rankPassagesByPrompt(passages, {
      prompt: "how does BM25 ranking algorithm work with TF-IDF",
      topK: 1,
    })

    expect(ranked.length).toBeGreaterThan(0)
    const topText = ranked[0]!.text.toLowerCase()
    // The BM25-section passage should surface first
    expect(topText).toMatch(/bm25|ranking|probabilistic|tfidf|tf.idf/)
  })

  // ── 3. Hash cache — second call is a cache hit ───────────────────────────

  it("cache returns same result without recompute on second call", async () => {
    const html = makeHtmlDoc()
    const htmlHash = contentHash(html)
    const prompt = "oauth2 token flow"
    const topK = 5

    // First pass: compute and store
    const { markdown, originalLength } = await htmlToMarkdown(html)
    const passages = splitMarkdownIntoPassages(markdown)
    const ranked = rankPassagesByPrompt(passages, { prompt, topK })
    const output = ranked.map((p) => p.text).join("\n\n---\n\n")
    const compressionRatio = output.length / Math.max(1, originalLength)

    const key = buildCacheKey("https://example.com/docs", htmlHash, prompt, topK)
    setCached(key, { passages: output, compressionRatio, passageCount: ranked.length })

    expect(cacheSize()).toBe(1)

    // Second pass: cache hit
    const hit = getCached(key)
    expect(hit).toBeDefined()
    expect(hit!.passages).toBe(output)
    expect(hit!.compressionRatio).toBe(compressionRatio)
    expect(hit!.passageCount).toBe(ranked.length)
  })

  // ── 4. Cache miss on different content hash ──────────────────────────────

  it("cache misses when content hash differs (page changed)", () => {
    const key1 = buildCacheKey("https://example.com", "aabbccdd", "query", 10)
    const key2 = buildCacheKey("https://example.com", "11223344", "query", 10)

    setCached(key1, { passages: "old content", compressionRatio: 0.1, passageCount: 3 })

    expect(getCached(key1)).toBeDefined()
    expect(getCached(key2)).toBeUndefined()
  })

  // ── 5. contentHash is stable ─────────────────────────────────────────────

  it("contentHash produces the same digest for the same input", () => {
    const html = makeHtmlDoc()
    expect(contentHash(html)).toBe(contentHash(html))
    expect(contentHash(html)).toHaveLength(16)
  })

  // ── 6. passage-split respects code fences ────────────────────────────────

  it("splitMarkdownIntoPassages keeps code fences whole", () => {
    const md = `## Setup\n\nInstall first.\n\n\`\`\`bash\nnpm install foo\necho done\n\`\`\`\n\nThen configure.\n`
    const passages = splitMarkdownIntoPassages(md)
    const fencePassage = passages.find((p) => p.text.includes("```"))
    expect(fencePassage).toBeDefined()
    // fence must not be split across passages
    const lines = fencePassage!.text.split("\n").filter((l) => l.startsWith("```"))
    expect(lines.length).toBe(2) // opening + closing fence
  })
})
