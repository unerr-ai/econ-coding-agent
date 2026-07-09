/**
 * Extract the first balanced top-level JSON object from `raw` — brace-match
 * from the first `{` to its matching `}`, tracking string literals so a
 * quoted `{`/`}` never miscounts depth — so a reasoning preamble before the
 * JSON, or trailing prose after it, doesn't break parsing. Returns `null`
 * when no balanced object is found.
 */
export function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{")
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return raw.slice(start, i + 1)
    }
  }
  return null
}
