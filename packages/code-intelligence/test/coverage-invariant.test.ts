/**
 * G4b — per-language graph coverage as a tracked invariant (docs/design/
 * agnostic-hands-eyes.md §7.2). A vendored, hermetic multi-language fixture
 * corpus under fixture-coverage/ has EXACT import/call counts known by
 * construction; this suite indexes it once and asserts
 * BunSqliteGraph.edgeCoverage() per language exactly (not floors), so any
 * resolver/extractor change that shifts a count fails loudly with the
 * language named — the rot P6 found only via a manual audit (§7.1) cannot
 * happen silently again. Real-repo floors (django/requests/econ) are the
 * separate, non-hermetic reference recorded in §7.2 — this suite never
 * touches the network or a cloned repo.
 *
 * Extensible by row (§5.1 generic-first law): adding a language means
 * dropping a mini-tree under fixture-coverage/<lang>/ plus one row in
 * CORPUS below — no other wiring.
 *
 * @sem domain=intelligence role=testing
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { join } from "node:path"
import { BunSqliteGraph, type EdgeCoverage } from "../src/bun-sqlite-graph.js"

const FIXTURE_ROOT = join(import.meta.dir, "fixture-coverage")

// One row per language mini-tree under fixture-coverage/<lang>/. Counts are
// exact by construction — read the mini-tree's source (each file documents
// which import is relative/absolute-dotted/directory/external) to see why.
const CORPUS: { lang: string; expected: EdgeCoverage[string] }[] = [
  // pkg/__init__.py + pkg/base.py + pkg/mod.py. mod.py: 1 relative import
  // (resolves), 1 absolute-dotted intra-package import (resolves), 1
  // external stdlib import (unresolved); 1 call (run -> build).
  { lang: "python", expected: { files: 3, imports: 3, resolvedImports: 2, calls: 1 } },
  // helper.ts + utils/index.ts + main.ts. main.ts: 1 relative import
  // (resolves), 1 directory-index import (resolves via ./utils ->
  // ./utils/index.ts), 1 external npm import (unresolved); 2 calls
  // (run -> helper, run -> util).
  { lang: "typescript", expected: { files: 3, imports: 3, resolvedImports: 2, calls: 2 } },
  // util.js. 1 external CommonJS require (unresolved); 0 calls (double is
  // defined but never called in-file).
  { lang: "javascript", expected: { files: 1, imports: 1, resolvedImports: 0, calls: 0 } },
]

describe("BunSqliteGraph — edgeCoverage() invariant over the vendored fixture corpus (G4b)", () => {
  let graph: BunSqliteGraph

  beforeAll(async () => {
    graph = new BunSqliteGraph(":memory:", FIXTURE_ROOT)
    await graph.index(FIXTURE_ROOT)
  })

  afterAll(() => graph.close())

  for (const { lang, expected } of CORPUS) {
    it(`${lang}: coverage matches the fixture's known-by-construction counts exactly`, () => {
      const coverage = graph.edgeCoverage()
      expect(coverage[lang]).toEqual(expected)
    })
  }

  it("indexes no languages beyond the fixture's corpus rows", () => {
    const coverage = graph.edgeCoverage()
    expect(Object.keys(coverage).sort()).toEqual(CORPUS.map((c) => c.lang).sort())
  })
})
