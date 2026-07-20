/**
 * Tests for decideErrorSearchNudge (packages/opencode/src/session/prompt.ts)
 * — the P5 error-search consumer that wires error-search.ts's deterministic
 * version-aware search triggers into the F18 seen-red finish-time gate
 * (docs/design/agnostic-hands-eyes.md §3 + §3.1). error-search.ts's own
 * exports (normalizeTraceForSearch/classifyTraceRoot/shouldSearchForError)
 * are already covered 35/35 in error-search.test.ts — these tests exercise
 * the WIRING: real inputs flowing through the real trigger functions,
 * proving the assembly (which output feeds the trace, how
 * recognizedByProfile/traceOrigin/reproAttempts are derived,
 * OPENCODE_DISABLE_WEBSEARCH short-circuiting) is correct end to end.
 */

import { describe, it, expect } from "bun:test"
import { decideErrorSearchNudge } from "../../src/session/prompt"

const DEPENDENCY_TRACEBACK = [
  "Traceback (most recent call last):",
  '  File "/repo/.venv/lib/python3.11/site-packages/somejsonlib/parser.py", line 42, in loads',
  "    return _parse(payload)",
  "ValueError: invalid literal for int() with base 10: 'abc'",
].join("\n")

const REPO_TRACEBACK = [
  "Traceback (most recent call last):",
  '  File "/repo/pkg/mod.py", line 10, in do_thing',
  "    return int(value)",
  "ValueError: invalid literal for int() with base 10: 'xyz'",
].join("\n")

const REPO_JUNIT_REPORT =
  '<testsuite tests="1" failures="1"><testcase classname="pkg.mod" name="test_do_thing"><failure message="boom"/></testcase></testsuite>'

describe("decideErrorSearchNudge", () => {
  it("(a) fires on a dependency-rooted, unrecognized trace — query is version-pinned and carries the dependency name", () => {
    const result = decideErrorSearchNudge({
      failingOutput: DEPENDENCY_TRACEBACK,
      reportContent: undefined,
      repoRoot: "/repo",
      ecosystemVersions: { deps: { somejsonlib: "2.3.1" } },
      reproAttempts: 0,
      alreadySearchedSignatures: new Set(),
      websearchDisabled: false,
    })
    expect(result).toBeDefined()
    expect(result!.decision.search).toBe(true)
    if (result!.decision.search) {
      expect(result!.decision.query).toContain("ValueError")
      expect(result!.decision.query).toContain("somejsonlib")
      expect(result!.decision.query).toContain("2.3.1")
      expect(result!.decision.reason).toContain("dependency")
    }
    // "fires once" — the wiring latches the returned signature into the
    // turn's already-searched set; feeding it back must never re-fire.
    const secondCall = decideErrorSearchNudge({
      failingOutput: DEPENDENCY_TRACEBACK,
      reportContent: undefined,
      repoRoot: "/repo",
      ecosystemVersions: { deps: { somejsonlib: "2.3.1" } },
      reproAttempts: 0,
      alreadySearchedSignatures: new Set([result!.signature]),
      websearchDisabled: false,
    })
    expect(secondCall!.decision.search).toBe(false)
  })

  it("(b) never fires when OPENCODE_DISABLE_WEBSEARCH is set — arena/benchmark strip-the-web discipline", () => {
    const result = decideErrorSearchNudge({
      failingOutput: DEPENDENCY_TRACEBACK,
      reportContent: undefined,
      repoRoot: "/repo",
      ecosystemVersions: { deps: { somejsonlib: "2.3.1" } },
      reproAttempts: 0,
      alreadySearchedSignatures: new Set(),
      websearchDisabled: true,
    })
    expect(result).toBeUndefined()
  })

  it("(c) does not re-fire for a signature already searched this turn", () => {
    const first = decideErrorSearchNudge({
      failingOutput: DEPENDENCY_TRACEBACK,
      reportContent: undefined,
      repoRoot: "/repo",
      ecosystemVersions: { deps: { somejsonlib: "2.3.1" } },
      reproAttempts: 0,
      alreadySearchedSignatures: new Set(),
      websearchDisabled: false,
    })
    expect(first!.decision.search).toBe(true)
    const repeat = decideErrorSearchNudge({
      failingOutput: DEPENDENCY_TRACEBACK,
      reportContent: undefined,
      repoRoot: "/repo",
      ecosystemVersions: { deps: { somejsonlib: "2.3.1" } },
      reproAttempts: 0,
      alreadySearchedSignatures: new Set([first!.signature]),
      websearchDisabled: false,
    })
    expect(repeat!.decision.search).toBe(false)
    if (!repeat!.decision.search) {
      expect(repeat!.decision.reason).toContain("already searched")
    }
  })

  it("(d) never fires on a repo-internal error our own structured test-report parser already recognized", () => {
    const result = decideErrorSearchNudge({
      failingOutput: REPO_TRACEBACK,
      reportContent: REPO_JUNIT_REPORT,
      repoRoot: "/repo",
      ecosystemVersions: { deps: {} },
      reproAttempts: 0,
      alreadySearchedSignatures: new Set(),
      websearchDisabled: false,
    })
    expect(result).toBeDefined()
    expect(result!.decision.search).toBe(false)
    if (!result!.decision.search) {
      expect(result!.decision.reason).toContain("repo-internal")
    }
  })

  it("returns undefined when the failing output carries no recognizable error/trace shape — never a false-positive query", () => {
    const result = decideErrorSearchNudge({
      failingOutput: "FAILED (failures=1)",
      reportContent: undefined,
      repoRoot: "/repo",
      ecosystemVersions: undefined,
      reproAttempts: 0,
      alreadySearchedSignatures: new Set(),
      websearchDisabled: false,
    })
    expect(result).toBeUndefined()
  })

  it("still fires on a repo-internal, recognized error once repro attempts escalate past the threshold", () => {
    const result = decideErrorSearchNudge({
      failingOutput: REPO_TRACEBACK,
      reportContent: REPO_JUNIT_REPORT,
      repoRoot: "/repo",
      ecosystemVersions: { deps: {} },
      reproAttempts: 2,
      alreadySearchedSignatures: new Set(),
      websearchDisabled: false,
    })
    expect(result!.decision.search).toBe(true)
    if (result!.decision.search) {
      expect(result!.decision.reason).toContain("repro unresolved")
    }
  })
})
