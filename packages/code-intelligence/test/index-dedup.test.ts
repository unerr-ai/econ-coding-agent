import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunSqliteGraph } from "../src/bun-sqlite-graph.js"

/**
 * Regression: real-world files yield several entities the (file_path, name,
 * kind) key cannot distinguish — TS overload clusters and same-named methods
 * on different object literals. index() must merge those into one row instead
 * of crashing on the UNIQUE constraint (which callers' fire-and-forget catch
 * used to swallow, leaving a silently empty graph).
 */
describe("index() — duplicate (name, kind) tuples within one file", () => {
  let dir: string
  let graph: BunSqliteGraph
  const fileName = "dupes.ts"

  const source = [
    "export function overloaded(a: string): string",
    "export function overloaded(a: number): number",
    "export function overloaded(a: unknown): unknown {",
    "  return a",
    "}",
    "",
    "export const optionsA = {",
    "  provider(name: string) {",
    "    return name",
    "  },",
    "}",
    "",
    "export const optionsB = {",
    "  provider(name: string) {",
    "    return name.toUpperCase()",
    "  },",
    "}",
    "",
  ].join("\n")

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "econ-index-dedup-"))
    await mkdir(join(dir, "src"), { recursive: true })
    await writeFile(join(dir, "src", fileName), source)
    graph = new BunSqliteGraph(":memory:", dir)
  })

  afterAll(async () => {
    graph.close()
    await rm(dir, { recursive: true, force: true })
  })

  it("indexes without throwing and stores one row per (name, kind)", async () => {
    const stats = await graph.index(dir)
    expect(stats.entities).toBeGreaterThan(0)

    const entities = await graph.getEntitiesInFile(join("src", fileName))
    const seen = new Map<string, number>()
    for (const e of entities) {
      const key = `${e.name}|${e.kind}`
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }
    for (const [key, count] of seen) {
      expect(`${key} x${count}`).toBe(`${key} x1`)
    }
  })

  it("merges an overload cluster into one entity spanning all declarations", async () => {
    const entities = await graph.getEntitiesInFile(join("src", fileName))
    const overloaded = entities.filter((e) => e.name === "overloaded")
    expect(overloaded.length).toBe(1)
    expect(overloaded[0]!.lineStart).toBe(1)
    expect(overloaded[0]!.lineEnd).toBeGreaterThanOrEqual(5)
  })

  it("re-index stays idempotent with merged rows", async () => {
    const first = await graph.getEntitiesInFile(join("src", fileName))
    await graph.index(dir)
    const second = await graph.getEntitiesInFile(join("src", fileName))
    expect(second.length).toBe(first.length)
  })
})
