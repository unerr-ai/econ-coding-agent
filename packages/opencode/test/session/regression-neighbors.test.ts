/**
 * Tests for discoverNeighborTests (packages/opencode/src/session/regression-neighbors.ts,
 * F11): Django-style tests/runtests.py + tests/<dir> matching, the pytest-style filename
 * fallback under tests/** and the source file's own directory, the no-match empty-array
 * case, and the 3-command cap.
 */

import { describe, it, expect, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverNeighborTests } from "../../src/session/regression-neighbors"

const dirs: string[] = []

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "regression-neighbors-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("discoverNeighborTests — Django-style (tests/runtests.py present)", () => {
  it("matches tests/delete and tests/delete_regress from django/db/models/deletion.py", () => {
    const cwd = makeFixture()
    mkdirSync(join(cwd, "tests"), { recursive: true })
    writeFileSync(join(cwd, "tests", "runtests.py"), "")
    mkdirSync(join(cwd, "tests", "delete"), { recursive: true })
    mkdirSync(join(cwd, "tests", "delete_regress"), { recursive: true })
    mkdirSync(join(cwd, "django", "db", "models"), { recursive: true })
    writeFileSync(join(cwd, "django", "db", "models", "deletion.py"), "")

    const result = discoverNeighborTests({
      touchedSourceFiles: ["django/db/models/deletion.py"],
      cwd,
    })

    expect(result.map((c) => c.command).sort()).toEqual(
      ["python tests/runtests.py delete --parallel 1", "python tests/runtests.py delete_regress --parallel 1"].sort(),
    )
    expect(result.every((c) => c.kind === "test")).toBe(true)
  })

  it("caps at 3 commands even when more than 3 tests/<dir> names match", () => {
    const cwd = makeFixture()
    mkdirSync(join(cwd, "tests"), { recursive: true })
    writeFileSync(join(cwd, "tests", "runtests.py"), "")
    for (const dirName of ["delete", "delete_regress", "deletes", "deletion_extra"]) {
      mkdirSync(join(cwd, "tests", dirName), { recursive: true })
    }
    mkdirSync(join(cwd, "django", "db", "models"), { recursive: true })
    writeFileSync(join(cwd, "django", "db", "models", "deletion.py"), "")

    const result = discoverNeighborTests({
      touchedSourceFiles: ["django/db/models/deletion.py"],
      cwd,
    })

    expect(result).toHaveLength(3)
  })
})

describe("discoverNeighborTests — pytest-style fallback (no tests/runtests.py)", () => {
  it("matches tests/test_http.py from utils/http.py", () => {
    const cwd = makeFixture()
    mkdirSync(join(cwd, "tests"), { recursive: true })
    writeFileSync(join(cwd, "tests", "test_http.py"), "")
    mkdirSync(join(cwd, "utils"), { recursive: true })
    writeFileSync(join(cwd, "utils", "http.py"), "")

    const result = discoverNeighborTests({
      touchedSourceFiles: ["utils/http.py"],
      cwd,
    })

    expect(result).toEqual([{ kind: "test", command: "python -m pytest tests/test_http.py -x -q" }])
  })

  it("also matches a <basename>_test.py sibling in the source file's own directory", () => {
    const cwd = makeFixture()
    mkdirSync(join(cwd, "utils"), { recursive: true })
    writeFileSync(join(cwd, "utils", "http.py"), "")
    writeFileSync(join(cwd, "utils", "http_test.py"), "")

    const result = discoverNeighborTests({
      touchedSourceFiles: ["utils/http.py"],
      cwd,
    })

    expect(result).toEqual([{ kind: "test", command: "python -m pytest utils/http_test.py -x -q" }])
  })

  it("returns [] when nothing matches", () => {
    const cwd = makeFixture()
    mkdirSync(join(cwd, "tests"), { recursive: true })
    writeFileSync(join(cwd, "tests", "test_http.py"), "")
    mkdirSync(join(cwd, "pkg"), { recursive: true })
    writeFileSync(join(cwd, "pkg", "unrelated.py"), "")

    const result = discoverNeighborTests({
      touchedSourceFiles: ["pkg/unrelated.py"],
      cwd,
    })

    expect(result).toEqual([])
  })

  it("returns [] for an empty touchedSourceFiles list", () => {
    const cwd = makeFixture()
    const result = discoverNeighborTests({ touchedSourceFiles: [], cwd })
    expect(result).toEqual([])
  })
})
