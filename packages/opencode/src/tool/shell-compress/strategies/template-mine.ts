/**
 * Drain3-lite log template mining — a pre-pass for the shell-output
 * compressor strategies. Masks variable tokens (numbers, hex/uuid, quoted
 * strings, filesystem paths, durations/sizes, ISO timestamps) to derive a
 * template key per line, then collapses lines that share a template. Drain3's
 * persistent parse tree and incremental learning are overkill for a single
 * captured shell output — this is the econ-lean version: one pass over the
 * given lines, no state carried between calls.
 */

import { isSalientLine } from "./salience"

const DUP_THRESHOLD = 3

const NUMBER_RE = /^-?\d+(\.\d+)?$/
const HEX_RE = /^(0x)?[0-9a-f]{6,}$/i
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const QUOTED_RE = /^(".*"|'.*')$/
const DURATION_SIZE_RE = /^\d+(\.\d+)?(ms|s|sec|min|h|B|KB|MB|GB|TB)$/i
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}:\d{2}([.,]\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/

function isFsPath(token: string): boolean {
  if (token.startsWith("/") || token.startsWith("./") || token.startsWith("~")) return true
  return token.includes("/") && /\.[a-zA-Z0-9]{1,8}$/.test(token)
}

// Trims trailing punctuation (log noise like `42,` or `foo.ts:`) before
// classifying a token, then re-attaches it to the masked placeholder so the
// template key still reflects the surrounding shape of the line.
function maskToken(token: string): string {
  if (!token) return token
  const stripped = token.replace(/[,;:]+$/, "")
  const suffix = token.slice(stripped.length)
  if (
    NUMBER_RE.test(stripped) ||
    HEX_RE.test(stripped) ||
    UUID_RE.test(stripped) ||
    QUOTED_RE.test(stripped) ||
    DURATION_SIZE_RE.test(stripped) ||
    ISO_TS_RE.test(stripped) ||
    isFsPath(stripped)
  ) {
    return `<*>${suffix}`
  }
  return token
}

function templateKey(line: string): string {
  return line
    .trim()
    .split(/\s+/)
    .map(maskToken)
    .join(" ")
}

interface TemplateGroup {
  exemplar: string
  rawLines: string[]
}

/**
 * Single-pass Drain3-lite template mining: masks variable tokens per line to
 * build a template key, groups lines by that key (salient lines group by
 * exact raw text instead, so two different error messages sharing a template
 * both survive), and collapses any group of 3+ to its first exemplar plus a
 * `[×N]` count marker — matching the dedup marker style used by the omni and
 * log-text strategies. Returns the input unchanged if mining does not shorten
 * it.
 *
 * @sem domain=tool role=compressor
 */
export function mineTemplates(lines: string[]): string[] {
  const order: string[] = []
  const groups = new Map<string, TemplateGroup>()

  for (const line of lines) {
    const key = isSalientLine(line) ? `s:${line}` : `t:${templateKey(line)}`
    let group = groups.get(key)
    if (!group) {
      group = { exemplar: line, rawLines: [] }
      groups.set(key, group)
      order.push(key)
    }
    group.rawLines.push(line)
  }

  const out: string[] = []
  for (const key of order) {
    const group = groups.get(key)!
    if (group.rawLines.length >= DUP_THRESHOLD) {
      out.push(`${group.exemplar}  [×${group.rawLines.length}]`)
    } else {
      out.push(...group.rawLines)
    }
  }

  return out.length < lines.length ? out : lines
}
