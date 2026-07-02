/**
 * Web search tool for the econ agent toolset.
 *
 * Sprint 3B upgrades:
 *  - BM25-prunes each result's snippet against the query (replaces raw char cap)
 *  - Returns a lean shape {title, url, ranked_snippet, score, published_at?}
 *  - Deduplicates near-identical results by canonical URL
 *  - `depth:0` (default) returns pruned snippets only — no page fetches
 *  - `depth:K` auto-fetches the top-K result URLs via runFetchUrlBatch and
 *    returns cross-document BM25-ranked passages with per-source provenance;
 *    raw pages are discarded before context (one call replaces search+pick+fetch)
 *  - `cache_ref` / `offset` / `limit` enable pagination at ~0 recompute cost
 *  - `withMeta` + `recordToolCall` wire into the Sprint-0 token meter
 *
 * @sem domain=intelligence role=tools
 */

import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import * as Tool from "./tool"
import * as McpWebSearch from "./mcp-websearch"
import DESCRIPTION from "./websearch.txt"
import { checksum } from "@opencode-ai/core/util/encode"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { rankPassagesByPrompt } from "../../../code-intelligence/src/webfetch/bm25"
import { runFetchUrlBatch, type BatchPassage, type BatchSource } from "../../../code-intelligence/src/webfetch/fetch-batch"
import { hashInputs, put, getSlice, withMeta, recordToolCall } from "./_shared"

// ---------------------------------------------------------------------------
// Public parameter schema
// ---------------------------------------------------------------------------

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({ description: "Websearch query" }),
  numResults: Schema.optional(Schema.Number).annotate({
    description: "Number of search results to return (default: 8)",
  }),
  livecrawl: Schema.optional(Schema.Literals(["fallback", "preferred"])).annotate({
    description:
      "Live crawl mode - 'fallback': use live crawling as backup if cached content unavailable, 'preferred': prioritize live crawling (default: 'fallback')",
  }),
  type: Schema.optional(Schema.Literals(["auto", "fast", "deep"])).annotate({
    description: "Search type - 'auto': balanced search (default), 'fast': quick results, 'deep': comprehensive search",
  }),
  contextMaxCharacters: Schema.optional(Schema.Number).annotate({
    description: "Maximum characters for context string (passed to provider; BM25 pruning is applied on top)",
  }),
  depth: Schema.optional(Schema.Number).annotate({
    description:
      "0 (default) = return BM25-pruned lean snippets only, no page fetches. " +
      "K (1–5) = auto-fetch the top-K result URLs in parallel, BM25-rank passages cross-document, " +
      "and return only the relevant passages with per-source provenance. Raw pages are never returned.",
  }),
  token_budget: Schema.optional(Schema.Number).annotate({
    description: "Approximate token budget for the response (default 2000). Limits results/passages returned.",
  }),
  cache_ref: Schema.optional(Schema.String).annotate({
    description: "Opaque ref from a prior call — returns the next cached page at ~0 cost.",
  }),
  offset: Schema.optional(Schema.Number).annotate({
    description: "0-based item offset for pagination (default 0). Used with cache_ref.",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Items per page (default 5 for snippets, 15 for depth passages).",
  }),
})

// ---------------------------------------------------------------------------
// Provider helpers (unchanged from original)
// ---------------------------------------------------------------------------

const WebSearchProviderSchema = Schema.Literals(["exa", "parallel"])
export type WebSearchProvider = Schema.Schema.Type<typeof WebSearchProviderSchema>

export function selectWebSearchProvider(sessionID: string, flags = { exa: false, parallel: false }): WebSearchProvider {
  const override = process.env.OPENCODE_WEBSEARCH_PROVIDER
  if (override === "exa" || override === "parallel") return override
  if (flags.parallel) return "parallel"
  if (flags.exa) return "exa"
  return Number.parseInt(checksum(sessionID) ?? "0", 36) % 2 === 0 ? "exa" : "parallel"
}

export function webSearchProviderLabel(provider: unknown) {
  if (provider === "parallel") return "Parallel Web Search"
  if (provider === "exa") return "Exa Web Search"
  return "Web Search"
}

export function webSearchModelName(extra: Tool.Context["extra"]) {
  const model = extra?.model
  if (!model || typeof model !== "object") return undefined
  const api = "api" in model && model.api && typeof model.api === "object" ? model.api : undefined
  const apiID = api && "id" in api && typeof api.id === "string" ? api.id : undefined
  const id = "id" in model && typeof model.id === "string" ? model.id : undefined
  return (apiID ?? id)?.slice(0, 100)
}

function parallelAuthHeaders() {
  const headers = { "User-Agent": `opencode/${InstallationVersion}` }
  if (!process.env.PARALLEL_API_KEY) return headers
  return { ...headers, Authorization: `Bearer ${process.env.PARALLEL_API_KEY}` }
}

function callProvider(
  http: HttpClient.HttpClient,
  provider: WebSearchProvider,
  params: Schema.Schema.Type<typeof Parameters>,
  ctx: Tool.Context,
) {
  if (provider === "parallel") {
    return McpWebSearch.call(
      http,
      McpWebSearch.PARALLEL_URL,
      "web_search",
      McpWebSearch.ParallelSearchArgs,
      {
        objective: params.query,
        search_queries: [params.query],
        session_id: ctx.sessionID,
        model_name: webSearchModelName(ctx.extra),
      },
      "25 seconds",
      parallelAuthHeaders(),
    )
  }

  return McpWebSearch.call(
    http,
    McpWebSearch.EXA_URL,
    "web_search_exa",
    McpWebSearch.SearchArgs,
    {
      query: params.query,
      type: params.type || "auto",
      numResults: params.numResults || 8,
      livecrawl: params.livecrawl || "fallback",
      contextMaxCharacters: params.contextMaxCharacters,
    },
    "25 seconds",
  )
}

// ---------------------------------------------------------------------------
// Search result types
// ---------------------------------------------------------------------------

/** Raw parsed search hit from the provider response. */
export interface ParsedHit {
  title: string
  url: string
  snippet: string
  published_at?: string
  score?: number
}

/** Lean result shape returned to the model — no raw HTML or redundant fields. */
export interface LeanSearchHit {
  title: string
  url: string
  ranked_snippet: string
  score?: number
  published_at?: string
}

// ---------------------------------------------------------------------------
// Parse provider response text into structured hits
// ---------------------------------------------------------------------------

/**
 * Attempt to extract structured search hits from a provider response string.
 * Tries JSON parsing first (Exa typically returns JSON), then falls back to
 * URL-anchored block parsing for text-format responses.
 *
 * Exported for unit testing.
 */
export function parseSearchHits(raw: string, _provider: WebSearchProvider): ParsedHit[] {
  if (!raw || !raw.trim()) return []

  // ── JSON path (Exa / structured providers) ──────────────────────────────
  try {
    const data: unknown = JSON.parse(raw)
    const extractFromArray = (arr: unknown[]): ParsedHit[] =>
      arr.flatMap((r) => {
        if (!r || typeof r !== "object") return []
        const ro = r as Record<string, unknown>
        const url = typeof ro["url"] === "string" ? ro["url"].trim() : ""
        if (!url) return []
        const snippet =
          typeof ro["text"] === "string" ? ro["text"] :
          typeof ro["content"] === "string" ? ro["content"] :
          typeof ro["snippet"] === "string" ? ro["snippet"] : ""
        return [{
          title: typeof ro["title"] === "string" ? ro["title"] : url,
          url,
          snippet,
          published_at: typeof ro["publishedDate"] === "string" ? ro["publishedDate"]
            : typeof ro["published_at"] === "string" ? ro["published_at"]
            : undefined,
          score: typeof ro["score"] === "number" ? ro["score"] : undefined,
        }]
      })

    if (data && typeof data === "object") {
      const obj = data as Record<string, unknown>
      if (Array.isArray(obj["results"])) return extractFromArray(obj["results"] as unknown[])
      if (Array.isArray(obj["hits"]))    return extractFromArray(obj["hits"] as unknown[])
      if (Array.isArray(data))           return extractFromArray(data as unknown[])
    }
  } catch { /* not JSON — fall through */ }

  // ── Text fallback: URL-anchored block parsing ────────────────────────────
  const hits: ParsedHit[] = []
  const urlRe = /https?:\/\/[^\s,'">\]）]+/g
  const blocks = raw.split(/\n{2,}/)
  for (const block of blocks) {
    const urlMatches = [...block.matchAll(urlRe)]
    if (urlMatches.length === 0) continue
    const url = (urlMatches[0]?.[0] ?? "").replace(/[.,;)]+$/, "")
    const titleMatch = block.match(/^(?:\d+\.\s*)?(.+?)(?:\n|$)/)
    const title = titleMatch?.[1]?.replace(urlRe, "").trim() ?? ""
    const snippet = block.replace(urlRe, "").replace(title, "").trim().slice(0, 600)
    hits.push({ url, title, snippet })
  }
  return hits
}

// ---------------------------------------------------------------------------
// Dedup by canonical URL
// ---------------------------------------------------------------------------

/** Derive a dedup key: scheme-normalised URL with tracking params and hash stripped. */
function canonicalKey(url: string): string {
  try {
    const u = new URL(url)
    for (const p of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ref", "fbclid"]) {
      u.searchParams.delete(p)
    }
    u.hash = ""
    return u.origin.toLowerCase() + u.pathname.toLowerCase().replace(/\/$/, "") + u.search
  } catch {
    return url.toLowerCase()
  }
}

/**
 * Remove duplicate hits that share a canonical URL. First occurrence wins.
 * Exported for unit testing.
 */
export function dedupHits(hits: ParsedHit[]): ParsedHit[] {
  const seen = new Set<string>()
  return hits.filter((h) => {
    const key = canonicalKey(h.url)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ---------------------------------------------------------------------------
// BM25-rank snippets and return lean shape
// ---------------------------------------------------------------------------

/**
 * BM25-rank search result snippets against `query` and return the lean shape.
 * Reuses the fetch-batch BM25 ranker — converts hits into Passage-like objects,
 * ranks, then maps back. Exported for unit testing.
 */
export function pruneHitsByBm25(hits: ParsedHit[], query: string, topK: number): LeanSearchHit[] {
  if (hits.length === 0 || !query.trim()) {
    return hits.slice(0, topK).map((h) => toLeanhit(h))
  }

  // Adapt hits to the Passage interface expected by rankPassagesByPrompt
  const passages = hits.map((h, i) => ({
    index: i,
    heading: h.title,
    text: h.snippet || h.title,
    startLine: 0,
  }))

  const ranked = rankPassagesByPrompt(passages, { prompt: query, topK })
  return ranked.map((p) => toLeanhit(hits[p.index]!))
}

function toLeanhit(h: ParsedHit): LeanSearchHit {
  return {
    title: h.title,
    url: h.url,
    ranked_snippet: h.snippet.slice(0, 600),
    ...(h.score !== undefined ? { score: h.score } : {}),
    ...(h.published_at ? { published_at: h.published_at } : {}),
  }
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/** Serialise lean hits as numbered markdown for the model. */
export function formatLeanHits(hits: LeanSearchHit[]): string {
  return hits
    .map((h, i) => {
      const lines = [`${i + 1}. **${h.title || h.url}**`, `   URL: ${h.url}`]
      if (h.published_at) lines.push(`   Published: ${h.published_at}`)
      if (h.ranked_snippet) lines.push(`   ${h.ranked_snippet}`)
      return lines.join("\n")
    })
    .join("\n\n")
}

/** Serialise depth-fusion passages with provenance for the model. */
function formatDepthPassages(passages: BatchPassage[], sources: BatchSource[]): string {
  const srcMap = new Map(sources.map((s) => [s.source_index, s]))
  return passages
    .map((p) => {
      const src = srcMap.get(p.source_index)
      const sourceLabel = src ? `${src.title || src.url} (${src.url})` : p.source_url
      const parts = [`Source: ${sourceLabel}`]
      if (p.heading) parts.push(`## ${p.heading}`)
      parts.push(p.text)
      return parts.join("\n")
    })
    .join("\n\n---\n\n")
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const WebSearchTool = Tool.define(
  "websearch",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const flags = yield* RuntimeFlags.Service

    return {
      get description() {
        return DESCRIPTION.replace("{{year}}", new Date().getFullYear().toString())
      },
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const { query, depth = 0, token_budget = 2000, cache_ref, offset = 0, limit } = params
          const numResults = params.numResults ?? 8

          // ── cache_ref pagination path ───────────────────────────────────────
          if (cache_ref) {
            const pageSize = limit ?? (depth > 0 ? 15 : 5)
            const sliceResult = getSlice(cache_ref, offset, pageSize)
            if (sliceResult) {
              const content =
                depth > 0
                  ? formatDepthPassages(sliceResult.slice as BatchPassage[], [])
                  : formatLeanHits(sliceResult.slice as LeanSearchHit[])
              const baseMeta = withMeta("", content)
              recordToolCall({ tool: "websearch", ...baseMeta })
              return {
                output: content,
                title: `Web Search: ${query}`,
                metadata: { cached: true, cache_ref } as Record<string, unknown>,
                meta: { ...baseMeta, cache_ref, total: sliceResult.total, more: sliceResult.more },
              }
            }
            // Cache miss — fall through to fresh search
          }

          // ── Provider selection + permission ─────────────────────────────────
          const provider = selectWebSearchProvider(ctx.sessionID, {
            exa: flags.enableExa,
            parallel: flags.enableParallel,
          })
          const providerLabel = webSearchProviderLabel(provider)
          yield* ctx.metadata({ title: `${providerLabel} "${query}"`, metadata: { provider } })

          yield* ctx.ask({
            permission: "websearch",
            patterns: [query],
            always: ["*"],
            metadata: {
              query,
              numResults: params.numResults,
              livecrawl: params.livecrawl,
              type: params.type,
              contextMaxCharacters: params.contextMaxCharacters,
              provider,
            },
          })

          // ── Search ──────────────────────────────────────────────────────────
          const rawResult = yield* callProvider(http, provider, params, ctx)
          const rawText = rawResult ?? ""

          // ── Parse + dedup + BM25-prune ──────────────────────────────────────
          const hits = parseSearchHits(rawText, provider)
          const deduped = dedupHits(hits)
          const effectiveTopK = Math.min(numResults, Math.max(1, Math.floor(token_budget / 200)))
          const leanHits = pruneHitsByBm25(deduped, query, effectiveTopK)

          // ── depth:0 — pruned snippets only, no fetch ────────────────────────
          if (depth === 0 || leanHits.length === 0) {
            const pageSize = limit ?? 5
            const pageKey = hashInputs("websearch:snippets", query, provider)
            put(pageKey, leanHits)
            const sliceResult = getSlice(pageKey, offset, pageSize)!
            const pageHits = sliceResult.slice as LeanSearchHit[]
            const content = pageHits.length > 0
              ? formatLeanHits(pageHits)
              : (rawText.slice(0, token_budget * 4) || "No search results found. Please try a different query.")
            const baseMeta = withMeta(rawText, content)
            recordToolCall({ tool: "websearch", ...baseMeta })
            const paginationMeta = sliceResult.more
              ? { cache_ref: pageKey, total: sliceResult.total, more: true as const }
              : {}
            return {
              output: content,
              title: `${providerLabel}: ${query}`,
              metadata: { provider, depth: 0, hits: leanHits.length } as Record<string, unknown>,
              meta: { ...baseMeta, ...paginationMeta },
            }
          }

          // ── depth:K — batch-fetch top-K URLs + cross-doc BM25 ───────────────
          const topK = Math.min(depth, 5)
          const topUrls = leanHits.slice(0, topK).map((h) => h.url)

          const batchResult = yield* Effect.promise(() =>
            runFetchUrlBatch(topUrls, { prompt: query }),
          )

          if (batchResult.result_status === "error") {
            // Fetch failed — fall back to lean snippets
            const content = leanHits.length > 0
              ? formatLeanHits(leanHits.slice(0, 5))
              : "Search succeeded but page fetch failed. Please try a more specific query."
            const baseMeta = withMeta(rawText, content)
            recordToolCall({ tool: "websearch", ...baseMeta })
            return {
              output: content,
              title: `${providerLabel}: ${query}`,
              metadata: { provider, depth, fetch_failed: true } as Record<string, unknown>,
              meta: baseMeta,
            }
          }

          const allPassages = batchResult.passages
          const pageSize = limit ?? 15
          const pageKey = hashInputs("websearch:depth", query, String(depth), provider)
          put(pageKey, allPassages)
          const sliceResult = getSlice(pageKey, offset, pageSize)!
          const pagePassages = sliceResult.slice as BatchPassage[]
          const content = formatDepthPassages(pagePassages, batchResult.sources)

          const baseMeta = withMeta(rawText, content)
          recordToolCall({ tool: "websearch", ...baseMeta })
          const paginationMeta = sliceResult.more
            ? { cache_ref: pageKey, total: sliceResult.total, more: true as const }
            : {}

          return {
            output: content,
            title: `${providerLabel}: ${query}`,
            metadata: {
              provider,
              depth,
              fetched_urls: topUrls,
              sources: batchResult.sources.map((s) => ({
                url: s.url,
                title: s.title,
                status: s.result_status,
              })),
            } as Record<string, unknown>,
            meta: { ...baseMeta, ...paginationMeta },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
