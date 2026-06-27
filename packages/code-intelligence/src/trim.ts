/**
 * Output trimming for tool results — head+tail+match strategy.
 *
 * Trims large command output and file reads to a token budget while preserving
 * the most relevant slice: head lines (preamble, imports), optional match
 * context around a query string, and tail lines (result, exports). An elision
 * marker in the middle reports how many lines were dropped and the full token
 * count so callers can request more if needed. Never cuts mid-line.
 *
 * Pure TypeScript — no external dependencies, no native addons.
 * Ported from unerr-cli src/intelligence/token-estimator.ts +
 * src/intelligence/smart-truncate.ts (structural-priority variant adapted to
 * flat text output rather than structured entity sections).
 *
 * @sem domain=output-trim role=core
 */

// ---------------------------------------------------------------------------
// Token estimation — content-aware char heuristic (no gpt-tokenizer dep)
// ---------------------------------------------------------------------------

type ContentType = "code" | "prose" | "json" | "mixed"

const CHARS_PER_TOKEN: Record<ContentType, number> = {
  code: 3.5,
  prose: 4.0,
  json: 3.0,
  mixed: 3.7,
}

function detectContentType(text: string): ContentType {
  if (text.length === 0) return "mixed"

  const sample = text.slice(0, 2000)
  const trimmed = sample.trim()

  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    return "json"
  }

  const braceCount = (sample.match(/[{}()[\];=><]/g) ?? []).length
  const wordCount = (sample.match(/\b\w+\b/g) ?? []).length
  const codeIndicators = (
    sample.match(
      /\b(function|const|let|var|class|import|export|return|if|for|while|async|await|type|interface|def|fn)\b/g,
    ) ?? []
  ).length

  if (codeIndicators > 3 || braceCount > wordCount * 0.15) return "code"
  if (braceCount < 5 && sample.split("\n").length < sample.length / 60) return "prose"
  return "mixed"
}

/**
 * Estimate token count for a string using a content-aware char heuristic.
 *
 * Accuracy: ~±10% for typical code and prose, within 20% for worst-case inputs.
 * No external deps — safe in any environment.
 */
export function estimateTokens(text: string): number {
  if (!text || text.length === 0) return 0
  const contentType = detectContentType(text)
  const ratio = CHARS_PER_TOKEN[contentType]
  const whitespaceCount = (text.match(/\s/g) ?? []).length
  const nonWhitespaceCount = text.length - whitespaceCount
  // Whitespace is cheap (~0.25 tokens per char); content varies by type.
  return Math.ceil(whitespaceCount * 0.25 + nonWhitespaceCount / ratio)
}

// ---------------------------------------------------------------------------
// Smart truncation — head + match-context + tail
// ---------------------------------------------------------------------------

/** Chars reserved for the elision marker line itself. */
const ELISION_RESERVE = 100

export interface TrimOptions {
  /** Target token budget (default 2000). */
  budget?: number
  /**
   * Fraction of the budget allocated to head lines (default 0.4).
   * Head covers the beginning of the output: preamble, imports, command start.
   */
  headRatio?: number
  /**
   * Fraction of the budget allocated to tail lines (default 0.3).
   * Tail covers the end of the output: exit status, result, exports.
   */
  tailRatio?: number
  /**
   * Lines of context around each query match in the middle section (default 2).
   * Only used when `query` is supplied.
   */
  matchContext?: number
  /**
   * Optional substring query — surfaces matching lines with surrounding
   * context in the middle section between head and tail.
   */
  query?: string
}

export interface TrimResult {
  /** Trimmed (or original, if within budget) text. */
  text: string
  /** True when content was elided. */
  truncated: boolean
  /** Estimated tokens in the returned text. */
  tokensUsed: number
  /** Budget that was applied. */
  tokensBudget: number
  /** Estimated tokens in the original input. */
  fullTokensEstimate: number
}

/**
 * Trim tool output to a token budget using a head+match-context+tail strategy.
 *
 * When the input fits within the budget it is returned unchanged
 * (`truncated: false`). Otherwise the function keeps head lines (covering the
 * beginning), tail lines (covering the end), and — when a `query` string is
 * given — matching lines from the middle section with surrounding context. An
 * elision marker is inserted at each gap, reporting the count of dropped lines
 * and the full token estimate.
 */
export function smartTruncate(text: string, opts: TrimOptions = {}): TrimResult {
  const budget = Math.max(opts.budget ?? 2000, 100)
  const fullTokens = estimateTokens(text)

  if (fullTokens <= budget) {
    return {
      text,
      truncated: false,
      tokensUsed: fullTokens,
      tokensBudget: budget,
      fullTokensEstimate: fullTokens,
    }
  }

  const headRatio = opts.headRatio ?? 0.4
  const tailRatio = opts.tailRatio ?? 0.3
  const matchRatio = Math.max(0, 1 - headRatio - tailRatio)

  // Use 3.7 chars/token as the working average when allocating char budgets.
  const AVG_CHARS_PER_TOKEN = 3.7
  const totalChars = budget * AVG_CHARS_PER_TOKEN
  const headChars = Math.max(0, Math.floor(totalChars * headRatio) - ELISION_RESERVE)
  const tailChars = Math.max(0, Math.floor(totalChars * tailRatio))
  const matchChars = Math.max(0, Math.floor(totalChars * matchRatio) - ELISION_RESERVE)

  const lines = text.split("\n")

  // --- Head: lines from the top ---
  const headLines: string[] = []
  let headLen = 0
  for (const line of lines) {
    const len = line.length + 1 // +1 for the newline
    if (headLen + len > headChars && headLines.length > 0) break
    headLines.push(line)
    headLen += len
  }

  // --- Tail: lines from the bottom ---
  const tailLines: string[] = []
  let tailLen = 0
  for (let i = lines.length - 1; i >= headLines.length; i--) {
    const line = lines[i]
    const len = line.length + 1
    if (tailLen + len > tailChars && tailLines.length > 0) break
    tailLines.unshift(line)
    tailLen += len
  }

  // --- Match context: query hits in the middle ---
  const middleStart = headLines.length
  const middleEnd = lines.length - tailLines.length
  const matchIdxSet = new Set<number>()

  if (opts.query && matchChars > 0 && middleStart < middleEnd) {
    const ctxRadius = Math.max(0, opts.matchContext ?? 2)
    const queryLower = opts.query.toLowerCase()
    let matchLen = 0

    for (let i = middleStart; i < middleEnd; i++) {
      if (lines[i].toLowerCase().includes(queryLower)) {
        // Always try to add the match line itself first — it is more important
        // than the context lines around it. Context fills in around it if budget
        // allows, but the hit line must not be starved by its own context prefix.
        if (!matchIdxSet.has(i)) {
          const matchLineLen = lines[i].length + 1
          if (matchLen + matchLineLen <= matchChars) {
            matchIdxSet.add(i)
            matchLen += matchLineLen
          }
        }
        // Then expand context around the match line (best-effort, budget permitting)
        const from = Math.max(middleStart, i - ctxRadius)
        const to = Math.min(middleEnd - 1, i + ctxRadius)
        for (let j = from; j <= to; j++) {
          if (!matchIdxSet.has(j)) {
            const len = lines[j].length + 1
            if (matchLen + len > matchChars) continue // skip this context line, try next
            matchIdxSet.add(j)
            matchLen += len
          }
        }
      }
    }
  }

  // --- Assemble result ---
  const sortedMatchIdxs = Array.from(matchIdxSet).sort((a, b) => a - b)
  const matchLinesInOrder = sortedMatchIdxs.map((i) => lines[i])

  const parts: string[] = []
  parts.push(...headLines)

  if (matchLinesInOrder.length > 0) {
    const omittedBeforeMatch =
      middleStart < sortedMatchIdxs[0] ? sortedMatchIdxs[0] - middleStart : 0
    if (omittedBeforeMatch > 0) {
      parts.push(`... [${omittedBeforeMatch} lines elided] ...`)
    }
    parts.push(...matchLinesInOrder)
    const lastMatchIdx = sortedMatchIdxs[sortedMatchIdxs.length - 1]
    const omittedAfterMatch =
      lastMatchIdx < middleEnd - 1 ? middleEnd - 1 - lastMatchIdx : 0
    if (omittedAfterMatch > 0) {
      parts.push(`... [${omittedAfterMatch} lines elided] ...`)
    }
  } else {
    const omitted = middleEnd - middleStart
    if (omitted > 0) {
      parts.push(
        `... [${omitted} lines elided — ${fullTokens} estimated tokens, budget ${budget}] ...`,
      )
    }
  }

  parts.push(...tailLines)

  const result = parts.join("\n")
  return {
    text: result,
    truncated: true,
    tokensUsed: estimateTokens(result),
    tokensBudget: budget,
    fullTokensEstimate: fullTokens,
  }
}
