/**
 * Tests for regression-neighbors.ts (packages/opencode/src/session/regression-neighbors.ts):
 * F11's discoverNeighborTests — Django-style tests/runtests.py + tests/<dir> matching, the
 * pytest-style filename fallback under tests/** and the source file's own directory, the
 * no-match empty-array case, and the 3-command cap — F17's additive module-package breadth:
 * the django-11885 scenario (basename stem surfaces tests/delete + tests/delete_regress, the
 * noisy "models" parent stem excluded so tests/model_forms/model_fields never appear), a
 * generic non-django repo reaching a one-level-below package tests/ tree via the parent-stem
 * only, the "ion"-stripped morphological variant reaching a strictly-prefixed pytest file, a
 * noise-stem (utils) exclusion, and the combined proximity+breadth cap enforcement — F19's
 * Django exact-twin pass: an exact `tests/<dir>/test_<stem>.py` hit ranked ahead of the fuzzy
 * `httpwrappers` substring match, absolute touched-file paths relativized before deriving the
 * stem, dedup across repeated twins, and the cap still trimming fuzzy hits first — and
 * F14a's project-interpreter discovery: discoverProjectInterpreter's candidate ordering
 * (repo-local venv, then conda env, then PATH), first-success-wins, the none-found null case,
 * the exact cwd-stripping probe one-liner, and rewriteInterpreter's leading-token swap — and
 * F16's selectRegressionPinCandidate: picks the first assertion-shaped (non-env-red, non-zero
 * exit) regression-gate failure to pin, skipping MISSING_FILE/MODULE_MISSING-shaped and
 * exit-0 entries, `null` on an empty list — and RF-6's rewriteInterpreterCommand: the shared
 * per-command rewrite point (bare python/python3 head swap across `&&`/`;` segments, pipe/
 * backtick/`$(` bail-out, undefined-interpreter passthrough, idempotence on a second pass) —
 * and F20's collectGraphNeighborCandidates (two-hop reverse-call walk, hop-2 never widening,
 * throw-safe empty-map degrade, disk-existence filtering, Django command formation) plus
 * discoverNeighborTests' graphCandidates merge (ranked after twins/before fuzzy, capped,
 * novelty-deduped, round-robin unchanged) — and F21's harvestTurnInterpreter (green/test-shaped/
 * python-headed detection, piped/env-prefixed/laundered-mixed rejection, latest-run-wins) —
 * and H2/H8 (gap-closure-plan.md §2, round 3): detectsModuleLevelSideEffect/
 * isHighP2PBreadthEdit's four side-effect shapes (astropy-13236's module-level DeprecationWarning,
 * astropy-8872's base-class edit, a default-arg change, a class decorator) vs. an indented/
 * unrelated/brand-new-file non-trigger, widenForModuleSideEffect's package-test-dir widening
 * capped at 5, findSiblingTestCommand's H2.2 fail-loud fallback (found/none), and
 * runDifferentialBaseline's H8 pre-edit revert-run-restore (astropy-8707's baseline subtraction
 * per test-id, combined with the kernel's checkClaimCoverage for the false-fire guard: a
 * pre-existing red is excused, a genuinely new one is not).
 */

import { describe, it, expect, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  discoverNeighborTests,
  discoverProjectInterpreter,
  discoverProjectToolchain,
  resolveActiveEcosystem,
  resolveToolchainEcosystem,
  runBuildCheckRung,
  runStructuredTestCommand,
  makeStructuredNeighborRunner,
  projectInterpreterCandidateCount,
  rewriteInterpreter,
  rewriteInterpreterCommand,
  deriveTopLevelPackage,
  selectRegressionPinCandidate,
  collectGraphNeighborCandidates,
  harvestTurnInterpreter,
  detectsModuleLevelSideEffect,
  isHighP2PBreadthEdit,
  widenForModuleSideEffect,
  findSiblingTestCommand,
  runDifferentialBaseline,
} from "../../src/session/regression-neighbors"
import type { NeighborGraphPort } from "../../src/session/regression-neighbors"
import { TEST_SHAPED_COMMAND_RE, LAUNDERED_FAILURE_SIGNATURE_RE, INTERPRETER_TOKEN_RE } from "../../src/session/seen-red"
import { checkClaimCoverage, type Claim, type Evidence } from "@opencode-ai/code-intelligence"
import { ECOSYSTEM_CONVENTIONS, type EcosystemProfile } from "../../src/code-intelligence/repo-profile"

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

describe("discoverNeighborTests — Django exact-twin (F19, highest rank)", () => {
  it("editing django/utils/http.py yields tests/utils_tests/test_http.py FIRST, ahead of the fuzzy tests/httpwrappers hit", () => {
    const cwd = makeFixture()
    mkdirSync(join(cwd, "tests"), { recursive: true })
    writeFileSync(join(cwd, "tests", "runtests.py"), "")
    mkdirSync(join(cwd, "tests", "utils_tests"), { recursive: true })
    writeFileSync(join(cwd, "tests", "utils_tests", "test_http.py"), "")
    mkdirSync(join(cwd, "tests", "httpwrappers"), { recursive: true })
    mkdirSync(join(cwd, "django", "utils"), { recursive: true })
    writeFileSync(join(cwd, "django", "utils", "http.py"), "")

    const result = discoverNeighborTests({
      touchedSourceFiles: ["django/utils/http.py"],
      cwd,
    })

    expect(result[0]).toEqual({
      kind: "test",
      command: "python tests/runtests.py utils_tests.test_http --parallel 1",
    })
    expect(result.map((c) => c.command)).toContain("python tests/runtests.py httpwrappers --parallel 1")
  })

  it("relativizes an ABSOLUTE touched-file path against cwd before deriving the stem (the package=\"\" bug class)", () => {
    const cwd = makeFixture()
    mkdirSync(join(cwd, "tests"), { recursive: true })
    writeFileSync(join(cwd, "tests", "runtests.py"), "")
    mkdirSync(join(cwd, "tests", "utils_tests"), { recursive: true })
    writeFileSync(join(cwd, "tests", "utils_tests", "test_http.py"), "")
    mkdirSync(join(cwd, "django", "utils"), { recursive: true })
    writeFileSync(join(cwd, "django", "utils", "http.py"), "")

    const result = discoverNeighborTests({
      touchedSourceFiles: [join(cwd, "django", "utils", "http.py")],
      cwd,
    })

    expect(result[0]).toEqual({
      kind: "test",
      command: "python tests/runtests.py utils_tests.test_http --parallel 1",
    })
  })

  it("dedups the twin command when two touched files resolve to the same test twin (already found)", () => {
    const cwd = makeFixture()
    mkdirSync(join(cwd, "tests"), { recursive: true })
    writeFileSync(join(cwd, "tests", "runtests.py"), "")
    mkdirSync(join(cwd, "tests", "utils_tests"), { recursive: true })
    writeFileSync(join(cwd, "tests", "utils_tests", "test_http.py"), "")
    mkdirSync(join(cwd, "django", "utils"), { recursive: true })
    writeFileSync(join(cwd, "django", "utils", "http.py"), "")
    mkdirSync(join(cwd, "django", "core"), { recursive: true })
    writeFileSync(join(cwd, "django", "core", "http.py"), "")

    const result = discoverNeighborTests({
      touchedSourceFiles: ["django/utils/http.py", "django/core/http.py"],
      cwd,
    })

    expect(result).toEqual([{ kind: "test", command: "python tests/runtests.py utils_tests.test_http --parallel 1" }])
  })

  it("still trims fuzzy hits, never a twin, when the combined pass 0+1+2 total exceeds MAX_NEIGHBOR_COMMANDS", () => {
    const cwd = makeFixture()
    mkdirSync(join(cwd, "tests"), { recursive: true })
    writeFileSync(join(cwd, "tests", "runtests.py"), "")
    mkdirSync(join(cwd, "tests", "utils_tests"), { recursive: true })
    writeFileSync(join(cwd, "tests", "utils_tests", "test_http.py"), "")
    for (const dirName of ["httpwrappers", "http_extra", "http_more"]) {
      mkdirSync(join(cwd, "tests", dirName), { recursive: true })
    }
    mkdirSync(join(cwd, "django", "utils"), { recursive: true })
    writeFileSync(join(cwd, "django", "utils", "http.py"), "")

    const result = discoverNeighborTests({
      touchedSourceFiles: ["django/utils/http.py"],
      cwd,
    })

    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({
      kind: "test",
      command: "python tests/runtests.py utils_tests.test_http --parallel 1",
    })
  })

  it("returns [] for the exact-twin pass alone when no tests/<dir>/test_<stem>.py matches (fuzzy passes still apply)", () => {
    const cwd = makeFixture()
    mkdirSync(join(cwd, "tests"), { recursive: true })
    writeFileSync(join(cwd, "tests", "runtests.py"), "")
    mkdirSync(join(cwd, "tests", "delete"), { recursive: true })
    mkdirSync(join(cwd, "django", "db", "models"), { recursive: true })
    writeFileSync(join(cwd, "django", "db", "models", "deletion.py"), "")

    const result = discoverNeighborTests({
      touchedSourceFiles: ["django/db/models/deletion.py"],
      cwd,
    })

    expect(result).toEqual([{ kind: "test", command: "python tests/runtests.py delete --parallel 1" }])
  })
})

describe("discoverNeighborTests — round-robin across touched files (django-11885 round C replay)", () => {
  it("a scratch file's fuzzy twin matches never crowd out a second touched file's real neighbors", () => {
    const cwd = makeFixture()
    mkdirSync(join(cwd, "tests"), { recursive: true })
    writeFileSync(join(cwd, "tests", "runtests.py"), "")
    mkdirSync(join(cwd, "tests", "delete"), { recursive: true })
    mkdirSync(join(cwd, "tests", "delete_regress"), { recursive: true })
    for (const dirName of ["auth_tests", "flatpages_tests", "invalid_models_tests"]) {
      mkdirSync(join(cwd, "tests", dirName), { recursive: true })
      writeFileSync(join(cwd, "tests", dirName, "test_models.py"), "")
    }
    mkdirSync(join(cwd, "django", "db", "models"), { recursive: true })
    writeFileSync(join(cwd, "django", "db", "models", "deletion.py"), "")
    mkdirSync(join(cwd, "_repro_app"), { recursive: true })
    writeFileSync(join(cwd, "_repro_app", "models.py"), "")

    const result = discoverNeighborTests({
      touchedSourceFiles: ["django/db/models/deletion.py", "_repro_app/models.py"],
      cwd,
    })

    expect(result).toHaveLength(3)
    expect(result.slice(0, 3).map((c) => c.command)).toContain("python tests/runtests.py delete --parallel 1")
  })

  it("single touched file is byte-identical to the pre-round-robin behavior", () => {
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

describe("rewriteInterpreterCommand", () => {
  it("rewrites a bare python head", () => {
    const result = rewriteInterpreterCommand("python repro_issue.py", "/repo/.venv/bin/python")
    expect(result).toBe("/repo/.venv/bin/python repro_issue.py")
  })

  it("rewrites a bare python3 head, leaving the rest of the command alone", () => {
    const result = rewriteInterpreterCommand("python3 -m pytest tests/x.py", "/repo/.venv/bin/python")
    expect(result).toBe("/repo/.venv/bin/python -m pytest tests/x.py")
  })

  it("rewrites only the segment whose head is python, after a `&&`", () => {
    const result = rewriteInterpreterCommand("cd /x && python repro.py", "/repo/.venv/bin/python")
    expect(result).toBe("cd /x && /repo/.venv/bin/python repro.py")
  })

  it("leaves an already-absolute interpreter head untouched", () => {
    const result = rewriteInterpreterCommand("/usr/bin/python3 x.py", "/repo/.venv/bin/python")
    expect(result).toBe("/usr/bin/python3 x.py")
  })

  it("leaves a non-python head untouched", () => {
    const result = rewriteInterpreterCommand("pytest tests/x.py", "/repo/.venv/bin/python")
    expect(result).toBe("pytest tests/x.py")
  })

  it("bails out unchanged on a piped command", () => {
    const result = rewriteInterpreterCommand("python x.py | tee log", "/repo/.venv/bin/python")
    expect(result).toBe("python x.py | tee log")
  })

  it("passes the command through unchanged when interpreter is undefined", () => {
    const result = rewriteInterpreterCommand("python x.py", undefined)
    expect(result).toBe("python x.py")
  })

  it("is idempotent — rewriting an already-rewritten command changes nothing", () => {
    const once = rewriteInterpreterCommand("python repro_issue.py", "/repo/.venv/bin/python")
    const twice = rewriteInterpreterCommand(once, "/repo/.venv/bin/python")
    expect(twice).toBe(once)
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

describe("collectGraphNeighborCandidates — F20 graph-derived reach", () => {
  it("shapely-2226 shape: two-hop reverse-call walk reaches BOTH the direct test caller and the caller-of-caller test, depth-1 first", async () => {
    const cwd = makeFixture()
    mkdirSync(join(cwd, "shapely", "geometry"), { recursive: true })
    writeFileSync(join(cwd, "shapely", "geometry", "collection.py"), "")
    mkdirSync(join(cwd, "shapely", "tests", "geometry"), { recursive: true })
    writeFileSync(join(cwd, "shapely", "tests", "geometry", "test_collection.py"), "")
    writeFileSync(join(cwd, "shapely", "tests", "test_split.py"), "")

    const graph: NeighborGraphPort = {
      async getEntitiesInFile(filePath) {
        if (filePath === "shapely/geometry/collection.py") {
          return [{ name: "GeometryCollection", filePath: "shapely/geometry/collection.py", kind: "class" }]
        }
        if (filePath === "shapely/ops.py") {
          return [{ name: "split", filePath: "shapely/ops.py", kind: "function" }]
        }
        return []
      },
      async getCallers(entityKey) {
        if (entityKey === "shapely/geometry/collection.py:GeometryCollection:class") {
          return [
            { from_file: "shapely/ops.py", from_entity: "split" },
            { from_file: "shapely/tests/geometry/test_collection.py", from_entity: "test_x" },
          ]
        }
        if (entityKey === "shapely/ops.py:split:function") {
          return [{ from_file: "shapely/tests/test_split.py", from_entity: "test_split_line" }]
        }
        return []
      },
    }

    const result = await collectGraphNeighborCandidates({
      touchedSourceFiles: ["shapely/geometry/collection.py"],
      cwd,
      graph,
    })

    expect(result.get("shapely/geometry/collection.py")).toEqual([
      "python -m pytest shapely/tests/geometry/test_collection.py -x -q",
      "python -m pytest shapely/tests/test_split.py -x -q",
    ])
  })

  it("hop-2 never widens: a non-test caller-of-caller file is ignored, only its test-file siblings count", async () => {
    const cwd = makeFixture()
    mkdirSync(join(cwd, "pkg"), { recursive: true })
    writeFileSync(join(cwd, "pkg", "mod.py"), "")
    mkdirSync(join(cwd, "pkg", "tests"), { recursive: true })
    writeFileSync(join(cwd, "pkg", "tests", "test_bar.py"), "")

    const graph: NeighborGraphPort = {
      async getEntitiesInFile(filePath) {
        if (filePath === "pkg/mod.py") return [{ name: "foo", filePath: "pkg/mod.py", kind: "function" }]
        if (filePath === "pkg/caller.py") return [{ name: "bar", filePath: "pkg/caller.py", kind: "function" }]
        return []
      },
      async getCallers(entityKey) {
        if (entityKey === "pkg/mod.py:foo:function") {
          return [{ from_file: "pkg/caller.py", from_entity: "bar" }]
        }
        if (entityKey === "pkg/caller.py:bar:function") {
          return [
            { from_file: "pkg/other_caller.py", from_entity: "baz" },
            { from_file: "pkg/tests/test_bar.py", from_entity: "test_bar" },
          ]
        }
        return []
      },
    }

    const result = await collectGraphNeighborCandidates({
      touchedSourceFiles: ["pkg/mod.py"],
      cwd,
      graph,
    })

    expect(result.get("pkg/mod.py")).toEqual(["python -m pytest pkg/tests/test_bar.py -x -q"])
  })

  it("a graph port whose methods throw resolves to an empty map, never rejects", async () => {
    const cwd = makeFixture()
    const graph: NeighborGraphPort = {
      async getEntitiesInFile() {
        throw new Error("graph unavailable")
      },
      async getCallers() {
        throw new Error("graph unavailable")
      },
    }

    const result = await collectGraphNeighborCandidates({
      touchedSourceFiles: ["pkg/mod.py"],
      cwd,
      graph,
    })

    expect(result).toEqual(new Map())
  })

  it("drops a graph-known test file that does not exist on disk", async () => {
    const cwd = makeFixture()
    mkdirSync(join(cwd, "pkg"), { recursive: true })
    writeFileSync(join(cwd, "pkg", "mod.py"), "")
    // pkg/tests/test_missing.py is deliberately never created on disk.

    const graph: NeighborGraphPort = {
      async getEntitiesInFile(filePath) {
        if (filePath === "pkg/mod.py") return [{ name: "foo", filePath: "pkg/mod.py", kind: "function" }]
        return []
      },
      async getCallers(entityKey) {
        if (entityKey === "pkg/mod.py:foo:function") {
          return [{ from_file: "pkg/tests/test_missing.py", from_entity: "test_x" }]
        }
        return []
      },
    }

    const result = await collectGraphNeighborCandidates({
      touchedSourceFiles: ["pkg/mod.py"],
      cwd,
      graph,
    })

    expect(result.has("pkg/mod.py")).toBe(false)
  })

  it("forms the Django runtests command for a graph-reached tests/<dir>/tests.py file", async () => {
    const cwd = makeFixture()
    mkdirSync(join(cwd, "tests"), { recursive: true })
    writeFileSync(join(cwd, "tests", "runtests.py"), "")
    mkdirSync(join(cwd, "django", "db", "models"), { recursive: true })
    writeFileSync(join(cwd, "django", "db", "models", "deletion.py"), "")
    mkdirSync(join(cwd, "tests", "delete_regress"), { recursive: true })
    writeFileSync(join(cwd, "tests", "delete_regress", "tests.py"), "")

    const graph: NeighborGraphPort = {
      async getEntitiesInFile(filePath) {
        if (filePath === "django/db/models/deletion.py") {
          return [{ name: "delete_objects", filePath: "django/db/models/deletion.py", kind: "function" }]
        }
        return []
      },
      async getCallers(entityKey) {
        if (entityKey === "django/db/models/deletion.py:delete_objects:function") {
          return [{ from_file: "tests/delete_regress/tests.py", from_entity: "test_delete" }]
        }
        return []
      },
    }

    const result = await collectGraphNeighborCandidates({
      touchedSourceFiles: ["django/db/models/deletion.py"],
      cwd,
      graph,
    })

    expect(result.get("django/db/models/deletion.py")).toEqual([
      "python tests/runtests.py delete_regress --parallel 1",
    ])
  })
})

describe("discoverNeighborTests — F20 graphCandidates param", () => {
  it("ranks a touched file's novel graph candidates AFTER its Django exact twin and BEFORE its fuzzy hits, capped at 2 per file", () => {
    const cwd = makeFixture()
    mkdirSync(join(cwd, "tests"), { recursive: true })
    writeFileSync(join(cwd, "tests", "runtests.py"), "")
    mkdirSync(join(cwd, "tests", "model_meta"), { recursive: true })
    writeFileSync(join(cwd, "tests", "model_meta", "test_deletion.py"), "")
    mkdirSync(join(cwd, "tests", "delete"), { recursive: true })
    mkdirSync(join(cwd, "django", "db", "models"), { recursive: true })
    writeFileSync(join(cwd, "django", "db", "models", "deletion.py"), "")

    const graphCandidates = new Map<string, string[]>([
      [
        "django/db/models/deletion.py",
        [
          "python tests/runtests.py delete_regress --parallel 1",
          "python tests/runtests.py auth_tests --parallel 1",
          "python tests/runtests.py flatpages_tests --parallel 1",
        ],
      ],
    ])

    const result = discoverNeighborTests({
      touchedSourceFiles: ["django/db/models/deletion.py"],
      cwd,
      graphCandidates,
    })

    expect(result.map((c) => c.command)).toEqual([
      "python tests/runtests.py model_meta.test_deletion --parallel 1",
      "python tests/runtests.py delete_regress --parallel 1",
      "python tests/runtests.py auth_tests --parallel 1",
    ])
  })

  it("does not double-count a graph candidate that is byte-identical to a filename-rung candidate", () => {
    const cwd = makeFixture()
    mkdirSync(join(cwd, "tests"), { recursive: true })
    writeFileSync(join(cwd, "tests", "test_alpha_one.py"), "")
    mkdirSync(join(cwd, "pkg", "sub"), { recursive: true })
    writeFileSync(join(cwd, "pkg", "sub", "alpha.py"), "")

    const graphCandidates = new Map<string, string[]>([
      [
        "pkg/sub/alpha.py",
        [
          "python -m pytest tests/test_alpha_one.py -x -q",
          "python -m pytest tests/test_alpha_extra.py -x -q",
        ],
      ],
    ])

    const result = discoverNeighborTests({
      touchedSourceFiles: ["pkg/sub/alpha.py"],
      cwd,
      graphCandidates,
    })

    const commands = result.map((c) => c.command)
    expect(commands).toEqual([
      "python -m pytest tests/test_alpha_extra.py -x -q",
      "python -m pytest tests/test_alpha_one.py -x -q",
    ])
    expect(commands.filter((c) => c === "python -m pytest tests/test_alpha_one.py -x -q")).toHaveLength(1)
  })

  it("keeps round-robin across touched files unchanged when both files carry graph candidates", () => {
    const cwd = makeFixture()
    mkdirSync(join(cwd, "pkg"), { recursive: true })
    writeFileSync(join(cwd, "pkg", "a.py"), "")
    writeFileSync(join(cwd, "pkg", "b.py"), "")

    const graphCandidates = new Map<string, string[]>([
      ["pkg/a.py", ["python -m pytest tests/test_a1.py -x -q", "python -m pytest tests/test_a2.py -x -q"]],
      ["pkg/b.py", ["python -m pytest tests/test_b1.py -x -q", "python -m pytest tests/test_b2.py -x -q"]],
    ])

    const result = discoverNeighborTests({
      touchedSourceFiles: ["pkg/a.py", "pkg/b.py"],
      cwd,
      graphCandidates,
    })

    expect(result.map((c) => c.command)).toEqual([
      "python -m pytest tests/test_a1.py -x -q",
      "python -m pytest tests/test_b1.py -x -q",
      "python -m pytest tests/test_a2.py -x -q",
    ])
  })
})

describe("harvestTurnInterpreter — F21 turn-harvested interpreter", () => {
  it("returns 'python' for a green 'python -m pytest tests/ -q' run reporting N passed", () => {
    const result = harvestTurnInterpreter([{ command: "python -m pytest tests/ -q", exitCode: 0, output: "12 passed" }])
    expect(result).toBe("python")
  })

  it("returns the full interpreter path for a green venv-pathed pytest run", () => {
    const result = harvestTurnInterpreter([
      { command: "/testbed/venv/bin/python -m pytest x.py -q", exitCode: 0, output: "1 passed" },
    ])
    expect(result).toBe("/testbed/venv/bin/python")
  })

  it("returns 'python' for a green run behind a 'cd <dir> && ' prefix", () => {
    const result = harvestTurnInterpreter([{ command: "cd /testbed && python -m pytest a.py", exitCode: 0, output: "1 passed" }])
    expect(result).toBe("python")
  })

  it("skips an exit-0 run whose output has no green test signature (e.g. a bare version print)", () => {
    const result = harvestTurnInterpreter([{ command: "python -m pytest --version", exitCode: 0, output: "pytest 7.4.0" }])
    expect(result).toBeNull()
  })

  it("skips a laundered mixed result ('N passed, M failed')", () => {
    const result = harvestTurnInterpreter([
      { command: "python -m pytest tests/ -q", exitCode: 0, output: "3 passed, 1 failed" },
    ])
    expect(result).toBeNull()
  })

  it("skips a piped command — the exit code may not belong to the test run", () => {
    const result = harvestTurnInterpreter([{ command: "python -m pytest a.py | tail -5", exitCode: 0, output: "1 passed" }])
    expect(result).toBeNull()
  })

  it("skips an env-prefixed command — only a bare or pathed python* head is evidence of which interpreter ran", () => {
    const result = harvestTurnInterpreter([
      { command: "DJANGO_SETTINGS_MODULE=x python -m pytest a.py", exitCode: 0, output: "1 passed" },
    ])
    expect(result).toBeNull()
  })

  it("skips a red (non-zero exit) run", () => {
    const result = harvestTurnInterpreter([{ command: "python -m pytest a.py", exitCode: 1, output: "1 passed" }])
    expect(result).toBeNull()
  })

  it("skips a non-test-shaped green run", () => {
    const result = harvestTurnInterpreter([{ command: "python setup.py build", exitCode: 0, output: "OK" }])
    expect(result).toBeNull()
  })

  it("returns the LATER interpreter when two green runs are present", () => {
    const result = harvestTurnInterpreter([
      { command: "python -m pytest a.py -q", exitCode: 0, output: "1 passed" },
      { command: "/opt/venv/bin/python -m pytest b.py -q", exitCode: 0, output: "1 passed" },
    ])
    expect(result).toBe("/opt/venv/bin/python")
  })

  it("returns null for an empty executions list", () => {
    expect(harvestTurnInterpreter([])).toBeNull()
  })

  it("returns 'python' for a Django runtests.py run whose output ends in 'OK'", () => {
    const result = harvestTurnInterpreter([
      { command: "python tests/runtests.py delete --parallel 1", exitCode: 0, output: "Ran 3 tests in 0.012s\n\nOK" },
    ])
    expect(result).toBe("python")
  })
})

describe("seen-red.ts exports the regexes harvestTurnInterpreter depends on", () => {
  it("still exports TEST_SHAPED_COMMAND_RE, LAUNDERED_FAILURE_SIGNATURE_RE, and INTERPRETER_TOKEN_RE", () => {
    expect(TEST_SHAPED_COMMAND_RE).toBeInstanceOf(RegExp)
    expect(LAUNDERED_FAILURE_SIGNATURE_RE).toBeInstanceOf(RegExp)
    expect(INTERPRETER_TOKEN_RE).toBeInstanceOf(RegExp)
  })
})

describe("detectsModuleLevelSideEffect — H2.1 import-time side-effect heuristic", () => {
  it("astropy-13236 shape: a module-level warnings.warn(...) added at column 0 trips it", () => {
    const oldContent = "import warnings\n\ndef helper():\n    return 1\n"
    const newContent = 'import warnings\n\nwarnings.warn("old API", DeprecationWarning)\n\ndef helper():\n    return 1\n'
    expect(detectsModuleLevelSideEffect(oldContent, newContent)).toBe(true)
  })

  it("the same warnings.warn(...) call INDENTED inside a function does not trip it", () => {
    const oldContent = "def helper():\n    return 1\n"
    const newContent = 'def helper():\n    warnings.warn("inside", DeprecationWarning)\n    return 1\n'
    expect(detectsModuleLevelSideEffect(oldContent, newContent)).toBe(false)
  })

  it("a decorator directly above a module-level class trips it", () => {
    const oldContent = "class Foo:\n    pass\n"
    const newContent = "@total_ordering\nclass Foo:\n    pass\n"
    expect(detectsModuleLevelSideEffect(oldContent, newContent)).toBe(true)
  })

  it("a decorator above a def (not a class) does not trip it", () => {
    const oldContent = "def helper():\n    return 1\n"
    const newContent = "@cache\ndef helper():\n    return 1\n"
    expect(detectsModuleLevelSideEffect(oldContent, newContent)).toBe(false)
  })

  it("a bare module-level call (registry mutation) trips it", () => {
    const oldContent = "def helper():\n    return 1\n"
    const newContent = "def helper():\n    return 1\n\nregister_default_converter()\n"
    expect(detectsModuleLevelSideEffect(oldContent, newContent)).toBe(true)
  })

  it("a body-only edit unrelated to module scope does not trip it", () => {
    const oldContent = "def helper():\n    return 1\n"
    const newContent = "def helper():\n    return 2\n"
    expect(detectsModuleLevelSideEffect(oldContent, newContent)).toBe(false)
  })

  it("a brand-new file (no oldContent) never trips it", () => {
    expect(detectsModuleLevelSideEffect("", "warnings.warn('x')\n")).toBe(false)
  })
})

describe("isHighP2PBreadthEdit — H2.4 high-P2P-breadth classification", () => {
  it("astropy-8872 shape: a class base-list edit trips it", () => {
    const oldContent = "class Quantity:\n    pass\n"
    const newContent = "class Quantity(np.ndarray):\n    pass\n"
    expect(isHighP2PBreadthEdit(oldContent, newContent)).toBe(true)
  })

  it("a function default-argument change trips it", () => {
    const oldContent = "def convert(value, dtype=None):\n    return value\n"
    const newContent = "def convert(value, dtype=float):\n    return value\n"
    expect(isHighP2PBreadthEdit(oldContent, newContent)).toBe(true)
  })

  it("subsumes detectsModuleLevelSideEffect's own shapes (13236)", () => {
    const oldContent = "def helper():\n    return 1\n"
    const newContent = 'warnings.warn("old", DeprecationWarning)\n\ndef helper():\n    return 1\n'
    expect(isHighP2PBreadthEdit(oldContent, newContent)).toBe(true)
  })

  it("an unrelated body-only edit does not trip it", () => {
    const oldContent = "def helper():\n    return 1\n"
    const newContent = "def helper():\n    return 2\n"
    expect(isHighP2PBreadthEdit(oldContent, newContent)).toBe(false)
  })
})

describe("widenForModuleSideEffect — H2.1/H2.4 widening, capped at 5", () => {
  it("includes every test_*.py under the touched file's top-level package tests/ dir, capped", () => {
    const cwd = makeFixture()
    mkdirSync(join(cwd, "mypkg", "tests"), { recursive: true })
    for (const name of ["test_a", "test_b", "test_c", "test_d", "test_e", "test_f"]) {
      writeFileSync(join(cwd, "mypkg", "tests", `${name}.py`), "")
    }
    writeFileSync(join(cwd, "mypkg", "core.py"), "")

    const result = widenForModuleSideEffect("mypkg/core.py", cwd)

    expect(result.length).toBeLessThanOrEqual(5)
    expect(result.length).toBeGreaterThan(0)
    expect(result.every((c) => c.kind === "test")).toBe(true)
    expect(result.every((c) => /mypkg\/tests\/test_\w+\.py/.test(c.command))).toBe(true)
  })

  it("uses the Django runtests.py app-level command for a Django repo", () => {
    const cwd = makeFixture()
    mkdirSync(join(cwd, "tests"), { recursive: true })
    writeFileSync(join(cwd, "tests", "runtests.py"), "")
    mkdirSync(join(cwd, "django", "db", "models"), { recursive: true })
    writeFileSync(join(cwd, "django", "db", "models", "deletion.py"), "")

    const result = widenForModuleSideEffect("django/db/models/deletion.py", cwd)

    expect(result.some((c) => c.command === "python tests/runtests.py django --parallel 1")).toBe(true)
  })
})

describe("findSiblingTestCommand — H2.2 fail-loud fallback", () => {
  it("finds test_<stem>.py in the same directory as the touched Python file", () => {
    const cwd = makeFixture()
    mkdirSync(join(cwd, "pkg"), { recursive: true })
    writeFileSync(join(cwd, "pkg", "widget.py"), "")
    writeFileSync(join(cwd, "pkg", "test_widget.py"), "")

    const result = findSiblingTestCommand("pkg/widget.py", cwd)

    expect(result).toEqual({ kind: "test", command: "python -m pytest pkg/test_widget.py -x -q" })
  })

  it("returns null when no sibling test file exists — the caller surfaces unverifiable regression surface", () => {
    const cwd = makeFixture()
    mkdirSync(join(cwd, "pkg"), { recursive: true })
    writeFileSync(join(cwd, "pkg", "widget.py"), "")

    expect(findSiblingTestCommand("pkg/widget.py", cwd)).toBeNull()
  })
})

describe("runDifferentialBaseline — H8 differential regression baseline", () => {
  it("astropy-8707 shape: reverts touched files to HEAD, runs neighbors once, restores current content", async () => {
    const headContent = new Map([["astropy/_np_utils.pyx", "# old: uses np.int\n"]])
    const currentContent = new Map([["astropy/_np_utils.pyx", "# new: uses np.int_\n"]])
    const writes: { filePath: string; content: string }[] = []
    const neighbors = [{ kind: "test" as const, command: "python -m pytest astropy/tests/test_np_utils.py -x -q" }]

    const baseline = await runDifferentialBaseline({
      touchedSourceFiles: ["astropy/_np_utils.pyx"],
      neighbors,
      runner: async () => ({ exitCode: 1, stdout: "", stderr: "AttributeError: module 'numpy' has no attribute 'int'" }),
      readHeadContent: async (f) => headContent.get(f) ?? null,
      readCurrentContent: async (f) => currentContent.get(f)!,
      writeContent: async (f, c) => {
        writes.push({ filePath: f, content: c })
      },
    })

    expect([...baseline]).toEqual(["python -m pytest astropy/tests/test_np_utils.py -x -q"])
    // Reverted to HEAD first (for the run), then restored to current content — in that order.
    expect(writes).toEqual([
      { filePath: "astropy/_np_utils.pyx", content: "# old: uses np.int\n" },
      { filePath: "astropy/_np_utils.pyx", content: "# new: uses np.int_\n" },
    ])
  })

  it("leaves a brand-new file (no HEAD blob) untouched", async () => {
    const writes: { filePath: string; content: string }[] = []
    const neighbors = [{ kind: "test" as const, command: "python -m pytest a.py -x -q" }]

    await runDifferentialBaseline({
      touchedSourceFiles: ["new_file.py"],
      neighbors,
      runner: async () => ({ exitCode: 0, stdout: "1 passed", stderr: "" }),
      readHeadContent: async () => null,
      readCurrentContent: async () => "should never be read",
      writeContent: async (f, c) => {
        writes.push({ filePath: f, content: c })
      },
    })

    expect(writes).toEqual([])
  })

  it("restores content in a finally even if the runner throws", async () => {
    const writes: { filePath: string; content: string }[] = []
    const neighbors = [{ kind: "test" as const, command: "python -m pytest a.py -x -q" }]

    await expect(
      runDifferentialBaseline({
        touchedSourceFiles: ["a.py"],
        neighbors,
        runner: async () => {
          throw new Error("boom")
        },
        readHeadContent: async () => "old\n",
        readCurrentContent: async () => "new\n",
        writeContent: async (f, c) => {
          writes.push({ filePath: f, content: c })
        },
      }),
    ).rejects.toThrow("boom")

    expect(writes).toEqual([
      { filePath: "a.py", content: "old\n" },
      { filePath: "a.py", content: "new\n" },
    ])
  })

  it("false-fire guard: combined with checkClaimCoverage, a pre-existing red is excused but a genuinely new one still denies (per test-id, not per-file)", async () => {
    const neighbors = [
      { kind: "test" as const, command: "python -m pytest astropy/tests/test_np_utils.py::test_np_int -x -q" },
      { kind: "test" as const, command: "python -m pytest astropy/tests/test_np_utils.py::test_real_regression -x -q" },
    ]
    // Pre-edit (baseline) run: only test_np_int fails (the arena's own broken np.int import).
    const baseline = await runDifferentialBaseline({
      touchedSourceFiles: ["astropy/_np_utils.pyx"],
      neighbors,
      runner: async (cmd) => ({
        exitCode: cmd.command.includes("test_np_int") ? 1 : 0,
        stdout: "",
        stderr: cmd.command.includes("test_np_int") ? "AttributeError: module 'numpy' has no attribute 'int'" : "",
      }),
      readHeadContent: async () => "old\n",
      readCurrentContent: async () => "new\n",
      writeContent: async () => {},
    })
    expect([...baseline]).toEqual(["python -m pytest astropy/tests/test_np_utils.py::test_np_int -x -q"])

    // Post-edit run: BOTH fail now — test_np_int is the same pre-existing env
    // red, test_real_regression is a genuinely new, model-induced red.
    const claim: Claim = { kind: "no_regressions", scope: { kind: "tests", items: neighbors.map((n) => n.command) } }
    const evidence: Evidence = {
      scope: claim.scope,
      items: [
        { id: neighbors[0]!.command, verdict: "fail" },
        { id: neighbors[1]!.command, verdict: "fail" },
      ],
      baseline: [...baseline],
    }
    const verdict = checkClaimCoverage(claim, evidence)

    expect(verdict.covered).toBe(false)
    expect(verdict.preExisting).toEqual([neighbors[0]!.command])
    expect(verdict.failing).toEqual([neighbors[1]!.command])
  })
})

describe("discoverNeighborTests — P3 table-driven twin discovery (agnostic-hands-eyes.md §4.2)", () => {
  it("django byte-parity: the exact-twin command is reproducible byte-for-byte from the python-django row's own singleTestTemplate", () => {
    const cwd = makeFixture()
    mkdirSync(join(cwd, "tests"), { recursive: true })
    writeFileSync(join(cwd, "tests", "runtests.py"), "")
    mkdirSync(join(cwd, "tests", "httpwrappers"), { recursive: true })
    writeFileSync(join(cwd, "tests", "httpwrappers", "test_http.py"), "")
    mkdirSync(join(cwd, "django", "utils"), { recursive: true })
    writeFileSync(join(cwd, "django", "utils", "http.py"), "")

    const result = discoverNeighborTests({ touchedSourceFiles: ["django/utils/http.py"], cwd })

    const djangoRow = ECOSYSTEM_CONVENTIONS.find((r) => r.id === "python-django")!
    const expected = djangoRow.singleTestTemplate.replace("{testId}", "httpwrappers.test_http --parallel 1")
    expect(expected).toBe("python tests/runtests.py httpwrappers.test_http --parallel 1")
    expect(result[0]).toEqual({ kind: "test", command: expected })
  })

  it("js: matches a __tests__/<stem>.test.ts twin via the javascript-jest row and forms `npx jest <path>`", () => {
    const cwd = makeFixture()
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "proj", devDependencies: {} }))
    mkdirSync(join(cwd, "src"), { recursive: true })
    writeFileSync(join(cwd, "src", "foo.ts"), "")
    mkdirSync(join(cwd, "__tests__"), { recursive: true })
    writeFileSync(join(cwd, "__tests__", "foo.test.ts"), "")

    const result = discoverNeighborTests({ touchedSourceFiles: ["src/foo.ts"], cwd })

    expect(result).toEqual([{ kind: "test", command: "npx jest __tests__/foo.test.ts" }])
  })

  it("go: matches a same-package <stem>_test.go twin and forms a package-scoped `go test ./<pkgDir>`", () => {
    const cwd = makeFixture()
    writeFileSync(join(cwd, "go.mod"), "module example.com/proj\n\ngo 1.21\n")
    mkdirSync(join(cwd, "pkg"), { recursive: true })
    writeFileSync(join(cwd, "pkg", "foo.go"), "package pkg\n")
    writeFileSync(join(cwd, "pkg", "foo_test.go"), "package pkg\n")

    const result = discoverNeighborTests({ touchedSourceFiles: ["pkg/foo.go"], cwd })

    expect(result).toEqual([{ kind: "test", command: "go test ./pkg" }])
  })

  it("rust: matches a tests/<stem>.rs integration twin and forms `cargo test --test <stem>`", () => {
    const cwd = makeFixture()
    writeFileSync(join(cwd, "Cargo.toml"), "[package]\nname = \"proj\"\n")
    mkdirSync(join(cwd, "src"), { recursive: true })
    writeFileSync(join(cwd, "src", "widget.rs"), "")
    mkdirSync(join(cwd, "tests"), { recursive: true })
    writeFileSync(join(cwd, "tests", "widget.rs"), "")

    const result = discoverNeighborTests({ touchedSourceFiles: ["src/widget.rs"], cwd })

    expect(result).toEqual([{ kind: "test", command: "cargo test --test widget" }])
  })

  it("java: matches the src/test/java mirror-path twin (<Stem>Test.java) and forms `mvn test -Dtest=<ClassName>`", () => {
    const cwd = makeFixture()
    writeFileSync(join(cwd, "pom.xml"), "<project></project>")
    mkdirSync(join(cwd, "src", "main", "java", "com", "example"), { recursive: true })
    writeFileSync(join(cwd, "src", "main", "java", "com", "example", "Widget.java"), "")
    mkdirSync(join(cwd, "src", "test", "java", "com", "example"), { recursive: true })
    writeFileSync(join(cwd, "src", "test", "java", "com", "example", "WidgetTest.java"), "")

    const result = discoverNeighborTests({ touchedSourceFiles: ["src/main/java/com/example/Widget.java"], cwd })

    expect(result).toEqual([{ kind: "test", command: "mvn test -Dtest=WidgetTest" }])
  })

  it("a plain python repo (no other ecosystem manifest) is unaffected — pytest fallback still applies", () => {
    const cwd = makeFixture()
    mkdirSync(join(cwd, "tests"), { recursive: true })
    writeFileSync(join(cwd, "tests", "test_http.py"), "")
    mkdirSync(join(cwd, "utils"), { recursive: true })
    writeFileSync(join(cwd, "utils", "http.py"), "")

    const result = discoverNeighborTests({ touchedSourceFiles: ["utils/http.py"], cwd })

    expect(result).toEqual([{ kind: "test", command: "python -m pytest tests/test_http.py -x -q" }])
  })
})

describe("discoverProjectToolchain — P2a per-ecosystem toolchain probe ladder (agnostic-hands-eyes.md §2.3)", () => {
  const originalHome = process.env.HOME

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
  })

  it("python routes straight through to discoverProjectInterpreter, unaffected by ecosystem generalization", async () => {
    const cwd = makeFixture()
    mkdirSync(join(cwd, ".venv", "bin"), { recursive: true })
    writeFileSync(join(cwd, ".venv", "bin", "python"), "")

    const result = await discoverProjectToolchain({
      cwd,
      ecosystem: "python",
      topLevelPackage: "django",
      runner: async (command) => ({ exitCode: command.command.includes(".venv") ? 0 : 1, stdout: "", stderr: "" }),
    })

    expect(result).toBe(join(cwd, ".venv", "bin", "python"))
  })

  it("prefers `mise which <tool>` when a mise binary is on PATH and a .tool-versions pin exists", async () => {
    const cwd = makeFixture()
    writeFileSync(join(cwd, ".tool-versions"), "nodejs 20.10.0\n")
    const probed: string[] = []

    const result = await discoverProjectToolchain({
      cwd,
      ecosystem: "javascript",
      runner: async (command) => {
        probed.push(command.command)
        if (command.command === "mise --version") return { exitCode: 0, stdout: "2024.1.0", stderr: "" }
        if (command.command === "mise which node") return { exitCode: 0, stdout: "/home/user/.local/share/mise/installs/node/20.10.0/bin/node\n", stderr: "" }
        return { exitCode: 1, stdout: "", stderr: "" }
      },
    })

    expect(result).toBe("/home/user/.local/share/mise/installs/node/20.10.0/bin/node")
    expect(probed).toEqual(["mise --version", "mise which node"])
  })

  it("mise-absent fallback: no pin file at all skips the mise rung and probes the ecosystem's own minimal ladder", async () => {
    const cwd = makeFixture()
    const probed: string[] = []

    const result = await discoverProjectToolchain({
      cwd,
      ecosystem: "go",
      runner: async (command) => {
        probed.push(command.command)
        return { exitCode: command.command === "go --version" ? 0 : 1, stdout: "", stderr: "" }
      },
    })

    expect(result).toBe("go")
    expect(probed).toEqual(["go --version"])
    expect(probed.some((c) => c.startsWith("mise"))).toBe(false)
  })

  it("mise-absent fallback: a pin file present but no mise binary on PATH still falls through to the ecosystem ladder", async () => {
    const cwd = makeFixture()
    writeFileSync(join(cwd, "mise.toml"), "[tools]\nrust = \"1.75.0\"\n")

    const result = await discoverProjectToolchain({
      cwd,
      ecosystem: "rust",
      runner: async (command) => ({ exitCode: command.command === "cargo --version" ? 0 : 1, stdout: "", stderr: "" }),
    })

    expect(result).toBe("cargo")
  })

  it("node ladder is .nvmrc-aware: an .nvmrc-named version is probed before the bare PATH node", async () => {
    const cwd = makeFixture()
    writeFileSync(join(cwd, ".nvmrc"), "18.19.0\n")
    process.env.HOME = cwd
    const probed: string[] = []

    const result = await discoverProjectToolchain({
      cwd,
      ecosystem: "javascript",
      runner: async (command) => {
        probed.push(command.command)
        return { exitCode: 1, stdout: "", stderr: "" }
      },
    })

    expect(result).toBeNull()
    expect(probed[0]).toContain(join(cwd, ".nvm", "versions", "node", "v18.19.0", "bin", "node"))
    expect(probed[1]).toBe("node --version")
  })
})

describe("runBuildCheckRung — P2b build-first rung (agnostic-hands-eyes.md §2.4)", () => {
  it("runs the resolved ecosystem's buildCheck once and reports build_check_red on a nonzero exit", async () => {
    const cwd = makeFixture()
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "proj" }))
    let calls = 0

    const result = await runBuildCheckRung({
      cwd,
      runner: async (command) => {
        calls++
        expect(command.command).toBe("tsc --noEmit")
        return { exitCode: 2, stdout: "", stderr: "src/foo.ts(3,5): error TS2322" }
      },
    })

    expect(calls).toBe(1)
    expect(result).toEqual({
      ran: true,
      passed: false,
      command: "tsc --noEmit",
      signal: "build_check_red",
      outputTail: "src/foo.ts(3,5): error TS2322",
    })
  })

  it("reports passed on a zero exit, still ran once", async () => {
    const cwd = makeFixture()
    writeFileSync(join(cwd, "go.mod"), "module example.com/proj\n\ngo 1.21\n")

    const result = await runBuildCheckRung({
      cwd,
      runner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    })

    expect(result).toEqual({ ran: true, passed: true, command: "go build ./..." })
  })

  it("a python fixture never runs the rung — the python-pytest row carries no buildCheck", async () => {
    const cwd = makeFixture()
    writeFileSync(join(cwd, "pyproject.toml"), "[project]\nname = \"proj\"\n")
    let calls = 0

    const result = await runBuildCheckRung({
      cwd,
      runner: async () => {
        calls++
        return { exitCode: 0, stdout: "", stderr: "" }
      },
    })

    expect(calls).toBe(0)
    expect(result).toEqual({ ran: false, passed: true })
  })
})

describe("resolveActiveEcosystem / resolveToolchainEcosystem — P3 production call site (prompt.ts's toolchain probe)", () => {
  it("resolves the javascript ecosystem for a JS repo, agreeing with discoverNeighborTests' own resolution", () => {
    const cwd = makeFixture()
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "proj" }))
    mkdirSync(join(cwd, "__tests__"), { recursive: true })

    const eco = resolveActiveEcosystem(cwd, ["src/foo.js"])
    expect(eco?.language).toBe("javascript")
    expect(resolveToolchainEcosystem(cwd, ["src/foo.js"])).toBe("javascript")
  })

  it("resolves the python row when the repo is python-shaped", () => {
    const cwd = makeFixture()
    writeFileSync(join(cwd, "pyproject.toml"), "[project]\nname = \"proj\"\n")

    const eco = resolveActiveEcosystem(cwd, ["pkg/mod.py"])
    expect(eco?.language).toBe("python")
    expect(resolveToolchainEcosystem(cwd, ["pkg/mod.py"])).toBe("python")
  })

  it("falls back to python — today's only probed ecosystem — when nothing resolves at all", () => {
    const cwd = makeFixture()
    expect(resolveToolchainEcosystem(cwd, ["scratch.txt"])).toBe("python")
  })
})

describe("selectNonPythonEcosystem — django-11885: an ecosystem must OWN a touched file to be selected", () => {
  it("the regression: a mixed python+javascript profile with only .py touched files falls back to python, and the build-check rung never fires", async () => {
    const cwd = makeFixture()
    writeFileSync(join(cwd, "pyproject.toml"), "[project]\nname = \"proj\"\n")
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "proj" }))

    const eco = resolveActiveEcosystem(cwd, ["pkg/mod.py"])
    expect(eco?.language).toBe("python")
    expect(resolveToolchainEcosystem(cwd, ["pkg/mod.py"])).toBe("python")

    let calls = 0
    const result = await runBuildCheckRung({
      cwd,
      touchedSourceFiles: ["pkg/mod.py"],
      runner: async () => {
        calls++
        return { exitCode: 0, stdout: "", stderr: "" }
      },
    })

    expect(calls).toBe(0)
    expect(result).toEqual({ ran: false, passed: true })
  })

  it("the same mixed profile resolves the javascript ecosystem once a touched file is actually .js/.ts", () => {
    const cwd = makeFixture()
    writeFileSync(join(cwd, "pyproject.toml"), "[project]\nname = \"proj\"\n")
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "proj" }))

    const eco = resolveActiveEcosystem(cwd, ["static/admin/js/widget.ts"])
    expect(eco?.language).toBe("javascript")
  })

  it("monorepo: a touched file under a candidate's own root selects that root's ecosystem, not the sibling candidate", () => {
    const cwd = makeFixture()
    mkdirSync(join(cwd, "frontend"), { recursive: true })
    writeFileSync(join(cwd, "frontend", "package.json"), JSON.stringify({ name: "web" }))
    mkdirSync(join(cwd, "service"), { recursive: true })
    writeFileSync(join(cwd, "service", "go.mod"), "module example.com/service\n\ngo 1.21\n")

    const eco = resolveActiveEcosystem(cwd, ["service/main.go"])
    expect(eco?.language).toBe("go")
    expect(eco?.root).toBe("service")
  })

  it("a pure single-ecosystem repo (no python row) still resolves its only candidate even with no touched files", () => {
    const cwd = makeFixture()
    writeFileSync(join(cwd, "go.mod"), "module example.com/proj\n\ngo 1.21\n")

    const eco = resolveActiveEcosystem(cwd, [])
    expect(eco?.language).toBe("go")
  })

  it("empty touched files in a mixed python+javascript profile falls back to python — nothing fires before the first edit", () => {
    const cwd = makeFixture()
    writeFileSync(join(cwd, "pyproject.toml"), "[project]\nname = \"proj\"\n")
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "proj" }))

    const eco = resolveActiveEcosystem(cwd, [])
    expect(eco?.language).toBe("python")
    expect(resolveToolchainEcosystem(cwd, [])).toBe("python")
  })
})

describe("runStructuredTestCommand / makeStructuredNeighborRunner — P1 structured-report capture (agnostic-hands-eyes.md §2.2)", () => {
  const pytestEco: EcosystemProfile = {
    language: "python",
    root: ".",
    toolchain: { probeLadder: [] },
    versions: { deps: {} },
    tests: {
      runner: "pytest",
      suite: "pytest",
      single: "pytest {testId}",
      structured: { flag: "--junitxml=<path>", format: "junitxml" },
      conventions: { dirs: ["tests"], filePatterns: ["test_*.py"], twinRule: "" },
      source: "convention",
      needsSynthesis: false,
      validated: false,
    },
    repro: { ext: "py", run: "python repro_issue.py" },
  }
  const jestEco: EcosystemProfile = {
    language: "javascript",
    root: ".",
    toolchain: { probeLadder: [] },
    versions: { deps: {} },
    tests: {
      runner: "jest",
      suite: "npx jest",
      single: "npx jest {testId}",
      structured: { flag: "--json", format: "json" },
      conventions: { dirs: ["__tests__"], filePatterns: ["*.test.js"], twinRule: "" },
      source: "convention",
      needsSynthesis: false,
      validated: false,
    },
    repro: { ext: "js", run: "node repro_issue.js" },
  }
  const djangoEco: EcosystemProfile = { ...pytestEco, tests: { ...pytestEco.tests, runner: "django-test" } }

  function extractTempPath(command: string): string {
    const match = command.match(/--junitxml=(\S+)/)
    if (!match) throw new Error(`no --junitxml in ${command}`)
    return match[1]!
  }

  afterEach(() => {
    // runStructuredTestCommand cleans up its own temp files on the happy
    // path; this only mops up a test double that never wrote one.
  })

  it("appends the <path>-templated flag, reads the temp artifact OUTSIDE the repo, and populates CommandResult.report", async () => {
    let calls = 0
    const { result, reportContent } = await runStructuredTestCommand(
      { kind: "test", command: "pytest tests/test_foo.py -x -q" },
      pytestEco,
      async (command) => {
        calls++
        const path = extractTempPath(command.command)
        expect(path.startsWith("/tmp") || path.includes(require("node:os").tmpdir())).toBe(true)
        expect(path.startsWith(process.cwd())).toBe(false)
        writeFileSync(
          path,
          '<testsuite tests="1" failures="1"><testcase classname="test_foo" name="test_x"><failure message="assert 1 == 2">AssertionError</failure></testcase></testsuite>',
        )
        return { exitCode: 1, stdout: "", stderr: "" }
      },
    )

    expect(calls).toBe(1)
    expect(result.report).toEqual({ caseCount: 1, skipped: 0 })
    expect(reportContent).toContain("test_foo")
  })

  it("falls back to re-running the UNFLAGGED command, byte-identical, when the installed runner never produces the artifact (Django's runtests.py doesn't understand --junitxml)", async () => {
    const calls: string[] = []
    const unflaggedResult = { exitCode: 1, stdout: "FAILED (failures=1)", stderr: "" }
    const { result, reportContent } = await runStructuredTestCommand(
      { kind: "test", command: "python tests/runtests.py delete --parallel 1" },
      djangoEco,
      async (command) => {
        calls.push(command.command)
        if (command.command.includes("--junitxml=")) {
          // simulates argparse rejecting the unknown flag — no artifact written
          return { exitCode: 2, stdout: "", stderr: "error: unrecognized arguments: --junitxml=..." }
        }
        return unflaggedResult
      },
    )

    expect(calls.length).toBe(2)
    expect(calls[0]).toContain("--junitxml=")
    expect(calls[0]).toStartWith("python tests/runtests.py delete --parallel 1 ")
    expect(calls[1]).toBe("python tests/runtests.py delete --parallel 1")
    expect(result).toEqual(unflaggedResult)
    expect(reportContent).toBeUndefined()
  })

  it("a bare (non-<path>) structured flag reads the report straight from stdout (jest --json)", async () => {
    const jestJson = JSON.stringify({
      testResults: [
        { name: "foo.test.js", assertionResults: [{ fullName: "foo works", status: "passed" }] },
      ],
    })
    let calls = 0
    const { result, reportContent } = await runStructuredTestCommand(
      { kind: "test", command: "npx jest __tests__/foo.test.js" },
      jestEco,
      async (command) => {
        calls++
        expect(command.command).toBe("npx jest __tests__/foo.test.js --json")
        return { exitCode: 0, stdout: jestJson, stderr: "" }
      },
    )

    expect(calls).toBe(1)
    expect(result.report).toEqual({ caseCount: 1, skipped: 0 })
    expect(reportContent).toBe(jestJson)
  })

  it("runs a non-test command (kind !== \"test\") unmodified — never appends the flag", async () => {
    let calls = 0
    const { result, reportContent } = await runStructuredTestCommand(
      { kind: "guard", command: "git show HEAD:foo.py" },
      pytestEco,
      async (command) => {
        calls++
        expect(command.command).toBe("git show HEAD:foo.py")
        return { exitCode: 0, stdout: "x = 1", stderr: "" }
      },
    )
    expect(calls).toBe(1)
    expect(result).toEqual({ exitCode: 0, stdout: "x = 1", stderr: "" })
    expect(reportContent).toBeUndefined()
  })

  it("makeStructuredNeighborRunner wires the capture into a CommandRunner and populates the reportContentByCommand side channel keyed by the ORIGINAL command", async () => {
    const reportContentByCommand = new Map<string, string>()
    const runner = makeStructuredNeighborRunner(
      async (command) => {
        if (command.command.includes("--junitxml=")) {
          const path = extractTempPath(command.command)
          writeFileSync(path, '<testsuite tests="1"><testcase classname="t" name="ok"/></testsuite>')
          return { exitCode: 0, stdout: "", stderr: "" }
        }
        return { exitCode: 0, stdout: "", stderr: "" }
      },
      pytestEco,
      reportContentByCommand,
    )

    const result = await runner({ kind: "test", command: "pytest tests/test_ok.py -x -q" })
    expect(result.exitCode).toBe(0)
    expect(result.report).toEqual({ caseCount: 1, skipped: 0 })
    expect(reportContentByCommand.get("pytest tests/test_ok.py -x -q")).toContain("testsuite")
  })
})
