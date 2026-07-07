/**
 * OL-7.9: coupling & test-strength detection.
 *
 * probeSliceCoupling is exercised against a real indexed toy repo (fixtures/
 * ol79-coupling) — a 12-caller hub (high coupling) and an isolated leaf (low
 * coupling) — plus defensive paths with a throwing/empty mock graph.
 *
 * probeSliceTestStrength is exercised against four isolated package roots
 * (fixtures/ol79-teststrength) that each fire exactly one signal, plus a
 * package root with none (untestable) and a nonexistent-file defensive path.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { join } from "node:path"
import { BunSqliteGraph } from "@opencode-ai/code-intelligence"
import { probeSliceCoupling, probeSliceTestStrength } from "../../src/tool/graph-tools"

const COUPLING_FIXTURE = join(import.meta.dir, "fixtures/ol79-coupling")
const TS_FIXTURE = join(import.meta.dir, "fixtures/ol79-teststrength")

describe("OL-7.9 — probeSliceCoupling", () => {
  let graph: BunSqliteGraph

  beforeAll(async () => {
    graph = new BunSqliteGraph(":memory:", COUPLING_FIXTURE)
    await graph.index(COUPLING_FIXTURE)
  })

  afterAll(() => {
    graph.close()
  })

  it("scores a 12-caller hub as high coupling", async () => {
    const result = await probeSliceCoupling("touch the hub entity", ["hub.ts"], graph)
    expect(result.confidence).toBe("graph")
    expect(result.coupling).toBe("high")
    expect(result.score).toBeGreaterThanOrEqual(50)
  })

  it("scores an isolated leaf as low coupling (real graph, non-zero resolution)", async () => {
    const result = await probeSliceCoupling("touch the leaf entity", ["leaf.ts"], graph)
    expect(result.confidence).toBe("graph")
    expect(result.coupling).toBe("low")
    expect(result.score).toBeLessThan(50)
  })

  it("resolves entities from slice text tokens when no files are given", async () => {
    const result = await probeSliceCoupling("please touch centralHub next", undefined, graph)
    expect(result.confidence).toBe("graph")
    expect(result.coupling).toBe("high")
  })

  it("defensive: no matching entities yields low/0/none", async () => {
    const result = await probeSliceCoupling("zzz nonexistent qqq", [], graph)
    expect(result).toEqual({ coupling: "low", score: 0, confidence: "none" })
  })

  it("defensive: a throwing graph yields low/0/none, never throws", async () => {
    const throwingGraph = {
      getEntitiesInFile: async () => {
        throw new Error("boom")
      },
      search: async () => {
        throw new Error("boom")
      },
    } as unknown as BunSqliteGraph
    const result = await probeSliceCoupling("hub caller entity", ["hub.ts"], throwingGraph)
    expect(result).toEqual({ coupling: "low", score: 0, confidence: "none" })
  })
})

describe("OL-7.9 — probeSliceTestStrength", () => {
  it("hasTests signal alone marks the slice testable", async () => {
    const result = await probeSliceTestStrength([join(TS_FIXTURE, "pkg-with-tests/src/foo.ts")])
    expect(result.testStrength).toBe("testable")
    expect(result.signals.hasTests).toBe(true)
    expect(result.signals.hasTypeCoverage).toBe(false)
    expect(result.signals.hasCompileTarget).toBe(false)
  })

  it("hasTypeCoverage signal alone marks the slice testable", async () => {
    const result = await probeSliceTestStrength([join(TS_FIXTURE, "pkg-typed/src/bar.ts")])
    expect(result.testStrength).toBe("testable")
    expect(result.signals.hasTests).toBe(false)
    expect(result.signals.hasTypeCoverage).toBe(true)
    expect(result.signals.hasCompileTarget).toBe(false)
  })

  it("hasCompileTarget signal alone marks the slice testable", async () => {
    const result = await probeSliceTestStrength([join(TS_FIXTURE, "pkg-compiled/src/baz.ts")])
    expect(result.testStrength).toBe("testable")
    expect(result.signals.hasTests).toBe(false)
    expect(result.signals.hasTypeCoverage).toBe(false)
    expect(result.signals.hasCompileTarget).toBe(true)
  })

  it("no signals fired marks the slice untestable (pessimistic default)", async () => {
    const result = await probeSliceTestStrength([join(TS_FIXTURE, "pkg-none/src/qux.ts")])
    expect(result.testStrength).toBe("untestable")
    expect(result.signals).toEqual({ hasTests: false, hasTypeCoverage: false, hasCompileTarget: false })
  })

  it("any file in the slice firing a signal marks the whole slice testable", async () => {
    const result = await probeSliceTestStrength([
      join(TS_FIXTURE, "pkg-none/src/qux.ts"),
      join(TS_FIXTURE, "pkg-with-tests/src/foo.ts"),
    ])
    expect(result.testStrength).toBe("testable")
    expect(result.signals.hasTests).toBe(true)
  })

  it("I2: classic-JS package — suffix-less test dir + assignment-style defs — is testable", async () => {
    // express shape: suite lives at test/res.send.js (no .test/.spec suffix),
    // source exports nothing ESM-visible; the dotted assignment name is the
    // only link between suite and source.
    const result = await probeSliceTestStrength([join(TS_FIXTURE, "pkg-classic/lib/response.js")])
    expect(result.testStrength).toBe("testable")
    expect(result.signals.hasTests).toBe(true)
  })

  it("defensive: a nonexistent file yields untestable, never throws", async () => {
    const result = await probeSliceTestStrength(["/does/not/exist/nowhere.ts"])
    expect(result.testStrength).toBe("untestable")
    expect(result.signals).toEqual({ hasTests: false, hasTypeCoverage: false, hasCompileTarget: false })
  })

  it("defensive: an empty file list yields untestable, never throws", async () => {
    const result = await probeSliceTestStrength([])
    expect(result.testStrength).toBe("untestable")
  })
})

describe("OL-7.9 — the four (coupling × testStrength) matrix cells", () => {
  let graph: BunSqliteGraph

  beforeAll(async () => {
    graph = new BunSqliteGraph(":memory:", COUPLING_FIXTURE)
    await graph.index(COUPLING_FIXTURE)
  })

  afterAll(() => {
    graph.close()
  })

  it("low coupling + testable", async () => {
    const coupling = await probeSliceCoupling("touch the leaf entity", ["leaf.ts"], graph)
    const testStrength = await probeSliceTestStrength([join(TS_FIXTURE, "pkg-with-tests/src/foo.ts")])
    expect(coupling.coupling).toBe("low")
    expect(testStrength.testStrength).toBe("testable")
  })

  it("low coupling + untestable", async () => {
    const coupling = await probeSliceCoupling("touch the leaf entity", ["leaf.ts"], graph)
    const testStrength = await probeSliceTestStrength([join(TS_FIXTURE, "pkg-none/src/qux.ts")])
    expect(coupling.coupling).toBe("low")
    expect(testStrength.testStrength).toBe("untestable")
  })

  it("high coupling + testable", async () => {
    const coupling = await probeSliceCoupling("touch the hub entity", ["hub.ts"], graph)
    const testStrength = await probeSliceTestStrength([join(TS_FIXTURE, "pkg-typed/src/bar.ts")])
    expect(coupling.coupling).toBe("high")
    expect(testStrength.testStrength).toBe("testable")
  })

  it("high coupling + untestable", async () => {
    const coupling = await probeSliceCoupling("touch the hub entity", ["hub.ts"], graph)
    const testStrength = await probeSliceTestStrength([join(TS_FIXTURE, "pkg-none/src/qux.ts")])
    expect(coupling.coupling).toBe("high")
    expect(testStrength.testStrength).toBe("untestable")
  })
})
