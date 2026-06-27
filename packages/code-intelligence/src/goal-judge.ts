/**
 * Goal-iteration doom-loop gate and run-until-goal orchestrator for econ's
 * autonomous loop. Detects stagnation at the GOAL-ITERATION level — when the
 * step function produces the same progress signature repeatedly — and halts the
 * loop before it wastes further model budget.
 *
 * Reconciliation with guardrail.ts (S6.3 retry-loop-breaker): both modules
 * share the same pattern (stable progress key + consecutive count vs. a limit),
 * but they operate at different layers and take opposite actions when triggered.
 * GuardrailState.retries tracks EDIT-level identical blocked edits and RELEASES
 * the block (downgrades to advisory) so the turn can progress; GoalJudgeState
 * tracks GOAL-ITERATION level stagnation and HALTS the loop entirely to prevent
 * wasted budget. They are complementary and never overlap: the guardrail fires
 * inside a single tool-execute.before call, the doom-loop gate fires between
 * complete goal-iteration steps.
 *
 * Live-model judge creation is intentionally not exported here: it requires
 * credentials from the unerr core and belongs in the .opencode plugin wiring,
 * not this pure decision module. Use makeStubJudge for unit tests and
 * deterministic orchestration.
 *
 * @sem domain=intelligence role=analysis
 */

/**
 * Describes one iteration's state: the goal being pursued, which iteration
 * number this is, a stable progress signature the doom-loop gate hashes on, and
 * an optional free-text summary of what the step produced.
 *
 * @sem domain=intelligence role=analysis
 */
export interface GoalContext {
  goal: string
  iteration: number
  progressKey: string
  lastStepResult?: string
}

/**
 * Decides whether the goal has been reached for the given context. Implementations
 * may call a live model (gated on credentials) or apply a deterministic predicate;
 * the interface is the same either way so orchestration logic is judge-agnostic.
 *
 * @sem domain=intelligence role=analysis
 */
export interface Judge {
  evaluate(ctx: GoalContext): Promise<{ done: boolean; reason: string }>
}

/**
 * Bounds on how long a goal loop is allowed to run: the absolute iteration ceiling
 * and the consecutive-stagnation threshold that trips the doom-loop gate early.
 *
 * @sem domain=intelligence role=configuration
 */
export interface GoalJudgeConfig {
  maxIterations: number
  stagnationLimit: number
}

/**
 * Sensible defaults for a goal-judge run: up to 20 iterations before giving up,
 * with a doom-loop halt after 3 consecutive iterations that produce the same
 * progress signature.
 *
 * @sem domain=intelligence role=configuration
 */
export const DEFAULT_GOAL_JUDGE_CONFIG: GoalJudgeConfig = {
  maxIterations: 20,
  stagnationLimit: 3,
}

/**
 * Mutable stagnation ledger owned by the caller across iterations of a single
 * run-until-goal session. Mirrors the role of GuardrailState.retries but at the
 * goal-iteration layer: tracks the last observed progress key and how many
 * consecutive times it has appeared unchanged.
 *
 * @sem domain=intelligence role=analysis
 */
export interface GoalJudgeState {
  lastProgressKey: string | null
  stagnationCount: number
}

/**
 * Creates a fresh, zeroed goal-judge state for the start of a new run session.
 *
 * @sem domain=intelligence role=analysis
 */
export function createGoalJudgeState(): GoalJudgeState {
  return { lastProgressKey: null, stagnationCount: 0 }
}

/**
 * The final outcome of a run-until-goal call: whether the goal was reached,
 * the loop stagnated (doom-loop), or the iteration ceiling was hit, along with
 * how many iterations ran and a human-readable explanation.
 *
 * @sem domain=intelligence role=analysis
 */
export type GoalOutcome = {
  status: "completed" | "doom-loop" | "max-iterations"
  iterations: number
  reason: string
}

/**
 * Wraps a pure boolean predicate as a Judge for tests and deterministic
 * orchestration — no model call, no credentials required. A live-model judge
 * that calls an LLM oracle belongs in the .opencode plugin wiring where
 * credentials are available, not in this module.
 *
 * @sem domain=intelligence role=analysis
 */
export function makeStubJudge(predicate: (ctx: GoalContext) => boolean): Judge {
  return {
    async evaluate(ctx: GoalContext): Promise<{ done: boolean; reason: string }> {
      const done = predicate(ctx)
      return { done, reason: done ? "predicate satisfied" : "predicate not satisfied" }
    },
  }
}

/**
 * Runs a step function repeatedly, evaluating goal completion after each step,
 * and halts early if the loop stagnates. The doom-loop gate fires BEFORE the
 * judge on each iteration so stagnating runs halt without paying model judge cost.
 *
 * @sem domain=intelligence role=analysis
 */
export async function runUntilGoal(args: {
  goal: string
  step: (iteration: number) => Promise<GoalContext> | GoalContext
  judge: Judge
  state?: GoalJudgeState
  config?: GoalJudgeConfig
}): Promise<GoalOutcome> {
  const config = args.config ?? DEFAULT_GOAL_JUDGE_CONFIG
  const state = args.state ?? createGoalJudgeState()

  for (let iteration = 1; iteration <= config.maxIterations; iteration++) {
    const ctx = await args.step(iteration)

    // Doom-loop gate: update stagnation count BEFORE calling the judge, so a
    // stagnating run halts promptly without paying for a judge evaluation.
    if (ctx.progressKey === state.lastProgressKey) {
      state.stagnationCount++
    } else {
      state.stagnationCount = 1
      state.lastProgressKey = ctx.progressKey
    }

    if (state.stagnationCount >= config.stagnationLimit) {
      return {
        status: "doom-loop",
        iterations: iteration,
        reason:
          `[econ-goal] doom-loop detected: progress key "${ctx.progressKey}" has not changed for ` +
          `${state.stagnationCount} consecutive iterations — halting to prevent wasted budget.`,
      }
    }

    const verdict = await args.judge.evaluate(ctx)
    if (verdict.done) {
      return { status: "completed", iterations: iteration, reason: verdict.reason }
    }
  }

  return {
    status: "max-iterations",
    iterations: config.maxIterations,
    reason:
      `[econ-goal] max iterations (${config.maxIterations}) reached without completing goal: "${args.goal}".`,
  }
}
