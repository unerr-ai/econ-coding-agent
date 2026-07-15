/**
 * User filter DSL — reads repo-local `.econ/filters.toml` and global
 * `~/.config/econ/filters.toml`, first-matching-filter-wins, applied right before classify
 * (after redact + git-status fast path + cloud parser).
 * Directives: match_command, strip_lines_matching, keep_lines_matching, replace,
 * truncate_lines_at, max_lines, tail_lines, on_empty.
 * Ported from unerr-cli src/proxy/shell-strategies/filter-dsl.ts — ships its own minimal
 * TOML reader (no external dep) that understands only the directive subset above; missing
 * config files are a no-op (returns null, never throws).
 *
 * @sem domain=tool role=compressor
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface FilterReplace {
  pattern: string
  replacement: string
}

export interface UserFilter {
  name: string
  match_command: string
  strip_lines_matching?: string[]
  keep_lines_matching?: string[]
  replace?: FilterReplace[]
  truncate_lines_at?: number
  max_lines?: number
  tail_lines?: number
  on_empty?: string
}

interface CompiledFilter {
  raw: UserFilter
  matchCommand: RegExp
  strip?: RegExp[]
  keep?: RegExp[]
  replace?: { pattern: RegExp; replacement: string }[]
}

let cachedFilters: CompiledFilter[] | null = null
let cacheKey = ""

function readFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}

// ─── Minimal TOML reader for our directive subset ──────────────────────────

function unquote(input: string): string {
  const s = input.trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\")
  }
  return s
}

function parseScalar(v: string): unknown {
  const t = v.trim()
  if (t === "true") return true
  if (t === "false") return false
  if (/^-?\d+$/.test(t)) return Number.parseInt(t, 10)
  if (/^-?\d+\.\d+$/.test(t)) return Number.parseFloat(t)
  return unquote(t)
}

function parseArrayLiteral(v: string): unknown[] | null {
  const trimmed = v.trim()
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null
  const inner = trimmed.slice(1, -1).trim()
  if (!inner) return []

  // Array of inline tables: [{ pattern = "x", replacement = "y" }, ...]
  if (inner.includes("{")) {
    const tables: Record<string, unknown>[] = []
    let depth = 0
    let start = -1
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i]
      if (ch === "{") {
        if (depth === 0) start = i + 1
        depth++
      } else if (ch === "}") {
        depth--
        if (depth === 0 && start >= 0) {
          const body = inner.slice(start, i)
          const obj: Record<string, unknown> = {}
          for (const pair of body.split(",")) {
            const eq = pair.indexOf("=")
            if (eq < 0) continue
            const k = pair.slice(0, eq).trim()
            const val = pair.slice(eq + 1).trim()
            obj[k] = parseScalar(val)
          }
          tables.push(obj)
        }
      }
    }
    return tables
  }

  // Simple string/number array
  return inner
    .split(/,\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseScalar)
}

interface RawSection {
  name: string
  values: Record<string, unknown>
}

function parseToml(src: string): RawSection[] {
  const sections: RawSection[] = []
  let current: RawSection | null = null
  // Join continuation lines for arrays that span multiple lines
  const compactLines: string[] = []
  let buf = ""
  let depth = 0
  for (const rawLine of src.split("\n")) {
    const line = rawLine.replace(/#.*$/, "")
    if (depth > 0) {
      buf += ` ${line.trim()}`
    } else if (line.includes("[") && !line.match(/^\s*\[[^=]*\]\s*$/)) {
      // Likely the start of an inline-table array or multi-line array
      buf = line
    } else {
      compactLines.push(line)
      continue
    }
    for (const ch of line) {
      if (ch === "[") depth++
      else if (ch === "]") depth--
    }
    if (depth <= 0) {
      compactLines.push(buf)
      buf = ""
      depth = 0
    }
  }
  if (buf) compactLines.push(buf)

  for (const rawLine of compactLines) {
    const line = rawLine.trim()
    if (!line) continue
    const sectionMatch = line.match(/^\[([^\]]+)\]\s*$/)
    if (sectionMatch?.[1]) {
      if (current) sections.push(current)
      current = { name: sectionMatch[1], values: {} }
      continue
    }
    if (!current) continue
    const eq = line.indexOf("=")
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const rest = line.slice(eq + 1).trim()
    const arr = parseArrayLiteral(rest)
    current.values[key] = arr ?? parseScalar(rest)
  }
  if (current) sections.push(current)
  return sections
}

// ─── Loading + compilation ─────────────────────────────────────────────────

function compileOne(name: string, raw: Record<string, unknown>): CompiledFilter | null {
  const mc = raw.match_command
  if (typeof mc !== "string" || !mc) return null

  let matchCommand: RegExp
  try {
    matchCommand = new RegExp(mc)
  } catch {
    return null
  }

  const toRegexes = (arr: unknown): RegExp[] | undefined => {
    if (!Array.isArray(arr)) return undefined
    const out: RegExp[] = []
    for (const s of arr) {
      if (typeof s !== "string") continue
      try {
        out.push(new RegExp(s))
      } catch {
        // skip bad regex
      }
    }
    return out.length > 0 ? out : undefined
  }

  const toReplace = (arr: unknown): { pattern: RegExp; replacement: string }[] | undefined => {
    if (!Array.isArray(arr)) return undefined
    const out: { pattern: RegExp; replacement: string }[] = []
    for (const item of arr) {
      if (item && typeof item === "object" && typeof (item as Record<string, unknown>).pattern === "string") {
        const p = (item as Record<string, unknown>).pattern as string
        const r = (item as Record<string, unknown>).replacement as string | undefined
        try {
          out.push({ pattern: new RegExp(p, "g"), replacement: r ?? "" })
        } catch {
          // skip
        }
      }
    }
    return out.length > 0 ? out : undefined
  }

  const f: UserFilter = {
    name,
    match_command: mc,
    strip_lines_matching: Array.isArray(raw.strip_lines_matching)
      ? (raw.strip_lines_matching.filter((x) => typeof x === "string") as string[])
      : undefined,
    keep_lines_matching: Array.isArray(raw.keep_lines_matching)
      ? (raw.keep_lines_matching.filter((x) => typeof x === "string") as string[])
      : undefined,
    replace: Array.isArray(raw.replace) ? (raw.replace as FilterReplace[]) : undefined,
    truncate_lines_at: typeof raw.truncate_lines_at === "number" ? raw.truncate_lines_at : undefined,
    max_lines: typeof raw.max_lines === "number" ? raw.max_lines : undefined,
    tail_lines: typeof raw.tail_lines === "number" ? raw.tail_lines : undefined,
    on_empty: typeof raw.on_empty === "string" ? raw.on_empty : undefined,
  }

  return {
    raw: f,
    matchCommand,
    strip: toRegexes(raw.strip_lines_matching),
    keep: toRegexes(raw.keep_lines_matching),
    replace: toReplace(raw.replace),
  }
}

function loadFilters(cwd: string): CompiledFilter[] {
  const repoPath = join(cwd, ".econ", "filters.toml")
  const userPath = join(homedir(), ".config", "econ", "filters.toml")
  const key = `${repoPath}|${userPath}`
  if (cachedFilters && cacheKey === key) return cachedFilters

  const sources = [readFile(repoPath), readFile(userPath)].filter((s): s is string => Boolean(s))
  const compiled: CompiledFilter[] = []
  for (const src of sources) {
    const sections = parseToml(src)
    for (const section of sections) {
      if (!section.name.startsWith("filters.")) continue
      const name = section.name.slice("filters.".length)
      const c = compileOne(name, section.values)
      if (c) compiled.push(c)
    }
  }
  cachedFilters = compiled
  cacheKey = key
  return compiled
}

/**
 * Apply the first matching user filter to the output. Returns null if no filter matches or
 * neither config file exists — caller falls through to the built-in git-status/cloud/classify
 * path. Never throws.
 *
 * @sem domain=tool role=compressor
 */
export function applyUserFilter(command: string, stdout: string, cwd: string): { text: string; name: string } | null {
  const filters = loadFilters(cwd)
  if (filters.length === 0) return null
  const filter = filters.find((f) => f.matchCommand.test(command))
  if (!filter) return null

  let text = stdout

  if (filter.replace) {
    for (const r of filter.replace) text = text.replace(r.pattern, r.replacement)
  }

  let lines = text.split("\n")
  if (filter.strip) {
    lines = lines.filter((l) => !filter.strip?.some((r) => r.test(l)))
  }
  if (filter.keep) {
    lines = lines.filter((l) => filter.keep?.some((r) => r.test(l)))
  }

  if (filter.raw.truncate_lines_at) {
    const limit = filter.raw.truncate_lines_at
    lines = lines.map((l) => (l.length > limit ? `${l.slice(0, limit)}…` : l))
  }

  if (filter.raw.tail_lines && lines.length > filter.raw.tail_lines) {
    lines = [
      `… (${lines.length - filter.raw.tail_lines} earlier lines suppressed)`,
      ...lines.slice(-filter.raw.tail_lines),
    ]
  } else if (filter.raw.max_lines && lines.length > filter.raw.max_lines) {
    lines = [
      ...lines.slice(0, filter.raw.max_lines),
      `… (${lines.length - filter.raw.max_lines} more lines suppressed)`,
    ]
  }

  text = lines.join("\n").trim()
  if (!text && filter.raw.on_empty) {
    text = filter.raw.on_empty
  }

  return { text, name: filter.raw.name }
}

/** Test helper — flush cache so repeated calls in tests pick up new files. */
export function _clearFilterCache(): void {
  cachedFilters = null
  cacheKey = ""
}
