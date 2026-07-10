import { describe, it, expect } from "bun:test"
import {
  observeStep,
  normalizeResult,
  createGrindValve,
  GRIND_VALVE_STEPS,
  GRIND_VALVE_STALL_WINDOW,
} from "../../src/session/turn-supervisor"
import { stuckNudgeText, grindValveNudgeText } from "../../src/session/prompts/nudges"
import { createStuckSupervisor } from "../../../code-intelligence/src/orchestration-fsm"
import { GRIND_DESIGN_PREPASS_TODO } from "../../src/session/slice-orchestrator"
import {
  GRIND_DESIGN_SLICE_CONTENT,
  LOCALIZATION_SLICE_CONTENT,
  PLAN_SLICE_CONTENT,
  REDECOMPOSITION_SLICE_CONTENT,
} from "../../src/session/prompts/seeds"

// SM4 — the root-loop step observer that feeds the stuck supervisor. Pure, so
// these are table tests over synthetic tool-part arrays (the shape prompt.ts
// reads off a completed assistant message: {type:"tool", tool, state:{status,
// input, output}}).

// -- test doubles -----------------------------------------------------------

function bash(command: string, output: string, status: "completed" | "error" = "completed") {
  return { type: "tool", tool: "bash", state: { status, input: { command }, output } }
}
function edit(filePath: string, status: "completed" | "error" = "completed", oldString = "a", newString = "b") {
  return { type: "tool", tool: "edit", state: { status, input: { filePath, oldString, newString } } }
}
function read(filePath: string, offset?: number) {
  const input = offset === undefined ? { filePath } : { filePath, offset }
  return { type: "tool", tool: "read", state: { status: "completed", input, output: "…file contents…" } }
}
function task(description: string) {
  return { type: "tool", tool: "task", state: { status: "completed", input: { description }, output: "…subagent report…" } }
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

  it("tracks a read-only tool by its target (not an empty signature) and stays resultless", () => {
    const { observation } = observeStep([read("django/db/models/deletion.py")])
    expect(observation.toolSignature).toContain("read:django/db/models/deletion.py")
    expect(observation.resultSignature).toBeUndefined()
    expect(observation.readFiles).toEqual(["django/db/models/deletion.py"])
    expect(observation.progressed).toBe(false)
  })

  it("tracks a sub-agent spawn by its description so distinct explorations differ", () => {
    const a = observeStep([task("explore the collector")]).observation.toolSignature
    const b = observeStep([task("explore the query compiler")]).observation.toolSignature
    expect(a).toContain("task:explore the collector")
    expect(a).not.toBe(b)
  })

  it("marks a landed edit and a run command as progress; a pure read is not", () => {
    expect(observeStep([edit("src/foo.ts")]).observation.progressed).toBe(true)
    expect(observeStep([bash(CMD, GREEN)]).observation.progressed).toBe(true)
    expect(observeStep([read("src/foo.ts")]).observation.progressed).toBe(false)
    // a denied edit never modified anything → not progress
    expect(observeStep([edit("src/foo.ts", "error")]).observation.progressed).toBe(false)
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

  it("diverse read-only exploration never trips repeated-tool (the run-11885 false positive)", () => {
    const sup = createStuckSupervisor()
    // read a file, spawn an explorer, read two more — varied signatures, not a loop
    expect(sup.observe(observeStep([read("a.py")]).observation)).toBeUndefined()
    expect(sup.observe(observeStep([task("explore the collector")]).observation)).toBeUndefined()
    expect(sup.observe(observeStep([read("b.py")]).observation)).toBeUndefined()
    expect(sup.observe(observeStep([read("c.py")]).observation)).toBeUndefined()
  })

  it("still catches a genuine read loop: the identical read re-issued 3x", () => {
    const sup = createStuckSupervisor()
    expect(sup.observe(observeStep([read("a.py")]).observation)).toBeUndefined()
    expect(sup.observe(observeStep([read("a.py")]).observation)).toBeUndefined()
    const signal = sup.observe(observeStep([read("a.py")]).observation)
    expect(signal?.reason).toBe("repeated-tool")
  })

  it("three progressive (different) edits to one file never trip repeated-tool (run-11885 v2 false positive)", () => {
    const sup = createStuckSupervisor()
    // import edit, then collect edit, then the delete-loop edit — the real 11885 fix shape
    expect(sup.observe(observeStep([edit("d.py", "completed", "import a", "import a, b")]).observation)).toBeUndefined()
    expect(sup.observe(observeStep([edit("d.py", "completed", "x = []", "x = {}")]).observation)).toBeUndefined()
    expect(sup.observe(observeStep([edit("d.py", "completed", "for q in x", "for q in x.values()")]).observation)).toBeUndefined()
  })

  it("still catches the SAME edit re-applied to one file 3x", () => {
    const sup = createStuckSupervisor()
    expect(sup.observe(observeStep([edit("d.py", "completed", "a", "b")]).observation)).toBeUndefined()
    expect(sup.observe(observeStep([edit("d.py", "completed", "a", "b")]).observation)).toBeUndefined()
    const signal = sup.observe(observeStep([edit("d.py", "completed", "a", "b")]).observation)
    expect(signal?.reason).toBe("repeated-tool")
  })

  it("three no-operation steps in a row fire no-op", () => {
    const sup = createStuckSupervisor()
    expect(sup.observe(observeStep([]).observation)).toBeUndefined()
    expect(sup.observe(observeStep([]).observation)).toBeUndefined()
    const signal = sup.observe(observeStep([]).observation)
    expect(signal?.reason).toBe("no-op")
  })

  it("re-reading ONE file 5x (different offsets) fires excessive-reread, not exact-duplicate", () => {
    const sup = createStuckSupervisor()
    let signal
    for (let i = 0; i < 5; i++) {
      signal = sup.observe(observeStep([read("deletion.py", i)]).observation)
    }
    expect(signal?.reason).toBe("excessive-reread")
    expect(signal?.signature).toBe("deletion.py")
  })

  it("an edit between rereads clears the tally — read, work, read again never fires", () => {
    const sup = createStuckSupervisor()
    for (let i = 0; i < 4; i++) {
      expect(sup.observe(observeStep([read("deletion.py", i)]).observation)).toBeUndefined()
    }
    // a real edit lands → reread tally resets
    expect(sup.observe(observeStep([edit("deletion.py", "completed", "old", "new")]).observation)).toBeUndefined()
    // four more reads (re-verification) do not fire
    for (let i = 10; i < 14; i++) {
      expect(sup.observe(observeStep([read("deletion.py", i)]).observation)).toBeUndefined()
    }
  })
})

// -- L4.2 grind valve --------------------------------------------------------
// The once-per-turn budget rung riding SM4's observation stream: opens at
// GRIND_VALVE_STEPS observed steps when no green verify landed in the last
// GRIND_VALVE_STALL_WINDOW (the django-11885 grind: 179 DIVERSE inline steps
// the repetition ladder never caught). Signals are mocked the same way as the
// supervisor tests above — synthetic tool-part arrays through observeStep.

describe("createGrindValve", () => {
  // One grinding step: a landed source edit + a red test run (diverse inputs so
  // the stuck ladder's repeat signatures never collide — the 11885 shape).
  const grindStep = (i: number) => observeStep([edit(`src/f${i}.ts`, "completed", `a${i}`, `b${i}`), bash(CMD, RED)])
  const greenStep = () => observeStep([bash(CMD, GREEN)])

  it("does NOT fire below the step budget, however red the run is", () => {
    const valve = createGrindValve()
    for (let i = 1; i < GRIND_VALVE_STEPS; i++) {
      expect(valve.observe(grindStep(i))).toBeUndefined()
    }
  })

  it("fires exactly at the budget when no green verify ever happened", () => {
    const valve = createGrindValve()
    let signal
    for (let i = 1; i <= GRIND_VALVE_STEPS; i++) {
      signal = valve.observe(grindStep(i))
      if (i < GRIND_VALVE_STEPS) expect(signal).toBeUndefined()
    }
    expect(signal).toBeDefined()
    expect(signal?.step).toBe(GRIND_VALVE_STEPS)
    expect(signal?.stepsSinceGreen).toBe(GRIND_VALVE_STEPS)
  })

  it("does NOT fire when a green verify transition happened in-window; fires once the stall completes", () => {
    const valve = createGrindValve()
    // red grind up to just before the budget, with a green landing so the
    // stall window is NOT yet exceeded at the budget crossing…
    const greenAt = GRIND_VALVE_STEPS - 5
    for (let i = 1; i <= GRIND_VALVE_STEPS; i++) {
      const result = i === greenAt ? greenStep() : grindStep(i)
      expect(valve.observe(result)).toBeUndefined() // at step 60 the stall is only 5 < 15
    }
    // …then keeps holding until the stall window is genuinely exceeded.
    let signal
    for (let i = GRIND_VALVE_STEPS + 1; i <= greenAt + GRIND_VALVE_STALL_WINDOW; i++) {
      signal = valve.observe(grindStep(i))
      if (i < greenAt + GRIND_VALVE_STALL_WINDOW) expect(signal).toBeUndefined()
    }
    expect(signal?.step).toBe(greenAt + GRIND_VALVE_STALL_WINDOW)
    expect(signal?.stepsSinceGreen).toBe(GRIND_VALVE_STALL_WINDOW)
  })

  it("an edit-only step is never a green verify — it cannot reset the stall", () => {
    const valve = createGrindValve()
    let signal
    for (let i = 1; i <= GRIND_VALVE_STEPS; i++) {
      // pure landed edits: progressed, but no command ran → no resultSignature
      signal = valve.observe(observeStep([edit(`src/g${i}.ts`, "completed", `x${i}`, `y${i}`)]))
    }
    expect(signal?.step).toBe(GRIND_VALVE_STEPS)
  })

  it("a red command run is never a green verify", () => {
    const valve = createGrindValve()
    let signal
    for (let i = 1; i <= GRIND_VALVE_STEPS; i++) {
      signal = valve.observe(observeStep([bash(CMD, RED)]))
    }
    expect(signal).toBeDefined()
  })

  it("fires at most once — a fired valve never re-fires", () => {
    const valve = createGrindValve()
    let fired = 0
    for (let i = 1; i <= GRIND_VALVE_STEPS * 2; i++) {
      if (valve.observe(grindStep(i))) fired += 1
    }
    expect(fired).toBe(1)
  })

  it("proposes through the existing delegation shape: the reasoner design seed todo", () => {
    // The valve's proposal IS the injected todo the OL-7.3b slice hook
    // dispatches — assert its shape, not deep dispatch (the hook, allocation,
    // and fold-back are existing machinery with their own tests).
    expect(GRIND_DESIGN_PREPASS_TODO.content).toBe(GRIND_DESIGN_SLICE_CONTENT)
    expect(GRIND_DESIGN_PREPASS_TODO.status).toBe("pending")
    expect(GRIND_DESIGN_PREPASS_TODO.sliceType).toBe("design")
    expect(GRIND_DESIGN_PREPASS_TODO.need).toBe("reasoner")
    expect(GRIND_DESIGN_PREPASS_TODO.persona).toBe("researcher")
    // dedup-by-content must keep it plantable alongside every other seed kind
    for (const other of [LOCALIZATION_SLICE_CONTENT, PLAN_SLICE_CONTENT, REDECOMPOSITION_SLICE_CONTENT]) {
      expect(GRIND_DESIGN_SLICE_CONTENT).not.toBe(other)
    }
  })

  it("the valve nudge names the evidence and holds edits until the design returns", () => {
    const text = grindValveNudgeText({ step: 60, stepsSinceGreen: 15 })
    expect(text).toContain("60")
    expect(text).toContain("15")
    expect(text.toLowerCase()).toContain("design")
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
