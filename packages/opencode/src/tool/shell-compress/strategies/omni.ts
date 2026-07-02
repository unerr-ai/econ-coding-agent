/**
 * Omni fallback compressor — used when classifier confidence < 0.7.
 * Simple dedup + error-line extraction; no domain-specific knowledge.
 */

const ERROR_RE = /\b(ERROR|FATAL|CRIT|PANIC|Exception|Traceback|FAIL(?:ED)?|WARN(?:ING)?)\b/i
const MAX_ERROR_LINES = 30
const MAX_PATTERNS = 30
const SMALL_THRESHOLD = 80

function normalizeOmniLine(line: string): string {
  return line
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*Z?/g, "<TS>")
    .replace(/\b[0-9a-f]{7,40}\b/gi, "<HASH>")
    .replace(/\b\d+\b/g, "<N>")
    .trim()
}

export function compressOmni(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  if (lines.length <= SMALL_THRESHOLD) return text

  const errorLines: string[] = []
  const seen = new Map<string, { line: string; count: number }>()

  for (const line of lines) {
    if (!line.trim()) continue
    if (ERROR_RE.test(line)) {
      errorLines.push(line)
      continue
    }
    const norm = normalizeOmniLine(line)
    if (norm.length < 4) continue
    const existing = seen.get(norm)
    if (existing) {
      existing.count++
    } else {
      seen.set(norm, { line, count: 1 })
    }
  }

  const parts: string[] = [`(${lines.length} lines)`]

  if (errorLines.length > 0) {
    const errDedup = new Map<string, { line: string; count: number }>()
    for (const e of errorLines) {
      const existing = errDedup.get(e)
      if (existing) existing.count++
      else errDedup.set(e, { line: e, count: 1 })
    }
    let shown = 0
    for (const { line, count } of errDedup.values()) {
      if (shown >= MAX_ERROR_LINES) break
      parts.push(count > 1 ? `${line}  [×${count}]` : line)
      shown++
    }
    if (errDedup.size > MAX_ERROR_LINES) parts.push(`… ${errDedup.size - MAX_ERROR_LINES} more error lines`)
  }

  const sorted = [...seen.values()].sort((a, b) => b.count - a.count)
  for (const { line, count } of sorted.slice(0, MAX_PATTERNS)) {
    parts.push(count > 1 ? `${line}  [×${count}]` : line)
  }
  if (sorted.length > MAX_PATTERNS) parts.push(`… ${sorted.length - MAX_PATTERNS} more unique patterns`)

  return parts.join("\n")
}
