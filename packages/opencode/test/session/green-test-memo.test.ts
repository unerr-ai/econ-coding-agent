import { describe, expect, test } from "bun:test"
import { greenMemoBefore, greenMemoAfter, GREEN_MEMO_COMMANDS, MUTATING_BASH } from "@/session/tools"

// L3.1 green-test memo (docs/design/turn-cache-economics.md §5-L3 item 1): re-running an
// already-green test command with nothing changed short-circuits to a visible memo stub.
// Exercised at the same pure layer as step-result-budget.test.ts: `step` below reproduces
// the registry-loop wrapper contract in session/tools.ts — greenMemoBefore first (hit →
// skip execution), greenMemoAfter only after a real execution — and counts whether the
// underlying command actually ran.

// Each test gets a fresh sessionID so the module-level memo Map starts empty.
let seq = 0
function freshSession() {
  seq += 1
  return `ses_memo_${seq}`
}

function step(
  sessionID: string,
  toolID: string,
  args: Record<string, unknown>,
  run: () => { output: string; metadata: Record<string, unknown> },
  messageID = "msg_memo_1",
) {
  const memo = greenMemoBefore({ toolID, sessionID, args })
  if (memo) return { output: memo.output, metadata: memo.metadata, ran: false }
  const result = run()
  greenMemoAfter({ toolID, sessionID, messageID, args, result })
  return { output: result.output, metadata: result.metadata, ran: true }
}

// A green (exit 0) bash execution with a multi-line result, counting real runs.
function greenRun(counter: { runs: number }, output = "test_a OK\ntest_b OK\n45 tests passed") {
  return () => {
    counter.runs += 1
    return { output, metadata: { exit: 0 } as Record<string, unknown> }
  }
}

describe("green-test memo", () => {
  test("identical green test command: second call returns the memo stub without executing", () => {
    const sessionID = freshSession()
    const counter = { runs: 0 }
    const args = { command: "python tests/runtests.py model_enums" }

    const first = step(sessionID, "bash", args, greenRun(counter), "msg_memo_first")
    expect(first.ran).toBe(true)

    const second = step(sessionID, "bash", args, greenRun(counter))
    expect(second.ran).toBe(false)
    expect(counter.runs).toBe(1)
    // The stub is unmistakably a memo — marker, provenance step, last-result tail, and the
    // force-re-run escape hatch — never impersonating fresh output.
    expect(second.output).toContain("[green-test memo]")
    expect(second.output).toContain("unchanged since step msg_memo_first")
    expect(second.output).toContain("this exact command already passed and no file has been modified since")
    expect(second.output).toContain("45 tests passed")
    expect(second.output).toContain("change the command text (e.g. add -v)")
    expect(second.metadata["green_memo"]).toBe(true)
  })

  test("stub carries only the last 10 lines of the memoized output", () => {
    const sessionID = freshSession()
    const counter = { runs: 0 }
    const args = { command: "pytest tests/" }
    const output = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n")

    step(sessionID, "bash", args, greenRun(counter, output))
    const second = step(sessionID, "bash", args, greenRun(counter))
    expect(second.ran).toBe(false)
    expect(second.output).not.toContain("line 19")
    expect(second.output).toContain("line 20")
    expect(second.output).toContain("line 29")
  })

  test("red result is never memoized", () => {
    const sessionID = freshSession()
    const counter = { runs: 0 }
    const args = { command: "pytest tests/test_models.py" }
    const redRun = () => {
      counter.runs += 1
      return { output: "1 failed", metadata: { exit: 1 } as Record<string, unknown> }
    }

    step(sessionID, "bash", args, redRun)
    const second = step(sessionID, "bash", args, redRun)
    expect(second.ran).toBe(true)
    expect(counter.runs).toBe(2)
  })

  test("aborted/timed-out result (exit null) is never memoized", () => {
    const sessionID = freshSession()
    const counter = { runs: 0 }
    const args = { command: "pytest tests/" }
    const nullRun = () => {
      counter.runs += 1
      return { output: "", metadata: { exit: null } as Record<string, unknown> }
    }

    step(sessionID, "bash", args, nullRun)
    expect(step(sessionID, "bash", args, nullRun).ran).toBe(true)
    expect(counter.runs).toBe(2)
  })

  test("edit-family tool completion invalidates the whole session memo", () => {
    const sessionID = freshSession()
    const counter = { runs: 0 }
    const args = { command: "npm test" }

    step(sessionID, "bash", args, greenRun(counter))
    expect(step(sessionID, "bash", args, greenRun(counter)).ran).toBe(false)

    for (const toolID of ["edit", "write", "apply_patch", "unerr_file_edit"]) {
      step(sessionID, toolID, { filePath: "/tmp/x.ts" }, () => ({
        output: "ok",
        metadata: {} as Record<string, unknown>,
      }))
      expect(step(sessionID, "bash", args, greenRun(counter)).ran).toBe(true)
      // Re-arm the memo for the next tool in the loop.
      expect(step(sessionID, "bash", args, greenRun(counter)).ran).toBe(false)
    }
  })

  test("mutating bash invalidates; read-only bash does not", () => {
    const sessionID = freshSession()
    const counter = { runs: 0 }
    const args = { command: "yarn test" }
    const otherRun = () => ({ output: "", metadata: { exit: 0 } as Record<string, unknown> })

    step(sessionID, "bash", args, greenRun(counter))

    // Read-only commands leave the memo intact.
    for (const command of ["git status", "git log --oneline", "git diff", "grep -rn foo src", "cat README.md", "ls -la", 'python -c "print(1)"']) {
      step(sessionID, "bash", { command }, otherRun)
    }
    expect(step(sessionID, "bash", args, greenRun(counter)).ran).toBe(false)

    // A mutating command drops the whole session memo.
    step(sessionID, "bash", { command: "rm -rf build" }, otherRun)
    expect(step(sessionID, "bash", args, greenRun(counter)).ran).toBe(true)
  })

  test("non-test bash commands are never memoized", () => {
    const sessionID = freshSession()
    const counter = { runs: 0 }
    const args = { command: "ls -la" }

    step(sessionID, "bash", args, greenRun(counter))
    expect(step(sessionID, "bash", args, greenRun(counter)).ran).toBe(true)
    expect(counter.runs).toBe(2)
  })

  test("a test command with a mutation shape is treated as mutating, never memoized", () => {
    const sessionID = freshSession()
    const counter = { runs: 0 }
    const args = { command: "pytest tests/ > out.log" }

    step(sessionID, "bash", args, greenRun(counter))
    expect(step(sessionID, "bash", args, greenRun(counter)).ran).toBe(true)
  })

  test("normalization: whitespace variants hit the same key", () => {
    const sessionID = freshSession()
    const counter = { runs: 0 }

    step(sessionID, "bash", { command: "pytest   tests/test_x.py" }, greenRun(counter))
    const second = step(sessionID, "bash", { command: "  pytest tests/test_x.py " }, greenRun(counter))
    expect(second.ran).toBe(false)
    expect(counter.runs).toBe(1)
  })

  test("workdir participates in the key: same command, different directory, different result", () => {
    const sessionID = freshSession()
    const counter = { runs: 0 }

    step(sessionID, "bash", { command: "pytest", workdir: "/repo/a" }, greenRun(counter))
    expect(step(sessionID, "bash", { command: "pytest", workdir: "/repo/b" }, greenRun(counter)).ran).toBe(true)
    expect(step(sessionID, "bash", { command: "pytest", workdir: "/repo/a" }, greenRun(counter)).ran).toBe(false)
  })

  test("memo is session-scoped: another session never sees the entry", () => {
    const a = freshSession()
    const b = freshSession()
    const counter = { runs: 0 }
    const args = { command: "bun test" }

    step(a, "bash", args, greenRun(counter))
    expect(step(b, "bash", args, greenRun(counter)).ran).toBe(true)
  })

  test("MUTATING_BASH exempts fd-duplication but catches file redirects and git state changes", () => {
    // `2>&1` is how test invocations merge stderr — it must not mark them mutating.
    expect(MUTATING_BASH.test("python tests/runtests.py model_enums 2>&1")).toBe(false)
    expect(MUTATING_BASH.test("pytest tests/ > out.log")).toBe(true)
    expect(MUTATING_BASH.test("echo hi >> notes.txt")).toBe(true)
    expect(MUTATING_BASH.test("sed -i 's/a/b/' file.py")).toBe(true)
    expect(MUTATING_BASH.test("git checkout -- .")).toBe(true)
    expect(MUTATING_BASH.test("git status")).toBe(false)
    expect(MUTATING_BASH.test("pip install -e .")).toBe(true)
    expect(MUTATING_BASH.test("python setup.py develop")).toBe(true)
  })

  test("GREEN_MEMO_COMMANDS covers the test/check allowlist and nothing read-shaped", () => {
    for (const command of [
      "python tests/runtests.py model_enums",
      "pytest tests/test_x.py -x",
      "bun test test/session",
      "npm test",
      "npm run test",
      "yarn test",
      "tsc --noEmit",
      "eslint src/",
      "ruff check .",
      "mypy pkg/",
    ]) {
      expect(GREEN_MEMO_COMMANDS.test(command)).toBe(true)
    }
    for (const command of ["ls -la", "git status", "cat foo.py", "grep -rn pattern src/"]) {
      expect(GREEN_MEMO_COMMANDS.test(command)).toBe(false)
    }
  })
})
