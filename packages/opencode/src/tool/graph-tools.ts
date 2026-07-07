/**
 * Econ graph tools — wraps the code-intelligence BunSqliteGraph into the
 * opencode Tool.define() shape so the agent loop can call recon, file_read,
 * and get_references natively without blind filesystem reads.
 *
 * Z1: isolated econ addition. Cross-package imports use relative paths so no
 * `bun install` is required during development. Add
 * `"@opencode-ai/code-intelligence": "workspace:*"` to package.json
 * dependencies before shipping to production.
 *
 * @sem domain=intelligence role=tools
 */

// Z1 — resolved via tsconfig paths alias (no bun install needed during dev;
// add "workspace:*" dep to package.json before shipping)
import { BunSqliteGraph, makeReconTool, makeGetReferencesTool, makeSearchCodeTool, makeFileOutlineTool, makeNoteSaveTool, computeTurnRisk, type Entity, type VerifyCommand } from "@opencode-ai/code-intelligence"

import * as Tool from "./tool"
import { Effect, Schema } from "effect"
import { withMeta, hashInputs, getSlice, recordToolCall } from "./_shared"
import { enrichEntities } from "./graph-tools-enrich"
import type { LeanEntity } from "./graph-tools-enrich"
// Sprint 4: glob mode uses Glob.scanSync (sync, no Effect service needed)
import { Glob } from "@opencode-ai/core/util/glob"
import path from "path"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { existsSync, readFileSync, mkdirSync, unlinkSync } from "node:fs"
import { Database } from "bun:sqlite"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"

// ---------------------------------------------------------------------------
// Per-repo-root singleton graph — one persistent, disk-backed graph per
// canonical repo root, shared by every subdirectory that calls in.
// ---------------------------------------------------------------------------

/**
 * Schema version stamped into a disk graph db's `PRAGMA user_version`. Bump
 * this whenever the on-disk shape in bun-sqlite-graph.ts's SCHEMA changes —
 * getGraph() wipes and rebuilds any db file stamped with a different version
 * rather than open a graph db against a stale/incompatible schema. v3: adds
 * entities.summary (+ the notes.stale column from earlier the same day).
 */
export const GRAPH_SCHEMA_VERSION = 3

interface GraphRegistryEntry {
  graph: BunSqliteGraph
  indexReady: Promise<unknown>
}

/** One entry per canonicalized repo root — never a second graph (memory or disk) for the same root. */
const _graphs = new Map<string, GraphRegistryEntry>()

/**
 * Looks up the registry entry (if any) whose graph is `graph` by identity —
 * lets probeTurnRisk/probeSliceCoupling bound their wait on the same index
 * promise getGraph() attached to that instance without assuming the graph
 * came from the default (cwd) root. A graph built outside getGraph() (e.g. a
 * test's directly-constructed or mock BunSqliteGraph) has no entry, so the
 * bound-wait is skipped — same as when the registry hadn't indexed anything yet.
 */
function indexReadyFor(graph: BunSqliteGraph): Promise<unknown> | undefined {
  for (const entry of _graphs.values()) {
    if (entry.graph === graph) return entry.indexReady
  }
  return undefined
}

/**
 * Walks up from `startDir` to the nearest ancestor holding a `.git` entry —
 * the boundary every subdirectory of a checkout canonicalizes to, so a call
 * from anywhere inside the repo resolves to the same singleton. Falls back to
 * the nearest ancestor with a package.json (workspace/package root), then to
 * `startDir` itself if neither is found.
 */
export function canonicalRepoRoot(startDir: string): string {
  let dir = path.resolve(startDir)
  let packageRoot: string | undefined
  while (true) {
    if (existsSync(path.join(dir, ".git"))) return dir
    if (packageRoot === undefined && existsSync(path.join(dir, "package.json"))) packageRoot = dir
    const parent = path.dirname(dir)
    if (parent === dir) return packageRoot ?? startDir
    dir = parent
  }
}

/**
 * On-disk path for a canonical root's graph db — one file per repo root under
 * the shared data directory, mirroring how database.ts derives its path from
 * Global.Path.data (see packages/core/src/database/database.ts:43-55). Keyed
 * by a hash of the root so nested checkouts never collide.
 */
export function graphDbPath(root: string): string {
  return path.join(Global.Path.data, "graph", Hash.fast(root), "graph.db")
}

/**
 * Deletes an on-disk graph db whose stamped schema version doesn't match
 * GRAPH_SCHEMA_VERSION, so getGraph() rebuilds fresh instead of opening an
 * incompatible schema. No-op if the file doesn't exist yet.
 */
function evictStaleSchema(dbPath: string): void {
  if (!existsSync(dbPath)) return
  let version = -1
  try {
    const probe = new Database(dbPath)
    try {
      const row = probe.prepare("PRAGMA user_version").get() as { user_version: number } | undefined
      version = row?.user_version ?? 0
    } finally {
      probe.close()
    }
  } catch {
    version = -1 // unreadable/corrupt file — treat as a mismatch and rebuild fresh
  }
  if (version !== GRAPH_SCHEMA_VERSION) {
    try {
      unlinkSync(dbPath)
    } catch {
      /* best-effort */
    }
  }
}

/** Stamps GRAPH_SCHEMA_VERSION onto a freshly (re)built on-disk graph db. */
function stampSchemaVersion(dbPath: string): void {
  try {
    const probe = new Database(dbPath)
    try {
      probe.exec(`PRAGMA user_version = ${GRAPH_SCHEMA_VERSION}`)
    } finally {
      probe.close()
    }
  } catch {
    /* best-effort */
  }
}

/** Resolves (constructing on first touch) the registry entry for `startDir`'s canonical repo root. */
function getOrCreateEntry(startDir: string): GraphRegistryEntry {
  const root = canonicalRepoRoot(startDir)
  const existing = _graphs.get(root)
  if (existing) return existing

  const dbPath = graphDbPath(root)
  mkdirSync(path.dirname(dbPath), { recursive: true })
  evictStaleSchema(dbPath)

  const graph = new BunSqliteGraph(dbPath, root)
  stampSchemaVersion(dbPath)

  // Kick off the background index and keep the promise so callers can await
  // readiness (see ensureGraphReady). The catch keeps a failed index from
  // turning into an unhandled rejection.
  const indexReady = graph.index(root).catch(() => {})
  const entry: GraphRegistryEntry = { graph, indexReady }
  _graphs.set(root, entry)
  return entry
}

/**
 * Repo-root-scoped singleton: canonicalizes `startDir` (default: cwd) to its
 * repo root and returns the one graph instance shared by every call for that
 * root — a call from any subdirectory of the same checkout gets the same
 * graph and awaits the same index promise, never a second graph (memory or
 * disk) for one root. First touch persists the graph to a per-root db file
 * under the data directory (see graphDbPath) rather than an in-memory
 * throwaway, so a later process warm-starts off disk instead of re-indexing
 * from scratch.
 *
 * @sem domain=intelligence role=query
 */
export function getGraph(startDir: string = process.cwd()): BunSqliteGraph {
  return getOrCreateEntry(startDir).graph
}

/**
 * Resolve once the canonical root's graph has finished its initial index,
 * then hand back that graph. The read tools await this so the first query
 * returns real results instead of an empty cold-graph hit — without it the
 * model sees an empty result and falls back to shelling out, which it must
 * never do.
 *
 * @sem domain=intelligence role=query
 */
export async function ensureGraphReady(startDir: string = process.cwd()): Promise<BunSqliteGraph> {
  const entry = getOrCreateEntry(startDir)
  await entry.indexReady
  return entry.graph
}

/**
 * Graph-tool execute paths bound their wait on the initial index to this long
 * before degrading to a "still indexing" response — longer than the turn-open
 * risk probe's budget (RISK_PROBE_INDEX_BUDGET_MS) since a tool call the model
 * deliberately invoked is worth waiting longer for.
 */
const GRAPH_TOOL_READY_TIMEOUT_MS = 15_000

/**
 * Bounded readiness gate for graph tool execute paths: races the canonical
 * root's index promise against GRAPH_TOOL_READY_TIMEOUT_MS so a huge first
 * index can't stall a tool call forever. `ready:false` on timeout — callers
 * surface a "graph still indexing" result (or, for the read tool's entity
 * path, silently skip enrichment) instead of querying a not-yet-ready graph,
 * which would otherwise return an empty result and send the model shelling
 * out to grep.
 *
 * @sem domain=intelligence role=query
 */
export async function ensureGraphReadyBounded(
  timeoutMs: number = GRAPH_TOOL_READY_TIMEOUT_MS,
  startDir: string = process.cwd(),
): Promise<{ graph: BunSqliteGraph; ready: boolean }> {
  const entry = getOrCreateEntry(startDir)
  let timer: ReturnType<typeof setTimeout> | undefined
  const budget = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs)
  })
  try {
    const raced = await Promise.race([entry.indexReady.then(() => "ready" as const), budget])
    return { graph: entry.graph, ready: raced === "ready" }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Top entities the turn-open risk probe scores for the prompt (the focus set). */
const RISK_PROBE_ENTITY_LIMIT = 8
/**
 * The risk probe waits at most this long for the initial index before falling
 * back to 0. Turn-open latency must not hostage a whole-repo index — a cold
 * graph simply yields no risk signal that turn and warms for the next.
 */
const RISK_PROBE_INDEX_BUDGET_MS = 3000
/** Prompt tokens below this length aren't worth a graph lookup. */
const RISK_TOKEN_MIN_LEN = 4
/** Bound the number of tokens the probe searches, capping turn-open latency. */
const RISK_MAX_TOKENS = 12
/**
 * Generic english/coding words that would match unrelated hubs and inflate risk
 * for prompts that don't actually target dangerous code. Symbol-shaped tokens
 * (routeTurn, computeRisk, Tool) survive; connectives and verbs don't.
 */
const RISK_TOKEN_STOPLIST = new Set([
  "this", "that", "then", "with", "from", "into", "your", "there", "here", "when", "what", "which",
  "please", "make", "change", "update", "refactor", "implement", "function", "class", "method",
  "file", "files", "code", "test", "tests", "type", "types", "value", "return", "async", "await",
  "before", "after", "ship", "audit", "blast", "radius", "across", "core", "touched", "helper",
  "sits", "lives", "builds", "properly", "packages", "merged", "definition", "schemas", "ensure",
  "verify", "edge", "cases", "existing", "second", "receiver", "behavior", "semantics", "migration",
  "documented", "coherent", "plainly", "remains", "risky", "zero", "regressions", "tolerated",
  "anywhere",
])

/** Splits text into non-identifier-delimited chunks, each with its raw form and its dot-split pieces. */
function splitIdentifierChunks(text: string): { pieces: string[] }[] {
  const chunks: { pieces: string[] }[] = []
  for (const raw of text.split(/[^A-Za-z0-9_$.]+/)) {
    if (!raw) continue
    chunks.push({ pieces: raw.split(".") })
  }
  return chunks
}

/**
 * Identifier-shaped tokens worth resolving against the graph. Two-pass: symbol-shaped
 * tokens (camelCase/PascalCase, snake_case, `$`-prefixed, a genuine multi-part dotted
 * ref like Tool.define, or backtick-quoted in the prompt) fill the cap first so they
 * beat prose to the budget; plain prose tokens fill any remaining slots, filtered by
 * the stoplist. Drops short tokens and dedupes case-insensitively throughout.
 *
 * @sem domain=routing role=analysis
 */
export function candidateRiskTokens(prompt: string): string[] {
  const backtickTokens = new Set<string>()
  const backtickRe = /`([^`]*)`/g
  let bm: RegExpExecArray | null
  while ((bm = backtickRe.exec(prompt))) {
    for (const { pieces } of splitIdentifierChunks(bm[1])) {
      for (const piece of pieces) {
        const p = piece.trim()
        if (p) backtickTokens.add(p.toLowerCase())
      }
    }
  }

  const seen = new Set<string>()
  const symbolTokens: string[] = []
  const proseTokens: string[] = []
  for (const { pieces } of splitIdentifierChunks(prompt)) {
    // A genuine dotted ref (Tool.define) splits into 2+ non-empty pieces; a
    // trailing sentence period (e.g. "core.") splits into one piece plus "".
    const dotted = pieces.filter((p) => p.trim().length > 0).length > 1
    for (const tok of pieces) {
      const t = tok.trim()
      if (t.length < RISK_TOKEN_MIN_LEN) continue
      const lower = t.toLowerCase()
      if (seen.has(lower)) continue

      const isSymbolShaped =
        /[A-Z]/.test(t.slice(1)) ||
        t.includes("_") ||
        t.startsWith("$") ||
        (dotted && !RISK_TOKEN_STOPLIST.has(lower)) ||
        backtickTokens.has(lower)

      if (isSymbolShaped) {
        seen.add(lower)
        symbolTokens.push(t)
      } else {
        if (RISK_TOKEN_STOPLIST.has(lower)) continue
        seen.add(lower)
        proseTokens.push(t)
      }
    }
  }

  const out = symbolTokens.slice(0, RISK_MAX_TOKENS)
  for (const t of proseTokens) {
    if (out.length >= RISK_MAX_TOKENS) break
    out.push(t)
  }
  return out
}

/**
 * OL-3.3: code-structural risk for one live turn, 0–100. Resolves the prompt's
 * identifier-shaped tokens to graph entities and scores their blast-radius /
 * fan-in / centrality with computeTurnRisk — pure structural signal, no
 * prompt-text classification. Fully defensive: a cold graph, an index that
 * exceeds the latency budget, no matching entities, or any error all yield 0,
 * and the router falls back to its prompt-heaviness signal. Never throws — a
 * risk probe must not break a turn.
 *
 * @sem domain=routing role=analysis
 */
/**
 * Resolve a prompt/slice text's candidate tokens to graph entities: search
 * EVERY token (bounded — at most 12 tokens × 3 matches), union the matches,
 * and when the union exceeds the pool cap keep the highest-fan-in entities.
 * The old first-token-wins fill never even searched a decisive symbol that
 * sat past the first few tokens (run-20 replay: the fix target itself was
 * dropped), and any order-based fill still loses it to eight unique noise
 * matches — fan-in rank is position-independent. Tops `into` up to
 * RISK_PROBE_ENTITY_LIMIT; never evicts entities already in it.
 */
async function resolveRiskEntities(text: string, graph: BunSqliteGraph, into: Map<string, Entity>): Promise<void> {
  const candidates = new Map<string, Entity>()
  for (const tok of candidateRiskTokens(text)) {
    for (const e of await graph.search(tok, 3)) {
      if (!candidates.has(e.name) && !into.has(e.name)) candidates.set(e.name, e)
    }
  }
  let ranked = [...candidates.values()]
  const room = Math.max(0, RISK_PROBE_ENTITY_LIMIT - into.size)
  if (ranked.length > room) {
    const fanIn = new Map<string, number>()
    for (const e of ranked) {
      fanIn.set(e.name, (await graph.getCallers(e.key)).length)
    }
    ranked = ranked
      .sort((a, b) => (fanIn.get(b.name) ?? 0) - (fanIn.get(a.name) ?? 0))
      .slice(0, room)
  }
  for (const e of ranked) into.set(e.name, e)
}

export async function probeTurnRisk(prompt: string, graph: BunSqliteGraph = getGraph()): Promise<number> {
  try {
    // Bound the wait on the initial index: skip risk this turn rather than block
    // turn-open on a full-repo index.
    const indexReady = indexReadyFor(graph)
    if (indexReady) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const budget = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), RISK_PROBE_INDEX_BUDGET_MS)
      })
      try {
        const raced = await Promise.race([indexReady.then(() => "ready" as const), budget])
        if (raced === "timeout") return 0
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
    // graph.search matches symbol names, not sentences — resolve every candidate
    // token and round-robin the matches into the capped pool.
    const byName = new Map<string, Entity>()
    await resolveRiskEntities(prompt, graph, byName)
    if (byName.size === 0) return 0
    const turn = await computeTurnRisk(graph, [...byName.values()])
    return turn?.score ?? 0
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// OL-7.9: per-slice coupling + test-strength probes
// ---------------------------------------------------------------------------

/** At or above this computeTurnRisk score, a slice is treated as high-coupling. */
const SLICE_COUPLING_HIGH_THRESHOLD = 50

/** Coupling verdict for one decomposed slice, plus the raw score behind it. */
export interface SliceCouplingResult {
  /** 'high' when the slice's entities clear SLICE_COUPLING_HIGH_THRESHOLD; 'low' otherwise (default on any failure). */
  coupling: "low" | "high"
  /** Raw computeTurnRisk score (0–100) the verdict was derived from; 0 on any defensive fallback. */
  score: number
  /** 'graph' when the score came from a real resolved-entity turn-risk computation; 'none' on a defensive fallback. */
  confidence: "graph" | "none"
}

const SLICE_COUPLING_LOW_NONE: SliceCouplingResult = { coupling: "low", score: 0, confidence: "none" }

/**
 * OL-7.9: cross-slice coupling for one decomposed slice — scopes the same
 * risk machinery as probeTurnRisk (blast-radius / fan-in / centrality via
 * computeTurnRisk) to just this slice's resolved entities instead of a whole
 * turn. Entities resolve first from the slice's named files (exact, via
 * getEntitiesInFile) and then from the slice text's identifier-shaped tokens
 * (same resolution as probeTurnRisk), capped at RISK_PROBE_ENTITY_LIMIT.
 * Fully defensive: a cold graph, an index-latency timeout, no matches, or
 * any error all yield {coupling:"low", score:0, confidence:"none"} — coupling
 * detection never blocks a slice from being allocated.
 *
 * @sem domain=routing role=analysis
 */
export async function probeSliceCoupling(
  sliceText: string,
  files?: string[],
  graph: BunSqliteGraph = getGraph(),
): Promise<SliceCouplingResult> {
  try {
    const indexReady = indexReadyFor(graph)
    if (indexReady) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const budget = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), RISK_PROBE_INDEX_BUDGET_MS)
      })
      try {
        const raced = await Promise.race([indexReady.then(() => "ready" as const), budget])
        if (raced === "timeout") return SLICE_COUPLING_LOW_NONE
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    const byName = new Map<string, Entity>()
    for (const f of files ?? []) {
      for (const e of await graph.getEntitiesInFile(f)) {
        if (!byName.has(e.name)) byName.set(e.name, e)
        if (byName.size >= RISK_PROBE_ENTITY_LIMIT) break
      }
      if (byName.size >= RISK_PROBE_ENTITY_LIMIT) break
    }
    if (byName.size < RISK_PROBE_ENTITY_LIMIT) {
      await resolveRiskEntities(sliceText, graph, byName)
    }
    if (byName.size === 0) return SLICE_COUPLING_LOW_NONE

    const turn = await computeTurnRisk(graph, [...byName.values()])
    const score = turn?.score ?? 0
    return {
      coupling: score >= SLICE_COUPLING_HIGH_THRESHOLD ? "high" : "low",
      score,
      confidence: "graph",
    }
  } catch {
    return SLICE_COUPLING_LOW_NONE
  }
}

/** Package-root search: walk up at most this many directories looking for package.json. */
const TEST_STRENGTH_PKG_ROOT_DEPTH = 6
/** Cap on candidate test files scanned per file (bounded latency). */
const TEST_STRENGTH_TEST_SCAN_LIMIT = 50
/** package.json script names that count as "a compile target exists". */
const TEST_STRENGTH_COMPILE_SCRIPTS = ["build", "typecheck", "compile", "tsc"]

/** Which signals fired for a testStrength verdict. */
export interface SliceTestStrengthSignals {
  /** A co-located/test-dir test file referencing the file's basename or an exported symbol. */
  hasTests: boolean
  /** An ancestor tsconfig.json exists and does not exclude the file. */
  hasTypeCoverage: boolean
  /** The owning package.json declares a build/typecheck/compile script. */
  hasCompileTarget: boolean
}

/** Test-strength verdict for a slice's files, plus which signals fired. */
export interface SliceTestStrengthResult {
  /** 'testable' when any signal fired for any file; 'untestable' otherwise (pessimistic default). */
  testStrength: "testable" | "untestable"
  signals: SliceTestStrengthSignals
}

function findPackageRoot(fromFile: string): string | undefined {
  let dir = path.dirname(fromFile)
  for (let i = 0; i < TEST_STRENGTH_PKG_ROOT_DEPTH; i++) {
    if (existsSync(path.join(dir, "package.json"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/** Exported symbol names declared in a source file — a lightweight regex scan, no graph needed. */
function exportedSymbolNames(content: string): string[] {
  const names: string[] = []
  const re = /export\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(content))) names.push(m[1]!)
  // I2 — classic-idiom assignment definitions export nothing the ESM regex can
  // see; collect the dotted receiver.name (`.prototype` collapsed) so an
  // express-style suite that calls `res.send(...)` matches. Deliberately NOT
  // the bare member name — `send` alone matches everywhere and a false
  // "testable" routes to the weaker verifier, the wrong direction to be wrong.
  const assignRe = /^(\w+(?:\.\w+)*)\.(\w+)\s*=\s*(?:async\s+)?(?:function\b|\((?:[^()]|\([^()]*\))*\)\s*=>|\w+\s*=>)/gm
  while ((m = assignRe.exec(content))) {
    const receiver = m[1]!.replace(/\.prototype$/, "")
    if (receiver === "exports" || receiver === "module.exports" || receiver === "this") continue
    names.push(`${receiver}.${m[2]!}`)
  }
  return names
}

function fileHasTests(absFile: string): boolean {
  const stem = path.basename(absFile).replace(/\.[tj]sx?$/, "")
  const pkgRoot = findPackageRoot(absFile) ?? path.dirname(absFile)
  // Suffix-named tests anywhere, plus suffix-LESS files under conventional test
  // dirs (I2: express names its suite test/res.send.js — the old suffix-only
  // glob was blind to the entire directory).
  const suffixNamed = Glob.scanSync("**/*.{test,spec}.{ts,tsx,js,jsx}", {
    cwd: pkgRoot,
    absolute: true,
    dot: false,
  })
  const testDirNamed = Glob.scanSync("{test,tests,spec,specs,__tests__}/**/*.{ts,tsx,js,jsx,mjs,cjs}", {
    cwd: pkgRoot,
    absolute: true,
    dot: false,
  })
  const candidates = [...new Set([...suffixNamed, ...testDirNamed])].slice(0, TEST_STRENGTH_TEST_SCAN_LIMIT)
  if (candidates.length === 0) return false

  let symbolNames: string[] = []
  try {
    symbolNames = exportedSymbolNames(readFileSync(absFile, "utf8"))
  } catch { /* source unreadable — basename check still applies */ }

  for (const testFile of candidates) {
    let content: string
    try {
      content = readFileSync(testFile, "utf8")
    } catch { continue }
    if (content.includes(stem)) return true
    if (symbolNames.some((name) => content.includes(name))) return true
  }
  return false
}

function hasTypeCoverage(absFile: string): boolean {
  if (!/\.tsx?$/.test(absFile)) return false
  const pkgRoot = findPackageRoot(absFile)
  if (!pkgRoot) return false
  const tsconfigPath = path.join(pkgRoot, "tsconfig.json")
  if (!existsSync(tsconfigPath)) return false
  try {
    const raw = readFileSync(tsconfigPath, "utf8")
    const stripped = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
    const parsed = JSON.parse(stripped) as { exclude?: string[] }
    const rel = path.relative(pkgRoot, absFile)
    const excluded = (parsed.exclude ?? []).some((pattern) => rel.startsWith(pattern.replace(/\/\*\*.*$/, "")))
    return !excluded
  } catch {
    // tsconfig present but unparseable (comments/trailing commas beyond our strip) —
    // still coverage-shaped: a real tsc run would pick the file up.
    return true
  }
}

function hasCompileTarget(absFile: string): boolean {
  const pkgRoot = findPackageRoot(absFile)
  if (!pkgRoot) return false
  const pkgJsonPath = path.join(pkgRoot, "package.json")
  if (!existsSync(pkgJsonPath)) return false
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { scripts?: Record<string, string> }
    const scripts = pkg.scripts ?? {}
    return TEST_STRENGTH_COMPILE_SCRIPTS.some((name) => name in scripts)
  } catch {
    return false
  }
}

/**
 * OL-7.9: does a sound check exist for this slice's files — the axis the
 * (coupling × test-strength) matrix needs to decide whether default-cheap
 * execution is safe. Per file, checks (a) a co-located/test-dir test file
 * whose content references the file's basename or an exported symbol
 * (regex-scanned, no graph lookup needed), (b) tsconfig coverage (an
 * ancestor tsconfig.json that doesn't exclude the file), (c) a compile
 * target (the owning package.json declares a build/typecheck/compile
 * script). Any signal firing on any file marks the whole slice testable.
 * Fully defensive: a missing file, unreadable tsconfig/package.json, or any
 * error simply drops that file's contribution rather than throwing; total
 * failure to resolve anything yields "untestable" — the pessimistic default
 * routes to the stronger verifier, which is the safe direction to be wrong in.
 *
 * @sem domain=routing role=analysis
 */
export async function probeSliceTestStrength(files: string[]): Promise<SliceTestStrengthResult> {
  const signals: SliceTestStrengthSignals = {
    hasTests: false,
    hasTypeCoverage: false,
    hasCompileTarget: false,
  }
  try {
    for (const file of files ?? []) {
      const absFile = path.isAbsolute(file) ? file : path.join(process.cwd(), file)
      try {
        if (!signals.hasTests && fileHasTests(absFile)) signals.hasTests = true
      } catch { /* defensive — this file contributes nothing to hasTests */ }
      try {
        if (!signals.hasTypeCoverage && hasTypeCoverage(absFile)) signals.hasTypeCoverage = true
      } catch { /* defensive — this file contributes nothing to hasTypeCoverage */ }
      try {
        if (!signals.hasCompileTarget && hasCompileTarget(absFile)) signals.hasCompileTarget = true
      } catch { /* defensive — this file contributes nothing to hasCompileTarget */ }
    }
  } catch {
    return { testStrength: "untestable", signals: { hasTests: false, hasTypeCoverage: false, hasCompileTarget: false } }
  }
  const testStrength: "testable" | "untestable" =
    signals.hasTests || signals.hasTypeCoverage || signals.hasCompileTarget ? "testable" : "untestable"
  return { testStrength, signals }
}

/** package.json script names that yield sound-rung commands, checked in this order (F2). */
const VERIFY_SCRIPT_KINDS: ReadonlyArray<{ script: string; kind: VerifyCommand["kind"] }> = [
  { script: "typecheck", kind: "typecheck" },
  { script: "test", kind: "test" },
  { script: "lint", kind: "lint" },
]

/**
 * Sound-rung contract: a verify command must be side-effect-free and
 * terminating. A script that rewrites the tree (--write/--fix) or never
 * exits (--watch/-w) is not a check, so it's excluded even when its name
 * matches typecheck/test/lint. Deliberately conservative — a false skip only
 * degrades to the ladder's other rungs, a false emit mutates the user's tree.
 */
const MUTATING_OR_NONTERMINATING_SCRIPT_RE = /(?:^|\s)(?:--write|--fix|--watch|-w)\b/

/**
 * F2 — repo-derived sound-rung commands for a slice whose text names none:
 * resolve the owning package root of the slice's files (cwd's own package.json
 * as the fallback), read its scripts, and emit `<pm> run <script>` for the
 * typecheck/test/lint scripts that exist, package manager detected from the
 * lockfile. Each command cd's to its package root so a monorepo slice verifies
 * in the right package regardless of the runner's cwd. Fully defensive: any
 * unreadable root contributes nothing; no root with scripts ⇒ [] (the sound
 * rung stays inapplicable, exactly as before this probe existed). Scripts
 * carrying a mutation or watch flag (e.g. `biome lint --write`, `vitest --watch`)
 * are skipped so verification never edits the tree or hangs on the runner timeout.
 *
 * @sem domain=routing role=analysis
 */
export async function probeSliceVerifyCommands(files: string[]): Promise<VerifyCommand[]> {
  try {
    const roots: string[] = []
    for (const file of files ?? []) {
      const absFile = path.isAbsolute(file) ? file : path.join(process.cwd(), file)
      const root = findPackageRoot(absFile)
      if (root && !roots.includes(root)) roots.push(root)
    }
    if (roots.length === 0 && existsSync(path.join(process.cwd(), "package.json"))) roots.push(process.cwd())
    for (const root of roots) {
      try {
        const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
          scripts?: Record<string, string>
        }
        const scripts = pkg.scripts ?? {}
        const pm =
          existsSync(path.join(root, "bun.lock")) || existsSync(path.join(root, "bun.lockb"))
            ? "bun"
            : existsSync(path.join(root, "pnpm-lock.yaml"))
              ? "pnpm"
              : existsSync(path.join(root, "yarn.lock"))
                ? "yarn"
                : "npm"
        const commands = VERIFY_SCRIPT_KINDS.filter(
          ({ script }) => script in scripts && !MUTATING_OR_NONTERMINATING_SCRIPT_RE.test(scripts[script]),
        ).map(({ script, kind }) => ({
          kind,
          command: `cd "${root}" && ${pm} run ${script}`,
        }))
        if (commands.length > 0) return commands
      } catch {
        /* this root contributes nothing */
      }
    }
    return []
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// recon
// ---------------------------------------------------------------------------

const ReconParameters = Schema.Struct({
  task: Schema.String.annotate({
    description:
      "Natural-language task phrase describing what you need to do. " +
      "Returns entities + references + notes in one shot.",
  }),
  cache_ref: Schema.optional(Schema.String).annotate({
    description:
      "Hash from a prior `ur|cache-ref` / `_meta.cache_ref` marker — returns the " +
      "withheld full-body slice from local cache (~0ms recompute).",
  }),
  offset: Schema.optional(Schema.Number).annotate({
    description: "0-based slice offset when using cache_ref (default 0).",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Max entities in the lean index (default 10); page size for cache_ref.",
  }),
})

/**
 * `recon` tool: graph-backed task-phrase → bundle. Replaces the fan-out of
 * multiple search+read calls with a single tool invocation.
 *
 * @sem domain=intelligence role=tools
 */
export const GraphReconTool = Tool.define(
  "recon",
  Effect.succeed({
    description:
      "Return a lean recon bundle for a natural-language task phrase: entities with " +
      "signature + 15-line preview + caller_count, their references, and anchored notes. " +
      "Full bodies are cached — follow up with cache_ref to page them in without recompute. " +
      "ur|rsk lines are emitted for chokepoint entities (fan-in ≥ 10).",
    parameters: ReconParameters,
    execute: (input: Schema.Schema.Type<typeof ReconParameters>, _ctx: Tool.Context) => {
      // cache_ref fast-path: return a withheld body slice without recomputing.
      if (input.cache_ref) {
        return Effect.promise(async () => {
          const offset = input.offset ?? 0
          const lim = input.limit ?? 5
          const slice = getSlice(input.cache_ref!, offset, lim)
          if (!slice) {
            return {
              title: "recon",
              metadata: {} as Record<string, unknown>,
              output: JSON.stringify({ error: "cache_ref not found; resubmit the original query to recompute" }),
            }
          }
          return {
            title: "recon",
            metadata: {} as Record<string, unknown>,
            output: JSON.stringify(
              { cache_ref: input.cache_ref, offset, total: slice.total, more: slice.more, items: slice.slice },
              null,
              2,
            ),
          }
        })
      }

      const root = process.cwd()
      return Effect.promise(async () => {
        const gate = await ensureGraphReadyBounded()
        if (!gate.ready) {
          const output = "Graph still indexing the repo — retry this call shortly for full results."
          const meta = withMeta(output, output)
          recordToolCall({ tool: "recon", ...meta })
          return { title: "recon", metadata: { meta } as Record<string, unknown>, output }
        }
        const rawOutput = await makeReconTool(gate.graph).execute(input as Record<string, unknown>)

        let parsed: unknown
        try { parsed = JSON.parse(rawOutput) } catch {
          const meta = withMeta(rawOutput, rawOutput)
          recordToolCall({ tool: "recon", ...meta })
          return { title: "recon", metadata: { meta } as Record<string, unknown>, output: rawOutput }
        }

        const bundle = parsed as { entities?: unknown[]; references?: unknown[]; notes?: unknown[] }
        const entityList: LeanEntity[] = Array.isArray(bundle?.entities)
          ? (bundle.entities as LeanEntity[])
          : []

        const queryCacheKey = hashInputs(String(input.task), "recon")
        const { lean, cacheKey, total, signals } = await enrichEntities(entityList, root, queryCacheKey)

        const leanBundle = { ...bundle, entities: lean }
        const leanJson = JSON.stringify(
          { ...leanBundle, _meta: { cache_ref: cacheKey, total, more: false } },
          null,
          2,
        )
        const signalBlock = signals.length > 0 ? "\n\n" + signals.join("\n") : ""
        const output = leanJson + signalBlock

        const meta = withMeta(rawOutput, output)
        recordToolCall({ tool: "recon", ...meta })
        return {
          title: "recon",
          metadata: { meta } as Record<string, unknown>,
          output,
        }
      })
    },
  }),
)


// ---------------------------------------------------------------------------
// get_references
// ---------------------------------------------------------------------------

const GetReferencesParameters = Schema.Struct({
  entity: Schema.String.annotate({
    description: "Entity name or stable key (<filePath>:<name>:<kind>).",
  }),
  direction: Schema.optional(
    Schema.Literals(["callers", "callees"]).annotate({
      description:
        "callers = who calls/imports this entity (fan-in, default); " +
        "callees = what this entity calls/imports.",
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed("callers" as const))),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Max references to return (default 25).",
  }),
  include_text_occurrences: Schema.optional(Schema.Boolean).annotate({
    description:
      "Default false. Set true for a RENAME — also returns word-boundary literal matches of " +
      "the entity name the call graph cannot see. Only applies with direction:'callers'.",
  }),
})

/**
 * `get_references` tool: returns the caller list (blast radius) or callee
 * list for a named entity, backed by the in-process SQLite graph.
 *
 * @sem domain=intelligence role=tools
 */
export const GraphGetReferencesTool = Tool.define(
  "get_references",
  Effect.succeed({
    description:
      "Return the caller list (fan-in) or callee list (outgoing imports/calls) for a " +
      "named entity. Use direction='callers' to see blast radius; 'callees' for dependencies.",
    parameters: GetReferencesParameters,
    execute: (
      input: Schema.Schema.Type<typeof GetReferencesParameters>,
      _ctx: Tool.Context,
    ) =>
      Effect.promise(async () => {
        const root = process.cwd()
        const gate = await ensureGraphReadyBounded()
        if (!gate.ready) {
          const output = "Graph still indexing the repo — retry this call shortly for full results."
          const meta = withMeta(output, output)
          recordToolCall({ tool: "get_references", ...meta })
          return { title: "get_references", metadata: { meta } as Record<string, unknown>, output }
        }
        return makeGetReferencesTool(gate.graph, root)
          .execute(input as Record<string, unknown>)
          .then((output: string) => {
            const meta = withMeta(output, output)
            recordToolCall({ tool: "get_references", ...meta })
            return {
              title: "get_references",
              metadata: { meta } as Record<string, unknown>,
              output,
            }
          })
      }),
  }),
)

// ---------------------------------------------------------------------------
// search (symbol / literal / regex / task-phrase modes)
// ---------------------------------------------------------------------------

const SearchCodeParameters = Schema.Struct({
  query: Schema.String.annotate({
    description:
      "Symbol name, task phrase, or search pattern. " +
      "Returns lean index by default (signatures, line ranges, caller counts, 15-line preview; no full source). " +
      "Full bodies are cached — follow up with cache_ref to page them in without recompute.",
  }),
  cache_ref: Schema.optional(Schema.String).annotate({
    description:
      "Hash from a prior `_meta.cache_ref` marker — returns the withheld full-body slice " +
      "from local cache (~0ms recompute). Pair with offset/limit to page.",
  }),
  offset: Schema.optional(Schema.Number).annotate({
    description: "0-based slice offset when using cache_ref (default 0).",
  }),
  mode: Schema.optional(Schema.String).annotate({
    description:
      "symbol = ranked name matches; literal = exact string search; regex = regex search; " +
      "glob = filename-pattern matching (query is the glob pattern, path sets the root); " +
      "refs = callers/callees of a named entity (pair with direction). " +
      "Omit for default task-phrase recon.",
  }),
  kind: Schema.optional(Schema.String).annotate({
    description: "Entity kind filter (symbol mode): function | class | type | variable | method | interface.",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Max results (default 20); page size when using cache_ref; cap for refs mode (default 25).",
  }),
  context: Schema.optional(Schema.Number).annotate({
    description: "Context lines per match for literal/regex mode (default 2, max 6).",
  }),
  include_body: Schema.optional(Schema.Boolean).annotate({
    description: "Include full source body for each matched entity (symbol mode).",
  }),
  want: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Attach callers/callees/imports to each result (symbol/task mode).",
  }),
  // glob mode
  path: Schema.optional(Schema.String).annotate({
    description: "Directory to search within (glob mode; defaults to cwd). Absolute or cwd-relative.",
  }),
  // refs mode
  direction: Schema.optional(Schema.String).annotate({
    description: "callers (default) | callees — which direction to traverse the call graph (refs mode).",
  }),
  include_text_occurrences: Schema.optional(Schema.Boolean).annotate({
    description:
      "Also return word-boundary literal matches the call graph cannot see (refs mode, direction=callers). " +
      "Use for RENAME tasks.",
  }),
})

/**
 * `search` tool: unified code-navigation entry point — symbol name
 * matches, content search (literal/regex), filename glob, caller/callee refs,
 * or task-phrase recon bundle. Subsumes recon, grep, glob, and get_references.
 *
 * @sem domain=intelligence role=tools
 */
export const GraphSearchCodeTool = Tool.define(
  "search",
  Effect.gen(function* () {
    const ripgrep = yield* Ripgrep.Service
    return {
    description:
      "Unified code search and navigation. Modes:\n" +
      "  (default) task-phrase recon — entities + callers + notes in one bundle\n" +
      "  symbol    — ranked name matches with signatures and caller counts\n" +
      "  literal   — exact string search with context lines (replaces grep)\n" +
      "  regex     — regex search with context lines (replaces grep)\n" +
      "  glob      — filename-pattern matching; query is the glob pattern (replaces glob tool)\n" +
      "  refs      — callers/callees of a named entity; pair with direction (replaces get_references)\n" +
      "Returns lean index by default — signatures, line ranges, caller counts, 15-line preview. " +
      "Full bodies are cached under _meta.cache_ref; supply cache_ref+offset to page them in. " +
      "ur|rsk lines are emitted for chokepoint entities (fan-in ≥ 10).",
    parameters: SearchCodeParameters,
    execute: (input: Schema.Schema.Type<typeof SearchCodeParameters>, _ctx: Tool.Context) => {
      // cache_ref fast-path: return a withheld full-body slice without recomputing.
      if (input.cache_ref) {
        return Effect.promise(async () => {
          const offset = input.offset ?? 0
          const lim = input.limit ?? 5
          const slice = getSlice(input.cache_ref!, offset, lim)
          if (!slice) {
            return {
              title: "search",
              metadata: {} as Record<string, unknown>,
              output: JSON.stringify({ error: "cache_ref not found; resubmit the original query to recompute" }),
            }
          }
          return {
            title: "search",
            metadata: {} as Record<string, unknown>,
            output: JSON.stringify(
              { cache_ref: input.cache_ref, offset, total: slice.total, more: slice.more, items: slice.slice },
              null,
              2,
            ),
          }
        })
      }

      const root = process.cwd()

      // -----------------------------------------------------------------------
      // glob mode: filename-pattern matching via Glob.scanSync.
      // Subsumes the standalone GlobTool. Does not filter by .gitignore
      // (use searchCode mode:'regex' with an include pattern for that).
      // -----------------------------------------------------------------------
      if (input.mode === "glob") {
        return Effect.promise(async () => {
          const searchDir = input.path ?? root
          const files = Glob.scanSync(input.query, { cwd: searchDir, absolute: true, dot: true })
          const cap = 100
          const truncated = files.length > cap
          const listed = files.slice(0, cap)
          const output =
            listed.length === 0
              ? "No files found"
              : listed.join("\n") +
                (truncated
                  ? `\n\n(Showing first ${cap} of ${files.length} matches. Use a more specific pattern.)`
                  : "")
          const meta = withMeta(output, output)
          recordToolCall({ tool: "search", ...meta })
          return {
            title: "search",
            metadata: { meta, mode: "glob", count: files.length, truncated } as Record<string, unknown>,
            output,
          }
        })
      }

      // -----------------------------------------------------------------------
      // refs mode: callers/callees of a named entity via the in-process graph.
      // Subsumes the standalone GraphGetReferencesTool.
      // -----------------------------------------------------------------------
      if (input.mode === "refs") {
        return Effect.promise(async () => {
          const gate = await ensureGraphReadyBounded()
          if (!gate.ready) {
            const output = "Graph still indexing the repo — retry this call shortly for full results."
            const meta = withMeta(output, output)
            recordToolCall({ tool: "search", ...meta })
            return { title: "search", metadata: { meta, mode: "refs" } as Record<string, unknown>, output }
          }
          const refsInput: Record<string, unknown> = {
            entity: input.query,
            direction: input.direction ?? "callers",
            limit: input.limit ?? 25,
            include_text_occurrences: input.include_text_occurrences ?? false,
          }
          const output = await makeGetReferencesTool(gate.graph, root).execute(refsInput)
          const meta = withMeta(output, output)
          recordToolCall({ tool: "search", ...meta })
          return {
            title: "search",
            metadata: { meta, mode: "refs" } as Record<string, unknown>,
            output,
          }
        })
      }

      return Effect.promise(async () => {
        const gate = await ensureGraphReadyBounded()
        if (!gate.ready) {
          const output = "Graph still indexing the repo — retry this call shortly for full results."
          const meta = withMeta(output, output)
          recordToolCall({ tool: "search", ...meta })
          return { title: "search", metadata: { meta } as Record<string, unknown>, output }
        }
        const rawOutput = await makeSearchCodeTool(gate.graph, root).execute(
          input as Record<string, unknown>,
        )

        // Literal/regex modes: content search — try indexed files first, fall back to ripgrep.
        const mode = input.mode
        if (mode === "literal" || mode === "regex") {
          // Trigger ripgrep fallback when the indexed search returned no matches
          let isIndexedEmpty = false
          try {
            const parsed = JSON.parse(rawOutput)
            if (Array.isArray(parsed)) isIndexedEmpty = parsed.length === 0
          } catch { /* rawOutput not JSON */ }
          if (!isIndexedEmpty) isIndexedEmpty = !rawOutput || rawOutput.trim() === ""

          if (isIndexedEmpty) {
            const cwd = input.path ?? root
            const pattern =
              mode === "literal"
                ? input.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
                : input.query
            try {
              const rgResult = await Effect.runPromise(
                ripgrep.grep({ cwd, pattern, limit: 100 }),
              )
              if (rgResult.length > 0) {
                const rows = rgResult.map((item) => ({
                  path: path.resolve(cwd, item.entry.path),
                  line: item.line,
                  text: item.text,
                }))
                const truncated = rows.length === 100
                const lines = [
                  `Found ${rows.length} matches${truncated ? " (more available)" : ""} [ripgrep fallback]`,
                ]
                let current = ""
                for (const match of rows) {
                  if (current !== match.path) {
                    if (current !== "") lines.push("")
                    current = match.path
                    lines.push(`${match.path}:`)
                  }
                  lines.push(`  Line ${match.line}: ${match.text}`)
                }
                if (truncated) lines.push("\n(Results truncated. Use a more specific pattern.)")
                const output = lines.join("\n")
                const meta = withMeta(rawOutput, output)
                recordToolCall({ tool: "search", ...meta })
                return {
                  title: "search",
                  metadata: { meta, mode, fallback: "ripgrep" } as Record<string, unknown>,
                  output,
                }
              }
            } catch { /* ripgrep unavailable — return indexed output */ }
          }

          const meta = withMeta(rawOutput, rawOutput)
          recordToolCall({ tool: "search", ...meta })
          return {
            title: "search",
            metadata: { meta } as Record<string, unknown>,
            output: rawOutput,
          }
        }

        // Symbol / task-phrase modes: enrich entity list with lean-index projection.
        let parsed: unknown
        try { parsed = JSON.parse(rawOutput) } catch {
          const meta = withMeta(rawOutput, rawOutput)
          recordToolCall({ tool: "search", ...meta })
          return { title: "search", metadata: { meta } as Record<string, unknown>, output: rawOutput }
        }

        const isBundle =
          parsed !== null &&
          typeof parsed === "object" &&
          !Array.isArray(parsed) &&
          "entities" in (parsed as object)
        const entityList: LeanEntity[] = isBundle
          ? ((parsed as { entities: unknown[] }).entities as LeanEntity[])
          : Array.isArray(parsed)
            ? (parsed as LeanEntity[])
            : []

        if (entityList.length === 0) {
          const meta = withMeta(rawOutput, rawOutput)
          recordToolCall({ tool: "search", ...meta })
          return { title: "search", metadata: { meta } as Record<string, unknown>, output: rawOutput }
        }

        const queryCacheKey = hashInputs(String(input.query), mode ?? "task")
        const { lean, cacheKey, total, signals } = await enrichEntities(entityList, root, queryCacheKey)

        const leanParsed = isBundle ? { ...(parsed as object), entities: lean } : lean
        const leanJson = JSON.stringify(
          { ...leanParsed, _meta: { cache_ref: cacheKey, total, more: false } },
          null,
          2,
        )
        const signalBlock = signals.length > 0 ? "\n\n" + signals.join("\n") : ""
        const output = leanJson + signalBlock

        const meta = withMeta(rawOutput, output)
        recordToolCall({ tool: "search", ...meta })
        return {
          title: "search",
          metadata: { meta } as Record<string, unknown>,
          output,
        }
      })
    },
  }
  }),
)

// ---------------------------------------------------------------------------
// file_outline
// ---------------------------------------------------------------------------

const FileOutlineParameters = Schema.Struct({
  file_path: Schema.String.annotate({
    description: "File path (absolute or relative to the repo root).",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Max entities to return (default 30, max 100).",
  }),
  token_budget: Schema.optional(Schema.Number).annotate({
    description: "Max response tokens (default 400).",
  }),
})

/**
 * `file_outline` tool: structural outline of a source file — entities (name,
 * kind, line range), import/export list. Backed by the in-process graph with
 * AST fallback during background indexing.
 *
 * @sem domain=intelligence role=tools
 */
export const GraphFileOutlineTool = Tool.define(
  "file_outline",
  Effect.succeed({
    description:
      "Structural outline of a source file — entities (name, kind, line range), import/export list. " +
      "Call before reading large files; pair with read(entity:) for targeted access.",
    parameters: FileOutlineParameters,
    execute: (input: Schema.Schema.Type<typeof FileOutlineParameters>, _ctx: Tool.Context) => {
      const root = process.cwd()
      return Effect.promise(async () => {
        const gate = await ensureGraphReadyBounded()
        if (!gate.ready) {
          const output = "Graph still indexing the repo — retry this call shortly for full results."
          const meta = withMeta(output, output)
          recordToolCall({ tool: "file_outline", ...meta })
          return { title: "file_outline", metadata: { meta } as Record<string, unknown>, output }
        }
        return makeFileOutlineTool(gate.graph, root)
          .execute(input as Record<string, unknown>)
          .then((output: string) => {
            const meta = withMeta(output, output)
            recordToolCall({ tool: "file_outline", ...meta })
            return {
              title: "file_outline",
              metadata: { meta } as Record<string, unknown>,
              output,
            }
          })
      })
    },
  }),
)

// ---------------------------------------------------------------------------
// note_save
// ---------------------------------------------------------------------------

const NoteSaveParameters = Schema.Struct({
  note: Schema.optional(Schema.String).annotate({
    description:
      "Wire-format note: kind|anchor|polarity|content (e.g. \"rul|f:src/x.ts|-|no intelligence imports\"). " +
      "Use this OR the structured kind/anchor/polarity/content fields below, not both.",
  }),
  kind: Schema.optional(Schema.String).annotate({
    description: "Note kind (structured form): cnv | rul | wrn | dec | blk | fct.",
  }),
  anchor: Schema.optional(Schema.String).annotate({
    description: "Anchor (structured form): f:<path> | e:<entity> | g:<glob> | p: (project-wide).",
  }),
  polarity: Schema.optional(Schema.String).annotate({
    description: "Polarity (structured form): + (do) | - (don't) | ~ (mixed/ambiguous).",
  }),
  content: Schema.optional(Schema.String).annotate({
    description: "Content (structured form): a single line of prose (newlines are stripped).",
  }),
})

/**
 * `note_save` tool: persists a single anchored note (wire string or
 * structured fields) to the graph's notes store, backed by the in-process
 * SQLite graph — the model-invokable path that gives
 * BunSqliteGraph.upsertNote its production caller.
 *
 * @sem domain=intelligence role=tools
 */
export const GraphNoteSaveTool = Tool.define(
  "note_save",
  Effect.succeed({
    description:
      "Persist a single anchored note to the graph's notes store: pass either `note` " +
      "(wire string kind|anchor|polarity|content) or the structured kind/anchor/polarity/content " +
      "fields. Validates kind/anchor-prefix/polarity before saving; returns a descriptive error " +
      "on invalid input instead of throwing.",
    parameters: NoteSaveParameters,
    execute: (input: Schema.Schema.Type<typeof NoteSaveParameters>, _ctx: Tool.Context) =>
      Effect.promise(async () => {
        const gate = await ensureGraphReadyBounded()
        if (!gate.ready) {
          const output = "Graph still indexing the repo — retry this call shortly for full results."
          const meta = withMeta(output, output)
          recordToolCall({ tool: "note_save", ...meta })
          return { title: "note_save", metadata: { meta } as Record<string, unknown>, output }
        }
        return makeNoteSaveTool(gate.graph)
          .execute(input as Record<string, unknown>)
          .then((output: string) => {
            const meta = withMeta(output, output)
            recordToolCall({ tool: "note_save", ...meta })
            return {
              title: "note_save",
              metadata: { meta } as Record<string, unknown>,
              output,
            }
          })
      }),
  }),
)
