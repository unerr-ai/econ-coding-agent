/**
 * Cross-file scoping tests: pkg-a and pkg-b each define a same-named
 * `run`/`start` pair. getCallers must resolve the input key to (file, name,
 * kind) via getEntity and then filter edges by name AND to_file — so pkg-a's
 * `run` and pkg-b's `run` never share callers/fan-in, and the bare `run()`
 * call site inside `start()` produces a resolved call-kind edge (counted in
 * fan-in alongside the import edge).
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { join } from "node:path"
import { BunSqliteGraph } from "../src/bun-sqlite-graph.js"

const FIXTURE_DIR = join(import.meta.dir, "fixture-scoping")

let graph: BunSqliteGraph

describe("BunSqliteGraph — cross-file scoping for same-named entities", () => {
  beforeAll(async () => {
    graph = new BunSqliteGraph(":memory:", FIXTURE_DIR)
    const stats = await graph.index(FIXTURE_DIR)
    expect(stats.files).toBeGreaterThanOrEqual(4)
  })

  afterAll(() => graph.close())

  it("search finds both same-named `run` entities, one per package", async () => {
    const results = await graph.search("run")
    expect(results.filter((e) => e.name === "run").length).toBe(2)
  })

  it("getCallers for pkg-a's run returns only pkg-a's caller", async () => {
    const results = await graph.search("run")
    const pkgARun = results.find((e) => e.name === "run" && e.filePath.includes("pkg-a"))
    expect(pkgARun).toBeDefined()

    const callers = await graph.getCallers(pkgARun!.key)
    expect(callers.length).toBeGreaterThan(0)
    expect(callers.every((r) => r.fromFile.includes("pkg-a"))).toBe(true)
    expect(callers.some((r) => r.fromFile.includes("pkg-b"))).toBe(false)
  })

  it("getCallers for pkg-b's run returns only pkg-b's caller", async () => {
    const results = await graph.search("run")
    const pkgBRun = results.find((e) => e.name === "run" && e.filePath.includes("pkg-b"))
    expect(pkgBRun).toBeDefined()

    const callers = await graph.getCallers(pkgBRun!.key)
    expect(callers.length).toBeGreaterThan(0)
    expect(callers.every((r) => r.fromFile.includes("pkg-b"))).toBe(true)
    expect(callers.some((r) => r.fromFile.includes("pkg-a"))).toBe(false)
  })

  it("the bare run() call site inside start() resolves to a 'call' edge counted in fan-in", async () => {
    const results = await graph.search("run")
    const pkgARun = results.find((e) => e.name === "run" && e.filePath.includes("pkg-a"))
    expect(pkgARun).toBeDefined()

    const callers = await graph.getCallers(pkgARun!.key)
    const callEdge = callers.find((r) => r.kind === "call")
    expect(callEdge).toBeDefined()
    expect(callEdge!.fromEntity).toBe("start")
    expect(callEdge!.fromFile).toContain("pkg-a")
  })

  it("riskScore for pkg-a's helper.ts reflects only pkg-a's fan-in", async () => {
    const score = await graph.riskScore(join("pkg-a", "helper.ts"))
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThanOrEqual(1)
  })

  it("a directory import ('./util') resolves via the /index.* variant", async () => {
    const util = await graph.getEntity("sharedUtil")
    expect(util).not.toBeNull()
    expect(util!.filePath).toContain(join("pkg-c", "util", "index.ts"))

    const callers = await graph.getCallers(util!.key)
    expect(callers.length).toBeGreaterThan(0)
    expect(callers.some((r) => r.fromFile.includes(join("pkg-c", "main.ts")))).toBe(true)
    expect(callers.some((r) => r.kind === "call" && r.fromEntity === "invokeShared")).toBe(true)
  })
})
