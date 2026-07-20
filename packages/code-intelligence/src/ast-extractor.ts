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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { basename, dirname, extname, join, resolve } from "node:path"

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
  /** True when this edge is CONFIRMED external at extraction time (never a
   *  same-repo file) — e.g. C/C++'s angle `#include <...>`. Lets the graph
   *  layer record it resolved-external immediately instead of leaving it
   *  for the G2 suffix fallback to (mis)guess at. */
  external?: boolean
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
// Import extraction + resolution — generic kernel (wave G: G1 kernel data
// row + resolver, G1a extraction rows). One algorithm parameterized by a
// per-language data row (agnostic-hands-eyes.md §5.1 generic-first law)
// replaces what were two near-identical hand-written resolvers (JS relative
// probing, Python dot-hop/source-root walking) — they were the same
// algorithm with different constants. Adding a language's resolution or
// extraction coverage is a new table row, never new control flow here.
// ---------------------------------------------------------------------------

/** How a language's relative-import marker is parsed, once a specifier is
 *  already known to start with "." (both styles gate on that same leading-
 *  dot test — it's what happens next that differs). "dot-hop" (Python):
 *  repeated leading dots ARE the hop count and double as the module
 *  separator, so they must be peeled off before the remainder is split on
 *  `separator`. "path-prefix" (JS/TS): no peeling — the whole specifier
 *  (any ".."/"." segments included) is split on `separator` and handed to
 *  `resolve()`, which already interprets those segments natively. */
type RelativeStyle =
  | "dot-hop"
  | "path-prefix"
  /** Matches unconditionally — no leading marker to peel off (C/C++'s
   *  quoted `#include`, always relative to the including file first). */
  | "implicit"
  /** Literal-token marker set (Rust's `crate::`/`self::`/`super::`) — see
   *  `RelativeMarker`. Data-parameterized so a keyword-prefixed relative
   *  grammar never needs its own resolver branch. */
  | { kind: "markers"; markers: RelativeMarker[] }

/** One literal-token relative marker for the `{ kind: "markers" }` relative
 *  style. */
interface RelativeMarker {
  /** Literal prefix this marker matches at the START of a specifier. */
  token: string
  /** Directories to hop up from `dirname(fromFile)` for ONE match of this
   *  marker — ignored when `rootStrategies` is set. */
  upHops: number
  /** True when consecutive matches of the SAME marker each add another hop
   *  (Rust's `super::super::`, mirrors python's ".." dot-hop repetition). */
  repeatable?: boolean
  /** When set, this marker's root isn't a `dirname(fromFile)` hop at all —
   *  it's derived via these strategies instead (Rust's `crate::` → crate
   *  source root). `upHops`/`repeatable` are ignored when this is set. */
  rootStrategies?: RootStrategy[]
}

/** Ordered strategies for deriving a root to resolve a NON-relative
 *  specifier against. Python supplies `sourceRootWalk`/`repoRoot`; JS/TS
 *  never does, so a bare specifier (an npm package) stays unresolved by
 *  construction — no strategies to try. */
type RootStrategy =
  | { kind: "sourceRootWalk"; markerFile: string }
  | { kind: "repoRoot"; subdir?: string }
  /** Walk up from `dirname(fromFile)`, inclusive, until an ancestor
   *  directory's OWN basename equals `name` — that directory IS the root
   *  (Rust: nearest `src/`). No push if never found, so an ordered
   *  strategies list falls through to the next entry. */
  | { kind: "nearestDirNamed"; name: string }
  /** Walk up from `dirname(fromFile)`, inclusive, until an ancestor
   *  directory CONTAINS `markerFile` — that directory (or its `subdir`) is
   *  the root (Rust: crate root via `Cargo.toml`). Opposite direction from
   *  `sourceRootWalk`, which climbs WHILE the marker is present; this one
   *  stops AT the first ancestor that HAS it. */
  | { kind: "nearestAncestorWithMarker"; markerFile: string; subdir?: string }
  /** Read `manifestFile` (nearest ancestor of `fromFile`, or `repoRoot`),
   *  capture a module-path prefix via `capturePattern` (first capture
   *  group), and resolve a specifier only when it starts with that prefix —
   *  the remainder becomes a subpath under the manifest's directory. Go's
   *  `go.mod` "module" line is the first user; the mechanism is generic
   *  (any manifest-declared root-path language could reuse it). Handled
   *  specially by `resolveGenericImport`'s absolute-strategy loop, not by
   *  `deriveRoots` — it needs the specifier itself, not just a root. */
  | { kind: "manifestPrefix"; manifestFile: string; capturePattern: RegExp }

/** One import-syntax shape for a language (G1a). `regex` matches one
 *  statement (global, multiline); its first capture group is the specifier
 *  — UNLESS `specifierPattern` is set, in which case that capture group is a
 *  multi-specifier BLOCK (Go's factored `import ( ... )`) re-scanned with
 *  `specifierPattern` for each individual specifier inside it. */
interface ImportExtractPattern {
  regex: RegExp
  specifierPattern?: RegExp
  /** True when the specifier can be a same-repo relative path
   *  (`#include "x.h"`) vs external-only (`#include <x.h>`, a bare package
   *  name) — gates whether `resolveGenericImport`'s relative-style branch
   *  is even reachable for this pattern's captures (informational only for
   *  languages whose row has no `relative` style at all). */
  relativeCapable: boolean
  /** False marks every specifier this pattern captures as CONFIRMED
   *  external at extraction time — never attempted by row resolution NOR
   *  the G2 suffix fallback (C/C++ angle `#include <...>`: a standard/
   *  system header, never a same-repo file; encoding this as data instead
   *  of a suffix-fallback guess kills the `<string>`/`<array>` false-match
   *  class structurally). Defaults to true (attempt resolution normally). */
  fallbackEligible?: boolean
}

/** One row per language: constants only, no behavior. */
interface LanguageImportRow {
  /** Joins a specifier's segments once any relative marker is peeled off. */
  separator: string
  /** Relative-import grammar, or null when this row has no relative-import
   *  grammar at all. */
  relative: RelativeStyle | null
  /** Extensions stripped from a relative specifier before resolving (a
   *  NodeNext ".js" specifier still matches a ".ts" source file). */
  stripExtensions?: string[]
  /** Ordered candidate file templates probed against a resolved base path;
   *  "<base>" and "<ext>" placeholders are substituted. */
  moduleFileTemplates: string[]
  /** Extensions substituted into "<ext>"; a language with one fixed
   *  extension (Python) supplies [""] and bakes it into the template. */
  extensions: string[]
  /** File probed for a bare relative import whose remainder is empty once
   *  the marker is stripped (Python's `from . import X` — the package's own
   *  `__init__.py`). Only reachable via "dot-hop". */
  emptyRelativeFile?: string
  /** Root-derivation strategies tried in order for a non-relative
   *  specifier; absent/empty = non-relative specifiers never resolve. */
  absoluteRootStrategies?: RootStrategy[]
  /** When a relative-style match fails to find a file, fall through to
   *  `absoluteRootStrategies` instead of resolving to null outright (C/C++:
   *  a quoted `#include` is unconditionally relative-first, but genuinely
   *  falls back to a repo-root/`include/` search path — unlike python/js,
   *  where a failed relative resolution should STAY unresolved, so this
   *  defaults to unset/false for every other row). */
  relativeFallsThroughToAbsolute?: boolean
  /** When set, `probeModuleFile`'s directory-fallback applies — the
   *  specifier names a package/directory, not a specific file (Go). */
  directoryRepresentative?: boolean
  /** Import-statement extraction patterns (G1a) — empty for languages whose
   *  extraction stays hand-written below (ES/CJS, Python: multi-form
   *  binding/aliasing logic that doesn't reduce to "one regex, one
   *  specifier"). */
  extractPatterns: ImportExtractPattern[]
}

const JS_IMPORT_ROW: LanguageImportRow = {
  separator: "/",
  relative: "path-prefix",
  stripExtensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  moduleFileTemplates: ["<base><ext>", "<base>/index<ext>"],
  extensions: [".ts", ".tsx", ".js", ".jsx"],
  extractPatterns: [],
}

const PYTHON_IMPORT_ROW: LanguageImportRow = {
  separator: ".",
  relative: "dot-hop",
  moduleFileTemplates: ["<base>.py", "<base>/__init__.py"],
  extensions: [""],
  emptyRelativeFile: "__init__.py",
  absoluteRootStrategies: [
    { kind: "sourceRootWalk", markerFile: "__init__.py" },
    { kind: "repoRoot" },
    { kind: "repoRoot", subdir: "src" },
  ],
  extractPatterns: [],
}

/** C/C++ quoted `#include "path.h"` row (shared by `c`/`cpp`, G3): the
 *  specifier IS a literal relative path (extension embedded, so
 *  `moduleFileTemplates` is a bare `<base>` — never append another
 *  extension on top of one the specifier already carries) and it always
 *  resolves relative to the including file's OWN directory first
 *  ("implicit" — no marker prefix like python/js need); a miss falls
 *  through to repo root / an `include/` subdir via
 *  `relativeFallsThroughToAbsolute`. Angle includes (`fallbackEligible:
 *  false` below) never reach this row's resolver at all. */
const C_FAMILY_IMPORT_ROW: LanguageImportRow = {
  separator: "/",
  relative: "implicit",
  moduleFileTemplates: ["<base>"],
  extensions: [""],
  relativeFallsThroughToAbsolute: true,
  absoluteRootStrategies: [{ kind: "repoRoot" }, { kind: "repoRoot", subdir: "include" }],
  extractPatterns: [
    { regex: /^\s*#include\s+"([^"]+)"/gm, relativeCapable: true },
    { regex: /^\s*#include\s*<([^>]+)>/gm, relativeCapable: false, fallbackEligible: false },
  ],
}

/** Per-language import table (wave G). Resolution rows exist for
 *  python/typescript/javascript (G1) and now go/java/rust/c/cpp (G3) —
 *  every row resolves at extraction time via the one generic
 *  `resolveGenericImport`. Adding Kotlin (or any new language) is one more
 *  entry here. */
const IMPORT_LANGUAGE_TABLE: Partial<Record<Language, LanguageImportRow>> = {
  typescript: JS_IMPORT_ROW,
  javascript: JS_IMPORT_ROW,
  python: PYTHON_IMPORT_ROW,
  go: {
    separator: "/",
    relative: null,
    moduleFileTemplates: [],
    // Go imports name PACKAGES (directories), not files — `directoryRepresentative`
    // lets probeModuleFile pick any ".go" file inside the resolved package dir.
    extensions: [".go"],
    directoryRepresentative: true,
    absoluteRootStrategies: [{ kind: "manifestPrefix", manifestFile: "go.mod", capturePattern: /^module\s+(\S+)/m }],
    extractPatterns: [
      // import "fmt" / import f "fmt" / import _ "fmt" / import . "fmt"
      { regex: /^import\s+(?:[\w.]+\s+)?"([^"]+)"/gm, relativeCapable: false },
      // factored: import (\n\t"fmt"\n\t"os"\n\talias "pkg/path"\n)
      { regex: /^import\s*\(([\s\S]*?)\)/gm, specifierPattern: /"([^"]+)"/g, relativeCapable: false },
    ],
  },
  java: {
    separator: ".",
    relative: null,
    // Java's dotted package path → a path under a source root. No
    // per-directory marker file exists to express a sourceRootWalk (unlike
    // python's __init__.py), so only the two repoRoot-shaped strategies are
    // tried; a multi-module checkout (guava) that keeps sources under a
    // module subdir neither strategy reaches is an honest, reported gap —
    // not forced with repo-specific data (see the G3 measurement report).
    moduleFileTemplates: ["<base>.java"],
    extensions: [""],
    absoluteRootStrategies: [{ kind: "repoRoot", subdir: "src/main/java" }, { kind: "repoRoot" }],
    extractPatterns: [
      // import a.b.C; / import static a.b.C.d; / import a.b.*;
      { regex: /^import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/gm, relativeCapable: false },
    ],
  },
  rust: {
    separator: "::",
    // Literal-token markers: `self::` (same dir), `super::` (parent,
    // repeatable), `crate::` (crate source root, derived via `rootStrategies`
    // instead of a dirname hop — nearest `src/` up-walk, else the nearest
    // `Cargo.toml`'s directory). A bare `use a::b::c` with none of these
    // markers is an external crate and stays unresolved by row (no
    // `absoluteRootStrategies` on this row).
    relative: {
      kind: "markers",
      markers: [
        { token: "self::", upHops: 0 },
        { token: "super::", upHops: 1, repeatable: true },
        {
          token: "crate::",
          upHops: 0,
          rootStrategies: [{ kind: "nearestDirNamed", name: "src" }, { kind: "nearestAncestorWithMarker", markerFile: "Cargo.toml" }],
        },
      ],
    },
    moduleFileTemplates: ["<base>.rs", "<base>/mod.rs"],
    extensions: [""],
    extractPatterns: [
      // use a::b::{c, d}; — one edge for the group path (acceptable per
      // spec); per-leaf edges would need prefix+leaf reconstruction, not
      // built here.
      { regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([\w:]+)::\{[^}]*\}\s*;/gm, relativeCapable: false },
      // use a::b::c; / use a::b::c as e;
      { regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([\w:]+)(?:\s+as\s+\w+)?\s*;/gm, relativeCapable: false },
    ],
  },
  c: C_FAMILY_IMPORT_ROW,
  cpp: C_FAMILY_IMPORT_ROW,
}

/** Probe `row.moduleFileTemplates` (outer) × `row.extensions` (inner) — every
 *  extension of the first template before any of the second — against
 *  `base`; when nothing matches and `row.directoryRepresentative` is set,
 *  fall back to the first file directly inside `base` (if `base` is itself
 *  a directory) whose extension is in `row.extensions` — for languages
 *  whose import specifiers name a PACKAGE/DIRECTORY rather than a specific
 *  file (Go: `import "pkg/sub"` names the directory, not one file in it).
 *  Null if nothing on disk matches either way. */
function probeModuleFile(base: string, row: LanguageImportRow): string | null {
  for (const template of row.moduleFileTemplates) {
    for (const ext of row.extensions) {
      const candidate = template.replace("<base>", base).replace("<ext>", ext)
      if (existsSync(candidate)) return candidate
    }
  }
  if (row.directoryRepresentative && existsSync(base) && statSync(base).isDirectory()) {
    const entries = readdirSync(base)
    for (const ext of row.extensions) {
      if (!ext) continue
      const hit = entries.find((f) => f.endsWith(ext))
      if (hit) return join(base, hit)
    }
  }
  return null
}

/** Peel a relative marker off `specifier` per `style` — see `RelativeStyle`.
 *  Returns null when `specifier` isn't relative for `style`'s grammar, or
 *  `style` is null (no relative-import grammar for this row). The
 *  `{kind:"markers"}` style consumes a literal-token marker from the front
 *  of `specifier` (repeating for a `repeatable` marker matched
 *  consecutively, Rust's `super::super::`) and stops at the first
 *  non-matching or non-repeatable marker; a `rootStrategies`-bearing marker
 *  (Rust's `crate::`) short-circuits immediately since its root doesn't
 *  come from hop-counting `upHops`. The `implicit` style matches
 *  unconditionally (C/C++'s quoted `#include`, always relative to the
 *  including file first — no leading-dot marker to peel). */
function matchRelativeMarker(
  specifier: string,
  style: RelativeStyle | null
): { upHops: number; rest: string; rootStrategies?: RootStrategy[] } | null {
  if (!style) return null

  if (typeof style === "object") {
    let rest = specifier
    let upHops = 0
    let rootStrategies: RootStrategy[] | undefined
    let matchedAny = false
    for (;;) {
      const hit = style.markers.find((mk) => rest.startsWith(mk.token))
      if (!hit) break
      matchedAny = true
      rest = rest.slice(hit.token.length)
      if (hit.rootStrategies) {
        rootStrategies = hit.rootStrategies
        break
      }
      upHops += hit.upHops
      if (!hit.repeatable) break
    }
    return matchedAny ? { upHops, rest, rootStrategies } : null
  }

  if (style === "implicit") return { upHops: 0, rest: specifier }

  if (!specifier.startsWith(".")) return null
  if (style === "dot-hop") {
    const dotMatch = specifier.match(/^(\.+)(.*)$/)
    const dots = dotMatch?.[1] ?? "."
    return { upHops: dots.length - 1, rest: dotMatch?.[2] ?? "" }
  }
  return { upHops: 0, rest: specifier }
}

/** Walk up from `dirname(fromFile)`, inclusive, until an ancestor directory
 *  contains `markerFile`; return that ancestor. Falls back to `repoRoot`
 *  when it contains `markerFile` and no ancestor did — null when neither
 *  finds it. Shared by `deriveRoots`'s `nearestAncestorWithMarker` strategy
 *  and `resolveViaManifestPrefix` (Go's `go.mod` lookup). */
function nearestAncestorWithFile(fromFile: string, markerFile: string, repoRoot?: string): string | null {
  let dir = dirname(fromFile)
  for (;;) {
    if (existsSync(join(dir, markerFile))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  if (repoRoot && existsSync(join(repoRoot, markerFile))) return repoRoot
  return null
}

/** Derive candidate roots for a non-relative specifier, in strategy order —
 *  `sourceRootWalk` walks up from `dirname(fromFile)` while `markerFile`
 *  still exists in the current directory, stopping at the first ancestor
 *  that doesn't; `repoRoot` (optionally + `subdir`) is used verbatim, and is
 *  skipped entirely when no `repoRoot` was supplied; `nearestDirNamed` walks
 *  up until an ancestor's OWN basename matches; `nearestAncestorWithMarker`
 *  walks up until an ancestor CONTAINS `markerFile`. `manifestPrefix` never
 *  reaches here — it needs the specifier itself, so
 *  `resolveGenericImport`'s absolute-strategy loop handles it directly
 *  instead of going through this root-only helper. */
function deriveRoots(fromFile: string, repoRoot: string | undefined, strategies: RootStrategy[]): string[] {
  const roots: string[] = []
  for (const s of strategies) {
    if (s.kind === "sourceRootWalk") {
      let dir = dirname(fromFile)
      while (existsSync(join(dir, s.markerFile))) {
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
      }
      roots.push(dir)
    } else if (s.kind === "repoRoot") {
      if (repoRoot) roots.push(s.subdir ? join(repoRoot, s.subdir) : repoRoot)
    } else if (s.kind === "nearestDirNamed") {
      let dir = dirname(fromFile)
      for (;;) {
        if (basename(dir) === s.name) {
          roots.push(dir)
          break
        }
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    } else if (s.kind === "nearestAncestorWithMarker") {
      const dir = nearestAncestorWithFile(fromFile, s.markerFile, repoRoot)
      if (dir) roots.push(s.subdir ? join(dir, s.subdir) : dir)
    }
  }
  return roots
}

function stripKnownExtensions(specifier: string, exts: string[]): string {
  if (!exts.length) return specifier
  const alternation = exts.map((e) => e.replace(/^\./, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
  return specifier.replace(new RegExp(`\\.(${alternation})$`), "")
}

/** G3 generic strategy (see `RootStrategy`'s `manifestPrefix` variant): read
 *  `strategy.manifestFile` nearest `fromFile` (or `repoRoot`), capture a
 *  module-path prefix via `strategy.capturePattern`, and resolve
 *  `specifier` only when it actually starts with that prefix — a specifier
 *  belonging to a DIFFERENT module is a genuine external dependency and
 *  correctly returns null here, not a false match. The remainder resolves
 *  as a subpath under the manifest's directory, probed via
 *  `probeModuleFile`. */
function resolveViaManifestPrefix(
  specifier: string,
  fromFile: string,
  repoRoot: string | undefined,
  strategy: Extract<RootStrategy, { kind: "manifestPrefix" }>,
  row: LanguageImportRow
): string | null {
  const manifestDir = nearestAncestorWithFile(fromFile, strategy.manifestFile, repoRoot)
  if (!manifestDir) return null

  let manifestContent: string
  try {
    manifestContent = readFileSync(join(manifestDir, strategy.manifestFile), "utf8")
  } catch {
    return null
  }
  const modulePrefix = manifestContent.match(strategy.capturePattern)?.[1]
  if (!modulePrefix) return null

  let remainder: string
  if (specifier === modulePrefix) remainder = ""
  else if (specifier.startsWith(modulePrefix + row.separator)) remainder = specifier.slice(modulePrefix.length + row.separator.length)
  else return null

  const packageDir = remainder ? resolve(manifestDir, ...remainder.split(row.separator)) : manifestDir
  return probeModuleFile(packageDir, row)
}

/**
 * Resolve an import specifier against the importing file's absolute path,
 * for any language with a `LanguageImportRow` (G1/G3). A relative specifier
 * is peeled per `row.relative` — a leading-dot hop ("dot-hop"/"path-prefix"),
 * a literal-token marker set (Rust's `crate::`/`self::`/`super::`,
 * `{kind:"markers"}`), or unconditionally the whole specifier ("implicit" —
 * C/C++'s quoted `#include`, always relative to the including file first) —
 * then probes `row.moduleFileTemplates` from the resulting base directory,
 * or the marker's own `rootStrategies` when it has them (Rust `crate::`). A
 * bare relative import with nothing after the marker (Python's `from .
 * import X`) probes `row.emptyRelativeFile` instead. When the relative
 * attempt fails AND `row.relativeFallsThroughToAbsolute` is set (C/C++
 * only — python/js relative failures stay unresolved), resolution
 * continues into the absolute branch below instead of returning null.
 *
 * Non-relative specifiers resolve via `row.absoluteRootStrategies`, tried
 * in order: the plain root-derivation kinds join the FULL specifier onto a
 * derived root; `manifestPrefix` (Go's `go.mod` module line) instead strips
 * a manifest-declared prefix off the specifier and resolves the remainder
 * under the manifest's directory — handled separately since it needs the
 * specifier, not just a root. A row without any strategies (JS/TS) leaves
 * every bare specifier unresolved by construction ("that's an npm package,
 * not a file"). Returns null when nothing on disk matches.
 */
function resolveGenericImport(specifier: string, fromFile: string, row: LanguageImportRow, repoRoot?: string): string | null {
  const rel = matchRelativeMarker(specifier, row.relative)
  let relResult: string | null = null

  if (rel) {
    if (rel.rootStrategies) {
      if (rel.rest) {
        const cleaned = row.stripExtensions ? stripKnownExtensions(rel.rest, row.stripExtensions) : rel.rest
        const segments = cleaned.split(row.separator)
        for (const root of deriveRoots(fromFile, repoRoot, rel.rootStrategies)) {
          const hit = probeModuleFile(resolve(root, ...segments), row)
          if (hit) {
            relResult = hit
            break
          }
        }
      }
    } else {
      let dir = dirname(fromFile)
      for (let i = 0; i < rel.upHops; i++) dir = dirname(dir)

      if (!rel.rest) {
        if (row.emptyRelativeFile) {
          const initPath = join(dir, row.emptyRelativeFile)
          if (existsSync(initPath)) relResult = initPath
        }
      } else {
        const cleaned = row.stripExtensions ? stripKnownExtensions(rel.rest, row.stripExtensions) : rel.rest
        const base = resolve(dir, ...cleaned.split(row.separator))
        relResult = probeModuleFile(base, row)
      }
    }
    if (relResult || !row.relativeFallsThroughToAbsolute) return relResult
  }

  if (!row.absoluteRootStrategies?.length) return relResult
  const segments = specifier.split(row.separator)
  for (const strategy of row.absoluteRootStrategies) {
    if (strategy.kind === "manifestPrefix") {
      const hit = resolveViaManifestPrefix(specifier, fromFile, repoRoot, strategy, row)
      if (hit) return hit
      continue
    }
    for (const root of deriveRoots(fromFile, repoRoot, [strategy])) {
      const hit = probeModuleFile(resolve(root, ...segments), row)
      if (hit) return hit
    }
  }
  return relResult
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
 * Extract import and call edges from source. Import edges parse ES named/
 * default/namespace bindings, CommonJS `require()` destructured and whole-
 * module bindings, Python `from X import A as Z, B` / `import X.Y.Z as W`
 * forms, and Go/Java/Rust/C/C++ import statements — one generic resolver
 * (`resolveGenericImport`) and one generic per-language extraction table
 * (`IMPORT_LANGUAGE_TABLE`, wave G) back all of it, so every language's
 * different specifier grammar shares the same hop/probe algorithm and a new
 * language's coverage is a table row, not new code (G3 gave the five
 * extraction-only languages resolver rows too — `toEntity` now stores each
 * one's FULL specifier, not just its last segment, so row resolution and
 * the graph layer's suffix-fallback guards both have the whole path to
 * work with). Unresolved specifiers (an npm package, a Python stdlib
 * module, an external Go/Java/Rust/C/C++ dependency, or a same-repo file
 * genuinely missing) get `toFile: null`. Call edges scan each
 * entity's body for bare `identifier(` call sites and for `X.fn(` property
 * calls whose receiver `X` resolves to a same-file namespace or default
 * import binding — excluding other member access (`obj.foo(` where `obj`
 * isn't an import) and language keywords — and resolve the callee name
 * against same-file entities or this file's own import bindings (Python's
 * local binding names included); only resolved calls are kept (edge_kind
 * "call"), attributed to their enclosing entity via line ranges.
 *
 * @sem domain=intelligence role=utilities
 */
export function extractEdges(
  content: string,
  filePath: string,
  entities: ExtractedEntity[] = [],
  repoRoot?: string
): ExtractedEdge[] {
  const edges: ExtractedEdge[] = []
  const importNameToFile = new Map<string, string | null>()

  // ES: import { A, B } from "..."
  const namedImport = /^import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["']([^"']+)["']/gm
  let m: RegExpExecArray | null
  while ((m = namedImport.exec(content)) !== null) {
    const names = (m[1] ?? "").split(",").map((s) => s.trim().split(/\s+as\s+/)[0]?.trim()).filter(Boolean)
    const toFile = resolveGenericImport(m[2] ?? "", filePath, JS_IMPORT_ROW)
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
    const toFile = resolveGenericImport(m[2] ?? "", filePath, JS_IMPORT_ROW)
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
    const toFile = resolveGenericImport(m[2] ?? "", filePath, JS_IMPORT_ROW)
    if (n) importNameToFile.set(n, toFile)
  }

  // CommonJS: const/let/var { A, B } = require("./x") — leading whitespace
  // allowed since lazy in-function requires are a real Node idiom (unlike ES
  // imports, which must be top-level). A piece may rename (`source: local`)
  // and/or carry a default (`source: local = fallback`); the SOURCE name
  // becomes the import edge's target, the LOCAL name is what call sites use.
  const cjsNamedImport = /^\s*(?:const|let|var)\s+\{([^}]+)\}\s*=\s*require\(\s*["']([^"']+)["']\s*\)/gm
  while ((m = cjsNamedImport.exec(content)) !== null) {
    const toFile = resolveGenericImport(m[2] ?? "", filePath, JS_IMPORT_ROW)
    const pieces = (m[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean)
    for (const piece of pieces) {
      const withoutDefault = piece.replace(/=.*$/, "").trim()
      const [sourceRaw, localRaw] = withoutDefault.split(":").map((s) => s.trim())
      if (!sourceRaw) continue
      const local = localRaw || sourceRaw
      edges.push({ fromEntity: "", toEntity: sourceRaw, toFile, kind: "import" })
      importNameToFile.set(local, toFile)
    }
  }

  // CommonJS: const/let/var X = require("./x") — X is usable as both a bare
  // call (X(...)) and a namespace-like property-call receiver (X.fn(...)),
  // resolved below through the same importNameToFile map ES bindings use.
  const cjsWholeImport = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*["']([^"']+)["']\s*\)/gm
  while ((m = cjsWholeImport.exec(content)) !== null) {
    const n = m[1]
    const toFile = resolveGenericImport(m[2] ?? "", filePath, JS_IMPORT_ROW)
    if (n) {
      edges.push({ fromEntity: "", toEntity: n, toFile, kind: "import" })
      importNameToFile.set(n, toFile)
    }
  }

  // Python: from X import A as Z, B / import X.Y.Z as W, a, b — gated on file
  // extension since python's import grammar has no analog to overlap with
  // the ES/CJS forms above. Module specifiers resolve via
  // resolveGenericImport(PYTHON_IMPORT_ROW) (relative dot-hops, absolute
  // dotted against the importing file's source root or repoRoot); each
  // imported name's LOCAL binding also registers in importNameToFile so the
  // bare-call pass below resolves python call sites the same way it does JS
  // ones.
  if (filePath.endsWith(".py")) {
    // from X import A as Z, B
    const pyFromImport = /^from\s+(\S+)\s+import\s+(.+)$/gm
    while ((m = pyFromImport.exec(content)) !== null) {
      const moduleSpecifier = m[1] ?? ""
      const moduleToFile = resolveGenericImport(moduleSpecifier, filePath, PYTHON_IMPORT_ROW, repoRoot)
      const moduleIsPackage = moduleToFile !== null && moduleToFile.endsWith("__init__.py")
      const moduleDir = moduleToFile ? dirname(moduleToFile) : null

      const pieces = (m[2] ?? "").split(",").map((s) => s.trim()).filter(Boolean)
      for (const piece of pieces) {
        const [sourceName, aliasName] = piece.split(/\s+as\s+/).map((s) => s.trim())
        if (!sourceName) continue
        const localName = aliasName || sourceName

        // Submodule-from-package: `from pkg import submodule` — if X
        // resolved to a package's __init__.py and <X-dir>/<name>.py exists
        // on disk, the imported name's own edge target is that submodule
        // file, not the package's __init__.py.
        let toFile = moduleToFile
        if (moduleIsPackage && moduleDir) {
          const submodulePath = join(moduleDir, `${sourceName}.py`)
          if (existsSync(submodulePath)) toFile = submodulePath
        }

        edges.push({ fromEntity: "", toEntity: sourceName, toFile, kind: "import" })
        importNameToFile.set(localName, toFile)
      }
    }

    // import X.Y.Z as W, a, b
    const pyPlainImport = /^import\s+(.+)$/gm
    while ((m = pyPlainImport.exec(content)) !== null) {
      const pieces = (m[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean)
      for (const piece of pieces) {
        const [modPart, aliasPart] = piece.split(/\s+as\s+/).map((s) => s.trim())
        if (!modPart) continue
        const segments = modPart.split(".")
        const lastSeg = segments[segments.length - 1]
        const bindingName = aliasPart || lastSeg
        if (!bindingName) continue

        const toFile = resolveGenericImport(modPart, filePath, PYTHON_IMPORT_ROW, repoRoot)
        edges.push({ fromEntity: "", toEntity: bindingName, toFile, kind: "import" })
        importNameToFile.set(bindingName, toFile)
      }
    }
  }

  // Generic per-language import extraction (G1a/G3) — go/java/rust/c/cpp
  // emit no syntax overlapping ES/CJS/Python above, so this is
  // unconditional; the table's other rows (python/typescript/javascript)
  // carry an empty `extractPatterns` and no-op here, since their extraction
  // stays the hand-written blocks above. `toEntity` stores the FULL
  // specifier (not just its last segment) so `resolveGenericImport` — and
  // the G2 suffix fallback's full-specifier verification guard — has the
  // whole path to work with. A pattern with `fallbackEligible: false`
  // (C/C++ angle `#include <...>`) skips resolution entirely and marks the
  // edge confirmed-external instead of leaving it for the suffix fallback
  // to (mis)guess at.
  const detectedLanguage = detectLanguage(filePath)
  const importRow = detectedLanguage ? IMPORT_LANGUAGE_TABLE[detectedLanguage] : undefined
  if (importRow) {
    for (const pattern of importRow.extractPatterns) {
      pattern.regex.lastIndex = 0
      let em: RegExpExecArray | null
      while ((em = pattern.regex.exec(content)) !== null) {
        const captured = em[1] ?? ""
        if (!captured) continue

        const pushSpecifier = (spec: string) => {
          if (!spec) return
          if (pattern.fallbackEligible === false) {
            edges.push({ fromEntity: "", toEntity: spec, toFile: null, external: true, kind: "import" })
            return
          }
          const toFile = resolveGenericImport(spec, filePath, importRow, repoRoot)
          edges.push({ fromEntity: "", toEntity: spec, toFile, kind: "import" })
        }

        if (pattern.specifierPattern) {
          pattern.specifierPattern.lastIndex = 0
          let sm: RegExpExecArray | null
          while ((sm = pattern.specifierPattern.exec(captured)) !== null) {
            pushSpecifier(sm[1] ?? "")
          }
        } else {
          pushSpecifier(captured)
        }
      }
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
