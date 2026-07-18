/**
 * G4 (wave-G item 3) — injection-time note-staleness enforcement.
 * `BunSqliteGraph.enforceNoteStaleness` is the gate `recon()` runs its notes
 * through before handing them back: a note whose anchor no longer resolves
 * right now is dropped; one whose cached `stale` flag disagrees with a fresh
 * resolve is kept but prefixed `[stale-anchor]`; g:/p: anchors and any
 * per-note error always pass through unchanged (fail-closed).
 *
 * recon()'s own anchor construction only ever queries notes whose anchor came
 * from a currently-matched entity, so it can never itself produce a note
 * whose cached `stale` flag disagrees with a live check (the same index()
 * pass that sets stale=1 also purges the entity, so search() stops matching
 * it). The drop/mark branches are exercised directly against
 * enforceNoteStaleness with a hand-built AnchoredNote[] instead — same
 * pattern notes-anchors.test.ts uses for the raw stale sweep, one level up.
 */
import { describe, it, expect, afterEach } from "bun:test"
import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunSqliteGraph } from "../src/bun-sqlite-graph.js"

describe("BunSqliteGraph.enforceNoteStaleness — recon injection-time gate", () => {
  let dir: string
  let graph: BunSqliteGraph

  afterEach(async () => {
    graph?.close()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it("a note anchored to a currently-existing file passes through unchanged", async () => {
    dir = await mkdtemp(join(tmpdir(), "econ-graph-stale-inject-"))
    await writeFile(join(dir, "a.ts"), "export function foo(): void {}\n")
    graph = new BunSqliteGraph(":memory:", dir)
    await graph.index(dir)

    const out = await graph.enforceNoteStaleness([
      { anchor: "f:a.ts", kind: "cnv", polarity: "+", content: "keep in sync", stale: false },
    ])

    expect(out).toEqual([{ anchor: "f:a.ts", kind: "cnv", polarity: "+", content: "keep in sync", stale: false }])
  })

  it("drops a note whose f:<path> anchor's file is gone right now, regardless of the cached stale flag", async () => {
    dir = await mkdtemp(join(tmpdir(), "econ-graph-stale-inject-"))
    graph = new BunSqliteGraph(":memory:", dir)
    await graph.index(dir)

    // Cached flag says fresh (stale:false — never evaluated by an index()
    // pass since this note was hand-built), but the file has never existed
    // on disk under `dir` — a live check must catch this independent of the
    // cache.
    const out = await graph.enforceNoteStaleness([
      { anchor: "f:never-existed.ts", kind: "wrn", polarity: "-", content: "do not touch", stale: false },
    ])

    expect(out).toEqual([])
  })

  it("drops a note whose e:<name> anchor's entity no longer exists in the graph", async () => {
    dir = await mkdtemp(join(tmpdir(), "econ-graph-stale-inject-"))
    await writeFile(join(dir, "a.ts"), "export function realFn(): void {}\n")
    graph = new BunSqliteGraph(":memory:", dir)
    await graph.index(dir)

    const out = await graph.enforceNoteStaleness([
      { anchor: "e:ghostFn", kind: "fct", polarity: "+", content: "ghostFn no longer exists", stale: false },
    ])

    expect(out).toEqual([])
  })

  it("keeps a note whose e:<name> anchor's entity still exists", async () => {
    dir = await mkdtemp(join(tmpdir(), "econ-graph-stale-inject-"))
    await writeFile(join(dir, "a.ts"), "export function realFn(): void {}\n")
    graph = new BunSqliteGraph(":memory:", dir)
    await graph.index(dir)

    const out = await graph.enforceNoteStaleness([
      { anchor: "e:realFn", kind: "fct", polarity: "+", content: "realFn does the thing", stale: false },
    ])

    expect(out).toEqual([
      { anchor: "e:realFn", kind: "fct", polarity: "+", content: "realFn does the thing", stale: false },
    ])
  })

  it("marks [stale-anchor] a note whose cached stale flag says gone but the file has genuinely returned", async () => {
    dir = await mkdtemp(join(tmpdir(), "econ-graph-stale-inject-"))
    const filePath = join(dir, "gone.ts")
    await writeFile(filePath, "export function goneFn(): void {}\n")
    graph = new BunSqliteGraph(":memory:", dir)
    await graph.index(dir)

    await graph.upsertNote({
      anchor: "f:gone.ts",
      kind: "cnv",
      polarity: "+",
      content: "keep this in sync with the sibling schema",
    })
    await unlink(filePath)
    await graph.index(dir) // ghost sweep flags the note stale=1

    const cached = await graph.getNotesForAnchors(["f:gone.ts"])
    expect(cached[0]!.stale).toBe(true)

    // The file returns, but no re-index has run yet — the cached flag still
    // says gone even though a live check finds it back.
    await writeFile(filePath, "export function goneFn(): void {}\n")

    const out = await graph.enforceNoteStaleness(cached)

    expect(out).toEqual([
      {
        anchor: "f:gone.ts",
        kind: "cnv",
        polarity: "+",
        content: "[stale-anchor] keep this in sync with the sibling schema",
        stale: true,
      },
    ])
  })

  it("g: and p: anchors always pass through unchanged (no single resolvable target)", async () => {
    dir = await mkdtemp(join(tmpdir(), "econ-graph-stale-inject-"))
    graph = new BunSqliteGraph(":memory:", dir)
    await graph.index(dir)

    const out = await graph.enforceNoteStaleness([
      { anchor: "g:*.ts", kind: "wrn", polarity: "-", content: "glob rule", stale: false },
      { anchor: "p:", kind: "fct", polarity: "+", content: "project fact", stale: false },
    ])

    expect(out).toHaveLength(2)
    expect(out.map((n) => n.content)).toEqual(["glob rule", "project fact"])
  })

  it("fails closed: a malformed anchor is injected unchanged rather than dropped", async () => {
    dir = await mkdtemp(join(tmpdir(), "econ-graph-stale-inject-"))
    graph = new BunSqliteGraph(":memory:", dir)
    await graph.index(dir)
    await graph.close()
    // The graph is now closed — any DB-touching check (getEntity) throws.
    const out = await graph.enforceNoteStaleness([
      { anchor: "e:whatever", kind: "fct", polarity: "+", content: "survives the error", stale: false },
    ])

    expect(out).toEqual([
      { anchor: "e:whatever", kind: "fct", polarity: "+", content: "survives the error", stale: false },
    ])
  })

  it("recon() end-to-end: a note anchored to a file that vanished since the last index still fetches via search()'s stale entity but is dropped at injection", async () => {
    dir = await mkdtemp(join(tmpdir(), "econ-graph-stale-inject-"))
    await writeFile(join(dir, "vanish.ts"), "export function vanishFn(): void {}\n")
    graph = new BunSqliteGraph(":memory:", dir)
    await graph.index(dir)

    await graph.upsertNote({
      anchor: "f:vanish.ts",
      kind: "wrn",
      polarity: "-",
      content: "do not reintroduce the old signature",
    })

    // Delete the file WITHOUT re-indexing — the entities table (and thus
    // recon()'s search()) still reports vanishFn as live, so the note's f:
    // anchor is still constructed, but the file is genuinely gone right now.
    await unlink(join(dir, "vanish.ts"))

    const bundle = await graph.recon("vanishFn")
    expect(bundle.entities.some((e) => e.name === "vanishFn")).toBe(true)
    expect(bundle.notes.some((n) => n.anchor === "f:vanish.ts")).toBe(false)
  })
})
