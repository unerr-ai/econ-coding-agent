/**
 * Batch web-fetch engine: fetch N URLs in parallel (bounded concurrency +
 * overall deadline), BM25-rank passages cross-document, return provenance-
 * tagged passages in one call. This is the shared engine that search-fusion
 * will later reuse — keep it dep-free beyond the sibling webfetch modules.
 *
 * Designed for testability: pass `opts.fetchFn` to inject a mock fetch so
 * tests run without network access.
 *
 * @sem domain=intelligence role=webfetch
 */

import { htmlToMarkdown, type PageMetadata } from "./extract.js"
import { splitMarkdownIntoPassages, type Passage } from "./passage-split.js"
import { rankPassagesByPrompt } from "./bm25.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A passage in a batch result, carrying provenance back to its source page.
 *
 * @sem domain=intelligence role=webfetch
 */
export interface BatchPassage {
  /** Ordinal in the merged list after cross-document ranking. */
  index: number
  /** Zero-based index of the source URL in the input array. */
  source_index: number
  /** Final URL of the source page (after redirects). */
  source_url: string
  heading: string | null
  text: string
}

/**
 * Per-URL fetch summary row in a batch result.
 *
 * @sem domain=intelligence role=webfetch
 */
export interface BatchSource {
  source_index: number
  url: string
  result_status: "ok" | "error"
  title: string
  word_count?: number
  /** Error message for failed sources; absent on ok. */
  error?: string
  /** OG/article metadata parsed from the source page. */
  metadata?: PageMetadata
}

/**
 * Successful batch result: cross-document BM25-ranked passages (or round-robin
 * interleaved when no prompt) with per-source provenance.
 *
 * @sem domain=intelligence role=webfetch
 */
export interface BatchFetchOk {
  result_status: "ok"
  sources: BatchSource[]
  passages: BatchPassage[]
  total: number
  fetched: number
  ok: number
  failed: number
}

/**
 * Batch result when every URL failed.
 *
 * @sem domain=intelligence role=webfetch
 */
export interface BatchFetchError {
  result_status: "error"
  sources: BatchSource[]
  fetched: number
  ok: 0
  failed: number
  suggestion: string
}

/** Union of all possible batch results. */
export type BatchFetchResult = BatchFetchOk | BatchFetchError

/**
 * Options for runFetchUrlBatch. All fields optional; sensible defaults apply.
 *
 * @sem domain=intelligence role=webfetch
 */
export interface BatchFetchOptions {
  /** Natural-language query used to BM25-rank passages across all pages. */
  prompt?: string
  /** Max passages to return (default: min(30, total passages)). */
  top_k?: number
  /** Max concurrent fetches (default 5). */
  concurrency?: number
  /** Overall wall-clock cap in ms across the whole batch (default 30 000). */
  deadlineMs?: number
  /**
   * Injected fetch function. Defaults to globalThis.fetch.
   * Pass a mock here in unit tests so no real network calls are made.
   */
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface SourcedPassage extends Passage {
  sourceIndex: number
  sourceUrl: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BATCH_URLS = 10
const DEFAULT_CONCURRENCY = 5
const DEFAULT_DEADLINE_MS = 30_000
const FETCH_TIMEOUT_MS = 15_000
/** Only BM25-rank when the combined passage text exceeds this byte threshold. */
const BM25_GATE_BYTES = 8_192
const DEFAULT_TOP_K = 30

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchFn(url, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** Interleave passages by source so no single page dominates when there is no prompt. */
function interleaveBySource(passages: SourcedPassage[]): SourcedPassage[] {
  if (passages.length === 0) return passages
  const bySource = new Map<number, SourcedPassage[]>()
  for (const p of passages) {
    const arr = bySource.get(p.sourceIndex)
    if (arr) arr.push(p)
    else bySource.set(p.sourceIndex, [p])
  }
  const queues = [...bySource.values()]
  const out: SourcedPassage[] = []
  let drained = false
  while (!drained) {
    drained = true
    for (const q of queues) {
      const next = q.shift()
      if (next) {
        out.push(next)
        drained = false
      }
    }
  }
  return out
}

/** Run work items with bounded concurrency and an overall deadline. */
async function runBounded<T>(
  items: string[],
  concurrency: number,
  deadlineMs: number,
  work: (url: string, index: number) => Promise<T>,
): Promise<(T | { _error: string })[]> {
  const deadline = Date.now() + deadlineMs
  const out = new Array<T | { _error: string }>(items.length)
  let cursor = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        out[i] = { _error: "batch_deadline_exceeded" }
        continue
      }
      try {
        out[i] = await Promise.race([
          work(items[i] as string, i),
          new Promise<{ _error: string }>((resolve) =>
            setTimeout(() => resolve({ _error: "batch_deadline_exceeded" }), remaining),
          ),
        ])
      } catch (e) {
        out[i] = { _error: e instanceof Error ? e.message : String(e) }
      }
    }
  }

  const pool = Math.min(Math.max(1, concurrency), items.length)
  await Promise.all(Array.from({ length: pool }, () => worker()))
  return out
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Fetch 1–10 URLs in parallel, BM25-rank passages cross-document, and return
 * provenance-tagged passages in one call. When no prompt is provided, passages
 * are interleaved by source so no single page dominates.
 *
 * Injecting `opts.fetchFn` enables unit tests without network access:
 * ```ts
 * const result = await runFetchUrlBatch(urls, { fetchFn: myMockFetch })
 * ```
 *
 * @sem domain=intelligence role=webfetch
 */
export async function runFetchUrlBatch(
  urls: string[],
  opts: BatchFetchOptions = {},
): Promise<BatchFetchResult> {
  // 1. Dedupe + cap
  const deduped: string[] = []
  const seen = new Set<string>()
  for (const u of urls) {
    if (typeof u !== "string") continue
    const t = u.trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    deduped.push(t)
    if (deduped.length >= MAX_BATCH_URLS) break
  }

  if (deduped.length === 0) {
    return {
      result_status: "error",
      sources: [],
      fetched: 0,
      ok: 0,
      failed: 0,
      suggestion: "runFetchUrlBatch requires at least one URL string",
    }
  }

  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY)
  const deadlineMs = Math.max(1000, opts.deadlineMs ?? DEFAULT_DEADLINE_MS)
  const fetchFn = opts.fetchFn ?? globalThis.fetch
  const prompt = opts.prompt?.trim() ?? ""

  // 2. Parallel fetch with bounded concurrency + overall deadline
  type PageOk = { title: string; markdown: string; finalUrl: string; metadata: PageMetadata }
  type PageErr = { _error: string }

  const settled = await runBounded<PageOk | PageErr>(deduped, concurrency, deadlineMs, async (url) => {
    const res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS, fetchFn)
    if (!res.ok) return { _error: `HTTP ${res.status}` }
    const html = await res.text()
    const { title, markdown, metadata } = await htmlToMarkdown(html, res.url || url)
    return { title, markdown, finalUrl: res.url || url, metadata }
  })

  // 3. Build sources + collect passages with cross-document provenance
  const sources: BatchSource[] = []
  const allPassages: SourcedPassage[] = []
  let okCount = 0
  let globalIdx = 0

  for (let i = 0; i < deduped.length; i++) {
    const r = settled[i]
    if (r && !("_error" in r)) {
      const pageResult = r as PageOk
      okCount++
      const passages = splitMarkdownIntoPassages(pageResult.markdown)
      sources.push({
        source_index: i,
        url: deduped[i] as string,
        result_status: "ok",
        title: pageResult.title || (deduped[i] as string),
        word_count: pageResult.markdown.split(/\s+/).filter(Boolean).length,
        metadata: pageResult.metadata,
      })
      for (const p of passages) {
        allPassages.push({
          ...p,
          index: globalIdx++,
          sourceIndex: i,
          sourceUrl: pageResult.finalUrl,
        })
      }
    } else {
      sources.push({
        source_index: i,
        url: deduped[i] as string,
        result_status: "error",
        title: "",
        error: (r as PageErr)?._error ?? "fetch_failed",
      })
    }
  }

  if (okCount === 0) {
    return {
      result_status: "error",
      sources,
      fetched: deduped.length,
      ok: 0,
      failed: deduped.length,
      suggestion:
        deduped.length === 1
          ? "the URL failed — check connectivity or try the URL directly"
          : "every URL failed — retry individual URLs to see specific errors",
    }
  }

  // 4. Cross-document BM25 rank or interleave by source
  let ordered: SourcedPassage[]
  const combinedBytes = Buffer.byteLength(allPassages.map((p) => p.text).join("\n"), "utf-8")
  if (prompt && combinedBytes > BM25_GATE_BYTES && allPassages.length > 0) {
    // rankPassagesByPrompt returns elements from the input array — SourcedPassage is a Passage
    const ranked = rankPassagesByPrompt(allPassages as Passage[], { prompt, topK: allPassages.length })
    ordered = ranked as SourcedPassage[]
  } else {
    ordered = interleaveBySource(allPassages)
  }

  // 5. Slice to top_k and build final passage list with global provenance indices
  const topK = Math.max(1, opts.top_k ?? Math.min(DEFAULT_TOP_K, ordered.length))
  const window = ordered.slice(0, topK)
  const passages: BatchPassage[] = window.map((p, i) => ({
    index: i,
    source_index: p.sourceIndex,
    source_url: p.sourceUrl,
    heading: p.heading,
    text: p.text,
  }))

  return {
    result_status: "ok",
    sources,
    passages,
    total: ordered.length,
    fetched: deduped.length,
    ok: okCount,
    failed: deduped.length - okCount,
  }
}
