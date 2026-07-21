/**
 * Tests for seen-red.ts (packages/opencode/src/session/seen-red.ts):
 * F18's findUnresolvedSeenRed — a red test/repro run cleared by a later
 * same-target green run, a red never re-run (flagged with an evidence
 * tail), a non-test bash failure ignored regardless of exit code, an
 * env-red (missing file / missing module) output ignored even though it is
 * test-shaped, clearing via the `clearedByProbe` passthrough (the M4
 * gate's own green re-run, invisible to the transcript), and the
 * exact-command fallback when no test-target tokens are extractable.
 * Also covers isTrackedSuiteCommand (committed-suite provenance for the
 * inversion rung, repro scripts excluded), partitionSeenRedByInversion
 * (binding vs sanctioned split, empty-literals no-op), isEnvBlockedSignature
 * (the environment-marker regex family), and partitionSeenRedByEnvBlock
 * (F18c — env/baseline-blocked writeoff: binding vs envBlocked split,
 * provenance-gated on edit-ordering + repeat count).
 */

import { describe, it, expect } from "bun:test"
import {
  findUnresolvedSeenRed,
  isTrackedSuiteCommand,
  partitionSeenRedByInversion,
  isEnvBlockedSignature,
  partitionSeenRedByEnvBlock,
  collectObservedRedTestIds,
  observedTestVerdicts,
  type SeenRedExecution,
  type UnresolvedSeenRed,
} from "../../src/session/seen-red"
import type { IssueExpectation } from "../../src/session/issue-expectations"

describe("findUnresolvedSeenRed", () => {
  it("(a) clears a red test run when a later execution shares its test-target token", () => {
    const executions: SeenRedExecution[] = [
      {
        command: "pytest tests/test_foo.py::test_bar",
        exitCode: 1,
        output: "============ FAILURES ============\nFAILED tests/test_foo.py::test_bar - AssertionError: assert 1 == 2",
      },
      {
        command: "pytest tests/test_foo.py::test_bar -v",
        exitCode: 0,
        output: "1 passed in 0.01s",
      },
    ]
    expect(findUnresolvedSeenRed(executions)).toEqual([])
  })

  it("(b) flags a red test run that is never re-run, with a 15-line evidence tail", () => {
    const bodyLines = Array.from({ length: 20 }, (_, i) => `line ${i + 1} of context`)
    const failureLine = "FAILED tests/test_bar.py::test_baz - AssertionError: assert False"
    const output = [...bodyLines, failureLine].join("\n")
    const executions: SeenRedExecution[] = [
      {
        command: "pytest tests/test_bar.py::test_baz",
        exitCode: 1,
        output,
      },
    ]
    const expectedTail = [...bodyLines.slice(-14), failureLine].join("\n")
    expect(findUnresolvedSeenRed(executions)).toEqual([
      { command: "pytest tests/test_bar.py::test_baz", outputTail: expectedTail },
    ])
  })

  it("(c) ignores a non-test bash failure (grep exit 1)", () => {
    const executions: SeenRedExecution[] = [
      {
        command: "grep foo file",
        exitCode: 1,
        output: "",
      },
    ]
    expect(findUnresolvedSeenRed(executions)).toEqual([])
  })

  it("(d) ignores env-red output (ModuleNotFoundError / missing file) even though it is test-shaped", () => {
    const executions: SeenRedExecution[] = [
      {
        command: "pytest tests/test_foo.py",
        exitCode: 1,
        output: "Traceback (most recent call last):\n  File \"conftest.py\", line 1, in <module>\nModuleNotFoundError: No module named 'foo'",
      },
      {
        command: "python repro_issue.py",
        exitCode: 2,
        output: "Traceback (most recent call last):\npython: can't open file 'repro_issue.py': [Errno 2] No such file or directory",
      },
    ]
    expect(findUnresolvedSeenRed(executions)).toEqual([])
  })

  it("(e) clears a red test run via clearedByProbe sharing a test-target token", () => {
    const executions: SeenRedExecution[] = [
      {
        command: "pytest tests/test_qux.py::test_it",
        exitCode: 1,
        output: "FAILED tests/test_qux.py::test_it - AssertionError: nope",
      },
    ]
    expect(findUnresolvedSeenRed(executions, "python -m pytest tests/test_qux.py::test_it -q")).toEqual([])
  })

  it("(f) falls back to exact-command matching when no test-target tokens are extractable", () => {
    const executions: SeenRedExecution[] = [
      {
        command: "pytest",
        exitCode: 1,
        output: "FAILED - AssertionError: whole suite broke\n1 failed",
      },
      {
        command: "pytest",
        exitCode: 0,
        output: "5 passed",
      },
    ]
    expect(findUnresolvedSeenRed(executions)).toEqual([])
  })

  it("does not clear a bare-command red with a differently-shaped bare-command green (no tokens, no exact match)", () => {
    const executions: SeenRedExecution[] = [
      {
        command: "pytest",
        exitCode: 1,
        output: "FAILED - AssertionError: whole suite broke\n1 failed",
      },
      {
        command: "pytest -x",
        exitCode: 0,
        output: "5 passed",
      },
    ]
    expect(findUnresolvedSeenRed(executions)).toEqual([
      { command: "pytest", outputTail: "FAILED - AssertionError: whole suite broke\n1 failed" },
    ])
  })

  // --- exit-code laundering (live replay of a piped/compound test run) ---

  const C3_LAUNDERED_RED =
    '.venv/bin/python tests/runtests.py delete delete_regress 2>&1 | grep -E "^(test_|FAIL|ERROR|OK|PASS|Ran|FAILED|test_) |^[0-9]+ tests" | tail -40; echo "---INSPECT---"; .venv/bin/python repro_inspect_combined.py'
  const C3_RED_OUTPUT = "Ran 63 tests in 0.511s\nFAILED (failures=2, errors=7, skipped=3)\n---INSPECT---\ncomposed WHERE clause: (OR: ...)"

  it("(g) flags a piped/compound test run whose exit was laundered to 0", () => {
    const executions: SeenRedExecution[] = [{ command: C3_LAUNDERED_RED, exitCode: 0, output: C3_RED_OUTPUT }]
    const unresolved = findUnresolvedSeenRed(executions)
    expect(unresolved).toHaveLength(1)
    expect(unresolved[0]!.command).toBe(C3_LAUNDERED_RED)
  })

  it("(h) flags a tail-piped runtests red with exit 0", () => {
    const executions: SeenRedExecution[] = [
      {
        command: "python runtests.py delete --verbosity 1 2>&1 | tail -10",
        exitCode: 0,
        output: "Ran 44 tests in 0.443s\n\nFAILED (failures=2, skipped=1)\nDestroying test database for alias 'default'...",
      },
    ]
    expect(findUnresolvedSeenRed(executions)).toHaveLength(1)
  })

  it("(i) a laundered red is cleared by a later green run sharing its bare module label", () => {
    const executions: SeenRedExecution[] = [
      { command: C3_LAUNDERED_RED, exitCode: 0, output: C3_RED_OUTPUT },
      {
        command: "python tests/runtests.py delete --parallel 1",
        exitCode: 0,
        output: "Ran 44 tests in 0.4s\n\nOK (skipped=1)",
      },
    ]
    expect(findUnresolvedSeenRed(executions)).toEqual([])
  })

  it("(j) a later laundered RED re-run must not clear an earlier red", () => {
    const executions: SeenRedExecution[] = [
      { command: C3_LAUNDERED_RED, exitCode: 0, output: C3_RED_OUTPUT },
      {
        command: "python tests/runtests.py delete 2>&1 | tail -5",
        exitCode: 0,
        output: "Ran 44 tests in 0.4s\n\nFAILED (failures=2, skipped=1)",
      },
    ]
    expect(findUnresolvedSeenRed(executions)).toHaveLength(2)
  })

  it("(k) reading FAILED text via grep/cat never counts as a red execution", () => {
    const executions: SeenRedExecution[] = [
      {
        command: "grep -n FAILED tests/delete/run.log | tail -3",
        exitCode: 0,
        output: "12:FAILED (failures=2, skipped=1)",
      },
      { command: "cat tests/runtests.py | head -40", exitCode: 0, output: "FAILED (failures=%d)" },
    ]
    expect(findUnresolvedSeenRed(executions)).toEqual([])
  })

  it("(l) a shared interpreter path never clears a red (interpreter is not a target)", () => {
    const executions: SeenRedExecution[] = [
      { command: C3_LAUNDERED_RED, exitCode: 0, output: C3_RED_OUTPUT },
      { command: '.venv/bin/python -c "print(1)"', exitCode: 0, output: "1" },
    ]
    expect(findUnresolvedSeenRed(executions)).toHaveLength(1)
  })

  it("(m) unresolved reds are capped at the last 3", () => {
    const executions: SeenRedExecution[] = Array.from({ length: 5 }, (_, i) => ({
      command: `pytest tests/test_mod${i}.py`,
      exitCode: 1,
      output: `FAILED tests/test_mod${i}.py::test_x - AssertionError`,
    }))
    const unresolved = findUnresolvedSeenRed(executions)
    expect(unresolved).toHaveLength(3)
    expect(unresolved[0]!.command).toBe("pytest tests/test_mod2.py")
    expect(unresolved[2]!.command).toBe("pytest tests/test_mod4.py")
  })

  it("(n) a dotted narrowing of a bare module label clears it", () => {
    const executions: SeenRedExecution[] = [
      { command: C3_LAUNDERED_RED, exitCode: 0, output: C3_RED_OUTPUT },
      {
        command: "python tests/runtests.py delete.DeletionTests delete_regress --parallel 1",
        exitCode: 0,
        output: "Ran 20 tests in 0.2s\n\nOK",
      },
    ]
    expect(findUnresolvedSeenRed(executions)).toEqual([])
  })
})

describe("isTrackedSuiteCommand", () => {
  it("a tracked-suite runtests invocation (piped tail) is tracked-suite-shaped", () => {
    expect(
      isTrackedSuiteCommand(".venv/bin/python tests/runtests.py migrations.test_writer --verbosity=2 2>&1 | tail -40"),
    ).toBe(true)
  })

  it("the agent's own scratch repro never qualifies, even though a test-shaped runner token is present", () => {
    expect(isTrackedSuiteCommand("python repro_issue.py")).toBe(false)
  })

  it("a pytest tests/ path invocation is tracked-suite-shaped", () => {
    expect(isTrackedSuiteCommand("pytest tests/test_writer.py -x")).toBe(true)
  })

  it("a bare non-test command is never tracked-suite-shaped", () => {
    expect(isTrackedSuiteCommand("ls -la")).toBe(false)
  })
})

// --- 2026-07-15 live-run fixtures (oracle-inversion partition) ---

describe("partitionSeenRedByInversion", () => {
  const TRACKED_SUITE_COMMAND =
    ".venv/bin/python tests/runtests.py migrations.test_writer --verbosity=2 2>&1 | tail -40"
  const REPRO_COMMAND = "python repro_issue.py"
  const INVERSION_TAIL =
    "AssertionError: Tuples differ: (\"mig[13 chars]writer.TextEnum['A']\", {'import migrations.test_writer'}) != (\"mig[13 chars]writer.TextEnum('a-value')\", {'import migrations.test_writer'})"
  const PLAIN_FAILURE_TAIL = "AssertionError: False is not true"
  // Form-class rung fixture (adapted from issue-expectations.test.ts's
  // promotedLiterals): a single expected-kind literal in enum subscript
  // form, no "actual"-kind counterpart — rung 1 is structurally blind here.
  const FORM_CLASS_LITERALS: IssueExpectation[] = [
    { value: "TextEnum['A']", kind: "expected", source: "It should be: TextEnum['A']" },
  ]

  it("empty literals: every red stays binding, sanctioned empty — byte-identical to pre-partition behavior", () => {
    const unresolved: UnresolvedSeenRed[] = [
      { command: TRACKED_SUITE_COMMAND, outputTail: INVERSION_TAIL },
      { command: REPRO_COMMAND, outputTail: PLAIN_FAILURE_TAIL },
    ]
    const result = partitionSeenRedByInversion(unresolved, [])
    expect(result.binding).toEqual(unresolved)
    expect(result.sanctioned).toEqual([])
  })

  it("a tracked-suite command + an inversion-shaped tail + firing literals lands in sanctioned with desired/buggy literals populated", () => {
    const unresolved: UnresolvedSeenRed[] = [{ command: TRACKED_SUITE_COMMAND, outputTail: INVERSION_TAIL }]
    const result = partitionSeenRedByInversion(unresolved, FORM_CLASS_LITERALS)
    expect(result.binding).toEqual([])
    expect(result.sanctioned).toHaveLength(1)
    expect(result.sanctioned[0]!.command).toBe(TRACKED_SUITE_COMMAND)
    expect(result.sanctioned[0]!.desiredLiteral).toBe("TextEnum['A']")
    expect(result.sanctioned[0]!.buggyLiteral).toContain("TextEnum('a-value')")
  })

  it("the same inverting tail from the agent's own repro command is never sanctioned — a repro's red is honest", () => {
    const unresolved: UnresolvedSeenRed[] = [{ command: REPRO_COMMAND, outputTail: INVERSION_TAIL }]
    const result = partitionSeenRedByInversion(unresolved, FORM_CLASS_LITERALS)
    expect(result.binding).toEqual(unresolved)
    expect(result.sanctioned).toEqual([])
  })

  it("a tracked-suite command with a plain non-inversion failure stays binding", () => {
    const unresolved: UnresolvedSeenRed[] = [{ command: TRACKED_SUITE_COMMAND, outputTail: PLAIN_FAILURE_TAIL }]
    const result = partitionSeenRedByInversion(unresolved, FORM_CLASS_LITERALS)
    expect(result.binding).toEqual(unresolved)
    expect(result.sanctioned).toEqual([])
  })

  it("a mixed input array is partitioned correctly, preserving order within each bucket", () => {
    const plainA: UnresolvedSeenRed = { command: "pytest tests/test_a.py -x", outputTail: PLAIN_FAILURE_TAIL }
    const inversionA: UnresolvedSeenRed = { command: TRACKED_SUITE_COMMAND, outputTail: INVERSION_TAIL }
    const plainB: UnresolvedSeenRed = { command: "pytest tests/test_b.py -x", outputTail: PLAIN_FAILURE_TAIL }
    const inversionB: UnresolvedSeenRed = {
      command: ".venv/bin/python tests/runtests.py migrations.test_writer2 2>&1 | tail -40",
      outputTail: INVERSION_TAIL,
    }
    const result = partitionSeenRedByInversion([plainA, inversionA, plainB, inversionB], FORM_CLASS_LITERALS)
    expect(result.binding).toEqual([plainA, plainB])
    expect(result.sanctioned.map((s) => s.command)).toEqual([inversionA.command, inversionB.command])
  })
})

// --- 2026-07-15 live-run fixtures (env/baseline-blocked partition) ---

describe("isEnvBlockedSignature", () => {
  it("matches the conservative marker set (backend required / ImproperlyConfigured / command not found)", () => {
    expect(isEnvBlockedSignature("django.core.exceptions.ImproperlyConfigured: GIS backend required")).toBe(true)
    expect(isEnvBlockedSignature("psycopg2 backend required for this test")).toBe(true)
    expect(isEnvBlockedSignature("bash: gdal-config: command not found")).toBe(true)
  })

  it("matches the real 2026-07-15 django arena text — 'backend' and 'required' share a clause but are not adjacent", () => {
    expect(isEnvBlockedSignature("Aborting: A GIS database backend is required to run gis_tests.")).toBe(true)
  })

  it("matches the MISSING_FILE_RE/MODULE_MISSING_RE family too (defense in depth)", () => {
    expect(isEnvBlockedSignature("ModuleNotFoundError: No module named 'psycopg2'")).toBe(true)
  })

  it("does NOT match a plain assertion failure", () => {
    expect(isEnvBlockedSignature("AssertionError: 22 != 25 : 22 queries executed, 25 expected")).toBe(false)
  })

  it("does NOT match a plain unittest failure summary", () => {
    expect(isEnvBlockedSignature("FAILED (failures=15)")).toBe(false)
  })

  it("does NOT match 'backend' and 'required' when they belong to different sentences (gap must not cross a period)", () => {
    expect(
      isEnvBlockedSignature("The backend processed the request. Authentication is required for this endpoint."),
    ).toBe(false)
  })
})

describe("partitionSeenRedByEnvBlock", () => {
  // Includes "Traceback" so it also satisfies TEST_FAILURE_SIGNATURE_RE — the
  // repeat-count rung reuses isRedTestExecution, which requires a generic
  // red-test-execution shape in addition to the env marker itself.
  const GIS_TAIL =
    "Traceback (most recent call last):\n  ...\ndjango.core.exceptions.ImproperlyConfigured: GIS backend requires a PostGIS or SpatiaLite build"
  const PLAIN_TAIL = "AssertionError: 22 != 25 : 22 queries executed, 25 expected"
  const NEIGHBOR_CMD = "python tests/runtests.py gis_tests.geoapp"
  const OTHER_CMD = "pytest tests/test_bar.py::test_baz"

  it("an env-marker red repeated 2x (both BEFORE any edit) is sanctioned envBlocked", () => {
    const unresolved: UnresolvedSeenRed[] = [{ command: NEIGHBOR_CMD, outputTail: GIS_TAIL }]
    const executions: SeenRedExecution[] = [
      { command: NEIGHBOR_CMD, exitCode: 1, output: GIS_TAIL, sawEditBefore: false },
      { command: NEIGHBOR_CMD, exitCode: 1, output: GIS_TAIL, sawEditBefore: false },
    ]
    const result = partitionSeenRedByEnvBlock(unresolved, executions)
    expect(result.binding).toEqual([])
    expect(result.envBlocked).toHaveLength(1)
    expect(result.envBlocked[0]!.command).toBe(NEIGHBOR_CMD)
    expect(result.envBlocked[0]!.repeats).toBe(2)
  })

  it("an env-marker red that repeats only ONCE (no confirming repeat) stays binding", () => {
    const unresolved: UnresolvedSeenRed[] = [{ command: NEIGHBOR_CMD, outputTail: GIS_TAIL }]
    const executions: SeenRedExecution[] = [{ command: NEIGHBOR_CMD, exitCode: 1, output: GIS_TAIL, sawEditBefore: false }]
    const result = partitionSeenRedByEnvBlock(unresolved, executions)
    expect(result.binding).toEqual(unresolved)
    expect(result.envBlocked).toEqual([])
  })

  it("a NON-env-marker red whose first occurrence predates any edit, repeated 2x, is sanctioned via the timing path", () => {
    const unresolved: UnresolvedSeenRed[] = [{ command: OTHER_CMD, outputTail: PLAIN_TAIL }]
    const executions: SeenRedExecution[] = [
      { command: OTHER_CMD, exitCode: 1, output: PLAIN_TAIL, sawEditBefore: false },
      { command: OTHER_CMD, exitCode: 1, output: PLAIN_TAIL, sawEditBefore: false },
    ]
    const result = partitionSeenRedByEnvBlock(unresolved, executions)
    expect(result.binding).toEqual([])
    expect(result.envBlocked).toHaveLength(1)
  })

  it("a NON-env-marker red whose FIRST occurrence is AFTER an edit landed is NEVER sanctioned, even if it repeats 2x — the timing path requires before-edit provenance", () => {
    const unresolved: UnresolvedSeenRed[] = [{ command: OTHER_CMD, outputTail: PLAIN_TAIL }]
    const executions: SeenRedExecution[] = [
      { command: OTHER_CMD, exitCode: 1, output: PLAIN_TAIL, sawEditBefore: true },
      { command: OTHER_CMD, exitCode: 1, output: PLAIN_TAIL, sawEditBefore: true },
    ]
    const result = partitionSeenRedByEnvBlock(unresolved, executions)
    expect(result.binding).toEqual(unresolved)
    expect(result.envBlocked).toEqual([])
  })

  it("an env-marker red is sanctioned even when it first appeared AFTER an edit — the marker independently proves the environment, not the code, is at fault", () => {
    const unresolved: UnresolvedSeenRed[] = [{ command: NEIGHBOR_CMD, outputTail: GIS_TAIL }]
    const executions: SeenRedExecution[] = [
      { command: NEIGHBOR_CMD, exitCode: 1, output: GIS_TAIL, sawEditBefore: true },
      { command: NEIGHBOR_CMD, exitCode: 1, output: GIS_TAIL, sawEditBefore: true },
    ]
    const result = partitionSeenRedByEnvBlock(unresolved, executions)
    expect(result.binding).toEqual([])
    expect(result.envBlocked).toHaveLength(1)
  })

  it("differing signatures across runs are NEVER sanctioned: a normalization-surviving CONTENT difference keeps the red binding", () => {
    const unresolved: UnresolvedSeenRed[] = [{ command: NEIGHBOR_CMD, outputTail: GIS_TAIL }]
    const executions: SeenRedExecution[] = [
      { command: NEIGHBOR_CMD, exitCode: 1, output: GIS_TAIL, sawEditBefore: false },
      // a different failure message on the SAME command — not a stable repeat
      { command: NEIGHBOR_CMD, exitCode: 1, output: "AssertionError: some unrelated other failure", sawEditBefore: false },
    ]
    const result = partitionSeenRedByEnvBlock(unresolved, executions)
    expect(result.binding).toEqual(unresolved)
    expect(result.envBlocked).toEqual([])
  })

  it("run-to-run noise (durations/timestamps/temp paths) does not defeat the repeat-signature match", () => {
    const tailA = GIS_TAIL + " (0.031s)"
    const tailB = GIS_TAIL + " (1.204s)"
    const unresolved: UnresolvedSeenRed[] = [{ command: NEIGHBOR_CMD, outputTail: tailA }]
    const executions: SeenRedExecution[] = [
      { command: NEIGHBOR_CMD, exitCode: 1, output: tailA, sawEditBefore: false },
      { command: NEIGHBOR_CMD, exitCode: 1, output: tailB, sawEditBefore: false },
    ]
    const result = partitionSeenRedByEnvBlock(unresolved, executions)
    expect(result.envBlocked).toHaveLength(1)
  })

  it("the agent's own repro_issue.py red follows the SAME provenance rules — no special-casing by command shape", () => {
    const reproCmd = "python repro_issue.py"
    const unresolved: UnresolvedSeenRed[] = [{ command: reproCmd, outputTail: GIS_TAIL }]
    const executions: SeenRedExecution[] = [
      { command: reproCmd, exitCode: 1, output: GIS_TAIL, sawEditBefore: false },
      { command: reproCmd, exitCode: 1, output: GIS_TAIL, sawEditBefore: false },
    ]
    const result = partitionSeenRedByEnvBlock(unresolved, executions)
    expect(result.envBlocked).toHaveLength(1)
  })

  it("undefined sawEditBefore (a caller that hasn't wired edit provenance) reads as before-any-edit, not excluded", () => {
    const unresolved: UnresolvedSeenRed[] = [{ command: OTHER_CMD, outputTail: PLAIN_TAIL }]
    const executions: SeenRedExecution[] = [
      { command: OTHER_CMD, exitCode: 1, output: PLAIN_TAIL },
      { command: OTHER_CMD, exitCode: 1, output: PLAIN_TAIL },
    ]
    const result = partitionSeenRedByEnvBlock(unresolved, executions)
    expect(result.envBlocked).toHaveLength(1)
  })

  it("a mixed input array is partitioned correctly, preserving order within each bucket", () => {
    const plainOnce: UnresolvedSeenRed = { command: "pytest tests/test_a.py -x", outputTail: PLAIN_TAIL }
    const envBlocked: UnresolvedSeenRed = { command: NEIGHBOR_CMD, outputTail: GIS_TAIL }
    const executions: SeenRedExecution[] = [
      { command: "pytest tests/test_a.py -x", exitCode: 1, output: PLAIN_TAIL, sawEditBefore: false },
      { command: NEIGHBOR_CMD, exitCode: 1, output: GIS_TAIL, sawEditBefore: false },
      { command: NEIGHBOR_CMD, exitCode: 1, output: GIS_TAIL, sawEditBefore: false },
    ]
    const result = partitionSeenRedByEnvBlock([plainOnce, envBlocked], executions)
    expect(result.binding).toEqual([plainOnce])
    expect(result.envBlocked.map((e) => e.command)).toEqual([envBlocked.command])
  })
})

describe("collectObservedRedTestIds — H1 tooth 3 (gap-closure-plan §2.7)", () => {
  it("collects a test-target id from a single red execution", () => {
    const executions: SeenRedExecution[] = [
      { command: "pytest tests/test_bar.py::test_baz", exitCode: 1, output: "FAILED tests/test_bar.py::test_baz" },
    ]
    expect(collectObservedRedTestIds(executions)).toEqual(["tests/test_bar.py::test_baz"])
  })

  it("keeps an id that a LATER green execution clears — this is the full-set scope, never bounded to the unresolved-3 cap", () => {
    const executions: SeenRedExecution[] = [
      { command: "pytest tests/test_bar.py::test_baz", exitCode: 1, output: "FAILED tests/test_bar.py::test_baz" },
      { command: "pytest tests/test_bar.py::test_baz", exitCode: 0, output: "1 passed in 0.01s" },
    ]
    expect(collectObservedRedTestIds(executions)).toEqual(["tests/test_bar.py::test_baz"])
  })

  it("dedupes the same id seen red twice", () => {
    const executions: SeenRedExecution[] = [
      { command: "pytest tests/test_bar.py::test_baz", exitCode: 1, output: "FAILED tests/test_bar.py::test_baz" },
      { command: "pytest tests/test_bar.py::test_baz", exitCode: 1, output: "FAILED tests/test_bar.py::test_baz" },
    ]
    expect(collectObservedRedTestIds(executions)).toEqual(["tests/test_bar.py::test_baz"])
  })

  it("falls back to the whole command when no test-target token is extractable", () => {
    const executions: SeenRedExecution[] = [{ command: "pytest", exitCode: 1, output: "1 failed" }]
    expect(collectObservedRedTestIds(executions)).toEqual(["pytest"])
  })

  it("ignores a non-test bash failure and env-red output, same as isRedTestExecution", () => {
    const executions: SeenRedExecution[] = [
      { command: "grep foo bar.txt", exitCode: 1, output: "no match" },
      {
        command: "pytest repro_issue.py",
        exitCode: 2,
        output: "python: can't open file 'repro_issue.py': [Errno 2] No such file or directory",
      },
    ]
    expect(collectObservedRedTestIds(executions)).toEqual([])
  })

  it("accumulates across multiple distinct reds, never bounded to 3 (unlike findUnresolvedSeenRed)", () => {
    const executions: SeenRedExecution[] = Array.from({ length: 5 }, (_, i) => ({
      command: `pytest tests/test_mod${i}.py::test_x`,
      exitCode: 1,
      output: `FAILED tests/test_mod${i}.py::test_x - AssertionError`,
    }))
    expect(collectObservedRedTestIds(executions)).toHaveLength(5)
  })
})

describe("observedTestVerdicts — H1 tooth 3 (gap-closure-plan §2.7)", () => {
  it("a red-only id reads 'fail'", () => {
    const executions: SeenRedExecution[] = [
      { command: "pytest tests/test_bar.py::test_baz", exitCode: 1, output: "FAILED tests/test_bar.py::test_baz" },
    ]
    expect(observedTestVerdicts(executions).get("tests/test_bar.py::test_baz")).toBe("fail")
  })

  it("the LATEST execution wins: red then a clean green re-run reads 'pass'", () => {
    const executions: SeenRedExecution[] = [
      { command: "pytest tests/test_bar.py::test_baz", exitCode: 1, output: "FAILED tests/test_bar.py::test_baz" },
      { command: "pytest tests/test_bar.py::test_baz", exitCode: 0, output: "1 passed in 0.01s" },
    ]
    expect(observedTestVerdicts(executions).get("tests/test_bar.py::test_baz")).toBe("pass")
  })

  it("green then red reads 'fail' (the latest run is the one that matters)", () => {
    const executions: SeenRedExecution[] = [
      { command: "pytest tests/test_bar.py::test_baz", exitCode: 0, output: "1 passed in 0.01s" },
      { command: "pytest tests/test_bar.py::test_baz", exitCode: 1, output: "FAILED tests/test_bar.py::test_baz" },
    ]
    expect(observedTestVerdicts(executions).get("tests/test_bar.py::test_baz")).toBe("fail")
  })

  it("a laundered (exit-0 but red-signatured) re-run never overwrites a prior fail with a false pass", () => {
    const launderedRed =
      '.venv/bin/python tests/runtests.py delete delete_regress 2>&1 | grep -E "^(test_|FAIL|ERROR|OK|PASS|Ran|FAILED|test_) |^[0-9]+ tests" | tail -40; echo "---INSPECT---"; .venv/bin/python repro_inspect_combined.py'
    const launderedRedOutput =
      "Ran 63 tests in 0.511s\nFAILED (failures=2, errors=7, skipped=3)\n---INSPECT---\ncomposed WHERE clause: (OR: ...)"
    const executions: SeenRedExecution[] = [{ command: launderedRed, exitCode: 0, output: launderedRedOutput }]
    // The laundered run itself is red-shaped (isRedTestExecution catches it),
    // so it records "fail", not "pass" — never a false-green id.
    const verdicts = observedTestVerdicts(executions)
    const [, verdict] = [...verdicts.entries()][0]!
    expect(verdict).toBe("fail")
  })

  it("an id with no execution at all is absent from the map (undefined, not 'pass')", () => {
    const executions: SeenRedExecution[] = [
      { command: "pytest tests/test_bar.py::test_baz", exitCode: 1, output: "FAILED tests/test_bar.py::test_baz" },
    ]
    expect(observedTestVerdicts(executions).get("tests/test_other.py::test_x")).toBeUndefined()
  })
})
