/**
 * P11b — model-initiated tier delegation (session/slice-delegation.ts).
 * Everything here runs against the REAL slice pipeline (todosToLoopSlices →
 * allocateSlice → runConductorSliceLoop) with doubles only at the live seams
 * the conductor path also doubles in its own tests: dispatch, probes, the
 * shell runner, and the snapshot bracket. Tier-speak only — no model names.
 */
import { describe, it, expect } from "bun:test"
import type { SliceDispatchRequest } from "@opencode-ai/code-intelligence"
import {
  MAX_DELEGATES_PER_SLICE,
  delegateFromSeat,
  getDelegationSeat,
  registerDelegationSeat,
  releaseDelegationSeat,
  type DelegateTelemetry,
  type DelegationPorts,
  type DelegationSeat,
} from "../../src/session/slice-delegation"
import {
  isDelegatingSeat,
  type ConductorSliceDispatch,
  type InjectedSliceTodo,
  type SliceProbes,
} from "../../src/session/slice-orchestrator"

const PROBES: SliceProbes = {
  probeCoupling: async () => ({ coupling: "low" }),
  probeTestStrength: async () => ({ testStrength: "testable" }),
}

/** One full delegation harness: recorded dispatches, a live todo list seeded with the parent slice's own item, and telemetry/escalation sinks. */
function makeHarness(opts?: {
  dispatchText?: string
  exitCode?: number
  dispatch?: ConductorSliceDispatch
  appendTodo?: (todo: InjectedSliceTodo) => Promise<number>
}) {
  const requests: SliceDispatchRequest[] = []
  const dispatch: ConductorSliceDispatch =
    opts?.dispatch ?? (async () => ({ text: opts?.dispatchText ?? "done", parts: [] }))
  const todos: InjectedSliceTodo[] = [
    { content: "parent slice", status: "in_progress", priority: "high", sliceType: "design" },
  ]
  const appended: InjectedSliceTodo[] = []
  const statuses: Array<{ index: number; status: string }> = []
  const telemetry: DelegateTelemetry[] = []
  const escalations: unknown[] = []
  const ports: DelegationPorts = {
    dispatch: async (req) => {
      requests.push(req)
      return dispatch(req)
    },
    probes: PROBES,
    options: {
      runCommand: async () => ({ exitCode: opts?.exitCode ?? 0, stdout: "", stderr: opts?.exitCode ? "boom" : "" }),
      // U3 containment present — the delegate mini-loop rides the same
      // snapshot bracket, and evaluate()'s mechanical round-down can fire.
      snapshot: { track: async () => "hash1", restore: async () => {}, diff: async () => "" },
      onEscalation: (e) => escalations.push(e),
    },
    getTodos: async () => todos,
    appendTodo:
      opts?.appendTodo ??
      (async (todo) => {
        appended.push(todo)
        todos.push(todo)
        return todos.length - 1
      }),
    setTodoStatus: async (index, status) => {
      statuses.push({ index, status })
    },
    onDelegate: (info) => telemetry.push(info),
  }
  return { requests, todos, appended, statuses, telemetry, escalations, ports }
}

function makeSeat(
  ports: DelegationPorts,
  overrides?: Partial<Pick<DelegationSeat, "parentSliceId" | "callerTier" | "parentScope">>,
): DelegationSeat {
  const id = `ses_delegation_${Math.random().toString(36).slice(2)}`
  registerDelegationSeat(id, {
    parentSliceId: overrides?.parentSliceId ?? "parent slice",
    callerTier: overrides?.callerTier ?? "reasoner",
    parentScope: overrides?.parentScope ?? new Set(),
    ports,
  })
  return getDelegationSeat(id)!
}

describe("P11b — sub-planner example (reasoner seat delegates down through the one pipeline)", () => {
  it("two executor sub-items + one conductor sub-item: code resolves the tiers, todos thread parentID, telemetry and outputs land", async () => {
    const h = makeHarness()
    const seat = makeSeat(h.ports)

    // Two mechanical, testable sub-items with NO named commands: verify
    // strength stays weak, so evaluate() cannot round down — they dispatch on
    // the executor (allocateSlice's testable-invariant cell).
    const first = await delegateFromSeat(seat, {
      content: "Apply the decided rename of parseConfig to loadConfig in src/config.ts and report the diff",
      sliceType: "mechanical",
    })
    const second = await delegateFromSeat(seat, {
      content: "Update the call sites in src/server.ts to the renamed loadConfig and report the diff",
      sliceType: "mechanical",
    })
    // Third sub-item names a real typecheck command: mechanical + testable +
    // verify commands + snapshot containment ⇒ evaluate()'s one sanctioned
    // round-down fires and the dispatch lands one tier CHEAPER, on the
    // conductor (TIER_RANK price order: conductor sits below executor).
    const third = await delegateFromSeat(seat, {
      content: "Apply the decided import cleanup in src/util.ts, then verify with `bunx tsc --noEmit`",
      sliceType: "mechanical",
    })

    // The model never names a tier — code picked every one of these.
    expect(first.refused).toBe(false)
    expect(second.refused).toBe(false)
    expect(third.refused).toBe(false)
    expect(h.requests.map((r) => r.tier)).toEqual(["executor", "executor", "conductor"])
    // Depth-1: every dispatch out of a delegate's mini-loop is marked, so the
    // host never registers a delegation seat for the child (no grandchildren).
    expect(h.requests.every((r) => r.delegated === true)).toBe(true)
    expect(h.requests.every((r) => r.escalated === false)).toBe(true)

    // Child todos were written by the TOOL HANDLER, not the model: one per
    // accepted delegate, threaded under the parent slice's own todo (index 0),
    // in_progress at dispatch and settled completed with the verification.
    expect(h.appended).toHaveLength(3)
    for (const todo of h.appended) {
      expect(todo.parentID).toBe(0)
      expect(todo.status).toBe("in_progress")
      expect(todo.sliceType).toBe("mechanical")
    }
    expect(h.statuses).toEqual([
      { index: 1, status: "completed" },
      { index: 2, status: "completed" },
      { index: 3, status: "completed" },
    ])

    // Telemetry: one row per delegate — parent slice id, caller tier, the
    // code-resolved tier, and the dispatched outcome.
    expect(h.telemetry).toHaveLength(3)
    for (const row of h.telemetry) {
      expect(row.parentSliceId).toBe("parent slice")
      expect(row.callerTier).toBe("reasoner")
      expect(row.outcome).toBe("dispatched")
    }
    expect(h.telemetry.map((r) => r.resolvedTier)).toEqual(["executor", "executor", "conductor"])

    // The caller integrates a digest, headed by the settled tier + verdict.
    // The commandless delegates accept flagged-unverified (OL-9.5d — no sound
    // check existed to run); the command-backed one verifies green and accepts.
    expect(first.output).toStartWith("DELEGATED → executor [state=unverified")
    expect(third.output).toStartWith("DELEGATED → conductor [state=accepted")
    expect(seat.used).toBe(3)
  })

  it("a failing delegate rides the SAME verify + escalation ladder (rescue hops stay marked delegated) and its todo still settles", async () => {
    const h = makeHarness({ dispatchText: "still broken", exitCode: 1 })
    const seat = makeSeat(h.ports)

    const result = await delegateFromSeat(seat, {
      content: "Apply the decided import cleanup in src/util.ts, then verify with `bunx tsc --noEmit`",
      sliceType: "mechanical",
    })

    // Not a refusal and not a clone: the mini-loop rejected the cheap hop,
    // squeezed, climbed, and settled through the one pipeline.
    expect(result.refused).toBe(false)
    expect(h.escalations.length).toBeGreaterThan(0)
    expect(h.requests.length).toBeGreaterThan(1)
    expect(h.requests.every((r) => r.delegated === true)).toBe(true)
    expect(h.requests.slice(1).every((r) => r.escalated === true)).toBe(true)
    expect(result.output).toContain("state=")
    // Settlement follows the verification's settlement, whatever it was.
    expect(h.statuses).toHaveLength(1)
    expect(h.statuses[0]!.status).toBe("completed")
    expect(h.telemetry[0]!.outcome).toBe("dispatched")
  })

  it("delegate calls on one seat serialize — the mini-loops never interleave", async () => {
    let active = 0
    let maxActive = 0
    const h = makeHarness({
      dispatch: async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active--
        return { text: "done", parts: [] }
      },
    })
    const seat = makeSeat(h.ports)

    const [a, b] = await Promise.all([
      delegateFromSeat(seat, { content: "Apply the decided edit in src/a.ts", sliceType: "mechanical" }),
      delegateFromSeat(seat, { content: "Apply the decided edit in src/b.ts", sliceType: "mechanical" }),
    ])

    expect(a.refused).toBe(false)
    expect(b.refused).toBe(false)
    expect(maxActive).toBe(1)
    expect(seat.used).toBe(2)
  })
})

describe("P11b — refusals (every guardrail is code, not prompt text)", () => {
  it("down-only: a design-shaped request from a reasoner seat allocates AT the caller and is refused as its own job", async () => {
    const h = makeHarness()
    const seat = makeSeat(h.ports, { callerTier: "reasoner" })

    const result = await delegateFromSeat(seat, {
      content: "Decide the new cache-invalidation contract for the storage layer",
      sliceType: "design",
    })

    expect(result.refused).toBe(true)
    expect(result.output).toStartWith("DELEGATE REFUSED")
    expect(result.output).toContain("your job")
    // Nothing dispatched, nothing recorded, no budget consumed.
    expect(h.requests).toHaveLength(0)
    expect(h.appended).toHaveLength(0)
    expect(seat.used).toBe(0)
    expect(h.telemetry).toEqual([
      {
        parentSliceId: "parent slice",
        callerTier: "reasoner",
        resolvedTier: "reasoner",
        outcome: "refused",
        reason: expect.stringContaining("your job"),
      },
    ])
  })

  it("down-only is relative: the SAME design-shaped request from an oracle seat dispatches on the reasoner", async () => {
    const h = makeHarness()
    const seat = makeSeat(h.ports, { callerTier: "oracle" })

    const result = await delegateFromSeat(seat, {
      content: "Decide the new cache-invalidation contract for the storage layer",
      sliceType: "design",
    })

    expect(result.refused).toBe(false)
    expect(h.requests.map((r) => r.tier)).toEqual(["reasoner"])
    expect(h.requests[0]!.delegated).toBe(true)
    expect(result.output).toStartWith("DELEGATED → reasoner")
    expect(seat.used).toBe(1)
  })

  it("bound: the call after the per-slice cap refuses without consuming budget or dispatching", async () => {
    const h = makeHarness()
    const seat = makeSeat(h.ports)
    seat.used = MAX_DELEGATES_PER_SLICE

    const result = await delegateFromSeat(seat, {
      content: "Apply one more decided edit in src/extra.ts",
      sliceType: "mechanical",
    })

    expect(result.refused).toBe(true)
    expect(result.output).toContain("per-slice cap")
    expect(seat.used).toBe(MAX_DELEGATES_PER_SLICE)
    expect(h.requests).toHaveLength(0)
    expect(h.appended).toHaveLength(0)
    expect(h.telemetry[0]!.outcome).toBe("refused")
  })

  it("a refusal never consumes the budget: a refused design request still leaves room for a mechanical delegate", async () => {
    const h = makeHarness()
    const seat = makeSeat(h.ports)

    const refused = await delegateFromSeat(seat, {
      content: "Decide the module boundary for the new API",
      sliceType: "design",
    })
    const dispatched = await delegateFromSeat(seat, {
      content: "Apply the decided edit in src/api.ts",
      sliceType: "mechanical",
    })

    expect(refused.refused).toBe(true)
    expect(dispatched.refused).toBe(false)
    expect(seat.used).toBe(1)
  })

  it("scope containment: a delegate naming a file outside the parent slice's scope is refused with the offenders listed", async () => {
    const h = makeHarness()
    const seat = makeSeat(h.ports, { parentScope: new Set(["src/inside.ts"]) })

    const byParam = await delegateFromSeat(seat, {
      content: "Tidy the imports as decided",
      sliceType: "mechanical",
      files: ["src/outside.ts"],
    })
    const byContent = await delegateFromSeat(seat, {
      content: "Apply the decided edit in src/other/place.ts",
      sliceType: "mechanical",
    })

    for (const result of [byParam, byContent]) {
      expect(result.refused).toBe(true)
      expect(result.output).toContain("out of scope")
    }
    expect(byParam.output).toContain("src/outside.ts")
    expect(byContent.output).toContain("src/other/place.ts")
    expect(h.requests).toHaveLength(0)
    expect(seat.used).toBe(0)
  })

  it("scope containment: an in-scope file dispatches; an empty parent scope stands down (no computable boundary)", async () => {
    const scoped = makeHarness()
    const scopedSeat = makeSeat(scoped.ports, { parentScope: new Set(["src/inside.ts"]) })
    const inScope = await delegateFromSeat(scopedSeat, {
      content: "Apply the decided edit",
      sliceType: "mechanical",
      files: ["src/inside.ts"],
    })
    expect(inScope.refused).toBe(false)
    expect(scoped.requests.map((r) => r.tier)).toEqual(["executor"])

    const unscoped = makeHarness()
    const unscopedSeat = makeSeat(unscoped.ports, { parentScope: new Set() })
    const standsDown = await delegateFromSeat(unscopedSeat, {
      content: "Apply the decided edit",
      sliceType: "mechanical",
      files: ["anywhere/else.ts"],
    })
    expect(standsDown.refused).toBe(false)
  })
})

describe("P11b — child-todo recording details", () => {
  it("a deduped parent slice id (content#N) still resolves the parent todo index", async () => {
    const h = makeHarness()
    const seat = makeSeat(h.ports, { parentSliceId: "parent slice#2" })

    const result = await delegateFromSeat(seat, {
      content: "Apply the decided edit in src/x.ts",
      sliceType: "mechanical",
    })

    expect(result.refused).toBe(false)
    expect(h.appended[0]!.parentID).toBe(0)
  })

  it("a store rejection of the parentID edge falls back to a root append — the record is never lost", async () => {
    const calls: InjectedSliceTodo[] = []
    const h = makeHarness({
      appendTodo: async (todo) => {
        calls.push(todo)
        if (todo.parentID !== undefined) throw new Error("tree depth cap")
        return calls.length
      },
    })
    const seat = makeSeat(h.ports)

    const result = await delegateFromSeat(seat, {
      content: "Apply the decided edit in src/x.ts",
      sliceType: "mechanical",
    })

    expect(result.refused).toBe(false)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.parentID).toBe(0)
    expect(calls[1]!.parentID).toBeUndefined()
    expect(h.statuses[0]!.status).toBe("completed")
  })
})

describe("P11b — seat registry + isDelegatingSeat", () => {
  it("register/get/release roundtrip keyed by the child session id", () => {
    const { ports } = makeHarness()
    registerDelegationSeat("ses_p11b_registry", {
      parentSliceId: "parent slice",
      callerTier: "oracle",
      parentScope: new Set(["src/a.ts"]),
      ports,
    })
    const seat = getDelegationSeat("ses_p11b_registry")
    expect(seat).toBeDefined()
    expect(seat!.callerTier).toBe("oracle")
    expect(seat!.used).toBe(0)
    releaseDelegationSeat("ses_p11b_registry")
    expect(getDelegationSeat("ses_p11b_registry")).toBeUndefined()
    expect(getDelegationSeat("ses_never_registered")).toBeUndefined()
  })

  it("only a non-delegate reasoner/oracle seat delegates: executor/conductor never, delegate children never (depth-1)", () => {
    expect(isDelegatingSeat("reasoner")).toBe(true)
    expect(isDelegatingSeat("oracle")).toBe(true)
    expect(isDelegatingSeat("executor")).toBe(false)
    expect(isDelegatingSeat("conductor")).toBe(false)
    expect(isDelegatingSeat("reasoner", true)).toBe(false)
    expect(isDelegatingSeat("oracle", true)).toBe(false)
    expect(isDelegatingSeat("oracle", false)).toBe(true)
  })
})
