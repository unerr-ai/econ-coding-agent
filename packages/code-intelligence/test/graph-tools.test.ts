/**
 * Graph-tool interface smoke test: index the toy fixture, invoke each tool's
 * execute() function directly (no Effect runtime or model needed), and assert
 * graph-backed results come back correctly.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { join } from "node:path"
import { BunSqliteGraph } from "../src/bun-sqlite-graph.js"
import { makeReconTool, makeFileReadTool, makeGetReferencesTool } from "../src/tools.js"

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
})
