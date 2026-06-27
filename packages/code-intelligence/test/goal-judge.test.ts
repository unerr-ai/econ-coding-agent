/**
 * Unit tests for goal-judge.ts: the goal-iteration doom-loop gate and
 * run-until-goal orchestrator. All tests use makeStubJudge — no live model
 * or credentials required.
 */

import { describe, it, expect } from "bun:test"
import {
  runUntilGoal,
  makeStubJudge,
  createGoalJudgeState,
  DEFAULT_GOAL_JUDGE_CONFIG,
  type GoalContext,
} from "./../src/goal-judge.js"

describe("runUntilGoal", () => {
  // 1. COMPLETED: judge returns done once step produces progressKey "reached".
  it('returns status "completed" when the judge is satisfied', async () => {
    // Steps produce distinct keys for iterations 1 and 2, then "reached" at iter 3.
    const step = (iteration: number): GoalContext => ({
      goal: "test goal",
      iteration,
      progressKey: iteration < 3 ? `iter-${iteration}` : "reached",
      lastStepResult: `result of step ${iteration}`,
    })
    const judge = makeStubJudge((ctx) => ctx.progressKey === "reached")

    const outcome = await runUntilGoal({ goal: "test goal", step, judge })

    expect(outcome.status).toBe("completed")
    expect(outcome.iterations).toBe(3)
    expect(outcome.reason).toBe("predicate satisfied")
  })

  // 2. DOOM-LOOP: step always returns the same progressKey and judge never done.
  it('returns status "doom-loop" when progress stagnates', async () => {
    const step = (iteration: number): GoalContext => ({
      goal: "stuck goal",
      iteration,
      progressKey: "stuck",
    })
    const judge = makeStubJudge(() => false)

    const state = createGoalJudgeState()
    const config = { ...DEFAULT_GOAL_JUDGE_CONFIG } // stagnationLimit = 3

    const outcome = await runUntilGoal({ goal: "stuck goal", step, judge, state, config })

    expect(outcome.status).toBe("doom-loop")
    expect(outcome.iterations).toBe(config.stagnationLimit)
  })

  // 3. MAX-ITERATIONS: ever-changing keys (no stagnation) + judge never done.
  it('returns status "max-iterations" when the ceiling is hit', async () => {
    const step = (iteration: number): GoalContext => ({
      goal: "endless goal",
      iteration,
      // Each iteration gets a unique key — doom-loop gate never trips.
      progressKey: `unique-${iteration}-${Math.random()}`,
    })
    const judge = makeStubJudge(() => false)

    const config = { maxIterations: 5, stagnationLimit: 3 }

    const outcome = await runUntilGoal({ goal: "endless goal", step, judge, config })

    expect(outcome.status).toBe("max-iterations")
    expect(outcome.iterations).toBe(config.maxIterations)
  })

  // Doom-loop gate fires BEFORE the judge — stagnation halts before any judge call.
  it("halts on doom-loop before calling the judge for the triggering iteration", async () => {
    let judgeCalls = 0
    const step = (iteration: number): GoalContext => ({
      goal: "count test",
      iteration,
      progressKey: "frozen",
    })
    const judge = makeStubJudge(() => {
      judgeCalls++
      return false
    })

    const config = { maxIterations: 10, stagnationLimit: 3 }
    const outcome = await runUntilGoal({ goal: "count test", step, judge, config })

    expect(outcome.status).toBe("doom-loop")
    // stagnationLimit=3, so doom-loop fires at iteration 3.
    // Judge is NOT called on the iteration where doom-loop fires (gate is checked first).
    // Iterations 1 and 2 pass the gate (counts 1, 2 < 3), so judge is called twice.
    expect(judgeCalls).toBe(2)
  })
})

describe("makeStubJudge", () => {
  // 4. makeStubJudge: evaluate resolves done per the predicate.
  it("returns done=true when predicate returns true", async () => {
    const judge = makeStubJudge(() => true)
    const ctx: GoalContext = { goal: "g", iteration: 1, progressKey: "k" }
    const result = await judge.evaluate(ctx)
    expect(result.done).toBe(true)
  })

  it("returns done=false when predicate returns false", async () => {
    const judge = makeStubJudge(() => false)
    const ctx: GoalContext = { goal: "g", iteration: 1, progressKey: "k" }
    const result = await judge.evaluate(ctx)
    expect(result.done).toBe(false)
  })

  it("passes the full GoalContext to the predicate", async () => {
    let received: GoalContext | undefined
    const judge = makeStubJudge((ctx) => {
      received = ctx
      return false
    })
    const ctx: GoalContext = {
      goal: "my goal",
      iteration: 7,
      progressKey: "some-key",
      lastStepResult: "step output",
    }
    await judge.evaluate(ctx)
    expect(received).toEqual(ctx)
  })
})
