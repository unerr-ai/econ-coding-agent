/**
 * Web search as a first-class sense (docs/design/agnostic-hands-eyes.md §3 +
 * §3.1 version discipline) — the deterministic, version-aware triggers for
 * the human "paste the exact exception into search" move, layered on top of
 * the existing default-on Exa websearch tool (whose own "ONE search EARLY"
 * doctrine is unchanged). `normalizeTraceForSearch` implements the
 * documented refinement ritual (strip local paths/line numbers/addresses/
 * timestamps, keep the invariant type+message); `shouldSearchForError`
 * evaluates the doc's trigger table (unrecognized-or-dependency-rooted,
 * repro-unresolved escalation, never re-fire a signature, respect the
 * per-turn budget); the version-pinned query embedding, doc-URL builder,
 * and mismatch-warning detector implement §3.1. Pure functions only — no
 * LLM calls, no network, no FS — so every rule here is unit-testable
 * without a session. Intentionally unwired this wave: a later pass adopts
 * this module from `prompt.ts`.
 *
 * @sem domain=intelligence role=discovery
 */

import type { EcosystemVersions } from "../code-intelligence/repo-profile"

// ---------------------------------------------------------------------------
// normalizeTraceForSearch — the human refinement ritual
// ---------------------------------------------------------------------------

/** A search-ready query plus a stable dedupe key, both derived from one error/trace. @sem domain=intelligence role=discovery */
export interface NormalizedTrace {
  readonly query: string
  readonly signature: string
}

interface RawDetection {
  readonly type: string
  readonly message: string
}

function lastNonEmptyLine(text: string): string | undefined {
  const lines = text.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim()
    if (trimmed) return trimmed
  }
  return undefined
}

// Python: the traceback header is unambiguous; the invariant line is always
// the last non-empty line, either "Type: message" or a bare "Type".
function detectPython(output: string): RawDetection | undefined {
  if (!/^Traceback \(most recent call last\):/m.test(output)) return undefined
  const line = lastNonEmptyLine(output)
  if (!line || line.startsWith("File ")) return undefined
  const withMessage = /^([A-Za-z_][\w.]*):\s*(.*)$/.exec(line)
  if (withMessage) return { type: withMessage[1], message: withMessage[2] }
  if (/^[A-Za-z_][\w.]*$/.test(line)) return { type: line, message: "" }
  return undefined
}

// Rust: two panic message formats across editions — the pre-2021 single-line
// quoted form and the 2021+ "location on its own line" form.
function detectRust(output: string): RawDetection | undefined {
  const quoted = /thread '[^']*' panicked at '([^']*)',/.exec(output)
  if (quoted) return { type: "panic", message: quoted[1] }
  const located = /thread '[^']*' panicked at [^\n:]+:\d+:\d+:\s*\n(.+)/.exec(output)
  if (located) return { type: "panic", message: located[1].trim() }
  return undefined
}

// Go: `panic: <message>` is the unambiguous line opener (never shared with
// rust's "thread '...' panicked at" shape).
function detectGo(output: string): RawDetection | undefined {
  const m = /^panic:\s*(.+)$/m.exec(output)
  if (!m) return undefined
  return { type: "panic", message: m[1].trim() }
}

const JAVA_FRAME_RE = /\n\s*at\s+[\w.$]+\([^)]*\.java(?::\d+)?\)/

// Java: "Exception in thread" is unambiguous; the fallback requires a
// dotted, fully-qualified type (java.lang.X) AND a `.java:` stack frame so
// it never fires on a bare JS-style `Error: ...` line.
function detectJava(output: string): RawDetection | undefined {
  const named = /Exception in thread "[^"]*"\s+((?:[\w$]+\.)+[\w$]+):\s*(.*)$/m.exec(output)
  if (named) return { type: named[1], message: named[2] }
  const qualified = /^((?:[\w$]+\.)+(?:Exception|Error|Throwable)\w*):\s*(.*)$/m.exec(output)
  if (qualified && JAVA_FRAME_RE.test(output)) return { type: qualified[1], message: qualified[2] }
  return undefined
}

// Node/JS: an undotted *Error/*Exception/*Warning type line followed
// somewhere by a `    at ` stack frame. The "no dot in the type" and
// "at-frame present" checks together keep this from matching java or a
// bare non-stack message.
function detectNode(output: string): RawDetection | undefined {
  const m = /^([A-Z]\w*(?:Error|Exception|Warning)):\s*(.*)$/m.exec(output)
  if (!m) return undefined
  if (m[1].includes(".")) return undefined
  if (!/\n\s*at\s+/.test(output)) return undefined
  return { type: m[1], message: m[2] }
}

function detectRawError(output: string): RawDetection | undefined {
  return detectPython(output) ?? detectRust(output) ?? detectGo(output) ?? detectJava(output) ?? detectNode(output)
}

const UNIX_PATH_RE = /\/(?:[\w.-]+\/)+[\w.-]+(?::\d+(?::\d+)?)?/g
const WIN_PATH_RE = /[A-Za-z]:\\(?:[\w.-]+\\)*[\w.-]+(?::\d+)?/g
const MEMORY_ADDR_RE = /0x[0-9a-fA-F]{4,}/g
const TIMESTAMP_RE = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g
const STANDALONE_LINE_NO_RE = /\bline \d+\b/gi
const PAREN_FILE_LINE_RE = /\(([^,()]+),\s*line \d+\)/g

function collapseWhitespace(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/\s+([,.:;)])/g, "$1")
    .trim()
}

// Strip local absolute paths (unix + windows, with an optional trailing
// :line:col), memory addresses, ISO timestamps, and bare "line N" markers —
// the noise a human would never re-type into a search box — while leaving
// the invariant message text untouched.
function stripNoise(message: string): string {
  let out = message
  out = out.replace(PAREN_FILE_LINE_RE, "")
  out = out.replace(UNIX_PATH_RE, "")
  out = out.replace(WIN_PATH_RE, "")
  out = out.replace(MEMORY_ADDR_RE, "")
  out = out.replace(TIMESTAMP_RE, "")
  out = out.replace(STANDALONE_LINE_NO_RE, "")
  return collapseWhitespace(out)
}

/**
 * Extracts a search-ready query and a stable dedupe signature from an
 * error/stack-trace-shaped output — python traceback, node/JS stack, go
 * panic, java exception, or rust panic. Returns undefined when no
 * recognizable error shape is found (never a false-positive query).
 *
 * @sem domain=intelligence role=discovery
 */
export function normalizeTraceForSearch(output: string): NormalizedTrace | undefined {
  const raw = detectRawError(output)
  if (!raw) return undefined
  const cleanedMessage = stripNoise(raw.message)
  const query = collapseWhitespace(`${raw.type}: ${cleanedMessage}`).replace(/:\s*$/, "")
  if (!query) return undefined
  return { query, signature: query.toLowerCase() }
}

// ---------------------------------------------------------------------------
// classifyTraceRoot — dependency-vs-repo path heuristics
// ---------------------------------------------------------------------------

export type TraceOrigin = "dependency" | "repo" | "unknown"

/** Where a trace's implicated code lives, plus the dependency name when known. @sem domain=intelligence role=discovery */
export interface TraceRootClassification {
  readonly origin: TraceOrigin
  readonly dependencyName?: string
}

// One row per ecosystem's dependency-cache directory convention; group 1 is
// always the dependency name segment.
const DEPENDENCY_DIR_MARKERS: readonly RegExp[] = [
  /(?:site|dist)-packages\/([^/\s]+)/,
  /node_modules\/((?:@[^/\s]+\/)?[^/\s]+)/,
  /\.cargo\/registry\/(?:src|cache)\/[^/\s]+\/([a-zA-Z0-9_.-]+?)-\d[\w.-]*\//,
  /pkg\/mod\/((?:[^@/\s]+\/)*[^@/\s]+)@v\d[\w.-]*/,
  /\bvendor\/([^/\s]+)/,
  /\.m2\/repository\/(?:[^/\s]+\/)+([^/\s]+)\/\d[\w.-]*\//,
  /gems\/([a-zA-Z0-9_.-]+?)-\d[\w.-]*\//,
]

function normalizeDepKey(s: string): string {
  return s.toLowerCase().replace(/[-_.]/g, "")
}

function matchKnownDep(rawName: string, knownDeps: readonly string[]): string | undefined {
  const norm = normalizeDepKey(rawName)
  return knownDeps.find((d) => normalizeDepKey(d) === norm)
}

/**
 * Classifies a raw (unstripped) trace as dependency-rooted, repo-rooted, or
 * unknown via path heuristics: known dependency-cache directory shapes
 * (site-packages/node_modules/vendor/.cargo/pkg-mod/.m2/gems) win first —
 * their captured name is reconciled against the profile's resolved dep
 * names when one matches — else a literal repo-root path segment marks it
 * repo-rooted; neither present is unknown.
 *
 * @sem domain=intelligence role=discovery
 */
export function classifyTraceRoot(
  rawOutput: string,
  repoRoot: string,
  knownDeps: readonly string[] = [],
): TraceRootClassification {
  for (const marker of DEPENDENCY_DIR_MARKERS) {
    const m = marker.exec(rawOutput)
    if (m?.[1]) {
      return { origin: "dependency", dependencyName: matchKnownDep(m[1], knownDeps) ?? m[1] }
    }
  }
  const normalizedRoot = repoRoot.replace(/\/+$/, "")
  if (normalizedRoot && rawOutput.includes(normalizedRoot)) {
    return { origin: "repo" }
  }
  return { origin: "unknown" }
}

// ---------------------------------------------------------------------------
// shouldSearchForError — the deterministic trigger table
// ---------------------------------------------------------------------------

/** Repro attempts at/above this count escalate to a search even on a recognized, repo-rooted error (doc §3 row 2). */
export const DEFAULT_REPRO_UNRESOLVED_THRESHOLD = 2

/** Plain-data input to shouldSearchForError — testable without a session. @sem domain=intelligence role=gate */
export interface SearchTriggerInput {
  readonly trace: NormalizedTrace
  /** True when our own parsers/profile (seen-red, structured-report, etc.) already recognized this error. */
  readonly recognizedByProfile: boolean
  readonly traceOrigin: TraceRootClassification
  readonly reproAttempts: number
  /** N in "repro_unresolved after N attempts" — defaults to DEFAULT_REPRO_UNRESOLVED_THRESHOLD. */
  readonly reproUnresolvedThreshold?: number
  /** Signatures already searched this turn — enforces "never re-search a signature". */
  readonly alreadySearchedSignatures: ReadonlySet<string>
  /** Remaining per-turn search budget; a fired search must be counted down by the caller. */
  readonly budgetRemaining: number
  /** The ecosystem's resolved versions, for §3.1 version embedding into the fired query. */
  readonly versions?: EcosystemVersions
}

export type SearchDecision =
  | { readonly search: false; readonly reason: string }
  | { readonly search: true; readonly query: string; readonly reason: string }

// §3.1 rule 2: every external lookup carries the resolved version when the
// trace implicates a known dependency.
function embedVersion(baseQuery: string, dependencyName: string | undefined, versions: EcosystemVersions | undefined): string {
  if (!dependencyName || !versions) return baseQuery
  const version = versions.deps[dependencyName]
  if (!version) return baseQuery
  if (baseQuery.toLowerCase().includes(version.toLowerCase())) return baseQuery
  return `${baseQuery} ${dependencyName} ${version}`
}

/**
 * Evaluates the doc §3 trigger table against plain-data inputs: fires when
 * the error is unrecognized by our own parsers OR the trace is
 * dependency-rooted OR repro has gone unresolved for N attempts (the
 * escalation row, which fires even on a recognized/repo-rooted error);
 * never fires when repo-internal AND recognized (repo evidence suffices);
 * never re-fires an already-searched signature; never fires past budget.
 * A firing query is version-embedded per §3.1 when the trace's dependency
 * is in the profile.
 *
 * @sem domain=intelligence role=gate
 */
export function shouldSearchForError(input: SearchTriggerInput): SearchDecision {
  const threshold = input.reproUnresolvedThreshold ?? DEFAULT_REPRO_UNRESOLVED_THRESHOLD
  const dependencyRooted = input.traceOrigin.origin === "dependency"
  const reproEscalated = input.reproAttempts >= threshold
  const trigger = !input.recognizedByProfile || dependencyRooted || reproEscalated

  if (!trigger) {
    return { search: false, reason: "trace is repo-internal and recognized by our own parsers — repo evidence suffices" }
  }
  if (input.alreadySearchedSignatures.has(input.trace.signature)) {
    return { search: false, reason: "signature already searched this turn" }
  }
  if (input.budgetRemaining <= 0) {
    return { search: false, reason: "per-turn search budget exhausted" }
  }

  const query = embedVersion(input.trace.query, input.traceOrigin.dependencyName, input.versions)
  const reason = dependencyRooted
    ? "trace rooted in a dependency, not repo code"
    : !input.recognizedByProfile
      ? "error signature not recognized by our own parsers/profile"
      : `repro unresolved after ${input.reproAttempts} attempts`
  return { search: true, query, reason }
}

// ---------------------------------------------------------------------------
// Version discipline (§3.1) — mismatch warning + version-pinned doc URLs
// ---------------------------------------------------------------------------

/** A single dependency's profile-resolved name + version, for the mismatch check. @sem domain=intelligence role=discovery */
export interface DependencyVersionRef {
  readonly name: string
  readonly version: string
}

function majorOf(version: string): number | undefined {
  const m = /^(\d+)/.exec(version.trim())
  return m ? Number(m[1]) : undefined
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Looks for a version-shaped token within a short window after each
// occurrence of the dependency name — good enough for retrieved prose/doc
// snippets ("Django 2.2 removed...", "react-router v5.2.0 changed...").
function nearestVersionToken(text: string, name: string): string | undefined {
  const nameRe = new RegExp(escapeRegExp(name), "gi")
  let m: RegExpExecArray | null
  while ((m = nameRe.exec(text))) {
    const windowEnd = Math.min(text.length, m.index + name.length + 40)
    const window = text.slice(m.index, windowEnd)
    const versionMatch = /\d+\.\d+(?:\.\d+)?/.exec(window)
    if (versionMatch) return versionMatch[0]
  }
  return undefined
}

/**
 * Detects a version mentioned near the dependency's name in retrieved
 * result text that disagrees on MAJOR with the profile's resolved version,
 * and returns a one-line warning to ride alongside the result — never
 * silently rewrites or drops the result itself. Silent (undefined) when no
 * version is mentioned, or when majors agree (a minor/patch difference is
 * not flagged).
 *
 * @sem domain=intelligence role=discovery
 */
export function versionMismatchWarning(resultText: string, dependency: DependencyVersionRef): string | undefined {
  const found = nearestVersionToken(resultText, dependency.name)
  if (!found) return undefined
  const foundMajor = majorOf(found)
  const profileMajor = majorOf(dependency.version)
  if (foundMajor === undefined || profileMajor === undefined || foundMajor === profileMajor) return undefined
  return `this answer targets ${dependency.name} ${found}; this repo resolves ${dependency.name} ${dependency.version}`
}

export type DocEcosystemHint = "rust" | "cargo" | "javascript" | "typescript" | "npm" | "python" | "go" | "ruby"

function majorMinor(version: string): string | undefined {
  const m = /^(\d+)\.(\d+)/.exec(version.trim())
  return m ? `${m[1]}.${m[2]}` : undefined
}

/**
 * The ecosystems with ONE canonical, version-pinned per-package doc host —
 * docs.rs (rust), npmjs.com (JS/TS), pkg.go.dev (go — `go.mod`'s resolved
 * version already carries its `v` prefix, matching pkg.go.dev's expected
 * `@v1.2.3` shape), rubydoc.info (ruby). Adding another such ecosystem is one
 * row here, never another branch in `docUrlForDependency`.
 */
const ECOSYSTEM_DOC_URL: Readonly<Partial<Record<DocEcosystemHint, (name: string, version: string) => string>>> = {
  rust: (name, version) => `https://docs.rs/${name}/${version}/${name}/`,
  cargo: (name, version) => `https://docs.rs/${name}/${version}/${name}/`,
  javascript: (name, version) => `https://www.npmjs.com/package/${name}/v/${version}`,
  typescript: (name, version) => `https://www.npmjs.com/package/${name}/v/${version}`,
  npm: (name, version) => `https://www.npmjs.com/package/${name}/v/${version}`,
  go: (name, version) => `https://pkg.go.dev/${name}@${version}`,
  ruby: (name, version) => `https://www.rubydoc.info/gems/${name}/${version}`,
}

/**
 * Well-known packages whose docs live at a framework-specific URL shape
 * instead of their ecosystem's generic per-package host, keyed by lowercased
 * name — adding another one (a Rails/Laravel-shaped case) is one row, never
 * a `name.toLowerCase() === "..."` branch. `django`'s row reproduces the
 * pre-table hardcoded output byte-for-byte.
 */
const FRAMEWORK_DOC_URL: Readonly<Record<string, (version: string) => string | undefined>> = {
  django: (version) => {
    const mm = majorMinor(version)
    return mm ? `https://docs.djangoproject.com/en/${mm}/` : undefined
  },
}

/**
 * Version-pinned documentation URL for the common ecosystems this repo
 * actually sees (`ECOSYSTEM_DOC_URL`) plus the well-known single-package
 * special cases no generic host covers (`FRAMEWORK_DOC_URL` — django's own
 * /en/<X.Y>/ scheme, major.minor). Returns undefined for every other
 * name/ecosystem combination rather than guessing a URL pattern that might
 * not exist.
 *
 * @sem domain=intelligence role=discovery
 */
export function docUrlForDependency(name: string, version: string, ecosystem?: DocEcosystemHint): string | undefined {
  if (!name || !version) return undefined
  const ecosystemUrl = ecosystem ? ECOSYSTEM_DOC_URL[ecosystem] : undefined
  if (ecosystemUrl) return ecosystemUrl(name, version)
  return FRAMEWORK_DOC_URL[name.toLowerCase()]?.(version)
}
