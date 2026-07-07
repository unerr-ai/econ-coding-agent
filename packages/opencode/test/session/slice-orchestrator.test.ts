/**
 * Tests for the live slice-loop wiring in packages/opencode/src/session/slice-orchestrator.ts
 * (OL-7.3 + OL-2.2 + OL-9.5c). Covers the trajectory-capture seam (child message parts →
 * SliceTrajectory), tier→model resolution, the hasPendingTypedSlices gate (an explicitly-typed
 * pending slice only — no untyped-batch backstop; see the run-8 regression test) and the
 * shouldOrchestrate benefit gate on runConductorSliceLoop/runConductorOrchestration (no real
 * parallelism and under 6 slices → no dispatch, legacy path continues). The pure state machine
 * itself is covered in code-intelligence/test/slice-loop.test.ts.
 */

import { describe, it, expect, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { ECON_PERSONAS } from "@opencode-ai/code-intelligence"
import { Permission } from "../../src/permission"
import {
  extractTrajectory,
  resolveSliceModel,
  runConductorSliceLoop,
  runConductorOrchestration,
  todosToLoopSlices,
  hasPendingTypedSlices,
  shouldOrchestrate,
  autoTypeTodos,
  reconcileSettledSlices,
  LOCALIZATION_SLICE_CONTENT,
  LOCALIZATION_PREPASS_TODO,
  PLANNER_SLICE_CONTENT,
  PLANNER_PREPASS_TODO,
  shouldRunDiagnosisPrepass,
  isFixShapedPrompt,
  promptAuthorizesTestEdits,
  classifyTurnShape,
  categoryPreamble,
  isHardDiagnosisPrompt,
  diagnosisPrepassSeed,
  type TurnShapeCategory,
  extractVerifyCommands,
  TEST_TREE_GUARD_COMMAND,
  childSlicePermission,
  isDeciderSeat,
  personaForSlice,
  PERSONA_STEP_BUDGET,
  sliceStepBudget,
  FRAME_SLICE_STEP_BUDGET,
  countToolCalls,
  budgetExhaustedMarker,
  buildRepoPrimer,
  renderSliceDigestLedger,
  triagePreamble,
  orderTriageGoals,
  buildTriageTodoSkeleton,
  roundUpTriageShapes,
  type ConductorSliceDispatch,
  type SliceProbes,
  type OrchestrationTodo,
  type SlicePermissionRule,
  type SliceDigestEntry,
  type TriageTodoRow,
} from "../../src/session/slice-orchestrator"
import type { TriageGoal, TriageVerdict } from "../../src/session/turn-triage"

/** Probes that never touch a graph — fixed verdicts, with a call counter. */
function fakeProbes(
  coupling: "low" | "high" = "high",
  testStrength: "testable" | "untestable" = "untestable",
): SliceProbes & { couplingCalls: number; testStrengthCalls: number } {
  const state = { couplingCalls: 0, testStrengthCalls: 0 }
  return {
    get couplingCalls() {
      return state.couplingCalls
    },
    get testStrengthCalls() {
      return state.testStrengthCalls
    },
    probeCoupling: async () => {
      state.couplingCalls++
      return { coupling }
    },
    probeTestStrength: async () => {
      state.testStrengthCalls++
      return { testStrength }
    },
  }
}

describe("hasPendingTypedSlices", () => {
  it("false on untyped todos, false when all typed slices are done, true on a pending typed DAG", () => {
    expect(hasPendingTypedSlices([{ content: "x", status: "pending" }])).toBe(false)
    expect(hasPendingTypedSlices([{ content: "x", status: "completed", sliceType: "mechanical" }])).toBe(false)
    expect(hasPendingTypedSlices([{ content: "x", status: "pending", sliceType: "mechanical" }])).toBe(true)
  })

  // Run-8 post-mortem (2026-07-05, OL-9.5c): the old OL-9.3f backstop engaged
  // ANY untyped batch of >=3 pending items on the theory the conductor had
  // simply skipped typing. Every run-8 todo was untyped, so that clause alone
  // — with no benefit gate downstream — spun up 109 child sessions / 868 LLM
  // calls (~8 briefs x ~8 re-dispatches) for one trivial issue. It is deleted:
  // an untyped batch, of any size, no longer engages on its own.
  it("run-8 regression: an untyped batch of >=3 pending items no longer engages", () => {
    expect(
      hasPendingTypedSlices([
        { content: "find the bug", status: "pending" },
        { content: "fix the bug", status: "pending" },
        { content: "test the fix", status: "pending" },
      ]),
    ).toBe(false)
  })

  it("an untyped batch under 3 items never engages, even when all pending", () => {
    expect(
      hasPendingTypedSlices([
        { content: "find the bug", status: "pending" },
        { content: "fix the bug", status: "pending" },
      ]),
    ).toBe(false)
  })

  it("a partially-typed batch with its one typed item already settled follows the normal typed+pending rule", () => {
    expect(
      hasPendingTypedSlices([
        { content: "a", status: "completed", sliceType: "mechanical" },
        { content: "b", status: "pending" },
        { content: "c", status: "pending" },
      ]),
    ).toBe(false)
  })
})

describe("autoTypeTodos — structural typing nets (judgment, diagnosis pre-pass, plan-first build)", () => {
  // Run 20 T3's actual todo list — the audit turn whose inline verdict missed
  // a live silent-drop path. Judgment items must type verify+need:reasoner,
  // the pure suite-run must type verify, and the result must clear both the
  // engagement predicate and the benefit gate.
  const auditTurn: OrchestrationTodo[] = [
    { content: "Run full test suite from monorepo root", status: "pending" },
    {
      content: "Audit edge cases: both-refinements, superRefine, chained merge, merge after extend, catchall interaction, error messaging",
      status: "pending",
    },
    { content: "Verify deprecation posture coherence", status: "pending" },
    { content: "State verdict: soundness, completeness, residual risk", status: "pending" },
  ]

  it("types run-20's audit turn: judgment items get verify+need:reasoner, suite-run gets verify", () => {
    const typed = autoTypeTodos(auditTurn)
    expect(typed[0]).toMatchObject({ sliceType: "verify" })
    expect(typed[0]!.need).toBeUndefined()
    for (const i of [1, 2, 3]) expect(typed[i]).toMatchObject({ sliceType: "verify", need: "reasoner" })
    expect(hasPendingTypedSlices(typed)).toBe(true)
  })

  it("a build turn is never judgment-typed — run-20 T2 takes the plan-first net instead (F3)", () => {
    const buildTurn: OrchestrationTodo[] = [
      { content: "Study extend/safeExtend/pick/omit/partial refinement handling", status: "pending" },
      { content: "Implement fix in core/util.ts merge()", status: "pending" },
      { content: "Add regression tests in object.test.ts", status: "pending" },
      { content: "Verify existing object and intersection test suites are green", status: "pending" },
    ]
    const typed = autoTypeTodos(buildTurn)
    // the ambiguous recon-prose item stays with the conductor
    expect(typed[0]!.sliceType).toBeUndefined()
    // decided changes type mechanical — and never carry need (allocation matrix owns tier)
    expect(typed[1]).toMatchObject({ sliceType: "mechanical" })
    expect(typed[2]).toMatchObject({ sliceType: "mechanical" })
    for (const i of [1, 2, 3]) expect(typed[i]!.need).toBeUndefined()
    // disjoint file targets → parallel-eligible, no manufactured chain
    expect(typed[1]!.deps).toBeUndefined()
    expect(typed[2]!.deps).toBeUndefined()
    // the check-run serializes after BOTH mechanical items: the net's deps
    // bypass the stage backstop, so it imposes verify-after-build itself
    expect(typed[3]).toMatchObject({ sliceType: "verify" })
    expect(typed[3]!.deps).toEqual([buildTurn[1]!.content, buildTurn[2]!.content])
    expect(hasPendingTypedSlices(typed)).toBe(true)
  })

  it("a list the conductor typed itself is never touched", () => {
    const typedByModel: OrchestrationTodo[] = [
      { content: "State verdict: soundness", status: "pending" },
      { content: "recon the callers", status: "pending", sliceType: "recon" },
    ]
    expect(autoTypeTodos(typedByModel)).toEqual(typedByModel)
  })

  it("non-pending items are never retyped; settled mechanical items do not block typing", () => {
    const items: OrchestrationTodo[] = [
      { content: "Implement fix in util.ts", status: "completed" },
      { content: "State verdict: soundness, residual risk", status: "pending" },
    ]
    const typed = autoTypeTodos(items)
    expect(typed[0]!.sliceType).toBeUndefined()
    expect(typed[1]).toMatchObject({ sliceType: "verify", need: "reasoner" })
  })

  it("run-21 regression: noun 'fix' in a judgment item must not read as a build turn", () => {
    // The literal run-21 T3 list — "Does fix keep migration coherent?" matched
    // the old anywhere-in-text mechanical guard and suppressed all typing.
    const t3: OrchestrationTodo[] = [
      { content: "Run full monorepo test suite from root", status: "pending" },
      { content: "Edge cases: chained merges, merge-after-extend, catchall interaction, error messaging", status: "pending" },
      { content: "Deprecation posture: is merge deprecated? Does fix keep migration coherent?", status: "pending" },
      { content: "Final verdict: soundness, completeness, residual risk", status: "pending" },
    ]
    const typed = autoTypeTodos(t3)
    expect(typed[0]).toMatchObject({ sliceType: "verify" })
    for (const i of [1, 2, 3]) expect(typed[i]).toMatchObject({ sliceType: "verify", need: "reasoner" })
    expect(hasPendingTypedSlices(typed)).toBe(true)
  })

  it("an imperative mechanical item ('Add edge case tests') still reads as a build turn", () => {
    const list: OrchestrationTodo[] = [
      { content: "Add edge case tests for merge refinements", status: "pending" },
      { content: "State verdict: soundness", status: "pending" },
    ]
    expect(autoTypeTodos(list)).toEqual(list)
  })

  it("a plain conversational list stays untyped and inert", () => {
    const plain: OrchestrationTodo[] = [
      { content: "answer the user's question about the release date", status: "pending" },
      { content: "summarize the changelog", status: "pending" },
    ]
    const typed = autoTypeTodos(plain)
    expect(typed).toEqual(plain)
    expect(hasPendingTypedSlices(typed)).toBe(false)
  })

  // Diagnosis pre-pass (SWE-bench django-11964/11885 decode): a bug-shaped
  // build turn with no named file target gets ONE localization slice appended
  // — design allocation (oracle tier) + researcher persona (read+fetch only).
  // The hook that dispatches it is root-only; non-root concerns are out of
  // scope here.
  describe("diagnosis pre-pass — front-loaded localization on bug-shaped build turns", () => {
    const bugTurn: OrchestrationTodo[] = [
      { content: "Fix the enum display bug so str() returns the raw value", status: "pending" },
      { content: "Verify the model field returns 'M'", status: "pending" },
    ]

    it("bug-shaped turn with no file target: localization slice appended, originals byte-identical in place", () => {
      const typed = autoTypeTodos(bugTurn)
      expect(typed).toHaveLength(3)
      // Append-only: the original items are the SAME objects, same positions.
      expect(typed[0]).toBe(bugTurn[0]!)
      expect(typed[1]).toBe(bugTurn[1]!)
      expect(typed[2]).toEqual({
        content: LOCALIZATION_SLICE_CONTENT,
        status: "pending",
        priority: "high",
        sliceType: "design",
        need: "reasoner",
        persona: "researcher",
      })
      expect(hasPendingTypedSlices(typed)).toBe(true)
    })

    it("bug-shaped turn where an item already names a file path stays untouched — localization already done", () => {
      const localized: OrchestrationTodo[] = [
        { content: "Fix the enum display bug in django/db/models/enums.py", status: "pending" },
        { content: "Verify the model field returns 'M'", status: "pending" },
      ]
      expect(autoTypeTodos(localized)).toEqual(localized)
    })

    it("a bare code filename also counts as a file target", () => {
      const localized: OrchestrationTodo[] = [
        { content: "Fix the enum display bug", status: "pending" },
        { content: "Update enums.py so str() returns the raw value", status: "pending" },
      ]
      expect(autoTypeTodos(localized)).toEqual(localized)
    })

    it("a build list without repair verbs never triggers — run-20 T2 verbs are not diagnosis-shaped", () => {
      const buildTurn: OrchestrationTodo[] = [
        { content: "Implement the new formatter", status: "pending" },
        { content: "Add regression tests", status: "pending" },
        { content: "Run the suite", status: "pending" },
      ]
      expect(autoTypeTodos(buildTurn)).toEqual(buildTurn)
    })

    it("an already-typed bug-shaped list is never injected into", () => {
      const typedByModel: OrchestrationTodo[] = [
        { content: "Fix the enum display bug", status: "pending", sliceType: "mechanical" },
        { content: "Verify the model field returns 'M'", status: "pending" },
      ]
      expect(autoTypeTodos(typedByModel)).toEqual(typedByModel)
    })

    it("idempotent: the injected typed slice trips the typed-list guard on a second pass", () => {
      const once = autoTypeTodos(bugTurn)
      expect(autoTypeTodos(once)).toEqual(once)
    })

    it("completed/cancelled diagnosis items do not trigger injection", () => {
      const settled: OrchestrationTodo[] = [
        { content: "Fix the crash on startup", status: "completed" },
        { content: "Debug the enum fallback", status: "cancelled" },
        { content: "Update the changelog entry", status: "pending" },
      ]
      expect(autoTypeTodos(settled)).toEqual(settled)
    })
  })

  // Plan-first build net (F3/B8, case-5 decode): the conductor self-typed
  // zero items across 20+ observed runs, so build lists never dispatched. A
  // fresh plan (>=3 items, nothing run yet) with >=2 decided changes
  // (build-imperative opener + concrete file target) now types structurally.
  describe("plan-first build net — structural typing of fresh build plans", () => {
    const deppedPlan: OrchestrationTodo[] = [
      { content: "Create the tier registry in src/tiers/registry.ts", status: "pending" },
      { content: "Update src/tiers/registry.ts to export the binding table", status: "pending" },
      { content: "Then wire the binding table into src/session/allocate.ts", status: "pending" },
      { content: "Add the allocator note to docs/design/allocation.md", status: "pending" },
    ]

    it("B8: a first item claimed in_progress in the same todowrite call still counts and still types", () => {
      const claimed: OrchestrationTodo[] = [
        { content: "Implement the tier gate in src/session/gate.ts", status: "in_progress" },
        { content: "Wire the gate into src/session/loop.ts", status: "pending" },
        { content: "Run the session test suite and confirm it is green", status: "pending" },
      ]
      const typed = autoTypeTodos(claimed)
      // typed but status untouched — mirroring stays with the loop machinery
      expect(typed[0]).toMatchObject({ sliceType: "mechanical", status: "in_progress" })
      expect(typed[1]).toMatchObject({ sliceType: "mechanical", status: "pending" })
      expect(typed[2]).toMatchObject({ sliceType: "verify" })
      expect(typed[2]!.deps).toEqual([claimed[0]!.content, claimed[1]!.content])
      // engagement rides the still-pending typed items, not the claimed one
      expect(hasPendingTypedSlices(typed)).toBe(true)
    })

    it("a non-first in_progress item means work is genuinely underway — the net stands down", () => {
      const midFlight: OrchestrationTodo[] = [
        { content: "Implement the tier gate in src/session/gate.ts", status: "pending" },
        { content: "Wire the gate into src/session/loop.ts", status: "in_progress" },
        { content: "Run the session test suite and confirm it is green", status: "pending" },
      ]
      expect(autoTypeTodos(midFlight)).toEqual(midFlight)
    })

    it("a list with a settled item is a retro-log, not a plan — untouched", () => {
      const retroLog: OrchestrationTodo[] = [
        { content: "Implement the tier gate in src/session/gate.ts", status: "completed" },
        { content: "Wire the gate into src/session/loop.ts", status: "pending" },
        { content: "Update the gate docs in src/session/gate.ts", status: "pending" },
      ]
      expect(autoTypeTodos(retroLog)).toEqual(retroLog)
    })

    it("a plan the conductor typed itself is never touched — self-typing wins", () => {
      const selfTyped: OrchestrationTodo[] = [
        { content: "Implement the tier gate in src/session/gate.ts", status: "pending", sliceType: "mechanical" },
        { content: "Wire the gate into src/session/loop.ts", status: "pending" },
        { content: "Run the session test suite and confirm it is green", status: "pending" },
      ]
      expect(autoTypeTodos(selfTyped)).toEqual(selfTyped)
    })

    it("a 2-item list never types — below the plan threshold", () => {
      const pair: OrchestrationTodo[] = [
        { content: "Implement the tier gate in src/session/gate.ts", status: "pending" },
        { content: "Wire the gate into src/session/loop.ts", status: "pending" },
      ]
      expect(autoTypeTodos(pair)).toEqual(pair)
    })

    it("one decided change is not a plan — imperative verbs without file targets do not count", () => {
      const vague: OrchestrationTodo[] = [
        { content: "Implement the tier gate in src/session/gate.ts", status: "pending" },
        { content: "Add the loop wiring", status: "pending" },
        { content: "Create the follow-up ticket", status: "pending" },
      ]
      expect(autoTypeTodos(vague)).toEqual(vague)
    })

    it("a prose/Q&A list stays untyped regardless of size", () => {
      const qa: OrchestrationTodo[] = [
        { content: "Answer the user's question about the release cadence", status: "pending" },
        { content: "Summarize the changelog since the last tag", status: "pending" },
        { content: "Explain how the tier ladder chooses an escalation", status: "pending" },
      ]
      const typed = autoTypeTodos(qa)
      expect(typed).toEqual(qa)
      expect(hasPendingTypedSlices(typed)).toBe(false)
    })

    it("an audit-shaped list still takes the judgment path — verify+need:reasoner, never the build net", () => {
      const audit: OrchestrationTodo[] = [
        { content: "Run the full suite from the monorepo root", status: "pending" },
        { content: "Audit edge cases across the merge paths", status: "pending" },
        { content: "State verdict: soundness and residual risk", status: "pending" },
      ]
      const typed = autoTypeTodos(audit)
      expect(typed[0]).toMatchObject({ sliceType: "verify" })
      expect(typed[0]!.need).toBeUndefined()
      for (const i of [1, 2]) expect(typed[i]).toMatchObject({ sliceType: "verify", need: "reasoner" })
    })

    it("dep inference: shared file targets serialize same-file edits, an ordering cue serializes after the predecessor, disjoint targets stay parallel-eligible", () => {
      const typed = autoTypeTodos(deppedPlan)
      for (const i of [0, 1, 2, 3]) expect(typed[i]).toMatchObject({ sliceType: "mechanical" })
      expect(typed[0]!.deps).toBeUndefined() // first edit — nothing earlier
      expect(typed[1]!.deps).toEqual([deppedPlan[0]!.content]) // same file as item 1 → serialize
      expect(typed[2]!.deps).toEqual([deppedPlan[1]!.content]) // "Then …" → after its predecessor
      expect(typed[3]!.deps).toBeUndefined() // disjoint target, no cue → parallel
    })

    it("idempotent: a typed plan trips the typed-list guard on the next todowrite", () => {
      const once = autoTypeTodos(deppedPlan)
      expect(autoTypeTodos(once)).toEqual(once)
    })
  })
})

describe("shouldOrchestrate — the OL-9.5c benefit gate", () => {
  it("an explicitly-typed linear chain (every wave width 1) does not qualify", () => {
    const slices = [
      { id: "recon it", prompt: "" },
      { id: "fix it", prompt: "", deps: ["recon it"] },
      { id: "verify it", prompt: "", deps: ["fix it"] },
    ]
    expect(shouldOrchestrate(slices)).toBe(false)
  })

  it("a wave of >=2 independent slices qualifies", () => {
    const slices = [
      { id: "a", prompt: "" },
      { id: "b", prompt: "" },
    ]
    expect(shouldOrchestrate(slices)).toBe(true)
  })

  it("a batch of >=6 slices qualifies on scale alone, even serialized into width-1 waves", () => {
    const slices = Array.from({ length: 6 }, (_, i) => ({
      id: `step ${i}`,
      prompt: "",
      deps: i > 0 ? [`step ${i - 1}`] : undefined,
    }))
    expect(shouldOrchestrate(slices)).toBe(true)
  })

  it("under 6 slices with no wave of width >=2 does not qualify", () => {
    const slices = Array.from({ length: 5 }, (_, i) => ({
      id: `step ${i}`,
      prompt: "",
      deps: i > 0 ? [`step ${i - 1}`] : undefined,
    }))
    expect(shouldOrchestrate(slices)).toBe(false)
  })

  it("run-21: a lone judgment slice with need reasoner/oracle qualifies by itself", () => {
    expect(shouldOrchestrate([{ id: "final verdict", prompt: "", need: "reasoner" }])).toBe(true)
    expect(shouldOrchestrate([{ id: "final verdict", prompt: "", need: "oracle" }])).toBe(true)
    // an executor-need width-1 chain still gains nothing — stays declined
    expect(shouldOrchestrate([{ id: "run suite", prompt: "", need: "executor" }])).toBe(false)
  })

  // U2 — §4.5 goals-as-parallel-instances: a compound turn's goal count is an
  // independent width signal, on top of the pre-existing slice-shape checks.
  it("a goalCount of >=2 qualifies even a width-1 chain", () => {
    const slices = [
      { id: "recon it", prompt: "" },
      { id: "fix it", prompt: "", deps: ["recon it"] },
    ]
    expect(shouldOrchestrate(slices)).toBe(false)
    expect(shouldOrchestrate(slices, 2)).toBe(true)
  })

  it("a goalCount of 0 or 1 (or absent) never qualifies on its own", () => {
    const slices = [{ id: "solo step", prompt: "" }]
    expect(shouldOrchestrate(slices)).toBe(false)
    expect(shouldOrchestrate(slices, 0)).toBe(false)
    expect(shouldOrchestrate(slices, 1)).toBe(false)
    expect(shouldOrchestrate(slices, undefined)).toBe(false)
  })
})

describe("triagePreamble — U1/§1.1/§4.1 turn-scoped preamble", () => {
  it("lists every goal with its shape/deliverable and every constraint", () => {
    const verdict: TriageVerdict = {
      goals: [
        { quote: "fix the login bug", shape: "diagnosis-grounded", deliverable: "login succeeds" },
        { quote: "add a retry", shape: "build", deliverable: "retry wraps the call", needsPlan: true },
      ],
      constraints: [{ quote: "don't touch the tests", kind: "no-test-edit" }],
      confidence: "high",
    }
    const preamble = triagePreamble(verdict)
    expect(preamble).toContain("2 goals extracted, confidence=high")
    expect(preamble).toContain('"fix the login bug" — done when: login succeeds')
    expect(preamble).toContain("[build, needs-plan]")
    expect(preamble).toContain('CONSTRAINT (no-test-edit): "don\'t touch the tests"')
  })

  it("singular goal wording and a missing deliverable fall back to a generic done-when", () => {
    const verdict: TriageVerdict = {
      goals: [{ quote: "explain the flow", shape: "qa", deliverable: "" }],
      constraints: [],
      confidence: "low",
    }
    const preamble = triagePreamble(verdict)
    expect(preamble).toContain("1 goal extracted, confidence=low")
    expect(preamble).toContain("done when: the goal is satisfied")
    expect(preamble).not.toContain("CONSTRAINT")
  })
})

describe("orderTriageGoals — §1.2 dependency-ordered write sequence", () => {
  it("stable prompt order when no goal declares a dependency", () => {
    const goals: TriageGoal[] = [
      { quote: "a", shape: "build", deliverable: "" },
      { quote: "b", shape: "build", deliverable: "" },
      { quote: "c", shape: "build", deliverable: "" },
    ]
    expect(orderTriageGoals(goals)).toEqual([0, 1, 2])
  })

  it("a dependsOn reference is written before its dependent", () => {
    const goals: TriageGoal[] = [
      { quote: "second", shape: "build", deliverable: "", dependsOn: [1] },
      { quote: "first", shape: "build", deliverable: "" },
    ]
    expect(orderTriageGoals(goals)).toEqual([1, 0])
  })

  it("an out-of-range or self dependency is ignored, not fatal", () => {
    const goals: TriageGoal[] = [
      { quote: "a", shape: "build", deliverable: "", dependsOn: [0, 99] },
      { quote: "b", shape: "build", deliverable: "" },
    ]
    expect(orderTriageGoals(goals)).toEqual([0, 1])
  })

  it("a hallucinated cycle drains the remainder in prompt order instead of hanging", () => {
    const goals: TriageGoal[] = [
      { quote: "a", shape: "build", deliverable: "", dependsOn: [1] },
      { quote: "b", shape: "build", deliverable: "", dependsOn: [0] },
    ]
    expect(orderTriageGoals(goals)).toEqual([0, 1])
  })
})

describe("buildTriageTodoSkeleton — U2 turn-open goal-tree materialization", () => {
  it("one root todo per goal, dependency-ordered, no frame seed when none is needed", () => {
    const verdict: TriageVerdict = {
      goals: [
        { quote: "add feature X", shape: "build", deliverable: "X works" },
        { quote: "add feature Y", shape: "build", deliverable: "Y works" },
      ],
      constraints: [],
      confidence: "high",
    }
    const todos = buildTriageTodoSkeleton(verdict)
    expect(todos).toHaveLength(2)
    expect(todos.map((t) => t.content)).toEqual(["add feature X", "add feature Y"])
    expect(todos.every((t) => t.parentID === undefined)).toBe(true)
  })

  it("a needsPlan goal gets exactly one frame-seed child linked by parentID", () => {
    const verdict: TriageVerdict = {
      goals: [{ quote: "diagnose the flaky test", shape: "build", deliverable: "root cause found", needsPlan: true }],
      constraints: [],
      confidence: "high",
    }
    const todos: TriageTodoRow[] = buildTriageTodoSkeleton(verdict)
    expect(todos).toHaveLength(2)
    expect(todos[0]!.content).toBe("diagnose the flaky test")
    expect(todos[1]!.parentID).toBe(0)
    expect(todos[1]!.content).toBe(diagnosisPrepassSeed("diagnose the flaky test").content)
  })

  it("a diagnosis-vague shaped goal also gets a frame seed, even without needsPlan", () => {
    const verdict: TriageVerdict = {
      goals: [{ quote: "something is slow sometimes", shape: "diagnosis-vague", deliverable: "cause identified" }],
      constraints: [],
      confidence: "high",
    }
    const todos = buildTriageTodoSkeleton(verdict)
    expect(todos).toHaveLength(2)
    expect(todos[1]!.parentID).toBe(0)
  })

  it("dependency order is respected: the parent index tracks the WRITE position, not the original index", () => {
    const verdict: TriageVerdict = {
      goals: [
        { quote: "second, depends on first", shape: "build", deliverable: "", dependsOn: [1] },
        { quote: "first, needs a plan", shape: "build", deliverable: "", needsPlan: true },
      ],
      constraints: [],
      confidence: "high",
    }
    const todos = buildTriageTodoSkeleton(verdict)
    // write order: "first, needs a plan" (position 0), "second, depends on first" (position 1)
    expect(todos[0]!.content).toBe("first, needs a plan")
    expect(todos[1]!.content).toBe("second, depends on first")
    // the frame seed for "first, needs a plan" must point at ITS write position (0), not its original index (1).
    expect(todos[2]!.parentID).toBe(0)
  })

  it("at most one frame seed per goal — the check is per-goal, never duplicated", () => {
    const verdict: TriageVerdict = {
      goals: [
        { quote: "goal one, needs plan", shape: "build", deliverable: "", needsPlan: true },
        { quote: "goal two, needs plan", shape: "build", deliverable: "", needsPlan: true },
      ],
      constraints: [],
      confidence: "high",
    }
    const todos = buildTriageTodoSkeleton(verdict)
    expect(todos).toHaveLength(4) // 2 root goals + 2 frame seeds, one each
    expect(todos.filter((t) => t.parentID === 0)).toHaveLength(1)
    expect(todos.filter((t) => t.parentID === 1)).toHaveLength(1)
  })
})

describe("roundUpTriageShapes — grounded-without-file-target rounds up (case-1 net)", () => {
  const grounded = (quote: string): TriageVerdict => ({
    goals: [{ quote, shape: "diagnosis-grounded", deliverable: "bug fixed" }],
    constraints: [],
    confidence: "high",
  })

  it("an entity-name-only symptom prompt rounds diagnosis-grounded up to diagnosis-vague", () => {
    const prompt =
      "TextChoices/IntegerChoices value returned by the getter is the enum member, not the raw value — fix it. Don't touch any tests."
    const verdict = grounded("TextChoices value returned by the getter is the enum member")
    const rounded = roundUpTriageShapes(verdict, prompt)
    expect(rounded).not.toBe(verdict)
    expect(rounded.goals[0]!.shape).toBe("diagnosis-vague")
    // and the rounded verdict now re-arms the skeleton's frame seed
    const todos = buildTriageTodoSkeleton(rounded)
    expect(todos).toHaveLength(2)
    expect(todos[1]!.parentID).toBe(0)
  })

  it("a prompt naming a concrete code file stays grounded (identity return)", () => {
    const prompt = "the getter in django/db/models/enums.py returns the member — fix it"
    const verdict = grounded("the getter in enums.py returns the member")
    expect(roundUpTriageShapes(verdict, prompt)).toBe(verdict)
  })

  it("non-diagnosis shapes are untouched and the verdict returns by identity", () => {
    const verdict: TriageVerdict = {
      goals: [
        { quote: "add feature X", shape: "build", deliverable: "X works" },
        { quote: "is the fix sound?", shape: "audit", deliverable: "verdict" },
      ],
      constraints: [],
      confidence: "high",
    }
    expect(roundUpTriageShapes(verdict, "add feature X and audit the fix")).toBe(verdict)
  })

  it("only the grounded goal flips in a mixed verdict; others are preserved verbatim", () => {
    const verdict: TriageVerdict = {
      goals: [
        { quote: "the parser drops trailing commas", shape: "diagnosis-grounded", deliverable: "fixed" },
        { quote: "add a regression test", shape: "build", deliverable: "test added", needsPlan: false },
      ],
      constraints: [{ quote: "don't touch any tests", kind: "no-test-edit" }],
      confidence: "high",
    }
    const rounded = roundUpTriageShapes(verdict, "the parser drops trailing commas; add a regression test")
    expect(rounded.goals[0]!.shape).toBe("diagnosis-vague")
    expect(rounded.goals[1]).toEqual(verdict.goals[1])
    expect(rounded.constraints).toBe(verdict.constraints)
  })
})

describe("autoTypeTodos — bracket-tagged audit lists (case-2 tierfire3 decode)", () => {
  const pending = (content: string): OrchestrationTodo => ({ content, status: "pending" })

  it("a tagged pure check-run types plain verify (runner) — the tag alone is not judgment", () => {
    const todos = [
      pending("[audit] Soundness — is preserving refinements on merge semantically correct for both operands?"),
      pending("[audit] Edge cases — enumerate and assess the edge cases this change must survive"),
      pending("[audit] Test suite — run relevant tests and report what they do and don't prove"),
      pending("[audit] API/deprecation posture — is this the right contract versus documented behavior?"),
      pending("[verdict] SHIP or DO NOT SHIP with reasons"),
    ]
    const typed = autoTypeTodos(todos)
    expect(typed[0]).toMatchObject({ sliceType: "verify", need: "reasoner" })
    expect(typed[1]).toMatchObject({ sliceType: "verify", need: "reasoner" })
    expect(typed[2]).toMatchObject({ sliceType: "verify" })
    expect((typed[2] as { need?: string }).need).toBeUndefined()
    expect(typed[3]).toMatchObject({ sliceType: "verify", need: "reasoner" })
    // the tag IS the judgment signal when the body carries no keyword
    expect(typed[4]).toMatchObject({ sliceType: "verify", need: "reasoner" })
  })

  it("a tag-hidden mechanical opener stays untyped — never judgment-typed read-only", () => {
    const todos = [
      pending("[audit] Soundness — audit the merge change for both operands"),
      pending("[audit] Fix the asymmetry the audit found in the merge path"),
      pending("[verdict] SHIP or DO NOT SHIP with reasons"),
    ]
    const typed = autoTypeTodos(todos)
    expect((typed[1] as { sliceType?: string }).sliceType).toBeUndefined()
    expect(typed[0]).toMatchObject({ sliceType: "verify", need: "reasoner" })
    expect(typed[2]).toMatchObject({ sliceType: "verify", need: "reasoner" })
  })

  it("the verdict item is dep-gated on every other typed sibling — never a blind wave-1 launch", () => {
    const todos = [
      pending("(1) soundness — is the change semantically correct for a merge of two schemas?"),
      pending("(2) edge cases — enumerate the edge cases this change must survive and assess each"),
      pending("(3) test suite — run the relevant test suite and report what it does and does not prove"),
      pending("FINAL VERDICT — SHIP or DO NOT SHIP, with reasons"),
    ]
    const typed = autoTypeTodos(todos)
    const verdict = typed[3] as { sliceType?: string; need?: string; deps?: string[] }
    expect(verdict).toMatchObject({ sliceType: "verify", need: "reasoner" })
    expect(verdict.deps).toEqual([todos[0]!.content, todos[1]!.content, todos[2]!.content])
    // dimensions themselves stay dep-less (parallel wave 1)
    expect((typed[0] as { deps?: string[] }).deps).toBeUndefined()
    expect((typed[2] as { deps?: string[] }).deps).toBeUndefined()
  })

  it("an in_progress judgment claim is typed and dispatched anyway; an in_progress check-run is not", () => {
    const todos: OrchestrationTodo[] = [
      { content: "(1) soundness — is the change semantically correct in general?", status: "in_progress" },
      pending("(2) edge cases — enumerate and assess the edge cases"),
      { content: "(3) test suite — run the relevant tests and report", status: "in_progress" },
      pending("FINAL VERDICT — SHIP or DO NOT SHIP, with reasons"),
    ]
    const typed = autoTypeTodos(todos)
    expect(typed[0]).toMatchObject({ sliceType: "verify", need: "reasoner" })
    expect((typed[2] as { sliceType?: string }).sliceType).toBeUndefined()
    // the verdict's deps include the claimed-but-typed soundness item, not the inline check-run
    expect((typed[3] as { deps?: string[] }).deps).toEqual([todos[0]!.content, todos[1]!.content])
  })

  it("untagged judgment items are classified exactly as before the tag rule", () => {
    const todos = [
      pending("Audit the soundness of the planted merge fix"),
      pending("Run the full test suite and confirm it passes"),
      pending("Final verdict: is the fix sound?"),
    ]
    const typed = autoTypeTodos(todos)
    expect(typed[0]).toMatchObject({ sliceType: "verify", need: "reasoner" })
    expect(typed[1]).toMatchObject({ sliceType: "verify" })
    expect((typed[1] as { need?: string }).need).toBeUndefined()
    expect(typed[2]).toMatchObject({ sliceType: "verify", need: "reasoner" })
  })
})

describe("autoTypeTodos — venue-inline skip (§4.2 rule 4, U2, conservative v1)", () => {
  it("a batch of exactly 2 pure check-run items types and then discards typing (no need pin)", () => {
    const todos: OrchestrationTodo[] = [
      { content: "Run the tests", status: "pending" },
      { content: "Check the build", status: "pending" },
    ]
    // The same two contents, as the leading pair of a 3+ item batch (below), DO type to "verify" —
    // confirming this pair discards typing via the venue-inline rule, not because neither ever matches.
    const result = autoTypeTodos(todos)
    // untyped for inline execution — byte-identical to the input, no sliceType added
    expect(result).toEqual(todos)
  })

  it("a batch of 3+ pure check-run items still types — above the venue-inline ceiling", () => {
    const todos: OrchestrationTodo[] = [
      { content: "Run the tests", status: "pending" },
      { content: "Check the build", status: "pending" },
      { content: "Verify the suite is green", status: "pending" },
    ]
    const result = autoTypeTodos(todos)
    expect(result.every((t) => t.sliceType === "verify")).toBe(true)
  })

  it("a need-pinned item in a small batch is never discarded (judgment keeps its verdict slice)", () => {
    const todos: OrchestrationTodo[] = [{ content: "Assess the fix's soundness", status: "pending" }]
    const result = autoTypeTodos(todos)
    expect(result[0]).toMatchObject({ sliceType: "verify", need: "reasoner" })
  })
})

describe("todosToLoopSlices — conversion", () => {
  it("skips untyped todos, fills coupling/testStrength from probes, carries need + resolved deps", async () => {
    const probes = fakeProbes("high", "testable")
    const todos: OrchestrationTodo[] = [
      { content: "design the API", status: "pending", sliceType: "design", need: "oracle" },
      { content: "apply it", status: "pending", sliceType: "mechanical", deps: ["design the API", "ghost"] },
      { content: "just a note", status: "pending" },
    ]
    const slices = await todosToLoopSlices(todos, probes)
    expect(slices).toHaveLength(2)
    expect(slices[0]).toMatchObject({ id: "design the API", need: "oracle", coupling: "high", testStrength: "testable" })
    // deps resolve to known ids; the unknown "ghost" ref is dropped so planWaves never throws.
    expect(slices[1].deps).toEqual(["design the API"])
    expect(probes.couplingCalls).toBe(2)
  })

  it("prefers an already-tagged coupling/testStrength and does not re-probe it", async () => {
    const probes = fakeProbes()
    const slices = await todosToLoopSlices(
      [{ content: "a", status: "pending", sliceType: "mechanical", coupling: "low", testStrength: "testable" }],
      probes,
    )
    expect(slices[0]).toMatchObject({ coupling: "low", testStrength: "testable" })
    expect(probes.couplingCalls).toBe(0)
    expect(probes.testStrengthCalls).toBe(0)
  })

  // Settled-slice memory (OL-9.5c): a re-engagement must not re-dispatch a
  // slice that already reached a terminal status on an earlier engagement.
  it("excludes completed/failed/cancelled typed todos, converting only the still-pending one", async () => {
    const probes = fakeProbes()
    const todos: OrchestrationTodo[] = [
      { content: "already shipped", status: "completed", sliceType: "mechanical" },
      { content: "also shipped", status: "completed", sliceType: "mechanical" },
      { content: "gave up on this one", status: "failed", sliceType: "mechanical" },
      { content: "abandoned", status: "cancelled", sliceType: "mechanical" },
      { content: "still to do", status: "pending", sliceType: "mechanical" },
    ]
    const slices = await todosToLoopSlices(todos, probes)
    expect(slices).toHaveLength(1)
    expect(slices[0].id).toBe("still to do")
  })
})

describe("shouldRunDiagnosisPrepass (F1 — turn-open trigger)", () => {
  it("fires on a symptom-only bug prompt (defect evidence, no file target)", () => {
    expect(
      shouldRunDiagnosisPrepass(
        "The app shows Suit.HEART instead of Hearts when rendering the enum — str() on members returns the wrong value. Please fix it.",
      ),
    ).toBe(true)
  })

  it("stays quiet when the prompt names a concrete file (Type-B grounded — conductor goes direct)", () => {
    expect(shouldRunDiagnosisPrepass("fix the off-by-one suffix handling in Columns.col_str in ddl_references.py")).toBe(
      false,
    )
  })

  it("stays quiet on build/spec prompts — 'should return X' spec language is not defect evidence", () => {
    expect(
      shouldRunDiagnosisPrepass(
        "Implement a dependency-free helper exporting statusPhrase(code); unknown codes should return Unknown Status",
      ),
    ).toBe(false)
  })

  it("stays quiet on plain Q&A and empty prompts", () => {
    expect(shouldRunDiagnosisPrepass("summarize how the routing layer decides which tier runs a slice")).toBe(false)
    expect(shouldRunDiagnosisPrepass("")).toBe(false)
  })

  it("the seed constant is the same slice autoTypeTodos injects (one home for the shape)", () => {
    expect(LOCALIZATION_PREPASS_TODO).toMatchObject({
      content: LOCALIZATION_SLICE_CONTENT,
      status: "pending",
      priority: "high",
      sliceType: "design",
      persona: "researcher",
    })
  })
})

describe("isFixShapedPrompt / promptAuthorizesTestEdits (B3 — no-test-edit gate arming)", () => {
  it("fix-shaped fires on defect evidence, WITH or without a file target (broader than the pre-pass)", () => {
    expect(isFixShapedPrompt("the login page crashes when the session expires")).toBe(true)
    expect(isFixShapedPrompt("fix the off-by-one in django/utils/timesince.py")).toBe(true)
    expect(shouldRunDiagnosisPrepass("fix the off-by-one in django/utils/timesince.py")).toBe(false)
  })

  it("fix-shaped stays quiet on build and Q&A prompts", () => {
    expect(isFixShapedPrompt("add a --json flag to the export command")).toBe(false)
    expect(isFixShapedPrompt("how does the session compaction ladder work?")).toBe(false)
    expect(isFixShapedPrompt("")).toBe(false)
  })

  it("authorization: tests as the verb's object disarms; tests as acceptance criteria does not", () => {
    expect(promptAuthorizesTestEdits("update the tests to cover the new flag")).toBe(true)
    expect(promptAuthorizesTestEdits("fix the flaky test in the pool suite")).toBe(true)
    expect(promptAuthorizesTestEdits("update tests/test_utils.py for the new format")).toBe(true)
    expect(promptAuthorizesTestEdits("fix the bug so the tests pass")).toBe(false)
    expect(promptAuthorizesTestEdits("fix the divmod bug; make sure the tests stay green")).toBe(false)
  })

  it("negated phrasing is prohibition, not authorization — the caseA live-fire bug", () => {
    expect(promptAuthorizesTestEdits("Fix the enum bug. Do not modify any test files.")).toBe(false)
    expect(promptAuthorizesTestEdits("fix the crash but never update the tests")).toBe(false)
    expect(promptAuthorizesTestEdits("resolve it without adjusting the tests")).toBe(false)
    // A real authorization elsewhere in the prompt still wins.
    expect(promptAuthorizesTestEdits("Do not modify old test files. DO update tests/test_new.py for the new shape.")).toBe(
      true,
    )
  })

  it("a test path quoted in failure output never authorizes (evidence is not authorization)", () => {
    expect(
      promptAuthorizesTestEdits(
        "the suite reports FAILED tests/test_utils.py::test_divmod — expected (0, 1) but got (1, 0)",
      ),
    ).toBe(false)
  })
})

describe("classifyTurnShape (§8 — evidence-shape casting decision)", () => {
  it("diagnosis-vague: defect evidence, no file target", () => {
    expect(
      classifyTurnShape(
        "The app shows Suit.HEART instead of Hearts when rendering the enum — str() on members returns the wrong value. Please fix it.",
      ),
    ).toEqual({ category: "diagnosis-vague", confidence: "high" })
  })

  it("diagnosis-grounded: defect evidence plus a named file", () => {
    expect(classifyTurnShape("fix the off-by-one suffix handling in Columns.col_str in ddl_references.py")).toEqual({
      category: "diagnosis-grounded",
      confidence: "high",
    })
  })

  it("build: an imperative opener with no defect words — 'should return X' spec language is not defect evidence", () => {
    expect(
      classifyTurnShape(
        "Implement a dependency-free helper exporting statusPhrase(code); unknown codes should return Unknown Status",
      ),
    ).toEqual({ category: "build", confidence: "high" })
  })

  it("audit: judgment keywords with no build opener and no defect words", () => {
    expect(classifyTurnShape("Audit the last merge for soundness and residual risk")).toEqual({
      category: "audit",
      confidence: "high",
    })
  })

  it("qa: the question-shaped default — no casting signal fires, so confidence is always low", () => {
    expect(classifyTurnShape("how does the session compaction ladder work?")).toEqual({
      category: "qa",
      confidence: "low",
    })
    expect(classifyTurnShape("summarize how the routing layer decides which tier runs a slice")).toEqual({
      category: "qa",
      confidence: "low",
    })
  })

  it("conflict → low: defect words alongside judgment keywords keep the diagnosis reading, flagged low", () => {
    expect(classifyTurnShape("is the fix sound — audit the change for residual risk")).toEqual({
      category: "diagnosis-vague",
      confidence: "low",
    })
  })

  it("conflict → low: a build opener alongside defect words stays diagnosis (the seed gate must not drift)", () => {
    const prompt = "Add a guard so the export no longer crashes on empty input"
    expect(classifyTurnShape(prompt)).toEqual({ category: "diagnosis-vague", confidence: "low" })
    expect(shouldRunDiagnosisPrepass(prompt)).toBe(true)
  })

  it("conflict → low: a build opener stands the judgment reading down (autoTypeTodos' build-branch rule)", () => {
    expect(classifyTurnShape("Update the migration script and give a verdict on its soundness")).toEqual({
      category: "build",
      confidence: "low",
    })
  })

  it("empty prompt: no signals, not question-shaped → the build default, low", () => {
    expect(classifyTurnShape("")).toEqual({ category: "build", confidence: "low" })
  })

  it("the diagnosis-vague verdict is exactly shouldRunDiagnosisPrepass — the classifier and the seed gate agree", () => {
    const prompts = [
      "The app shows Suit.HEART instead of Hearts when rendering the enum. Please fix it.",
      "fix the off-by-one suffix handling in Columns.col_str in ddl_references.py",
      "Implement a helper exporting statusPhrase(code)",
      "Audit the last merge for soundness and residual risk",
      "how does the session compaction ladder work?",
      "Add a guard so the export no longer crashes on empty input",
      "",
    ]
    for (const p of prompts) {
      expect(classifyTurnShape(p).category === "diagnosis-vague").toBe(shouldRunDiagnosisPrepass(p))
    }
  })
})

describe("categoryPreamble (§8 rule 4 — the turn-scoped casting playbook)", () => {
  const categories: TurnShapeCategory[] = ["diagnosis-vague", "diagnosis-grounded", "build", "audit", "qa"]

  it("every category has its own preamble: non-empty, <=4 lines, opening with the shape tag", () => {
    for (const c of categories) {
      const p = categoryPreamble(c)
      expect(p.length).toBeGreaterThan(0)
      expect(p.split("\n").length).toBeLessThanOrEqual(4)
      expect(p.startsWith("TURN SHAPE:")).toBe(true)
    }
    expect(new Set(categories.map(categoryPreamble)).size).toBe(categories.length)
  })

  it("each preamble teaches its shape's casting stance", () => {
    expect(categoryPreamble("diagnosis-vague")).toMatch(/pre-pass.*frames|do not anchor/i)
    expect(categoryPreamble("diagnosis-grounded")).toMatch(/discriminating probe/i)
    expect(categoryPreamble("build")).toMatch(/typed slices.*DAG/i)
    expect(categoryPreamble("audit")).toMatch(/reasoner slices.*never judge inline/i)
    expect(categoryPreamble("qa")).toMatch(/no decomposition/i)
  })
})

describe("planner seat (§8 — a bounded reasoner plan slice for the hardest shapes)", () => {
  it("PLANNER_PREPASS_TODO: the frame-slice shape pinned need:reasoner on the researcher persona", () => {
    expect(PLANNER_PREPASS_TODO).toMatchObject({
      content: PLANNER_SLICE_CONTENT,
      status: "pending",
      priority: "high",
      sliceType: "design",
      need: "reasoner",
      persona: "researcher",
    })
  })

  it("the plan brief demands sites + probes + layers + a typed-slice DAG, and forbids code", () => {
    expect(PLANNER_SLICE_CONTENT).toMatch(/ranked candidate defect sites/i)
    expect(PLANNER_SLICE_CONTENT).toMatch(/discriminating probe/i)
    expect(PLANNER_SLICE_CONTENT).toMatch(/fix layer/i)
    expect(PLANNER_SLICE_CONTENT).toMatch(/execution DAG of typed slices/i)
    expect(PLANNER_SLICE_CONTENT).toMatch(/Writing code, diffs, or edits is forbidden/i)
  })

  it("a lone planner seed carries its need pin through conversion and passes the benefit gate", async () => {
    const slices = await todosToLoopSlices([PLANNER_PREPASS_TODO], fakeProbes())
    expect(slices).toHaveLength(1)
    expect(slices[0]).toMatchObject({ id: PLANNER_SLICE_CONTENT, sliceType: "design", need: "reasoner" })
    expect(shouldOrchestrate(slices)).toBe(true)
  })

  it("a lone localization seed ALSO passes the benefit gate — a frame slice must dispatch, never sit pending", async () => {
    const slices = await todosToLoopSlices([LOCALIZATION_PREPASS_TODO], fakeProbes())
    expect(slices).toHaveLength(1)
    expect(slices[0]).toMatchObject({ id: LOCALIZATION_SLICE_CONTENT, sliceType: "design", need: "reasoner" })
    expect(shouldOrchestrate(slices)).toBe(true)
  })

  it("isHardDiagnosisPrompt: an ordinary single-site symptom is NOT hard", () => {
    expect(
      isHardDiagnosisPrompt(
        "The app shows Suit.HEART instead of Hearts when rendering the enum — str() on members returns the wrong value. Please fix it.",
      ),
    ).toBe(false)
    expect(isHardDiagnosisPrompt("")).toBe(false)
  })

  it("hard on >=2 distinct subsystem tokens (backticked / camelCase / snake_case anchors)", () => {
    expect(
      isHardDiagnosisPrompt(
        "the `SessionStore` cache and `flushQueue` worker disagree — writes during flush are dropped",
      ),
    ).toBe(true)
    expect(isHardDiagnosisPrompt("syncQueue drops items whenever retry_backoff is active")).toBe(true)
  })

  it("hard on a multi-sentence symptom carrying a cross-layer marker; a lone marker sentence is not", () => {
    expect(
      isHardDiagnosisPrompt(
        "Logins fail intermittently after we upgraded the driver. It only happens under load, roughly one request in fifty.",
      ),
    ).toBe(true)
    expect(isHardDiagnosisPrompt("Logins fail intermittently")).toBe(false)
  })

  it("diagnosisPrepassSeed: the planner for hard shapes, the localization slice otherwise", () => {
    expect(
      diagnosisPrepassSeed(
        "Logins fail intermittently after we upgraded the driver. It only happens under load, roughly one request in fifty.",
      ),
    ).toBe(PLANNER_PREPASS_TODO)
    expect(
      diagnosisPrepassSeed(
        "The app shows Suit.HEART instead of Hearts when rendering the enum. Please fix it.",
      ),
    ).toBe(LOCALIZATION_PREPASS_TODO)
  })
})

describe("extractVerifyCommands (F2)", () => {
  it("extracts backticked runner commands and classifies kind", () => {
    const cmds = extractVerifyCommands(
      "Run `bun test packages/x` then `bun run typecheck` and `eslint src/` — expect `Suit.HEART` unchanged",
    )
    expect(cmds).toEqual([
      { kind: "test", command: "bun test packages/x" },
      { kind: "typecheck", command: "bun run typecheck" },
      { kind: "lint", command: "eslint src/" },
    ])
  })

  it("ignores prose backticks and dedupes repeated commands", () => {
    expect(extractVerifyCommands("check `col_str` and `IndexColumns` behavior")).toEqual([])
    expect(extractVerifyCommands("`pytest -x` first, then `pytest -x` again")).toHaveLength(1)
  })
})

describe("todosToLoopSlices — verify-command derivation (F2)", () => {
  it("a verify slice gets text-named commands with the test-tree guard first", async () => {
    const probes = fakeProbes()
    const slices = await todosToLoopSlices(
      [{ content: "run the suite with `bun test packages/core`", status: "pending", sliceType: "verify" }],
      probes,
    )
    expect(slices[0].verifyCommands).toEqual([
      TEST_TREE_GUARD_COMMAND,
      { kind: "test", command: "bun test packages/core" },
    ])
  })

  it("falls back to the repo-script probe when the text names no command", async () => {
    const probes: SliceProbes = {
      ...fakeProbes(),
      probeVerifyCommands: async () => [{ kind: "test", command: "npm run test" }],
    }
    const slices = await todosToLoopSlices(
      [{ content: "verify the change end to end", status: "pending", sliceType: "verify" }],
      probes,
    )
    expect(slices[0].verifyCommands).toEqual([TEST_TREE_GUARD_COMMAND, { kind: "test", command: "npm run test" }])
  })

  it("a testable mechanical slice gets commands; an untestable one stays command-free", async () => {
    const withProbe = (ts: "testable" | "untestable"): SliceProbes => ({
      ...fakeProbes("low", ts),
      probeVerifyCommands: async () => [{ kind: "test", command: "npm run test" }],
    })
    const testable = await todosToLoopSlices(
      [{ content: "apply the fix", status: "pending", sliceType: "mechanical" }],
      withProbe("testable"),
    )
    expect(testable[0].verifyCommands).toEqual([TEST_TREE_GUARD_COMMAND, { kind: "test", command: "npm run test" }])
    const untestable = await todosToLoopSlices(
      [{ content: "apply the fix", status: "pending", sliceType: "mechanical" }],
      withProbe("untestable"),
    )
    expect(untestable[0].verifyCommands).toBeUndefined()
  })

  it("a test-authoring batch skips the guard and marks the authoring slice isTestSlice", async () => {
    const probes = fakeProbes()
    const slices = await todosToLoopSlices(
      [
        {
          content: "Add regression tests for col_str",
          status: "pending",
          sliceType: "mechanical",
          testStrength: "testable",
        },
        { content: "run `bun test packages/core`", status: "pending", sliceType: "verify" },
      ],
      probes,
    )
    expect(slices[0]!.isTestSlice).toBe(true)
    expect(slices[1]!.verifyCommands).toEqual([{ kind: "test", command: "bun test packages/core" }])
  })
})

describe("todosToLoopSlices — dep-ref resolution (todo_N / bare N / stage-DAG backstop)", () => {
  it("resolves a 1-indexed todo_N chain into a linear DAG, not a flat wave (live-run repro)", async () => {
    const probes = fakeProbes()
    const todos: OrchestrationTodo[] = [
      { content: "step 1", status: "pending", sliceType: "mechanical" },
      { content: "step 2", status: "pending", sliceType: "mechanical", deps: ["todo_1"] },
      { content: "step 3", status: "pending", sliceType: "mechanical", deps: ["todo_2"] },
      { content: "step 4", status: "pending", sliceType: "mechanical", deps: ["todo_3"] },
      { content: "step 5", status: "pending", sliceType: "mechanical", deps: ["todo_4"] },
      { content: "step 6", status: "pending", sliceType: "mechanical", deps: ["todo_5"] },
    ]
    const slices = await todosToLoopSlices(todos, probes)
    expect(slices[0]!.deps).toBeUndefined()
    for (let i = 1; i < slices.length; i++) {
      expect(slices[i]!.deps).toEqual([slices[i - 1]!.id])
    }
  })

  it("resolves bare-number and todo-2/todo 2/todo_2 spellings to the same target", async () => {
    const probes = fakeProbes()
    for (const ref of ["2", "todo-2", "todo 2", "todo_2"]) {
      const todos: OrchestrationTodo[] = [
        { content: "one", status: "pending", sliceType: "mechanical" },
        { content: "two", status: "pending", sliceType: "mechanical" },
        { content: `three via ${ref}`, status: "pending", sliceType: "mechanical", deps: [ref] },
      ]
      const slices = await todosToLoopSlices(todos, probes)
      expect(slices[2]!.deps).toEqual(["two"])
    }
  })

  it("still resolves an exact content-string id untouched", async () => {
    const probes = fakeProbes()
    const todos: OrchestrationTodo[] = [
      { content: "design the widget", status: "pending", sliceType: "design" },
      { content: "build the widget", status: "pending", sliceType: "mechanical", deps: ["design the widget"] },
    ]
    const slices = await todosToLoopSlices(todos, probes)
    expect(slices[1]!.deps).toEqual(["design the widget"])
  })

  it("resolves todo_0 to the first item via the 0-indexed fallback", async () => {
    const probes = fakeProbes()
    const todos: OrchestrationTodo[] = [
      { content: "alpha", status: "pending", sliceType: "mechanical" },
      { content: "beta", status: "pending", sliceType: "mechanical", deps: ["todo_0"] },
    ]
    const slices = await todosToLoopSlices(todos, probes)
    expect(slices[1]!.deps).toEqual(["alpha"])
  })

  it("drops a genuine self-reference (todo_0 on item 1 itself); zero resolved deps then trips the stage-DAG backstop", async () => {
    // todo_0 from item 1 (index 0) is unambiguously self under both the 1-indexed
    // and 0-indexed readings, so resolveDepRef drops it outright (unlike todo_1 from
    // item 1, whose 0-indexed fallback lands on item 2 instead of dropping).
    const probes = fakeProbes()
    const todos: OrchestrationTodo[] = [
      { content: "recon the thing", status: "pending", sliceType: "recon", deps: ["todo_0"] },
      { content: "make the change", status: "pending", sliceType: "mechanical" },
      { content: "verify it", status: "pending", sliceType: "verify" },
    ]
    const slices = await todosToLoopSlices(todos, probes)
    expect(slices[0]!.deps).toBeUndefined()
    expect(slices[1]!.deps).toEqual(["recon the thing"])
    expect(slices[2]!.deps).toEqual(["make the change"])
  })

  it("all-garbage deps trigger the stage-DAG backstop: mechanical→recon, verify→mechanical", async () => {
    const probes = fakeProbes()
    const todos: OrchestrationTodo[] = [
      { content: "recon the callers", status: "pending", sliceType: "recon", deps: ["banana"] },
      { content: "apply the fix", status: "pending", sliceType: "mechanical", deps: ["banana"] },
      { content: "verify green", status: "pending", sliceType: "verify", deps: ["banana"] },
    ]
    const slices = await todosToLoopSlices(todos, probes)
    expect(slices[0]!.deps).toBeUndefined()
    expect(slices[1]!.deps).toEqual(["recon the callers"])
    expect(slices[2]!.deps).toEqual(["apply the fix"])
  })

  it("a resolver-manufactured cycle falls back to the stage-DAG backstop instead of reaching the fail-loud scheduler", async () => {
    const probes = fakeProbes()
    // "todo_1" from item 0 skips the 1-indexed self and lands 0-indexed on item 1;
    // "todo_1" from item 1 lands 1-indexed on item 0 — a cycle no conductor intended,
    // which planWaves would otherwise throw on.
    const todos: OrchestrationTodo[] = [
      { content: "scout", status: "pending", sliceType: "recon", deps: ["todo_1"] },
      { content: "apply", status: "pending", sliceType: "mechanical", deps: ["todo_1"] },
    ]
    const slices = await todosToLoopSlices(todos, probes)
    expect(slices[0]!.deps).toBeUndefined()
    expect(slices[1]!.deps).toEqual(["scout"])
  })

  it("dedupes a todo_N ref and its equivalent content-string ref into a single dep", async () => {
    const probes = fakeProbes()
    const todos: OrchestrationTodo[] = [
      { content: "first thing", status: "pending", sliceType: "mechanical" },
      { content: "second thing", status: "pending", sliceType: "mechanical", deps: ["todo_1", "first thing"] },
    ]
    const slices = await todosToLoopSlices(todos, probes)
    expect(slices[1]!.deps).toEqual(["first thing"])
  })
})

describe("todosToLoopSlices — design-emits-the-patch contract + specBacked", () => {
  it("appends 'Output contract:' to a design slice that has a mechanical dependent", async () => {
    const probes = fakeProbes()
    const todos: OrchestrationTodo[] = [
      { content: "design the schema", status: "pending", sliceType: "design" },
      { content: "apply the migration", status: "pending", sliceType: "mechanical", deps: ["design the schema"] },
    ]
    const slices = await todosToLoopSlices(todos, probes)
    expect(slices[0].prompt).toContain("Output contract:")
  })

  it("does not append 'Output contract:' to a design slice with no mechanical dependent", async () => {
    const probes = fakeProbes()
    const todos: OrchestrationTodo[] = [
      { content: "design the schema", status: "pending", sliceType: "design" },
      { content: "recon the callers", status: "pending", sliceType: "recon", deps: ["design the schema"] },
    ]
    const slices = await todosToLoopSlices(todos, probes)
    expect(slices[0].prompt).not.toContain("Output contract:")
  })

  it("marks specBacked === true on a mechanical slice whose deps include a design slice", async () => {
    const probes = fakeProbes()
    const todos: OrchestrationTodo[] = [
      { content: "design the schema", status: "pending", sliceType: "design" },
      { content: "apply the migration", status: "pending", sliceType: "mechanical", deps: ["design the schema"] },
    ]
    const slices = await todosToLoopSlices(todos, probes)
    expect(slices[1].specBacked).toBe(true)
  })

  it("leaves specBacked undefined on a mechanical slice with no design dep", async () => {
    const probes = fakeProbes()
    const todos: OrchestrationTodo[] = [{ content: "apply the migration", status: "pending", sliceType: "mechanical" }]
    const slices = await todosToLoopSlices(todos, probes)
    expect(slices[0].specBacked).toBeUndefined()
  })
})

describe("todosToLoopSlices — OL-9.3f deterministic decomposition backstop", () => {
  it("a batch with even one conductor-typed item is left untouched by the heuristic", async () => {
    const probes = fakeProbes()
    const todos: OrchestrationTodo[] = [
      { content: "find the bug", status: "pending", sliceType: "mechanical" },
      { content: "fix it", status: "pending" },
      { content: "test it", status: "pending" },
    ]
    const slices = await todosToLoopSlices(todos, probes)
    // only the one conductor-typed item becomes a slice; the untyped two stay ignored
    expect(slices).toHaveLength(1)
    expect(slices[0]).toMatchObject({ id: "find the bug", sliceType: "mechanical" })
  })

  it("an untyped batch of >=3 items gets a sliceType derived from content keywords", async () => {
    const probes = fakeProbes()
    const todos: OrchestrationTodo[] = [
      { content: "investigate the failure", status: "pending" },
      { content: "fix the root cause", status: "pending" },
      { content: "run the tests to verify", status: "pending" },
    ]
    const slices = await todosToLoopSlices(todos, probes)
    expect(slices).toHaveLength(3)
    expect(slices[0].sliceType).toBe("recon")
    expect(slices[1].sliceType).toBe("mechanical")
    expect(slices[2].sliceType).toBe("verify")
  })

  it("a 2-item untyped batch stays un-orchestrated — no types derived, no slices produced", async () => {
    const probes = fakeProbes()
    const todos: OrchestrationTodo[] = [
      { content: "investigate the failure", status: "pending" },
      { content: "fix the root cause", status: "pending" },
    ]
    const slices = await todosToLoopSlices(todos, probes)
    expect(slices).toHaveLength(0)
  })
})

describe("personaForSlice", () => {
  it("maps sliceType to its default persona: recon→explorer, verify→runner, mechanical→applier, design/other→procedure", () => {
    expect(personaForSlice({ sliceType: "recon" })).toBe("explorer")
    expect(personaForSlice({ sliceType: "verify" })).toBe("runner")
    expect(personaForSlice({ sliceType: "mechanical" })).toBe("applier")
    expect(personaForSlice({ sliceType: "design" })).toBe("procedure")
    expect(personaForSlice({})).toBe("procedure")
  })

  it("an explicit persona wins over the sliceType default when it names a real ECON_PERSONAS member", () => {
    expect(personaForSlice({ sliceType: "mechanical", persona: "researcher" })).toBe("researcher")
    expect(personaForSlice({ sliceType: "recon", persona: "author" })).toBe("author")
  })

  it("ignores a persona value that is not a real ECON_PERSONAS member, falling back to the sliceType default", () => {
    expect(personaForSlice({ sliceType: "verify", persona: "not-a-real-persona" })).toBe("runner")
  })
})

describe("sliceStepBudget — frame slices get their own allowance", () => {
  it("localization and planner frame slices get FRAME_SLICE_STEP_BUDGET regardless of persona", () => {
    expect(sliceStepBudget("researcher", LOCALIZATION_SLICE_CONTENT)).toBe(FRAME_SLICE_STEP_BUDGET)
    expect(sliceStepBudget("researcher", PLANNER_SLICE_CONTENT)).toBe(FRAME_SLICE_STEP_BUDGET)
    expect(FRAME_SLICE_STEP_BUDGET).toBeGreaterThan(PERSONA_STEP_BUDGET.researcher)
  })

  it("every other slice keeps the persona budget", () => {
    expect(sliceStepBudget("researcher", "look up the docs for X")).toBe(PERSONA_STEP_BUDGET.researcher)
    expect(sliceStepBudget("applier", undefined)).toBe(PERSONA_STEP_BUDGET.applier)
  })
})

describe("PERSONA_STEP_BUDGET / countToolCalls / budgetExhaustedMarker (OL-9.3a)", () => {
  it("defines a positive budget for every ECON_PERSONAS member", () => {
    for (const persona of ECON_PERSONAS) {
      expect(typeof PERSONA_STEP_BUDGET[persona]).toBe("number")
      expect(PERSONA_STEP_BUDGET[persona]).toBeGreaterThan(0)
    }
  })

  it("countToolCalls counts completed tool parts and skips non-completed/non-tool/nameless parts", () => {
    const parts = [
      { type: "text", text: "hi" },
      { type: "tool", tool: "edit", state: { status: "completed" } },
      { type: "tool", tool: "bash", state: { status: "completed" } },
      { type: "tool", tool: "bash", state: { status: "running" } },
      { type: "tool" },
    ]
    expect(countToolCalls(parts)).toBe(2)
  })

  it("budgetExhaustedMarker names the persona and its configured budget", () => {
    const marker = budgetExhaustedMarker("explorer")
    expect(marker).toContain("explorer")
    expect(marker).toContain(String(PERSONA_STEP_BUDGET.explorer))
  })
})

describe("runConductorOrchestration — gating, mirroring, fallback", () => {
  const okDispatch: ConductorSliceDispatch = async () => ({ text: "done", parts: [] })

  it("untyped todos → engaged false, no dispatch", async () => {
    let dispatched = 0
    const res = await runConductorOrchestration({
      getTodos: async () => [{ content: "x", status: "pending" }],
      probes: fakeProbes(),
      dispatch: async () => {
        dispatched++
        return { text: "", parts: [] }
      },
      setTodoStatus: async () => {},
    })
    expect(res.engaged).toBe(false)
    expect(dispatched).toBe(0)
  })

  // Run-8 regression test (2026-07-04 live run): 13 untyped todos drove 109
  // child sessions / 868 LLM calls for one trivial issue because the old
  // OL-9.3f backstop engaged any untyped batch of >=3 pending items. The
  // backstop is deleted (OL-9.5c) — an untyped batch never engages, whatever
  // its size, so this must stay at zero dispatches.
  it("run-8 regression: an untyped batch of >=3 pending items → engaged false, zero dispatches", async () => {
    let dispatched = 0
    const res = await runConductorOrchestration({
      getTodos: async () => [
        { content: "find the bug", status: "pending" },
        { content: "fix the bug", status: "pending" },
        { content: "test the fix", status: "pending" },
      ],
      probes: fakeProbes(),
      dispatch: async () => {
        dispatched++
        return { text: "", parts: [] }
      },
      setTodoStatus: async () => {},
    })
    expect(res.engaged).toBe(false)
    expect(dispatched).toBe(0)
  })

  // Benefit gate (OL-9.5c), wired end-to-end: even an explicitly-typed DAG
  // fails to engage when it is a pure linear chain (every wave width 1) and
  // under the 6-slice scale threshold — splitting it would only add per-child
  // context re-derivation and wave serialization for zero parallelism.
  it("benefit gate: an explicitly-typed linear chain does not engage, even though every item is typed", async () => {
    let dispatched = 0
    const res = await runConductorOrchestration({
      getTodos: async () => [
        { content: "recon the callers", status: "pending", sliceType: "recon", coupling: "low", testStrength: "testable" },
        {
          content: "apply the fix",
          status: "pending",
          sliceType: "mechanical",
          deps: ["recon the callers"],
          coupling: "low",
          testStrength: "testable",
        },
        {
          content: "verify green",
          status: "pending",
          sliceType: "verify",
          deps: ["apply the fix"],
          coupling: "low",
          testStrength: "testable",
        },
      ],
      probes: fakeProbes(),
      dispatch: async () => {
        dispatched++
        return { text: "ok", parts: [] }
      },
      setTodoStatus: async () => {},
    })
    expect(res.engaged).toBe(false)
    expect(dispatched).toBe(0)
  })

  it("pending typed DAG → engages, dispatches, mirrors in_progress→completed", async () => {
    const statusCalls: { index: number; status: string }[] = []
    let dispatched = 0
    const res = await runConductorOrchestration({
      getTodos: async () => [
        { content: "a", status: "pending", sliceType: "mechanical", coupling: "low", testStrength: "testable" },
        { content: "b", status: "pending", sliceType: "mechanical", coupling: "low", testStrength: "testable" },
      ],
      probes: fakeProbes(),
      dispatch: async () => {
        dispatched++
        return { text: "ok", parts: [] }
      },
      setTodoStatus: async (index, status) => {
        statusCalls.push({ index, status })
      },
      // A green sound check so both slices accept on the cheap hop (no escalation).
      options: { runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
    })
    expect(res.engaged).toBe(true)
    expect(dispatched).toBeGreaterThanOrEqual(2)
    expect(statusCalls).toContainEqual({ index: 0, status: "in_progress" })
    expect(statusCalls).toContainEqual({ index: 1, status: "in_progress" })
    expect(statusCalls).toContainEqual({ index: 0, status: "completed" })
    expect(statusCalls).toContainEqual({ index: 1, status: "completed" })
    // completed comes after in_progress for a given slice.
    const firstCompleted = statusCalls.findIndex((c) => c.status === "completed")
    const lastInProgress = statusCalls.map((c) => c.status).lastIndexOf("in_progress")
    expect(firstCompleted).toBeGreaterThan(lastInProgress)
  })

  it("dispatch throw → caught at the boundary, metered, falls back (turn survives)", async () => {
    let metered = 0
    const res = await runConductorOrchestration({
      // Two independent slices so the OL-9.5c benefit gate passes (one wave of 2) and dispatch is reached.
      getTodos: async () => [
        { content: "a", status: "pending", sliceType: "mechanical" },
        { content: "b", status: "pending", sliceType: "mechanical" },
      ],
      probes: fakeProbes(),
      dispatch: async () => {
        throw new Error("dispatch boom")
      },
      setTodoStatus: async () => {},
      meterFallback: () => {
        metered++
      },
    })
    expect(res.engaged).toBe(false)
    expect(res.fellBack).toBe(true)
    expect(metered).toBe(1)
  })

  it("getTodos throw → metered fallback, no dispatch", async () => {
    let metered = 0
    let dispatched = 0
    const res = await runConductorOrchestration({
      getTodos: async () => {
        throw new Error("db down")
      },
      probes: fakeProbes(),
      dispatch: async () => {
        dispatched++
        return { text: "", parts: [] }
      },
      setTodoStatus: async () => {},
      meterFallback: () => {
        metered++
      },
    })
    expect(res.fellBack).toBe(true)
    expect(metered).toBe(1)
    expect(dispatched).toBe(0)
  })

  it("OL-9.3c finally-write: a mid-wave dispatch throw still settles every marked slice to a terminal status, never in_progress", async () => {
    const statusCalls: { index: number; status: string }[] = []
    const res = await runConductorOrchestration({
      getTodos: async () => [
        { content: "a", status: "pending", sliceType: "mechanical", coupling: "low", testStrength: "testable" },
        { content: "b", status: "pending", sliceType: "mechanical", coupling: "low", testStrength: "testable" },
      ],
      probes: fakeProbes(),
      dispatch: async (req) => {
        if (req.sliceId === "b") throw new Error("child crashed")
        return { text: "ok", parts: [] }
      },
      setTodoStatus: async (index, status) => {
        statusCalls.push({ index, status })
      },
      meterFallback: () => {},
    })
    expect(res.fellBack).toBe(true)
    const finalStatusFor = (idx: number) => statusCalls.filter((c) => c.index === idx).at(-1)?.status
    expect(finalStatusFor(0)).not.toBe("in_progress")
    expect(finalStatusFor(1)).not.toBe("in_progress")
  })

  it("CTX-2.3: a cold-graph probe rejection during slice conversion is caught at the boundary — turn falls back, never blocks", async () => {
    let metered = 0
    let dispatched = 0
    const coldProbes: SliceProbes = {
      probeCoupling: async () => {
        throw new Error("graph cold")
      },
      probeTestStrength: async () => ({ testStrength: "untestable" }),
    }
    const res = await runConductorOrchestration({
      getTodos: async () => [
        { content: "a", status: "pending", sliceType: "mechanical" },
        { content: "b", status: "pending", sliceType: "mechanical" },
      ],
      probes: coldProbes,
      dispatch: async () => {
        dispatched++
        return { text: "ok", parts: [] }
      },
      setTodoStatus: async () => {},
      meterFallback: () => {
        metered++
      },
    })
    expect(res.engaged).toBe(false)
    expect(res.fellBack).toBe(true)
    expect(metered).toBe(1)
    expect(dispatched).toBe(0)
  })
})

describe("extractTrajectory — child message parts → trajectory", () => {
  it("maps edit/write parts to file-edit events with a scannable diff and shell parts to commands", () => {
    const parts = [
      { type: "text", text: "hi" },
      { type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "src/a.ts", oldString: "expect(x).toBe(1)", newString: "return x" } } },
      { type: "tool", tool: "write", state: { status: "completed", input: { filePath: "src/b.ts", content: "export const b = 1" } } },
      { type: "tool", tool: "shell", state: { status: "completed", input: { command: "bun test" } } },
      { type: "tool", tool: "read", state: { status: "completed", input: { filePath: "src/c.ts" } } },
    ]
    const traj = extractTrajectory(parts)
    expect(traj.events).toHaveLength(3)
    expect(traj.events[0]).toMatchObject({ kind: "file-edit", filePath: "src/a.ts" })
    expect((traj.events[0] as { diff: string }).diff).toContain("-expect(x).toBe(1)")
    expect(traj.events[2]).toMatchObject({ kind: "command", command: "bun test" })
  })

  it("skips non-completed tool parts and marks isTestSlice through", () => {
    const parts = [{ type: "tool", tool: "edit", state: { status: "running", input: { filePath: "x.ts" } } }]
    const traj = extractTrajectory(parts, true)
    expect(traj.events).toHaveLength(0)
    expect(traj.isTestSlice).toBe(true)
  })
})

describe("resolveSliceModel", () => {
  it("splits a registry model ref into providerID/modelID", () => {
    const m = resolveSliceModel("executor")
    expect(typeof m.providerID).toBe("string")
    expect(typeof m.modelID).toBe("string")
    expect(m.providerID.length).toBeGreaterThan(0)
    expect(m.modelID.length).toBeGreaterThan(0)
  })
})

describe("runConductorSliceLoop", () => {
  it("engages and derives trajectory from the child's parts", async () => {
    const dispatch: ConductorSliceDispatch = async () => ({
      text: "done",
      parts: [{ type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "src/a.ts", oldString: "a", newString: "b" } } }],
      usage: { model: "gpt-oss-20b", cost: 0.001, tokens: { input: 1, output: 1 } },
    })
    const result = await runConductorSliceLoop(
      [{ id: "a", prompt: "edit a", testStrength: "testable", verifyCommands: [{ kind: "typecheck", command: "true" }] }],
      dispatch,
      { runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
    )
    expect(result.engaged).toBe(true)
    expect(result.outcomes[0].state).toBe("accepted")
  })

  it("CTX-2.1: a cheap-attempt rejection escalates with a compiled brief, not the raw slice prompt", async () => {
    const prompts: string[] = []
    const escalatedFlags: boolean[] = []
    const dispatch: ConductorSliceDispatch = async (req) => {
      prompts.push(req.prompt)
      escalatedFlags.push(req.escalated)
      return { text: "still broken", parts: [] }
    }
    const result = await runConductorSliceLoop(
      [{ id: "a", prompt: "fix the bug", testStrength: "testable", verifyCommands: [{ kind: "typecheck", command: "false" }] }],
      dispatch,
      { runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "typecheck failed" }) },
    )
    // One cheap dispatch + exactly one escalation hop (MAX_SLICE_ATTEMPTS = 2).
    expect(prompts.length).toBe(2)
    expect(escalatedFlags).toEqual([false, true])
    // The cheap hop carries the raw slice prompt verbatim...
    expect(prompts[0]).toBe("fix the bug")
    // ...the escalation hop carries a compiled OracleBrief (compileBrief's fixed sections),
    // never the raw slice prompt or a running transcript (OL-3.2 stateless-oracle contract).
    expect(prompts[1]).not.toBe("fix the bug")
    expect(prompts[1]).toContain("## Problem")
    expect(prompts[1]).toContain("## Question")
    expect(prompts[1]).toContain("## Expected Output Shape")
    expect(result.outcomes[0].state).toBe("unverified")
  })

  it("an accepted cheap attempt never escalates — a non-oracle turn's dispatch prompt is the plain slice prompt, unaffected", async () => {
    const prompts: string[] = []
    const escalatedFlags: boolean[] = []
    const dispatch: ConductorSliceDispatch = async (req) => {
      prompts.push(req.prompt)
      escalatedFlags.push(req.escalated)
      return { text: "done", parts: [] }
    }
    const result = await runConductorSliceLoop(
      [{ id: "b", prompt: "trivial edit", testStrength: "testable", verifyCommands: [{ kind: "typecheck", command: "true" }] }],
      dispatch,
      { runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
    )
    expect(prompts).toEqual(["trivial edit"])
    expect(escalatedFlags).toEqual([false])
    expect(result.outcomes[0].state).toBe("accepted")
  })
})

describe("isDeciderSeat (F6 — seat-scoped toolsets)", () => {
  it("design/verify at reasoner or oracle is a decider seat", () => {
    expect(isDeciderSeat("reasoner", "verify")).toBe(true)
    expect(isDeciderSeat("oracle", "design")).toBe(true)
  })

  it("mechanical stays a worker seat at every tier; low tiers never decide", () => {
    expect(isDeciderSeat("reasoner", "mechanical")).toBe(false)
    expect(isDeciderSeat("oracle", "mechanical")).toBe(false)
    expect(isDeciderSeat("executor", "verify")).toBe(false)
    expect(isDeciderSeat("conductor", "design")).toBe(false)
    expect(isDeciderSeat("executor", undefined)).toBe(false)
  })
})

describe("childSlicePermission — evaluated against real Permission.merge/evaluate semantics", () => {
  // Mirrors the live opencode.json arena ruleset that froze runs 4 and 5.
  const BASE_AGENT_RULES: PermissionV1.Ruleset = [
    { permission: "bash", pattern: "*", action: "ask" },
    { permission: "bash", pattern: "pwd", action: "allow" },
    { permission: "bash", pattern: "sudo *", action: "deny" },
    { permission: "edit", pattern: "*", action: "ask" },
    { permission: "question", pattern: "*", action: "allow" },
    { permission: "webfetch", pattern: "*", action: "ask" },
  ]

  it("allows the run-5 freeze command (node -e ...) despite the base bash-ask", () => {
    const effective = Permission.merge(BASE_AGENT_RULES, childSlicePermission(undefined, false))
    expect(Permission.evaluate("bash", 'node -e "const p = require(\'./x\')"', effective).action).toBe("allow")
  })

  it("allows the run-4 freeze command (TZ-prefixed jest invocation)", () => {
    const effective = Permission.merge(BASE_AGENT_RULES, childSlicePermission(undefined, false))
    expect(
      Permission.evaluate("bash", "TZ=America/Los_Angeles npx jest test/timezone.test.js --runInBand", effective)
        .action,
    ).toBe("allow")
  })

  it("re-pins danger patterns to deny after the broad bash allow", () => {
    const effective = Permission.merge(BASE_AGENT_RULES, childSlicePermission(undefined, false))
    expect(Permission.evaluate("bash", "sudo rm -rf /", effective).action).toBe("deny")
    expect(Permission.evaluate("bash", "git push origin main", effective).action).toBe("deny")
    expect(Permission.evaluate("bash", "curl http://evil", effective).action).toBe("deny")
  })

  it("allows edit for the slice's own work", () => {
    const effective = Permission.merge(BASE_AGENT_RULES, childSlicePermission(undefined, false))
    expect(Permission.evaluate("edit", "src/x.ts", effective).action).toBe("allow")
  })

  it("explorer children lose the shell and edit — recon runs on read tools only", () => {
    const effective = Permission.merge(BASE_AGENT_RULES, childSlicePermission(undefined, true, "explorer"))
    expect(Permission.evaluate("bash", 'node -e "probe()"', effective).action).toBe("deny")
    expect(Permission.evaluate("edit", "src/x.ts", effective).action).toBe("deny")
    expect(Permission.evaluate("webfetch", "https://x", effective).action).toBe("deny")
  })

  it("denies the blocking question surface and the network", () => {
    const effective = Permission.merge(BASE_AGENT_RULES, childSlicePermission(undefined, false))
    expect(Permission.evaluate("question", "anything", effective).action).toBe("deny")
    expect(Permission.evaluate("webfetch", "https://x", effective).action).toBe("deny")
  })

  it("denies task even when the merged ruleset includes a task allow from the agent/config side", () => {
    const rulesWithTaskAllow: PermissionV1.Ruleset = [
      ...BASE_AGENT_RULES,
      { permission: "task", pattern: "*", action: "allow" },
    ]
    const effective = Permission.merge(rulesWithTaskAllow, childSlicePermission(undefined, false))
    expect(Permission.evaluate("task", "unerr-worker", effective).action).toBe("deny")
    expect(Permission.evaluate("question", "anything", effective).action).toBe("deny")
  })

  it("no-ask invariant: no overlaid permission ever resolves to ask, for every persona and the no-persona default", () => {
    const permissions = ["bash", "edit", "question", "webfetch", "websearch", "skill", "doom_loop", "task"]
    for (const persona of [undefined, ...ECON_PERSONAS] as const) {
      const effective = Permission.merge(BASE_AGENT_RULES, childSlicePermission(undefined, false, persona))
      for (const permission of permissions) {
        expect(Permission.evaluate(permission, "an-arbitrary-pattern-123", effective).action).not.toBe("ask")
      }
    }
  })

  it("decider seat (F6): bash and edit deny even on the runner persona — judgment slices stop grinding", () => {
    const effective = Permission.merge(BASE_AGENT_RULES, childSlicePermission(undefined, true, "runner", true))
    expect(Permission.evaluate("bash", "npx jest --runInBand", effective).action).toBe("deny")
    expect(Permission.evaluate("edit", "src/x.ts", effective).action).toBe("deny")
    // Read surfaces stay untouched — the seat judges from evidence.
    expect(Permission.evaluate("question", "anything", effective).action).toBe("deny")
  })

  it("worker seat unaffected: deciderSeat=false keeps bash+edit for a mechanical rescue at any tier", () => {
    const effective = Permission.merge(BASE_AGENT_RULES, childSlicePermission(undefined, false, "applier", false))
    expect(Permission.evaluate("bash", "npx jest --runInBand", effective).action).toBe("allow")
    expect(Permission.evaluate("edit", "src/x.ts", effective).action).toBe("allow")
  })

  it("researcher persona flips webfetch/websearch to allow and denies bash+edit unconditionally", () => {
    const effective = Permission.merge(BASE_AGENT_RULES, childSlicePermission(undefined, false, "researcher"))
    expect(Permission.evaluate("webfetch", "https://x", effective).action).toBe("allow")
    expect(Permission.evaluate("websearch", "anything", effective).action).toBe("allow")
    expect(Permission.evaluate("bash", "pwd", effective).action).toBe("deny")
    expect(Permission.evaluate("edit", "src/x.ts", effective).action).toBe("deny")
  })

  it("researcher stays denied bash+edit even when readOnly is false (it never gets a write lane)", () => {
    const effective = Permission.merge(BASE_AGENT_RULES, childSlicePermission(undefined, false, "researcher"))
    expect(Permission.evaluate("edit", "src/x.ts", effective).action).toBe("deny")
  })

  it("write-lane personas keep today's rules: web denied, bash/edit allowed", () => {
    for (const persona of ECON_PERSONAS.filter((p) => p !== "researcher" && p !== "explorer")) {
      const effective = Permission.merge(BASE_AGENT_RULES, childSlicePermission(undefined, false, persona))
      expect(Permission.evaluate("webfetch", "https://x", effective).action).toBe("deny")
      expect(Permission.evaluate("bash", "pwd", effective).action).toBe("allow")
      expect(Permission.evaluate("edit", "src/x.ts", effective).action).toBe("allow")
    }
  })

  it("explorer loses the shell and edit even when readOnly is false", () => {
    const effective = Permission.merge(BASE_AGENT_RULES, childSlicePermission(undefined, false, "explorer"))
    expect(Permission.evaluate("bash", "pwd", effective).action).toBe("deny")
    expect(Permission.evaluate("edit", "src/x.ts", effective).action).toBe("deny")
    expect(Permission.evaluate("webfetch", "https://x", effective).action).toBe("deny")
  })

  it("readOnly=true denies edit while bash stays allowed", () => {
    const effective = Permission.merge(BASE_AGENT_RULES, childSlicePermission(undefined, true))
    expect(Permission.evaluate("edit", "src/x.ts", effective).action).toBe("deny")
    expect(Permission.evaluate("bash", "npx jest x", effective).action).toBe("allow")
  })

  it("keeps parent rules in front, still effective for a permission the overlay doesn't touch", () => {
    const parentRules: SlicePermissionRule[] = [{ permission: "external_directory", pattern: "*", action: "deny" }]
    const effective = Permission.merge(BASE_AGENT_RULES, childSlicePermission(parentRules, false))
    expect(Permission.evaluate("external_directory", "*", effective).action).toBe("deny")
  })
})

describe("buildRepoPrimer (OL-9.4b)", () => {
  const tmpDirs: string[] = []
  function makeTmpRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "slice-primer-"))
    tmpDirs.push(dir)
    return dir
  }

  afterEach(() => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop()!
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("renders a bounded top-2-level tree and skips node_modules/.git/dist", () => {
    const cwd = makeTmpRepo()
    mkdirSync(join(cwd, "src"))
    writeFileSync(join(cwd, "src", "index.ts"), "")
    mkdirSync(join(cwd, "node_modules"))
    writeFileSync(join(cwd, "node_modules", "pkg.js"), "")
    mkdirSync(join(cwd, ".git"))
    mkdirSync(join(cwd, "dist"))
    writeFileSync(join(cwd, "README.md"), "")

    const primer = buildRepoPrimer({ cwd })
    expect(primer).toContain("Repo primer (already established")
    expect(primer).toContain("do NOT re-list directories or re-read package.json")
    expect(primer).toContain("src/")
    expect(primer).toContain("src/index.ts")
    expect(primer).toContain("README.md")
    expect(primer).not.toContain("node_modules")
    expect(primer).not.toContain(".git")
    expect(primer).not.toContain("dist")
  })

  it("caps the tree at maxEntries", () => {
    const cwd = makeTmpRepo()
    for (let i = 0; i < 10; i++) writeFileSync(join(cwd, `file-${i}.txt`), "")

    const primer = buildRepoPrimer({ cwd, maxEntries: 3 })
    const treeLines = primer.split("\n").filter((l) => l.startsWith("file-"))
    expect(treeLines.length).toBeLessThanOrEqual(3)
  })

  it("summarizes package.json: name, scripts, workspaces", () => {
    const cwd = makeTmpRepo()
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ name: "econ-test-repo", scripts: { build: "tsc", test: "bun test" }, workspaces: ["packages/*"] }),
    )

    const primer = buildRepoPrimer({ cwd })
    expect(primer).toContain("package.json: name=econ-test-repo")
    expect(primer).toContain("scripts=[build, test]")
    expect(primer).toContain("workspaces=yes")
  })

  it("handles a missing package.json without throwing, and omits the package.json line", () => {
    const cwd = makeTmpRepo()
    writeFileSync(join(cwd, "index.js"), "")

    const primer = buildRepoPrimer({ cwd })
    expect(primer).not.toContain("package.json:")
    expect(primer).toContain("index.js")
  })

  it("never throws on an unreadable/nonexistent cwd", () => {
    expect(() => buildRepoPrimer({ cwd: join(tmpdir(), "does-not-exist-econ-primer-test") })).not.toThrow()
  })
})

describe("renderSliceDigestLedger (OL-9.4b)", () => {
  it("renders empty for no completed slices (wave 1)", () => {
    expect(renderSliceDigestLedger([])).toBe("")
  })

  it("includes the do-not-re-derive wording and each entry's id + text", () => {
    const entries: SliceDigestEntry[] = [
      { id: "slice-a", text: "found the bug in foo.ts" },
      { id: "slice-b", text: "added the retry helper" },
    ]
    const rendered = renderSliceDigestLedger(entries)
    expect(rendered).toContain("Established by earlier slices")
    expect(rendered).toContain("trust these findings; do not re-derive them")
    expect(rendered).toContain("slice-a")
    expect(rendered).toContain("found the bug in foo.ts")
    expect(rendered).toContain("slice-b")
    expect(rendered).toContain("added the retry helper")
  })

  it("truncates a single entry beyond the per-digest cap", () => {
    const longText = "x".repeat(2000)
    const rendered = renderSliceDigestLedger([{ id: "slice-a", text: longText }], { perDigestMaxChars: 100 })
    expect(rendered).toContain("x".repeat(100))
    expect(rendered).not.toContain("x".repeat(101))
  })

  it("stops adding entries once the total cap would be exceeded", () => {
    const entries: SliceDigestEntry[] = Array.from({ length: 10 }, (_, i) => ({
      id: `slice-${i}`,
      text: "y".repeat(200),
    }))
    const rendered = renderSliceDigestLedger(entries, { perDigestMaxChars: 200, totalMaxChars: 500 })
    expect(rendered.length).toBeLessThan(700) // header + a couple of blocks, not all 10
    expect(rendered).toContain("slice-0")
    expect(rendered).not.toContain("slice-9")
  })
})

describe("slice child prompt assembly includes primer + ledger (OL-9.4b)", () => {
  /** Mirrors the `.filter(Boolean).join("\n\n")` composition in prompt.ts's dispatch closure. */
  function assembleFramed(repoPrimer: string, ledger: string, parentTask: string, slicePrompt: string): string {
    return [
      "You are a headless slice executor: you run ONE slice of a decomposed parent task, unattended.",
      repoPrimer,
      ledger,
      parentTask ? `## Parent task (context only — do ONLY your slice)\n${parentTask}` : "",
      `## Your slice\n${slicePrompt}`,
    ]
      .filter(Boolean)
      .join("\n\n")
  }

  it("wave 1 (no completed slices): primer present, ledger section absent", () => {
    const primer = buildRepoPrimer({ cwd: process.cwd() })
    const ledger = renderSliceDigestLedger([])
    const framed = assembleFramed(primer, ledger, "parent task text", "do the thing")
    expect(framed).toContain("Repo primer (already established")
    expect(framed).not.toContain("Established by earlier slices")
  })

  it("wave 2+ (completed slices present): both sections present with do-not-re-derive wording", () => {
    const primer = buildRepoPrimer({ cwd: process.cwd() })
    const ledger = renderSliceDigestLedger([{ id: "wave1-slice", text: "found and fixed the root cause" }])
    const framed = assembleFramed(primer, ledger, "parent task text", "do the next thing")
    expect(framed).toContain("Repo primer (already established")
    expect(framed).toContain("do NOT re-list directories or re-read package.json")
    expect(framed).toContain("Established by earlier slices")
    expect(framed).toContain("trust these findings; do not re-derive them")
    expect(framed).toContain("wave1-slice")
  })
})

describe("reconcileSettledSlices — settled-slice memory + frame-seed preservation (case-2 tierfire3 double-wave)", () => {
  it("case-2 tierfire3 replay: a completed 4-dim+verdict wave re-emitted bare comes back completed with fields carried", () => {
    const existing: OrchestrationTodo[] = [
      { content: "Audit edge cases: both-refinements, superRefine, chained merge", status: "completed", sliceType: "verify", need: "reasoner" },
      { content: "Verify deprecation posture coherence", status: "completed", sliceType: "verify", need: "reasoner" },
      { content: "Assess residual risk in the merge path", status: "completed", sliceType: "verify", need: "reasoner" },
      { content: "Check error messaging format consistency", status: "completed", sliceType: "verify", need: "reasoner" },
      {
        content: "State verdict: soundness, completeness, residual risk",
        status: "completed",
        sliceType: "verify",
        need: "reasoner",
        deps: [
          "Audit edge cases: both-refinements, superRefine, chained merge",
          "Verify deprecation posture coherence",
          "Assess residual risk in the merge path",
          "Check error messaging format consistency",
        ],
      },
    ]
    // Re-emitted with NO slice fields at all — a stale rewrite of the plan list.
    const incoming: OrchestrationTodo[] = existing.map((t, i) => ({
      content: t.content,
      status: i % 2 === 0 ? "pending" : "in_progress",
    }))
    const result = reconcileSettledSlices(incoming, existing)
    expect(result).toHaveLength(5)
    for (let i = 0; i < 4; i++) {
      expect(result[i]).toMatchObject({ content: existing[i]!.content, status: "completed", sliceType: "verify", need: "reasoner" })
    }
    expect(result[4]).toMatchObject({
      content: existing[4]!.content,
      status: "completed",
      sliceType: "verify",
      need: "reasoner",
      deps: existing[4]!.deps,
    })
    expect(hasPendingTypedSlices(result)).toBe(false)
  })

  it("an omitted SETTLED typed slice is re-appended at the tail with its terminal status intact", () => {
    const existing: OrchestrationTodo[] = [
      { content: "Audit dimension 5: config drift", status: "completed", sliceType: "verify", need: "reasoner" },
    ]
    const incoming: OrchestrationTodo[] = [{ content: "A fresh unrelated todo", status: "pending" }]
    const result = reconcileSettledSlices(incoming, existing)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual(incoming[0])
    expect(result[1]).toMatchObject({
      content: "Audit dimension 5: config drift",
      status: "completed",
      sliceType: "verify",
      need: "reasoner",
    })
  })

  it("case-1 skeleton clobber: an omitted frame seed is re-appended, still pending+typed, parentID stripped", () => {
    const existing: Array<OrchestrationTodo & { parentID?: number }> = [
      { content: "Fix the crash on startup", status: "pending" },
      { ...LOCALIZATION_PREPASS_TODO, parentID: 0 },
    ]
    const incoming: OrchestrationTodo[] = [
      { content: "fresh untyped item 1", status: "pending" },
      { content: "fresh untyped item 2", status: "pending" },
      { content: "fresh untyped item 3", status: "pending" },
    ]
    const result = reconcileSettledSlices(incoming, existing)
    expect(result).toHaveLength(4)
    const seed = result[3]!
    expect(seed.content).toBe(LOCALIZATION_SLICE_CONTENT)
    expect(seed.status).toBe("pending")
    expect(seed.sliceType).toBe("design")
    expect("parentID" in seed).toBe(false)
    expect(hasPendingTypedSlices(result)).toBe(true)
  })

  it("an omitted NON-terminal, non-seed typed slice is dropped — a legitimate re-plan", () => {
    const existing: OrchestrationTodo[] = [
      { content: "Implement the old approach in old.ts", status: "pending", sliceType: "mechanical" },
    ]
    const incoming: OrchestrationTodo[] = [{ content: "Implement the new approach in new.ts", status: "pending" }]
    const result = reconcileSettledSlices(incoming, existing)
    expect(result).toEqual(incoming)
  })

  it("forward transition allowed: a stored pending typed slice re-emitted completed stays completed", () => {
    const existing: OrchestrationTodo[] = [
      { content: "Implement the tier gate in src/session/gate.ts", status: "pending", sliceType: "mechanical" },
    ]
    const incoming: OrchestrationTodo[] = [
      { content: "Implement the tier gate in src/session/gate.ts", status: "completed" },
    ]
    const result = reconcileSettledSlices(incoming, existing)
    expect(result).toEqual([{ content: "Implement the tier gate in src/session/gate.ts", status: "completed", sliceType: "mechanical" }])
  })

  it("no typed stored todos: incoming returned unchanged, and an UNTYPED completed todo rewritten to pending is not re-stuck", () => {
    const existing: OrchestrationTodo[] = [{ content: "Update the changelog entry", status: "completed" }]
    const incoming: OrchestrationTodo[] = [{ content: "Update the changelog entry", status: "pending" }]
    const result = reconcileSettledSlices(incoming, existing)
    expect(result).toEqual(incoming)
    expect(result[0]!.status).toBe("pending")
  })

  it("autoTypeTodos active-DAG guard: a settled typed item alone no longer blocks typing of fresh judgment items", () => {
    const list: OrchestrationTodo[] = [
      { content: "Audit edge cases: both-refinements, superRefine, chained merge", status: "pending" },
      { content: "Verify deprecation posture coherence", status: "pending" },
      { content: "Assess residual risk in the merge path", status: "pending" },
      { content: "State verdict: soundness, completeness, residual risk", status: "pending" },
      { content: "Old settled item", status: "completed", sliceType: "mechanical" },
    ]
    const typed = autoTypeTodos(list)
    for (const i of [0, 1, 2]) expect(typed[i]).toMatchObject({ sliceType: "verify", need: "reasoner" })
    expect(typed[3]).toMatchObject({
      sliceType: "verify",
      need: "reasoner",
      deps: [list[0]!.content, list[1]!.content, list[2]!.content],
    })
    expect(typed[4]).toMatchObject({ content: "Old settled item", status: "completed", sliceType: "mechanical" })
    expect(hasPendingTypedSlices(typed)).toBe(true)
  })

  it("autoTypeTodos active-DAG guard: a list with a PENDING typed slice still early-returns unchanged", () => {
    const list: OrchestrationTodo[] = [
      { content: "Wire the gate in src/session/gate.ts", status: "pending", sliceType: "mechanical" },
      { content: "State verdict: soundness", status: "pending" },
    ]
    expect(autoTypeTodos(list)).toEqual(list)
  })

  it("autoTypeTodos injection one-shot: a bug-shaped list already containing a completed seed emits no duplicate seed", () => {
    const list: OrchestrationTodo[] = [
      { content: "Fix the enum display bug so str() returns the raw value", status: "pending" },
      { ...LOCALIZATION_PREPASS_TODO, status: "completed" },
      { content: "Verify the model field returns 'M'", status: "pending" },
    ]
    const typed = autoTypeTodos(list)
    const seedCount = typed.filter((t) => t.content === LOCALIZATION_SLICE_CONTENT).length
    expect(seedCount).toBe(1)
  })
})
