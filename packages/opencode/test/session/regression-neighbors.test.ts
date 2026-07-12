/**
 * Tests for regression-neighbors.ts (packages/opencode/src/session/regression-neighbors.ts):
 * F11's discoverNeighborTests — Django-style tests/runtests.py + tests/<dir> matching, the
 * pytest-style filename fallback under tests/** and the source file's own directory, the
 * no-match empty-array case, and the 3-command cap — and F14a's project-interpreter
 * discovery: discoverProjectInterpreter's candidate ordering (repo-local venv, then conda
 * env, then PATH), first-success-wins, the none-found null case, the exact cwd-stripping
 * probe one-liner, and rewriteInterpreter's leading-token swap.
 */

import { describe, it, expect, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  discoverNeighborTests,
  discoverProjectInterpreter,
  projectInterpreterCandidateCount,
  rewriteInterpreter,
  deriveTopLevelPackage,
} from "../../src/session/regression-neighbors"

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

describe("discoverProjectInterpreter", () => {
  const originalHome = process.env.HOME

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
  })

  it("probes repo-local venv before a conda env before PATH", async () => {
    const cwd = makeFixture()
    mkdirSync(join(cwd, ".venv", "bin"), { recursive: true })
    writeFileSync(join(cwd, ".venv", "bin", "python"), "")

    const home = makeFixture()
    process.env.HOME = home
    mkdirSync(join(home, "miniconda3", "envs", "proj", "bin"), { recursive: true })
    writeFileSync(join(home, "miniconda3", "envs", "proj", "bin", "python"), "")

    const probed: string[] = []
    const result = await discoverProjectInterpreter({
      cwd,
      topLevelPackage: "django",
      runner: async (command) => {
        probed.push(command.command)
        return { exitCode: 1, stdout: "", stderr: "ModuleNotFoundError: No module named 'django'" }
      },
    })

    expect(result).toBeNull()
    const venvIndex = probed.findIndex((p) => p.startsWith(join(cwd, ".venv", "bin", "python")))
    const condaIndex = probed.findIndex((p) => p.includes("miniconda3"))
    const pathIndex = probed.findIndex((p) => p.startsWith("python3 ") || p.startsWith("python "))
    expect(venvIndex).toBeGreaterThanOrEqual(0)
    expect(condaIndex).toBeGreaterThan(venvIndex)
    expect(pathIndex).toBeGreaterThan(condaIndex)
  })

  it("returns the first candidate whose probe exits 0", async () => {
    const cwd = makeFixture()
    mkdirSync(join(cwd, ".venv", "bin"), { recursive: true })
    writeFileSync(join(cwd, ".venv", "bin", "python"), "")

    const result = await discoverProjectInterpreter({
      cwd,
      topLevelPackage: "django",
      runner: async (command) => ({ exitCode: command.command.includes(".venv") ? 0 : 1, stdout: "", stderr: "" }),
    })

    expect(result).toBe(join(cwd, ".venv", "bin", "python"))
  })

  it("returns null when every candidate's probe fails", async () => {
    const cwd = makeFixture()

    const result = await discoverProjectInterpreter({
      cwd,
      topLevelPackage: "django",
      runner: async () => ({ exitCode: 1, stdout: "", stderr: "ModuleNotFoundError: No module named 'django'" }),
    })

    expect(result).toBeNull()
  })

  it("probes with a one-liner that strips '' / cwd sys.path entries before importing", async () => {
    const cwd = makeFixture()
    let probedCommand = ""

    await discoverProjectInterpreter({
      cwd,
      topLevelPackage: "django",
      runner: async (command) => {
        probedCommand = command.command
        return { exitCode: 0, stdout: "", stderr: "" }
      },
    })

    expect(probedCommand).toBe(
      `python3 -c "import sys; sys.path = [p for p in sys.path if p not in ('', '.', sys.path[0] if sys.path else '')]; import django"`,
    )
  })

  it("projectInterpreterCandidateCount matches the number of candidates actually probed", async () => {
    const cwd = makeFixture()
    const probed: string[] = []

    await discoverProjectInterpreter({
      cwd,
      topLevelPackage: "django",
      runner: async (command) => {
        probed.push(command.command)
        return { exitCode: 1, stdout: "", stderr: "" }
      },
    })

    expect(projectInterpreterCandidateCount(cwd)).toBe(probed.length)
  })
})

describe("rewriteInterpreter", () => {
  it("replaces the leading python token of a plain command", () => {
    const result = rewriteInterpreter(["python tests/runtests.py auth_tests --parallel 1"], "/repo/.venv/bin/python")
    expect(result).toEqual(["/repo/.venv/bin/python tests/runtests.py auth_tests --parallel 1"])
  })

  it("replaces a leading python3 token the same way", () => {
    const result = rewriteInterpreter(["python3 -m pytest tests/test_http.py -x -q"], "/repo/.venv/bin/python")
    expect(result).toEqual(["/repo/.venv/bin/python -m pytest tests/test_http.py -x -q"])
  })

  it("replaces the token after a `cd <dir> && ` prefix", () => {
    const result = rewriteInterpreter(
      ["cd django && python tests/runtests.py auth_tests --parallel 1"],
      "/repo/.venv/bin/python",
    )
    expect(result).toEqual(["cd django && /repo/.venv/bin/python tests/runtests.py auth_tests --parallel 1"])
  })

  it("leaves a non-python command untouched", () => {
    const result = rewriteInterpreter(["bun test packages/foo"], "/repo/.venv/bin/python")
    expect(result).toEqual(["bun test packages/foo"])
  })
})

describe("deriveTopLevelPackage", () => {
  const cwd = "/testbed"

  it("relativizes an absolute path under cwd, then takes the first segment", () => {
    expect(deriveTopLevelPackage("/testbed/django/db/models/deletion.py", cwd)).toBe("django")
  })

  it("takes the first segment of an already-relative path", () => {
    expect(deriveTopLevelPackage("django/db/models/deletion.py", cwd)).toBe("django")
  })

  it("applies the existing src/<pkg> second-segment rule", () => {
    expect(deriveTopLevelPackage("src/pkg/x.py", cwd)).toBe("pkg")
  })

  it("falls back to the first non-empty segment for an absolute path outside cwd", () => {
    expect(deriveTopLevelPackage("/other/pkg/x.py", cwd)).toBe("other")
  })

  it("returns undefined for an empty file path", () => {
    expect(deriveTopLevelPackage("", cwd)).toBeUndefined()
  })
})
