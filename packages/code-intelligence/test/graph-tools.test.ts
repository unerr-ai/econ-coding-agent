/**
 * Graph-tool interface smoke test: index the toy fixture, invoke each tool's
 * execute() function directly (no Effect runtime or model needed), and assert
 * graph-backed results come back correctly.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { join } from "node:path"
import { BunSqliteGraph } from "../src/bun-sqlite-graph.js"
import { makeReconTool, makeFileReadTool, makeGetReferencesTool, makeSearchCodeTool, makeFileOutlineTool } from "../src/tools.js"

const FIXTURE_DIR = join(import.meta.dir, "fixture")

let graph: BunSqliteGraph

describe("Graph tools — execute() interface smoke test", () => {
  beforeAll(async () => {
    graph = new BunSqliteGraph(":memory:", FIXTURE_DIR)
    const stats = await graph.index(FIXTURE_DIR)
    // Sanity: at least 3 files, entities present
    expect(stats.files).toBeGreaterThanOrEqual(3)
    expect(stats.entities).toBeGreaterThan(0)
  })

  afterAll(() => graph.close())

  // -------------------------------------------------------------------------
  // recon tool
  // -------------------------------------------------------------------------

  it("recon returns a JSON bundle with entities array", async () => {
    const tool = makeReconTool(graph)
    expect(tool.id).toBe("recon")

    // Use a word > 3 chars that matches a fixture entity name via LIKE '%calc%'
    const raw = await tool.execute({ task: "calc" })
    const bundle = JSON.parse(raw)

    expect(bundle).toHaveProperty("entities")
    expect(bundle).toHaveProperty("references")
    expect(Array.isArray(bundle.entities)).toBe(true)
    expect(bundle.entities.length).toBeGreaterThan(0)
  })

  it("recon entities include greet function for greeting task", async () => {
    const tool = makeReconTool(graph)
    const raw = await tool.execute({ task: "greet" })
    const bundle = JSON.parse(raw)

    const names: string[] = bundle.entities.map((e: { name: string }) => e.name)
    expect(names.some((n) => n.toLowerCase().includes("greet"))).toBe(true)
  })

  // -------------------------------------------------------------------------
  // get_references tool
  // -------------------------------------------------------------------------

  it("get_references callers finds c.ts importing greet", async () => {
    const tool = makeGetReferencesTool(graph)
    expect(tool.id).toBe("get_references")

    const raw = await tool.execute({ entity: "greet", direction: "callers" })
    const refs = JSON.parse(raw)

    expect(Array.isArray(refs)).toBe(true)
    expect(refs.length).toBeGreaterThan(0)
    expect(refs.some((r: { fromFile: string }) => r.fromFile.includes("c.ts"))).toBe(true)
  })

  it("get_references defaults to callers when direction omitted", async () => {
    const tool = makeGetReferencesTool(graph)
    const raw = await tool.execute({ entity: "greet" })
    const refs = JSON.parse(raw)

    expect(Array.isArray(refs)).toBe(true)
    expect(refs.length).toBeGreaterThan(0)
  })

  it("get_references callees with empty entity returns file-level import edges", async () => {
    // The AST extractor stores import edges with fromEntity="" (file-level).
    // Querying callees with entity="" returns all import edges across the fixture.
    const tool = makeGetReferencesTool(graph)
    const raw = await tool.execute({ entity: "", direction: "callees" })
    const refs = JSON.parse(raw)

    expect(Array.isArray(refs)).toBe(true)
    expect(refs.length).toBeGreaterThan(0)
    // All edges should be import kind
    expect(refs.every((r: { kind: string }) => r.kind === "import")).toBe(true)
  })

  it("get_references callers for Calculator returns c.ts edge", async () => {
    const tool = makeGetReferencesTool(graph)
    const raw = await tool.execute({ entity: "Calculator", direction: "callers" })
    const refs = JSON.parse(raw)

    expect(refs.some((r: { fromFile: string }) => r.fromFile.includes("c.ts"))).toBe(true)
  })

  // -------------------------------------------------------------------------
  // file_read tool
  // -------------------------------------------------------------------------

  it("file_read reads a fixture file with 1-based line numbers", async () => {
    const tool = makeFileReadTool(graph, FIXTURE_DIR)
    expect(tool.id).toBe("file_read")

    const result = await tool.execute({ path: "a.ts" })

    expect(result).toContain("greet")
    // Line 1 prefix format: "   1\t"
    expect(result).toMatch(/^\s+1\t/)
  })

  it("file_read with entity returns entity profile JSON", async () => {
    const tool = makeFileReadTool(graph, FIXTURE_DIR)
    const result = await tool.execute({ path: "a.ts", entity: "greet" })
    const profile = JSON.parse(result)

    expect(profile).toHaveProperty("name", "greet")
    expect(profile).toHaveProperty("kind", "function")
    expect(profile).toHaveProperty("lineStart")
    expect(profile).toHaveProperty("filePath")
  })

  it("file_read with unknown entity returns not-found message", async () => {
    const tool = makeFileReadTool(graph, FIXTURE_DIR)
    const result = await tool.execute({ path: "a.ts", entity: "nonExistentEntity_xyz" })

    expect(result).toContain("not found")
  })

  it("file_read absolute path resolves correctly", async () => {
    const tool = makeFileReadTool(graph, FIXTURE_DIR)
    const abs = join(FIXTURE_DIR, "b.ts")
    const result = await tool.execute({ path: abs })

    expect(result).toContain("Calculator")
  })

  // -------------------------------------------------------------------------
  // file_outline tool
  // -------------------------------------------------------------------------

  it("file_outline returns entity list with kind and lines", async () => {
    const tool = makeFileOutlineTool(graph, FIXTURE_DIR)
    expect(tool.id).toBe("file_outline")

    const raw = await tool.execute({ file_path: "a.ts" })
    const outline = JSON.parse(raw)

    expect(outline).toHaveProperty("file_path")
    expect(outline).toHaveProperty("total_lines")
    expect(outline).toHaveProperty("entities")
    expect(outline).toHaveProperty("imports")
    expect(outline).toHaveProperty("exports")
    expect(Array.isArray(outline.entities)).toBe(true)
    // a.ts has greet function and VERSION constant
    const names: string[] = outline.entities.map((e: { name: string }) => e.name)
    expect(names.some((n) => n.includes("greet"))).toBe(true)
    // Each entity has lines array
    const e = outline.entities[0]
    expect(Array.isArray(e.lines)).toBe(true)
    expect(e.lines.length).toBe(2)
  })

  it("file_outline captures export statements", async () => {
    const tool = makeFileOutlineTool(graph, FIXTURE_DIR)
    const raw = await tool.execute({ file_path: "a.ts" })
    const outline = JSON.parse(raw)

    expect(Array.isArray(outline.exports)).toBe(true)
    expect(outline.exports.length).toBeGreaterThan(0)
  })

  it("file_outline returns error for missing file", async () => {
    const tool = makeFileOutlineTool(graph, FIXTURE_DIR)
    const result = await tool.execute({ file_path: "nonexistent_xyz.ts" })
    expect(result).toContain("not found")
  })

  // -------------------------------------------------------------------------
  // search_code tool
  // -------------------------------------------------------------------------

  it("search_code symbol mode returns ranked entity matches", async () => {
    const tool = makeSearchCodeTool(graph, FIXTURE_DIR)
    expect(tool.id).toBe("search_code")

    const raw = await tool.execute({ query: "greet", mode: "symbol" })
    const entities = JSON.parse(raw)

    expect(Array.isArray(entities)).toBe(true)
    expect(entities.length).toBeGreaterThan(0)
    expect(entities.some((e: { name: string }) => e.name.toLowerCase().includes("greet"))).toBe(true)
  })

  it("search_code symbol mode kind filter narrows results", async () => {
    const tool = makeSearchCodeTool(graph, FIXTURE_DIR)

    const raw = await tool.execute({ query: "calc", mode: "symbol", kind: "function" })
    const entities = JSON.parse(raw)

    expect(Array.isArray(entities)).toBe(true)
    // All returned entities should be functions
    entities.forEach((e: { kind: string }) => expect(e.kind).toBe("function"))
  })

  it("search_code symbol mode with want:callers attaches caller list", async () => {
    const tool = makeSearchCodeTool(graph, FIXTURE_DIR)

    const raw = await tool.execute({ query: "greet", mode: "symbol", want: ["callers"] })
    const entities = JSON.parse(raw)

    expect(Array.isArray(entities)).toBe(true)
    const greetEntity = entities.find((e: { name: string }) => e.name === "greet")
    expect(greetEntity).toBeDefined()
    expect(greetEntity).toHaveProperty("callers")
    expect(Array.isArray(greetEntity.callers)).toBe(true)
  })

  it("search_code literal mode finds string in fixture files", async () => {
    const tool = makeSearchCodeTool(graph, FIXTURE_DIR)

    // "Hello," appears in a.ts greet function body
    const raw = await tool.execute({ query: "Hello,", mode: "literal" })
    const matches = JSON.parse(raw)

    expect(Array.isArray(matches)).toBe(true)
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0]).toHaveProperty("file")
    expect(matches[0]).toHaveProperty("line")
    expect(matches[0]).toHaveProperty("context")
    expect(matches.some((m: { file: string }) => m.file.includes("a.ts"))).toBe(true)
  })

  it("search_code regex mode matches pattern across files", async () => {
    const tool = makeSearchCodeTool(graph, FIXTURE_DIR)

    // Match export const ... = ... lines
    const raw = await tool.execute({ query: "export const \\w+", mode: "regex" })
    const matches = JSON.parse(raw)

    expect(Array.isArray(matches)).toBe(true)
    expect(matches.length).toBeGreaterThan(0)
  })

  it("search_code default mode returns recon bundle", async () => {
    const tool = makeSearchCodeTool(graph, FIXTURE_DIR)

    const raw = await tool.execute({ query: "greet function" })
    const bundle = JSON.parse(raw)

    expect(bundle).toHaveProperty("entities")
    expect(bundle).toHaveProperty("references")
  })

  // -------------------------------------------------------------------------
  // get_references — new params
  // -------------------------------------------------------------------------

  it("get_references limit caps returned references", async () => {
    const tool = makeGetReferencesTool(graph, FIXTURE_DIR)

    // Get callers without limit first to know total
    const rawAll = await tool.execute({ entity: "greet", direction: "callers" })
    const allRefs = JSON.parse(rawAll)

    // Now with limit: 1
    const rawLimited = await tool.execute({ entity: "greet", direction: "callers", limit: 1 })
    const limited = JSON.parse(rawLimited)

    expect(Array.isArray(limited)).toBe(true)
    if (allRefs.length > 1) {
      expect(limited.length).toBe(1)
    }
  })

  it("get_references include_text_occurrences returns text_occurrences key", async () => {
    const tool = makeGetReferencesTool(graph, FIXTURE_DIR)

    const raw = await tool.execute({
      entity: "greet",
      direction: "callers",
      include_text_occurrences: true,
    })
    const result = JSON.parse(raw)

    expect(result).toHaveProperty("references")
    expect(result).toHaveProperty("text_occurrences")
    expect(Array.isArray(result.text_occurrences)).toBe(true)
    // "greet" appears in a.ts, c.ts at minimum
    expect(result.text_occurrences.length).toBeGreaterThan(0)
  })

  // -------------------------------------------------------------------------
  // Sprint 2B: lean index — caller_count + preview
  // -------------------------------------------------------------------------

  it("search_code symbol mode returns caller_count on each entity", async () => {
    const tool = makeSearchCodeTool(graph, FIXTURE_DIR)
    const raw = await tool.execute({ query: "greet", mode: "symbol" })
    const entities = JSON.parse(raw)

    expect(Array.isArray(entities)).toBe(true)
    expect(entities.length).toBeGreaterThan(0)
    const greet = entities.find((e: { name: string }) => e.name === "greet")
    expect(greet).toBeDefined()
    expect(greet).toHaveProperty("caller_count")
    expect(typeof greet.caller_count).toBe("number")
    expect(greet.caller_count).toBeGreaterThan(0) // c.ts calls greet
  })

  it("search_code symbol mode returns preview (≤15 lines) on each entity", async () => {
    const tool = makeSearchCodeTool(graph, FIXTURE_DIR)
    const raw = await tool.execute({ query: "greet", mode: "symbol" })
    const entities = JSON.parse(raw)

    expect(Array.isArray(entities)).toBe(true)
    const greet = entities.find((e: { name: string }) => e.name === "greet")
    expect(greet).toBeDefined()
    expect(greet).toHaveProperty("preview")
    expect(typeof greet.preview).toBe("string")
    expect(greet.preview.length).toBeGreaterThan(0)
    // preview must NOT include the full body when entity is short —
    // it is at most 15 lines
    const previewLines = (greet.preview as string).split("\n").length
    expect(previewLines).toBeLessThanOrEqual(15)
    // body NOT present in lean output (include_body not set)
    expect(greet.body).toBeUndefined()
  })

  it("search_code default (task-phrase) mode returns caller_count + preview on entities", async () => {
    const tool = makeSearchCodeTool(graph, FIXTURE_DIR)
    const raw = await tool.execute({ query: "greet function" })
    const bundle = JSON.parse(raw)

    expect(bundle).toHaveProperty("entities")
    expect(Array.isArray(bundle.entities)).toBe(true)
    expect(bundle.entities.length).toBeGreaterThan(0)
    const first = bundle.entities[0]
    expect(first).toHaveProperty("caller_count")
    expect(first).toHaveProperty("preview")
    expect(typeof first.caller_count).toBe("number")
    expect(typeof first.preview).toBe("string")
  })

  // -------------------------------------------------------------------------
  // Sprint 2B: notes store — upsertNote + getNotesForAnchors + recon notes
  // -------------------------------------------------------------------------

  it("BunSqliteGraph.upsertNote + getNotesForAnchors round-trip", async () => {
    await graph.upsertNote({
      anchor: "f:src/test-anchor.ts",
      kind: "wrn",
      polarity: "-",
      content: "do not call this from production paths",
    })
    const notes = await graph.getNotesForAnchors(["f:src/test-anchor.ts"])
    expect(notes.length).toBeGreaterThanOrEqual(1)
    const note = notes[0]!
    expect(note.anchor).toBe("f:src/test-anchor.ts")
    expect(note.kind).toBe("wrn")
    expect(note.polarity).toBe("-")
    expect(note.content).toBe("do not call this from production paths")
  })

  it("getNotesForAnchors returns empty array for unknown anchors", async () => {
    const notes = await graph.getNotesForAnchors(["f:no/such/file.ts"])
    expect(Array.isArray(notes)).toBe(true)
    expect(notes.length).toBe(0)
  })

  it("recon bundle includes notes array (may be empty)", async () => {
    const tool = makeReconTool(graph)
    const raw = await tool.execute({ task: "greet" })
    const bundle = JSON.parse(raw)

    expect(bundle).toHaveProperty("notes")
    expect(Array.isArray(bundle.notes)).toBe(true)
  })

  it("recon bundle includes stored notes when anchor matches entity file", async () => {
    // Insert a note anchored to a.ts (relative path as the graph stores it)
    await graph.upsertNote({
      anchor: "f:a.ts",
      kind: "cnv",
      polarity: "+",
      content: "always use greet for user-facing strings",
    })
    const tool = makeReconTool(graph)
    const raw = await tool.execute({ task: "greet" })
    const bundle = JSON.parse(raw)

    expect(Array.isArray(bundle.notes)).toBe(true)
    const match = bundle.notes.find(
      (n: { anchor: string; content: string }) => n.anchor === "f:a.ts",
    )
    expect(match).toBeDefined()
    expect(match.content).toBe("always use greet for user-facing strings")
  })
})
