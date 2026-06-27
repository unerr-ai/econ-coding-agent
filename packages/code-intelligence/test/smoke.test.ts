/**
 * Smoke test: index the toy fixture, assert graph queries return expected
 * entities and edges from bun:sqlite. No WASM required — regex extractor runs.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { join } from "node:path"
import { BunSqliteGraph } from "../src/bun-sqlite-graph.js"

const FIXTURE_DIR = join(import.meta.dir, "fixture")

let graph: BunSqliteGraph

describe("BunSqliteGraph — toy repo smoke test", () => {
  beforeAll(async () => {
    // Use in-memory DB so the test is self-contained
    graph = new BunSqliteGraph(":memory:", FIXTURE_DIR)
    const stats = await graph.index(FIXTURE_DIR)
    // Sanity: at least 3 files indexed (a, b, c) with entities
    expect(stats.files).toBeGreaterThanOrEqual(3)
    expect(stats.entities).toBeGreaterThan(0)
  })

  afterAll(() => {
    graph.close()
  })

  // -------------------------------------------------------------------------
  // Entity lookup
  // -------------------------------------------------------------------------

  it("finds the greet function from a.ts", async () => {
    const entity = await graph.getEntity("greet")
    expect(entity).not.toBeNull()
    expect(entity!.name).toBe("greet")
    expect(entity!.kind).toBe("function")
    expect(entity!.filePath).toContain("a.ts")
    expect(entity!.lineStart).toBeGreaterThan(0)
  })

  it("finds the Calculator class from b.ts", async () => {
    const entity = await graph.getEntity("Calculator")
    expect(entity).not.toBeNull()
    expect(entity!.name).toBe("Calculator")
    expect(entity!.kind).toBe("class")
    expect(entity!.filePath).toContain("b.ts")
  })

  it("finds methods inside Calculator", async () => {
    const add = await graph.getEntity("Calculator.add")
    expect(add).not.toBeNull()
    expect(add!.kind).toBe("method")
    expect(add!.parentClass).toBe("Calculator")
  })

  it("finds the main function from c.ts", async () => {
    const entity = await graph.getEntity("main")
    expect(entity).not.toBeNull()
    expect(entity!.kind).toBe("function")
    expect(entity!.filePath).toContain("c.ts")
  })

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  it("search returns entities matching a substring", async () => {
    const results = await graph.search("calc")
    expect(results.length).toBeGreaterThan(0)
    const names = results.map((e) => e.name.toLowerCase())
    expect(names.some((n) => n.includes("calc"))).toBe(true)
  })

  it("search with 'greet' finds the greet function", async () => {
    const results = await graph.search("greet")
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]!.name).toBe("greet")
  })

  // -------------------------------------------------------------------------
  // Edge / reference queries
  // -------------------------------------------------------------------------

  it("c.ts imports greet — getCallers('greet') returns c.ts edge", async () => {
    const callers = await graph.getCallers("greet")
    expect(callers.length).toBeGreaterThan(0)
    const cEdge = callers.find((r) => r.fromFile.includes("c.ts"))
    expect(cEdge).toBeDefined()
    expect(cEdge!.kind).toBe("import")
  })

  it("c.ts imports Calculator — getCallers('Calculator') returns c.ts edge", async () => {
    const callers = await graph.getCallers("Calculator")
    expect(callers.length).toBeGreaterThan(0)
    const cEdge = callers.find((r) => r.fromFile.includes("c.ts"))
    expect(cEdge).toBeDefined()
  })

  // -------------------------------------------------------------------------
  // Risk signal
  // -------------------------------------------------------------------------

  it("riskScore for a.ts is between 0 and 1", async () => {
    const score = await graph.riskScore("a.ts")
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(1)
  })

  it("riskScore for a file with callers is > 0", async () => {
    // greet is imported by c.ts → fan-in ≥ 1 → score > 0
    const score = await graph.riskScore("a.ts")
    expect(score).toBeGreaterThan(0)
  })

  // -------------------------------------------------------------------------
  // Compress stub
  // -------------------------------------------------------------------------

  it("compress truncates content that exceeds budget", () => {
    const long = "x".repeat(1000)
    const compressed = graph.compress(long, 10) // budget=10 tokens → ~40 chars
    expect(compressed.length).toBeLessThan(long.length)
    expect(compressed).toContain("[truncated]")
  })

  it("compress returns content unchanged when within budget", () => {
    const short = "hello world"
    expect(graph.compress(short, 100)).toBe(short)
  })
})
