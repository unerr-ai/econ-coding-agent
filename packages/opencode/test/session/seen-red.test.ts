/**
 * Tests for seen-red.ts (packages/opencode/src/session/seen-red.ts):
 * F18's findUnresolvedSeenRed — a red test/repro run cleared by a later
 * same-target green run, a red never re-run (flagged with an evidence
 * tail), a non-test bash failure ignored regardless of exit code, an
 * env-red (missing file / missing module) output ignored even though it is
 * test-shaped, clearing via the `clearedByProbe` passthrough (the M4
 * gate's own green re-run, invisible to the transcript), and the
 * exact-command fallback when no test-target tokens are extractable.
 */

import { describe, it, expect } from "bun:test"
import { findUnresolvedSeenRed, type SeenRedExecution } from "../../src/session/seen-red"

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

  // --- exit-code laundering (11885 rounds C+C3 live replay) ---

  const C3_LAUNDERED_RED =
    '.venv/bin/python tests/runtests.py delete delete_regress 2>&1 | grep -E "^(test_|FAIL|ERROR|OK|PASS|Ran|FAILED|test_) |^[0-9]+ tests" | tail -40; echo "---INSPECT---"; .venv/bin/python repro_inspect_combined.py'
  const C3_RED_OUTPUT = "Ran 63 tests in 0.511s\nFAILED (failures=2, errors=7, skipped=3)\n---INSPECT---\ncomposed WHERE clause: (OR: ...)"

  it("(g) flags a piped/compound test run whose exit was laundered to 0 (11885 C3 shape)", () => {
    const executions: SeenRedExecution[] = [{ command: C3_LAUNDERED_RED, exitCode: 0, output: C3_RED_OUTPUT }]
    const unresolved = findUnresolvedSeenRed(executions)
    expect(unresolved).toHaveLength(1)
    expect(unresolved[0]!.command).toBe(C3_LAUNDERED_RED)
  })

  it("(h) flags a tail-piped runtests red with exit 0 (11885 round-C shape)", () => {
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
