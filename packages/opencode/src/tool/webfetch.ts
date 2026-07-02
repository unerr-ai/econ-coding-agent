/**
 * Token-lean web-fetch tool for the econ agent toolset.
 *
 * Fetches a URL (or list of URLs), extracts DOM text to markdown via a pure
 * regex pipeline, splits the result into passages, and returns the top-ranked
 * passages scored against the caller's prompt — reducing raw page size by
 * ~70–90% for typical documentation pages.
 *
 * Supports cache_ref pagination so large result sets can be paged at ~0
 * recompute cost. First paginated call returns meta.cache_ref + total + more;
 * follow-up calls with cache_ref skip the fetch entirely.
 *
 * @sem domain=intelligence role=tools
 */

import * as Tool from "./tool"
import { Effect, Schema } from "effect"
import { htmlToMarkdown } from "../../../code-intelligence/src/webfetch/extract"
import { splitMarkdownIntoPassages, type Passage } from "../../../code-intelligence/src/webfetch/passage-split"
import { rankPassagesByPrompt } from "../../../code-intelligence/src/webfetch/bm25"
import { contentHash, buildCacheKey, getCached, setCached } from "../../../code-intelligence/src/webfetch/cache"
import { hashInputs, put, getSlice, withMeta, recordToolCall } from "./_shared"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Passages per page in paginated mode. */
const DEFAULT_PAGE_SIZE = 10
/** Max passages ranked and stored in the pagination cache (when top_k not given). */
const MAX_RANKED = 50

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

export const Parameters = Schema.Struct({
  url: Schema.String.annotate({
    description: "The URL to fetch content from (must start with http:// or https://).",
  }),
  prompt: Schema.optional(Schema.String).annotate({
    description:
      "Query / task description used to BM25-rank the extracted passages by relevance. " +
      "Omit to return the top passages in document order.",
  }),
  top_k: Schema.optional(Schema.Number).annotate({
    description:
      "Maximum number of passages to rank and cache (default 50). " +
      "Returned as-is when `limit` is absent; first page is returned when `limit` is set.",
  }),
  cache_ref: Schema.optional(Schema.String).annotate({
    description:
      "Opaque reference returned by a prior call. When present, skip the fetch and return " +
      "the next page of previously-ranked passages at ~0 cost.",
  }),
  offset: Schema.optional(Schema.Number).annotate({
    description: "0-based passage offset within the cached result set (default 0). Only used with cache_ref.",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description:
      "Maximum passages to return in this response. When set, enables paginated mode: " +
      "response includes meta.cache_ref, meta.total, meta.more. Default is all passages.",
  }),
})

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

/**
 * `webfetch` tool: fetch a URL and return BM25-ranked markdown passages
 * instead of the raw page, achieving a 70–90% size reduction.
 * Supports cache_ref pagination — large result sets page at near-zero cost.
 *
 * @sem domain=intelligence role=tools
 */
export const WebFetchTool = Tool.define(
  "webfetch",
  Effect.succeed({
    description:
      "Fetch a URL and return BM25-ranked markdown passages relevant to `prompt`. " +
      "Returns much less text than the raw page (typically 10–30% of original size). " +
      "Provide `prompt` to rank passages by relevance; omit for top passages in document order. " +
      "Pass `limit` to enable pagination: the first response includes `meta.cache_ref`; " +
      "send `cache_ref` + `offset` in follow-up calls to page through remaining passages at ~0 cost.",
    parameters: Parameters,
    execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
      Effect.promise(async () => {
        const { url, prompt = "", top_k, cache_ref, offset = 0, limit } = params
        const pageSize = limit ?? DEFAULT_PAGE_SIZE

        // ── cache_ref path (pagination hit) ──────────────────────────────────
        if (cache_ref) {
          const sliceResult = getSlice(cache_ref, offset, pageSize)
          if (sliceResult) {
            const passages = sliceResult.slice as Passage[]
            const content = formatPassages(passages)
            const baseMeta = withMeta("", content)
            recordToolCall({ tool: "webfetch", ...baseMeta })
            return {
              title: url,
              metadata: {
                cached: true,
                paged: true,
                passageCount: passages.length,
              } as Record<string, unknown>,
              output: content,
              meta: {
                ...baseMeta,
                cache_ref,
                total: sliceResult.total,
                more: sliceResult.more,
              },
            }
          }
          // Cache miss (evicted) — fall through to fresh fetch
        }

        if (!url.startsWith("http://") && !url.startsWith("https://")) {
          throw new Error("URL must start with http:// or https://")
        }

        const topK = Math.max(1, top_k ?? MAX_RANKED)

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

        // ── Content-hash cache (non-paginated fast path) ─────────────────────
        const contentCacheKey = buildCacheKey(url, htmlHash, prompt, topK)
        const contentCached = getCached(contentCacheKey)
        if (contentCached && limit === undefined) {
          const baseMeta = withMeta(html, contentCached.passages)
          recordToolCall({ tool: "webfetch", ...baseMeta })
          return {
            title: url,
            metadata: {
              cached: true,
              compressionRatio: contentCached.compressionRatio,
              passageCount: contentCached.passageCount,
            } as Record<string, unknown>,
            output: contentCached.passages,
            meta: baseMeta,
          }
        }

        // ── Extract → split → rank ───────────────────────────────────────────
        const extracted = await htmlToMarkdown(html, url)
        const pageTitle = extracted.title || url
        const allPassages = splitMarkdownIntoPassages(extracted.markdown)

        const ranked: Passage[] = prompt
          ? rankPassagesByPrompt(allPassages, { prompt, topK })
          : allPassages.slice(0, topK)

        // ── Pagination cache (always populated so cache_ref works later) ──────
        const pageKey = hashInputs(url, prompt, String(topK))
        put(pageKey, ranked)

        // ── Assemble response ─────────────────────────────────────────────────
        let returnedPassages: Passage[]
        let paginationMeta: { cache_ref?: string; total?: number; more?: boolean } = {}

        if (limit !== undefined) {
          const sliceResult = getSlice(pageKey, offset, pageSize)!
          returnedPassages = sliceResult.slice as Passage[]
          paginationMeta = { cache_ref: pageKey, total: sliceResult.total, more: sliceResult.more }
        } else {
          returnedPassages = ranked
        }

        const output = formatPassages(returnedPassages, pageTitle)
        const compressionRatio = output.length / Math.max(1, extracted.originalLength)

        // ── Update content-hash cache ────────────────────────────────────────
        setCached(contentCacheKey, { passages: output, compressionRatio, passageCount: returnedPassages.length })

        const baseMeta = withMeta(html, output)
        recordToolCall({ tool: "webfetch", ...baseMeta })

        return {
          title: url,
          metadata: {
            cached: false,
            compressionRatio,
            passageCount: returnedPassages.length,
          } as Record<string, unknown>,
          output,
          meta: { ...baseMeta, ...paginationMeta },
        }
      }),
  }),
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatPassages(passages: Passage[], titleHeader?: string): string {
  const header = titleHeader ? `# ${titleHeader}\n\n` : ""
  const body = passages.map((p) => p.text).join("\n\n---\n\n")
  return header + body
}
