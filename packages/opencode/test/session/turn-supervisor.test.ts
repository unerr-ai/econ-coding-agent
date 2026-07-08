import { describe, it, expect } from "bun:test"
import { observeStep, normalizeResult, stuckNudgeText } from "../../src/session/turn-supervisor"
import { createStuckSupervisor } from "../../../code-intelligence/src/orchestration-fsm"

// SM4 — the root-loop step observer that feeds the stuck supervisor. Pure, so
// these are table tests over synthetic tool-part arrays (the shape prompt.ts
// reads off a completed assistant message: {type:"tool", tool, state:{status,
// input, output}}).

// -- test doubles -----------------------------------------------------------

function bash(command: string, output: string, status: "completed" | "error" = "completed") {
  return { type: "tool", tool: "bash", state: { status, input: { command }, output } }
}
function edit(filePath: string, status: "completed" | "error" = "completed") {
  return { type: "tool", tool: "edit", state: { status, input: { filePath, oldString: "a", newString: "b" } } }
}

const RED = "test_large_delete ... FAIL\nAssertionError: 22 != 25 : 22 queries executed, 25 expected"
const GREEN = "test_large_delete ... ok\nRan 1 test in 0.031s\nOK"
const CMD = "python tests/runtests.py delete.tests.DeletionTests.test_large_delete"

// -- observeStep ------------------------------------------------------------

describe("observeStep", () => {
  it("a failed command sets a result signature and enters the probe-from-red pool", () => {
    const { observation, failedCommands } = observeStep([bash(CMD, RED)])
    expect(observation.resultSignature).toBeDefined()
    expect(observation.toolSignature).toContain(CMD)
    expect(failedCommands).toEqual([CMD])
  })

  it("a passing command carries a result signature but nothing failed", () => {
    const { observation, failedCommands } = observeStep([bash(CMD, GREEN)])
    expect(observation.resultSignature).toBeDefined()
    expect(failedCommands).toEqual([])
  })

  it("an edit-only step has no result signature (leaves the red tally untouched)", () => {
    const { observation, failedCommands } = observeStep([edit("django/db/models/deletion.py")])
    expect(observation.resultSignature).toBeUndefined()
    expect(observation.toolSignature).toContain("deletion.py")
    expect(failedCommands).toEqual([])
  })

  it("flags a completed test-file edit as the fake-green tell when test edits are forbidden", () => {
    const { observation } = observeStep([edit("tests/test_delete.py")], { isTestSlice: false })
    expect(observation.editedTestFile).toBe("tests/test_delete.py")
  })

  it("does NOT flag a test-file edit on a sanctioned test turn (isTestSlice)", () => {
    const { observation } = observeStep([edit("tests/test_delete.py")], { isTestSlice: true })
    expect(observation.editedTestFile).toBeUndefined()
  })

  it("does NOT flag a DENIED test edit (status error never modified the file)", () => {
    const { observation } = observeStep([edit("tests/test_delete.py", "error")], { isTestSlice: false })
    expect(observation.editedTestFile).toBeUndefined()
  })

  it("ignores a source-file edit (not a test path)", () => {
    const { observation } = observeStep([edit("django/db/models/deletion.py")], { isTestSlice: false })
    expect(observation.editedTestFile).toBeUndefined()
  })

  it("treats a status:error command as failed even without a failure marker in output", () => {
    const { failedCommands } = observeStep([bash(CMD, "", "error")])
    expect(failedCommands).toEqual([CMD])
  })
})

// -- normalizeResult --------------------------------------------------------

describe("normalizeResult", () => {
  it("strips run-to-run duration noise so the same failure hashes identically", () => {
    const a = normalizeResult("FAIL: 22 != 25\nRan 1 test in 0.031s")
    const b = normalizeResult("FAIL: 22 != 25\nRan 1 test in 1.204s")
    expect(a).toBe(b)
    expect(a).toContain("22 != 25")
  })

  it("strips timestamps, hex addresses and temp paths", () => {
    const a = normalizeResult("boom at 0xdeadbeef in /tmp/pytest-abc/x 2026-07-08T10:00:00Z")
    const b = normalizeResult("boom at 0xfeed1234 in /tmp/pytest-xyz/y 2026-07-08T11:22:33Z")
    expect(a).toBe(b)
  })
})

// -- integration: the 11885 thrash shape -----------------------------------

describe("observeStep + createStuckSupervisor", () => {
  it("catches the same red result repeated 3x even with an interleaved source edit", () => {
    const sup = createStuckSupervisor()
    // step 1: run the repro RED
    expect(sup.observe(observeStep([bash(CMD, RED)]).observation)).toBeUndefined()
    // step 2: edit the source (an edit-only step must not reset the red tally)
    expect(sup.observe(observeStep([edit("django/db/models/deletion.py")]).observation)).toBeUndefined()
    // step 3: re-run RED (2nd identical red)
    expect(sup.observe(observeStep([bash(CMD, RED)]).observation)).toBeUndefined()
    // step 4: re-run RED (3rd identical red) → repeated-red fires
    const signal = sup.observe(observeStep([bash(CMD, RED)]).observation)
    expect(signal?.reason).toBe("repeated-red")
  })

  it("a genuinely progressing run (red → different red → green) never fires", () => {
    const sup = createStuckSupervisor()
    expect(sup.observe(observeStep([bash(CMD, RED)]).observation)).toBeUndefined()
    expect(sup.observe(observeStep([bash(CMD, "FAIL: different error entirely")]).observation)).toBeUndefined()
    expect(sup.observe(observeStep([bash(CMD, GREEN)]).observation)).toBeUndefined()
  })
})

// -- stuckNudgeText ---------------------------------------------------------

describe("stuckNudgeText", () => {
  it("names the grader for a test-edit tell", () => {
    const text = stuckNudgeText({ reason: "test-edit", signature: "tests/x.py", count: 1 }, 2)
    expect(text.toLowerCase()).toContain("grader")
    expect(text.toLowerCase()).toContain("not a fix")
  })

  it("rung 2 asks for a first-principles root-cause pass", () => {
    const r1 = stuckNudgeText({ reason: "repeated-red", signature: "x", count: 3 }, 1)
    const r2 = stuckNudgeText({ reason: "repeated-red", signature: "x", count: 3 }, 2)
    expect(r2.toLowerCase()).toContain("first principles")
    expect(r1).not.toBe(r2)
  })
})
