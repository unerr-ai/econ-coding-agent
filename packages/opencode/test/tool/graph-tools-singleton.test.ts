/**
 * Task #7 (econ graph uplift): getGraph()'s per-repo-root singleton, disk
 * persistence, and schema-version gate. Exercises canonicalRepoRoot's
 * git-root walk-up, the module-level per-root registry (never a second graph
 * for one root), on-disk warm-start behavior, and the PRAGMA user_version
 * eviction gate — all against synthetic temp fixture repos (never the real
 * checkout) so runs stay fast and isolated from the monorepo's own size.
 */
import { describe, it, expect } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { Database } from "bun:sqlite"
import { BunSqliteGraph } from "@opencode-ai/code-intelligence"
import {
  getGraph,
  ensureGraphReady,
  ensureGraphReadyBounded,
  canonicalRepoRoot,
  graphDbPath,
  GRAPH_SCHEMA_VERSION,
} from "../../src/tool/graph-tools"

/** A synthetic repo: a `.git` marker (canonicalRepoRoot only checks existence, never validity) plus a source file. */
function makeFixtureRepo(fileCount = 1): string {
  const root = mkdtempSync(join(tmpdir(), "econ-graph-singleton-"))
  mkdirSync(join(root, ".git"))
  for (let i = 0; i < fileCount; i++) {
    writeFileSync(join(root, `f${i}.ts`), `export function f${i}() { return ${i} }\n`)
  }
  return root
}

describe("getGraph — per-repo-root singleton", () => {
  it("a repo-root call and a nested-subdirectory call share the same instance", async () => {
    const root = makeFixtureRepo()
    try {
      const nested = join(root, "src", "deep", "nested")
      mkdirSync(nested, { recursive: true })

      const fromRoot = await ensureGraphReady(root)
      const fromNested = getGraph(nested)

      expect(fromNested).toBe(fromRoot)
      expect(canonicalRepoRoot(nested)).toBe(canonicalRepoRoot(root))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("two different repo roots get distinct instances", async () => {
    const rootA = makeFixtureRepo()
    const rootB = makeFixtureRepo()
    try {
      const graphA = await ensureGraphReady(rootA)
      const graphB = await ensureGraphReady(rootB)

      expect(graphA).not.toBe(graphB)
    } finally {
      rmSync(rootA, { recursive: true, force: true })
      rmSync(rootB, { recursive: true, force: true })
    }
  })
})

describe("getGraph — disk persistence", () => {
  it("warm reopen re-extracts ~0 files after the first index (content-hash skip)", async () => {
    const root = makeFixtureRepo(3)
    try {
      await ensureGraphReady(root) // first touch — builds + indexes the on-disk db

      const dbPath = graphDbPath(canonicalRepoRoot(root))
      const reopened = new BunSqliteGraph(dbPath, root)
      try {
        const stats = await reopened.index(root)
        expect(stats.files).toBe(0)
      } finally {
        reopened.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("getGraph — schema-version gate", () => {
  it("a mismatched PRAGMA user_version wipes and rebuilds the db fresh", async () => {
    const root = makeFixtureRepo()
    try {
      const dbPath = graphDbPath(canonicalRepoRoot(root))
      mkdirSync(dirname(dbPath), { recursive: true })

      const stale = new Database(dbPath)
      stale.exec("PRAGMA user_version = 999")
      stale.exec("CREATE TABLE marker (id INTEGER)")
      stale.exec("INSERT INTO marker VALUES (1)")
      stale.close()

      await ensureGraphReady(root)

      const check = new Database(dbPath, { readonly: true })
      const version = (check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
      let hasMarkerTable = true
      try {
        check.prepare("SELECT * FROM marker").get()
      } catch {
        hasMarkerTable = false
      }
      check.close()

      expect(version).toBe(GRAPH_SCHEMA_VERSION)
      expect(hasMarkerTable).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("ensureGraphReadyBounded — never hangs on a cold graph", () => {
  it("a near-zero timeout against a not-yet-indexed root resolves ready:false promptly", async () => {
    // Enough files that indexing measurably outlasts a 1ms timer, so ready:false
    // is a reliable (non-racy) outcome rather than an occasional false positive.
    const root = makeFixtureRepo(300)
    try {
      const started = Date.now()
      const { ready } = await ensureGraphReadyBounded(1, root)
      const elapsedMs = Date.now() - started

      expect(ready).toBe(false)
      expect(elapsedMs).toBeLessThan(2_000)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
