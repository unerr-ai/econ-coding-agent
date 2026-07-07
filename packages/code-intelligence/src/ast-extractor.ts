/**
 * Language-agnostic entity and edge extractor using regex patterns as the
 * primary path, with an optional WASM tree-sitter upgrade when grammars are
 * available. No native addons — safe under `bun build --compile`.
 *
 * Ported from unerr-cli src/intelligence/ast-extractor.ts (regex subset).
 *
 * @sem domain=intelligence role=utilities
 */

import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { dirname, extname, join, resolve } from "node:path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractedEntity {
  name: string
  kind: string
  signature: string
  lineStart: number
  lineEnd: number
  contentHash: string
  parentClass?: string
  /** Semantic domain tag from a `@sem domain=<tag>` line in the preceding doc comment. */
  semDomain?: string
  /** Semantic role tag from a `@sem role=<tag>` line in the preceding doc comment. */
  semRole?: string
  /** Normalized prose summary from the preceding doc comment (what + why); undefined when empty or a name-echo. */
  summary?: string
}

export interface ExtractedEdge {
  /** Importing / calling entity name (or empty string for file-level imports). */
  fromEntity: string
  /** Entity name being referenced. */
  toEntity: string
  /** Resolved absolute path of the referenced file, or null when unresolved
   *  (external package, or a language extractEdges doesn't attempt to resolve). */
  toFile: string | null
  /** Edge kind: "import" | "call" | "extends" */
  kind: string
}

export type Language =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "java"
  | "rust"
  | "c"
  | "cpp"
  | "csharp"
  | "ruby"
  | "php"
  | "kotlin"
  | "swift"

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

const EXTENSION_MAP: Record<string, Language> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".java": "java",
  ".rs": "rust",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".rb": "ruby",
  ".rake": "ruby",
  ".php": "php",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
}

/** Detect language from file extension. Returns null for unsupported files. */
export function detectLanguage(filePath: string): Language | null {
  const ext = extname(filePath).toLowerCase()
  return EXTENSION_MAP[ext] ?? null
}

// ---------------------------------------------------------------------------
// Regex pattern definitions (ported from unerr-cli)
// ---------------------------------------------------------------------------

const CONTROL_FLOW = new Set(["if", "else", "switch", "for", "while", "do", "catch", "return", "with"])

interface PatternDef {
  regex: RegExp
  kind: string
  nameGroup: number
  sigGroup?: number
  /** Dotted receiver of an assignment-style definition (`res.send = function`) — names the parent, not the entity. */
  receiverGroup?: number
}

function getPatterns(lang: Language): PatternDef[] {
  switch (lang) {
    case "typescript":
    case "javascript":
      return [
        {
          regex: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(\([^)]*\))/,
          kind: "function",
          nameGroup: 1,
          sigGroup: 2,
        },
        { regex: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/, kind: "class", nameGroup: 1 },
        { regex: /^(?:export\s+)?interface\s+(\w+)/, kind: "interface", nameGroup: 1 },
        {
          regex: /^\s+(?:(?:private|protected|public|override|abstract|readonly)\s+)*(?:async\s+)?(?:static\s+)?(?:get\s+|set\s+)?(\w+)\s*(\((?:[^()]|\([^()]*\))*\))\s*(?::\s*[^{;]+)?[{]/,
          kind: "method",
          nameGroup: 1,
          sigGroup: 2,
        },
        {
          regex: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>)/,
          kind: "function",
          nameGroup: 1,
        },
        {
          // Classic-idiom assignment definitions at module scope:
          // `res.send = function send(body) {`, `Foo.prototype.bar = function () {`,
          // `exports.parse = async (req) => …`, `module.exports = function () {`.
          // Express/lodash-era code defines most of its public surface this way —
          // without this net the coupling probe starves (express: 55 entities
          // repo-wide, 2 in lib/response.js).
          regex:
            /^(\w+(?:\.\w+)*)\.(\w+)\s*=\s*(?:async\s+)?(?:function\b(?:\s+\w+)?\s*(\((?:[^()]|\([^()]*\))*\))|(?:\((?:[^()]|\([^()]*\))*\)|\w+)\s*=>)/,
          kind: "method",
          nameGroup: 2,
          sigGroup: 3,
          receiverGroup: 1,
        },
      ]
    case "python":
      return [
        { regex: /^(?:\s*)(?:async\s+)?def\s+(\w+)\s*(\([^)]*\))/, kind: "function", nameGroup: 1, sigGroup: 2 },
        { regex: /^class\s+(\w+)/, kind: "class", nameGroup: 1 },
      ]
    case "go":
      return [
        { regex: /^func\s+(\w+)\s*(\([^)]*\))/, kind: "function", nameGroup: 1, sigGroup: 2 },
        { regex: /^func\s+\([^)]+\)\s+(\w+)\s*(\([^)]*\))/, kind: "method", nameGroup: 1, sigGroup: 2 },
        { regex: /^type\s+(\w+)\s+struct/, kind: "class", nameGroup: 1 },
        { regex: /^type\s+(\w+)\s+interface/, kind: "interface", nameGroup: 1 },
      ]
    case "java":
      return [
        {
          regex: /^\s*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:abstract\s+)?class\s+(\w+)/,
          kind: "class",
          nameGroup: 1,
        },
        {
          regex: /^\s*(?:public\s+|private\s+|protected\s+)?interface\s+(\w+)/,
          kind: "interface",
          nameGroup: 1,
        },
        {
          regex: /^\s*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:\w+(?:<[^>]+>)?)\s+(\w+)\s*(\([^)]*\))/,
          kind: "method",
          nameGroup: 1,
          sigGroup: 2,
        },
      ]
    case "rust":
      return [
        { regex: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*(\([^)]*\))/, kind: "function", nameGroup: 1, sigGroup: 2 },
        { regex: /^\s*(?:pub\s+)?struct\s+(\w+)/, kind: "class", nameGroup: 1 },
        { regex: /^\s*(?:pub\s+)?trait\s+(\w+)/, kind: "interface", nameGroup: 1 },
      ]
    default:
      return []
  }
}

// ---------------------------------------------------------------------------
// Block-end finder (brace matching, Python indentation)
// ---------------------------------------------------------------------------

function findBlockEnd(lines: string[], startIdx: number, lang: Language): number {
  if (lang === "python") {
    const startIndent = (lines[startIdx] ?? "").match(/^(\s*)/)?.[1]?.length ?? 0
    for (let i = startIdx + 1; i < lines.length; i++) {
      const l = lines[i] ?? ""
      if (l.trim() === "") continue
      const ind = l.match(/^(\s*)/)?.[1]?.length ?? 0
      if (ind <= startIndent) return i
    }
    return lines.length
  }
  // Brace matching for all other languages
  let depth = 0
  let opened = false
  for (let i = startIdx; i < lines.length; i++) {
    const l = lines[i] ?? ""
    for (const ch of l) {
      if (ch === "{") { depth++; opened = true }
      else if (ch === "}") { depth-- }
    }
    if (opened && depth <= 0) return i + 1
  }
  return Math.min(startIdx + 30, lines.length)
}

// ---------------------------------------------------------------------------
// Multi-line signature collapse
// ---------------------------------------------------------------------------

function buildLogicalLine(lines: string[], startIdx: number, maxJoin = 16): string {
  // A blank starting line can never itself begin a declaration — return it
  // as-is rather than joining forward into the next statement (otherwise a
  // method preceded by a blank line gets matched twice: once from the blank
  // line joined into it, once from its own declaration line).
  const startRaw = lines[startIdx] ?? ""
  if (startRaw.trim() === "") return startRaw

  let depth = 0
  let result = ""
  for (let j = startIdx; j < lines.length && j - startIdx <= maxJoin; j++) {
    const raw = lines[j] ?? ""
    result += j === startIdx ? raw : ` ${raw.trim()}`
    for (let k = 0; k < raw.length; k++) {
      const ch = raw.charCodeAt(k)
      if (ch === 40) depth++        // (
      else if (ch === 41) depth--   // )
      else if ((ch === 123 || ch === 59) && depth <= 0) return result  // { ;
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Doc-comment / @sem parser
// ---------------------------------------------------------------------------

/**
 * Strip comment markers from a single trimmed line inside a block comment.
 * Handles the opening slash-star-star, the closing star-slash, and interior star lines.
 */
function stripCommentLine(rawTrimmed: string): string {
  if (rawTrimmed.startsWith("/**")) {
    let t = rawTrimmed.slice(3).trimStart()
    if (t.endsWith("*/")) t = t.slice(0, -2).trimEnd()
    return t
  }
  if (rawTrimmed.endsWith("*/")) {
    let t = rawTrimmed.slice(0, -2).trimEnd()
    if (t.startsWith("*")) t = t.slice(1).trimStart()
    return t
  }
  if (rawTrimmed.startsWith("* ")) return rawTrimmed.slice(2)
  if (rawTrimmed === "*") return ""
  return rawTrimmed
}

/** Split an identifier on camelCase boundaries and separators, lowercased, for name-echo comparison. */
function splitNameWords(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .toLowerCase()
    .trim()
}

/**
 * True when prose is empty, or a trivial restatement of entityName — case/
 * whitespace-insensitive equality with the raw name or its camelCase-split
 * form. Mirrors (cheaply) unerr's parse-time name-echo rejection.
 */
function isNameEcho(prose: string, entityName: string): boolean {
  const p = prose.trim().toLowerCase().replace(/[.!]+$/, "")
  if (!p) return true
  if (p === entityName.trim().toLowerCase()) return true
  if (p === splitNameWords(entityName)) return true
  return false
}

/** Collapse prose lines to a single normalized summary, or undefined when empty/name-echo. */
function normalizeSummary(proseLines: string[], entityName: string): string | undefined {
  const joined = proseLines.join(" ").replace(/\s+/g, " ").trim()
  if (!joined || isNameEcho(joined, entityName)) return undefined
  return joined.length > 300 ? joined.slice(0, 300).trim() : joined
}

/**
 * Walk backward from entityLineIdx to find the nearest block comment above the
 * entity declaration; parse "@sem domain=<tag> role=<tag>" from it and collapse
 * the remaining prose lines (comment markers stripped, whitespace collapsed,
 * capped ~300 chars) into a summary — undefined when empty or a name-echo of
 * entityName.
 *
 * @sem domain=intelligence role=utilities
 */
function extractDocComment(
  lines: string[],
  entityLineIdx: number,
  entityName: string
): { semDomain?: string; semRole?: string; summary?: string } {
  let scanIdx = entityLineIdx - 1
  // Skip blank lines between comment and declaration
  while (scanIdx >= 0 && (lines[scanIdx] ?? "").trim() === "") scanIdx--
  if (scanIdx < 0) return {}

  const endTrimmed = (lines[scanIdx] ?? "").trim()
  // Must end with */ to be a block comment close (or be a single-line /** ... */)
  if (!endTrimmed.endsWith("*/")) return {}
  const blockEnd = scanIdx

  // Walk back to the /** opening
  while (scanIdx >= 0 && !(lines[scanIdx] ?? "").trim().startsWith("/**")) scanIdx--
  if (scanIdx < 0) return {}

  // Extract and strip content lines
  let semDomain: string | undefined
  let semRole: string | undefined
  const proseLines: string[] = []
  for (let i = scanIdx; i <= blockEnd; i++) {
    const text = stripCommentLine((lines[i] ?? "").trim())
    if (text.startsWith("@sem")) {
      const domainM = /domain=(\S+)/.exec(text)
      const roleM = /role=(\S+)/.exec(text)
      if (domainM?.[1]) semDomain = domainM[1]
      if (roleM?.[1]) semRole = roleM[1]
      continue
    }
    if (text.startsWith("@")) continue // other jsdoc tags aren't prose
    if (text) proseLines.push(text)
  }
  return { semDomain, semRole, summary: normalizeSummary(proseLines, entityName) }
}

// ---------------------------------------------------------------------------
// Entity extraction
// ---------------------------------------------------------------------------

/**
 * Extract entities from source using regex patterns. Returns [] for
 * unsupported languages — never throws.
 *
 * @sem domain=intelligence role=utilities
 */
export function extractEntities(content: string, filePath: string): ExtractedEntity[] {
  const lang = detectLanguage(filePath)
  if (!lang) return []

  const lines = content.split("\n")
  const entities: ExtractedEntity[] = []
  const patterns = getPatterns(lang)
  let currentClass: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const matchLine = buildLogicalLine(lines, i)

    for (const pat of patterns) {
      const m = pat.regex.exec(matchLine)
      if (!m) continue
      const rawName = m[pat.nameGroup] ?? ""
      if (!rawName) continue
      if (pat.kind === "method" && CONTROL_FLOW.has(rawName)) continue

      if (pat.kind === "class") currentClass = rawName

      let name = pat.kind === "method" && currentClass ? `${currentClass}.${rawName}` : rawName
      let parentClass = pat.kind === "method" ? (currentClass ?? undefined) : undefined
      if (pat.receiverGroup != null) {
        // Assignment-style definition: the dotted receiver is the parent, not
        // the enclosing class. `X.prototype` collapses to `X`; the CommonJS
        // export receivers and `this` are wrappers, not parents.
        const receiver = (m[pat.receiverGroup] ?? "").replace(/\.prototype$/, "")
        if (receiver === "exports" || receiver === "module.exports") {
          name = rawName
          parentClass = undefined
        } else if (receiver === "this") {
          name = currentClass ? `${currentClass}.${rawName}` : rawName
          parentClass = currentClass ?? undefined
        } else {
          name = `${receiver}.${rawName}`
          parentClass = receiver
        }
      }
      const signature = (pat.sigGroup != null ? m[pat.sigGroup] : "") ?? ""
      const lineStart = i + 1
      const lineEnd = findBlockEnd(lines, i, lang)
      const body = lines.slice(i, lineEnd).join("\n")
      const contentHash = createHash("sha256").update(body).digest("hex").slice(0, 16)

      const { semDomain, semRole, summary } = extractDocComment(lines, i, rawName)
      entities.push({
        name,
        kind: pat.kind,
        signature: signature.trim(),
        lineStart,
        lineEnd,
        contentHash,
        parentClass,
        semDomain,
        semRole,
        summary,
      })
      break
    }
  }

  return entities
}

// ---------------------------------------------------------------------------
// Import specifier resolution
// ---------------------------------------------------------------------------

const RESOLVABLE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"]

/**
 * Resolve a relative import specifier ("./foo", "../bar.js") against the
 * absolute path of the importing file. Strips any extension the specifier
 * already carries (a NodeNext ".js" specifier still matches a ".ts" source
 * file), then probes each candidate extension and an `/index.*` variant
 * against the filesystem. Returns null for non-relative specifiers or when
 * nothing on disk matches (external package, or a genuinely missing file).
 */
function resolveRelativeImport(specifier: string, fromFile: string): string | null {
  if (!specifier.startsWith(".")) return null
  const dir = dirname(fromFile)
  const withoutExt = specifier.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "")
  const base = resolve(dir, withoutExt)

  for (const ext of RESOLVABLE_EXTENSIONS) {
    if (existsSync(base + ext)) return base + ext
  }
  for (const ext of RESOLVABLE_EXTENSIONS) {
    const candidate = join(base, `index${ext}`)
    if (existsSync(candidate)) return candidate
  }
  return null
}

// ---------------------------------------------------------------------------
// Call-site keyword filter and enclosing-entity lookup
// ---------------------------------------------------------------------------

/** Language keywords/control-flow that can precede "(" but are never a call target. */
const CALL_SITE_KEYWORDS = new Set([
  ...CONTROL_FLOW,
  "function", "typeof", "instanceof", "new", "delete", "void", "in", "of",
  "yield", "await", "try", "finally", "throw", "case", "class", "extends",
  "super", "this", "constructor", "async", "static", "get", "set", "import",
  "export", "from", "as", "let", "const", "var", "true", "false", "null",
  "undefined", "public", "private", "protected", "readonly", "abstract",
  "interface", "enum", "namespace", "declare", "type", "implements",
  "def", "elif", "except", "lambda", "pass", "raise", "assert", "global",
  "nonlocal", "and", "or", "not", "is", "None", "True", "False",
  "func", "package", "go", "chan", "select", "defer", "struct", "map",
  "range", "fallthrough", "goto",
  "fn", "pub", "impl", "trait", "mod", "use", "match", "loop", "unsafe",
  "throws", "synchronized", "final", "override",
])

/** Narrowest entity whose [lineStart, lineEnd] contains lineNo, or null. */
function findEnclosingEntity(lineNo: number, entities: ExtractedEntity[]): ExtractedEntity | null {
  let best: ExtractedEntity | null = null
  let bestSpan = Number.POSITIVE_INFINITY
  for (const e of entities) {
    if (lineNo >= e.lineStart && lineNo <= e.lineEnd) {
      const span = e.lineEnd - e.lineStart
      if (span < bestSpan) {
        bestSpan = span
        best = e
      }
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Edge extraction (import + call references)
// ---------------------------------------------------------------------------

/**
 * Extract import and call edges from source using regex. Import edges parse
 * ES named/default/namespace bindings and Python-style `from X import Y`,
 * resolving relative ES specifiers to an absolute `toFile` (null for
 * external/unresolved). Call edges scan each entity's body for bare
 * `identifier(` call sites and for `X.fn(` property calls whose receiver `X`
 * resolves to a same-file namespace or default import binding — excluding
 * other member access (`obj.foo(` where `obj` isn't an import) and language
 * keywords — and resolve the callee name against same-file entities or this
 * file's own import bindings; only resolved calls are kept (edge_kind
 * "call"), attributed to their enclosing entity via line ranges.
 *
 * @sem domain=intelligence role=utilities
 */
export function extractEdges(
  content: string,
  filePath: string,
  entities: ExtractedEntity[] = []
): ExtractedEdge[] {
  const edges: ExtractedEdge[] = []
  const importNameToFile = new Map<string, string | null>()

  // ES: import { A, B } from "..."
  const namedImport = /^import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["']([^"']+)["']/gm
  let m: RegExpExecArray | null
  while ((m = namedImport.exec(content)) !== null) {
    const names = (m[1] ?? "").split(",").map((s) => s.trim().split(/\s+as\s+/)[0]?.trim()).filter(Boolean)
    const toFile = resolveRelativeImport(m[2] ?? "", filePath)
    for (const n of names) {
      if (!n) continue
      edges.push({ fromEntity: "", toEntity: n, toFile, kind: "import" })
      importNameToFile.set(n, toFile)
    }
  }

  // ES: import DefaultName from "..." — also usable below as a
  // namespace-like property-call receiver (CommonJS default-as-namespace
  // interop, e.g. `import util from "./util"; util.merge(...)`).
  const defaultImport = /^import\s+(\w+)\s+from\s+["']([^"']+)["']/gm
  while ((m = defaultImport.exec(content)) !== null) {
    const n = m[1]
    const toFile = resolveRelativeImport(m[2] ?? "", filePath)
    if (n) {
      edges.push({ fromEntity: "", toEntity: n, toFile, kind: "import" })
      importNameToFile.set(n, toFile)
    }
  }

  // ES: import * as X from "..." — X is a namespace-import binding; a
  // property call off it (X.fn(...)) is resolved below through the same
  // importNameToFile map bare-call resolution already uses.
  const namespaceImport = /^import\s+\*\s+as\s+(\w+)\s+from\s+["']([^"']+)["']/gm
  while ((m = namespaceImport.exec(content)) !== null) {
    const n = m[1]
    const toFile = resolveRelativeImport(m[2] ?? "", filePath)
    if (n) importNameToFile.set(n, toFile)
  }

  // Python: from X import A, B (path resolution not attempted — dotted modules)
  const pyImport = /^from\s+\S+\s+import\s+(.+)$/gm
  while ((m = pyImport.exec(content)) !== null) {
    const names = (m[1] ?? "").split(",").map((s) => s.trim().split(/\s+as\s+/)[0]?.trim()).filter(Boolean)
    for (const n of names) {
      if (n) edges.push({ fromEntity: "", toEntity: n, toFile: null, kind: "import" })
    }
  }

  // Call edges: scan each line once, attribute to its narrowest enclosing
  // entity, and resolve candidates against same-file entities or this
  // file's own imports. Unresolved candidates are dropped.
  if (entities.length > 0) {
    const sameFileTarget = new Map<string, string>()
    for (const e of entities) {
      sameFileTarget.set(e.name, e.name)
      const lastSeg = e.name.includes(".") ? e.name.slice(e.name.lastIndexOf(".") + 1) : e.name
      if (!sameFileTarget.has(lastSeg)) sameFileTarget.set(lastSeg, e.name)
    }

    const callSitePattern = /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g
    // Property calls `X.fn(` — callSitePattern's negative lookbehind already
    // excludes any identifier preceded by ".", so this is a separate pass.
    // Only fires when the receiver X is a known namespace/default import
    // binding (checked against importNameToFile below); a plain local
    // variable or class-instance receiver (obj.method()) never matches, by
    // construction — no general member-call resolution is attempted.
    const propertyCallPattern = /(?<![.\w$])([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g
    const addedCallEdges = new Set<string>()
    const lines = content.split("\n")

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ""
      callSitePattern.lastIndex = 0
      const hasBareCall = callSitePattern.test(line)
      propertyCallPattern.lastIndex = 0
      const hasPropertyCall = propertyCallPattern.test(line)
      if (!hasBareCall && !hasPropertyCall) continue
      const enclosing = findEnclosingEntity(i + 1, entities)
      if (!enclosing) continue

      if (hasBareCall) {
        callSitePattern.lastIndex = 0
        let cm: RegExpExecArray | null
        while ((cm = callSitePattern.exec(line)) !== null) {
          const candidate = cm[1]
          if (!candidate || CALL_SITE_KEYWORDS.has(candidate)) continue

          const sameFile = sameFileTarget.get(candidate)
          if (sameFile && sameFile !== enclosing.name) {
            const dedupeKey = `${enclosing.name}->${sameFile}`
            if (!addedCallEdges.has(dedupeKey)) {
              addedCallEdges.add(dedupeKey)
              edges.push({ fromEntity: enclosing.name, toEntity: sameFile, toFile: filePath, kind: "call" })
            }
            continue
          }

          if (importNameToFile.has(candidate)) {
            const toFile = importNameToFile.get(candidate) ?? null
            if (toFile) {
              const dedupeKey = `${enclosing.name}->${candidate}`
              if (!addedCallEdges.has(dedupeKey)) {
                addedCallEdges.add(dedupeKey)
                edges.push({ fromEntity: enclosing.name, toEntity: candidate, toFile, kind: "call" })
              }
            }
          }
        }
      }

      if (hasPropertyCall) {
        propertyCallPattern.lastIndex = 0
        let pm: RegExpExecArray | null
        while ((pm = propertyCallPattern.exec(line)) !== null) {
          const receiver = pm[1]
          const member = pm[2]
          if (!receiver || !member) continue
          if (CALL_SITE_KEYWORDS.has(receiver) || CALL_SITE_KEYWORDS.has(member)) continue

          const toFile = importNameToFile.get(receiver) ?? null
          if (!toFile) continue

          const dedupeKey = `${enclosing.name}->${member}@${toFile}`
          if (addedCallEdges.has(dedupeKey)) continue
          addedCallEdges.add(dedupeKey)
          edges.push({ fromEntity: enclosing.name, toEntity: member, toFile, kind: "call" })
        }
      }
    }
  }

  return edges
}
