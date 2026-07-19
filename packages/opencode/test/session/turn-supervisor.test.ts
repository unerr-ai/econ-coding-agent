import { describe, it, expect } from "bun:test"
import {
  observeStep,
  normalizeResult,
  createGrindValve,
  GRIND_VALVE_STEPS,
  GRIND_VALVE_STALL_WINDOW,
  createBatchMomentumWatcher,
  createRerunDedupeTracker,
  IDENTICAL_RUN_THRESHOLD,
  SLOW_COMMAND_MS,
  looksLikeTestExecution,
  shouldDenyUnverifiedFinish,
  decideHeadlessCompletionReentry,
  isTestInfraFilePath,
  detectPatchSanityGap,
  shouldDenyPatchSanity,
  shouldDenyF2pClaim,
} from "../../src/session/turn-supervisor"
import {
  stuckNudgeText,
  grindValveNudgeText,
  reproDriftNudgeText,
  convergeNowNudgeText,
  pinGreenFinishNudgeText,
  backgroundJobCompletionNudgeText,
  backgroundJobHeartbeatNudgeText,
  hubDesignVerdictNudgeText,
  hubDesignDegradedNudgeText,
  unverifiedFinishGateNudgeText,
  identicalRunDedupeNudgeText,
  patchSanityNudgeText,
  f2pClaimNudgeText,
} from "../../src/session/prompts/nudges"
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

function bash(
  command: string,
  output: string,
  status: "completed" | "error" = "completed",
  time?: { start: number; end?: number },
) {
  return { type: "tool", tool: "bash", state: { status, input: { command }, output, time } }
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

  it("does NOT mark slowCommand when state.time is missing", () => {
    expect(observeStep([bash(CMD, GREEN)]).observation.slowCommand).toBe(false)
  })

  it("does NOT mark slowCommand for a command under SLOW_COMMAND_MS", () => {
    const fast = observeStep([bash(CMD, GREEN, "completed", { start: 0, end: 500 })])
    expect(fast.observation.slowCommand).toBe(false)
  })

  it("marks slowCommand when a completed command ran >= SLOW_COMMAND_MS", () => {
    const slow = observeStep([bash(CMD, GREEN, "completed", { start: 0, end: SLOW_COMMAND_MS })])
    expect(slow.observation.slowCommand).toBe(true)
  })

  it("marks slowCommand for a timeout-killed command (status error, duration ≈ the bash timeout)", () => {
    const killed = observeStep([bash(CMD, "", "error", { start: 0, end: SLOW_COMMAND_MS })])
    expect(killed.observation.slowCommand).toBe(true)
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

// -- createRerunDedupeTracker (Round-H probe_rerun_dedupe) ------------------

describe("createRerunDedupeTracker", () => {
  it("fires on the 3rd identical (normalized) rerun, not the 1st or 2nd", () => {
    const tracker = createRerunDedupeTracker()
    expect(tracker.observe([bash(CMD, RED)])).toBeUndefined()
    expect(tracker.observe([bash(CMD, RED)])).toBeUndefined()
    const signal = tracker.observe([bash(CMD, RED)])
    expect(signal).toEqual({ command: CMD, occurrence: IDENTICAL_RUN_THRESHOLD })
  })

  it("an edit landing between runs resets the counter — the streak must restart from zero, not continue", () => {
    const tracker = createRerunDedupeTracker()
    expect(tracker.observe([bash(CMD, RED)])).toBeUndefined()
    expect(tracker.observe([bash(CMD, RED)])).toBeUndefined()
    // an edit lands right before what would have been the 3rd identical run
    expect(tracker.observe([edit("django/db/models/deletion.py")])).toBeUndefined()
    // only 2 post-edit reruns so far — without the reset this would be the
    // 4th identical run overall and would already have fired on the 3rd
    expect(tracker.observe([bash(CMD, RED)])).toBeUndefined()
    expect(tracker.observe([bash(CMD, RED)])).toBeUndefined()
    // the 3rd POST-EDIT rerun does fire — the streak restarted, it did not carry over
    expect(tracker.observe([bash(CMD, RED)])?.occurrence).toBe(3)
  })

  it("a different (normalized) output resets that command's own counter — a flaky test never fires", () => {
    const tracker = createRerunDedupeTracker()
    expect(tracker.observe([bash(CMD, RED)])).toBeUndefined()
    expect(tracker.observe([bash(CMD, RED)])).toBeUndefined()
    // 3rd run comes back GREEN instead — resets, does not fire
    expect(tracker.observe([bash(CMD, GREEN)])).toBeUndefined()
    expect(tracker.observe([bash(CMD, GREEN)])).toBeUndefined()
    // only the 2nd identical GREEN in a row — must not fire yet
    expect(tracker.observe([bash(CMD, RED)])).toBeUndefined()
  })

  it("run-to-run noise (durations/timestamps/temp paths) does not defeat the identical-output match", () => {
    const tracker = createRerunDedupeTracker()
    expect(tracker.observe([bash(CMD, "FAIL: 22 != 25\nRan 1 test in 0.031s")])).toBeUndefined()
    expect(tracker.observe([bash(CMD, "FAIL: 22 != 25\nRan 1 test in 1.204s")])).toBeUndefined()
    const signal = tracker.observe([bash(CMD, "FAIL: 22 != 25\nRan 1 test in 9.876s")])
    expect(signal?.occurrence).toBe(3)
  })

  it("fires at most once per distinct command — a 4th, 5th, ... identical rerun of the SAME command never re-fires", () => {
    const tracker = createRerunDedupeTracker()
    tracker.observe([bash(CMD, RED)])
    tracker.observe([bash(CMD, RED)])
    expect(tracker.observe([bash(CMD, RED)])).toBeDefined()
    expect(tracker.observe([bash(CMD, RED)])).toBeUndefined()
    expect(tracker.observe([bash(CMD, RED)])).toBeUndefined()
  })

  it("a DIFFERENT command gets its own independent counter", () => {
    const tracker = createRerunDedupeTracker()
    const OTHER_CMD = "python tests/runtests.py auth_tests"
    tracker.observe([bash(CMD, RED)])
    tracker.observe([bash(CMD, RED)])
    // two runs of a different command in between must not contribute to CMD's tally
    tracker.observe([bash(OTHER_CMD, RED)])
    tracker.observe([bash(OTHER_CMD, RED)])
    const signal = tracker.observe([bash(CMD, RED)])
    expect(signal).toEqual({ command: CMD, occurrence: 3 })
  })
})

describe("identicalRunDedupeNudgeText", () => {
  it("names the command and the occurrence count, and asks for a change before re-running", () => {
    const text = identicalRunDedupeNudgeText(CMD, 3)
    expect(text).toContain(CMD)
    expect(text).toContain("3")
    expect(text.toLowerCase()).toContain("no new information")
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

  it("a FAST identical red 3x stays repeated-red (no environment signal)", () => {
    const sup = createStuckSupervisor()
    const fastTime = { start: 0, end: 500 }
    expect(sup.observe(observeStep([bash(CMD, RED, "completed", fastTime)]).observation)).toBeUndefined()
    expect(sup.observe(observeStep([bash(CMD, RED, "completed", fastTime)]).observation)).toBeUndefined()
    const signal = sup.observe(observeStep([bash(CMD, RED, "completed", fastTime)]).observation)
    expect(signal?.reason).toBe("repeated-red")
  })

  it("a SLOW identical red 3x reclassifies as environment-slow (CPU-starved/timeout-killed shell, not model stuckness)", () => {
    const sup = createStuckSupervisor()
    const slowTime = { start: 0, end: SLOW_COMMAND_MS }
    expect(sup.observe(observeStep([bash(CMD, RED, "completed", slowTime)]).observation)).toBeUndefined()
    expect(sup.observe(observeStep([bash(CMD, RED, "completed", slowTime)]).observation)).toBeUndefined()
    const signal = sup.observe(observeStep([bash(CMD, RED, "completed", slowTime)]).observation)
    expect(signal?.reason).toBe("environment-slow")
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

// -- Wave 6 — hub-shopping design pre-pass -----------------------------------
// Same "assert the proposal shape, not deep dispatch" scope as the grind
// valve's own todo/nudge tests above (the OL-7.3b hook, allocation, and
// fold-back are existing machinery with their own tests) — prompt.ts's inner
// loop wiring itself has no scoped test here or for any sibling watcher
// (grind valve, stuck ladder, batch momentum, env-slow all lack one too; the
// loop's Effect/session/provider harness makes a scoped unit test
// disproportionate) — typecheck + these shape/content tests carry the wave.

describe("Wave 7 — hubDesignVerdictNudgeText", () => {
  it("names the bounced files, the decided fix site, and holds edits there", () => {
    const verdict = { file: "django/forms/widgets.py", entity: "Widget.value_from_datadict", change: "coerce at the source" }
    const text = hubDesignVerdictNudgeText(verdict, ["django/db/models/base.py", "django/forms/widgets.py"])
    expect(text).toContain("django/db/models/base.py")
    expect(text).toContain("django/forms/widgets.py")
    expect(text).toContain(verdict.file)
    expect(text).toContain(verdict.entity)
    expect(text).toContain(verdict.change)
    expect(text.toLowerCase()).toContain("design")
  })
})

describe("Wave 7 — hubDesignDegradedNudgeText", () => {
  it("names the bounced files and asks the model to re-derive the fix site itself", () => {
    const text = hubDesignDegradedNudgeText(["hub_a.py", "hub_b.py"])
    expect(text).toContain("hub_a.py")
    expect(text).toContain("hub_b.py")
    expect(text.toLowerCase()).toContain("defines")
    expect(text.toLowerCase()).toContain("coercion")
  })

  it("wave 8d: without candidates, text is unchanged (still asks the model to re-derive)", () => {
    const text = hubDesignDegradedNudgeText(["hub_a.py", "hub_b.py"])
    expect(text).toBe(
      "Your edits have twice landed on shared hub modules (hub_a.py, hub_b.py) — that is symptom-layer avoidance. Re-derive the fix site yourself before any further edit: name the module that DEFINES the misbehaving class or function the issue names, and fix its behavior THERE — never a coercion at a consumption site.",
    )
  })

  it("wave 8d: with candidates, names them and drops the re-derive-yourself instruction", () => {
    const text = hubDesignDegradedNudgeText(["hub_a.py", "hub_b.py"], ["django/db/models/enums.py"])
    expect(text).toContain("hub_a.py")
    expect(text).toContain("hub_b.py")
    expect(text).toContain("Per the code graph, the symbols this issue names are defined in:")
    expect(text).toContain("django/db/models/enums.py")
    expect(text.toLowerCase()).not.toContain("re-derive the fix site yourself")
    expect(text.toLowerCase()).toContain("coercion")
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

// -- L1.2c batch-momentum watcher --------------------------------------------
// Fires after BATCH_NUDGE_AFTER_SINGLE_STEPS consecutive single-tool-call
// steps, re-arming every BATCH_NUDGE_REARM_STEPS steps while the run
// persists. A >=2-call step resets the run; a 0-call step is neutral (neither
// increments nor resets).

describe("createBatchMomentumWatcher", () => {
  it("fires on the third consecutive single-call step", () => {
    const watcher = createBatchMomentumWatcher()
    expect(watcher.observe(1)).toBeUndefined()
    expect(watcher.observe(1)).toBeUndefined()
    expect(watcher.observe(1)).toEqual({ step: 3, consecutiveSingleCalls: 3 })
  })

  it("a multi-call step resets the run", () => {
    const watcher = createBatchMomentumWatcher()
    const counts = [1, 1, 2, 1, 1, 1]
    const signals = counts.map((c) => watcher.observe(c))
    expect(signals.slice(0, 5)).toEqual([undefined, undefined, undefined, undefined, undefined])
    expect(signals[5]).toEqual({ step: 6, consecutiveSingleCalls: 3 })
  })

  it("a zero-call step is neutral — it neither increments nor resets the run", () => {
    const watcher = createBatchMomentumWatcher()
    const counts = [1, 1, 0, 1]
    const signals = counts.map((c) => watcher.observe(c))
    expect(signals.slice(0, 3)).toEqual([undefined, undefined, undefined])
    expect(signals[3]).toEqual({ step: 4, consecutiveSingleCalls: 3 })
  })

  it("re-arms after BATCH_NUDGE_REARM_STEPS steps while the run persists", () => {
    const watcher = createBatchMomentumWatcher()
    const signals: (ReturnType<typeof watcher.observe> | undefined)[] = []
    for (let i = 1; i <= 12; i++) signals.push(watcher.observe(1))
    expect(signals[2]).toEqual({ step: 3, consecutiveSingleCalls: 3 }) // step 3
    for (let i = 4; i <= 10; i++) expect(signals[i - 1]).toBeUndefined()
    expect(signals[10]).toEqual({ step: 11, consecutiveSingleCalls: 11 }) // step 11
    expect(signals[11]).toBeUndefined() // step 12: re-armed at 11, only 1 step later
  })

  it("after a reset mid-run, both the run AND the re-arm cadence must clear before the next fire", () => {
    const watcher = createBatchMomentumWatcher()
    expect(watcher.observe(1)).toBeUndefined() // step 1
    expect(watcher.observe(1)).toBeUndefined() // step 2
    expect(watcher.observe(1)).toEqual({ step: 3, consecutiveSingleCalls: 3 }) // step 3: fires
    expect(watcher.observe(2)).toBeUndefined() // step 4: resets the run
    expect(watcher.observe(1)).toBeUndefined() // step 5: run=1
    expect(watcher.observe(1)).toBeUndefined() // step 6: run=2
    expect(watcher.observe(1)).toBeUndefined() // step 7: run=3, but 7-3=4 < 8 — not re-armed yet
    expect(watcher.observe(1)).toBeUndefined() // step 8: run=4, 8-3=5 < 8
    expect(watcher.observe(1)).toBeUndefined() // step 9: run=5, 9-3=6 < 8
    expect(watcher.observe(1)).toBeUndefined() // step 10: run=6, 10-3=7 < 8
    expect(watcher.observe(1)).toEqual({ step: 11, consecutiveSingleCalls: 7 }) // step 11: run=7, 11-3=8 >= 8 — fires
  })
})

// -- S8 convergeNowNudgeText --------------------------------------------------

describe("convergeNowNudgeText", () => {
  it("names the elapsed step count and both concrete exits", () => {
    const text = convergeNowNudgeText(8)
    expect(text).toContain("8 steps ago")
    expect(text).toContain("repro_issue.py")
    expect(text.toLowerCase()).toContain("finish")
  })

  it("interpolates a different step count", () => {
    const text = convergeNowNudgeText(12)
    expect(text).toContain("12 steps ago")
  })
})

// -- S8 reproDriftNudgeText suite-edit-denied clause -------------------------

describe("reproDriftNudgeText (suite-edit-denied)", () => {
  it("names the repo root and forbids importing from a tests module (django-11790 strict run #3)", () => {
    const text = reproDriftNudgeText("suite-edit-denied")
    expect(text.toLowerCase()).toContain("repo root")
    expect(text.toLowerCase()).toContain("never inside")
    expect(text.toLowerCase()).toContain("tests.*")
  })
})

// -- S9 reproDriftNudgeText pinned-repro-deleted clause ----------------------

describe("reproDriftNudgeText (pinned-repro-deleted)", () => {
  it("names the deleted file and the pinned command, and calls a missing file RED", () => {
    const text = reproDriftNudgeText("pinned-repro-deleted", {
      file: "repro_issue.py",
      probeCommand: "python repro_issue.py",
    })
    expect(text).toContain("repro_issue.py")
    expect(text).toContain("python repro_issue.py")
    expect(text.toUpperCase()).toContain("RED")
  })

  it("falls back to generic phrasing with no context", () => {
    const text = reproDriftNudgeText("pinned-repro-deleted")
    expect(text.toLowerCase()).toContain("pinned repro file")
  })
})

// -- S9 pinGreenFinishNudgeText -----------------------------------------------

describe("pinGreenFinishNudgeText", () => {
  it("names the pinned command, the STOP instruction, and forbids touching the repro file", () => {
    const text = pinGreenFinishNudgeText("python repro_issue.py")
    expect(text).toContain("python repro_issue.py")
    expect(text.toUpperCase()).toContain("STOP")
    expect(text.toLowerCase()).toContain("untracked")
    expect(text.toLowerCase()).toContain("final answer")
  })
})

// -- wave 10: looksLikeTestExecution ------------------------------------------
// django-11885 autopsy: the agent's one `runtests.py`-matching command was
// `cat tests/runtests.py` (a read), and `py_compile` was its only
// verification before shipping a 36-line source patch.

describe("looksLikeTestExecution", () => {
  it("recognizes a django runtests.py invocation", () => {
    expect(looksLikeTestExecution("python tests/runtests.py delete.tests.DeletionTests.test_large_delete")).toBe(
      true,
    )
  })

  it("recognizes a direct ./runtests.py invocation with no interpreter prefix", () => {
    expect(looksLikeTestExecution("./tests/runtests.py delete.tests.DeletionTests.test_large_delete")).toBe(true)
  })

  it("recognizes a venv python invocation with django settings", () => {
    expect(looksLikeTestExecution(".venv/bin/python tests/runtests.py delete_tests --settings=test_sqlite")).toBe(
      true,
    )
  })

  it("recognizes python -m pytest", () => {
    expect(looksLikeTestExecution("python -m pytest -q tests/test_delete.py")).toBe(true)
  })

  it("recognizes pytest invoked directly", () => {
    expect(looksLikeTestExecution("pytest -q tests/")).toBe(true)
  })

  it("checks the segment after && for a real execution too", () => {
    expect(looksLikeTestExecution("cd repo && python tests/runtests.py delete_tests")).toBe(true)
  })

  it("does NOT match a cat of the runner file — a read, never a run", () => {
    expect(looksLikeTestExecution("cat tests/runtests.py")).toBe(false)
  })

  it("does NOT match head/tail/sed reads of the runner file", () => {
    expect(looksLikeTestExecution("head -50 tests/runtests.py")).toBe(false)
    expect(looksLikeTestExecution("tail tests/runtests.py")).toBe(false)
    expect(looksLikeTestExecution("sed -n '1,20p' tests/runtests.py")).toBe(false)
  })

  it("does NOT match runtests.py appearing only inside a grep pattern", () => {
    expect(looksLikeTestExecution("grep -n runtests.py tests/")).toBe(false)
  })

  it("does NOT match a bare python invocation with no test-shaped argument", () => {
    expect(looksLikeTestExecution('python -c "import deletion"')).toBe(false)
  })

  it("does NOT match a read chained after a semicolon", () => {
    expect(looksLikeTestExecution("echo start; cat tests/runtests.py")).toBe(false)
  })
})

// -- wave 10: shouldDenyUnverifiedFinish + unverifiedFinishGateNudgeText -----

describe("shouldDenyUnverifiedFinish", () => {
  const base = { isChildSession: false, landedSourceEdits: true, ranRealTest: false, alreadyDenied: false }

  it("denies once: source edited, zero real test execution, not yet denied", () => {
    expect(shouldDenyUnverifiedFinish(base)).toBe(true)
  })

  it("the second finish attempt is always allowed once already denied, regardless of state", () => {
    expect(shouldDenyUnverifiedFinish({ ...base, alreadyDenied: true })).toBe(false)
  })

  it("a turn with no landed source edits never denies", () => {
    expect(shouldDenyUnverifiedFinish({ ...base, landedSourceEdits: false })).toBe(false)
  })

  it("a child session never denies", () => {
    expect(shouldDenyUnverifiedFinish({ ...base, isChildSession: true })).toBe(false)
  })

  it("a turn that ran a real test execution never denies", () => {
    expect(shouldDenyUnverifiedFinish({ ...base, ranRealTest: true })).toBe(false)
  })
})

describe("unverifiedFinishGateNudgeText", () => {
  it("names the concrete derived command when one is available", () => {
    const text = unverifiedFinishGateNudgeText("cd \"/repo\" && python tests/runtests.py delete_tests")
    expect(text).toContain("python tests/runtests.py delete_tests")
  })

  it("falls back to a generic ask when no command could be derived", () => {
    const text = unverifiedFinishGateNudgeText()
    expect(text.toLowerCase()).toContain("run the project's test suite")
  })
})

// -- D4 (09-ops-hands): decideHeadlessCompletionReentry ----------------------

describe("decideHeadlessCompletionReentry", () => {
  const base = {
    interactive: false,
    runningJobIds: ["job_1"],
    heartbeatFlaggedJobIds: new Set<string>(),
    reentryCount: 0,
    maxReentries: 20,
  }

  it("proceeds untouched on an interactive session (v1 scope)", () => {
    expect(decideHeadlessCompletionReentry({ ...base, interactive: true })).toBe("proceed")
  })

  it("proceeds when the session has no running jobs — the inert path", () => {
    expect(decideHeadlessCompletionReentry({ ...base, runningJobIds: [] })).toBe("proceed")
  })

  it("proceeds once the re-entry budget is spent, even with jobs still running", () => {
    expect(decideHeadlessCompletionReentry({ ...base, reentryCount: 20 })).toBe("proceed")
  })

  it("waits when headless with a running, un-flagged job under budget", () => {
    expect(decideHeadlessCompletionReentry(base)).toBe("wait")
  })

  it("heartbeat-passes once every running job is already heartbeat-flagged", () => {
    expect(
      decideHeadlessCompletionReentry({ ...base, heartbeatFlaggedJobIds: new Set(["job_1"]) }),
    ).toBe("heartbeat-pass")
  })

  it("still waits when only SOME running jobs are heartbeat-flagged (a new job started)", () => {
    expect(
      decideHeadlessCompletionReentry({
        ...base,
        runningJobIds: ["job_1", "job_2"],
        heartbeatFlaggedJobIds: new Set(["job_1"]),
      }),
    ).toBe("wait")
  })
})

describe("backgroundJobCompletionNudgeText", () => {
  it("names the job id, command, exit code, duration, output, and log path", () => {
    const text = backgroundJobCompletionNudgeText({
      id: "job_2",
      command: "make",
      exitCode: 0,
      elapsedMs: 581_000,
      chunk: "build finished",
      logPath: "/tmp/job-output/job_2.log",
    })
    expect(text).toContain("job_2")
    expect(text).toContain("`make`")
    expect(text).toContain("exited with code 0")
    expect(text).toContain("9m41s")
    expect(text).toContain("build finished")
    expect(text).toContain("/tmp/job-output/job_2.log")
    expect(text.toLowerCase()).toContain("finish")
  })

  it("falls back to '(no new output)' on an empty chunk", () => {
    const text = backgroundJobCompletionNudgeText({
      id: "job_3",
      command: "true",
      exitCode: 0,
      elapsedMs: 1000,
      chunk: "   ",
      logPath: "/tmp/job_3.log",
    })
    expect(text).toContain("(no new output)")
  })
})

describe("backgroundJobHeartbeatNudgeText", () => {
  it("names the job, elapsed duration, and the wait window, and offers wait/kill/finish", () => {
    const text = backgroundJobHeartbeatNudgeText({
      id: "job_1",
      command: "pytest -x",
      elapsedMs: 601_000,
      waitedMs: 600_000,
    })
    expect(text).toContain("job_1")
    expect(text).toContain("`pytest -x`")
    expect(text).toContain("still running")
    expect(text).toContain("waited 10 more minutes")
    expect(text.toLowerCase()).toContain("job tool")
    expect(text.toLowerCase()).toContain("kill")
    expect(text.toLowerCase()).toContain("finish")
  })
})

// -- H3: isTestInfraFilePath / detectPatchSanityGap / shouldDenyPatchSanity -

describe("isTestInfraFilePath", () => {
  it("matches a root-level conftest.py", () => {
    expect(isTestInfraFilePath("conftest.py")).toBe(true)
    expect(isTestInfraFilePath("astropy/conftest.py")).toBe(true)
  })

  it("matches setup.py and setup.cfg", () => {
    expect(isTestInfraFilePath("setup.py")).toBe(true)
    expect(isTestInfraFilePath("setup.cfg")).toBe(true)
  })

  it("matches a GitHub Actions workflow file", () => {
    expect(isTestInfraFilePath(".github/workflows/ci.yml")).toBe(true)
  })

  it("does not match real application code", () => {
    expect(isTestInfraFilePath("astropy/io/fits/hdu/base.py")).toBe(false)
  })
})

describe("detectPatchSanityGap", () => {
  // The astropy-7166 shape: a $1.31 escalated fix that shipped a
  // conftest.py-only patch with ZERO overlap with the issue.
  it("7166 shape: a conftest-only patch with no candidate-site overlap and no issue justification denies, naming the sites", () => {
    const gap = detectPatchSanityGap({
      patchFiles: ["astropy/conftest.py"],
      candidateSites: ["astropy/io/fits/hdu/base.py", "astropy/io/fits/header.py"],
      issueText: "The FITS header parser mis-handles a continuation card.",
    })
    expect(gap).toBe("no-overlap")
  })

  it("legitimate-fix shape: the patch intersects an issue-named/graph-resolved site — no gap (false-fire guard)", () => {
    const gap = detectPatchSanityGap({
      patchFiles: ["astropy/io/fits/hdu/base.py"],
      candidateSites: ["astropy/io/fits/hdu/base.py"],
      issueText: "The FITS header parser mis-handles a continuation card.",
    })
    expect(gap).toBeUndefined()
  })

  it("a defining-site edit under a shared subtree still passes via the pathsRefer suffix match", () => {
    const gap = detectPatchSanityGap({
      patchFiles: ["/repo/astropy/io/fits/hdu/base.py"],
      candidateSites: ["astropy/io/fits/hdu/base.py"],
      issueText: "issue text irrelevant to this check",
    })
    expect(gap).toBeUndefined()
  })

  it("test-infra-with-justification shape: the issue text names conftest.py — allowed even though the patch touches ONLY test infra", () => {
    const gap = detectPatchSanityGap({
      patchFiles: ["conftest.py"],
      candidateSites: ["conftest.py"],
      issueText: "The `numpy_extension` fixture in conftest.py needs a session scope.",
    })
    expect(gap).toBeUndefined()
  })

  it("test-infra-unjustified shape: a test-infra-only patch that overlaps a candidate site but the issue never names the file", () => {
    const gap = detectPatchSanityGap({
      patchFiles: ["astropy/conftest.py"],
      // A graph-coincidental symbol match placed conftest.py in the
      // candidate list even though the issue text below never asks for it.
      candidateSites: ["astropy/conftest.py"],
      issueText: "The FITS header parser mis-handles a continuation card.",
    })
    expect(gap).toBe("test-infra-unjustified")
  })

  it("fails open (undefined) when the patch is empty", () => {
    expect(detectPatchSanityGap({ patchFiles: [], candidateSites: ["a.py"], issueText: "x" })).toBeUndefined()
  })

  it("fails open (undefined) when there are zero candidate sites to check against — never a false-fire on missing evidence", () => {
    expect(
      detectPatchSanityGap({ patchFiles: ["astropy/conftest.py"], candidateSites: [], issueText: "x" }),
    ).toBeUndefined()
  })
})

describe("shouldDenyPatchSanity", () => {
  const base = { isChildSession: false, reason: "no-overlap" as const, alreadyDenied: false }

  it("denies once: a reason is present, root session, not yet denied", () => {
    expect(shouldDenyPatchSanity(base)).toBe(true)
  })

  it("never denies when there is no reason (a sane patch)", () => {
    expect(shouldDenyPatchSanity({ ...base, reason: undefined })).toBe(false)
  })

  it("never denies a child session", () => {
    expect(shouldDenyPatchSanity({ ...base, isChildSession: true })).toBe(false)
  })

  it("never denies twice — the bounded floor, second arrival fails open", () => {
    expect(shouldDenyPatchSanity({ ...base, alreadyDenied: true })).toBe(false)
  })
})

describe("patchSanityNudgeText", () => {
  it("no-overlap: names the touched patch files and the candidate sites", () => {
    const text = patchSanityNudgeText("no-overlap", ["astropy/conftest.py"], ["astropy/io/fits/hdu/base.py"])
    expect(text).toContain("astropy/conftest.py")
    expect(text).toContain("astropy/io/fits/hdu/base.py")
    expect(text.toLowerCase()).toContain("wrong-file")
  })

  it("test-infra-unjustified: names the test-infra files and asks for justification", () => {
    const text = patchSanityNudgeText("test-infra-unjustified", ["conftest.py"], [])
    expect(text).toContain("conftest.py")
    expect(text.toLowerCase()).toContain("test-infrastructure")
  })
})

describe("shouldDenyF2pClaim — H1 tooth 3 (gap-closure-plan §2.7)", () => {
  const base = { isChildSession: false, covered: false, alreadyDenied: false }

  it("denies once: not covered, root session, not yet denied", () => {
    expect(shouldDenyF2pClaim(base)).toBe(true)
  })

  it("never denies when the claim is covered (every observed red re-ran green)", () => {
    expect(shouldDenyF2pClaim({ ...base, covered: true })).toBe(false)
  })

  it("never denies a child session", () => {
    expect(shouldDenyF2pClaim({ ...base, isChildSession: true })).toBe(false)
  })

  it("never denies twice — the bounded floor, second arrival fails open", () => {
    expect(shouldDenyF2pClaim({ ...base, alreadyDenied: true })).toBe(false)
  })
})

describe("f2pClaimNudgeText", () => {
  it("names every missing test id", () => {
    const text = f2pClaimNudgeText(["tests/test_bar.py::test_baz", "tests/test_qux.py::test_it"])
    expect(text).toContain("tests/test_bar.py::test_baz")
    expect(text).toContain("tests/test_qux.py::test_it")
    expect(text.toLowerCase()).toContain("re-run")
  })
})
