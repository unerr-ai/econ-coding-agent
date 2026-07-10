/**
 * P11b — model-initiated tier delegation for reasoner/oracle slice seats
 * (ORCHESTRATION_IMPROVEMENTS.md §4j, decisions Q-O/Q-P). A high-tier slice
 * child is a depth-1 sub-planner: mid-slice it can NAME a discovered
 * sub-item (content + optional sliceType/files hints) through the `delegate`
 * tool, and CODE picks the tier via the existing per-slice allocator +
 * evaluator and runs it through the SAME slice pipeline a conductor-planned
 * slice rides — persona resolution, P8 step budget, verify ladder, snapshot
 * bracket, double-pay ledger — never a raw spawn. Semantics in LLM, policy
 * in code; every guardrail here is enforced in code, not prompt text:
 *
 *  - down-only: the allocated tier must rank strictly below the caller's on
 *    the capability ladder (LADDER_RANK); a design-shaped request that
 *    allocates at-or-above the caller is refused — that IS the caller's job.
 *  - depth-1: every dispatch a delegate mini-loop issues carries
 *    `delegated: true`, so the host never registers a delegation seat for a
 *    delegate child (no grandchildren) and `childSlicePermission` denies it
 *    the `delegate`/`task` tools.
 *  - bounded: at most MAX_DELEGATES_PER_SLICE accepted delegates per parent
 *    slice; the next call refuses with the reason.
 *  - scope-contained: the delegate's named files must stay inside the parent
 *    slice's own predicted scope (the same P6b `extractSliceFiles` probe);
 *    out-of-scope files refuse with the offenders listed. A parent slice
 *    that names no files has no computable scope — the check stands down
 *    (mirrors P6b's "empty when a slice names no files: no false overlap").
 *  - recorded: every ACCEPTED delegate is written by this handler — never by
 *    the model — as a child todo under the parent slice's own todo
 *    (`parentID` threaded), marked in_progress at dispatch and settled when
 *    the delegate's verification settles. The parent item completes only
 *    when its own slice does.
 *
 * Delegate calls on one seat run sequentially (a promise chain per seat):
 * the slice machinery at this seam dispatches one mini-loop per call, and
 * serializing keeps the todo read-modify-writes and the per-seat counter
 * race-free without new concurrency machinery.
 *
 * @sem domain=routing role=orchestrator
 */

import { allocateSlice, LADDER_RANK, type EconTier } from "@opencode-ai/code-intelligence"
import {
  extractSliceFiles,
  inferSliceType,
  runConductorSliceLoop,
  todosToLoopSlices,
  type ConductorLoopOptions,
  type ConductorSliceDispatch,
  type InjectedSliceTodo,
  type OrchestrationTodo,
  type SliceProbes,
} from "./slice-orchestrator"

/** Q-O — per-slice delegate bound (mirrors the 3–5 branching discipline of the todo tree, and keeps a parent's children ≤5 in the store). */
export const MAX_DELEGATES_PER_SLICE = 4

/** What the model names when it delegates: the work, and optional shape/scope hints. Tier is never a parameter — code picks it. */
export interface DelegateParams {
  /** The delegate's whole brief — exact paths, method when it matters, and the report expected back. */
  readonly content: string
  /** Optional DAG-node shape hint (design/mechanical/recon/verify); inferred from the content when absent. */
  readonly sliceType?: string
  /** Optional explicit file scope; folded into the brief so the probes/wiring see it, and checked against the parent slice's scope. */
  readonly files?: readonly string[]
}

/** One telemetry row per delegate call — refused or dispatched, with the deciding reason. */
export interface DelegateTelemetry {
  readonly parentSliceId: string
  readonly callerTier: EconTier
  readonly resolvedTier?: EconTier
  readonly outcome: "dispatched" | "refused"
  readonly reason: string
}

/** The live seams a delegation seat needs from the host — all shared with the conductor's own orchestration path (one pipeline, no clone). */
export interface DelegationPorts {
  /** The SAME child-spawn closure the conductor's slice loop uses (prompt.ts dispatch). */
  readonly dispatch: ConductorSliceDispatch
  /** The OL-7.9 coupling/test-strength/verify-command probes. */
  readonly probes: SliceProbes
  /** The conductor loop options (snapshot bracket, judge/confidence samplers, cwd, provenance sink) — the delegate mini-loop rides the same safety stack. */
  readonly options?: ConductorLoopOptions
  /** Read the live session todo list (for the parent-todo index lookup). */
  readonly getTodos: () => Promise<readonly OrchestrationTodo[]>
  /** Append one child todo to the live list; resolves to its position index. */
  readonly appendTodo: (todo: InjectedSliceTodo) => Promise<number>
  /** Settle a todo's status by position index. */
  readonly setTodoStatus: (index: number, status: string) => Promise<void>
  /** Telemetry sink — one row per delegate call (callback-to-caller pattern; the host emits Effect.logInfo). */
  readonly onDelegate?: (info: DelegateTelemetry) => void
}

/** One registered delegating seat: a reasoner/oracle slice child session that may delegate. */
export interface DelegationSeat {
  /** The parent slice's id (its todo content) — the goal item delegates are recorded under. */
  readonly parentSliceId: string
  /** The seat's own tier — the down-only ceiling. */
  readonly callerTier: EconTier
  /** The parent slice's predicted file scope (extractSliceFiles over its brief) — the containment boundary. */
  readonly parentScope: ReadonlySet<string>
  readonly ports: DelegationPorts
  /** Accepted delegates so far (refusals don't consume the budget). */
  used: number
  /** Per-seat serialization chain — delegate calls on one seat never interleave. */
  chain: Promise<void>
}

// ---------------------------------------------------------------------------
// Seat registry — keyed by the CHILD SESSION id the seat runs as. The
// dispatch closure registers a seat right before prompting a reasoner/oracle
// slice child (never a delegate child — depth-1) and releases it when the
// child settles; the delegate tool resolves its caller's seat here.
// ---------------------------------------------------------------------------

const seats = new Map<string, DelegationSeat>()

export function registerDelegationSeat(
  sessionID: string,
  init: Pick<DelegationSeat, "parentSliceId" | "callerTier" | "parentScope" | "ports">,
): void {
  seats.set(sessionID, { ...init, used: 0, chain: Promise.resolve() })
}

export function releaseDelegationSeat(sessionID: string): void {
  seats.delete(sessionID)
}

export function getDelegationSeat(sessionID: string): DelegationSeat | undefined {
  return seats.get(sessionID)
}

/** What the delegate tool returns to the calling model. */
export interface DelegateResult {
  refused: boolean
  /** The dispatched tier (post-allocation) when not refused. */
  tier?: EconTier
  output: string
}

/** Slice ids are todo content, deduped with a `#N` suffix on collision — strip it for the todo lookup. */
function parentTodoIndex(todos: readonly OrchestrationTodo[], parentSliceId: string): number | undefined {
  const content = parentSliceId.replace(/#\d+$/, "")
  const idx = todos.findIndex((t) => t.content === content || t.content === parentSliceId)
  return idx >= 0 ? idx : undefined
}

/** Cap on the delegate's output carried back into the caller's context — digests, not transcripts (mirrors the synthesis digest cap). */
const DELEGATE_OUTPUT_CHAR_CAP = 4000

/**
 * Execute one delegate call against a seat: policy checks (budget, scope,
 * down-only allocation), child-todo recording, then the one-slice pipeline
 * run. Serialized per seat via `seat.chain`. Never throws — every failure
 * mode returns a model-readable result and a telemetry row.
 */
export function delegateFromSeat(seat: DelegationSeat, params: DelegateParams): Promise<DelegateResult> {
  const run = () => runDelegate(seat, params)
  const next = seat.chain.then(run, run)
  seat.chain = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

function refuse(seat: DelegationSeat, reason: string, resolvedTier?: EconTier): DelegateResult {
  seat.ports.onDelegate?.({
    parentSliceId: seat.parentSliceId,
    callerTier: seat.callerTier,
    ...(resolvedTier ? { resolvedTier } : {}),
    outcome: "refused",
    reason,
  })
  return { refused: true, output: `DELEGATE REFUSED — ${reason}` }
}

async function runDelegate(seat: DelegationSeat, params: DelegateParams): Promise<DelegateResult> {
  // --- Bound: ≤4 accepted delegates per parent slice; the next call refuses.
  if (seat.used >= MAX_DELEGATES_PER_SLICE) {
    return refuse(
      seat,
      `this slice already dispatched ${MAX_DELEGATES_PER_SLICE} delegates (the per-slice cap). Do the remaining work yourself in this slice, or return with the discovery declared so the conductor re-plans it.`,
    )
  }

  // --- Brief: fold the explicit files hint into the content so the probes,
  //     wiring, and P6b scope extraction all see the same scope.
  const files = params.files ?? []
  const content = files.length > 0 ? `${params.content}\nFiles in scope: ${files.join(", ")}` : params.content

  // --- Scope containment (P6b machinery): the delegate must stay inside the
  //     parent slice's own predicted scope. No parent scope ⇒ no computable
  //     boundary ⇒ the check stands down (no false overlap).
  const delegateScope = new Set<string>([...files, ...extractSliceFiles(content)])
  if (seat.parentScope.size > 0) {
    const outOfScope = [...delegateScope].filter((f) => !seat.parentScope.has(f))
    if (outOfScope.length > 0) {
      return refuse(
        seat,
        `out of scope: [${outOfScope.join(", ")}] are outside this slice's own file scope [${[...seat.parentScope].join(", ")}]. A delegate must stay inside the parent slice's scope — return with the discovery declared instead.`,
      )
    }
  }

  // --- Build the one-slice DAG through the SAME todo→slice conversion the
  //     conductor's plan rides (probes, verify commands, probe pin, patch
  //     contract). Deliberately NO arming here: a delegate is the parent
  //     seat's mechanical residue — the parent already absorbed the turn's
  //     difficulty, and flooring every delegate at the reasoner would make
  //     down-only refuse the mechanism on exactly the turns it serves.
  const sliceType = params.sliceType && params.sliceType.trim().length > 0 ? params.sliceType : inferSliceType(content)
  const todo: OrchestrationTodo = { content, status: "pending", sliceType }
  const [slice] = await todosToLoopSlices([todo], seat.ports.probes)
  if (!slice) {
    return refuse(seat, `the delegate description did not produce a dispatchable slice (sliceType "${sliceType}").`)
  }

  // --- Down-only (Q-O): the resolved tier must rank strictly below the
  //     caller on the capability ladder. evaluate() inside the pipeline can
  //     only hold or round DOWN from this base, so the allocator is the
  //     honest ceiling to gate on.
  const allocation = allocateSlice({
    sliceType: slice.sliceType,
    coupling: slice.coupling,
    testStrength: slice.testStrength,
    need: slice.need,
    risk: slice.risk,
    specBacked: slice.specBacked,
  })
  if (LADDER_RANK[allocation.tier] >= LADDER_RANK[seat.callerTier]) {
    return refuse(
      seat,
      `this work allocates to the ${allocation.tier} tier, at or above your own seat (${seat.callerTier}) — that's your job. Do it in this slice, or return with the discovery declared for re-decomposition. (${allocation.reason})`,
      allocation.tier,
    )
  }

  // --- Accepted: reserve the budget slot, record the child todo (tool
  //     handler, never the model), then run the ONE slice pipeline.
  seat.used++
  const todos = await seat.ports.getTodos()
  const parentIdx = parentTodoIndex(todos, seat.parentSliceId)
  const childTodo: InjectedSliceTodo = {
    content,
    status: "in_progress",
    priority: "medium",
    sliceType,
    ...(parentIdx !== undefined ? { parentID: parentIdx } : {}),
  }
  let childIdx: number
  try {
    childIdx = await seat.ports.appendTodo(childTodo)
  } catch {
    // The store's tree validation can reject a parentID edge (e.g. the parent
    // sits at the depth cap). The record must not be lost — re-append as a
    // root item, mirroring reconcileSettledSlices' parentID-strip fallback.
    const { parentID: _dropped, ...rootTodo } = childTodo
    childIdx = await seat.ports.appendTodo(rootTodo as InjectedSliceTodo)
  }

  try {
    const result = await runConductorSliceLoop(
      [slice],
      // Depth-1: every request this mini-loop issues — the cheap hop and any
      // rescue hop — is marked delegated, so the host never grants the child
      // its own delegation seat and its permissions deny delegate/task.
      (req) => seat.ports.dispatch({ ...req, delegated: true }),
      {
        ...seat.ports.options,
        requestingTier: seat.callerTier,
        parentScope: seat.parentScope,
      },
    )
    const outcome = result.outcomes[0]!
    // Settlement: the child todo settles when the delegate's verification
    // settles (blocked is unreachable for a dep-less single slice).
    await seat.ports.setTodoStatus(childIdx, outcome.state === "blocked" ? "cancelled" : "completed")
    seat.ports.onDelegate?.({
      parentSliceId: seat.parentSliceId,
      callerTier: seat.callerTier,
      resolvedTier: outcome.tier,
      outcome: "dispatched",
      reason: allocation.reason,
    })
    const finalTier = outcome.escalation?.tier ?? outcome.tier
    const body =
      outcome.output.length > DELEGATE_OUTPUT_CHAR_CAP
        ? `${outcome.output.slice(0, DELEGATE_OUTPUT_CHAR_CAP)}\n…[truncated]`
        : outcome.output
    return {
      refused: false,
      tier: outcome.tier,
      output: [
        `DELEGATED → ${finalTier} [state=${outcome.state}, rung=${outcome.verdict.rung}, attempts=${outcome.attempts}]`,
        body,
      ].join("\n"),
    }
  } catch (err) {
    // "cancelled" — the store's status vocabulary is the four standard values
    // (blocked slices settle the same way); the error detail rides the
    // telemetry row and the tool output below.
    await seat.ports.setTodoStatus(childIdx, "cancelled").catch(() => {})
    const message = err instanceof Error ? err.message : String(err)
    seat.ports.onDelegate?.({
      parentSliceId: seat.parentSliceId,
      callerTier: seat.callerTier,
      resolvedTier: allocation.tier,
      outcome: "dispatched",
      reason: `loop-error: ${message}`,
    })
    return {
      refused: false,
      tier: allocation.tier,
      output: `DELEGATE FAILED — the dispatched slice errored before settling: ${message}. Its todo is marked failed; do the work yourself or return with the discovery declared.`,
    }
  }
}
