/**
 * In-process code graph backed by bun:sqlite. Walks a repo, extracts entities
 * and import edges using the regex extractor (WASM tree-sitter upgrade when
 * available), and stores them in a local SQLite DB for sub-millisecond queries.
 *
 * @sem domain=intelligence role=database
 */

import { Database } from "bun:sqlite"
import { readdir, readFile, stat } from "node:fs/promises"
import { join, relative, extname } from "node:path"
import { createHash } from "node:crypto"
import { extractEntities, extractEdges, detectLanguage, type ExtractedEntity } from "./ast-extractor.js"
import type { CodeIntelligence, Entity, Reference, ReconBundle } from "./index.js"
import type { AnchoredNote } from "./memory.js"
import { computeRisk } from "./risk.js"
import type { RiskGraph } from "./risk.js"

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = /* sql */ `
  CREATE TABLE IF NOT EXISTS files (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    path        TEXT    NOT NULL UNIQUE,
    content_hash TEXT   NOT NULL,
    indexed_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS entities (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path    TEXT    NOT NULL,
    name         TEXT    NOT NULL,
    kind         TEXT    NOT NULL,
    signature    TEXT    NOT NULL DEFAULT '',
    line_start   INTEGER NOT NULL,
    line_end     INTEGER NOT NULL,
    content_hash TEXT    NOT NULL,
    parent_class TEXT,
    domain       TEXT,
    role         TEXT,
    summary      TEXT,
    UNIQUE(file_path, name, kind)
  );

  CREATE TABLE IF NOT EXISTS edges (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    from_file   TEXT    NOT NULL,
    from_entity TEXT    NOT NULL DEFAULT '',
    to_entity   TEXT    NOT NULL,
    to_file     TEXT,
    edge_kind   TEXT    NOT NULL DEFAULT 'import'
  );

  CREATE INDEX IF NOT EXISTS idx_entities_name  ON entities(name);
  CREATE INDEX IF NOT EXISTS idx_entities_file  ON entities(file_path);
  CREATE INDEX IF NOT EXISTS idx_edges_from_ent ON edges(from_entity);
  CREATE INDEX IF NOT EXISTS idx_edges_to_ent   ON edges(to_entity);
  CREATE INDEX IF NOT EXISTS idx_edges_from_file ON edges(from_file);
  CREATE INDEX IF NOT EXISTS idx_edges_to_file  ON edges(to_file);

  CREATE TABLE IF NOT EXISTS notes (
    anchor     TEXT NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'fct',
    polarity   TEXT NOT NULL DEFAULT '+',
    content    TEXT NOT NULL,
    stale      INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY(anchor, kind, content)
  );
  CREATE INDEX IF NOT EXISTS idx_notes_anchor ON notes(anchor);
`

// ---------------------------------------------------------------------------
// Directory walk helpers
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".turbo", "out", "coverage"])

async function walkFiles(dir: string, root: string, results: string[]): Promise<void> {
  let entries: import("node:fs").Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const name = String(entry.name)
    if (name.startsWith(".") || SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    if (entry.isDirectory()) {
      await walkFiles(full, root, results)
    } else if (entry.isFile() && detectLanguage(name) !== null) {
      results.push(full)
    }
  }
}

// ---------------------------------------------------------------------------
// Entity key helper
// ---------------------------------------------------------------------------

function makeKey(filePath: string, name: string, kind: string): string {
  return `${filePath}:${name}:${kind}`
}

function rowToEntity(row: Record<string, unknown>, root: string): Entity {
  const filePath = relative(root, String(row["file_path"] ?? ""))
  return {
    key: makeKey(filePath, String(row["name"] ?? ""), String(row["kind"] ?? "")),
    name: String(row["name"] ?? ""),
    kind: String(row["kind"] ?? ""),
    filePath,
    lineStart: Number(row["line_start"] ?? 0),
    lineEnd: Number(row["line_end"] ?? 0),
    signature: String(row["signature"] ?? ""),
    parentClass: row["parent_class"] ? String(row["parent_class"]) : undefined,
    contentHash: String(row["content_hash"] ?? ""),
    domain: row["domain"] ? String(row["domain"]) : undefined,
    role: row["role"] ? String(row["role"]) : undefined,
    summary: row["summary"] ? String(row["summary"]) : undefined,
  }
}

function rowToReference(row: Record<string, unknown>, root: string): Reference {
  return {
    fromEntity: String(row["from_entity"] ?? ""),
    fromFile: relative(root, String(row["from_file"] ?? "")),
    toEntity: String(row["to_entity"] ?? ""),
    kind: String(row["edge_kind"] ?? "reference"),
  }
}

// ---------------------------------------------------------------------------
// Tokenization (search/recon query prep + FTS index content prep — both
// sides share this vocabulary so a query term matches a pre-split name/
// signature token)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "the", "is", "are", "a", "an", "of", "to", "for", "and", "or", "in", "on",
  "at", "by", "with", "this", "that", "where", "how", "what", "which", "who",
  "whom", "when", "why", "does", "do", "did", "was", "were", "be", "been",
  "being", "it", "its", "as", "from", "into", "onto", "about", "if", "then",
  "than", "but", "not", "no",
])

/** Split on any run of non-alphanumeric characters (whitespace, punctuation, snake/kebab separators). */
function splitWords(raw: string): string[] {
  return raw.split(/[^A-Za-z0-9]+/).filter(Boolean)
}

/** Split a single word on camelCase boundaries (getUserById -> get, User, By, Id -> further lowercased below). */
function splitCamel(word: string): string[] {
  return word
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean)
}

/** Lowercased token stream for a name/signature/domain/role blob — used to build FTS index content and to tokenize an incoming query so both sides match. */
function tokenize(text: string): string[] {
  const out: string[] = []
  for (const word of splitWords(text)) {
    for (const part of splitCamel(word)) out.push(part.toLowerCase())
  }
  return out
}

/** Tokenize a search/recon query: split + lowercase, drop stopwords and <=2 char tokens, dedupe. */
function tokenizeQuery(query: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const token of tokenize(query)) {
    if (token.length <= 2 || STOPWORDS.has(token) || seen.has(token)) continue
    seen.add(token)
    out.push(token)
  }
  return out
}

// ---------------------------------------------------------------------------
// Glob-anchor matching (g:<glob> notes vs a queried f:<path> anchor)
// ---------------------------------------------------------------------------

/** Manual glob→RegExp translation used only if Bun.Glob throws on a pattern: `**` crosses path separators, `*` and `?` don't. */
function globToRegExp(pattern: string): RegExp {
  let re = ""
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*"
        i++
      } else {
        re += "[^/]*"
      }
    } else if (c === "?") {
      re += "[^/]"
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c
    } else {
      re += c
    }
  }
  return new RegExp(`^${re}$`)
}

/** True when filePath matches glob pattern. Prefers the runtime-native Bun.Glob; falls back to a manual regex translation if Bun.Glob throws on a malformed pattern. */
function matchesGlob(pattern: string, filePath: string): boolean {
  try {
    return new Bun.Glob(pattern).match(filePath)
  } catch {
    try {
      return globToRegExp(pattern).test(filePath)
    } catch {
      return false
    }
  }
}

// ---------------------------------------------------------------------------
// BunSqliteGraph
// ---------------------------------------------------------------------------

/**
 * Concrete CodeIntelligence implementation using bun:sqlite as the backing
 * store. Graph-query methods (getEntity, getReferences, getCallers, search,
 * riskScore) plus a local FTS5-ranked recon/compress are fully implemented
 * here; a richer unerr-brain UDS proxy can still supersede recon/compress
 * for production use.
 *
 * @sem domain=intelligence role=database
 */
export class BunSqliteGraph implements CodeIntelligence {
  private db: Database
  private root: string
  private ftsAvailable: boolean = false

  constructor(dbPath: string = ":memory:", root: string = process.cwd()) {
    this.db = new Database(dbPath)
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
    this.db.exec(SCHEMA)
    // Migrations: add semantic columns to existing DBs (no-op if already present)
    try { this.db.exec("ALTER TABLE entities ADD COLUMN domain TEXT") } catch { /* already exists */ }
    try { this.db.exec("ALTER TABLE entities ADD COLUMN role TEXT") } catch { /* already exists */ }
    // FTS5 index over tokenized name/summary/signature/domain/role, keyed by
    // file_path/entity_name/entity_kind so a hit resolves back to an
    // entities row without a rowid-synced external-content table. Guarded —
    // search() falls back to the LIKE path if fts5 isn't compiled in.
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
          name_text, summary_text, sig_text, domain_text, role_text,
          file_path UNINDEXED, entity_name UNINDEXED, entity_kind UNINDEXED
        )
      `)
      this.ftsAvailable = true
    } catch {
      this.ftsAvailable = false
    }
    this.root = root
  }

  // -------------------------------------------------------------------------
  // Indexing
  // -------------------------------------------------------------------------

  /**
   * Walk repoPath, extract entities and import/call edges, upsert into
   * SQLite. Skips files whose content hash hasn't changed since last index
   * run. A changed file's entities and outgoing edges are deleted and
   * re-inserted wholesale (no ghost rows from renamed/removed entities);
   * after the walk, any file no longer on disk has its entities, edges
   * (either direction), and files row purged too. The same per-file
   * delete/insert cycle keeps the entities_fts full-text index (tokenized
   * name/summary/signature/domain/role) in sync. After the ghost-file purge, an
   * f:<path> note is flagged stale=1 if its file is now gone or stale=0 if
   * it has reappeared — the row itself is kept for audit either way.
   *
   * @sem domain=intelligence role=indexing
   */
  async index(repoPath: string): Promise<{ files: number; entities: number; edges: number }> {
    this.root = repoPath
    const allFiles: string[] = []
    await walkFiles(repoPath, repoPath, allFiles)
    const allFilesSet = new Set(allFiles)

    let filesIndexed = 0
    let entitiesTotal = 0
    let edgesTotal = 0

    const upsertFile = this.db.prepare(
      `INSERT INTO files (path, content_hash) VALUES (?, ?)
       ON CONFLICT(path) DO UPDATE SET content_hash=excluded.content_hash, indexed_at=unixepoch()`
    )
    const deleteEntitiesForFile = this.db.prepare(`DELETE FROM entities WHERE file_path = ?`)
    const insertEntity = this.db.prepare(
      `INSERT INTO entities (file_path, name, kind, signature, line_start, line_end, content_hash, parent_class, domain, role, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const deleteEdgesFromFile = this.db.prepare(`DELETE FROM edges WHERE from_file = ?`)
    const insertEdge = this.db.prepare(
      `INSERT INTO edges (from_file, from_entity, to_entity, to_file, edge_kind) VALUES (?, ?, ?, ?, ?)`
    )
    const getPrevHash = this.db.prepare(`SELECT content_hash FROM files WHERE path = ?`)
    const countEntitiesForFile = this.db.prepare(`SELECT COUNT(*) as n FROM entities WHERE file_path = ?`)
    const countEdgesFromFile = this.db.prepare(`SELECT COUNT(*) as n FROM edges WHERE from_file = ?`)
    const listKnownFiles = this.db.prepare(`SELECT path FROM files`)
    const deleteGhostEdges = this.db.prepare(`DELETE FROM edges WHERE from_file = ? OR to_file = ?`)
    const deleteFileRow = this.db.prepare(`DELETE FROM files WHERE path = ?`)
    const deleteFtsForFile = this.ftsAvailable
      ? this.db.prepare(`DELETE FROM entities_fts WHERE file_path = ?`)
      : null
    const insertFts = this.ftsAvailable
      ? this.db.prepare(
          `INSERT INTO entities_fts (name_text, summary_text, sig_text, domain_text, role_text, file_path, entity_name, entity_kind)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
      : null
    const listFileAnchoredNotes = this.db.prepare(`SELECT DISTINCT anchor FROM notes WHERE anchor LIKE 'f:%'`)
    const setNoteStale = this.db.prepare(`UPDATE notes SET stale = ? WHERE anchor = ?`)

    // bun:sqlite transactions run synchronously, so pre-load file content first.
    const contentMap = new Map<string, string>()
    await Promise.all(
      allFiles.map(async (fp) => {
        try {
          contentMap.set(fp, await readFile(fp, "utf8"))
        } catch {
          // skip unreadable files
        }
      })
    )

    this.db.transaction(() => {
      for (const filePath of allFiles) {
        const content = contentMap.get(filePath)
        if (content === undefined) continue

        const hash = createHash("sha256").update(content).digest("hex").slice(0, 16)
        const prev = getPrevHash.get(filePath) as { content_hash: string } | null
        if (prev?.content_hash === hash) {
          // File unchanged — count existing rows for stats, skip re-extraction.
          const ec = countEntitiesForFile.get(filePath) as { n: number } | null
          const dc = countEdgesFromFile.get(filePath) as { n: number } | null
          entitiesTotal += ec?.n ?? 0
          edgesTotal += dc?.n ?? 0
          continue
        }

        upsertFile.run(filePath, hash)
        filesIndexed++

        // Changed (or new) file: replace its entities + outgoing edges wholesale.
        deleteEntitiesForFile.run(filePath)
        deleteEdgesFromFile.run(filePath)
        deleteFtsForFile?.run(filePath)

        const entities = extractEntities(content, filePath)
        // Real files can yield several entities the (file_path, name, kind) key
        // cannot distinguish — TS overload clusters, or same-named methods on
        // different interfaces/object literals (parentClass is only detected for
        // class bodies). Merge each cluster into one row spanning all its line
        // ranges; the first occurrence keeps signature/hash/@sem/summary fields. Edge
        // extraction below still sees the raw list, so call-site attribution
        // keeps the precise per-declaration ranges.
        const dedupedEntities = new Map<string, ExtractedEntity>()
        for (const e of entities) {
          const dupeKey = `${e.name} ${e.kind}`
          const prev = dedupedEntities.get(dupeKey)
          if (prev) {
            prev.lineStart = Math.min(prev.lineStart, e.lineStart)
            prev.lineEnd = Math.max(prev.lineEnd, e.lineEnd)
          } else {
            dedupedEntities.set(dupeKey, { ...e })
          }
        }
        for (const e of dedupedEntities.values()) {
          insertEntity.run(
            filePath,
            e.name,
            e.kind,
            e.signature,
            e.lineStart,
            e.lineEnd,
            e.contentHash,
            e.parentClass ?? null,
            e.semDomain ?? null,
            e.semRole ?? null,
            e.summary ?? null
          )
          insertFts?.run(
            tokenize(e.name).join(" "),
            tokenize(e.summary ?? "").join(" "),
            tokenize(e.signature).join(" "),
            tokenize(e.semDomain ?? "").join(" "),
            tokenize(e.semRole ?? "").join(" "),
            filePath,
            e.name,
            e.kind
          )
          entitiesTotal++
        }

        const edges = extractEdges(content, filePath, entities, this.root)
        for (const edge of edges) {
          insertEdge.run(filePath, edge.fromEntity, edge.toEntity, edge.toFile ?? null, edge.kind)
          edgesTotal++
        }
      }

      // Purge ghost rows: files that no longer exist on disk.
      const knownFiles = listKnownFiles.all() as { path: string }[]
      for (const { path } of knownFiles) {
        if (allFilesSet.has(path)) continue
        deleteEntitiesForFile.run(path)
        deleteGhostEdges.run(path, path)
        deleteFtsForFile?.run(path)
        deleteFileRow.run(path)
      }

      // Stale-anchor sweep: an f:<path> note whose file is gone from disk is
      // flagged stale=1 (rows are kept for audit, not deleted); one whose
      // file has reappeared is flagged back to stale=0. e:/g:/p: anchors are
      // never touched here — only a file's own on-disk presence drives this.
      const knownRelFiles = new Set(allFiles.map((fp) => relative(repoPath, fp)))
      const fileAnchoredNotes = listFileAnchoredNotes.all() as { anchor: string }[]
      for (const { anchor } of fileAnchoredNotes) {
        const isPresent = knownRelFiles.has(anchor.slice(2))
        setNoteStale.run(isPresent ? 0 : 1, anchor)
      }
    })()

    return { files: filesIndexed, entities: entitiesTotal, edges: edgesTotal }
  }

  /**
   * Whole-graph row totals read straight off the tables. Distinct from index()'s
   * return value, whose `files` counts only what was re-extracted this run (0 on a
   * fully warm repo) — this is the true persisted total the `opencode init` receipt
   * reports so a warm re-index still shows the real graph size, not a 0.
   *
   * @sem domain=intelligence role=indexing
   */
  stats(): { files: number; entities: number; edges: number } {
    const count = (table: string) =>
      (this.db.prepare(`SELECT COUNT(*) as n FROM ${table}`).get() as { n: number } | null)?.n ?? 0
    return { files: count("files"), entities: count("entities"), edges: count("edges") }
  }

  // -------------------------------------------------------------------------
  // Graph queries
  // -------------------------------------------------------------------------

  /**
   * Look up an entity by stable key (<filePath>:<name>:<kind>) or bare name.
   * Key form resolves via the absolute path stored in the DB.
   *
   * @sem domain=intelligence role=query
   */
  async getEntity(key: string): Promise<Entity | null> {
    // Try bare name first (most common usage from callers)
    const byName = this.db
      .prepare("SELECT * FROM entities WHERE name = ? LIMIT 1")
      .get(key) as Record<string, unknown> | null
    if (byName) return rowToEntity(byName, this.root)

    // Try key decomposition: "<filePath>:<name>:<kind>"
    const parts = key.split(":")
    if (parts.length >= 3) {
      const [fp, name, kind] = parts
      const relPath = fp ?? ""
      const absPath = relPath.startsWith("/") ? relPath : join(this.root, relPath)
      const byKey = this.db
        .prepare("SELECT * FROM entities WHERE file_path=? AND name=? AND kind=? LIMIT 1")
        .get(absPath, name ?? "", kind ?? "") as Record<string, unknown> | null
      if (byKey) return rowToEntity(byKey, this.root)
    }

    return null
  }

  /**
   * Return all outgoing import/call edges from the named entity, scoped to
   * its resolved (name, from_file) so two same-named entities in different
   * files never share edges. entityKey "" is the file-level import query
   * (import edges carry fromEntity="") — kept unscoped for that case since
   * there is no single entity to resolve it against.
   *
   * @sem domain=intelligence role=query
   */
  async getReferences(entityKey: string): Promise<Reference[]> {
    if (entityKey === "") {
      const rows = this.db
        .prepare("SELECT * FROM edges WHERE from_entity = ''")
        .all() as Record<string, unknown>[]
      return rows.map((r) => rowToReference(r, this.root))
    }
    const entity = await this.getEntity(entityKey)
    if (!entity) return []
    const absFile = entity.filePath.startsWith("/") ? entity.filePath : join(this.root, entity.filePath)
    const rows = this.db
      .prepare("SELECT * FROM edges WHERE from_entity = ? AND from_file = ?")
      .all(entity.name, absFile) as Record<string, unknown>[]
    return rows.map((r) => rowToReference(r, this.root))
  }

  /**
   * Return all callers of the named entity — edges where to_entity AND
   * to_file both match the entity's resolved (name, file), so two same-named
   * entities in different files never cross-contaminate each other's fan-in.
   *
   * @sem domain=intelligence role=query
   */
  async getCallers(entityKey: string): Promise<Reference[]> {
    const entity = await this.getEntity(entityKey)
    if (!entity) return []
    const absFile = entity.filePath.startsWith("/") ? entity.filePath : join(this.root, entity.filePath)
    const rows = this.db
      .prepare("SELECT * FROM edges WHERE to_entity = ? AND to_file = ?")
      .all(entity.name, absFile) as Record<string, unknown>[]
    return rows.map((r) => rowToReference(r, this.root))
  }

  /**
   * Full-text search over tokenized entity name/summary/signature/domain/role.
   * Multi-word phrases are tokenized (camelCase/snake_case split, stopwords
   * and <=2 char tokens dropped) and ranked through FTS5 bm25() — the name
   * column is weighted highest (summary second) so an exact-name hit outranks
   * an incidental substring match elsewhere. Single-token queries, special-char
   * queries, an empty token set, or any FTS miss/error fall back to the
   * original name LIKE substring scan, so exact-symbol lookups keep working.
   *
   * @sem domain=intelligence role=query
   */
  async search(query: string, limit = 20): Promise<Entity[]> {
    const isPhrase = /\s/.test(query.trim())
    if (this.ftsAvailable && isPhrase) {
      const tokens = tokenizeQuery(query)
      if (tokens.length > 0) {
        try {
          const matchExpr = tokens.join(" OR ")
          const hits = this.db
            .prepare(
              `SELECT file_path, entity_name, entity_kind, bm25(entities_fts, 10.0, 5.0, 2.0, 1.0, 1.0) as rank
               FROM entities_fts WHERE entities_fts MATCH ? ORDER BY rank LIMIT ?`
            )
            .all(matchExpr, limit) as Array<{ file_path: string; entity_name: string; entity_kind: string }>
          if (hits.length > 0) {
            const getRow = this.db.prepare(
              "SELECT * FROM entities WHERE file_path=? AND name=? AND kind=? LIMIT 1"
            )
            const results: Entity[] = []
            for (const hit of hits) {
              const row = getRow.get(hit.file_path, hit.entity_name, hit.entity_kind) as Record<string, unknown> | null
              if (row) results.push(rowToEntity(row, this.root))
            }
            if (results.length > 0) return results
          }
        } catch {
          // FTS query failed (unavailable, malformed) — fall through to LIKE.
        }
      }
    }

    const pattern = `%${query}%`
    const rows = this.db
      .prepare("SELECT * FROM entities WHERE name LIKE ? ORDER BY name LIMIT ?")
      .all(pattern, limit) as Record<string, unknown>[]
    return rows.map((r) => rowToEntity(r, this.root))
  }

  // -------------------------------------------------------------------------
  // Risk signal
  // -------------------------------------------------------------------------

  /**
   * Return all entities whose source file matches filePath. Accepts relative
   * paths (resolved against root) or absolute paths. Satisfies the
   * RiskGraph.getEntitiesInFile contract used by computeRisk.
   *
   * @sem domain=intelligence role=query
   */
  async getEntitiesInFile(filePath: string): Promise<Entity[]> {
    const absPath = filePath.startsWith("/") ? filePath : join(this.root, filePath)
    const rows = this.db
      .prepare("SELECT * FROM entities WHERE file_path = ?")
      .all(absPath) as Record<string, unknown>[]
    return rows.map((r) => rowToEntity(r, this.root))
  }

  /**
   * Multi-factor 0–100 code-structural risk score for editing filePath,
   * normalized to [0, 1] for backward compatibility. Delegates to
   * computeRisk (risk.ts): factors are blast-radius, fan-in, centrality,
   * and body complexity. Returns the max score across all entities in the
   * file so a file containing even one high-risk entity is flagged.
   *
   * @sem domain=intelligence role=analysis
   */
  async riskScore(filePath: string): Promise<number> {
    const entities = await this.getEntitiesInFile(filePath)
    if (entities.length === 0) return 0

    // BunSqliteGraph satisfies RiskGraph structurally (getEntity,
    // getCallers, getReferences, getEntitiesInFile are all implemented).
    const g = this as unknown as RiskGraph
    let maxScore = 0
    for (const entity of entities) {
      const { score } = await computeRisk(g, entity)
      if (score > maxScore) maxScore = score
    }

    // Divide by 100 to maintain the existing [0, 1] return contract
    return Math.min(1, maxScore / 100)
  }

  /**
   * Distinct-file fan-in for filePath: how many OTHER files hold an edge
   * (import or call) pointing at it. Self-imports (from_file === to_file)
   * are excluded so a file's own internal references never inflate its
   * count. The raw hub signal the edit-time hub-edit gate thresholds on.
   *
   * @sem domain=intelligence role=analysis
   */
  fileFanIn(filePath: string): number {
    const absPath = filePath.startsWith("/") ? filePath : join(this.root, filePath)
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT from_file) as n FROM edges WHERE to_file = ? AND from_file != ?`
      )
      .get(absPath, absPath) as { n: number } | null
    return row?.n ?? 0
  }

  // -------------------------------------------------------------------------
  // Recon + compress (FTS5-ranked local implementation — a richer unerr
  // brain UDS proxy can still supersede these for production use)
  // -------------------------------------------------------------------------

  /**
   * Persist a single anchored note. Upserts on (anchor, kind, content) —
   * re-saving the same note is idempotent; only polarity is updated. New
   * rows start non-stale (stale=0); an existing row's stale flag is left as
   * whatever index()'s ghost-file sweep last set it to — only re-indexing
   * flips it.
   *
   * @sem domain=intelligence role=indexing
   */
  async upsertNote(note: AnchoredNote): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO notes (anchor, kind, polarity, content)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(anchor, kind, content) DO UPDATE SET polarity=excluded.polarity`,
      )
      .run(note.anchor, note.kind, note.polarity, note.content)
  }

  /**
   * Return all notes whose anchor is in the given list — exact-string match
   * for f:/e:/p: anchors — plus any g:<glob> note whose pattern matches one
   * of the queried f:<path> anchors (glob rows can't live in the same IN-list
   * lookup since they aren't literal matches, so they're fetched and tested
   * separately via matchesGlob). Every row carries its stale flag, set/cleared
   * by index()'s ghost-file sweep, so callers can decide what to do with a
   * note whose file is gone. Cheap index scan; returns an empty array when
   * the anchor list is empty.
   *
   * @sem domain=intelligence role=query
   */
  async getNotesForAnchors(anchors: string[]): Promise<AnchoredNote[]> {
    if (anchors.length === 0) return []
    type NoteRow = { anchor: string; kind: string; polarity: string; content: string; stale: number }

    const placeholders = anchors.map(() => "?").join(", ")
    const exactRows = this.db
      .prepare(
        `SELECT anchor, kind, polarity, content, stale FROM notes WHERE anchor IN (${placeholders})`,
      )
      .all(...anchors) as NoteRow[]

    const filePaths = anchors.filter((a) => a.startsWith("f:")).map((a) => a.slice(2))
    const globRows: NoteRow[] = []
    if (filePaths.length > 0) {
      const globCandidates = this.db
        .prepare(`SELECT anchor, kind, polarity, content, stale FROM notes WHERE anchor LIKE 'g:%'`)
        .all() as NoteRow[]
      for (const row of globCandidates) {
        const pattern = row.anchor.slice(2)
        if (filePaths.some((fp) => matchesGlob(pattern, fp))) globRows.push(row)
      }
    }

    const seen = new Set<string>()
    const results: AnchoredNote[] = []
    for (const row of [...exactRows, ...globRows]) {
      const dedupeKey = `${row.anchor} ${row.kind} ${row.content}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      results.push({
        anchor: row.anchor,
        kind: row.kind as AnchoredNote["kind"],
        polarity: row.polarity as AnchoredNote["polarity"],
        content: row.content,
        stale: row.stale === 1,
      })
    }
    return results
  }

  /**
   * Recon bundle for a natural-language task phrase. Tokenizes the FULL
   * phrase (every >2-char non-stopword term, not just the first word) and
   * hands the joined terms to search(), so multi-term FTS5/bm25 ranking
   * decides the match order; falls back to the raw phrase when
   * tokenization yields nothing. Notes are fetched for both the file (f:)
   * and entity (e:) anchors of each matched entity.
   *
   * @sem domain=intelligence role=analysis
   */
  async recon(task: string): Promise<ReconBundle> {
    const tokens = tokenizeQuery(task)
    const searchQuery = tokens.length > 0 ? tokens.join(" ") : task
    const entities = await this.search(searchQuery, 10)
    const references: Reference[] = []
    for (const e of entities.slice(0, 5)) {
      const refs = await this.getReferences(e.key)
      references.push(...refs)
    }
    // Populate notes for both file and entity anchors of matched entities.
    const anchors = [
      ...new Set([
        ...entities.map((e) => `f:${e.filePath}`),
        ...entities.map((e) => `e:${e.name}`),
      ]),
    ]
    const notes = await this.getNotesForAnchors(anchors)
    return { entities, references, notes }
  }

  /**
   * Max fan-in among the given candidate names — distinct (from_file,
   * from_entity) callers per name, so an import edge and a call edge from
   * the same caller count once. Names the graph doesn't know score 0
   * (absent from the result map).
   */
  private fanInForNames(names: string[]): Map<string, number> {
    const map = new Map<string, number>()
    if (names.length === 0) return map
    const placeholders = names.map(() => "?").join(", ")
    const rows = this.db
      .prepare(
        `SELECT to_entity, COUNT(DISTINCT from_file || char(1) || from_entity) as cnt
         FROM edges WHERE to_entity IN (${placeholders}) GROUP BY to_entity`
      )
      .all(...names) as Array<{ to_entity: string; cnt: number }>
    for (const r of rows) map.set(r.to_entity, r.cnt)
    return map
  }

  /**
   * Entity-ranked trimming: splits content on blank lines into candidate
   * blocks, scores each block by the highest known-entity fan-in among the
   * identifiers it mentions (fanInForNames), and keeps the highest-scoring
   * blocks whole until the token budget (~4 chars/token) is spent —
   * truncating the first block that overflows the remaining budget with a
   * marker and dropping the rest. Content with a single block (no
   * blank-line structure to rank) falls back to plain char truncation —
   * deterministic either way.
   *
   * @sem domain=intelligence role=utilities
   */
  compress(content: string, budget: number): string {
    const charBudget = budget * 4
    if (content.length <= charBudget) return content

    const blocks = content.split(/\n\s*\n/).filter((b) => b.trim().length > 0)
    if (blocks.length <= 1) {
      return content.slice(0, charBudget) + "\n… [truncated]"
    }

    const blockWords = blocks.map((b) => [...new Set(b.match(/\b[A-Za-z_$][\w$]*\b/g) ?? [])])
    const fanIn = this.fanInForNames([...new Set(blockWords.flat())])

    const scored = blocks.map((block, idx) => {
      let score = 0
      for (const w of blockWords[idx] ?? []) score = Math.max(score, fanIn.get(w) ?? 0)
      return { block, score, idx }
    })
    scored.sort((a, b) => b.score - a.score || a.idx - b.idx)

    const kept: string[] = []
    let used = 0
    let truncated = false
    for (const item of scored) {
      if (truncated) continue
      const sep = kept.length > 0 ? 2 : 0
      if (used + sep + item.block.length <= charBudget) {
        kept.push(item.block)
        used += sep + item.block.length
        continue
      }
      const remaining = charBudget - used - sep
      if (remaining > 0) kept.push(item.block.slice(0, remaining))
      kept.push("… [truncated]")
      truncated = true
    }
    if (!truncated) kept.push("… [truncated]")
    return kept.join("\n\n")
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Close the underlying SQLite connection. */
  close(): void {
    this.db.close()
  }
}
