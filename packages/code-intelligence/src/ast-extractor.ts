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
import { extname } from "node:path"

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
}

export interface ExtractedEdge {
  /** Importing / calling entity name (or empty string for file-level imports). */
  fromEntity: string
  /** Entity name being referenced. */
  toEntity: string
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

/**
 * Walk backward from entityLineIdx to find the nearest block comment above the
 * entity declaration and parse "@sem domain=<tag> role=<tag>" from it.
 *
 * @sem domain=intelligence role=utilities
 */
function extractDocComment(lines: string[], entityLineIdx: number): { semDomain?: string; semRole?: string } {
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
  for (let i = scanIdx; i <= blockEnd; i++) {
    const text = stripCommentLine((lines[i] ?? "").trim())
    if (text.startsWith("@sem")) {
      const domainM = /domain=(\S+)/.exec(text)
      const roleM = /role=(\S+)/.exec(text)
      if (domainM?.[1]) semDomain = domainM[1]
      if (roleM?.[1]) semRole = roleM[1]
    }
  }
  return { semDomain, semRole }
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

      const name = pat.kind === "method" && currentClass ? `${currentClass}.${rawName}` : rawName
      const signature = (pat.sigGroup != null ? m[pat.sigGroup] : "") ?? ""
      const lineStart = i + 1
      const lineEnd = findBlockEnd(lines, i, lang)
      const body = lines.slice(i, lineEnd).join("\n")
      const contentHash = createHash("sha256").update(body).digest("hex").slice(0, 16)

      const { semDomain, semRole } = extractDocComment(lines, i)
      entities.push({
        name,
        kind: pat.kind,
        signature: signature.trim(),
        lineStart,
        lineEnd,
        contentHash,
        parentClass: pat.kind === "method" ? (currentClass ?? undefined) : undefined,
        semDomain,
        semRole,
      })
      break
    }
  }

  return entities
}

// ---------------------------------------------------------------------------
// Edge extraction (import-level references)
// ---------------------------------------------------------------------------

/**
 * Extract import/call edges from source using regex. Captures ES import
 * named bindings and Python-style `from X import Y` as "import" edges.
 *
 * @sem domain=intelligence role=utilities
 */
export function extractEdges(content: string, _filePath: string): ExtractedEdge[] {
  const edges: ExtractedEdge[] = []

  // ES: import { A, B } from "..."
  const namedImport = /^import\s+\{([^}]+)\}\s+from\s+["'][^"']+["']/gm
  let m: RegExpExecArray | null
  while ((m = namedImport.exec(content)) !== null) {
    const names = (m[1] ?? "").split(",").map((s) => s.trim().split(/\s+as\s+/)[0]?.trim()).filter(Boolean)
    for (const n of names) {
      if (n) edges.push({ fromEntity: "", toEntity: n, kind: "import" })
    }
  }

  // ES: import DefaultName from "..."
  const defaultImport = /^import\s+(\w+)\s+from\s+["'][^"']+["']/gm
  while ((m = defaultImport.exec(content)) !== null) {
    const n = m[1]
    if (n) edges.push({ fromEntity: "", toEntity: n, kind: "import" })
  }

  // Python: from X import A, B
  const pyImport = /^from\s+\S+\s+import\s+(.+)$/gm
  while ((m = pyImport.exec(content)) !== null) {
    const names = (m[1] ?? "").split(",").map((s) => s.trim().split(/\s+as\s+/)[0]?.trim()).filter(Boolean)
    for (const n of names) {
      if (n) edges.push({ fromEntity: "", toEntity: n, kind: "import" })
    }
  }

  return edges
}
