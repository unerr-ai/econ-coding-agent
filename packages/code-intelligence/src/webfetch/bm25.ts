/**
 * Pure-TypeScript BM25 passage ranking — no external dependencies.
 *
 * Scores each passage against a caller-supplied query prompt using the
 * Okapi BM25 formula (k1=1.5, b=0.75) with separate heading / text field
 * weights. Passages below a minimum prose threshold (too short, or
 * navigation-link-heavy) are filtered before ranking so nav chrome doesn't
 * displace substantive content.
 *
 * Empty prompt → returns passages in original document order, untouched.
 *
 * Ported and extended from unerr-cli src/tools/web/bm25-rank.ts; wink-
 * bm25-text-search dep replaced with an inline implementation to keep this
 * module dep-free.
 *
 * @sem domain=intelligence role=webfetch
 */

import type { Passage } from "./passage-split.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options for BM25 passage ranking.
 *
 * @sem domain=intelligence role=webfetch
 */
export interface RankOptions {
  /** Natural-language query to rank passages against. */
  prompt: string
  /** Maximum number of passages to return (default: min(20, corpus size)). */
  topK?: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_RANKABLE_TEXT_CHARS = 150
const MAX_LINK_DENSITY = 0.4
const HEADING_WEIGHT = 1.2
const TEXT_WEIGHT = 1.0
const BM25_K1 = 1.5
const BM25_B = 0.75
const BM25_MIN_CORPUS_SIZE = 3

const MARKDOWN_LINK_PATTERN = /\[[^\]]+\]\([^)]+\)/g

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "of", "and", "or", "but", "in", "on", "at", "to", "for", "with",
  "by", "from", "up", "down", "out", "off", "over", "under", "as",
  "this", "that", "these", "those", "it", "its", "into", "if", "then",
  "do", "does", "did",
])

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
}

// ---------------------------------------------------------------------------
// Prose-candidate filter
// ---------------------------------------------------------------------------

function linkDensity(text: string): number {
  if (text.length === 0) return 0
  const links = text.match(MARKDOWN_LINK_PATTERN)
  if (!links) return 0
  const linkBytes = links.reduce((sum, link) => sum + link.length, 0)
  return linkBytes / text.length
}

function isProseCandidate(passage: Passage): boolean {
  if (passage.text.length < MIN_RANKABLE_TEXT_CHARS) return false
  if (linkDensity(passage.text) > MAX_LINK_DENSITY) return false
  return true
}

// ---------------------------------------------------------------------------
// Pure BM25 scorer
// ---------------------------------------------------------------------------

interface DocTokens {
  textTokens: string[]
  headingTokens: string[]
}

function computeBm25Scores(docs: DocTokens[], queryTokens: string[]): number[] {
  const N = docs.length
  const totalLen = docs.reduce(
    (sum, d) => sum + d.textTokens.length * TEXT_WEIGHT + d.headingTokens.length * HEADING_WEIGHT,
    0,
  )
  const avgdl = N > 0 ? totalLen / N : 1

  // Document frequency per term (across text + heading combined)
  const df = new Map<string, number>()
  for (const doc of docs) {
    const terms = new Set([...doc.textTokens, ...doc.headingTokens])
    for (const term of terms) {
      df.set(term, (df.get(term) ?? 0) + 1)
    }
  }

  return docs.map((doc) => {
    const dl = doc.textTokens.length * TEXT_WEIGHT + doc.headingTokens.length * HEADING_WEIGHT
    let score = 0

    for (const term of queryTokens) {
      const docFreq = df.get(term) ?? 0
      if (docFreq === 0) continue

      const idf = Math.log((N - docFreq + 0.5) / (docFreq + 0.5) + 1)

      // Text field contribution
      const tfText = doc.textTokens.filter((t) => t === term).length
      if (tfText > 0) {
        const norm = (tfText * (BM25_K1 + 1)) / (tfText + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgdl)))
        score += TEXT_WEIGHT * idf * norm
      }

      // Heading field contribution (boosted)
      const tfHeading = doc.headingTokens.filter((t) => t === term).length
      if (tfHeading > 0) {
        const norm =
          (tfHeading * (BM25_K1 + 1)) / (tfHeading + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgdl)))
        score += HEADING_WEIGHT * idf * norm
      }
    }

    return score
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Rank passages by BM25 relevance to a query prompt. Filters navigation chrome
 * (short / link-heavy passages) before scoring. Returns original order when
 * prompt is empty or corpus is too small to rank meaningfully.
 *
 * @sem domain=intelligence role=webfetch
 */
export function rankPassagesByPrompt(passages: Passage[], opts: RankOptions): Passage[] {
  const prompt = opts.prompt?.trim()
  if (!prompt || passages.length === 0) return passages

  const promptTokens = tokenize(prompt)
  if (promptTokens.length === 0) return passages

  const prose = passages.filter(isProseCandidate)
  const candidates = prose.length > 0 ? prose : passages
  const topK = Math.max(1, opts.topK ?? Math.min(20, candidates.length))

  if (candidates.length < BM25_MIN_CORPUS_SIZE) {
    return candidates.slice(0, topK)
  }

  const docs: DocTokens[] = candidates.map((p) => ({
    textTokens: tokenize(p.text),
    headingTokens: tokenize(p.heading ?? ""),
  }))

  const scores = computeBm25Scores(docs, promptTokens)

  // Sort by score descending; fall back to original order on all-zero scores
  const indexed = candidates.map((p, i) => ({ p, score: scores[i] ?? 0 }))
  indexed.sort((a, b) => b.score - a.score)

  if ((indexed[0]?.score ?? 0) === 0) return candidates.slice(0, topK)

  return indexed.slice(0, topK).map((x) => x.p)
}
