/**
 * Incremental indexing tests: a content-hash match skips re-extraction for
 * an unchanged file; a changed file is deleted and re-inserted wholesale (no
 * ghost rows from a renamed entity); a file removed from disk has its
 * entities/edges/files row purged after the next index() walk; and repeated
 * index() runs over an unchanged tree are idempotent (stable row counts).
 */
import { describe, it, expect, afterEach } from "bun:test"
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunSqliteGraph } from "../src/bun-sqlite-graph.js"

describe("BunSqliteGraph — incremental indexing", () => {
  let dir: string
  let graph: BunSqliteGraph

  afterEach(async () => {
    graph?.close()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it("unchanged file is skipped on re-index via content-hash", async () => {
    dir = await mkdtemp(join(tmpdir(), "econ-graph-incremental-"))
    await writeFile(join(dir, "a.ts"), "export function alpha(): void {}\n")

    graph = new BunSqliteGraph(":memory:", dir)
    const first = await graph.index(dir)
    expect(first.files).toBe(1)
    expect(first.entities).toBe(1)

    const second = await graph.index(dir)
    // Nothing changed on disk — zero files re-extracted this run.
    expect(second.files).toBe(0)
    expect(second.entities).toBe(first.entities)
    expect(second.edges).toBe(first.edges)

    const entities = await graph.getEntitiesInFile("a.ts")
    expect(entities.length).toBe(1)
  })

  it("changed file is fully re-extracted — a renamed entity leaves no old row behind", async () => {
    dir = await mkdtemp(join(tmpdir(), "econ-graph-incremental-"))
    const filePath = join(dir, "b.ts")
    await writeFile(filePath, "export function oldName(): void {}\n")

    graph = new BunSqliteGraph(":memory:", dir)
    await graph.index(dir)
    expect(await graph.getEntity("oldName")).not.toBeNull()

    // Rename the function in place — the old entity row must be gone, not a ghost.
    await writeFile(filePath, "export function newName(): void {}\n")
    const stats = await graph.index(dir)
    expect(stats.files).toBe(1)

    expect(await graph.getEntity("oldName")).toBeNull()
    expect(await graph.getEntity("newName")).not.toBeNull()

    const entitiesInFile = await graph.getEntitiesInFile("b.ts")
    expect(entitiesInFile.length).toBe(1)
    expect(entitiesInFile[0]!.name).toBe("newName")
  })

  it("a file removed from disk leaves no ghost entities in search()", async () => {
    dir = await mkdtemp(join(tmpdir(), "econ-graph-incremental-"))
    const ghostPath = join(dir, "c.ts")
    await writeFile(ghostPath, "export function ghostFn(): void {}\n")
    await writeFile(join(dir, "keep.ts"), "export function keepFn(): void {}\n")

    graph = new BunSqliteGraph(":memory:", dir)
    await graph.index(dir)
    expect((await graph.search("ghostFn")).length).toBe(1)

    await unlink(ghostPath)
    await graph.index(dir)

    expect((await graph.search("ghostFn")).length).toBe(0)
    // The sibling file's entity survives the ghost purge.
    expect((await graph.search("keepFn")).length).toBe(1)
  })

  it("repeated index() runs over an unchanged tree are idempotent (stable row counts)", async () => {
    dir = await mkdtemp(join(tmpdir(), "econ-graph-incremental-"))
    await writeFile(join(dir, "d.ts"), "export function delta(): void {}\n")
    await writeFile(
      join(dir, "e.ts"),
      "import { delta } from \"./d\"\nexport function useDelta(): void {\n  delta()\n}\n",
    )

    graph = new BunSqliteGraph(":memory:", dir)
    const run1 = await graph.index(dir)
    const run2 = await graph.index(dir)
    const run3 = await graph.index(dir)

    expect(run1.entities).toBe(2)
    expect(run2.entities).toBe(run1.entities)
    expect(run2.edges).toBe(run1.edges)
    expect(run3.entities).toBe(run1.entities)
    expect(run3.edges).toBe(run1.edges)
  })
})

// Wave 5 — fileFanIn: distinct-importer-file count over a small python
// fixture (the hub-edit gate's raw signal).
describe("BunSqliteGraph — fileFanIn", () => {
  let dir: string
  let graph: BunSqliteGraph

  afterEach(async () => {
    graph?.close()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it("counts distinct importer files, excluding self-imports and non-importers", async () => {
    dir = await mkdtemp(join(tmpdir(), "econ-graph-fanin-"))
    await writeFile(join(dir, "base.py"), "class Model:\n    pass\n")
    await writeFile(join(dir, "caller_a.py"), "from base import Model\n")
    await writeFile(join(dir, "caller_b.py"), "from base import Model\n")
    await writeFile(join(dir, "lonely.py"), "x = 1\n")

    graph = new BunSqliteGraph(":memory:", dir)
    await graph.index(dir)

    expect(graph.fileFanIn("base.py")).toBe(2)
    expect(graph.fileFanIn("lonely.py")).toBe(0)
  })
})
