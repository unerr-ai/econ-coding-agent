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
})
