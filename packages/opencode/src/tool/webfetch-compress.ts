/**
 * BM25-compressed web-fetch tool for the econ agent toolset.
 *
 * Fetches a URL, extracts the DOM text to markdown via a pure regex pipeline,
 * splits the result into passages, and returns the top-ranked passages scored
 * against the caller's prompt — reducing raw page size by ~70–90% for typical
 * documentation pages. Results are hash-cached (URL + content hash + prompt +
 * topK) so repeated calls on an unchanged page are free.
 *
 * Z2.3: econ S2.3 addition. Remove this comment when graduated.
 *
 * @sem domain=intelligence role=tools
 */

import * as Tool from "./tool"
import { Effect, Schema } from "effect"
import { htmlToMarkdown } from "../../../code-intelligence/src/webfetch/extract"
import { splitMarkdownIntoPassages } from "../../../code-intelligence/src/webfetch/passage-split"
import { rankPassagesByPrompt } from "../../../code-intelligence/src/webfetch/bm25"
import { contentHash, buildCacheKey, getCached, setCached } from "../../../code-intelligence/src/webfetch/cache"

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const Parameters = Schema.Struct({
  url: Schema.String.annotate({
    description: "The URL to fetch content from (must start with http:// or https://).",
  }),
  prompt: Schema.optional(Schema.String).annotate({
    description:
      "Query / task description used to BM25-rank the extracted passages by relevance. " +
      "Omit to return the top passages in document order.",
  }),
  top_k: Schema.optional(Schema.Number).annotate({
    description: "Maximum number of passages to return (default 10).",
  }),
})

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

/**
 * `webfetch_compress` tool: fetch a URL and return BM25-ranked markdown
 * passages instead of the raw page, achieving a 70–90% size reduction.
 *
 * @sem domain=intelligence role=tools
 */
export const WebFetchCompressTool = Tool.define(
  "webfetch_compress",
  Effect.succeed({
    description:
      "Fetch a URL and return BM25-ranked markdown passages relevant to `prompt`. " +
      "Returns much less text than the raw page (typically 10–30% of original size). " +
      "Provide `prompt` to rank passages by relevance; omit for top passages in document order. " +
      "Results are hash-cached so repeated calls on the same page content are free.",
    parameters: Parameters,
    execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
      Effect.promise(async () => {
        const { url, prompt = "", top_k } = params
        const topK = Math.max(1, top_k ?? 10)

        if (!url.startsWith("http://") && !url.startsWith("https://")) {
          throw new Error("URL must start with http:// or https://")
        }

        // ── Fetch ────────────────────────────────────────────────────────────
        const response = await fetch(url, {
          headers: {
            "User-Agent": "econ-agent/1.0",
            Accept: "text/html,*/*;q=0.8",
          },
          signal: AbortSignal.timeout(30_000),
        })

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} fetching ${url}`)
        }

        const html = await response.text()
        const htmlHash = contentHash(html)

        // ── Cache lookup ─────────────────────────────────────────────────────
        const key = buildCacheKey(url, htmlHash, prompt, topK)
        const cached = getCached(key)
        if (cached) {
          return {
            title: url,
            metadata: {
              cached: true,
              compressionRatio: cached.compressionRatio,
              passageCount: cached.passageCount,
            } as Record<string, unknown>,
            output: cached.passages,
          }
        }

        // ── Extract → split → rank ───────────────────────────────────────────
        const { title, markdown, originalLength } = htmlToMarkdown(html)
        const allPassages = splitMarkdownIntoPassages(markdown)
        const ranked = prompt
          ? rankPassagesByPrompt(allPassages, { prompt, topK })
          : allPassages.slice(0, topK)

        // ── Format output ────────────────────────────────────────────────────
        const header = title ? `# ${title}\n\n` : ""
        const body = ranked.map((p) => p.text).join("\n\n---\n\n")
        const output = header + body

        const compressionRatio = output.length / Math.max(1, originalLength)

        // ── Cache store ──────────────────────────────────────────────────────
        setCached(key, { passages: output, compressionRatio, passageCount: ranked.length })

        return {
          title: url,
          metadata: {
            cached: false,
            compressionRatio,
            passageCount: ranked.length,
          } as Record<string, unknown>,
          output,
        }
      }),
  }),
)
