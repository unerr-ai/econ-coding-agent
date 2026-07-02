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
import { extractEntities, extractEdges, detectLanguage } from "./ast-extractor.js"
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
    UNIQUE(file_path, name, kind)
  );

  CREATE TABLE IF NOT EXISTS edges (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    from_file   TEXT    NOT NULL,
    from_entity TEXT    NOT NULL DEFAULT '',
    to_entity   TEXT    NOT NULL,
    edge_kind   TEXT    NOT NULL DEFAULT 'import'
  );

  CREATE INDEX IF NOT EXISTS idx_entities_name  ON entities(name);
  CREATE INDEX IF NOT EXISTS idx_entities_file  ON entities(file_path);
  CREATE INDEX IF NOT EXISTS idx_edges_from_ent ON edges(from_entity);
  CREATE INDEX IF NOT EXISTS idx_edges_to_ent   ON edges(to_entity);
  CREATE INDEX IF NOT EXISTS idx_edges_from_file ON edges(from_file);

  CREATE TABLE IF NOT EXISTS notes (
    anchor     TEXT NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'fct',
    polarity   TEXT NOT NULL DEFAULT '+',
    content    TEXT NOT NULL,
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
// BunSqliteGraph
// ---------------------------------------------------------------------------

/**
 * Concrete CodeIntelligence implementation using bun:sqlite as the backing
 * store. graph-query methods (getEntity, getReferences, getCallers, search,
 * riskScore) are fully implemented; recon and compress are stubs — extend with
 * the unerr brain UDS proxy for production use.
 *
 * @sem domain=intelligence role=database
 */
export class BunSqliteGraph implements CodeIntelligence {
  private db: Database
  private root: string

  constructor(dbPath: string = ":memory:", root: string = process.cwd()) {
    this.db = new Database(dbPath)
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
    this.db.exec(SCHEMA)
    // Migrations: add semantic columns to existing DBs (no-op if already present)
    try { this.db.exec("ALTER TABLE entities ADD COLUMN domain TEXT") } catch { /* already exists */ }
    try { this.db.exec("ALTER TABLE entities ADD COLUMN role TEXT") } catch { /* already exists */ }
    this.root = root
  }

  // -------------------------------------------------------------------------
  // Indexing
  // -------------------------------------------------------------------------

  /**
   * Walk repoPath, extract entities and import edges, upsert into SQLite.
   * Skips files whose content hash hasn't changed since last index run.
   *
   * @sem domain=intelligence role=indexing
   */
  async index(repoPath: string): Promise<{ files: number; entities: number; edges: number }> {
    this.root = repoPath
    const allFiles: string[] = []
    await walkFiles(repoPath, repoPath, allFiles)

    let filesIndexed = 0
    let entitiesTotal = 0
    let edgesTotal = 0

    const upsertFile = this.db.prepare(
      `INSERT INTO files (path, content_hash) VALUES (?, ?)
       ON CONFLICT(path) DO UPDATE SET content_hash=excluded.content_hash, indexed_at=unixepoch()`
    )
    const upsertEntity = this.db.prepare(
      `INSERT INTO entities (file_path, name, kind, signature, line_start, line_end, content_hash, parent_class, domain, role)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(file_path, name, kind) DO UPDATE SET
         signature=excluded.signature, line_start=excluded.line_start,
         line_end=excluded.line_end, content_hash=excluded.content_hash,
         parent_class=excluded.parent_class, domain=excluded.domain, role=excluded.role`
    )
    const deleteEdgesForFile = this.db.prepare(`DELETE FROM edges WHERE from_file = ?`)
    const insertEdge = this.db.prepare(
      `INSERT INTO edges (from_file, from_entity, to_entity, edge_kind) VALUES (?, ?, ?, ?)`
    )
    const getPrevHash = this.db.prepare(`SELECT content_hash FROM files WHERE path = ?`)

    // Wrap in a transaction for ~10x throughput
    const indexAll = this.db.transaction(() => {
      for (const filePath of allFiles) {
        // readFile is async but we need sync here inside transaction;
        // pre-loaded content is passed via closure from the async loop below.
      }
    })
    // We can't use async inside a transaction, so build content map first.
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
          // File unchanged — count existing entities for stats
          const c = this.db.prepare("SELECT COUNT(*) as n FROM entities WHERE file_path=?").get(filePath) as { n: number } | null
          entitiesTotal += c?.n ?? 0
          continue
        }

        upsertFile.run(filePath, hash)
        filesIndexed++

        const entities = extractEntities(content, filePath)
        for (const e of entities) {
          upsertEntity.run(
            filePath,
            e.name,
            e.kind,
            e.signature,
            e.lineStart,
            e.lineEnd,
            e.contentHash,
            e.parentClass ?? null,
            e.semDomain ?? null,
            e.semRole ?? null
          )
          entitiesTotal++
        }

        deleteEdgesForFile.run(filePath)
        const edges = extractEdges(content, filePath)
        for (const edge of edges) {
          insertEdge.run(filePath, edge.fromEntity, edge.toEntity, edge.kind)
          edgesTotal++
        }
      }
    })()

    return { files: filesIndexed, entities: entitiesTotal, edges: edgesTotal }
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
   * Return all outgoing import/call edges from the named entity.
   *
   * @sem domain=intelligence role=query
   */
  async getReferences(entityKey: string): Promise<Reference[]> {
    const rows = this.db
      .prepare("SELECT * FROM edges WHERE from_entity = ?")
      .all(entityKey) as Record<string, unknown>[]
    return rows.map((r) => rowToReference(r, this.root))
  }

  /**
   * Return all callers of the named entity — edges where to_entity matches.
   *
   * @sem domain=intelligence role=query
   */
  async getCallers(entityKey: string): Promise<Reference[]> {
    // Match by entity name (bare) or full key
    const name = entityKey.includes(":") ? entityKey.split(":")[1] ?? entityKey : entityKey
    const rows = this.db
      .prepare("SELECT * FROM edges WHERE to_entity = ?")
      .all(name) as Record<string, unknown>[]
    return rows.map((r) => rowToReference(r, this.root))
  }

  /**
   * Search entities by name prefix or substring (case-insensitive, SQLite LIKE).
   *
   * @sem domain=intelligence role=query
   */
  async search(query: string, limit = 20): Promise<Entity[]> {
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

  // -------------------------------------------------------------------------
  // Recon + compress (stubs — extend with unerr brain UDS proxy)
  // -------------------------------------------------------------------------

  /**
   * Persist a single anchored note. Upserts on (anchor, kind, content) —
   * re-saving the same note is idempotent; only polarity is updated.
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
   * Return all notes whose anchor is in the given list. Cheap index scan;
   * returns an empty array when the list is empty or no matches exist.
   *
   * @sem domain=intelligence role=query
   */
  async getNotesForAnchors(anchors: string[]): Promise<AnchoredNote[]> {
    if (anchors.length === 0) return []
    const placeholders = anchors.map(() => "?").join(", ")
    const rows = this.db
      .prepare(
        `SELECT anchor, kind, polarity, content FROM notes WHERE anchor IN (${placeholders})`,
      )
      .all(...anchors) as Array<{ anchor: string; kind: string; polarity: string; content: string }>
    return rows.map((r) => ({
      anchor: r.anchor,
      kind: r.kind as AnchoredNote["kind"],
      polarity: r.polarity as AnchoredNote["polarity"],
      content: r.content,
    }))
  }

  /**
   * TODO: implement via semantic search over the entity graph + anchored notes
   * from unerr brain. Currently returns a simple name-search result with notes
   * populated from the local notes store for the matched entity file anchors.
   *
   * @sem domain=intelligence role=analysis
   */
  async recon(task: string): Promise<ReconBundle> {
    const words = task.toLowerCase().split(/\s+/).filter((w) => w.length > 3)
    const entities = words.length > 0
      ? await this.search(words[0] ?? task, 10)
      : []
    const references: Reference[] = []
    for (const e of entities.slice(0, 5)) {
      const refs = await this.getReferences(e.name)
      references.push(...refs)
    }
    // Populate notes from the store for file anchors of matched entities.
    const anchors = [...new Set(entities.map((e) => `f:${e.filePath}`))]
    const notes = await this.getNotesForAnchors(anchors)
    return { entities, references, notes }
  }

  /**
   * TODO: implement proper entity-ranked trimming. Currently truncates to
   * roughly `budget` characters (1 token ≈ 4 chars heuristic).
   *
   * @sem domain=intelligence role=utilities
   */
  compress(content: string, budget: number): string {
    const charBudget = budget * 4
    if (content.length <= charBudget) return content
    return content.slice(0, charBudget) + "\n… [truncated]"
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Close the underlying SQLite connection. */
  close(): void {
    this.db.close()
  }
}
