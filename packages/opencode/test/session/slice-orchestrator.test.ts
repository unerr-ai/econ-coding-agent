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
import {
  ECON_PERSONAS,
  allocateSlice,
  redecompositionCheck,
  PERPLEXITY_HIGH_THRESHOLD,
  type VerifyCommand,
  type CommandRunner,
  type CommandResult,
  type EconTier,
  type LogprobToken,
  type UncertaintySignal,
  type SliceOutcome,
  type RedecompositionSignals,
} from "@opencode-ai/code-intelligence"
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
  LOCALIZATION_PREPASS_TODO,
  REPRO_PREPASS_TODO,
  promptAuthorizesTestEdits,
  diagnosisDeniesTestEdits,
  PLAN_PREPASS_TODO,
  GRIND_DESIGN_PREPASS_TODO,
  extractVerifyCommands,
  TEST_TREE_GUARD_COMMAND,
  deriveTurnProbe,
  normalizeProbeCommand,
  canonicalScriptProbeCommand,
  canonicalCommandForScript,
  runTurnProbeGate,
  childSlicePermission,
  isDeciderSeat,
  isDelegatingSeat,
  todosToPlanNodes,
  personaForSlice,
  PERSONA_STEP_BUDGET,
  sliceStepBudget,
  FRAME_SLICE_STEP_BUDGET,
  countToolCalls,
  budgetExhaustedMarker,
  buildRepoPrimer,
  extractSliceFiles,
  resolveDottedPyModules,
  renderSliceDigestLedger,
  orderTriageGoals,
  buildTriageTodoSkeleton,
  logprobTokensFromParts,
  uncertaintyFromParts,
  redecompositionSignalsFromOutcomes,
  isReproScratchPath,
  MODULE_MISSING_RE,
  missingModuleFromOutput,
  type ConductorSliceDispatch,
  type SliceProbes,
  type OrchestrationTodo,
  type SlicePermissionRule,
  type SliceDigestEntry,
  type TriageTodoRow,
} from "../../src/session/slice-orchestrator"
import { triagePreamble } from "../../src/session/prompts/preambles"
import { batchMomentumNudgeText } from "../../src/session/prompts/nudges"
import {
  LOCALIZATION_SLICE_CONTENT,
  PLAN_SLICE_CONTENT,
  REDECOMPOSITION_SLICE_CONTENT,
  GRIND_DESIGN_SLICE_CONTENT,
  REPRO_SLICE_CONTENT,
} from "../../src/session/prompts/seeds"
import type { TriageGoal, TriageVerdict } from "../../src/session/turn-triage"
import type { ArmingDecision } from "../../src/session/arming-judge"
import { getResolveAttempts, incResolveAttempts, resetResolveAttempts } from "../../src/session/resolution-store"

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
  // build turn with no named file target gets ONE writer pre-pass appended —
  // reasoner-pinned (need) + mechanical/applier persona, so edit+bash stay
  // ALLOWED and it localizes, fixes, and verifies in one session. The hook
  // that dispatches it is root-only; non-root concerns are out of scope here.
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
        sliceType: "mechanical",
        testStrength: "testable",
        persona: "applier",
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

  // Arming judge override, refined by corpus R4 (2026-07-09): armLocalization,
  // when passed, is the SEMANTIC gate — but it never OVERRIDES the one syntactic
  // refinement from the to-do list, which the judge never saw: the active to-dos
  // must not already name a file target. `false` always suppresses (the gate
  // short-circuits); `true` still requires no file target before injecting.
  // R1 (non-diagnosis turns never arm) is gated upstream (the judge + Door-1),
  // so it is deliberately NOT re-checked here — a vague diagnosis whose
  // remediation to-dos aren't phrased "investigate/fix" must still arm. Only
  // when the caller passes no decision (undefined) does the semantic gate
  // itself fall back to the old DIAGNOSIS_START heuristic.
  describe("autoTypeTodos — arming judge override (armLocalization threaded in)", () => {
    const mechanicalTodos: OrchestrationTodo[] = [
      { content: "Fix the enum display bug so str() returns the raw value", status: "pending" },
      { content: "Verify the model field returns 'M'", status: "pending" },
    ]

    it("armLocalization:true injects the localization pre-pass — the judge is the sole semantic authority", () => {
      const typed = autoTypeTodos(mechanicalTodos, true)
      expect(typed).toHaveLength(3)
      expect(typed[2]).toEqual({
        content: LOCALIZATION_SLICE_CONTENT,
        status: "pending",
        priority: "high",
        sliceType: "mechanical",
        testStrength: "testable",
        persona: "applier",
      })
    })

    it("armLocalization:false suppresses injection even though the batch is bug-shaped with no file target", () => {
      expect(autoTypeTodos(mechanicalTodos, false)).toEqual(mechanicalTodos)
    })

    it("armLocalization undefined falls back to the old bug-shaped+no-file heuristic", () => {
      const typed = autoTypeTodos(mechanicalTodos)
      expect(typed).toHaveLength(3)
      expect(typed[2]!.content).toBe(LOCALIZATION_SLICE_CONTENT)
    })

    // R4 — the judge armed, but the to-dos already name a file target (new
    // syntactic grounding the turn-open judge never saw): suppress.
    it("R4: armLocalization:true is suppressed when the active to-dos already name a file target", () => {
      const grounded: OrchestrationTodo[] = [
        { content: "Fix the trailing commas in the schema import in database.ts", status: "pending" },
        { content: "Verify the import parses cleanly", status: "pending" },
      ]
      expect(autoTypeTodos(grounded, true)).toEqual(grounded)
    })

    // Guard against over-suppression: a vague diagnosis whose remediation
    // to-dos are phrased as ordinary build verbs ("add pagination…"), not
    // "investigate/fix", must still arm — R1 lives upstream (judge + Door-1),
    // not as a re-check here, so this must NOT be suppressed.
    it("armLocalization:true still injects for vague-diagnosis to-dos phrased as build verbs, with no file target", () => {
      const vagueDiagnosisTodos: OrchestrationTodo[] = [
        { content: "Add pagination to the query to fix the timeout", status: "pending" },
        { content: "Verify the query completes within budget", status: "pending" },
      ]
      const typed = autoTypeTodos(vagueDiagnosisTodos, true)
      expect(typed).toHaveLength(3)
      expect(typed[2]!.content).toBe(LOCALIZATION_SLICE_CONTENT)
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
    const preamble = triagePreamble(verdict, { armLocalization: false, hardness: "trivial", ambiguity: "clear" })
    expect(preamble).toContain("2 goals extracted, confidence=high")
    expect(preamble).toContain('"fix the login bug" — done when: login succeeds')
    expect(preamble).toContain("[build, needs-plan]")
    expect(preamble).toContain('CONSTRAINT (no-test-edit): "don\'t touch the tests"')
    expect(preamble).not.toContain("TURN FLAGGED")
  })

  it("singular goal wording and a missing deliverable fall back to a generic done-when", () => {
    const verdict: TriageVerdict = {
      goals: [{ quote: "explain the flow", shape: "qa", deliverable: "" }],
      constraints: [],
      confidence: "low",
    }
    const preamble = triagePreamble(verdict, { armLocalization: false, hardness: "trivial", ambiguity: "clear" })
    expect(preamble).toContain("1 goal extracted, confidence=low")
    expect(preamble).toContain("done when: the goal is satisfied")
    expect(preamble).not.toContain("CONSTRAINT")
    expect(preamble).not.toContain("TURN FLAGGED")
  })

  it("appends a decomposition-bias line when the arming judge flagged the turn ambiguous", () => {
    const verdict: TriageVerdict = {
      goals: [{ quote: "figure out why checkout fails intermittently", shape: "diagnosis-vague", deliverable: "" }],
      constraints: [],
      confidence: "low",
    }
    const preamble = triagePreamble(verdict, { armLocalization: false, hardness: "moderate", ambiguity: "ambiguous" })
    expect(preamble).toContain("TURN FLAGGED AMBIGUOUS")
    expect(preamble).toContain("prefer todowrite over inline single-shot handling")
  })

  it("appends a decomposition-bias line when the arming judge flagged the turn hard, even if ambiguity is clear", () => {
    const verdict: TriageVerdict = {
      goals: [{ quote: "migrate every caller to the new API", shape: "build", deliverable: "all callers updated" }],
      constraints: [],
      confidence: "high",
    }
    const preamble = triagePreamble(verdict, { armLocalization: false, hardness: "hard", ambiguity: "clear" })
    expect(preamble).toContain("TURN FLAGGED HARD")
  })

  it("flags both AMBIGUOUS/HARD when the arming judge fires on both axes", () => {
    const verdict: TriageVerdict = {
      goals: [{ quote: "something is broken somewhere in checkout", shape: "diagnosis-vague", deliverable: "" }],
      constraints: [],
      confidence: "low",
    }
    const preamble = triagePreamble(verdict, { armLocalization: true, hardness: "hard", ambiguity: "ambiguous" })
    expect(preamble).toContain("TURN FLAGGED AMBIGUOUS/HARD")
  })

  it("P3 — a research goal appends the cited-digest playbook; other shapes don't", () => {
    const research: TriageVerdict = {
      goals: [{ quote: "what changed in zod v4", shape: "research", deliverable: "a cited digest" }],
      constraints: [],
      confidence: "high",
    }
    const preamble = triagePreamble(research, { armLocalization: false, hardness: "trivial", ambiguity: "clear" })
    expect(preamble).toContain("RESEARCH PLAYBOOK")
    expect(preamble).toContain("CITED digest")
    expect(preamble).toContain("citation check")
    expect(preamble).not.toContain("REFACTOR PLAYBOOK")

    const build: TriageVerdict = {
      goals: [{ quote: "add a flag", shape: "build", deliverable: "flag works" }],
      constraints: [],
      confidence: "high",
    }
    expect(triagePreamble(build, { armLocalization: false, hardness: "trivial", ambiguity: "clear" })).not.toContain(
      "PLAYBOOK",
    )
  })

  it("P3 — a refactor goal appends the behavior-preserving playbook (mechanical default, suite green, no signature breaks)", () => {
    const verdict: TriageVerdict = {
      goals: [
        { quote: "extract the retry logic into a helper", shape: "refactor", deliverable: "behavior unchanged" },
      ],
      constraints: [],
      confidence: "high",
    }
    const preamble = triagePreamble(verdict, { armLocalization: false, hardness: "trivial", ambiguity: "clear" })
    expect(preamble).toContain("REFACTOR PLAYBOOK")
    expect(preamble).toContain("behavior must NOT change")
    expect(preamble).toContain("`mechanical`")
    expect(preamble).not.toContain("RESEARCH PLAYBOOK")
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
    const todos = buildTriageTodoSkeleton(verdict, { armLocalization: false, hardness: "trivial" })
    expect(todos).toHaveLength(2)
    expect(todos.map((t) => t.content)).toEqual(["add feature X", "add feature Y"])
    expect(todos.every((t) => t.parentID === undefined)).toBe(true)
  })

  it("a needsPlan BUILD goal gets exactly one PLAN-seed child linked by parentID (P12 — never the bug-hunt brief)", () => {
    const verdict: TriageVerdict = {
      goals: [{ quote: "add dark mode across all panels", shape: "build", deliverable: "dark mode works", needsPlan: true }],
      constraints: [],
      confidence: "high",
    }
    const todos: TriageTodoRow[] = buildTriageTodoSkeleton(verdict, { armLocalization: false, hardness: "hard" })
    expect(todos).toHaveLength(2)
    expect(todos[0]!.content).toBe("add dark mode across all panels")
    expect(todos[1]!.parentID).toBe(0)
    // A hard build gets the forward-looking plan seed, regardless of arming.hardness.
    expect(todos[1]!.content).toBe(PLAN_SLICE_CONTENT)
    expect(todos.some((t) => t.content === LOCALIZATION_SLICE_CONTENT)).toBe(false)
  })

  it("a diagnosis-vague shaped goal also gets a frame seed, even without needsPlan", () => {
    const verdict: TriageVerdict = {
      goals: [{ quote: "something is slow sometimes", shape: "diagnosis-vague", deliverable: "cause identified" }],
      constraints: [],
      confidence: "high",
    }
    const todos = buildTriageTodoSkeleton(verdict, { armLocalization: true, hardness: "moderate" })
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
    const todos = buildTriageTodoSkeleton(verdict, { armLocalization: true, hardness: "moderate" })
    // write order: "first, needs a plan" (position 0), "second, depends on first" (position 1)
    expect(todos[0]!.content).toBe("first, needs a plan")
    expect(todos[1]!.content).toBe("second, depends on first")
    // the frame seed for "first, needs a plan" must point at ITS write position (0), not its original index (1).
    expect(todos[2]!.parentID).toBe(0)
  })

  it("at most one frame seed per kind — two needsPlan build goals collapse to ONE plan seed, parented to the first", () => {
    const verdict: TriageVerdict = {
      goals: [
        { quote: "goal one, needs plan", shape: "build", deliverable: "", needsPlan: true },
        { quote: "goal two, needs plan", shape: "build", deliverable: "", needsPlan: true },
      ],
      constraints: [],
      confidence: "high",
    }
    const todos = buildTriageTodoSkeleton(verdict, { armLocalization: false, hardness: "moderate" })
    // Both goals resolve to the same plan seed — cross-goal content dedup
    // collapses them to ONE planted seed, parented to the first goal.
    expect(todos).toHaveLength(3) // 2 root goals + 1 shared frame seed
    expect(todos.filter((t) => t.content === PLAN_SLICE_CONTENT)).toHaveLength(1)
    expect(todos.filter((t) => t.parentID === 0)).toHaveLength(1)
    expect(todos.filter((t) => t.parentID === 1)).toHaveLength(0)
  })

  it("duplicate-dispatch fix: two goals whose seeds resolve to the SAME content plant it once, parented to the first (case-2 live-fire, $0.112/36% of run)", () => {
    const verdict: TriageVerdict = {
      goals: [
        {
          quote: "the `SessionStore` cache and `flushQueue` worker disagree — writes during flush are dropped",
          shape: "diagnosis-vague",
          deliverable: "root cause found",
        },
        { quote: "the retry path also drops writes somewhere", shape: "diagnosis-vague", deliverable: "" },
      ],
      constraints: [],
      confidence: "high",
    }
    // Both diagnosis goals fire via the arming judge and resolve to the same
    // writer seed — dedup collapses them to ONE planted seed, parented to the first.
    const todos = buildTriageTodoSkeleton(verdict, { armLocalization: true, hardness: "hard" })
    expect(todos).toHaveLength(3) // 2 root goals + 1 shared frame seed
    expect(todos.filter((t) => t.content === LOCALIZATION_SLICE_CONTENT)).toHaveLength(1)
    expect(todos.filter((t) => t.parentID === 0)).toHaveLength(1)
    expect(todos.filter((t) => t.parentID === 1)).toHaveLength(0)
  })

  it("single-seed collapse (django-12050 fix): ONE diagnosis goal flagged needsPlan plants the localization seed only — needsPlan is ignored on the diagnosis branch", () => {
    const verdict: TriageVerdict = {
      goals: [
        {
          quote: "fix the race condition in cache invalidation",
          shape: "diagnosis-vague",
          deliverable: "race fixed",
          needsPlan: true,
        },
      ],
      constraints: [],
      confidence: "high",
    }
    // The vague-hard-race shape: a hard diagnosis goal never plants a planner
    // AND a localization seed — the judge owns the diagnosis branch outright.
    const todos = buildTriageTodoSkeleton(verdict, { armLocalization: true, hardness: "hard" })
    expect(todos).toHaveLength(2) // 1 root goal + 1 localization seed
    expect(todos.filter((t) => t.content === LOCALIZATION_SLICE_CONTENT)).toHaveLength(1)
    expect(todos.some((t) => t.content === PLAN_SLICE_CONTENT)).toBe(false)
  })

  it("mixed-kind turn (P12): a diagnosis-vague goal and a needsPlan build goal each get their OWN seed kind, parented per goal", () => {
    const verdict: TriageVerdict = {
      goals: [
        { quote: "the export sometimes truncates rows", shape: "diagnosis-vague", deliverable: "" },
        { quote: "then add streaming export across all report types", shape: "build", deliverable: "", needsPlan: true },
      ],
      constraints: [],
      confidence: "high",
    }
    const todos = buildTriageTodoSkeleton(verdict, { armLocalization: true, hardness: "hard" })
    expect(todos).toHaveLength(4) // 2 root goals + 1 seed per kind
    expect(todos.find((t) => t.content === LOCALIZATION_SLICE_CONTENT)!.parentID).toBe(0)
    expect(todos.find((t) => t.content === PLAN_SLICE_CONTENT)!.parentID).toBe(1)
  })

  it("django-12039 regression: a diagnosis-grounded goal with needsPlan:true but armLocalization:false plants NO seed — the judge, not needsPlan, owns diagnosis arming", () => {
    // The exact over-route: the bug names its own file → the arming judge (the
    // semantic authority) declines localization → but the conductor's blind
    // `needsPlan` flag would previously OR its way past the judge and force a
    // reasoner localization pre-pass. On a DIAGNOSIS goal the judge decides ALONE.
    const verdict: TriageVerdict = {
      goals: [
        {
          quote: "str() of the enum in django/db/models/enums.py returns the wrong value",
          shape: "diagnosis-grounded",
          deliverable: "str() returns the raw value",
          needsPlan: true,
        },
      ],
      constraints: [],
      confidence: "high",
    }
    const todos = buildTriageTodoSkeleton(verdict, { armLocalization: false, hardness: "trivial" })
    // Only the root goal — no frame/localization seed child.
    expect(todos).toHaveLength(1)
    expect(todos[0]!.content).toBe("str() of the enum in django/db/models/enums.py returns the wrong value")
    expect(todos.some((t) => t.content === LOCALIZATION_SLICE_CONTENT)).toBe(false)
    expect(todos.every((t) => t.parentID === undefined)).toBe(true)
  })

  it("S2 — repro-then-localization: a diagnosis goal needing both plants BOTH seeds, repro first, same parentID (django-11964 iter-3 / 11848 iter-2 fix)", () => {
    const verdict: TriageVerdict = {
      goals: [{ quote: "the importer rejects vCard files", shape: "diagnosis-vague", deliverable: "importer fixed" }],
      constraints: [],
      confidence: "high",
    }
    const todos = buildTriageTodoSkeleton(verdict, { armLocalization: true, armReproduction: true, hardness: "moderate" })
    expect(todos).toHaveLength(3)
    expect(todos[1]!.content).toBe(REPRO_SLICE_CONTENT)
    expect(todos[2]!.content).toBe(LOCALIZATION_SLICE_CONTENT)
    expect(todos[1]!.parentID).toBe(0)
    expect(todos[2]!.parentID).toBe(0)
  })

  it("S2 — needsRepro only (armLocalization:false) plants the repro seed only", () => {
    const verdict: TriageVerdict = {
      goals: [{ quote: "the importer rejects vCard files", shape: "diagnosis-vague", deliverable: "importer fixed" }],
      constraints: [],
      confidence: "high",
    }
    const todos = buildTriageTodoSkeleton(verdict, { armLocalization: false, armReproduction: true, hardness: "moderate" })
    expect(todos).toHaveLength(2)
    expect(todos[1]!.content).toBe(REPRO_SLICE_CONTENT)
    expect(todos.some((t) => t.content === LOCALIZATION_SLICE_CONTENT)).toBe(false)
  })

  it("S2 — armLocalization only (no repro need) plants the localization seed only", () => {
    const verdict: TriageVerdict = {
      goals: [{ quote: "the importer rejects vCard files", shape: "diagnosis-vague", deliverable: "importer fixed" }],
      constraints: [],
      confidence: "high",
    }
    const todos = buildTriageTodoSkeleton(verdict, { armLocalization: true, armReproduction: false, hardness: "moderate" })
    expect(todos).toHaveLength(2)
    expect(todos[1]!.content).toBe(LOCALIZATION_SLICE_CONTENT)
    expect(todos.some((t) => t.content === REPRO_SLICE_CONTENT)).toBe(false)
  })

  it("S2 — two diagnosis goals needing both seeds still dedup by content: ONE repro + ONE localization, both parented to the first", () => {
    const verdict: TriageVerdict = {
      goals: [
        { quote: "goal one", shape: "diagnosis-vague", deliverable: "" },
        { quote: "goal two", shape: "diagnosis-vague", deliverable: "" },
      ],
      constraints: [],
      confidence: "high",
    }
    const todos = buildTriageTodoSkeleton(verdict, { armLocalization: true, armReproduction: true, hardness: "hard" })
    expect(todos).toHaveLength(4) // 2 root goals + 1 repro + 1 localization
    expect(todos.filter((t) => t.content === REPRO_SLICE_CONTENT)).toHaveLength(1)
    expect(todos.filter((t) => t.content === LOCALIZATION_SLICE_CONTENT)).toHaveLength(1)
    expect(todos.filter((t) => t.parentID === 0)).toHaveLength(2)
    expect(todos.filter((t) => t.parentID === 1)).toHaveLength(0)
  })

  it("S2 — hasPinnedProbe:true restores today's behavior (localization, not repro) even when armReproduction is true", () => {
    const verdict: TriageVerdict = {
      goals: [{ quote: "the importer rejects vCard files", shape: "diagnosis-vague", deliverable: "importer fixed" }],
      constraints: [],
      confidence: "high",
    }
    const todos = buildTriageTodoSkeleton(
      verdict,
      { armLocalization: true, armReproduction: true, hardness: "moderate" },
      { hasPinnedProbe: true },
    )
    expect(todos).toHaveLength(2)
    expect(todos[1]!.content).toBe(LOCALIZATION_SLICE_CONTENT)
  })

  it("S2 — armReproduction absent (an older ArmingDecision literal) never seeds repro — today's behavior is preserved by default", () => {
    const verdict: TriageVerdict = {
      goals: [{ quote: "the importer rejects vCard files", shape: "diagnosis-vague", deliverable: "importer fixed" }],
      constraints: [],
      confidence: "high",
    }
    const todos = buildTriageTodoSkeleton(verdict, { armLocalization: true, hardness: "moderate" })
    expect(todos[1]!.content).toBe(LOCALIZATION_SLICE_CONTENT)
  })

  it("S2 — a build goal's PLAN seed is unaffected by armReproduction (repro applies to diagnosis goals only)", () => {
    const verdict: TriageVerdict = {
      goals: [{ quote: "add dark mode across all panels", shape: "build", deliverable: "dark mode works", needsPlan: true }],
      constraints: [],
      confidence: "high",
    }
    const todos = buildTriageTodoSkeleton(verdict, { armLocalization: false, armReproduction: true, hardness: "hard" })
    expect(todos[1]!.content).toBe(PLAN_SLICE_CONTENT)
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

// P3/Q-D — the research shape's two policy deltas: the researcher auto-cast
// on research-shaped turns, and the citation verifier (never the test rung).
describe("personaForSlice — P3 research-shaped default", () => {
  it("recon defaults to explorer on an ordinary turn and to the web-enabled researcher on a research-shaped turn", () => {
    const recon = { sliceType: "recon" } as const
    expect(personaForSlice(recon)).toBe("explorer")
    expect(personaForSlice(recon, { researchShaped: false })).toBe("explorer")
    expect(personaForSlice(recon, { researchShaped: true })).toBe("researcher")
  })

  it("the research default is recon-scoped: edit-work personas never flip on a research+build compound", () => {
    expect(personaForSlice({ sliceType: "mechanical" }, { researchShaped: true })).toBe("applier")
    expect(personaForSlice({ sliceType: "verify" }, { researchShaped: true })).toBe("runner")
    expect(personaForSlice({ sliceType: "design" }, { researchShaped: true })).toBe("procedure")
  })

  it("an explicit persona still wins over the research default", () => {
    expect(personaForSlice({ sliceType: "recon", persona: "explorer" }, { researchShaped: true })).toBe("explorer")
  })
})

describe("todosToLoopSlices — P3 research slices verify by citation, never the test rung", () => {
  it("a research-turn recon slice gets no sound-rung commands and pins testStrength untestable", async () => {
    const probes = fakeProbes("low", "testable")
    const slices = await todosToLoopSlices(
      [{ content: "look up the zod v4 migration guide and run `bun test` afterwards", status: "pending", sliceType: "recon" }],
      probes,
      undefined,
      { researchShaped: true },
    )
    expect(slices[0]).toMatchObject({ testStrength: "untestable" })
    expect(slices[0]!.verifyCommands).toBeUndefined()
    expect(slices[0]!.probeCommand).toBeUndefined()
    expect(probes.testStrengthCalls).toBe(0)
  })

  it("an explicitly researcher-persona slice routes identically even without the turn flag", async () => {
    const slices = await todosToLoopSlices(
      [{ content: "digest the changelog", status: "pending", sliceType: "recon", persona: "researcher" }],
      fakeProbes("low", "testable"),
    )
    expect(slices[0]).toMatchObject({ testStrength: "untestable" })
    expect(slices[0]!.verifyCommands).toBeUndefined()
  })

  it("a research+build compound keeps the build slice's test rung intact", async () => {
    const slices = await todosToLoopSlices(
      [
        { content: "look up the new API shape", status: "pending", sliceType: "recon" },
        { content: "apply the rename — verify with `bun test`", status: "pending", sliceType: "mechanical", testStrength: "testable" },
      ],
      fakeProbes("low", "testable"),
      undefined,
      { researchShaped: true },
    )
    const build = slices.find((s) => s.sliceType === "mechanical")!
    expect(build.testStrength).toBe("testable")
    expect(build.verifyCommands?.length ?? 0).toBeGreaterThan(0)
  })
})

describe("LOCALIZATION_PREPASS_TODO (the one diagnosis frame-seed constant)", () => {
  it("the seed constant is the same slice autoTypeTodos injects (one home for the shape) — a difficulty-allocated WRITER seat", () => {
    expect(LOCALIZATION_PREPASS_TODO).toMatchObject({
      content: LOCALIZATION_SLICE_CONTENT,
      status: "pending",
      priority: "high",
      sliceType: "mechanical",
      testStrength: "testable",
      persona: "applier",
    })
    // Un-pinned: no reasoner `need` — the tier is DIFFICULTY-allocated now.
    expect("need" in LOCALIZATION_PREPASS_TODO).toBe(false)
  })
})

describe("REPRO_PREPASS_TODO (S2 — the repro-authoring pre-pass constant)", () => {
  it("is deliberately UNTYPED so it never dispatches as a child slice — it runs inline on the conductor", () => {
    expect(REPRO_PREPASS_TODO).toMatchObject({ content: REPRO_SLICE_CONTENT, status: "pending", priority: "high" })
    expect("sliceType" in REPRO_PREPASS_TODO).toBe(false)
    expect("need" in REPRO_PREPASS_TODO).toBe(false)
    // Untyped ⇒ hasPendingTypedSlices never sees it as a dispatchable DAG node.
    expect(hasPendingTypedSlices([{ ...REPRO_PREPASS_TODO }])).toBe(false)
  })

  it("the content demands executed, right-reason red evidence and forbids git-adding the scratch script", () => {
    expect(REPRO_SLICE_CONTENT).toMatch(/RUN it/i)
    expect(REPRO_SLICE_CONTENT).toMatch(/EXPECTED behavior/)
    expect(REPRO_SLICE_CONTENT).toMatch(/FOR THE ISSUE'S REASON/)
    expect(REPRO_SLICE_CONTENT).toMatch(/never `git add`/i)
    expect(REPRO_SLICE_CONTENT).not.toBe(LOCALIZATION_SLICE_CONTENT)
  })

  // S8 (django-11790 strict run #3): the repro died on `ImportError: cannot
  // import name 'CustomEmailField'` — it imported from a tests module and
  // was placed inside tests/auth_tests/.
  it("the template places the repro at the repo ROOT and forbids importing from a tests module", () => {
    expect(REPRO_SLICE_CONTENT).toMatch(/repo ROOT \(never inside tests\/\)/)
    expect(REPRO_SLICE_CONTENT).toMatch(/importing ONLY from the installed package/i)
    expect(REPRO_SLICE_CONTENT).toMatch(/never from tests\.\* or a test module/i)
  })

  // F8 — exit-masking-proof probe pinning: models were running the repro as
  // `... | tail -30` or `...; echo "exit=$?"`, which always exits 0 and
  // silently defeats the red-check re-execution regardless of the real result.
  it("demands the repro run BARE (no tail/echo/git-stash masking) and every named symptom asserted", () => {
    expect(REPRO_SLICE_CONTENT).toMatch(/Run it BARE/)
    expect(REPRO_SLICE_CONTENT).toMatch(/exactly `python repro_issue\.py`/)
    expect(REPRO_SLICE_CONTENT).toMatch(/never `\| tail`/)
    expect(REPRO_SLICE_CONTENT).toMatch(/never `; echo "exit=\$\?"`/)
    expect(REPRO_SLICE_CONTENT).toMatch(/never wrapped in `git stash`/)
    expect(REPRO_SLICE_CONTENT).toMatch(/assert EVERY one of them/)
    expect(REPRO_SLICE_CONTENT).toMatch(/one assert per symptom/)
  })

  // django-11964: the issue text literally quoted `str(self.my_str_value)` but
  // the repro asserted a downstream model-field effect instead of that exact
  // expression — half-verified fix.
  it("demands asserting the issue's own literal quoted expression, not a downstream effect of it", () => {
    expect(REPRO_SLICE_CONTENT).toMatch(/assert THAT EXACT expression called on the exact object it names/)
    expect(REPRO_SLICE_CONTENT).toMatch(/not a downstream\/derived effect of it/)
  })

  // F14c — a repro for date-relative behavior could not go red because the
  // behavior only diverges under a mocked clock; control ambient inputs
  // (clock, timezone, locale, randomness) inside the repro itself.
  it("demands controlling ambient-environment inputs inside the repro so it fails deterministically today", () => {
    expect(REPRO_SLICE_CONTENT).toMatch(/ambient environment/i)
  })
})

describe("promptAuthorizesTestEdits (B3 — no-test-edit gate arming)", () => {
  // ROOT arming (prompt.ts) is `!promptAuthorizesTestEdits(userText)` — no
  // fix-shape gate: an enhancement-shaped prompt with zero defect words still
  // arms unless the user explicitly asked for test work (the 11885 "Combine
  // fast delete queries" gap — isFixShapedPrompt never fired, so the gate
  // never armed and the agent laundered a design divergence through the
  // test). isFixShapedPrompt and PROMPT_DEFECT_EVIDENCE_RE are deleted.
  it("an enhancement-shaped prompt with no defect words still arms — every turn is denied by default", () => {
    expect(promptAuthorizesTestEdits("add a --json flag to the export command")).toBe(false)
    expect(promptAuthorizesTestEdits("how does the session compaction ladder work?")).toBe(false)
    expect(
      promptAuthorizesTestEdits(
        "Combine fast delete queries. When emulating ON DELETE CASCADE via on_delete=models.CASCADE the deletion.Collector will try to perform fast queries which are DELETE FROM table WHERE table.pk IN .... There are cases where the query isn't fast.",
      ),
    ).toBe(false)
    expect(promptAuthorizesTestEdits("")).toBe(false)
  })

  it("an explicit test-work ask disarms — the release valve", () => {
    expect(promptAuthorizesTestEdits("update the flaky test in tests/foo")).toBe(true)
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

  // 11885 full-stack live fire: the fix-slice seed's own prose disarmed the
  // child gate — "a described fix; the test must actually pass" matched
  // verb→object across the semicolon, and "Never weaken, delete, skip, or
  // edit…" put the negation more than two plain words back. Engine-authored
  // boilerplate must NEVER read as authorization.
  it("clause boundaries break the verb→tests span (the 11885 seed live-fire bug)", () => {
    expect(promptAuthorizesTestEdits("do not stop at a described fix; the test must actually pass")).toBe(false)
    expect(promptAuthorizesTestEdits("apply the fix: the test suite is the arbiter")).toBe(false)
    expect(promptAuthorizesTestEdits("ship the fix — the tests define done")).toBe(false)
  })

  it("comma-separated verb enumerations under a negation stay prohibitions", () => {
    expect(promptAuthorizesTestEdits("Never weaken, delete, skip, or edit the failing test to make it pass")).toBe(
      false,
    )
    expect(promptAuthorizesTestEdits("never rename, rewrite or update the tests")).toBe(false)
  })

  // F4c — 11885 fire-3: triage constraints are quote-grounded (a ticket that
  // never mentions tests can't arm the gate) and optimization phrasing evades
  // the fix-shape regex; the verdict's own diagnosis shape is the evidence.
  it("diagnosis-shaped goals deny test edits even when the prompt never mentions tests", () => {
    const ticket =
      "Combine fast delete queries. When emulating ON DELETE CASCADE via on_delete=models.CASCADE the deletion.Collector will try to perform fast queries which are DELETE FROM table WHERE table.pk IN .... There are cases where the query isn't fast."
    expect(diagnosisDeniesTestEdits(["diagnosis-vague"], ticket)).toBe(true)
    expect(diagnosisDeniesTestEdits(["diagnosis-grounded", "qa"], ticket)).toBe(true)
  })

  it("diagnosis-shape denial yields to explicit test-work authorization and to non-diagnosis turns", () => {
    expect(diagnosisDeniesTestEdits(["diagnosis-vague"], "the delete path is slow — update the tests to cover it")).toBe(
      false,
    )
    expect(diagnosisDeniesTestEdits(["build"], "add a --json flag to the export command")).toBe(false)
    expect(diagnosisDeniesTestEdits([], "anything")).toBe(false)
  })

  it("no engine-authored prompt string authorizes test edits (registry sweep)", async () => {
    const registries = [
      await import("../../src/session/prompts/seeds"),
      await import("../../src/session/prompts/preambles"),
      await import("../../src/session/prompts/nudges"),
      await import("../../src/session/prompts/fragments"),
      await import("../../src/session/prompts/personas"),
      await import("../../src/session/prompts/roles"),
      await import("../../src/session/prompts/protocol"),
    ]
    for (const mod of registries)
      for (const [name, value] of Object.entries(mod))
        if (typeof value === "string" && value.length > 40)
          expect(promptAuthorizesTestEdits(value), `${name} must not self-authorize test edits`).toBe(false)
  })

  it("the batch-momentum nudge (L1.2c) never authorizes test edits", () => {
    expect(promptAuthorizesTestEdits(batchMomentumNudgeText({ consecutiveSingleCalls: 4 }))).toBe(false)
  })
})

describe("diagnosis pre-pass seat (a single reasoner WRITER slice — localize → fix → verify in one session)", () => {
  it("the writer brief demands localize + minimal fix + run-to-green, and forbids tampering with the test", () => {
    expect(LOCALIZATION_SLICE_CONTENT).toMatch(/LOCALIZE/)
    expect(LOCALIZATION_SLICE_CONTENT).toMatch(/apply the minimal edit/i)
    expect(LOCALIZATION_SLICE_CONTENT).toMatch(/RUN the failing\/pinned test/)
    expect(LOCALIZATION_SLICE_CONTENT).toMatch(/until it passes GREEN/)
    expect(LOCALIZATION_SLICE_CONTENT).toMatch(/Never weaken, delete, skip, or edit the failing test/i)
    expect(LOCALIZATION_SLICE_CONTENT).toMatch(/ranked candidate sites/i)
    // L1.2b — the localization framing pre-marks the orientation batch (probes ride in ONE message).
    expect(LOCALIZATION_SLICE_CONTENT).toMatch(/orientation probes .* as ONE message with multiple tool calls/i)
    // No trace of the old read-only shackle.
    expect(LOCALIZATION_SLICE_CONTENT).not.toMatch(/Do not write code/i)
    expect(LOCALIZATION_SLICE_CONTENT).not.toMatch(/deliver targets, mechanism, and strategy only/i)
    // django-11848: the fix used datetime.now() where the surrounding module's
    // idiom (and the hidden grader's mock) was datetime.utcnow() — copy the
    // module's existing environment-read idiom, never introduce a new one.
    expect(LOCALIZATION_SLICE_CONTENT).toMatch(/COPY the exact idiom the surrounding module already uses/i)
    // a fix byte-identical to the gold patch except for one added str()
    // wrapper failed the hidden grader three runs in a row — the issue never
    // asked for a type conversion and the gold fix has none; forbid gratuitous
    // conversions/reformatting and require passing values through unchanged.
    expect(LOCALIZATION_SLICE_CONTENT).toMatch(
      /never add an explicit type conversion \(str\(\)\/int\(\)\/float\(\)\/bytes\(\)\) or reformatting the issue did not ask for/i,
    )
    // F14c — a fix introduced `import time` alongside a module that already
    // imports `datetime`; the hidden test mocked the existing import, so the
    // new equivalent bypassed the mock and failed under test.
    expect(LOCALIZATION_SLICE_CONTENT).toMatch(/already-imported/i)
    // F14c — a fix deleted an existing `self.username_field` attribute while
    // fixing an unrelated line; five other methods read it, causing regressions.
    expect(LOCALIZATION_SLICE_CONTENT).toMatch(/scope-minimal/i)
  })

  it("the seed is a WRITER seat: mechanical/applier is not a decider seat and keeps edit+bash ALLOWED at the reasoner", () => {
    expect(LOCALIZATION_PREPASS_TODO.sliceType).toBe("mechanical")
    expect(personaForSlice(LOCALIZATION_PREPASS_TODO)).toBe("applier")
    // mechanical at reasoner is a worker seat (isDeciderSeat false) → grind tools stay on.
    expect(isDeciderSeat("reasoner", LOCALIZATION_PREPASS_TODO.sliceType)).toBe(false)
    const persona = personaForSlice(LOCALIZATION_PREPASS_TODO)
    // readOnly=false (mechanical is not a recon/verify lane), deciderSeat=false → edit+bash allow.
    const effective = Permission.merge([], childSlicePermission(undefined, false, persona, false))
    expect(Permission.evaluate("edit", "src/x.ts", effective).action).toBe("allow")
    expect(Permission.evaluate("bash", "python -m pytest -k failing", effective).action).toBe("allow")
  })

  it("the writer seed is DIFFICULTY-allocated: trivial → executor (gate declines), judge-rated hard → reasoner (gate opens)", async () => {
    // No pin: a trivial, already-located bug converts to a testable mechanical
    // slice that allocates to the CHEAP executor — the lone seed no longer
    // force-opens the benefit gate (the django-12039 over-route).
    const trivial = await todosToLoopSlices([LOCALIZATION_PREPASS_TODO], fakeProbes())
    expect(trivial).toHaveLength(1)
    expect(trivial[0]).toMatchObject({ id: LOCALIZATION_SLICE_CONTENT, sliceType: "mechanical", testStrength: "testable" })
    expect(trivial[0]!.need).toBeUndefined()
    expect(allocateSlice(trivial[0]!).tier).toBe("executor")
    expect(shouldOrchestrate(trivial)).toBe(false)

    // When the arming judge rates the bug genuinely hard, the difficulty floor
    // lifts the SAME seed to the reasoner and the gate opens on the allocated tier.
    const hard = await todosToLoopSlices([LOCALIZATION_PREPASS_TODO], fakeProbes(), { hardness: "hard" })
    expect(allocateSlice(hard[0]!).tier).toBe("reasoner")
    expect(shouldOrchestrate(hard)).toBe(true)
  })

  it("P12 — the plan seed mirrors the re-plan seed's decider shape (design/reasoner/researcher) with a forward-looking, edit-free brief", () => {
    expect(PLAN_PREPASS_TODO).toMatchObject({
      content: PLAN_SLICE_CONTENT,
      status: "pending",
      priority: "high",
      sliceType: "design",
      need: "reasoner",
      persona: "researcher",
    })
    expect(PLAN_SLICE_CONTENT).toMatch(/DAG of typed slices/i)
    expect(PLAN_SLICE_CONTENT).toMatch(/Writing code or diffs is forbidden/i)
    // Forward-looking, not a bug hunt and not a residue re-plan.
    expect(PLAN_SLICE_CONTENT).not.toMatch(/LOCALIZE|failing\/pinned test/)
    expect(PLAN_SLICE_CONTENT).not.toMatch(/unverified|previous pass/i)
  })

  it("P12 — all three engine seeds are pairwise distinct (the dedup-by-content rule)", () => {
    const contents = [LOCALIZATION_SLICE_CONTENT, REDECOMPOSITION_SLICE_CONTENT, PLAN_SLICE_CONTENT]
    expect(new Set(contents).size).toBe(3)
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

describe("normalizeProbeCommand (F8 — exit-masking-proof probe pinning)", () => {
  it("strips a trailing display-only `| tail` stage but keeps a preceding redirect", () => {
    expect(normalizeProbeCommand("python repro_issue.py 2>&1 | tail -30")).toBe("python repro_issue.py 2>&1")
  })

  it("strips a trailing `; echo \"exit=$?\"` segment", () => {
    expect(normalizeProbeCommand('cd /testbed && timeout 60 python repro_issue.py; echo "exit=$?"')).toBe(
      "cd /testbed && timeout 60 python repro_issue.py",
    )
  })

  it("strips only the FINAL `| tail` stage, leaving an earlier chained pipeline intact", () => {
    expect(
      normalizeProbeCommand("pip install pytz sqlparse 2>&1 | tail -3 && python repro_issue.py 2>&1 | tail -30"),
    ).toBe("pip install pytz sqlparse 2>&1 | tail -3 && python repro_issue.py 2>&1")
  })

  it("strips a chained `| tail` AND a trailing `; echo` in the same command", () => {
    expect(normalizeProbeCommand("python repro_issue.py | tail -5 ; echo x")).toBe("python repro_issue.py")
  })

  it("leaves an unrelated pipe stage untouched — `| grep` changes semantics", () => {
    expect(normalizeProbeCommand("python tests/runtests.py auth_tests -k max_length")).toBe(
      "python tests/runtests.py auth_tests -k max_length",
    )
    expect(normalizeProbeCommand("cmd | grep -c FAIL")).toBe("cmd | grep -c FAIL")
    // `||` (OR) is not a pipe — `|| tail` must never be split into a dangling `|`
    expect(normalizeProbeCommand("python x.py || tail -f log")).toBe("python x.py || tail -f log")
    expect(normalizeProbeCommand("python repro_issue.py")).toBe("python repro_issue.py")
  })
})

describe("canonicalScriptProbeCommand (F10 — decoration-immune canonical pinning)", () => {
  it("pins the canonical runner invocation, dropping a trailing display-only pipe", () => {
    expect(canonicalScriptProbeCommand("python repro_issue.py 2>&1 | tail -30")).toBe("python repro_issue.py")
  })

  it("keeps a leading `cd <dir> && ` prefix but drops env vars, timeout, and a trailing echo", () => {
    expect(
      canonicalScriptProbeCommand('cd /testbed && PYTHONPATH=/testbed timeout 60 python repro_issue.py; echo "exit=$?"'),
    ).toBe("cd /testbed && python repro_issue.py")
  })

  it("drops git-stash wrapping decoration entirely", () => {
    expect(
      canonicalScriptProbeCommand("git -C /testbed stash && python repro_issue.py 2>&1 | tail -8 ; git -C /testbed stash pop"),
    ).toBe("python repro_issue.py")
  })

  it("returns undefined for a named-test command — not a repro script", () => {
    expect(canonicalScriptProbeCommand("python tests/runtests.py auth_tests -k max_length")).toBeUndefined()
  })

  it("dispatches .mjs to node", () => {
    expect(canonicalScriptProbeCommand("node reproduce_bug.mjs | head -5")).toBe("node reproduce_bug.mjs")
    // A dir-qualified path must survive whole — pinning just the basename
    // would resolve against the wrong cwd and false-red on file-not-found
    expect(canonicalScriptProbeCommand("python /testbed/repro_issue.py 2>&1 | tail -3")).toBe(
      "python /testbed/repro_issue.py",
    )
  })
})

describe("deriveTurnProbe (M4)", () => {
  it("extracts the most-specific pinned reproduction from a bug prompt", async () => {
    const prompt = `
The enum's string conversion is wrong.

Bug: ChoicesTests.test_str fails intermittently on model_enums.

Repro:
\`python tests/runtests.py model_enums.tests.ChoicesTests.test_str\`

Expected: str() on a Choices member returns its human label, not the raw value.
`
    expect(await deriveTurnProbe({ promptText: prompt })).toEqual({
      probe: { kind: "test", command: "python tests/runtests.py model_enums.tests.ChoicesTests.test_str" },
    })
  })

  it("returns undefined when the prompt names no runnable reproduction and no candidates are given", async () => {
    const prompt = `
The app shows Suit.HEART instead of Hearts when rendering the enum.
str() on the \`Suit\` member returns the raw value instead of the label.
Please fix it — no need to run anything, it's obvious from the code.
`
    expect(await deriveTurnProbe({ promptText: prompt })).toBeUndefined()
  })

  it("prefers the more-specific file+filter command over a bare one in the same prompt", async () => {
    const prompt = `
Two commands are relevant here.

Sometimes people just sanity-check with \`bun test\`.

But the actual repro is:
\`bun test packages/foo/bar.test.ts -t "handles retry"\`
`
    expect(await deriveTurnProbe({ promptText: prompt })).toEqual({
      probe: { kind: "test", command: 'bun test packages/foo/bar.test.ts -t "handles retry"' },
    })
  })

  it("prefers a command named in the prompt over the red-state fallback, and never runs the candidates", async () => {
    const prompt = "Repro: `python tests/runtests.py model_enums.tests.ChoicesTests.test_str`"
    const runner: CommandRunner = async () => {
      throw new Error("should never be called — the prompt already named a repro")
    }
    const result = await deriveTurnProbe({
      promptText: prompt,
      candidateTests: [{ kind: "test", command: "bun test packages/foo/bar.test.ts" }],
      runner,
    })
    expect(result).toEqual({
      probe: { kind: "test", command: "python tests/runtests.py model_enums.tests.ChoicesTests.test_str" },
    })
  })

  it("falls back to the most-specific currently-RED candidate when the prompt names no command", async () => {
    const prompt = "The app shows the wrong label. Please fix it."
    const candidates: VerifyCommand[] = [
      { kind: "test", command: "bun test packages/foo" },
      { kind: "test", command: 'bun test packages/foo/bar.test.ts -t "handles retry"' },
    ]
    const results: Record<string, CommandResult> = {
      "bun test packages/foo": { exitCode: 1, stdout: "", stderr: "" },
      'bun test packages/foo/bar.test.ts -t "handles retry"': { exitCode: 1, stdout: "", stderr: "" },
    }
    const runner: CommandRunner = async (cmd) => results[cmd.command]!
    const result = await deriveTurnProbe({ promptText: prompt, candidateTests: candidates, runner })
    expect(result).toEqual({
      probe: { kind: "test", command: 'bun test packages/foo/bar.test.ts -t "handles retry"' },
      redEvidence: { exitCode: 1, outputTail: "" },
    })
  })

  it("returns undefined when every candidate is currently green (nothing to pin)", async () => {
    const candidates: VerifyCommand[] = [{ kind: "test", command: "bun test packages/foo/bar.test.ts" }]
    const runner: CommandRunner = async () => ({ exitCode: 0, stdout: "", stderr: "" })
    const result = await deriveTurnProbe({ promptText: "Fix the bug.", candidateTests: candidates, runner })
    expect(result).toBeUndefined()
  })

  it("returns undefined when candidates are given but no runner is injected", async () => {
    const candidates: VerifyCommand[] = [{ kind: "test", command: "bun test packages/foo/bar.test.ts" }]
    const result = await deriveTurnProbe({ promptText: "Fix the bug.", candidateTests: candidates })
    expect(result).toBeUndefined()
  })

  // F10 — a candidate naming an authored repro script now pins its CANONICAL
  // runner invocation (canonicalScriptProbeCommand), which drops the
  // exit-masking `2>&1 | tail -30` decoration entirely rather than merely
  // stripping the trailing pipe (F8's `normalizeProbeCommand`); the runner
  // must see the canonical command, and the pin it confirms red on must
  // carry that same canonical form.
  it("re-runs and pins the CANONICAL command, not the raw exit-masking candidate", async () => {
    const receivedCommands: string[] = []
    const candidates: VerifyCommand[] = [{ kind: "test", command: "python repro_issue.py 2>&1 | tail -30" }]
    const runner: CommandRunner = async (cmd) => {
      receivedCommands.push(cmd.command)
      return { exitCode: 1, stdout: "", stderr: "AssertionError" }
    }
    const result = await deriveTurnProbe({
      promptText: "The computation is off by one.",
      candidateTests: candidates,
      runner,
    })
    expect(receivedCommands).toEqual(["python repro_issue.py"])
    expect(result).toEqual({
      probe: { kind: "test", command: "python repro_issue.py" },
      redEvidence: { exitCode: 1, outputTail: "AssertionError" },
    })
  })

  it("pins the canonical command for a `| tail`-decorated repro-script candidate", async () => {
    const receivedCommands: string[] = []
    const candidates: VerifyCommand[] = [{ kind: "test", command: "python repro_issue.py | tail -3" }]
    const runner: CommandRunner = async (cmd) => {
      receivedCommands.push(cmd.command)
      return { exitCode: 1, stdout: "", stderr: "AssertionError" }
    }
    const result = await deriveTurnProbe({
      promptText: "The computation is off by one.",
      candidateTests: candidates,
      runner,
    })
    expect(receivedCommands).toEqual(["python repro_issue.py"])
    expect(result).toEqual({
      probe: { kind: "test", command: "python repro_issue.py" },
      redEvidence: { exitCode: 1, outputTail: "AssertionError" },
    })
  })

  // F8 fallback — a named-test candidate (not a repro script) still goes
  // through normalizeProbeCommand's enumerated strip list, unchanged by F10.
  it("falls back to the F8-normalized command for a named-test candidate", async () => {
    const receivedCommands: string[] = []
    const candidates: VerifyCommand[] = [{ kind: "test", command: "python tests/runtests.py x.y -k z | tail -20" }]
    const runner: CommandRunner = async (cmd) => {
      receivedCommands.push(cmd.command)
      return { exitCode: 1, stdout: "", stderr: "AssertionError" }
    }
    const result = await deriveTurnProbe({
      promptText: "The computation is off by one.",
      candidateTests: candidates,
      runner,
    })
    expect(receivedCommands).toEqual(["python tests/runtests.py x.y -k z"])
    expect(result).toEqual({
      probe: { kind: "test", command: "python tests/runtests.py x.y -k z" },
      redEvidence: { exitCode: 1, outputTail: "AssertionError" },
    })
  })

  // F13f — a non-zero exit whose output is the shell's own file-not-found
  // signature is a phantom red: the script was never actually executed
  // against real logic, so the candidate must be skipped, never pinned.
  it("skips (never pins) a candidate whose non-zero exit is a phantom file-not-found, not a real red", async () => {
    const candidates: VerifyCommand[] = [{ kind: "test", command: "python repro_issue.py" }]
    const runner: CommandRunner = async () => ({
      exitCode: 2,
      stdout: "",
      stderr: "python: can't open file '/testbed/repro_issue.py': [Errno 2] No such file or directory",
    })
    const result = await deriveTurnProbe({
      promptText: "The computation is off by one.",
      candidateTests: candidates,
      runner,
    })
    expect(result).toBeUndefined()
  })

  // F15b — same discipline, a different phantom-red shape: a
  // ModuleNotFoundError means the interpreter running the candidate can't
  // even import the touched package, so this exit proves nothing either.
  it("skips (never pins) a candidate whose non-zero exit is a phantom module-not-found, not a real red", async () => {
    const candidates: VerifyCommand[] = [{ kind: "test", command: "python repro_issue.py" }]
    const runner: CommandRunner = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "Traceback (most recent call last):\nModuleNotFoundError: No module named 'django'",
    })
    const result = await deriveTurnProbe({
      promptText: "The computation is off by one.",
      candidateTests: candidates,
      runner,
    })
    expect(result).toBeUndefined()
  })

  it("still pins a non-phantom non-zero exit (a real AssertionError) alongside a phantom candidate", async () => {
    const candidates: VerifyCommand[] = [
      { kind: "test", command: "python repro_issue.py" },
      { kind: "test", command: 'bun test packages/foo/bar.test.ts -t "handles retry"' },
    ]
    const results: Record<string, CommandResult> = {
      "python repro_issue.py": {
        exitCode: 2,
        stdout: "",
        stderr: "python: can't open file 'repro_issue.py': [Errno 2] No such file or directory",
      },
      'bun test packages/foo/bar.test.ts -t "handles retry"': {
        exitCode: 1,
        stdout: "",
        stderr: "AssertionError",
      },
    }
    const runner: CommandRunner = async (cmd) => results[cmd.command]!
    const result = await deriveTurnProbe({
      promptText: "The computation is off by one.",
      candidateTests: candidates,
      runner,
    })
    expect(result).toEqual({
      probe: { kind: "test", command: 'bun test packages/foo/bar.test.ts -t "handles retry"' },
      redEvidence: { exitCode: 1, outputTail: "AssertionError" },
    })
  })
})

describe("MODULE_MISSING_RE / missingModuleFromOutput (F15b)", () => {
  it("matches the py3 ModuleNotFoundError shape and extracts the module name", () => {
    const output = "Traceback (most recent call last):\nModuleNotFoundError: No module named 'django'"
    expect(MODULE_MISSING_RE.test(output)).toBe(true)
    expect(missingModuleFromOutput(output)).toBe("django")
  })

  it("matches the ImportError shape (unquoted module name) and extracts it", () => {
    const output = "ImportError: No module named asgiref"
    expect(MODULE_MISSING_RE.test(output)).toBe(true)
    expect(missingModuleFromOutput(output)).toBe("asgiref")
  })

  it("extracts a dotted submodule name", () => {
    const output = "ModuleNotFoundError: No module named 'django.core.exceptions'"
    expect(missingModuleFromOutput(output)).toBe("django.core.exceptions")
  })

  it("does not match an unrelated exception", () => {
    const output = "AttributeError: 'NoneType' object has no attribute 'foo'"
    expect(MODULE_MISSING_RE.test(output)).toBe(false)
    expect(missingModuleFromOutput(output)).toBeNull()
  })

  it("returns null for output with no module-missing signature", () => {
    expect(missingModuleFromOutput("AssertionError: expected 1 got 2")).toBeNull()
  })
})

describe("canonicalCommandForScript (F13d — engine-initiated probe's runner mapping)", () => {
  it("maps a known scratch-script extension to its canonical runner invocation", () => {
    expect(canonicalCommandForScript("repro_issue.py")).toBe("python repro_issue.py")
    expect(canonicalCommandForScript("repro_issue.js")).toBe("node repro_issue.js")
    expect(canonicalCommandForScript("repro_issue.mjs")).toBe("node repro_issue.mjs")
    expect(canonicalCommandForScript("repro_issue.ts")).toBe("bun repro_issue.ts")
    expect(canonicalCommandForScript("repro_issue.sh")).toBe("sh repro_issue.sh")
    expect(canonicalCommandForScript("repro_issue.rb")).toBe("ruby repro_issue.rb")
  })

  it("returns undefined for an extension with no known runner", () => {
    expect(canonicalCommandForScript("repro_issue.txt")).toBeUndefined()
  })
})

describe("isReproScratchPath (S8 — scratch repro writes are evidence, not fixes)", () => {
  it("matches agent-authored scratch repro scripts, at root or nested", () => {
    expect(isReproScratchPath("repro_issue.py")).toBe(true)
    expect(isReproScratchPath("tests/auth_tests/repro_maxlength_regression.py")).toBe(true)
    expect(isReproScratchPath("reproduce-crash.sh")).toBe(true)
  })
  it("does not match product source or ordinary test files", () => {
    expect(isReproScratchPath("django/contrib/auth/forms.py")).toBe(false)
    expect(isReproScratchPath("src/session/prompt.ts")).toBe(false)
    expect(isReproScratchPath("tests/auth_tests/test_forms.py")).toBe(false)
  })
  it("matches a repro-named DIRECTORY segment anywhere in the path (django-11885 round C: a scaffolded scratch app)", () => {
    expect(isReproScratchPath("_repro_app/models.py")).toBe(true)
    expect(isReproScratchPath("repro_app/models.py")).toBe(true)
    expect(isReproScratchPath("repro/conftest.py")).toBe(true)
  })
  it("does not match a directory that merely starts with 'repro'/'reproduce' without an underscore break, or real product source", () => {
    expect(isReproScratchPath("reports/models.py")).toBe(false)
    expect(isReproScratchPath("reproducibility/utils.py")).toBe(false)
    expect(isReproScratchPath("django/db/models/deletion.py")).toBe(false)
  })
})

describe("reproSpecificity via deriveTurnProbe (S1 — authored repro scripts qualify as pins)", () => {
  it("an authored repro script (`repro_issue.py`) pins RED, carrying redEvidence", async () => {
    const candidates: VerifyCommand[] = [{ kind: "test", command: "python repro_issue.py" }]
    const runner: CommandRunner = async () => ({
      exitCode: 1,
      stdout: "AssertionError: expected 255, got 254",
      stderr: "",
    })
    const result = await deriveTurnProbe({
      promptText: "The computation is off by one.",
      candidateTests: candidates,
      runner,
    })
    expect(result).toEqual({
      probe: { kind: "test", command: "python repro_issue.py" },
      redEvidence: { exitCode: 1, outputTail: "AssertionError: expected 255, got 254" },
    })
  })

  it("a repro script GREEN on unpatched code cannot pin (the 11964 false-green shape)", async () => {
    const candidates: VerifyCommand[] = [{ kind: "test", command: "python repro_issue.py" }]
    const runner: CommandRunner = async () => ({ exitCode: 0, stdout: "", stderr: "" })
    const result = await deriveTurnProbe({
      promptText: "The computation is off by one.",
      candidateTests: candidates,
      runner,
    })
    expect(result).toBeUndefined()
  })

  it("a bare whole-suite command never qualifies as a repro, script name or not", async () => {
    const candidates: VerifyCommand[] = [{ kind: "test", command: "bun test" }]
    const runner: CommandRunner = async () => {
      throw new Error("should never run — a whole-suite command scores 0, never a repro candidate")
    }
    const result = await deriveTurnProbe({ promptText: "Fix the bug.", candidateTests: candidates, runner })
    expect(result).toBeUndefined()
  })

  it("a named test file still outranks a repro script when both are RED candidates", async () => {
    const candidates: VerifyCommand[] = [
      { kind: "test", command: "python repro_issue.py" },
      { kind: "test", command: "python tests/runtests.py model_enums.tests.ChoicesTests.test_str" },
    ]
    const results: Record<string, CommandResult> = {
      "python repro_issue.py": { exitCode: 1, stdout: "", stderr: "" },
      "python tests/runtests.py model_enums.tests.ChoicesTests.test_str": { exitCode: 1, stdout: "", stderr: "" },
    }
    const runner: CommandRunner = async (cmd) => results[cmd.command]!
    const result = await deriveTurnProbe({ promptText: "Fix the bug.", candidateTests: candidates, runner })
    expect(result).toEqual({
      probe: { kind: "test", command: "python tests/runtests.py model_enums.tests.ChoicesTests.test_str" },
      redEvidence: { exitCode: 1, outputTail: "" },
    })
  })
})

describe("runTurnProbeGate (M4)", () => {
  const probe: VerifyCommand = { kind: "test", command: "bun test packages/foo/bar.test.ts" }

  /** A fake CommandRunner keyed on the exact command string; throws on an unscripted command. */
  function scriptedRunner(map: Record<string, CommandResult>): { runner: CommandRunner; calls: string[] } {
    const calls: string[] = []
    const runner: CommandRunner = async (cmd) => {
      calls.push(cmd.command)
      const result = map[cmd.command]
      if (!result) throw new Error(`scriptedRunner: no response scripted for "${cmd.command}"`)
      return result
    }
    return { runner, calls }
  }

  it("accepts when the probe passes", async () => {
    const { runner } = scriptedRunner({
      [probe.command]: { exitCode: 0, stdout: "", stderr: "" },
    })
    const result = await runTurnProbeGate({ probe, noTestEdit: false, runner })
    expect(result).toEqual({ reject: false, outputTail: "" })
  })

  it("rejects at the probe rung when the probe still fails", async () => {
    const { runner } = scriptedRunner({
      [probe.command]: { exitCode: 1, stdout: "", stderr: "AssertionError: expected 'Hearts', got 'HEART'" },
    })
    const result = await runTurnProbeGate({ probe, noTestEdit: false, runner })
    expect(result.reject).toBe(true)
    expect(result.rung).toBe("probe")
    expect(result.exitCode).toBe(1)
    expect(result.reason).toContain("STILL FAILING")
  })

  it("rejects at the test-tree rung when noTestEdit and the guard fails — short-circuits before the probe", async () => {
    const { runner, calls } = scriptedRunner({
      [TEST_TREE_GUARD_COMMAND.command]: { exitCode: 1, stdout: "tests/foo.test.ts", stderr: "" },
      [probe.command]: { exitCode: 0, stdout: "", stderr: "" },
    })
    const result = await runTurnProbeGate({ probe, noTestEdit: true, runner })
    expect(result.reject).toBe(true)
    expect(result.rung).toBe("test-tree")
    expect(result.rung).not.toBe("probe")
    expect(calls).toEqual([TEST_TREE_GUARD_COMMAND.command])
  })

  it("accepts when noTestEdit and both the guard and the probe pass", async () => {
    const { runner, calls } = scriptedRunner({
      [TEST_TREE_GUARD_COMMAND.command]: { exitCode: 0, stdout: "", stderr: "" },
      [probe.command]: { exitCode: 0, stdout: "", stderr: "" },
    })
    const result = await runTurnProbeGate({ probe, noTestEdit: true, runner })
    expect(result).toEqual({ reject: false, outputTail: "" })
    expect(calls).toEqual([TEST_TREE_GUARD_COMMAND.command, probe.command])
  })

  // -- S9 missing-file reason -------------------------------------------------

  it("names the missing pinned file when the probe fails with exit 2 + a 'can't open file' tail", async () => {
    const scriptProbe: VerifyCommand = { kind: "test", command: "python repro_issue.py" }
    const { runner } = scriptedRunner({
      [scriptProbe.command]: {
        exitCode: 2,
        stdout: "",
        stderr: "python: can't open file 'repro_issue.py': [Errno 2] No such file or directory",
      },
    })
    const result = await runTurnProbeGate({ probe: scriptProbe, noTestEdit: false, runner })
    expect(result.reject).toBe(true)
    expect(result.rung).toBe("probe")
    expect(result.exitCode).toBe(2)
    expect(result.reason).toContain("repro_issue.py")
    expect(result.reason).toContain("is missing")
    expect(result.reason).not.toContain("STILL FAILING")
  })

  it("keeps the generic STILL FAILING reason for a normal assertion failure (not a missing-file signature)", async () => {
    const scriptProbe: VerifyCommand = { kind: "test", command: "python repro_issue.py" }
    const { runner } = scriptedRunner({
      [scriptProbe.command]: { exitCode: 1, stdout: "", stderr: "AssertionError: expected 255, got '255'" },
    })
    const result = await runTurnProbeGate({ probe: scriptProbe, noTestEdit: false, runner })
    expect(result.reject).toBe(true)
    expect(result.reason).toContain("STILL FAILING")
    expect(result.reason).not.toContain("is missing")
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

describe("todosToLoopSlices — pinned reproduction / probeCommand (task #7 probe rung)", () => {
  it("a mechanical fix slice's own targeted repro (a specific test file) is pinned as probeCommand", async () => {
    const probes = fakeProbes("low", "testable")
    const slices = await todosToLoopSlices(
      [
        {
          content: "Fix the null check in checkout.ts; repro: `bun test e2e/checkout.test.ts`",
          status: "pending",
          sliceType: "mechanical",
        },
      ],
      probes,
    )
    expect(slices[0]!.probeCommand).toEqual({ kind: "test", command: "bun test e2e/checkout.test.ts" })
    // Still populates the generic sound-rung spec too — probeCommand is additive, not a substitute.
    expect(slices[0]!.verifyCommands).toEqual([
      TEST_TREE_GUARD_COMMAND,
      { kind: "test", command: "bun test e2e/checkout.test.ts" },
    ])
  })

  it("a targeted repro via a -t filter (no file path) is also pinned", async () => {
    const probes = fakeProbes("low", "untestable")
    const slices = await todosToLoopSlices(
      [{ content: 'Fix it; repro: `bun test -t "handles empty cart"`', status: "pending", sliceType: "mechanical" }],
      probes,
    )
    expect(slices[0]!.probeCommand).toEqual({ kind: "test", command: 'bun test -t "handles empty cart"' })
  })

  it("falls back to an upstream dependency's content when the fix slice's own text names no repro", async () => {
    const probes = fakeProbes("low", "testable")
    const todos: OrchestrationTodo[] = [
      {
        content: "Localize the defect; confirmed repro: `bun test packages/core/foo.test.ts -t \"case\"`",
        status: "pending",
        sliceType: "design",
      },
      {
        content: "Fix the bug identified above",
        status: "pending",
        sliceType: "mechanical",
        deps: ["todo_1"],
      },
    ]
    const slices = await todosToLoopSlices(todos, probes)
    expect(slices[1]!.probeCommand).toEqual({ kind: "test", command: 'bun test packages/core/foo.test.ts -t "case"' })
  })

  it("a bare typecheck/lint/whole-suite command is NOT pinned as probeCommand, but still populates verifyCommands", async () => {
    const probes = fakeProbes("low", "testable")
    const slices = await todosToLoopSlices(
      [
        {
          content: "Fix the bug; verify with `bun run typecheck` and `bun test`",
          status: "pending",
          sliceType: "mechanical",
        },
      ],
      probes,
    )
    expect(slices[0]!.probeCommand).toBeUndefined()
    expect(slices[0]!.verifyCommands).toEqual([
      TEST_TREE_GUARD_COMMAND,
      { kind: "typecheck", command: "bun run typecheck" },
      { kind: "test", command: "bun test" },
    ])
  })

  it("no identifiable reproduction anywhere leaves probeCommand unset — never fabricated", async () => {
    const probes = fakeProbes("low", "untestable")
    const slices = await todosToLoopSlices(
      [{ content: "Fix the off-by-one in the pagination helper", status: "pending", sliceType: "mechanical" }],
      probes,
    )
    expect(slices[0]!.probeCommand).toBeUndefined()
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

describe("sliceStepBudget — the diagnosis pre-pass writer gets its own allowance", () => {
  it("P8 table — design/hard/escalated each lift the budget ×1.5 (ceil); plain slices keep the persona base", () => {
    const rows: Array<{
      persona: Parameters<typeof sliceStepBudget>[0]
      sliceId?: string
      opts?: Parameters<typeof sliceStepBudget>[2]
      expected: number
    }> = [
      // no opts / empty opts → persona base
      { persona: "applier", expected: PERSONA_STEP_BUDGET.applier },
      { persona: "runner", opts: {}, expected: PERSONA_STEP_BUDGET.runner },
      // mechanical, not hard, first attempt → base even with opts present
      { persona: "applier", opts: { sliceType: "mechanical", hard: false, escalated: false }, expected: PERSONA_STEP_BUDGET.applier },
      // design slice → ×1.5
      { persona: "researcher", opts: { sliceType: "design" }, expected: Math.ceil(PERSONA_STEP_BUDGET.researcher * 1.5) },
      // judge-rated-hard turn → ×1.5
      { persona: "explorer", opts: { hard: true }, expected: Math.ceil(PERSONA_STEP_BUDGET.explorer * 1.5) },
      // escalated rescue → ×1.5
      { persona: "applier", opts: { escalated: true }, expected: Math.ceil(PERSONA_STEP_BUDGET.applier * 1.5) },
      // stacked signals never compound — still ×1.5
      { persona: "author", opts: { sliceType: "design", hard: true, escalated: true }, expected: Math.ceil(PERSONA_STEP_BUDGET.author * 1.5) },
      // the frame writer's own allowance also rides the hard-tail bump
      { persona: "applier", sliceId: LOCALIZATION_SLICE_CONTENT, opts: { hard: true }, expected: Math.ceil(FRAME_SLICE_STEP_BUDGET * 1.5) },
    ]
    for (const row of rows) expect(sliceStepBudget(row.persona, row.sliceId, row.opts)).toBe(row.expected)
  })

  it("the writer pre-pass gets FRAME_SLICE_STEP_BUDGET regardless of persona", () => {
    expect(sliceStepBudget("researcher", LOCALIZATION_SLICE_CONTENT)).toBe(FRAME_SLICE_STEP_BUDGET)
    // The writer must localize AND fix AND iterate, so its budget clears the read-only floor.
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

  // L4.2 degraded stand-down (11964): a degraded turn-read (DEGRADED_ARMING,
  // `degraded:true`) keeps the conductor INLINE — its own mid-turn todos, even a
  // typed DAG that would otherwise engage, must not orchestrate into tiered
  // slices (that structural-cell allocation bought a 3.5× overrun on an ex-solo
  // ticket). The grind valve's design prepass is the sole exception.
  it("degraded turn: conductor mid-turn todos stay inline — no orchestration, zero dispatch", async () => {
    let dispatched = 0
    let standDown: { conductorTodos: number; grindEscapeHatch: boolean } | undefined
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
      setTodoStatus: async () => {},
      arming: { degraded: true },
      onDegradedStandDown: (info) => {
        standDown = info
      },
      options: { runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
    })
    expect(res.engaged).toBe(false)
    expect(dispatched).toBe(0)
    expect(standDown).toEqual({ conductorTodos: 2, grindEscapeHatch: false })
  })

  it("degraded turn: the grind-valve design prepass STILL orchestrates; conductor todos stay inline", async () => {
    const dispatchedIds: string[] = []
    let standDown: { conductorTodos: number; grindEscapeHatch: boolean } | undefined
    const res = await runConductorOrchestration({
      getTodos: async () => [
        { content: "a", status: "pending", sliceType: "mechanical", coupling: "low", testStrength: "testable" },
        GRIND_DESIGN_PREPASS_TODO,
      ],
      probes: fakeProbes(),
      dispatch: async (req) => {
        dispatchedIds.push(req.sliceId)
        return { text: "design done", parts: [] }
      },
      setTodoStatus: async () => {},
      arming: { degraded: true },
      onDegradedStandDown: (info) => {
        standDown = info
      },
      options: { runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
    })
    // The valve's escape hatch orchestrates; the conductor's own todo never does.
    expect(res.engaged).toBe(true)
    expect(dispatchedIds).toContain(GRIND_DESIGN_SLICE_CONTENT)
    expect(dispatchedIds).not.toContain("a")
    expect(standDown).toEqual({ conductorTodos: 1, grindEscapeHatch: true })
  })

  it("healthy turn (non-degraded arming): a typed DAG orchestrates unchanged, no stand-down", async () => {
    let dispatched = 0
    let stoodDown = false
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
      setTodoStatus: async () => {},
      arming: { hardness: "trivial", ambiguity: "clear" },
      onDegradedStandDown: () => {
        stoodDown = true
      },
      options: { runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
    })
    expect(res.engaged).toBe(true)
    expect(dispatched).toBeGreaterThanOrEqual(2)
    expect(stoodDown).toBe(false)
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

describe("runConductorOrchestration — #53/#54 resolution gate", () => {
  let sid = 0
  const nextSessionID = () => `resolution-gate-test-${++sid}`

  // Two independent typed slices — a real parallel wave, so the OL-9.5c
  // benefit gate passes and dispatch actually reaches the loop whenever the
  // resolution gate takes the decompose-now path.
  const dispatchableTodos: OrchestrationTodo[] = [
    { content: "alpha", status: "pending", sliceType: "mechanical", coupling: "low", testStrength: "testable" },
    { content: "beta", status: "pending", sliceType: "mechanical", coupling: "low", testStrength: "testable" },
  ]

  // A structurally-invalid candidate plan for validatePlan's structural-only
  // check: mutual `deps` refs form a two-node cycle (cycle detection runs
  // regardless of requireNodeFields). todosToLoopSlices' own cycle backstop
  // (stage-DAG fallback) still converts this into two independent slices, so
  // the decompose-now path (once reached) dispatches normally.
  const cyclicTodos: OrchestrationTodo[] = [
    { content: "a", status: "pending", sliceType: "mechanical", deps: ["b"] },
    { content: "b", status: "pending", sliceType: "mechanical", deps: ["a"] },
  ]

  afterEach(() => {
    delete process.env["OPENCODE_HEADLESS"]
  })

  it("not flagged (clear/trivial) → decompose unchanged, gate never runs", async () => {
    let dispatched = 0
    let gateCalls = 0
    const res = await runConductorOrchestration({
      getTodos: async () => dispatchableTodos,
      probes: fakeProbes(),
      dispatch: async () => {
        dispatched++
        return { text: "ok", parts: [] }
      },
      setTodoStatus: async () => {},
      sessionID: nextSessionID(),
      arming: { hardness: "trivial", ambiguity: "clear" },
      onResolutionGate: () => {
        gateCalls++
      },
    })
    expect(gateCalls).toBe(0)
    expect(dispatched).toBeGreaterThan(0)
    expect(res.fellBack).toBeUndefined()
  })

  it("P4 — a continuation turn stands the gate down: flagged inherited arming + invalid plan still decomposes, no resolve-first", async () => {
    let dispatched = 0
    let gateCalls = 0
    const res = await runConductorOrchestration({
      getTodos: async () => cyclicTodos,
      probes: fakeProbes(),
      dispatch: async () => {
        dispatched++
        return { text: "ok", parts: [] }
      },
      setTodoStatus: async () => {},
      sessionID: nextSessionID(),
      // The inherited (stored) arming decision may still read hard/ambiguous —
      // the continuation flag alone must stand the gate down.
      arming: { hardness: "hard", ambiguity: "ambiguous" },
      continuation: true,
      onResolutionGate: () => {
        gateCalls++
      },
    })
    expect(gateCalls).toBe(0)
    expect(dispatched).toBeGreaterThan(0)
    expect(res.fellBack).toBeUndefined()
  })

  it("flagged + structurally valid candidate plan → decompose unchanged (short-circuit)", async () => {
    let dispatched = 0
    let captured: { mode: string; candidatePlanValid?: boolean } | undefined
    await runConductorOrchestration({
      getTodos: async () => dispatchableTodos,
      probes: fakeProbes(),
      dispatch: async () => {
        dispatched++
        return { text: "ok", parts: [] }
      },
      setTodoStatus: async () => {},
      sessionID: nextSessionID(),
      arming: { hardness: "hard", ambiguity: "ambiguous" },
      onResolutionGate: (info) => {
        captured = info
      },
    })
    expect(captured?.mode).toBe("decompose-now")
    expect(captured?.candidatePlanValid).toBe(true)
    expect(dispatched).toBeGreaterThan(0)
  })

  it("flagged + invalid plan + attempts 0 + interactive → resolve-first: design pre-pass seeded, no slice", async () => {
    delete process.env["OPENCODE_HEADLESS"]
    let dispatched = 0
    let seeded: OrchestrationTodo | undefined
    let asked = 0
    let captured: { mode: string } | undefined
    const res = await runConductorOrchestration({
      getTodos: async () => cyclicTodos,
      probes: fakeProbes(),
      dispatch: async () => {
        dispatched++
        return { text: "ok", parts: [] }
      },
      setTodoStatus: async () => {},
      sessionID: nextSessionID(),
      arming: { hardness: "hard", ambiguity: "ambiguous" },
      appendTodos: async (seed) => {
        seeded = seed
      },
      askUser: () => {
        asked++
      },
      onResolutionGate: (info) => {
        captured = info
      },
    })
    expect(captured?.mode).toBe("resolve-first")
    // P12 residual case: this turn is flagged hard/ambiguous but NOT an armed
    // diagnosis (no armLocalization), so the resolution pass resolves by
    // producing the plan — never by hunting a bug that does not exist.
    expect(seeded?.content).toBe(PLAN_SLICE_CONTENT)
    expect(asked).toBe(0)
    expect(dispatched).toBe(0)
    expect(res.engaged).toBe(false)
  })

  it("P6a wiring: a blocked dependent's todo settles cancelled — never completed or failed", async () => {
    const finalStatus = new Map<number, string>()
    // alpha terminal-fails (its verify command always exits 1, ladder exhausts
    // to unverified); beta depends on alpha → blocked, never dispatched.
    const todos: OrchestrationTodo[] = [
      { content: "alpha — verify with `tsc --noEmit`", status: "pending", sliceType: "mechanical", coupling: "low", testStrength: "testable" },
      { content: "beta builds on alpha", status: "pending", sliceType: "mechanical", coupling: "low", testStrength: "testable", deps: ["alpha — verify with `tsc --noEmit`"] },
    ]
    const dispatched: string[] = []
    const res = await runConductorOrchestration({
      getTodos: async () => todos,
      probes: fakeProbes(),
      dispatch: async (req) => {
        dispatched.push(req.sliceId)
        return { text: "attempt", parts: [] }
      },
      setTodoStatus: async (idx, status) => {
        finalStatus.set(idx, status)
      },
      sessionID: nextSessionID(),
      goalCount: 2, // clears the benefit gate for a 2-slice series chain
      arming: { hardness: "trivial", ambiguity: "clear" },
      options: { runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "verify failed" }) },
    })
    expect(res.engaged).toBe(true)
    // beta never dispatched...
    expect(dispatched.some((id) => id.startsWith("beta"))).toBe(false)
    // ...alpha (attempted, settled unverified) completes; beta cancels.
    expect(finalStatus.get(0)).toBe("completed")
    expect(finalStatus.get(1)).toBe("cancelled")
  })

  it("resolve-first on an ARMED diagnosis re-seeds the localization writer pre-pass", async () => {
    let seeded: OrchestrationTodo | undefined
    let captured: { mode: string } | undefined
    await runConductorOrchestration({
      getTodos: async () => cyclicTodos,
      probes: fakeProbes(),
      dispatch: async () => ({ text: "ok", parts: [] }),
      setTodoStatus: async () => {},
      sessionID: nextSessionID(),
      arming: { armLocalization: true, hardness: "hard", ambiguity: "ambiguous" },
      appendTodos: async (seed) => {
        seeded = seed
      },
      onResolutionGate: (info) => {
        captured = info
      },
    })
    expect(captured?.mode).toBe("resolve-first")
    expect(seeded?.content).toBe(LOCALIZATION_SLICE_CONTENT)
  })

  it("ARMED + one prior localization pass → continue-inline: never decomposes even with a valid plan, no dispatch/append/ask (grind valve is the only escalation)", async () => {
    const sessionID = nextSessionID()
    incResolveAttempts(sessionID) // one prior armed localization pass (resolveAttempts=1)
    let dispatched = 0
    let appended = 0
    let asked = 0
    let captured: { mode: string } | undefined
    const res = await runConductorOrchestration({
      // dispatchableTodos form a structurally valid plan — a non-armed turn
      // would short-circuit to decompose-now and dispatch; the armed branch
      // must bypass that and continue inline instead (11885 0/4-vs-3/3 fix).
      getTodos: async () => dispatchableTodos,
      probes: fakeProbes(),
      dispatch: async () => {
        dispatched++
        return { text: "ok", parts: [] }
      },
      setTodoStatus: async () => {},
      sessionID,
      arming: { armLocalization: true, hardness: "hard", ambiguity: "ambiguous" },
      appendTodos: async () => {
        appended++
      },
      askUser: () => {
        asked++
      },
      onResolutionGate: (info) => {
        captured = info
      },
    })
    expect(captured?.mode).toBe("continue-inline")
    expect(dispatched).toBe(0)
    expect(appended).toBe(0)
    expect(asked).toBe(0)
    expect(res.engaged).toBe(false)
  })

  it("flagged + invalid plan + attempts>=1 + interactive → ask-user: one question, turn yielded, no slice", async () => {
    delete process.env["OPENCODE_HEADLESS"]
    const sessionID = nextSessionID()
    incResolveAttempts(sessionID) // simulate one prior resolve-first pass that still didn't converge
    let dispatched = 0
    let asked: string | undefined
    let appended = 0
    let captured: { mode: string } | undefined
    const res = await runConductorOrchestration({
      getTodos: async () => cyclicTodos,
      probes: fakeProbes(),
      dispatch: async () => {
        dispatched++
        return { text: "ok", parts: [] }
      },
      setTodoStatus: async () => {},
      sessionID,
      arming: { hardness: "hard", ambiguity: "ambiguous" },
      appendTodos: async () => {
        appended++
      },
      askUser: (q) => {
        asked = q
      },
      onResolutionGate: (info) => {
        captured = info
      },
    })
    expect(captured?.mode).toBe("ask-user")
    expect(asked).toBeTruthy()
    expect(appended).toBe(0)
    expect(dispatched).toBe(0)
    expect(res.engaged).toBe(false)
  })

  it("flagged + invalid plan + HEADLESS → ask-user never fires, falls to resolve-first", async () => {
    process.env["OPENCODE_HEADLESS"] = "1"
    const sessionID = nextSessionID()
    incResolveAttempts(sessionID) // attempts=1 — would ask-user if a real user were present
    let asked = 0
    let captured: { mode: string } | undefined
    await runConductorOrchestration({
      getTodos: async () => cyclicTodos,
      probes: fakeProbes(),
      dispatch: async () => ({ text: "ok", parts: [] }),
      setTodoStatus: async () => {},
      sessionID,
      arming: { hardness: "hard", ambiguity: "ambiguous" },
      appendTodos: async () => {},
      askUser: () => {
        asked++
      },
      onResolutionGate: (info) => {
        captured = info
      },
    })
    expect(asked).toBe(0)
    expect(captured?.mode).not.toBe("ask-user")
  })

  it("resolveAttempts >= MAX_RESOLVE_ATTEMPTS (headless) → decompose-now: termination, no infinite loop", async () => {
    process.env["OPENCODE_HEADLESS"] = "1"
    const sessionID = nextSessionID()
    incResolveAttempts(sessionID)
    incResolveAttempts(sessionID) // attempts=2, matches code-intelligence's MAX_RESOLVE_ATTEMPTS
    expect(getResolveAttempts(sessionID)).toBe(2)
    let dispatched = 0
    let captured: { mode: string } | undefined
    await runConductorOrchestration({
      getTodos: async () => cyclicTodos,
      probes: fakeProbes(),
      dispatch: async () => {
        dispatched++
        return { text: "ok", parts: [] }
      },
      setTodoStatus: async () => {},
      sessionID,
      arming: { hardness: "hard", ambiguity: "ambiguous" },
      askUser: () => {
        throw new Error("must not be reached — attempts cap wins over ask-user only when non-interactive")
      },
      onResolutionGate: (info) => {
        captured = info
      },
    })
    expect(captured?.mode).toBe("decompose-now")
    expect(dispatched).toBeGreaterThan(0)
  })

  it("P10 — two resolution passes exhaust the per-turn budget; resetResolveAttempts (the turn-open reset) restores it", async () => {
    process.env["OPENCODE_HEADLESS"] = "1"
    const sessionID = nextSessionID()
    const modes: string[] = []
    const run = () =>
      runConductorOrchestration({
        getTodos: async () => cyclicTodos,
        probes: fakeProbes(),
        dispatch: async () => ({ text: "ok", parts: [] }),
        setTodoStatus: async () => {},
        sessionID,
        arming: { hardness: "hard", ambiguity: "ambiguous" },
        appendTodos: async () => {},
        onResolutionGate: (info) => {
          modes.push(info.mode)
        },
      })
    // Two passes spend the budget (MAX_RESOLVE_ATTEMPTS = 2)…
    await run()
    await run()
    expect(modes).toEqual(["resolve-first", "resolve-first"])
    expect(getResolveAttempts(sessionID)).toBe(2)
    // …a third pass in the SAME turn is bounded to best-effort decomposition…
    await run()
    expect(modes.at(-1)).toBe("decompose-now")
    // …and the next user turn's reset hands the new task its own budget.
    resetResolveAttempts(sessionID)
    expect(getResolveAttempts(sessionID)).toBe(0)
    await run()
    expect(modes.at(-1)).toBe("resolve-first")
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
    // Deterministic same-failure signature every hop: the cheap dispatch rejects,
    // then squeezes the SAME tier once (M2 — the signature hasn't changed, so the
    // 2nd squeeze attempt stalls), climbs ONE hop to the conductor (the non-critical
    // climb depth, maxClimbs=1), squeezes there once more, and — with the climb
    // budget spent and the slice non-critical — settles unverified instead of
    // climbing again. 4 dispatches total: cheap, squeeze@executor, climb->conductor,
    // squeeze@conductor. Every hop past the cheap one is an escalation hop (a
    // same-tier squeeze retry re-dispatches through the same compiled-brief path a
    // climb does, per dispatchRescueHop).
    expect(prompts.length).toBe(4)
    expect(escalatedFlags).toEqual([false, true, true, true])
    // The cheap hop carries the raw slice prompt verbatim...
    expect(prompts[0]).toBe("fix the bug")
    // ...every hop after it carries a compiled OracleBrief (compileBrief's fixed
    // sections), never the raw slice prompt or a running transcript (OL-3.2
    // stateless-oracle contract) — squeeze hops included.
    for (const p of prompts.slice(1)) {
      expect(p).not.toBe("fix the bug")
      expect(p).toContain("## Problem")
      expect(p).toContain("## Question")
      expect(p).toContain("## Expected Output Shape")
    }
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

  it("P6b wiring: two slices naming the same file serialize via an implicit dep (editScopeOf is live)", async () => {
    const ok: ConductorSliceDispatch = async () => ({ text: "done", parts: [] })
    const runCommand = async () => ({ exitCode: 0, stdout: "", stderr: "" })
    const overlapping = await runConductorSliceLoop(
      [
        { id: "a", prompt: "edit src/config.ts header", testStrength: "testable" as const, verifyCommands: [{ kind: "typecheck" as const, command: "true" }] },
        { id: "b", prompt: "edit src/config.ts footer", testStrength: "testable" as const, verifyCommands: [{ kind: "typecheck" as const, command: "true" }] },
      ],
      ok,
      { runCommand },
    )
    expect(overlapping.telemetry.implicitDeps).toEqual([{ sliceId: "b", dependsOn: "a", overlap: ["src/config.ts"] }])
    expect(overlapping.waves).toEqual([["a"], ["b"]])

    const disjoint = await runConductorSliceLoop(
      [
        { id: "a", prompt: "edit src/one.ts", testStrength: "testable" as const, verifyCommands: [{ kind: "typecheck" as const, command: "true" }] },
        { id: "b", prompt: "edit src/two.ts", testStrength: "testable" as const, verifyCommands: [{ kind: "typecheck" as const, command: "true" }] },
      ],
      ok,
      { runCommand },
    )
    expect(disjoint.telemetry.implicitDeps).toEqual([])
    expect(disjoint.waves).toEqual([["a", "b"]])
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

  it("explorer children still get the four core tools — bash/edit/webfetch all allow", () => {
    const effective = Permission.merge(BASE_AGENT_RULES, childSlicePermission(undefined, true, "explorer"))
    expect(Permission.evaluate("bash", 'node -e "probe()"', effective).action).toBe("allow")
    expect(Permission.evaluate("edit", "src/x.ts", effective).action).toBe("allow")
    expect(Permission.evaluate("webfetch", "https://x", effective).action).toBe("allow")
  })

  it("denies the blocking question surface", () => {
    const effective = Permission.merge(BASE_AGENT_RULES, childSlicePermission(undefined, false))
    expect(Permission.evaluate("question", "anything", effective).action).toBe("deny")
  })

  it("allows the network (webfetch/websearch) for every seat — no longer researcher-only", () => {
    const effective = Permission.merge(BASE_AGENT_RULES, childSlicePermission(undefined, false))
    expect(Permission.evaluate("webfetch", "https://x", effective).action).toBe("allow")
    expect(Permission.evaluate("websearch", "anything", effective).action).toBe("allow")
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

  it("decider seat (F6): bash and edit now allow even on the runner persona — every seat gets the core tools", () => {
    const effective = Permission.merge(BASE_AGENT_RULES, childSlicePermission(undefined, true, "runner", true))
    expect(Permission.evaluate("bash", "npx jest --runInBand", effective).action).toBe("allow")
    expect(Permission.evaluate("edit", "src/x.ts", effective).action).toBe("allow")
    // The interactive question floor is unaffected by the decider seat.
    expect(Permission.evaluate("question", "anything", effective).action).toBe("deny")
  })

  it("worker seat unaffected: deciderSeat=false keeps bash+edit for a mechanical rescue at any tier", () => {
    const effective = Permission.merge(BASE_AGENT_RULES, childSlicePermission(undefined, false, "applier", false))
    expect(Permission.evaluate("bash", "npx jest --runInBand", effective).action).toBe("allow")
    expect(Permission.evaluate("edit", "src/x.ts", effective).action).toBe("allow")
  })

  it("researcher persona gets webfetch/websearch allow plus bash+edit allow like every other seat", () => {
    const effective = Permission.merge(BASE_AGENT_RULES, childSlicePermission(undefined, false, "researcher"))
    expect(Permission.evaluate("webfetch", "https://x", effective).action).toBe("allow")
    expect(Permission.evaluate("websearch", "anything", effective).action).toBe("allow")
    expect(Permission.evaluate("bash", "pwd", effective).action).toBe("allow")
    expect(Permission.evaluate("edit", "src/x.ts", effective).action).toBe("allow")
  })

  it("researcher gets edit allow regardless of readOnly — no persona-specific write-lane restriction remains", () => {
    const effective = Permission.merge(BASE_AGENT_RULES, childSlicePermission(undefined, false, "researcher"))
    expect(Permission.evaluate("edit", "src/x.ts", effective).action).toBe("allow")
  })

  it("write-lane personas keep bash/edit allowed and now also get webfetch allow", () => {
    for (const persona of ECON_PERSONAS.filter((p) => p !== "researcher" && p !== "explorer")) {
      const effective = Permission.merge(BASE_AGENT_RULES, childSlicePermission(undefined, false, persona))
      expect(Permission.evaluate("webfetch", "https://x", effective).action).toBe("allow")
      expect(Permission.evaluate("bash", "pwd", effective).action).toBe("allow")
      expect(Permission.evaluate("edit", "src/x.ts", effective).action).toBe("allow")
    }
  })

  it("explorer gets bash/edit/webfetch allow regardless of readOnly", () => {
    const effective = Permission.merge(BASE_AGENT_RULES, childSlicePermission(undefined, false, "explorer"))
    expect(Permission.evaluate("bash", "pwd", effective).action).toBe("allow")
    expect(Permission.evaluate("edit", "src/x.ts", effective).action).toBe("allow")
    expect(Permission.evaluate("webfetch", "https://x", effective).action).toBe("allow")
  })

  it("readOnly no longer denies edit — bash and edit both allow regardless of the flag", () => {
    const effective = Permission.merge(BASE_AGENT_RULES, childSlicePermission(undefined, true))
    expect(Permission.evaluate("edit", "src/x.ts", effective).action).toBe("allow")
    expect(Permission.evaluate("bash", "npx jest x", effective).action).toBe("allow")
  })

  it("keeps parent rules in front, still effective for a permission the overlay doesn't touch", () => {
    const parentRules: SlicePermissionRule[] = [{ permission: "external_directory", pattern: "*", action: "deny" }]
    const effective = Permission.merge(BASE_AGENT_RULES, childSlicePermission(parentRules, false))
    expect(Permission.evaluate("external_directory", "*", effective).action).toBe("deny")
  })

  it("P11b: delegate flips to allow ONLY on a delegating seat — every other seat denies it (and never asks)", () => {
    const delegating = Permission.merge(BASE_AGENT_RULES, childSlicePermission(undefined, false, undefined, false, true))
    expect(Permission.evaluate("delegate", "anything", delegating).action).toBe("allow")

    // The no-flag default (worker seats), a decider seat, and every persona all deny.
    const plain = Permission.merge(BASE_AGENT_RULES, childSlicePermission(undefined, false))
    expect(Permission.evaluate("delegate", "anything", plain).action).toBe("deny")
    const decider = Permission.merge(BASE_AGENT_RULES, childSlicePermission(undefined, true, "explorer", true, false))
    expect(Permission.evaluate("delegate", "anything", decider).action).toBe("deny")
    for (const persona of ECON_PERSONAS) {
      const effective = Permission.merge(BASE_AGENT_RULES, childSlicePermission(undefined, false, persona))
      expect(Permission.evaluate("delegate", "anything", effective).action).toBe("deny")
    }
  })

  it("P11b depth-1 wiring: a delegate child's own seat evaluates non-delegating, so its permission row lands deny", () => {
    // The dispatch closure derives the 5th argument from isDelegatingSeat(tier, req.delegated):
    // a reasoner-tier DELEGATE child (delegated: true) must come out deny — no grandchildren.
    const delegateChild = Permission.merge(
      BASE_AGENT_RULES,
      childSlicePermission(undefined, false, undefined, false, isDelegatingSeat("reasoner", true)),
    )
    expect(Permission.evaluate("delegate", "anything", delegateChild).action).toBe("deny")
    // ...while a first-level reasoner slice seat comes out allow.
    const sliceSeat = Permission.merge(
      BASE_AGENT_RULES,
      childSlicePermission(undefined, false, undefined, false, isDelegatingSeat("reasoner", undefined)),
    )
    expect(Permission.evaluate("delegate", "anything", sliceSeat).action).toBe("allow")
  })

  it("P11b: delegate stays denied even when the merged agent/config ruleset carries a delegate allow", () => {
    const rulesWithDelegateAllow: PermissionV1.Ruleset = [
      ...BASE_AGENT_RULES,
      { permission: "delegate", pattern: "*", action: "allow" },
    ]
    const effective = Permission.merge(rulesWithDelegateAllow, childSlicePermission(undefined, false))
    expect(Permission.evaluate("delegate", "anything", effective).action).toBe("deny")
  })
})

describe("todosToPlanNodes — P11b parentID threading (goal-tree structure reaches validatePlan)", () => {
  it("threads a persisted parentID into the node's parentId (positional ids)", () => {
    const todos: OrchestrationTodo[] = [
      { content: "goal", status: "in_progress", sliceType: "design" },
      { content: "delegate child", status: "in_progress", sliceType: "mechanical", parentID: 0 },
      { content: "unrelated", status: "pending" },
    ]
    const nodes = todosToPlanNodes(todos)
    expect(nodes[0]).toEqual({ id: "0" })
    expect(nodes[1]).toEqual({ id: "1", parentId: "0" })
    expect(nodes[2]).toEqual({ id: "2" })
  })

  it("drops an out-of-range or self-referencing parentID (same hygiene as dep refs)", () => {
    const todos: OrchestrationTodo[] = [
      { content: "self", status: "pending", parentID: 0 },
      { content: "dangling", status: "pending", parentID: 99 },
      { content: "negative", status: "pending", parentID: -1 },
    ]
    const nodes = todosToPlanNodes(todos)
    for (const node of nodes) {
      expect("parentId" in node).toBe(false)
    }
  })

  it("parentId and dependsOn coexist on one node", () => {
    const todos: OrchestrationTodo[] = [
      { content: "design it", status: "pending", sliceType: "design" },
      { content: "apply it", status: "pending", sliceType: "mechanical", deps: ["design it"], parentID: 0 },
    ]
    const nodes = todosToPlanNodes(todos)
    expect(nodes[1]).toEqual({ id: "1", parentId: "0", dependsOn: ["0"] })
  })
})

describe("extractSliceFiles (M1 — bare filenames)", () => {
  it("captures a bare source filename with no directory prefix", () => {
    expect(extractSliceFiles("Apply the fix to ddl_references.py")).toEqual(["ddl_references.py"])
  })

  it("still captures slash-qualified paths of any short extension", () => {
    expect(extractSliceFiles("edit docs/notes.md and src/session/prompt.ts")).toEqual([
      "docs/notes.md",
      "src/session/prompt.ts",
    ])
  })

  it("prose abbreviations and version numbers never match", () => {
    expect(extractSliceFiles("e.g. bump to v1.2, i.e. the 3.9 runtime")).toEqual([])
  })

  it("bare names outside the extension whitelist never match", () => {
    expect(extractSliceFiles("see notes.md for the plan")).toEqual([])
  })
})

describe("resolveDottedPyModules + turn-file fallback (M2)", () => {
  const tmpDirs: string[] = []
  function makePyRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "slice-m2-"))
    tmpDirs.push(dir)
    mkdirSync(join(dir, "pkg", "db"), { recursive: true })
    writeFileSync(join(dir, "pkg", "db", "ddl_references.py"), "class Columns:\n    pass\n")
    return dir
  }
  afterEach(() => {
    while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
  })

  it("resolves a dotted module chain to the longest existing .py prefix (symbols stripped)", () => {
    const cwd = makePyRepo()
    expect(resolveDottedPyModules("col_suffixes passed to pkg.db.ddl_references.Columns would be empty", cwd)).toEqual([
      "pkg/db/ddl_references.py",
    ])
  })

  it("a dotted chain with no existing file resolves to nothing", () => {
    const cwd = makePyRepo()
    expect(resolveDottedPyModules("see java.util.concurrent.atomic for details", cwd)).toEqual([])
  })

  it("todosToLoopSlices probes with the turn's files when a slice names none", async () => {
    const probed: string[][] = []
    const probes: SliceProbes = {
      probeCoupling: async () => ({ coupling: "low" }),
      probeTestStrength: async (files) => {
        probed.push(files)
        return { testStrength: "testable" }
      },
    }
    const todos: OrchestrationTodo[] = [
      { content: "Patch IndexColumns.__str__ to drop empty col-suffixes", status: "pending", sliceType: "mechanical" },
    ]
    await todosToLoopSlices(todos, probes, undefined, { fallbackFiles: ["django/db/backends/ddl_references.py"] })
    expect(probed).toEqual([["django/db/backends/ddl_references.py"]])
  })

  it("a slice's own named file wins over the turn fallback", async () => {
    const probed: string[][] = []
    const probes: SliceProbes = {
      probeCoupling: async () => ({ coupling: "low" }),
      probeTestStrength: async (files) => {
        probed.push(files)
        return { testStrength: "testable" }
      },
    }
    const todos: OrchestrationTodo[] = [
      { content: "Apply the fix to ddl_references.py", status: "pending", sliceType: "mechanical" },
    ]
    await todosToLoopSlices(todos, probes, undefined, { fallbackFiles: ["other/file.py"] })
    expect(probed).toEqual([["ddl_references.py"]])
  })

  it("the fallback feeds the verify-command probe too (sound rung gets real commands)", async () => {
    const probes: SliceProbes = {
      probeCoupling: async () => ({ coupling: "low" }),
      probeTestStrength: async () => ({ testStrength: "testable" }),
      probeVerifyCommands: async (files) =>
        files.length > 0 ? [{ kind: "test", command: `run-tests-for ${files.join(",")}` }] : [],
    }
    const todos: OrchestrationTodo[] = [
      { content: "Patch the __str__ method to drop empty suffixes", status: "pending", sliceType: "mechanical" },
    ]
    const [slice] = await todosToLoopSlices(todos, probes, undefined, { fallbackFiles: ["pkg/db/ddl_references.py"] })
    expect(slice!.verifyCommands?.some((c) => c.command.includes("run-tests-for pkg/db/ddl_references.py"))).toBe(true)
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

  it("M1: names a django-runtests harness so slices never guess pytest", () => {
    const cwd = makeTmpRepo()
    writeFileSync(join(cwd, "setup.py"), "from setuptools import setup\nsetup()\n")
    mkdirSync(join(cwd, "tests"))
    writeFileSync(join(cwd, "tests", "runtests.py"), "#!/usr/bin/env python\n")

    const primer = buildRepoPrimer({ cwd })
    expect(primer).toContain("Test harness (detected)")
    expect(primer).toContain("tests/runtests.py <dotted.test.label>")
    expect(primer).toContain("does NOT use pytest")
  })

  it("M1: no python markers ⇒ no harness line", () => {
    const cwd = makeTmpRepo()
    writeFileSync(join(cwd, "index.js"), "")

    const primer = buildRepoPrimer({ cwd })
    expect(primer).not.toContain("Test harness (detected)")
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
    expect(seed.sliceType).toBe("mechanical")
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

// ---------------------------------------------------------------------------
// #56 Part B / #55 — logprobTokensFromParts, uncertaintyFromParts,
// redecompositionSignalsFromOutcomes (pure helpers re-exported for the
// posterior-uncertainty gate and the §4.2 re-decomposition signals)
// ---------------------------------------------------------------------------

describe("logprobTokensFromParts", () => {
  it("reads { token, logprob }[] off the last text part's provider-keyed metadata", () => {
    const parts = [
      {
        type: "text",
        text: "ab",
        metadata: { openai: { logprobs: [{ token: "a", logprob: -0.1 }, { token: "b", logprob: -0.2 }] } },
      },
    ]
    expect(logprobTokensFromParts(parts)).toEqual([
      { token: "a", logprob: -0.1 },
      { token: "b", logprob: -0.2 },
    ])
  })

  it("no text part in parts → undefined", () => {
    expect(logprobTokensFromParts([{ type: "tool", tool: "bash" }])).toBeUndefined()
  })

  it("text part but no metadata → undefined", () => {
    expect(logprobTokensFromParts([{ type: "text", text: "hi" }])).toBeUndefined()
  })

  it("metadata present but no provider bucket carries logprobs → undefined", () => {
    expect(logprobTokensFromParts([{ type: "text", text: "hi", metadata: { openai: {} } }])).toBeUndefined()
  })

  it("logprobs is not an array → undefined", () => {
    expect(
      logprobTokensFromParts([{ type: "text", text: "hi", metadata: { openai: { logprobs: "not-an-array" } } }]),
    ).toBeUndefined()
  })

  it("logprobs items missing token/logprob are filtered out, leaving nothing → undefined", () => {
    const parts = [
      {
        type: "text",
        text: "hi",
        metadata: {
          openai: {
            logprobs: [{ token: "a" }, { logprob: -0.1 }, { token: 5, logprob: -0.1 }],
          },
        },
      },
    ]
    expect(logprobTokensFromParts(parts)).toBeUndefined()
  })

  it("two text parts, only the LAST has logprobs → returns the last one's tokens", () => {
    const parts = [
      { type: "text", text: "first" },
      { type: "text", text: "second", metadata: { openai: { logprobs: [{ token: "y", logprob: -1 }] } } },
    ]
    expect(logprobTokensFromParts(parts)).toEqual([{ token: "y", logprob: -1 }])
  })
})

describe("uncertaintyFromParts", () => {
  it("executor tier: strips reasoning up to the <|channel|>final boundary, computes perplexity over the answer tokens only", () => {
    const tokens: LogprobToken[] = [
      { token: "reasoning stuff ", logprob: -5 },
      { token: "more reasoning ", logprob: -5 },
      { token: "<|channel|>final", logprob: -0.01 },
      { token: "answer1", logprob: 0 },
      { token: "answer2", logprob: 0 },
    ]
    const parts = [{ type: "text", text: "combined", metadata: { openai: { logprobs: tokens } } }]
    const signal = uncertaintyFromParts(parts, "executor" as EconTier)
    expect(signal).toBeDefined()
    expect(signal!.kind).toBe("perplexity")
    expect(signal!.value).toBeCloseTo(1, 6)
    expect(signal!.high).toBe(false)
  })

  it("conductor tier: strips an <mm:think>…</mm:think> span, high perplexity on the remaining answer tokens flips high to true", () => {
    const tokens: LogprobToken[] = [
      { token: "<mm:think>", logprob: -0.01 },
      { token: "deep reasoning here", logprob: -20 },
      { token: "</mm:think>", logprob: -0.01 },
      { token: "answer", logprob: -2 },
      { token: " tokens", logprob: -2 },
    ]
    const parts = [{ type: "text", text: "combined", metadata: { openai: { logprobs: tokens } } }]
    const signal = uncertaintyFromParts(parts, "conductor" as EconTier)
    expect(signal).toBeDefined()
    expect(signal!.kind).toBe("perplexity")
    expect(signal!.value).toBeCloseTo(Math.exp(2), 6)
    expect(PERPLEXITY_HIGH_THRESHOLD).toBe(3)
    expect(signal!.high).toBe(true)
  })

  it("no logprobs on the dispatch (absent metadata) → undefined", () => {
    const parts = [{ type: "text", text: "hi" }]
    expect(uncertaintyFromParts(parts, "executor" as EconTier)).toBeUndefined()
  })

  it("executor tier: every token is inside/before the reasoning channel, so the answer channel is empty after strip → undefined", () => {
    const tokens: LogprobToken[] = [
      { token: "reasoning stuff", logprob: -5 },
      { token: "<|channel|>final", logprob: -1 },
    ]
    const parts = [{ type: "text", text: "combined", metadata: { openai: { logprobs: tokens } } }]
    expect(uncertaintyFromParts(parts, "executor" as EconTier)).toBeUndefined()
  })
})

describe("redecompositionSignalsFromOutcomes", () => {
  const oc = (state: SliceOutcome["state"]): SliceOutcome => ({ state }) as SliceOutcome

  it("one unverified among accepted → coverageGaps 1, budgetOverrunPct 0", () => {
    const signals = redecompositionSignalsFromOutcomes([oc("accepted"), oc("unverified")])
    expect(signals).toEqual({ coverageGaps: 1, budgetOverrunPct: 0 })
  })

  it("all accepted → coverageGaps 0, budgetOverrunPct 0", () => {
    const signals = redecompositionSignalsFromOutcomes([oc("accepted"), oc("accepted"), oc("accepted")])
    expect(signals).toEqual({ coverageGaps: 0, budgetOverrunPct: 0 })
  })

  it("2 of 3 escalated (>50%) → budgetOverrunPct 100", () => {
    const signals = redecompositionSignalsFromOutcomes([oc("escalated"), oc("escalated"), oc("accepted")])
    expect(signals.budgetOverrunPct).toBe(100)
  })

  it("1 of 3 escalated (not >50%) → budgetOverrunPct 0", () => {
    const signals = redecompositionSignalsFromOutcomes([oc("escalated"), oc("accepted"), oc("accepted")])
    expect(signals.budgetOverrunPct).toBe(0)
  })

  it("empty array → { coverageGaps: 0, budgetOverrunPct: 0 }", () => {
    expect(redecompositionSignalsFromOutcomes([])).toEqual({ coverageGaps: 0, budgetOverrunPct: 0 })
  })

  it("composes with redecompositionCheck: a coverage gap fires the new-items trigger", () => {
    const signals: RedecompositionSignals = redecompositionSignalsFromOutcomes([oc("unverified"), oc("accepted")])
    expect(redecompositionCheck(signals)).toContain("new-items")
  })

  it("P6a: a blocked dependent counts as a coverage gap exactly like an unverified slice", () => {
    const signals = redecompositionSignalsFromOutcomes([oc("accepted"), oc("blocked")])
    expect(signals).toEqual({ coverageGaps: 1, budgetOverrunPct: 0 })
    expect(redecompositionCheck(signals)).toContain("new-items")
  })
})
