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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { BunSqliteGraph } from "@opencode-ai/code-intelligence"
import { probeSliceCoupling, probeSliceTestStrength, probeSliceVerifyCommands } from "../../src/tool/graph-tools"

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

/** A synthetic package root: a package.json with the given scripts (F2 reads scripts, not repo VCS state). */
function makeScriptFixture(scripts: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "econ-graph-verifycmds-"))
  mkdirSync(join(root, "src"), { recursive: true })
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts }))
  writeFileSync(join(root, "src", "index.ts"), "export const x = 1\n")
  return root
}

describe("F2 — probeSliceVerifyCommands — mutating/non-terminating script guard", () => {
  it("skips a --write lint script but keeps a clean test script", async () => {
    const root = makeScriptFixture({ lint: "biome lint --write .", test: "vitest run" })
    try {
      const commands = await probeSliceVerifyCommands([join(root, "src", "index.ts")])
      expect(commands).toHaveLength(1)
      expect(commands[0].kind).toBe("test")
      expect(commands[0].command).toContain("npm run test")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("skips a --watch test script entirely — empty result, no throw", async () => {
    const root = makeScriptFixture({ test: "vitest --watch" })
    try {
      const commands = await probeSliceVerifyCommands([join(root, "src", "index.ts")])
      expect(commands).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("keeps a plain lint script with no mutation/watch flag", async () => {
    const root = makeScriptFixture({ lint: "eslint src" })
    try {
      const commands = await probeSliceVerifyCommands([join(root, "src", "index.ts")])
      expect(commands).toHaveLength(1)
      expect(commands[0].kind).toBe("lint")
      expect(commands[0].command).toContain("npm run lint")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("word-boundary pins: --fixtures is not mistaken for --fix", async () => {
    const root = makeScriptFixture({ test: "vitest run --fixtures ./f" })
    try {
      const commands = await probeSliceVerifyCommands([join(root, "src", "index.ts")])
      expect(commands).toHaveLength(1)
      expect(commands[0].kind).toBe("test")
      expect(commands[0].command).toContain("npm run test")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/**
 * A synthetic django-shaped python repo: setup.py at the root, source under
 * pkg/db/, suite under tests/ with a runtests.py harness, and one test module
 * whose content imports the source module by name.
 */
function makeDjangoFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "econ-graph-pyharness-"))
  mkdirSync(join(root, "pkg", "db"), { recursive: true })
  mkdirSync(join(root, "tests", "backends"), { recursive: true })
  writeFileSync(join(root, "setup.py"), "from setuptools import setup\nsetup()\n")
  writeFileSync(join(root, "pkg", "db", "ddl_references.py"), "class Columns:\n    pass\n")
  writeFileSync(join(root, "tests", "runtests.py"), "#!/usr/bin/env python\n")
  writeFileSync(
    join(root, "tests", "backends", "test_ddl_references.py"),
    "from pkg.db.ddl_references import Columns\n",
  )
  // Noise: a test module that never references the source module.
  writeFileSync(join(root, "tests", "backends", "test_other.py"), "import unittest\n")
  return root
}

describe("M1 (12039 tuning) — python-aware test-strength + verify-command probes", () => {
  it("a python module referenced by a tests/-dir test file is testable", async () => {
    const root = makeDjangoFixture()
    try {
      const result = await probeSliceTestStrength([join(root, "pkg", "db", "ddl_references.py")])
      expect(result.testStrength).toBe("testable")
      expect(result.signals.hasTests).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("a python module no test file references stays untestable", async () => {
    const root = makeDjangoFixture()
    try {
      writeFileSync(join(root, "pkg", "db", "orphan.py"), "class Orphan:\n    pass\n")
      const result = await probeSliceTestStrength([join(root, "pkg", "db", "orphan.py")])
      expect(result.testStrength).toBe("untestable")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("django-runtests harness: the command targets the referencing test module as a dotted label", async () => {
    const root = makeDjangoFixture()
    try {
      const commands = await probeSliceVerifyCommands([join(root, "pkg", "db", "ddl_references.py")])
      expect(commands).toHaveLength(1)
      expect(commands[0].kind).toBe("test")
      expect(commands[0].command).toContain("tests/runtests.py backends.test_ddl_references")
      // No referencing test ⇒ the noise module never rides along.
      expect(commands[0].command).not.toContain("test_other")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("prefers the project venv's python when .venv/bin/python exists at the root", async () => {
    const root = makeDjangoFixture()
    try {
      mkdirSync(join(root, ".venv", "bin"), { recursive: true })
      writeFileSync(join(root, ".venv", "bin", "python"), "")
      const commands = await probeSliceVerifyCommands([join(root, "pkg", "db", "ddl_references.py")])
      expect(commands[0].command).toContain("./.venv/bin/python tests/runtests.py")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("pytest harness: pytest config without runtests.py yields a targeted pytest command", async () => {
    const root = makeDjangoFixture()
    try {
      rmSync(join(root, "tests", "runtests.py"))
      writeFileSync(join(root, "pytest.ini"), "[pytest]\n")
      const commands = await probeSliceVerifyCommands([join(root, "pkg", "db", "ddl_references.py")])
      expect(commands).toHaveLength(1)
      expect(commands[0].command).toContain("-m pytest -q")
      expect(commands[0].command).toContain(join("tests", "backends", "test_ddl_references.py"))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("no harness config ⇒ no command, even when a referencing test exists (never guess a runner)", async () => {
    const root = makeDjangoFixture()
    try {
      rmSync(join(root, "tests", "runtests.py"))
      const commands = await probeSliceVerifyCommands([join(root, "pkg", "db", "ddl_references.py")])
      expect(commands).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
