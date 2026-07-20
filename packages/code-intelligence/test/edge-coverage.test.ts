/**
 * Unit tests for BunSqliteGraph.edgeCoverage() — P6 per-language edge-
 * coverage measurement (docs/design/agnostic-hands-eyes.md §7.1). A small
 * mixed-language fixture (typescript, python, go) with both a resolved and
 * an unresolved import exercises the SQL grouping/counting directly.
 */
import { describe, it, expect, afterEach } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunSqliteGraph } from "../src/bun-sqlite-graph.js"

describe("BunSqliteGraph — edgeCoverage()", () => {
  let dir: string
  let graph: BunSqliteGraph

  afterEach(async () => {
    graph?.close()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it("groups files/imports/resolvedImports/calls per language from a mixed-language fixture", async () => {
    dir = await mkdtemp(join(tmpdir(), "econ-graph-coverage-"))

    // typescript — one relative import (resolves) + one external import
    // (unresolved), plus a call to the resolved import.
    await writeFile(
      join(dir, "main.ts"),
      [
        `import { helper } from "./helper"`,
        `import _ from "lodash"`,
        ``,
        `export function run(): number {`,
        `  return helper()`,
        `}`,
        ``,
      ].join("\n"),
    )
    await writeFile(join(dir, "helper.ts"), `export function helper(): number {\n  return 1\n}\n`)

    // python — one relative import (resolves) + one unresolvable absolute
    // import (no such module on disk).
    await writeFile(join(dir, "main.py"), `from .helper import value\nimport numpy\n`)
    await writeFile(join(dir, "helper.py"), `value = 1\n`)

    // go — no resolver AND no import-syntax regex for this language, so the
    // file is indexed (files table) but contributes zero edges.
    await writeFile(join(dir, "main.go"), `package main\n\nfunc main() {}\n`)

    graph = new BunSqliteGraph(":memory:", dir)
    await graph.index(dir)

    const coverage = graph.edgeCoverage()

    expect(coverage["typescript"]).toEqual({ files: 2, imports: 2, resolvedImports: 1, calls: 1 })
    expect(coverage["python"]).toEqual({ files: 2, imports: 2, resolvedImports: 1, calls: 0 })
    expect(coverage["go"]).toEqual({ files: 1, imports: 0, resolvedImports: 0, calls: 0 })
    // No ruby/php/rust/c/cpp/other files in this fixture — absent, not zero-padded.
    expect(coverage["ruby"]).toBeUndefined()
    expect(coverage["other"]).toBeUndefined()
  })

  it("returns an empty object for a graph with nothing indexed", () => {
    graph = new BunSqliteGraph(":memory:", "/tmp/econ-graph-coverage-empty")
    expect(graph.edgeCoverage()).toEqual({})
  })
})
