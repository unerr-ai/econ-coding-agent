/**
 * Anchor-matching tests for the notes store: a g:<glob> note surfaces for a
 * matching f:<path> query and not for a non-matching one; an e:<name> note
 * round-trips across a re-index of its entity's file; a note on a file
 * removed from disk reads back stale=true after index() and flips back to
 * stale=false if the file reappears; upsertNote stays idempotent on
 * (anchor, kind, content) with the new stale column in place.
 */
import { describe, it, expect, afterEach } from "bun:test"
import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunSqliteGraph } from "../src/bun-sqlite-graph.js"

describe("BunSqliteGraph — notes: glob anchors, entity anchors, stale sweep", () => {
  let dir: string
  let graph: BunSqliteGraph

  afterEach(async () => {
    graph?.close()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // Glob anchors
  // -------------------------------------------------------------------------

  it("a g:<glob> note surfaces for a matching f:<path> query and not for a non-matching one", async () => {
    dir = await mkdtemp(join(tmpdir(), "econ-graph-notes-glob-"))
    await mkdir(join(dir, "src", "tools"), { recursive: true })
    await mkdir(join(dir, "other"), { recursive: true })
    await writeFile(join(dir, "src", "tools", "foo.ts"), "export function foo(): void {}\n")
    await writeFile(join(dir, "other", "bar.ts"), "export function bar(): void {}\n")

    graph = new BunSqliteGraph(":memory:", dir)
    await graph.index(dir)

    await graph.upsertNote({
      anchor: "g:src/tools/**",
      kind: "wrn",
      polarity: "-",
      content: "don't add a public export here without a review",
    })

    const matching = await graph.getNotesForAnchors([join("src", "tools", "foo.ts")].map((p) => `f:${p}`))
    expect(matching.some((n) => n.anchor === "g:src/tools/**")).toBe(true)

    const nonMatching = await graph.getNotesForAnchors([`f:${join("other", "bar.ts")}`])
    expect(nonMatching.some((n) => n.anchor === "g:src/tools/**")).toBe(false)
  })

  it("a g:*.test.ts note surfaces for a matching top-level f:<path> query", async () => {
    dir = await mkdtemp(join(tmpdir(), "econ-graph-notes-glob-"))
    await writeFile(join(dir, "foo.test.ts"), "export function fooTest(): void {}\n")
    await writeFile(join(dir, "foo.ts"), "export function foo(): void {}\n")

    graph = new BunSqliteGraph(":memory:", dir)
    await graph.index(dir)

    await graph.upsertNote({
      anchor: "g:*.test.ts",
      kind: "wrn",
      polarity: "-",
      content: "don't mock the db here",
    })

    const matching = await graph.getNotesForAnchors(["f:foo.test.ts"])
    expect(matching.some((n) => n.anchor === "g:*.test.ts")).toBe(true)

    const nonMatching = await graph.getNotesForAnchors(["f:foo.ts"])
    expect(nonMatching.some((n) => n.anchor === "g:*.test.ts")).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Entity anchors
  // -------------------------------------------------------------------------

  it("an e:<name> note round-trips and survives its entity's file being re-indexed", async () => {
    dir = await mkdtemp(join(tmpdir(), "econ-graph-notes-entity-"))
    const filePath = join(dir, "a.ts")
    await writeFile(filePath, "export function myFunc(): void {}\n")

    graph = new BunSqliteGraph(":memory:", dir)
    await graph.index(dir)

    await graph.upsertNote({
      anchor: "e:myFunc",
      kind: "fct",
      polarity: "+",
      content: "myFunc is called from the CLI entrypoint",
    })

    const before = await graph.getNotesForAnchors(["e:myFunc"])
    expect(before.some((n) => n.anchor === "e:myFunc")).toBe(true)

    // Change the file's content so it's re-extracted wholesale on the next index().
    await writeFile(filePath, "export function myFunc(): void {}\nexport function extra(): void {}\n")
    await graph.index(dir)

    const after = await graph.getNotesForAnchors(["e:myFunc"])
    expect(after.some((n) => n.anchor === "e:myFunc")).toBe(true)
    expect(after.find((n) => n.anchor === "e:myFunc")?.content).toBe("myFunc is called from the CLI entrypoint")
  })

  // -------------------------------------------------------------------------
  // Stale-anchor sweep
  // -------------------------------------------------------------------------

  it("a note on a deleted file reads back stale=true after re-index, and flips back if the file returns", async () => {
    dir = await mkdtemp(join(tmpdir(), "econ-graph-notes-stale-"))
    const filePath = join(dir, "gone.ts")
    const content = "export function goneFn(): void {}\n"
    await writeFile(filePath, content)

    graph = new BunSqliteGraph(":memory:", dir)
    await graph.index(dir)

    await graph.upsertNote({
      anchor: "f:gone.ts",
      kind: "cnv",
      polarity: "+",
      content: "keep this in sync with the sibling schema",
    })

    const initial = await graph.getNotesForAnchors(["f:gone.ts"])
    expect(initial.length).toBe(1)
    expect(initial[0]!.stale).toBeFalsy()

    await unlink(filePath)
    await graph.index(dir)

    const afterDelete = await graph.getNotesForAnchors(["f:gone.ts"])
    expect(afterDelete.length).toBe(1)
    expect(afterDelete[0]!.stale).toBe(true)

    await writeFile(filePath, content)
    await graph.index(dir)

    const afterRestore = await graph.getNotesForAnchors(["f:gone.ts"])
    expect(afterRestore.length).toBe(1)
    expect(afterRestore[0]!.stale).toBeFalsy()
  })

  it("e:/g:/p: anchors are never marked stale by the sweep, even after their file is deleted", async () => {
    dir = await mkdtemp(join(tmpdir(), "econ-graph-notes-stale-others-"))
    const filePath = join(dir, "a.ts")
    await writeFile(filePath, "export function trackedFn(): void {}\n")

    graph = new BunSqliteGraph(":memory:", dir)
    await graph.index(dir)

    await graph.upsertNote({ anchor: "e:trackedFn", kind: "fct", polarity: "+", content: "entity note" })
    await graph.upsertNote({ anchor: "g:*.ts", kind: "fct", polarity: "+", content: "glob note" })
    await graph.upsertNote({ anchor: "p:", kind: "fct", polarity: "+", content: "project note" })

    await unlink(filePath)
    await graph.index(dir)

    const entityNote = await graph.getNotesForAnchors(["e:trackedFn"])
    expect(entityNote[0]!.stale).toBeFalsy()

    const projectNote = await graph.getNotesForAnchors(["p:"])
    expect(projectNote[0]!.stale).toBeFalsy()
  })

  // -------------------------------------------------------------------------
  // upsertNote idempotency
  // -------------------------------------------------------------------------

  it("upsertNote stays idempotent on (anchor, kind, content) with the stale column in place", async () => {
    dir = await mkdtemp(join(tmpdir(), "econ-graph-notes-idempotent-"))
    await writeFile(join(dir, "a.ts"), "export function foo(): void {}\n")

    graph = new BunSqliteGraph(":memory:", dir)
    await graph.index(dir)

    await graph.upsertNote({ anchor: "f:a.ts", kind: "wrn", polarity: "-", content: "same note" })
    await graph.upsertNote({ anchor: "f:a.ts", kind: "wrn", polarity: "+", content: "same note" })

    const notes = await graph.getNotesForAnchors(["f:a.ts"])
    expect(notes.length).toBe(1)
    expect(notes[0]!.polarity).toBe("+")
    expect(notes[0]!.stale).toBeFalsy()
  })
})
