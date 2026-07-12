/**
 * Tests for regression-neighbors.ts (packages/opencode/src/session/regression-neighbors.ts):
 * F11's discoverNeighborTests — Django-style tests/runtests.py + tests/<dir> matching, the
 * pytest-style filename fallback under tests/** and the source file's own directory, the
 * no-match empty-array case, and the 3-command cap — F17's additive module-package breadth:
 * the django-11885 scenario (basename stem surfaces tests/delete + tests/delete_regress, the
 * noisy "models" parent stem excluded so tests/model_forms/model_fields never appear), a
 * generic non-django repo reaching a one-level-below package tests/ tree via the parent-stem
 * only, the "ion"-stripped morphological variant reaching a strictly-prefixed pytest file, a
 * noise-stem (utils) exclusion, and the combined proximity+breadth cap enforcement — and
 * F14a's project-interpreter discovery: discoverProjectInterpreter's candidate ordering
 * (repo-local venv, then conda env, then PATH), first-success-wins, the none-found null case,
 * the exact cwd-stripping probe one-liner, and rewriteInterpreter's leading-token swap — and
 * F16's selectRegressionPinCandidate: picks the first assertion-shaped (non-env-red, non-zero
 * exit) regression-gate failure to pin, skipping MISSING_FILE/MODULE_MISSING-shaped and
 * exit-0 entries, `null` on an empty list.
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
  selectRegressionPinCandidate,
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

describe("discoverNeighborTests — module-package breadth (F17, additive)", () => {
  it("django-11885: deletion.py's basename stem surfaces tests/delete and tests/delete_regress, with the noisy 'models' parent stem excluded (never tests/model_forms or tests/model_fields)", () => {
    const cwd = makeFixture()
    mkdirSync(join(cwd, "tests"), { recursive: true })
    writeFileSync(join(cwd, "tests", "runtests.py"), "")
    for (const dirName of ["delete", "delete_regress", "model_forms", "model_fields"]) {
      mkdirSync(join(cwd, "tests", dirName), { recursive: true })
    }
    mkdirSync(join(cwd, "django", "db", "models"), { recursive: true })
    writeFileSync(join(cwd, "django", "db", "models", "deletion.py"), "")

    const result = discoverNeighborTests({
      touchedSourceFiles: ["django/db/models/deletion.py"],
      cwd,
    })

    expect(result.map((c) => c.command).sort()).toEqual(
      ["python tests/runtests.py delete --parallel 1", "python tests/runtests.py delete_regress --parallel 1"].sort(),
    )
  })

  it("adds a parent-package stem match via a one-level-below test tree when same-file proximity finds nothing (generic, non-django pytest repo)", () => {
    const cwd = makeFixture()
    mkdirSync(join(cwd, "mypkg", "tests"), { recursive: true })
    writeFileSync(join(cwd, "mypkg", "tests", "test_widgets.py"), "")
    mkdirSync(join(cwd, "mypkg", "widgets"), { recursive: true })
    writeFileSync(join(cwd, "mypkg", "widgets", "render.py"), "")

    const result = discoverNeighborTests({
      touchedSourceFiles: ["mypkg/widgets/render.py"],
      cwd,
    })

    expect(result).toEqual([{ kind: "test", command: "python -m pytest mypkg/tests/test_widgets.py -x -q" }])
  })

  it("applies the 'ion'-stripped morphological variant so a stem still reaches a strictly-prefixed pytest file", () => {
    const cwd = makeFixture()
    mkdirSync(join(cwd, "tests"), { recursive: true })
    writeFileSync(join(cwd, "tests", "test_delete_extra.py"), "")
    mkdirSync(join(cwd, "mypkg", "models"), { recursive: true })
    writeFileSync(join(cwd, "mypkg", "models", "deletion.py"), "")

    const result = discoverNeighborTests({
      touchedSourceFiles: ["mypkg/models/deletion.py"],
      cwd,
    })

    expect(result).toEqual([{ kind: "test", command: "python -m pytest tests/test_delete_extra.py -x -q" }])
  })

  it("excludes a noise parent stem (utils) so it never matches an unrelated test file it would otherwise fuzzy-match", () => {
    const cwd = makeFixture()
    mkdirSync(join(cwd, "tests"), { recursive: true })
    writeFileSync(join(cwd, "tests", "test_utils.py"), "")
    mkdirSync(join(cwd, "pkg", "utils"), { recursive: true })
    writeFileSync(join(cwd, "pkg", "utils", "helpers.py"), "")

    const result = discoverNeighborTests({
      touchedSourceFiles: ["pkg/utils/helpers.py"],
      cwd,
    })

    expect(result).toEqual([])
  })

  it("caps combined proximity + breadth commands at the existing MAX_NEIGHBOR_COMMANDS (3), proximity kept first", () => {
    const cwd = makeFixture()
    mkdirSync(join(cwd, "tests"), { recursive: true })
    writeFileSync(join(cwd, "tests", "test_alpha_one.py"), "")
    writeFileSync(join(cwd, "tests", "test_alpha_two.py"), "")
    writeFileSync(join(cwd, "tests", "test_sub_x.py"), "")
    writeFileSync(join(cwd, "tests", "test_sub_y.py"), "")
    writeFileSync(join(cwd, "tests", "test_sub_z.py"), "")
    mkdirSync(join(cwd, "pkg", "sub"), { recursive: true })
    writeFileSync(join(cwd, "pkg", "sub", "alpha.py"), "")

    const result = discoverNeighborTests({
      touchedSourceFiles: ["pkg/sub/alpha.py"],
      cwd,
    })

    expect(result).toHaveLength(3)
    const commands = result.map((c) => c.command)
    expect(commands).toContain("python -m pytest tests/test_alpha_one.py -x -q")
    expect(commands).toContain("python -m pytest tests/test_alpha_two.py -x -q")
    expect(commands.some((c) => c.includes("test_sub_"))).toBe(true)
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

describe("selectRegressionPinCandidate", () => {
  it("picks the first assertion-shaped (non-env-red, non-zero exit) failure", () => {
    const failures = [
      { command: "python tests/runtests.py auth_tests --parallel 1", exitCode: 1, outputTail: "AssertionError: 2 != 1" },
      { command: "python tests/runtests.py delete_tests --parallel 1", exitCode: 1, outputTail: "AssertionError: 3 != 4" },
    ]
    expect(selectRegressionPinCandidate(failures)).toEqual(failures[0])
  })

  it("skips a MISSING_FILE_RE-shaped failure and pins the next assertion-red one", () => {
    const failures = [
      { command: "python tests/runtests.py missing_dir --parallel 1", exitCode: 2, outputTail: "No such file or directory" },
      { command: "python tests/runtests.py auth_tests --parallel 1", exitCode: 1, outputTail: "AssertionError: 2 != 1" },
    ]
    expect(selectRegressionPinCandidate(failures)).toEqual(failures[1])
  })

  it("skips a MODULE_MISSING_RE-shaped failure and pins the next assertion-red one", () => {
    const failures = [
      {
        command: "python tests/runtests.py auth_tests --parallel 1",
        exitCode: 1,
        outputTail: "ModuleNotFoundError: No module named 'django'",
      },
      { command: "python tests/runtests.py delete_tests --parallel 1", exitCode: 1, outputTail: "AssertionError: 3 != 4" },
    ]
    expect(selectRegressionPinCandidate(failures)).toEqual(failures[1])
  })

  it("skips an exit-0 entry", () => {
    const failures = [
      { command: "python tests/runtests.py auth_tests --parallel 1", exitCode: 0, outputTail: "OK" },
      { command: "python tests/runtests.py delete_tests --parallel 1", exitCode: 1, outputTail: "AssertionError: 3 != 4" },
    ]
    expect(selectRegressionPinCandidate(failures)).toEqual(failures[1])
  })

  it("returns null when every failure is env-red", () => {
    const failures = [
      { command: "python tests/runtests.py missing_dir --parallel 1", exitCode: 2, outputTail: "No such file or directory" },
      {
        command: "python tests/runtests.py auth_tests --parallel 1",
        exitCode: 1,
        outputTail: "ImportError: No module named django",
      },
    ]
    expect(selectRegressionPinCandidate(failures)).toBeNull()
  })

  it("returns null for an empty list", () => {
    expect(selectRegressionPinCandidate([])).toBeNull()
  })
})
