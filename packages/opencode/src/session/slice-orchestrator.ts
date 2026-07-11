/**
 * Live wiring for the execute-cheap-then-verify slice loop (OL-7.3 + OL-2.2) at
 * the conductor's execution seam. The pure state machine lives in
 * code-intelligence (`slice-loop.ts`); this module binds its injected ports to
 * opencode's real primitives — the sub-agent dispatch, the child session's
 * recorded trajectory, a bounded shell command runner for the sound rung, and
 * tier→model resolution. Engagement is unconditional and driven solely by
 * `hasPendingTypedSlices`: the conductor calls `runConductorSliceLoop` after it
 * has decomposed a complex turn into a typed DAG (OL-7.1/7.9/7.2 populate the
 * LoopSlice[]).
 *
 * @sem domain=routing role=orchestrator
 */

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { TriageGoal, TriageVerdict } from "./turn-triage"
import type { ArmingDecision } from "./arming-judge"
import { detectPythonHarness } from "../tool/graph-tools"
import {
  GRIND_DESIGN_SLICE_CONTENT,
  LOCALIZATION_SLICE_CONTENT,
  PLAN_SLICE_CONTENT,
  REDECOMPOSITION_SLICE_CONTENT,
  REPRO_SLICE_CONTENT,
} from "./prompts/seeds"
import { getResolveAttempts, incResolveAttempts } from "./resolution-store"
import {
  runSliceLoop,
  tierModelRef,
  ECON_PERSONAS,
  allocateSlice,
  TIER_RANK,
  planWaves,
  validatePlan,
  resolutionDecision,
  redecompositionCheck,
  MAX_RESOLVE_ATTEMPTS,
  answerChannelTokens,
  perplexityFromLogprobs,
  signalFromPerplexity,
  type EconPersona,
  type LoopSlice,
  type SliceLoopDeps,
  type SliceDispatchRequest,
  type SliceDispatchResult,
  type SliceLoopResult,
  type SliceOutcome,
  type SliceTrajectory,
  type TrajectoryEvent,
  type CommandRunner,
  type VerifyCommand,
  type CommandResult,
  type EconTier,
  type ExtraRungFn,
  type SliceHardness,
  type SliceAmbiguity,
  type PlanNode,
  type ResolutionMode,
  type RedecompositionSignals,
  type RedecompositionTrigger,
  type ModelFamily,
  type LogprobToken,
  type UncertaintySignal,
} from "@opencode-ai/code-intelligence"

// ---------------------------------------------------------------------------
// Persona resolution (OL-9.1b) — which intern persona runs a dispatched slice
// ---------------------------------------------------------------------------

/**
 * Resolve the persona a dispatched slice runs as: an explicit `persona` on the
 * todo/slice wins when it names a real ECON_PERSONAS member (read defensively —
 * the field may be absent until the todo schema carries it); otherwise the
 * slice's type maps deterministically (recon→explorer, verify→runner,
 * mechanical→applier, design/other→procedure). `author`/`researcher` are
 * therefore only reachable via the explicit field — with ONE shape-scoped
 * exception (P3/Q-D): on a research-shaped turn (`researchShaped`, from the
 * turn-read verdict) a `recon` slice defaults to the web-enabled `researcher`
 * instead of the repo-only `explorer` — external sources ARE the deliverable.
 * Pure so the dispatch closure and tests share one source of truth.
 *
 * @sem domain=routing role=router
 */
export function personaForSlice(
  slice: Pick<OrchestrationTodo, "sliceType" | "persona">,
  opts?: { researchShaped?: boolean },
): EconPersona {
  if (typeof slice.persona === "string" && (ECON_PERSONAS as readonly string[]).includes(slice.persona)) {
    return slice.persona as EconPersona
  }
  switch (slice.sliceType) {
    case "recon":
      return opts?.researchShaped ? "researcher" : "explorer"
    case "verify":
      return "runner"
    case "mechanical":
      return "applier"
    default:
      return "procedure"
  }
}

// ---------------------------------------------------------------------------
// Child-session permissions — a headless slice can never answer an "ask"
// ---------------------------------------------------------------------------

/** Minimal structural permission rule (assignable to PermissionV1.Rule). */
export interface SlicePermissionRule {
  permission: string
  pattern: string
  action: "allow" | "deny" | "ask"
}

/**
 * Permission rules for a headless slice child session. No user is attached to
 * a child, so any rule that evaluates to "ask" deadlocks the entire run — the
 * permission service parks the request on a Deferred nobody resolves (a live
 * conductor rescue froze on its first bash call this way; so did both of run
 * 4's repro attempts, and a live run froze a second time when a slice's
 * agent/config ruleset allowed the task tool and it spawned a grandchild that
 * then froze on its own permission ask). Session rules are merged after
 * agent/config rules and evaluation is last-match-wins, so this overlay
 * coerces every askable surface the slices actually hit to a decisive action:
 * bash and edit ARE the slice's work (allow); the danger set is re-pinned to
 * deny AFTER the broad bash allow; blocking/interactive surfaces (question)
 * and the network are denied so loop-on-deny bounces the model to an
 * alternative instead of dead-ending; task is denied unconditionally — a
 * slice can never re-orchestrate by spawning a subagent of its own, no matter
 * what the agent/config ruleset says, because delegation is the conductor's
 * job alone. The read-only lane (recon/verify) lands last of all and beats
 * the edit allow. Two personas run tighter than their lane: the researcher's
 * job is read+fetch only (webfetch/websearch flip to allow, bash+edit to
 * deny), and the explorer's job is read/search only (bash+edit deny — recon
 * happens through the read tools; probing with shell commands is the runner's
 * shape), so neither can ever touch the working tree or a shell. P11b: the
 * `delegate` tool is the ONE downward door — allowed only for a delegating
 * seat (a reasoner/oracle slice child that is not itself a delegate child,
 * `isDelegatingSeat`), denied everywhere else, so an executor seat or a
 * delegate child never sees it (a wildcard deny also drops it from the
 * advertised toolset via Permission.disabled).
 *
 * @sem domain=routing role=config
 */
export function childSlicePermission(
  parent: readonly SlicePermissionRule[] | undefined,
  readOnly: boolean,
  persona?: EconPersona,
  deciderSeat = false,
  delegatingSeat = false,
): SlicePermissionRule[] {
  const isResearcher = persona === "researcher"
  // F6 seat-scoping (casting rule 4): a decider seat loses the grind surfaces
  // by construction — not advisory prompt text. Judgment slices at reasoner/
  // oracle were burning the whole tool cap re-running suites and sweeping
  // files inline; their product is a verdict/plan, and command evidence
  // arrives from the sound rung and runner slices instead.
  const noShell = isResearcher || persona === "explorer" || deciderSeat
  return [
    ...(parent ?? []),
    { permission: "bash", pattern: "*", action: noShell ? "deny" : "allow" },
    { permission: "edit", pattern: "*", action: noShell ? "deny" : "allow" },
    { permission: "question", pattern: "*", action: "deny" },
    { permission: "task", pattern: "*", action: "deny" },
    { permission: "delegate", pattern: "*", action: delegatingSeat ? "allow" : "deny" },
    { permission: "webfetch", pattern: "*", action: isResearcher ? "allow" : "deny" },
    { permission: "websearch", pattern: "*", action: isResearcher ? "allow" : "deny" },
    { permission: "skill", pattern: "*", action: "deny" },
    { permission: "doom_loop", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "sudo *", action: "deny" },
    { permission: "bash", pattern: "rm -rf *", action: "deny" },
    { permission: "bash", pattern: "rm -fr *", action: "deny" },
    { permission: "bash", pattern: "git push*", action: "deny" },
    { permission: "bash", pattern: "curl *", action: "deny" },
    { permission: "bash", pattern: "wget *", action: "deny" },
    ...(readOnly && !isResearcher ? [{ permission: "edit", pattern: "*", action: "deny" as const }] : []),
  ]
}

/**
 * F6 — is this dispatch a DECIDER seat? True when the slice runs at a high
 * tier (reasoner/oracle) on a judgment-shaped sliceType (design/verify): its
 * work product is a plan or verdict authored from evidence read via the code
 * tools. Mechanical slices stay WORKER seats at every tier — an escalated
 * mechanical rescue at reasoner still needs edit and shell.
 *
 * @sem domain=routing role=config
 */
export function isDeciderSeat(tier: string, sliceType?: string): boolean {
  return (tier === "reasoner" || tier === "oracle") && (sliceType === "design" || sliceType === "verify")
}

/**
 * P11b — is this dispatch a DELEGATING seat? True for a reasoner/oracle-tier
 * slice child that is not itself a delegate child (`delegated` rides the
 * dispatch request from the delegate path's wrapper): such a seat holds the
 * `delegate` tool and a registered delegation seat, so it can hand its own
 * discovered sub-items down mid-slice. Executor seats are the floor (their
 * path is report-up → re-decomposition) and conductor-tier rescues are
 * rescues, not sub-planners — neither delegates. Depth-1 by construction:
 * a delegate child's requests carry `delegated`, so it never qualifies.
 *
 * @sem domain=routing role=config
 */
export function isDelegatingSeat(tier: string, delegated?: boolean): boolean {
  return (tier === "reasoner" || tier === "oracle") && delegated !== true
}

// ---------------------------------------------------------------------------
// Trajectory-capture seam — read the child session's recorded tool calls
// ---------------------------------------------------------------------------

/** The tool-name buckets the behavior monitor cares about (F15). */
const FILE_EDIT_TOOLS = new Set(["edit", "write", "apply_patch"])
const COMMAND_TOOLS = new Set(["shell", "bash"])

/** Minimal structural view of a completed tool part — the fields we read off a child message. */
interface ToolPartLike {
  type: string
  tool?: string
  state?: { status?: string; input?: Record<string, unknown> }
}

/** Render a compact pseudo-diff from an edit's old/new strings so the behavior monitor can scan it. */
function editDiff(input: Record<string, unknown>): string | undefined {
  const oldStr = typeof input["oldString"] === "string" ? (input["oldString"] as string) : undefined
  const newStr = typeof input["newString"] === "string" ? (input["newString"] as string) : undefined
  const content = typeof input["content"] === "string" ? (input["content"] as string) : undefined
  if (oldStr === undefined && newStr === undefined && content === undefined) return undefined
  const lines: string[] = []
  for (const l of (oldStr ?? "").split("\n")) if (l) lines.push(`-${l}`)
  for (const l of (newStr ?? content ?? "").split("\n")) if (l) lines.push(`+${l}`)
  return lines.join("\n")
}

/**
 * OL-7.3 trajectory-capture seam: build a SliceTrajectory from a child
 * session's message parts — the file edits (edit/write/apply_patch) and shell
 * commands it already recorded. The behavior monitor (F15) reads this to reject
 * a sound PASS produced by a test-dodging trajectory. Reads only completed tool
 * parts; anything unrecognised is ignored. `isTestSlice` exempts a declared
 * test-authoring slice from the test-file-edit flag.
 *
 * @sem domain=routing role=digest
 */
export function extractTrajectory(parts: readonly unknown[], isTestSlice?: boolean): SliceTrajectory {
  const events: TrajectoryEvent[] = []
  for (const raw of parts) {
    const part = raw as ToolPartLike
    if (part?.type !== "tool" || !part.tool) continue
    if (part.state?.status && part.state.status !== "completed") continue
    const input = part.state?.input ?? {}

    if (FILE_EDIT_TOOLS.has(part.tool)) {
      const filePath = (input["filePath"] ?? input["path"]) as string | undefined
      if (filePath) events.push({ kind: "file-edit", filePath, diff: editDiff(input) })
    } else if (COMMAND_TOOLS.has(part.tool)) {
      const command = input["command"]
      if (typeof command === "string") events.push({ kind: "command", command })
    }
  }
  return isTestSlice ? { isTestSlice: true, events } : { events }
}

/**
 * Count completed tool-call parts across a child session's messages — the
 * step-budget watchdog's input (OL-9.3a). Mirrors extractTrajectory's
 * completed-part filter so the two seams agree on what counts as a "step".
 *
 * @sem domain=routing role=digest
 */
export function countToolCalls(parts: readonly unknown[]): number {
  let n = 0
  for (const raw of parts) {
    const part = raw as ToolPartLike
    if (part?.type !== "tool" || !part.tool) continue
    if (part.state?.status && part.state.status !== "completed") continue
    n++
  }
  return n
}

/**
 * Per-persona step budget (OL-9.3a): the max tool-call steps a persona's child
 * session may take before the slice hook cancels it and treats the partial
 * output as the digest. Tunable — raise a persona's cap if it is starving on
 * real work, lower it if a persona tends to run away. `researcher`'s toolset
 * is narrowest (read+fetch only) so it gets the smallest budget; `procedure`
 * runs the longest numbered briefs so it gets the largest.
 *
 * @sem domain=routing role=config
 */
export const PERSONA_STEP_BUDGET: Record<EconPersona, number> = {
  explorer: 30,
  runner: 25,
  applier: 45,
  author: 45,
  researcher: 15,
  procedure: 60,
}

/**
 * The diagnosis pre-pass writer localizes across a whole unfamiliar repo AND
 * then applies the fix and re-runs the failing test in the SAME session, so it
 * needs headroom beyond a plain applier: 45 tool calls (a read-only
 * localization at 15 burned out with NOTHING delivered in the caseA live fire;
 * a writer that must also edit and iterate to green needs more, not less).
 */
export const FRAME_SLICE_STEP_BUDGET = 45

/** P8 — the difficulty/escalation signals that lift a slice's step budget, all already present at the dispatch seam (req.sliceType, req.escalated, the arming store's hardness). */
export interface SliceStepBudgetOpts {
  /** The slice's DAG node type — `design` is difficulty by construction (allocation's design-insight floor). */
  readonly sliceType?: string
  /** Arming-judge difficulty: true when the turn's hardness is `hard`. */
  readonly hard?: boolean
  /** True on an escalated rescue dispatch. */
  readonly escalated?: boolean
}

/**
 * Step budget for a slice: the diagnosis pre-pass writer gets its own
 * allowance, everything else the persona's. P8 — a design/hard slice or an
 * escalated rescue gets ×1.5: exhaustion is not graceful (the `[BUDGET
 * EXHAUSTED]` digest fails verification and the ladder double-pays a full
 * retry), so +50% steps up front on the hard tail is cheaper than a rescue.
 */
export function sliceStepBudget(persona: EconPersona, sliceId?: string, opts?: SliceStepBudgetOpts): number {
  const base = sliceId === LOCALIZATION_SLICE_CONTENT ? FRAME_SLICE_STEP_BUDGET : PERSONA_STEP_BUDGET[persona]
  return opts?.sliceType === "design" || opts?.hard || opts?.escalated ? Math.ceil(base * 1.5) : base
}

/** Fail-loud marker prepended to a slice's output when its step budget is exhausted (OL-9.3a). */
export function budgetExhaustedMarker(persona: EconPersona, budget: number = PERSONA_STEP_BUDGET[persona]): string {
  return `[BUDGET EXHAUSTED — persona "${persona}" step budget (${budget} tool calls) reached; child ended gracefully, partial output below is the digest]`
}

// ---------------------------------------------------------------------------
// Bounded shell command runner — the sound rung's live executor
// ---------------------------------------------------------------------------

/** Default per-command wall-clock ceiling for a sound-rung shell command. */
export const DEFAULT_SOUND_COMMAND_TIMEOUT_MS = 120_000

/**
 * A CommandRunner that shells out for the sound rung (typecheck / test / lint),
 * bounded by a hard timeout so a hung command can never wedge the loop. Runs in
 * the given cwd via Bun's spawn; a timeout or spawn error surfaces as a
 * non-zero exit code (a failed sound check → escalation), never a throw.
 *
 * @sem domain=routing role=sound-verify
 */
export function makeShellCommandRunner(opts?: { cwd?: string; timeoutMs?: number }): CommandRunner {
  const cwd = opts?.cwd ?? process.cwd()
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_SOUND_COMMAND_TIMEOUT_MS
  return async (command: VerifyCommand): Promise<CommandResult> => {
    try {
      const proc = Bun.spawn(["sh", "-c", command.command], { cwd, stdout: "pipe", stderr: "pipe" })
      const timer = setTimeout(() => proc.kill(), timeoutMs)
      try {
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
        return { exitCode, stdout, stderr }
      } finally {
        clearTimeout(timer)
      }
    } catch (e) {
      return { exitCode: 1, stdout: "", stderr: `slice-loop shell error: ${e instanceof Error ? e.message : String(e)}` }
    }
  }
}

// ---------------------------------------------------------------------------
// Tier → model resolution (registry-backed)
// ---------------------------------------------------------------------------

/** Resolve a slice's allocated tier to the concrete {providerID, modelID} the prompt path expects. */
export function resolveSliceModel(tier: EconTier): { providerID: string; modelID: string } {
  const ref = tierModelRef(tier)
  const slash = ref.indexOf("/")
  return slash === -1
    ? { providerID: ref, modelID: ref }
    : { providerID: ref.slice(0, slash), modelID: ref.slice(slash + 1) }
}

// ---------------------------------------------------------------------------
// The gated conductor entry point
// ---------------------------------------------------------------------------

/**
 * How the conductor runs one slice: spawn a sub-agent on `req.tier`'s model with
 * `req.prompt` and return its final text plus the parts to derive a trajectory
 * from. The caller (the session prompt loop) supplies this because the Effect
 * runtime + prompt ops live there; this module keeps the trajectory/shell/model
 * glue and the gate.
 */
export interface ConductorSliceDispatch {
  (req: SliceDispatchRequest): Promise<{ text: string; parts: readonly unknown[]; usage?: SliceDispatchResult["usage"]; isTestSlice?: boolean }>
}

/** Optional live samplers for the untestable rungs, and a shell runner override for tests. */
export interface ConductorLoopOptions {
  judgeGenerate?: (prompt: string) => Promise<string>
  qeGenerate?: (sliceId: string) => Promise<string>
  /** #59 — verbalized self-confidence fallback for the posterior-uncertainty gate (task #48): a 0-1 confidence that a slice solved the RIGHT problem, consulted ONLY when a prior-flagged slice's dispatch produced no logprob perplexity. Absent ⇒ the gate stays perplexity-only. */
  confidenceGenerate?: SliceLoopDeps["confidenceGenerate"]
  runCommand?: CommandRunner
  onEscalation?: SliceLoopDeps["onEscalation"]
  cwd?: string
  /** Execution-free RM rung (OL-7.8a); composed ahead of the judge in the ladder's extension slot. */
  rmRung?: ExtraRungFn
  /** U3 — failure-containment snapshot bracket (opencode's snapshot subsystem); absent ⇒ today's dirty-tree behavior. */
  snapshot?: SliceLoopDeps["snapshot"]
  /** U3 — escalation provenance sink (fromTier/toTier/rungReason), fired once per escalation hop. */
  onProvenance?: SliceLoopDeps["onProvenance"]
  /** P11b — the tier of the seat requesting this loop (the venue rule's `requestingTier`, P6c). Defaults to the conductor — the production caller; a delegate's mini-loop passes its caller's tier. */
  requestingTier?: EconTier
  /** P11b — files the requesting seat already has in scope (the venue rule's `sameFilesInScope` input, P6c). A delegate's mini-loop passes the parent slice's own scope. */
  parentScope?: ReadonlySet<string>
}

/**
 * #56 Part B — best-effort read of `{ token, logprob }[]` off the last text
 * part's provider metadata. The child session's stream processor stores the
 * gateway's per-token logprobs on the V1 text part's `metadata` (keyed by
 * provider, OpenAI-compatible `{ logprobs: [{ token, logprob }] }`). Any shape
 * mismatch or absent field ⇒ undefined — this runs on the hot dispatch path
 * and must never throw.
 */
export function logprobTokensFromParts(parts: readonly unknown[]): LogprobToken[] | undefined {
  try {
    const textParts = parts.filter(
      (p): p is { type: string; metadata?: Record<string, unknown> } =>
        typeof p === "object" && p !== null && (p as { type?: unknown }).type === "text",
    )
    const meta = textParts.at(-1)?.metadata as Record<string, { logprobs?: unknown }> | undefined
    if (meta === undefined) return undefined
    for (const bucket of Object.values(meta)) {
      const raw = bucket?.logprobs
      if (!Array.isArray(raw)) continue
      const tokens = raw.filter((t): t is LogprobToken => {
        const o = t as { token?: unknown; logprob?: unknown }
        return typeof o?.token === "string" && typeof o?.logprob === "number"
      })
      if (tokens.length > 0) return tokens
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * #56 Part B — derive the posterior-uncertainty signal (task #48) from a
 * dispatch's committed answer: strip the reasoning channel for the tier's model
 * family (`conductor` = inline `<mm:think>`; every other tier = the
 * `<|channel|>final` executor family, a no-op passthrough for the
 * separate-`reasoning_content` tiers), then take the answer tokens' geometric-
 * mean perplexity. Absent or unusable logprobs — the common case today: the
 * litellm provider path does not yet request them — ⇒ undefined, and the
 * accept-on-green gate falls back to the verbalized-confidence probe (#59).
 *
 * @sem domain=routing role=converter
 */
export function uncertaintyFromParts(parts: readonly unknown[], tier: EconTier): UncertaintySignal | undefined {
  const tokens = logprobTokensFromParts(parts)
  if (tokens === undefined || tokens.length === 0) return undefined
  const family: ModelFamily = tier === "conductor" ? "conductor" : "executor"
  const perplexity = perplexityFromLogprobs(answerChannelTokens(tokens, family))
  if (perplexity === undefined) return undefined
  return signalFromPerplexity(perplexity)
}

/**
 * #55 — derive the §4.2 re-decomposition signals from a settled run's
 * outcomes. An `unverified` slice (rejected but already at the top tier —
 * accepted-with-warning) is a coverage gap: real work we could not confirm,
 * surfaced as a `new-items` trigger rather than lost silently. A run that
 * escalated more than half its slices tracked well over its cheap-tier budget
 * (`escalate-tier`, informational — the per-slice escalation already happened
 * inside the loop). Pure so the wiring and its tests share one derivation.
 *
 * @sem domain=routing role=converter
 */
export function redecompositionSignalsFromOutcomes(outcomes: readonly SliceOutcome[]): RedecompositionSignals {
  const total = outcomes.length
  // P6a: a `blocked` slice (dep terminal-failed, never dispatched) is a
  // coverage gap exactly like an unverified one — work the run did not deliver,
  // surfaced to the re-plan seed rather than lost silently (Q-J decision).
  const coverageGaps = outcomes.filter((o) => o.state === "unverified" || o.state === "blocked").length
  const escalated = outcomes.filter((o) => o.state === "escalated").length
  return {
    coverageGaps,
    budgetOverrunPct: total > 0 && escalated / total > 0.5 ? 100 : 0,
  }
}

/**
 * Run a decomposed DAG through the slice loop at the conductor seam. Wraps the
 * caller's dispatch to attach the child-session trajectory and binds the live
 * shell runner + tier→model resolution before delegating to the pure loop.
 *
 * @sem domain=routing role=orchestrator
 */
export async function runConductorSliceLoop(
  slices: readonly LoopSlice[],
  dispatch: ConductorSliceDispatch,
  options?: ConductorLoopOptions,
): Promise<SliceLoopResult> {
  const sliceById = new Map(slices.map((s) => [s.id, s]))
  const wrappedDispatch: SliceLoopDeps["dispatch"] = async (req) => {
    const out = await dispatch(req)
    const slice = sliceById.get(req.sliceId)
    return {
      text: out.text,
      trajectory: extractTrajectory(out.parts, out.isTestSlice ?? slice?.isTestSlice),
      usage: out.usage,
      // #56 Part B — populate the posterior-uncertainty signal from the
      // dispatch's own logprobs when the gateway returned them; undefined
      // (today's common case) leaves the #48 gate on its #59 fallback.
      uncertainty: uncertaintyFromParts(out.parts, req.tier),
    }
  }

  const deps: SliceLoopDeps = {
    dispatch: wrappedDispatch,
    runCommand: options?.runCommand ?? makeShellCommandRunner({ cwd: options?.cwd }),
    judgeGenerate: options?.judgeGenerate,
    qeGenerate: options?.qeGenerate,
    confidenceGenerate: options?.confidenceGenerate,
    onEscalation: options?.onEscalation,
    rmRung: options?.rmRung,
    snapshot: options?.snapshot,
    onProvenance: options?.onProvenance,
    // P6b/P6c — predicted edit scope from the path-shaped tokens the slice's
    // own text names (the same extraction the coupling probes consume). Cheap,
    // deterministic, and empty when a slice names no files (no false overlap).
    // The conductor is the default requesting seat; a P11b delegate mini-loop
    // overrides it with the caller seat's tier and the parent slice's scope.
    editScopeOf: (slice) => new Set(extractSliceFiles(`${slice.prompt}\n${slice.wiring ?? ""}`)),
    requestingTier: options?.requestingTier ?? "conductor",
    ...(options?.parentScope ? { parentScope: options.parentScope } : {}),
  }

  return runSliceLoop(slices, deps)
}

// ---------------------------------------------------------------------------
// OL-7.3b — the live invocation driver: typed todos → slice loop → mirror
// ---------------------------------------------------------------------------

/**
 * The subset of a SessionTodo item the orchestration driver reads: the visible
 * fields plus the OL-7.1 typed-decomposition fields and the OL-9.1b persona
 * override. Kept structural (not imported from core's todo schema) so the
 * driver stays free of an Effect/DB dependency and is unit-testable with
 * plain objects.
 */
export interface OrchestrationTodo {
  readonly content: string
  readonly status: string
  readonly sliceType?: string
  readonly need?: string
  readonly deps?: readonly string[]
  readonly coupling?: string
  readonly testStrength?: string
  /** Explicit persona override (OL-9.1b) — only takes effect when it names an ECON_PERSONAS member; see personaForSlice. */
  readonly persona?: string
  /**
   * U2a goal-tree position index of this todo's parent within the same list
   * (goal → task → sub-item). The live todo store persists it (SessionTodo's
   * `parent_id` column), so it survives past turn-open; P11b threads it into
   * `todosToPlanNodes` (delegate sub-items render as a tree, and validatePlan
   * sees the real depth/branching) and the delegate tool writes it on every
   * accepted delegate's child todo.
   */
  readonly parentID?: number
}

/** True when a todo carries a non-empty OL-7.1 slice type — i.e. it is a decomposition-DAG node. */
function isTypedSlice(todo: OrchestrationTodo): boolean {
  return typeof todo.sliceType === "string" && todo.sliceType.length > 0
}

/** Terminal todo statuses — a slice that already reached one of these is settled and must not be re-converted into a dispatchable LoopSlice on a later engagement (OL-9.5c settled-slice memory). */
const TERMINAL_TODO_STATUSES = new Set(["completed", "failed", "cancelled"])

/** True when a todo is an OL-7.1 typed slice AND has not yet settled — the only todos todosToLoopSlices converts into dispatchable LoopSlices. */
function isDispatchableSlice(todo: OrchestrationTodo): boolean {
  return isTypedSlice(todo) && !TERMINAL_TODO_STATUSES.has(todo.status)
}

/**
 * The engagement predicate for the conductor hook: true only when at least one
 * todo carries an explicit, conductor-authored sliceType and is still
 * `pending`. Run-8 post-mortem (OL-9.5c): the old rule ALSO engaged any
 * untyped batch of >=3 items with one pending, on the theory that the
 * conductor had simply skipped typing — but every run-8 todo was untyped, so
 * that clause alone spun up 109 child sessions / 868 LLM calls for one
 * trivial issue. It is deleted here; `withDerivedTypes`/`inferSliceType`
 * still exist to backfill a sliceType for a caller that hands
 * todosToLoopSlices an all-untyped batch directly (e.g. the eval
 * decomp-scorer), but neither plays any part in this predicate anymore. The
 * pending gate doubles as the re-entry guard — once the loop has mirrored its
 * slices to `completed`, a later turn step sees no pending typed slice and
 * does not re-dispatch the DAG.
 *
 * @sem domain=routing role=router
 */
export function hasPendingTypedSlices(todos: readonly OrchestrationTodo[]): boolean {
  return todos.some((t) => isTypedSlice(t) && t.status === "pending")
}

/**
 * Path-shaped tokens a slice's text names — fed to the probes. Two forms: a
 * `/`-qualified path with any short extension, or a BARE filename with a known
 * source extension (12039 tuning, M1: the conductor typed "Apply the fix to
 * ddl_references.py" — no slash, so the slice probed with zero files, landed
 * untestable, and a handed fix authored at the reasoner). Bare matching stays
 * extension-whitelisted so prose abbreviations ("e.g.", "v1.2") never match.
 */
const SLICE_FILE_RE =
  /[\w./-]+\/[\w.-]+\.[a-z]{1,5}\b|\b[\w-]+\.(?:py|pyi|ts|tsx|js|jsx|mjs|cjs|go|rs|java|rb|c|h|cc|cpp|hpp|cs|php|swift|kt|scala|sql|sh|json|yaml|yml|toml)\b/gi

/** Path-shaped tokens a slice's text names — the shared scope extraction the probes, the P6b edit-scope probe, and the P11b delegate scope-containment gate all read. */
export function extractSliceFiles(text: string): string[] {
  const seen = new Set<string>()
  for (const m of text.matchAll(SLICE_FILE_RE)) seen.add(m[0])
  return [...seen]
}

/** Dotted identifier chains (≥3 segments) that MAY be python module paths — resolved against the real tree below. */
const DOTTED_MODULE_RE = /\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*){2,}\b/g

/**
 * 12039 tuning (M2): python prose names code by MODULE path, not file path —
 * "django.db.backends.ddl_references.Columns" carries the file but
 * `extractSliceFiles` can't see it. Resolve each dotted chain against the
 * REAL tree: the longest prefix (≥2 segments) that exists as `<segs>.py`
 * under `cwd` wins — trailing segments are symbols (Class.method), not path
 * parts. Existence-checked, so prose dots ("e.g.a.b") resolve to nothing.
 */
export function resolveDottedPyModules(text: string, cwd: string = process.cwd()): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(DOTTED_MODULE_RE)) {
    const segs = m[0].split(".")
    for (let k = segs.length; k >= 2; k--) {
      const candidate = `${segs.slice(0, k).join("/")}.py`
      if (existsSync(join(cwd, candidate))) {
        out.add(candidate)
        break
      }
    }
  }
  return [...out]
}

/** Injected probe surface — the OL-7.9 coupling/test-strength probes, or test doubles. */
export interface SliceProbes {
  probeCoupling: (text: string, files: string[]) => Promise<{ coupling: "low" | "high" }>
  probeTestStrength: (files: string[]) => Promise<{ testStrength: "testable" | "untestable" }>
  /** Repo-derived sound-rung commands (package scripts) for a slice whose text names none; optional — absent degrades to text-extraction only (F2). */
  probeVerifyCommands?: (files: string[]) => Promise<readonly VerifyCommand[]>
}

// ---------------------------------------------------------------------------
// Verify-command derivation (F2) — the sound rung only bites when a slice
// carries real commands. Before this, `verifyCommands` was never populated on
// the live path: the sound rung short-circuited on every slice, a "run the
// suite" runner slice reporting a RED suite passed QE (accurate report =
// success), and the escalation ladder had no reject to climb on.
// ---------------------------------------------------------------------------

// A backticked string in a slice's text is a command only when it opens with a
// known runner token. Conservative: prose backticks (`Suit.HEART`, `col_str`)
// must not match.
const VERIFY_COMMAND_OPENER_RE =
  /^(?:bun|bunx|npm|npx|pnpm|yarn|node|deno|tsc|jest|vitest|mocha|pytest|python3?|go|cargo|make|mvn|gradle|rake|ruby|php|dotnet|eslint|ruff|flake8|mypy)\b/

function verifyCommandKind(command: string): VerifyCommand["kind"] {
  if (/\b(?:typecheck|tsc|mypy)\b/.test(command)) return "typecheck"
  if (/\b(?:lint|eslint|ruff|flake8)\b/.test(command)) return "lint"
  return "test"
}

/**
 * Pull sound-rung commands out of a slice's own text: backticked strings that
 * open with a known runner token, classified typecheck/lint/test by keyword.
 * A verify item usually names its exact command ("run `bun test packages/x`")
 * — that text IS the spec; this makes it executable. Capped at 3.
 */
export function extractVerifyCommands(text: string): VerifyCommand[] {
  const commands: VerifyCommand[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const candidate = m[1]!.trim()
    if (!VERIFY_COMMAND_OPENER_RE.test(candidate) || seen.has(candidate)) continue
    seen.add(candidate)
    commands.push({ kind: verifyCommandKind(candidate), command: candidate })
    if (commands.length >= 3) break
  }
  return commands
}

// Task #7 (probe rung) — a pinned reproduction must target a SPECIFIC case: a
// named test file, or a -t/--grep/-k filter. A bare `bun test`/`pnpm test`
// (no file, no filter) is a whole-suite run, not a repro — it still qualifies
// as a generic verifyCommands entry, just never as probeCommand.
const REPRO_FILE_RE = /\.(?:test|spec)\.[a-zA-Z]+\b|(?:^|[\s/])(?:tests?|specs?)\/[^\s`]+/i
const REPRO_FILTER_RE = /(?:^|\s)(?:-t|-k|--grep)\b/
// S1 — an AUTHORED repro script (django-11964/12039: no existing test names
// the bug) qualifies as a pin too: `repro`/`reproduce`-named source file, any
// language. Scored below a named test file/filter (2-3) so a real test still
// outranks a synthetic script when both are on offer; a bare whole-suite
// command (neither RE matches) still scores 0 — never a repro.
const REPRO_SCRIPT_RE = /(?:^|[\s/])(?:repro|reproduce)[\w.-]*\.(?:py|js|ts|mjs|sh|rb)\b/i

/** Specificity score for a repro candidate (0 disqualifies it — not a repro). */
function reproSpecificity(cmd: VerifyCommand): number {
  if (cmd.kind !== "test") return 0
  // A multi-line compound command (a batched probe script) is a PROBE, not a
  // contract: pinning one wedges the turn on every section it bundles —
  // including self-invented edge asserts stricter than the issue (observed on
  // the first strict 11790 run, which timed out gate-locked on one). Only a
  // single runnable command may become the turn's pinned reproduction.
  if (cmd.command.includes("\n")) return 0
  const named = (REPRO_FILE_RE.test(cmd.command) ? 2 : 0) + (REPRO_FILTER_RE.test(cmd.command) ? 1 : 0)
  return named > 0 ? named : REPRO_SCRIPT_RE.test(cmd.command) ? 1 : 0
}

/**
 * The most-specific pinned reproduction among a slice's extracted verify
 * commands (task #7 probe rung) — reuses `extractVerifyCommands`'s output,
 * only ranks it; `undefined` when nothing extracted qualifies as a targeted
 * repro (a bare typecheck/lint/whole-suite command never does).
 */
function mostSpecificRepro(commands: readonly VerifyCommand[]): VerifyCommand | undefined {
  let best: VerifyCommand | undefined
  let bestScore = 0
  for (const cmd of commands) {
    const score = reproSpecificity(cmd)
    if (score > bestScore) {
      bestScore = score
      best = cmd
    }
  }
  return best
}

// Items whose job is to author/extend tests — the batch then legitimately
// edits test files: the guard below is skipped and the slice is marked
// isTestSlice so the behavior monitor's test-file-edit flag stays quiet.
const TEST_AUTHORING_RE = /^\s*(?:add|write|create|author|update|extend)\b.*\btests?\b/i

/**
 * The unmodified-test-tree guard (benchmark 11885): a green suite proves
 * nothing when the suite itself was edited to match the patch. Prepended to
 * every command-backed spec — lists tracked test files with MODIFICATIONS
 * (`--diff-filter=M`; brand-new repro test files stay legal) and fails the
 * sound rung with the file list as evidence. Inert outside a git repo.
 */
export const TEST_TREE_GUARD_COMMAND: VerifyCommand = {
  kind: "guard",
  command:
    'dirty=$(git diff --name-only --diff-filter=M HEAD -- 2>/dev/null | grep -E "(^|/)(tests?|__tests__|specs?)/|\\.(test|spec)\\.[a-zA-Z]+$|_test\\.[a-z]+$|(^|/)test_[^/]+\\.py$|(^|/)tests?\\.py$"); if [ -n "$dirty" ]; then echo "test files modified — a green suite over an edited oracle is invalid:"; echo "$dirty"; exit 1; fi',
}

// ---------------------------------------------------------------------------
// Turn-level prove-it gate (M4) — the reproduction backstop for INLINE fixes
// ---------------------------------------------------------------------------

/**
 * M4/S1 — the turn-end pinned reproduction: the command itself, plus (only
 * for a runner-confirmed red) the exit code and output tail that proved it
 * red. A prompt-text-named pin carries no `redEvidence` — it was never
 * executed to confirm, just extracted.
 */
export interface TurnProbePin {
  readonly probe: VerifyCommand
  readonly redEvidence?: { readonly exitCode: number; readonly outputTail: string }
}

/**
 * The pinned reproduction for the turn-end prove-it gate, from the best
 * available source: a command the turn's prompt names wins when present
 * (the turn-level analogue of a slice's probeCommand); otherwise, given
 * candidate tests and a runner, falls back to the most-specific candidate
 * that is currently RED, so a narrative issue naming no command still gets
 * a pinned probe the turn-end gate can require go green. Lets the turn-end
 * gate re-run the exact failing case even when the conductor fixed the bug
 * inline and dispatched no slices, where the slice-level probe rung never
 * engages. S1 — the red-state fallback's confirming run is captured as
 * `redEvidence` (exit code + ≤20-line output tail) so the pin carries its own
 * evidence, not just an assertion.
 *
 * @sem domain=routing role=repro-pin
 */
export async function deriveTurnProbe(opts: {
  promptText: string
  /** Candidate tests to probe for red-state when the prompt names no command. */
  candidateTests?: readonly VerifyCommand[]
  /** Injected runner for the red-state fallback; omit to skip it (prompt-text-only, as before). */
  runner?: CommandRunner
}): Promise<TurnProbePin | undefined> {
  const named = mostSpecificRepro(extractVerifyCommands(opts.promptText))
  if (named) return { probe: named }
  if (!opts.runner || !opts.candidateTests?.length) return undefined

  let best: VerifyCommand | undefined
  let bestScore = 0
  let bestRed: { exitCode: number; outputTail: string } | undefined
  for (const candidate of opts.candidateTests) {
    const score = reproSpecificity(candidate)
    if (score === 0 || score <= bestScore) continue // can't beat the current pin — skip the run
    const result = await opts.runner(candidate)
    if (result.exitCode !== 0) {
      bestScore = score
      best = candidate
      bestRed = {
        exitCode: result.exitCode,
        outputTail: (result.stderr.trim() || result.stdout.trim() || "").split("\n").slice(-20).join("\n"),
      }
    }
  }
  return best ? { probe: best, redEvidence: bestRed } : undefined
}

/** Outcome of the turn-end prove-it gate; `reject` blocks the turn from ending. */
export interface TurnProbeGateResult {
  reject: boolean
  rung?: "probe" | "test-tree"
  exitCode?: number
  reason?: string
  /** S1 — the accepting (green) run's output tail (≤20 lines), evidence-as-artifact alongside the red pin. Present only when `reject` is false. */
  outputTail?: string
}

/**
 * The turn-end backstop: a fix-shaped turn that pinned a reproduction may not
 * conclude while a tracked test was edited on a no-test-edit turn, or while the
 * pinned reproduction is still red. A reject carries the continue-message the
 * caller re-injects; a clean test tree AND green repro returns accept, with
 * the green run's output tail attached (S1 — the pin's red evidence and this
 * accept's green evidence form the done-time pair). Runs in the session cwd
 * via the same bounded shell runner the sound rung uses, so a hung command
 * can never wedge the turn.
 *
 * @sem domain=routing role=repro-gate
 */
export async function runTurnProbeGate(opts: {
  probe: VerifyCommand
  noTestEdit: boolean
  cwd?: string
  timeoutMs?: number
  runner?: CommandRunner
}): Promise<TurnProbeGateResult> {
  const runner = opts.runner ?? makeShellCommandRunner({ cwd: opts.cwd, timeoutMs: opts.timeoutMs })
  if (opts.noTestEdit) {
    const guard = await runner(TEST_TREE_GUARD_COMMAND)
    if (guard.exitCode !== 0) {
      return {
        reject: true,
        rung: "test-tree",
        exitCode: guard.exitCode,
        reason:
          `You edited a test file on a task that forbids test edits:\n${guard.stdout.trim()}\n` +
          `Revert every test change and fix the code the test checks — a green suite over an edited test proves nothing.`,
      }
    }
  }
  const result = await runner(opts.probe)
  if (result.exitCode === 0)
    return {
      reject: false,
      outputTail: (result.stderr.trim() || result.stdout.trim() || "").split("\n").slice(-20).join("\n"),
    }
  const detail = (result.stderr.trim() || result.stdout.trim() || "").split("\n").slice(-20).join("\n")
  return {
    reject: true,
    rung: "probe",
    exitCode: result.exitCode,
    reason:
      `The pinned reproduction \`${opts.probe.command}\` is STILL FAILING (exit ${result.exitCode}):\n${detail}\n` +
      `You have not fixed the root cause. Do not stop. Fix where the behavior is DEFINED (not where the error surfaces); do not edit the test to make it pass.`,
  }
}

// OL-9.3f deterministic decomposition backstop: keyword→sliceType heuristic,
// checked in this priority order (recon before verify before mechanical) so a
// multi-keyword item (e.g. "investigate then fix") lands on the earlier,
// safer-to-run-first stage rather than the destructive one.
const RECON_KEYWORDS = /\b(explore|find|trace|investigate|map|where)\b/i
const VERIFY_KEYWORDS = /\b(test|run|verify|typecheck|lint|reproduce)\b/i
const MECHANICAL_KEYWORDS = /\b(implement|fix|apply|add|wire|rename|refactor)\b/i

export function inferSliceType(content: string): string {
  if (RECON_KEYWORDS.test(content)) return "recon"
  if (VERIFY_KEYWORDS.test(content)) return "verify"
  if (MECHANICAL_KEYWORDS.test(content)) return "mechanical"
  return "mechanical"
}

// Judgment-shaped todo items: soundness verdicts, audits, edge-case/posture
// assessments — the class runs 19/20 proved the conductor self-grades wrong
// when it keeps them inline (run 20 declared "no residual risk" over a live
// silent-drop path). Deliberately narrow: produce-work verbs must NOT match.
const JUDGMENT_KEYWORDS = /\b(audit|verdict|soundness|residual risk|edge.?cases?|posture|coheren(?:t|ce)|sign.?off|is the fix (?:sound|correct))\b/i
// Pure check-run items: run/verify the suite, typecheck, lint — the verify-tail
// shape the runner persona exists for.
const VERIFY_RUN_KEYWORDS = /\b(run|re-?run|verify|check)\b.*\b(tests?|suites?|typecheck|lint|build|green|pass(?:es|ing)?)\b/i
// Mechanical INTENT is an imperative verb opening the item — "Implement fix in
// util.ts", "Add regression tests". Matching these verbs anywhere in the text
// is the run-21 false positive: the noun "fix" in a judgment item ("does fix
// keep migration coherent?") read as a build turn and suppressed all typing.
const MECHANICAL_START = /^\s*(implement|fix|apply|add|wire|rename|refactor|write|create|build|update|remove|delete)\b/i
// A leading bracketed tag on a todo item ("[audit] …", "[verdict] …") — the
// label style triagePreamble renders goals in, which the conductor mirrors
// into its own checklists. Stripped before body-level keyword classification
// in autoTypeTodos; identity on untagged content.
const TODO_TAG_RE = /^\s*\[[^\]\n]{1,24}\]\s*/
// The closing decision item of an audit list — the one that consumes the other
// dimensions ("FINAL VERDICT — SHIP or DO NOT SHIP", "APPROVE or REJECT").
// Deliberately narrow: per-dimension "sign off on X" items must NOT match,
// only the final decision does.
const VERDICT_SHAPED_RE = /\bverdict\b|\bship or do not ship\b|\bapprove or reject\b|\bfinal\s+sign.?off\b/i
// Defect-shaped item openers — the repair subset of the imperative verbs.
// Deliberately excludes implement/add/build/etc so an ordinary build list
// (the run-20 T2 shape) never reads as a bug turn.
const DIAGNOSIS_START = /^\s*(fix|debug|resolve|repair|investigate|diagnose)\b/i
// A concrete code-file target named in an item: a slashed path ending in a
// file extension, or a bare filename with a known code extension. Conservative
// on purpose — prose slashes ("read/write", "and/or") and version fragments
// ("v1.2/1.3") must not match, because a match means "localization already
// happened" and suppresses the diagnosis pre-pass below.
const FILE_TARGET_RE =
  /\b[\w.-]+\/[\w./-]*\.[a-z][a-z0-9]{0,5}\b|\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|c|cc|cpp|h|hpp|cs|php|kt|swift|sql|sh)\b/i

// F3 — plan-first build net openers: verbs that announce a DECIDED change
// ("Implement X in file.ts"). Deliberately NOT a copy of MECHANICAL_START:
// repair verbs (fix/debug/…) belong to the diagnosis pre-pass, and bare
// destructive openers (apply/remove/delete) stay with the conductor — a
// false decomposition costs more than a missed one.
const BUILD_IMPERATIVE_START =
  /^\s*(?:implement|add|create|build|wire|write|extend|refactor|migrate|convert|rename|update)\b/i

// An explicit ordering cue OPENING an item ("Then wire it in", "After the
// registry lands, update the callers") — plan structure the dep inference
// honors. Anchored so mid-sentence then/after prose never serializes an
// otherwise parallel-eligible plan; stripped before the imperative test so a
// cued build item still classifies.
const ORDERING_CUE_RE = /^\s*(?:then\b[\s,:]*|after\b[^,;]{0,60}[,;]\s*)/i

/** A decided change: a build-imperative opener (past any ordering cue) naming a concrete file target — verb + target means localization already happened. */
function isDecidedChange(todo: OrchestrationTodo): boolean {
  return BUILD_IMPERATIVE_START.test(todo.content.replace(ORDERING_CUE_RE, "")) && FILE_TARGET_RE.test(todo.content)
}

/** Every FILE_TARGET_RE hit in an item (lowercased) — the shared-target signal the dep inference reads. */
const FILE_TARGET_ALL_RE = new RegExp(FILE_TARGET_RE.source, "gi")
function fileTargetsOf(content: string): Set<string> {
  const out = new Set<string>()
  for (const m of content.matchAll(FILE_TARGET_ALL_RE)) out.add(m[0].toLowerCase())
  return out
}

/**
 * B8 — a FRESH plan: >=3 items and nothing has run yet. The conductor claims
 * item 1 `in_progress` in the SAME todowrite call that creates the list, so a
 * pending-only guard never sees it — at write time no work has happened; the
 * first item therefore counts as fresh either way. Any OTHER non-pending
 * status means work already ran (the retro-log shape, B2) and the net stands
 * down — decomposing a list mid-flight is the false-positive direction.
 */
function isFreshPlan(todos: readonly OrchestrationTodo[]): boolean {
  return todos.length >= 3 && todos.every((t, i) => t.status === "pending" || (i === 0 && t.status === "in_progress"))
}

/**
 * Shape of the todo the diagnosis pre-pass injects: OrchestrationTodo plus the
 * `priority` the todowrite boundary's SessionTodo.Info persistence requires.
 */
export interface InjectedSliceTodo extends OrchestrationTodo {
  readonly priority: string
}

/**
 * The single diagnosis pre-pass seed — shared by the turn-open triage
 * skeleton, the todowrite-time net in autoTypeTodos, and the resolve-first
 * re-seed. WRITER seat:
 * `mechanical` + `applier` leaves edit+bash ALLOWED (it is neither a decider
 * seat nor a read-only lane; see childSlicePermission/isDeciderSeat), so the
 * tier that runs it localizes, FIXES, and verifies the failing test in one
 * session instead of handing off a read-only analysis. DIFFICULTY-allocated,
 * NOT reasoner-pinned: the brief is a test-driven bug-fix writer (it runs the
 * failing test to green), so `testStrength:"testable"` clamps this mechanical
 * slice to the executor via allocateSlice and floors it to the reasoner ONLY
 * when the arming judge rates the bug genuinely hard/ambiguous (the difficulty
 * floor) — "generator tier ← difficulty". A trivial, already-located bug stays
 * on the cheap executor instead of the old blanket reasoner pin (django-12039).
 */
export const LOCALIZATION_PREPASS_TODO: InjectedSliceTodo = {
  content: LOCALIZATION_SLICE_CONTENT,
  status: "pending",
  priority: "high",
  sliceType: "mechanical",
  testStrength: "testable",
  persona: "applier",
}

/**
 * S2 — the repro-authoring pre-pass. DELIBERATELY UNTYPED (no `sliceType`) so
 * `isTypedSlice`/`hasPendingTypedSlices` never see it as a dispatchable DAG
 * node — it runs INLINE on the conductor in the ROOT session, the only place
 * that can observe its red run itself (a dispatched child's red is invisible
 * to the root's M4 pin; the existing probe-from-red path at prompt.ts's SM4
 * block is what actually pins it). Plants FIRST, before localization:
 * `buildTriageTodoSkeleton` withholds the localization seed while this one is
 * needed, and the mid-turn hand-off (prompt.ts SM4 block) plants localization
 * once the repro pins or the abstention deadline passes.
 */
export const REPRO_PREPASS_TODO: InjectedSliceTodo = {
  content: REPRO_SLICE_CONTENT,
  status: "pending",
  priority: "high",
}

/** #55 — the re-plan seed (§4.2 `new-items`): a `design` slice, so allocateSlice floors it to the reasoner (design-insight) and a lone re-plan seed still clears the shouldOrchestrate benefit gate (which keys on the ALLOCATED tier) on the hook re-fire. */
export const REDECOMPOSITION_PREPASS_TODO: InjectedSliceTodo = {
  content: REDECOMPOSITION_SLICE_CONTENT,
  status: "pending",
  priority: "high",
  sliceType: "design",
  need: "reasoner",
  persona: "researcher",
}

/** P12 — the plan seed a non-diagnosis `needsPlan` goal plants at turn open: same edit-free `design` shape as the re-plan seed (reasoner-floored by allocation, clears the benefit gate alone), but a forward-looking decomposition brief for fresh build work instead of the diagnosis writer's bug-hunt. */
export const PLAN_PREPASS_TODO: InjectedSliceTodo = {
  content: PLAN_SLICE_CONTENT,
  status: "pending",
  priority: "high",
  sliceType: "design",
  need: "reasoner",
  persona: "researcher",
}

/** L4.2 — the design seed the GRIND VALVE plants MID-TURN (prompt.ts SM4 block) when an inline conductor turn crosses its soft step budget with no green verify in the stall window (django-11885's 179-step, $0.8447 grind). Same edit-free `design`/reasoner shape as the two seeds above: the OL-7.3b slice hook dispatches it through the EXISTING delegation machinery (a lone design seed clears the shouldOrchestrate benefit gate) and the fold-back relay hands its design back to the conductor — the one inline→orchestrated mid-turn transition. */
export const GRIND_DESIGN_PREPASS_TODO: InjectedSliceTodo = {
  content: GRIND_DESIGN_SLICE_CONTENT,
  status: "pending",
  priority: "high",
  sliceType: "design",
  need: "reasoner",
  persona: "researcher",
}

// B3 — defect evidence in the USER prompt: repair verbs or symptom language.
// Serves the no-test-edit GOVERNANCE gate (isFixShapedPrompt) only — the
// turn's shape itself comes from the turn-read verdict. Deliberately requires
// defect words — a build prompt's "should return X" spec language must not match.
const PROMPT_DEFECT_EVIDENCE_RE =
  /\b(?:fix|debug|resolve|repair|diagnose|bug|broken|wrong(?:ly)?|incorrect(?:ly)?|fails?|failing|failure|error|exception|crash(?:es|ing)?|regression|instead of|unexpected(?:ly)?|doesn'?t work|not working|misbehav\w*)\b/i

/**
 * B3 — is this turn fix-shaped for the no-test-edit gate? Broader than the
 * pre-pass trigger on purpose: a grounded fix prompt that names the file is
 * still a fix turn (aligning tests to the patch is equally invalid there),
 * so no FILE_TARGET suppression here.
 *
 * @sem domain=routing role=router
 */
export function isFixShapedPrompt(userPrompt: string): boolean {
  if (!userPrompt) return false
  return PROMPT_DEFECT_EVIDENCE_RE.test(userPrompt)
}

// B3 — explicit test-work authorization: an authoring verb with tests as its
// NEAR object ("update the tests", "fix the flaky test"). The short span plus
// the trailing negative lookahead keep tests-as-acceptance-criteria phrasing
// ("fix the bug so the tests pass") from authorizing — that is exactly the
// prompt shape where editing tests is the classic hack. A test path quoted in
// a traceback never authorizes either: authorization is verb-object only.
const PROMPT_TEST_WORK_RE =
  /\b(?:add|write|create|author|update|extend|adjust|modify|fix|repair|rewrite)\b[^.!?\n;:—]{0,24}?\btests?\b(?!\s+(?:pass|passes|passing|still|go|stay|remain|green))/gi

// A negation directly before the verb means PROHIBITION, not authorization —
// the caseA live fire showed "Do not modify any test files" disarming the
// very gate that sentence asks for. The window tolerates comma-separated verb
// enumerations ("Never weaken, delete, skip, or edit the test"): the 11885
// full-stack live fire showed the engine's own fix-slice seed disarming the
// child gate because "not" sat more than two plain words back.
const TEST_WORK_NEGATION_RE = /\b(?:not|never|don'?t|won'?t|avoid|without|no)\s+(?:[\w'’]+,?\s+){0,4}(?:or\s+)?$/i

/**
 * B3 — did the user (or the parent conductor, for a child slice) explicitly
 * ask for test work? True disarms the no-test-edit gate for this session.
 * Negated phrasings ("do not modify the tests") never authorize.
 *
 * @sem domain=routing role=router
 */
export function promptAuthorizesTestEdits(userPrompt: string): boolean {
  if (!userPrompt) return false
  PROMPT_TEST_WORK_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = PROMPT_TEST_WORK_RE.exec(userPrompt))) {
    if (!TEST_WORK_NEGATION_RE.test(userPrompt.slice(Math.max(0, m.index - 32), m.index))) return true
  }
  return false
}

/** Engine-authored frame-seed contents (the diagnosis pre-pass writer and the P12 build plan seed) — the typed slices the turn-open skeleton plants, which a conductor rewrite must never drop. */
/**
 * F4c — diagnosis-shaped work denies test edits by default (11885 fire-3 live
 * fire): triage constraints are quote-grounded, so a ticket that never
 * mentions tests can NEVER arm the gate via triage, and optimization-phrased
 * diagnosis work evades the fix-shape regex — with both doors shut, slices
 * edited the grading tests and self-greened a wrong fix twice. The verdict's
 * own goal shapes are the missing evidence: when a turn diagnoses failing
 * behavior, that behavior's tests ARE the contract, so editing them is
 * tampering unless the user explicitly asked for test work (B3 above).
 *
 * @sem domain=routing role=router
 */
export function diagnosisDeniesTestEdits(goalShapes: readonly string[], userPrompt: string): boolean {
  return goalShapes.some((s) => s.startsWith("diagnosis")) && !promptAuthorizesTestEdits(userPrompt)
}

const FRAME_SEED_CONTENTS = new Set<string>([LOCALIZATION_SLICE_CONTENT, PLAN_SLICE_CONTENT])

/**
 * Todowrite-boundary reconcile net (case-2 tierfire3 double-wave decode): slice
 * settlement is monotonic — a conductor rewrite of the todo list cannot
 * resurrect a settled slice or drop an engine-planted frame seed. Two nets in
 * one seam: (a) an incoming item whose content matches a stored typed slice
 * keeps the stored slice fields, and a settled (terminal) stored status
 * overrides the incoming one, so a stale re-emission of the plan list can no
 * longer un-complete paid-for slices and re-trigger a full dispatch wave;
 * (b) a stored typed slice the incoming list omits is re-appended when it is
 * settled (settlement memory survives omission) or when it is a frame seed
 * (the case-1 skeleton-clobber race). An unstarted conductor-authored slice
 * omitted by the rewrite stays dropped — that is a legitimate re-plan.
 *
 * @sem domain=routing role=router
 */
export function reconcileSettledSlices<T extends OrchestrationTodo, S extends OrchestrationTodo>(
  incoming: readonly T[],
  existing: readonly S[],
): (T | S)[] {
  const storedTyped = new Map<string, S>()
  for (const t of existing) {
    if (!isTypedSlice(t)) continue
    const key = t.content.trim()
    if (!storedTyped.has(key)) storedTyped.set(key, t)
  }
  if (storedTyped.size === 0) return [...incoming]

  const incomingKeys = new Set(incoming.map((t) => t.content.trim()))
  const merged: (T | S)[] = incoming.map((t) => {
    const stored = storedTyped.get(t.content.trim())
    if (!stored) return t
    const patch: { sliceType?: string; need?: string; deps?: readonly string[]; persona?: string; status?: string } =
      {}
    if (stored.sliceType !== undefined) patch.sliceType = stored.sliceType
    if (stored.need !== undefined) patch.need = stored.need
    if (stored.deps !== undefined) patch.deps = stored.deps
    if (stored.persona !== undefined) patch.persona = stored.persona
    if (TERMINAL_TODO_STATUSES.has(stored.status)) patch.status = stored.status
    return { ...t, ...patch } as T
  })
  for (const [key, stored] of storedTyped) {
    if (incomingKeys.has(key)) continue
    if (!TERMINAL_TODO_STATUSES.has(stored.status) && !FRAME_SEED_CONTENTS.has(stored.content)) continue
    // Re-appended at the tail as a root item — a stored parentID indexed the
    // OLD list's positions and must not point into the rewritten one.
    const { parentID: _stale, ...rest } = stored
    merged.push(rest as S)
  }
  return merged
}

// ---------------------------------------------------------------------------
// U1/U2 — turn triage: preamble + goal-tree skeleton
// (docs/architecture/ORCHESTRATION_MECHANISM.md §1.1, §1.2, §4.1, §4.5)
// ---------------------------------------------------------------------------

/**
 * §1.2 — order a verdict's goals so a `dependsOn` reference always precedes
 * its dependent, otherwise stable in prompt order (Kahn's algorithm; a cycle
 * the model hallucinated falls back to prompt order for the unresolved
 * remainder rather than dropping a goal). Returns original `verdict.goals`
 * indices in write order — the order the turn-open skeleton is materialized.
 *
 * @sem domain=routing role=router
 */
export function orderTriageGoals(goals: readonly TriageGoal[]): number[] {
  const n = goals.length
  const deps = goals.map((g, i) => [...new Set(g.dependsOn ?? [])].filter((d) => d >= 0 && d < n && d !== i))
  const indegree = deps.map((d) => d.length)
  const dependents: number[][] = Array.from({ length: n }, () => [])
  deps.forEach((ds, i) => ds.forEach((d) => dependents[d]!.push(i)))
  const order: number[] = []
  const done = new Set<number>()
  while (order.length < n) {
    const all = goals.map((_, i) => i).filter((i) => !done.has(i))
    const ready = all.filter((i) => indegree[i] === 0)
    const batch = ready.length > 0 ? ready : all // a cycle: drain the remainder in prompt order
    for (const i of batch) {
      order.push(i)
      done.add(i)
      for (const dep of dependents[i]!) indegree[dep]--
    }
  }
  return order
}

/** One writable turn-open skeleton row — `OrchestrationTodo` (which carries `parentID`) plus the `priority` field `SessionTodo.Info` (§1.2/§4.5) requires. */
export interface TriageTodoRow extends OrchestrationTodo {
  readonly priority: string
}

/**
 * §1.2/U2 — materialize the turn-open todo skeleton from a non-null triage
 * verdict: one root todo per goal (dependency order, `orderTriageGoals`), and
 * for any goal that needs a frame pre-pass, one frame-seed child linked by the
 * goal-tree's `parentID` position index (goal -> task, one level — well inside
 * the tracker's depth-3 cap). The seed decision is a clean DOMAIN SPLIT: for a
 * DIAGNOSIS goal the arming decision OWNS localization arming
 * (`armLocalization` — the P1-alt code table over the turn-read's extracted
 * evidence, arming-judge.ts), so `needsPlan` cannot override it; its old OR
 * would else force a reasoner pre-pass onto an already-located bug the
 * decision correctly declined (the django-12039 regression). For a
 * NON-diagnosis/build goal, `needsPlan` owns the planning pre-pass and plants
 * the P12 PLAN seed — fresh work with no bug must not receive the diagnosis
 * writer's bug-hunt brief. Same-kind goals resolve to the same seed content, so
 * cross-goal content dedup plants at most ONE pre-pass per kind, parented to
 * the first qualifying goal in dependency order; a single diagnosis goal never
 * plants both (needsPlan is ignored on the diagnosis branch — the 12050
 * double-seed regression). S2 — repro-first sequencing: on a diagnosis goal
 * that still needs a reproduction (`arming.armReproduction` and no pin has
 * landed yet, `opts.hasPinnedProbe`), the REPRO seed plants INSTEAD of
 * localization — a post-fix repro can only ever run green, so localization is
 * WITHHELD until the mid-turn hand-off (prompt.ts SM4 block) plants it once
 * the repro pins (or the abstention deadline passes). `hasPinnedProbe:true`
 * (the prompt already named a pinnable command) restores today's behavior.
 *
 * @sem domain=routing role=router
 */
export function buildTriageTodoSkeleton(
  verdict: TriageVerdict,
  arming: ArmingDecision,
  opts?: { hasPinnedProbe?: boolean },
): TriageTodoRow[] {
  const order = orderTriageGoals(verdict.goals)
  const positionOf = new Map<number, number>()
  const todos: TriageTodoRow[] = []
  for (const origIdx of order) {
    positionOf.set(origIdx, todos.length)
    const goal = verdict.goals[origIdx]!
    todos.push({ content: goal.quote, status: "pending", priority: "medium" })
  }
  const needsRepro = (arming.armReproduction ?? false) && !opts?.hasPinnedProbe
  const plantedSeedContent = new Set<string>()
  for (const origIdx of order) {
    const goal = verdict.goals[origIdx]!
    const isDiagnosis = goal.shape === "diagnosis-vague" || goal.shape === "diagnosis-grounded"
    const seed = isDiagnosis
      ? needsRepro
        ? REPRO_PREPASS_TODO
        : arming.armLocalization
          ? LOCALIZATION_PREPASS_TODO
          : undefined
      : (goal.needsPlan ?? false)
        ? PLAN_PREPASS_TODO
        : undefined
    if (!seed || plantedSeedContent.has(seed.content)) continue
    plantedSeedContent.add(seed.content)
    todos.push({ ...seed, parentID: positionOf.get(origIdx)! })
  }
  return todos
}

/**
 * F3/B8 — the plan-first build net (case-5 decode). Self-typing was the only
 * door to the mechanical dispatch cell, and the conductor never once used it
 * — zero typed items across 20+ observed runs. When a todowrite call IS a
 * plan — a fresh list (isFreshPlan) with at least TWO decided changes
 * (isDecidedChange) — the boundary types exactly the items whose shape is
 * unambiguous: decided changes become `mechanical` (never `need` — the
 * allocation matrix owns tier), pure check-runs become `verify`, and
 * everything else — recon prose, judgment items, un-targeted authoring —
 * stays untyped with the conductor. A test-authoring decided change types
 * mechanical like any other; its isTestSlice exemption still lands downstream
 * in todosToLoopSlices (TEST_AUTHORING_RE is conversion-time, not typing-time).
 *
 * Dep inference is conservative in the safety direction: a mechanical item
 * serializes after every earlier mechanical it shares a file target with (two
 * edits to one file must never share a wave) and after the nearest earlier
 * typed item when it opens with an ordering cue; a verify item serializes
 * after ALL of the net's mechanical items — the net's deps bypass
 * todosToLoopSlices' no-deps stage backstop, so it must impose
 * verify-after-build itself or the check runs before the change exists.
 * Disjoint-target items keep empty deps (parallel-eligible), and an item that
 * already carries deps keeps them verbatim.
 *
 * @sem domain=routing role=router
 */
function typeBuildPlan<T extends OrchestrationTodo>(todos: readonly T[]): T[] {
  if (!isFreshPlan(todos) || todos.filter(isDecidedChange).length < 2) return [...todos]
  const priorMechanical: Array<{ content: string; targets: ReadonlySet<string> }> = []
  let priorTypedContent: string | undefined
  return todos.map((t) => {
    if (isDecidedChange(t)) {
      const targets = fileTargetsOf(t.content)
      const deps = new Set<string>()
      for (const prev of priorMechanical) {
        if ([...prev.targets].some((target) => targets.has(target))) deps.add(prev.content)
      }
      if (ORDERING_CUE_RE.test(t.content) && priorTypedContent !== undefined) deps.add(priorTypedContent)
      priorMechanical.push({ content: t.content, targets })
      priorTypedContent = t.content
      return t.deps === undefined && deps.size > 0
        ? { ...t, sliceType: "mechanical", deps: [...deps] }
        : { ...t, sliceType: "mechanical" }
    }
    if (!TEST_AUTHORING_RE.test(t.content) && VERIFY_RUN_KEYWORDS.test(t.content)) {
      const deps = priorMechanical.map((m) => m.content)
      priorTypedContent = t.content
      return t.deps === undefined && deps.length > 0 ? { ...t, sliceType: "verify", deps } : { ...t, sliceType: "verify" }
    }
    return t
  })
}

/** §4.2 rule 4 (venue affinity, conservative v1) — the typed-candidate-count ceiling under which autoTypeTodos stands down and leaves the batch untyped for inline execution. */
const VENUE_INLINE_MAX_ITEMS = 2

/**
 * Structural auto-typing for the judgment class (2026-07-06, run-20 decode).
 * Advisory typing rules never steer the conductor model, so on the one turn
 * shape where inline judgment is a proven quality hole — an audit/verdict turn
 * — the todowrite boundary types the slices itself: judgment-shaped pending
 * items become read-only `verify` slices pinned `need:"reasoner"`, and pure
 * check-run items become `verify` slices (runner persona via personaForSlice).
 * Three guards keep run 8 buried: a list the conductor typed itself is never
 * touched; a list with any build/mechanical-shaped active item (a build turn)
 * is never judgment-typed — it takes the build branch below instead; and
 * terminal-status items are never retyped. One deliberate exception (case-2
 * tierfire3 attempt B): an in_progress JUDGMENT item is a conductor inline
 * claim — the run-20 self-grade hole — so it types and dispatches anyway;
 * in_progress check-runs stay with the conductor.
 *
 * One structural exception on the build-turn branch — the diagnosis pre-pass
 * (SWE-bench django-11964/11885 decode; hardened 2026-07-09 against the
 * PROMPT_SLICING_CORPUS.md live-judge over-fires, rule R4): on a
 * build/mechanical batch, the turn-open arming decision
 * (`armLocalization`, threaded in) is the SEMANTIC gate — true/false, or,
 * absent a decision, the old DIAGNOSIS_START heuristic (R1 — never localizing
 * a non-diagnosis turn — is gated upstream at the arming decision and at
 * Door-1/buildTriageTodoSkeleton, so it is deliberately NOT re-imposed here: a
 * vague diagnosis whose remediation to-dos aren't phrased "investigate/fix"
 * must still arm when the decision said so). One syntactic refinement from the
 * to-do list, which the decision never saw, ALWAYS applies on top and is never
 * overridden — "string-matchers refine, never override": R4 —
 * the active to-dos must not already name a file target, because a to-do
 * naming its own file means Door-2 knows the site the judge could not. Only
 * when both hold does the pre-pass append one typed localization slice — the
 * single WRITER seed (`mechanical` + `applier`, so it localizes, FIXES, and
 * verifies the failing test in ONE session), difficulty-allocated on the
 * generator axis: an already-located fix stays on the cheap executor and only a
 * genuinely hard/ambiguous bug floors to the reasoner (the difficulty floor) —
 * front-loaded before the conductor's own checklist so the localization
 * decision is settled first, never a second workhorse. Existing items are
 * never edited or reordered (append-only: `todo_N` positional deps must not
 * shift), and the injected slice is typed, so a second pass exits on the
 * active-DAG guard while the seed is live and a content check keeps the
 * injection one-shot after it settles. Engagement, allocation,
 * lanes, and attempt caps all stay with the existing OL-9.5 machinery
 * downstream.
 *
 * The build branch's second net is the plan-first typing net (typeBuildPlan,
 * F3/B8). Precedence is by construction, not by ordering luck: the judgment
 * shape requires NO build-shaped active item, so an audit list never reaches
 * the build branch; the diagnosis pre-pass requires NO active file target
 * while the net requires two decided-change targets, so the two build-side
 * nets are disjoint; and a list carrying a live (non-settled) conductor-typed
 * slice exits at the top guard before any net runs — self-typing, when it
 * happens, wins, but settled slices are history and never mute the nets.
 *
 * §4.2 rule 4 (venue affinity, U2, conservative v1): after a net above would
 * type the batch, a result of <= VENUE_INLINE_MAX_ITEMS items with no `need`
 * pin among them is discarded — the whole point of typing is to justify a
 * spawn, and a candidate set this small at the conductor's own tier never
 * clears that bar, so the batch is returned untyped for inline execution.
 *
 * @sem domain=routing role=router
 */
export function autoTypeTodos<T extends OrchestrationTodo>(
  todos: readonly T[],
  armLocalization?: boolean,
): (T | InjectedSliceTodo)[] {
  // Active-DAG guard: only a non-settled typed slice marks a conductor DAG in
  // flight. Settled typed slices are history reconcileSettledSlices re-stuck —
  // they must not disable typing for the turn's next phase.
  if (todos.some(isDispatchableSlice)) return [...todos]
  const active = todos.filter((t) => !TERMINAL_TODO_STATUSES.has(t.status))
  const typed = ((): (T | InjectedSliceTodo)[] => {
    if (active.some((t) => MECHANICAL_START.test(t.content) || isDecidedChange(t))) {
      // The turn-open arming decision (the P1-alt code table over turn-read
      // evidence) owns the SEMANTIC localization call and is threaded in as
      // `armLocalization`; absent a decision it degrades to the old
      // DIAGNOSIS_START heuristic (R1 — build/audit/run-only never reach this
      // as an armed decision — is now gated upstream, at the decision table and
      // at Door-1/buildTriageTodoSkeleton, so it must not be re-imposed here: a
      // legitimate vague diagnosis whose remediation to-dos aren't phrased
      // "investigate/diagnose" — e.g. "add pagination to the query" — must
      // still arm when the decision said so). One syntactic refinement from
      // the to-do list — which the decision never saw —
      // ALWAYS applies on top of either path and is never overridden (corpus
      // R4, "string-matchers refine, never override"): the active to-dos must
      // NOT already name a file target, because a to-do naming its own file
      // means Door-2 knows the site the judge could not. The content check
      // keeps injection one-shot now that a SETTLED seed no longer trips the
      // top guard: a list already carrying the seed (any status) falls through
      // to plan-first typing instead of paying twice.
      const armDecision =
        armLocalization ?? todos.some((t) => t.status === "pending" && DIAGNOSIS_START.test(t.content))
      const shouldArm = armDecision && !active.some((t) => FILE_TARGET_RE.test(t.content))
      if (shouldArm && !todos.some((t) => t.content === LOCALIZATION_SLICE_CONTENT)) {
        return [...todos, LOCALIZATION_PREPASS_TODO]
      }
      return typeBuildPlan(todos)
    }
    const mapped = todos.map((t) => {
      // A leading bracket tag ("[audit] …", "[verdict] …") is presentation the
      // triage preamble taught the conductor, not content (case-2 tierfire3
      // decode: the suite run priced at reasoner because the tag's literal
      // "audit" judgment-typed it). Classify the BODY first: a tag-hidden
      // mechanical opener stays untyped, and a pure check-run with no judgment
      // language in its body types plain verify (runner) even inside an
      // audit-tagged list. The tag still counts as a judgment signal for items
      // whose body carries no keyword at all ("[verdict] SHIP or DO NOT SHIP").
      const body = t.content.replace(TODO_TAG_RE, "")
      // An in_progress judgment item is a conductor CLAIM, and inline judgment
      // claims are the run-20 self-grade hole — observed flaking in case-2
      // tierfire3 attempt B (claimed, never executed, cancelled at turn close).
      // Decision-shaped ambiguity rounds UP: the claim dispatches anyway.
      // Check-runs stay pending-only — a run the conductor is actually
      // executing inline must not double-run.
      const claimable = t.status === "pending" || t.status === "in_progress"
      if (!claimable || MECHANICAL_START.test(body)) return t
      if (!JUDGMENT_KEYWORDS.test(body) && !TEST_AUTHORING_RE.test(body) && VERIFY_RUN_KEYWORDS.test(body))
        return t.status === "pending" ? { ...t, sliceType: "verify" } : t
      if (JUDGMENT_KEYWORDS.test(t.content)) return { ...t, sliceType: "verify", need: "reasoner" }
      if (VERIFY_RUN_KEYWORDS.test(t.content)) return t.status === "pending" ? { ...t, sliceType: "verify" } : t
      return t
    })
    // The closing verdict is decision-shaped — it consumes the other
    // dimensions' results, yet judgment typing used to emit a dep-less DAG and
    // the verdict slice launched blind in wave 1 (case-2 tierfire3 attempt B,
    // identical creation timestamps). A deps-less verdict-shaped typed item
    // gains deps on every other newly-typed sibling; conductor-authored deps
    // always win.
    const dimensionIds = mapped
      .filter((t) => isDispatchableSlice(t) && !VERDICT_SHAPED_RE.test(t.content))
      .map((t) => t.content)
    return mapped.map((t) =>
      isTypedSlice(t) && t.deps === undefined && VERDICT_SHAPED_RE.test(t.content) && dimensionIds.length > 0
        ? { ...t, deps: dimensionIds }
        : t,
    )
  })()
  // §4.2 rule 4 (venue affinity, conservative v1): a typed candidate set this
  // small, with nothing pinned above the conductor, earns nothing from a
  // spawn (§1.3) — leave it untyped so the conductor executes it inline
  // instead of paying a child's brief-compile + cold-cache-write cost. The
  // engine-planted diagnosis frame seed is EXEMPT: its plant already passed the
  // `shouldArm` gate (a deliberate localization decision), so it must not be
  // force-swallowed here just because it is difficulty-allocated and no longer
  // carries a `need` pin. Whether the seed actually spawns a child is decided
  // downstream by `shouldOrchestrate` on the ALLOCATED tier (a trivial seed
  // allocates to the executor and the benefit gate declines it there).
  const newlyTyped = typed.filter(isDispatchableSlice)
  if (
    newlyTyped.length > 0 &&
    newlyTyped.length <= VENUE_INLINE_MAX_ITEMS &&
    newlyTyped.every((t) => !t.need && !FRAME_SEED_CONTENTS.has(t.content))
  ) {
    return [...todos]
  }
  return typed
}

/**
 * OL-9.3f backstop: when a caller hands todosToLoopSlices a batch of >=3 items
 * and types NONE of them, that reads as typing having been skipped altogether
 * rather than every item genuinely judged trivial — derive a sliceType per
 * item from content keywords so the batch still becomes a dispatchable DAG.
 * As of OL-9.5c this no longer drives conductor engagement:
 * `hasPendingTypedSlices` requires an explicitly-typed pending slice before
 * todosToLoopSlices is ever reached on the live hook path, so this now only
 * fires for a caller that invokes todosToLoopSlices directly on an
 * all-untyped batch (e.g. the eval decomp-scorer). A single
 * conductor-assigned sliceType anywhere in the batch always wins; this only
 * fires when typing is entirely absent, and a batch under 3 items is left
 * untouched (too small to be worth orchestrating).
 */
function withDerivedTypes(todos: readonly OrchestrationTodo[]): readonly OrchestrationTodo[] {
  if (todos.length < 3 || todos.some(isTypedSlice)) return todos
  return todos.map((t) => ({ ...t, sliceType: inferSliceType(t.content) }))
}

/**
 * Convert the conductor's typed todo items into the pure loop's `LoopSlice[]`.
 * Each typed todo becomes one slice whose `id` is its content (deduped on
 * collision); `need` carries straight through and deps resolve against the
 * built id set (an unresolvable ref is dropped so planWaves never throws on a
 * stray id). When the conductor emitted the DAG with NO deps at all, the
 * canonical stage ordering recon → design → mechanical → verify is imposed
 * deterministically — a dep-less plan otherwise runs as one parallel wave
 * (verify before the fix exists) and silently disables the design→mechanical
 * patch handoff. `coupling`/`testStrength` prefer an already-tagged value and
 * otherwise come from the injected OL-7.9 probes, run over the files the slice
 * text names. Untyped todos are ignored — they are not DAG nodes, unless the
 * OL-9.3f backstop (withDerivedTypes) fires and types the whole batch first.
 * A typed todo already `completed`/`failed`/`cancelled` is excluded too
 * (OL-9.5c settled-slice memory) — a re-engagement must not re-dispatch work
 * that already reached a terminal status. The optional `arming` param carries
 * the turn's arming-judge difficulty signals (§1.1b) — goal-level, not
 * per-todo — so every slice built here inherits the same `hardness`/
 * `ambiguity`, letting the two-axis allocator floor a hard/ambiguous slice's
 * generator tier at the reasoner. P3/Q-D: a researcher-persona slice
 * (explicit, or the research-turn recon default via `opts.researchShaped`)
 * verifies by CITATION, never the test rung — no sound-rung commands, no
 * probe pin, `testStrength` pinned untestable so the verify ladder routes to
 * the judge over the cited digest.
 *
 * @sem domain=routing role=digest
 */
export async function todosToLoopSlices(
  todos: readonly OrchestrationTodo[],
  probes: SliceProbes,
  arming?: { hardness?: SliceHardness; ambiguity?: SliceAmbiguity },
  opts?: { researchShaped?: boolean; fallbackFiles?: readonly string[] },
): Promise<LoopSlice[]> {
  const effectiveTodos = withDerivedTypes(todos)
  const typed = effectiveTodos.filter(isDispatchableSlice)

  // Assign stable, unique ids (content, deduped) before resolving deps against them.
  const ids: string[] = []
  const used = new Set<string>()
  for (const t of typed) {
    let id = t.content
    let n = 1
    while (used.has(id)) id = `${t.content}#${++n}`
    used.add(id)
    ids.push(id)
  }

  // Dep-ref resolution: conductors express deps three observed ways — the exact
  // content id, `todo_N` (a 1-indexed position ref the live conductor invented
  // on 2026-07-04, silently dropped by the old exact-match resolver), or a bare
  // number. Position refs resolve against the typed todos in emission order,
  // preferring the 1-indexed reading and falling back to 0-indexed; a ref that
  // lands on the slice itself is dropped (no self-deps, planWaves would cycle).
  const resolveDepRef = (ref: string, selfIdx: number): string | undefined => {
    if (used.has(ref)) return ref === ids[selfIdx] ? undefined : ref
    const m = /^(?:todo[\s_-]?)?(\d+)$/i.exec(ref.trim())
    if (!m) return undefined
    const n = Number(m[1])
    for (const idx of [n - 1, n]) {
      if (idx >= 0 && idx < ids.length && idx !== selfIdx) return ids[idx]
    }
    return undefined
  }
  const resolvedDeps = typed.map((t, i) => [
    ...new Set((t.deps ?? []).map((r) => resolveDepRef(r, i)).filter((d): d is string => d !== undefined)),
  ])

  // Positional fallbacks can, on nonsense input, resolve two refs into each
  // other — and the loop's wave scheduler fails loud on a cycle. A cycle the
  // RESOLVER manufactured must instead read as "resolution failed" so the
  // stage-DAG backstop below orders the plan.
  const isAcyclic = (deps: readonly string[][]): boolean => {
    const done = new Set<string>()
    while (done.size < ids.length) {
      const ready = ids.filter((id, i) => !done.has(id) && deps[i]!.every((d) => done.has(d)))
      if (ready.length === 0) return false
      for (const id of ready) done.add(id)
    }
    return true
  }

  // Deps guard (backstop): conductor decomposition varies run to run, and a
  // plan whose deps all failed to resolve (or that has none) is a single
  // parallel wave — verify runs before the fix exists. When NO ordering
  // survived resolution, impose the canonical stage DAG: every slice depends on
  // all slices of the nearest earlier stage present (unknown slice types run
  // with mechanical). A plan with even one resolved dep is left untouched.
  const STAGE_ORDER: Record<string, number> = { recon: 0, design: 1, mechanical: 2, verify: 3 }
  const stageOf = (t: OrchestrationTodo): number => STAGE_ORDER[t.sliceType ?? ""] ?? STAGE_ORDER["mechanical"]!
  const anyDepResolved = resolvedDeps.some((d) => d.length > 0) && isAcyclic(resolvedDeps)
  const stages = typed.map(stageOf)
  const effectiveDeps: readonly string[][] =
    anyDepResolved || typed.length < 2
      ? resolvedDeps
      : typed.map((t) => {
          const earlier = stages.filter((s) => s < stageOf(t))
          if (earlier.length === 0) return []
          const prev = Math.max(...earlier)
          return ids.filter((_, j) => stages[j] === prev)
        })

  // Design-emits-the-patch (widened): every edit-emitting slice — a design
  // slice that feeds a mechanical dependent, or a mechanical/author slice
  // itself — must end with the concrete edit; the downstream executor
  // transcribes, it does not invent.
  const PATCH_CONTRACT =
    "\n\nOutput contract: a mechanical slice will apply your design verbatim. End your output with the CONCRETE edit(s) — for each change: the file path, the precise location, and the exact new code (or a unified diff). Prose without the exact code is an incomplete result."
  const sliceTypeAt = new Map(typed.map((t, i) => [ids[i]!, t.sliceType]))
  const hasMechanicalDependent = (id: string): boolean =>
    typed.some((t, j) => effectiveDeps[j]!.includes(id) && t.sliceType === "mechanical")
  const dependsOnDesign = (i: number): boolean => effectiveDeps[i]!.some((d) => sliceTypeAt.get(d) === "design")

  // F2: a batch that authors tests legitimately edits test files — the
  // test-tree guard is skipped for the whole batch.
  const batchAuthorsTests = typed.some((t) => TEST_AUTHORING_RE.test(t.content))

  // Task #7 — pinned-reproduction lookup: an edit-emitting slice's upstream
  // deps are themselves typed todos in this same batch (deps only resolve
  // against `used`, i.e. `typed`); index their content by id so a mechanical
  // fix can fall back to a dependency's (e.g. a diagnosis slice's) text.
  const contentById = new Map(ids.map((id, idx) => [id, typed[idx]!.content]))

  return Promise.all(
    typed.map(async (t, i): Promise<LoopSlice> => {
      // M2 — a slice's own text is a stochastic key (run 2 typed "Patch
      // IndexColumns.__str__..." with no file at all): own path tokens plus
      // tree-resolved dotted modules, falling back to the TURN's file
      // evidence (the prompt-named files) when the slice names none. A slice
      // with no scope anywhere probes with [] exactly as before.
      const ownFiles = [...new Set([...extractSliceFiles(t.content), ...resolveDottedPyModules(t.content)])]
      const files = ownFiles.length > 0 ? ownFiles : [...(opts?.fallbackFiles ?? [])]
      // P3/Q-D — the citation-verified research slice, keyed on the resolved
      // persona so an explicit `persona:"researcher"` and the research-turn
      // recon default route identically.
      const isResearchSlice = personaForSlice(t, opts) === "researcher"
      const [coupling, testStrength] = await Promise.all([
        t.coupling ? Promise.resolve({ coupling: t.coupling as "low" | "high" }) : probes.probeCoupling(t.content, files),
        isResearchSlice
          ? Promise.resolve({ testStrength: "untestable" as const })
          : t.testStrength
            ? Promise.resolve({ testStrength: t.testStrength as "testable" | "untestable" })
            : probes.probeTestStrength(files),
      ])
      const deps = effectiveDeps[i]!.filter((d) => used.has(d))
      const isPatchEmittingSlice =
        (t.sliceType === "design" && hasMechanicalDependent(ids[i]!)) ||
        t.sliceType === "mechanical" ||
        t.sliceType === "author"

      // Task #7 (probe rung) — a bug-fix/diagnosis edit-emitting slice that
      // names an identifiable reproduction (own content first, falling back to
      // an upstream dep's) gets it pinned as probeCommand, so the verifier's
      // probe rung enforces red→green on that exact case. Unset when nothing
      // identifiable exists — never fabricated (the M3 floor covers that case).
      let probeCommand: VerifyCommand | undefined
      if (isPatchEmittingSlice && !isResearchSlice) {
        probeCommand = mostSpecificRepro(extractVerifyCommands(t.content))
        if (!probeCommand) {
          const upstreamCandidates = deps.flatMap((d) => extractVerifyCommands(contentById.get(d) ?? ""))
          probeCommand = mostSpecificRepro(upstreamCandidates)
        }
      }

      // F2 — sound-rung spec: a verify slice always wants commands; a testable
      // mechanical slice wants its edit checked the same way. Text-named
      // commands win; the repo-script probe fills in when the text names none.
      // The test-tree guard rides FIRST in every command-backed spec.
      const wantsCommands =
        !isResearchSlice &&
        (t.sliceType === "verify" || (t.sliceType === "mechanical" && testStrength.testStrength === "testable"))
      let verifyCommands: VerifyCommand[] = []
      if (wantsCommands) {
        verifyCommands = extractVerifyCommands(t.content)
        if (verifyCommands.length === 0 && probes.probeVerifyCommands) {
          verifyCommands = [...(await probes.probeVerifyCommands(files))]
        }
        if (verifyCommands.length > 0 && !batchAuthorsTests) {
          verifyCommands = [TEST_TREE_GUARD_COMMAND, ...verifyCommands]
        }
      }

      return {
        id: ids[i]!,
        prompt: isPatchEmittingSlice ? `${t.content}${PATCH_CONTRACT}` : t.content,
        sliceType: t.sliceType as LoopSlice["sliceType"],
        need: t.need,
        deps: deps.length > 0 ? deps : undefined,
        coupling: coupling.coupling,
        testStrength: testStrength.testStrength,
        specBacked: t.sliceType === "mechanical" && dependsOnDesign(i) ? true : undefined,
        hardness: arming?.hardness,
        ambiguity: arming?.ambiguity,
        ...(verifyCommands.length > 0 ? { verifyCommands } : {}),
        ...(probeCommand ? { probeCommand } : {}),
        ...(TEST_AUTHORING_RE.test(t.content) ? { isTestSlice: true } : {}),
      }
    }),
  )
}

/**
 * The benefit gate (OL-9.5c): decomposition only earns its overhead when
 * splitting demonstrably helps — real parallelism exists (some wave
 * `planWaves` schedules has >=2 slices that can run concurrently), the
 * batch is large enough that no single context could hold it (>=6 slices),
 * or a slice ALLOCATES to a tier above the executor (run-21: a lone judgment
 * slice whose `allocateSlice` tier is reasoner/oracle IS the benefit — a
 * fresh-context higher-tier verdict the lead model cannot produce inline — so
 * it must not be declined for being a width-1 DAG). Keying on the ALLOCATED
 * tier, not a raw `need` hint, is load-bearing: the allocator can clamp a
 * `need` request away (a testable mechanical slice hinting `need:"reasoner"`
 * still allocates to the executor), so a raw-`need` gate would open on a slice
 * the router then runs cheap. A linear all-cheap chain — every wave width 1,
 * nothing allocating above the executor — gains nothing from being split: each
 * child still pays its own context re-derivation and the waves still serialize,
 * so it is strictly worse than handling the same work inline (run-8 evidence:
 * 868 LLM calls for one trivial, purely-linear issue). Applied once per engagement, right
 * after `todosToLoopSlices`, before any dispatch. `goalCount` (U2, from the
 * turn's triage verdict) is a second, independent width signal: >=2 tracked
 * goals is real width even when each goal's own DAG is a linear chain — the
 * goals themselves run as parallel instances (§4.5), so the benefit is at
 * the goal level, not the per-goal wave level.
 *
 * @sem domain=routing role=router
 */
export function shouldOrchestrate(slices: readonly LoopSlice[], goalCount?: number): boolean {
  if (slices.length >= 6) return true
  if (slices.some((s) => TIER_RANK[allocateSlice(s).tier] >= TIER_RANK.reasoner)) return true
  if ((goalCount ?? 0) >= 2) return true
  return planWaves(slices).some((wave) => wave.length >= 2)
}

/**
 * #53/#54 resolution-gate — placeholder token budget for `validatePlan`'s
 * structural check at the todo→slice seam. No turn-level TOKEN budget exists
 * at this seam today (`sliceStepBudget`/`PERSONA_STEP_BUDGET` above are
 * tool-CALL step budgets, not tokens); `todosToPlanNodes` below never sets
 * `estimateTokens` (a todo-derived plan carries none), so `validatePlan`'s
 * budget-headroom check (`totalEstimate > 0.7*budget`) is always `0 >
 * ~0.7*budget` — a structural no-op regardless of this value. Chosen to
 * match the placeholder value evaluator.test.ts already uses for the same
 * check; kept only so the call shape matches `validatePlan`'s signature.
 */
const RESOLUTION_GATE_BUDGET = 10_000

/**
 * #53/#54 — map the live todo list to `PlanNode[]` for `validatePlan`'s
 * structural-only check (`requireNodeFields:false`). `id` is positional
 * index (todos carry no persisted id at this seam); `dependsOn` resolves
 * each todo's `deps` refs the same way `todosToLoopSlices` resolves them —
 * exact content match, or a `todo_N`/bare-number position ref — against that
 * same index set, dropping an unresolvable ref. `parentId` threads straight
 * from the todo's persisted `parentID` position index (P11b — the goal-tree
 * structure the store carries: skeleton seeds and delegate child todos), so
 * validatePlan sees the real depth/branching and delegates render as a tree;
 * an out-of-range or self-referencing parentID is dropped, mirroring the
 * dep-ref hygiene. `estimateTokens` is omitted — see RESOLUTION_GATE_BUDGET.
 * Exported for its own unit rows.
 *
 * @sem domain=routing role=router
 */
export function todosToPlanNodes(todos: readonly OrchestrationTodo[]): PlanNode[] {
  const ids = todos.map((_, i) => String(i))
  const firstIndexOfContent = new Map<string, number>()
  todos.forEach((t, i) => {
    if (!firstIndexOfContent.has(t.content)) firstIndexOfContent.set(t.content, i)
  })
  const resolveRef = (ref: string, selfIdx: number): string | undefined => {
    const byContent = firstIndexOfContent.get(ref)
    if (byContent !== undefined) return byContent === selfIdx ? undefined : ids[byContent]
    const m = /^(?:todo[\s_-]?)?(\d+)$/i.exec(ref.trim())
    if (!m) return undefined
    const n = Number(m[1])
    for (const idx of [n - 1, n]) {
      if (idx >= 0 && idx < ids.length && idx !== selfIdx) return ids[idx]
    }
    return undefined
  }
  return todos.map((t, i) => {
    const dependsOn = [
      ...new Set((t.deps ?? []).map((r) => resolveRef(r, i)).filter((d): d is string => d !== undefined)),
    ]
    const parentId =
      t.parentID !== undefined && t.parentID >= 0 && t.parentID < todos.length && t.parentID !== i
        ? ids[t.parentID]
        : undefined
    return {
      id: ids[i]!,
      ...(parentId !== undefined ? { parentId } : {}),
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
    }
  })
}

/**
 * #53/#54 — one clarifying question derived from what the arming judge
 * threaded through to this seam. The judge's `evidence` string (the exact
 * span that decided its call) lives on `ArmingVerdict`, not the narrow
 * `ArmingDecision`/`{hardness, ambiguity}` shape this seam receives, so the
 * question is grounded in the two axes only, not a quoted span.
 *
 * @sem domain=routing role=router
 */
function resolutionClarifyingQuestion(arming?: { hardness?: SliceHardness; ambiguity?: SliceAmbiguity }): string {
  const bits: string[] = []
  if (arming?.ambiguity === "ambiguous") bits.push("the intended approach is ambiguous")
  if (arming?.hardness === "hard") bits.push("the task is structurally hard to decompose cleanly")
  const why = bits.length > 0 ? bits.join(" and ") : "the approach for this turn isn't settled"
  return `This turn is flagged uncertain (${why}), and an autonomous resolution pass could not produce a valid plan. Can you clarify the intended approach or scope before I continue?`
}

/**
 * Everything the OL-7.3b hook needs from the live turn, all injected so the
 * driver has no Effect/DB dependency and runs under unit-test doubles. The
 * three status-write and dispatch ports are the only live seams.
 */
export interface ConductorOrchestrationDeps {
  /** Read the current session todo list (with typed-decomposition fields). */
  getTodos: () => Promise<readonly OrchestrationTodo[]>
  /** The OL-7.9 coupling/test-strength probes (live) or doubles (tests). */
  probes: SliceProbes
  /** Spawn one slice as a child session — the Effect-bridged task-tool dispatch. */
  dispatch: ConductorSliceDispatch
  /** Mirror a slice's status onto its originating todo (by original index) so the tracker reflects the loop. */
  setTodoStatus: (todoIndex: number, status: string) => Promise<void>
  /** Fallback meter — invoked exactly once when the hook falls back to the legacy path on an internal error. */
  meterFallback?: (err: unknown) => void
  /** Extra loop options (samplers, RM rung, shell runner, cwd). */
  options?: ConductorLoopOptions
  /** U2 — the turn's triage goal count (§1.2), fed into `shouldOrchestrate`'s width check. Absent on a null-verdict (legacy) turn. */
  goalCount?: number
  /** §1.1b — the turn's arming-judge difficulty signals, threaded onto every slice `todosToLoopSlices` builds for this turn (two-axis allocator floor). `armLocalization` picks the resolve-first seed's shape (P12 residual case). `degraded` (the null turn-read posture, `DEGRADED_ARMING`) holds the conductor inline — mid-turn todos never orchestrate, the grind valve's design prepass excepted. Absent on a null-verdict (legacy) turn. */
  arming?: { hardness?: SliceHardness; ambiguity?: SliceAmbiguity; armLocalization?: boolean; degraded?: boolean }
  /** P4 §4b — this turn is a continuation (steering/iteration on the session's existing work): the resolution gate stands down entirely — a continuation never re-enters resolve-first; the fresh turn that started the task already resolved it. */
  continuation?: boolean
  /** P3/Q-D — the turn-read found a research-shaped goal: recon slices default to the web-enabled researcher persona and research slices verify by citation, never the test rung (threaded to `todosToLoopSlices`). */
  researchShaped?: boolean
  /** M2 — the TURN's file evidence (prompt-named paths + tree-resolved dotted modules): the probe fallback for slices whose own text names no file. */
  turnFiles?: readonly string[]
  /** #53/#54 — the live session id, the resolution-store key. Absent (a caller/test double that predates the resolution gate) → a flagged turn skips the gate and decomposes unchanged, same as before the gate existed. */
  sessionID?: string
  /** #53/#54 — plant one diagnosis pre-pass seed onto the session's stored todo list (append, dedup by content) — the "resolve-first" branch's re-seed when `buildTriageTodoSkeleton`'s turn-open seed did not already plant one for this turn's shape. Typed `InjectedSliceTodo` (not the narrower `OrchestrationTodo`) because the live todo store requires `priority`, which only the frame-seed constants (`LOCALIZATION_PREPASS_TODO`/`PLAN_PREPASS_TODO`) carry. */
  appendTodos?: (seed: InjectedSliceTodo) => Promise<void>
  /** #53/#54 — register one clarifying question and return without waiting for the answer; the caller wires this to `Question.Service.ask` via a non-blocking Effect fork so the turn yields instead of parking on the Deferred. Absent (headless/test double) → `"ask-user"` can never be acted on (it is also gated off by `interactive` below). */
  askUser?: (question: string) => void
  /** #53/#54 — resolution-gate telemetry sink, mirrors `options.onProvenance`'s callback-to-caller pattern (this file has no Effect dependency; the caller emits `Effect.logInfo`). */
  onResolutionGate?: (info: {
    flagged: boolean
    mode: ResolutionMode
    candidatePlanValid?: boolean
    resolveAttempts: number
  }) => void
  /** L4.2 — degraded stand-down telemetry sink: fires when a degraded (null turn-read) turn holds its conductor-authored mid-turn todos INLINE instead of orchestrating them. `grindEscapeHatch` is true when the grind valve's design prepass is present and still orchestrates. Same callback-to-caller pattern as `onResolutionGate` (this file has no Effect dependency; the caller emits the log line). */
  onDegradedStandDown?: (info: { conductorTodos: number; grindEscapeHatch: boolean }) => void
  /** #55 — mid-flight re-decomposition telemetry sink: fires after every settled run with the §4.2 triggers `redecompositionCheck` returned and the signals behind them, whether or not any trigger was acted on. Same callback-to-caller pattern as `onResolutionGate`. */
  onRedecomposition?: (info: {
    triggers: RedecompositionTrigger[]
    coverageGaps: number
    escalated: number
    reseeded: boolean
    redecompAttempts: number
  }) => void
}

/** What the hook reports back to the turn: whether it took over, and whether it fell back on error. */
export interface ConductorOrchestrationResult {
  engaged: boolean
  fellBack?: boolean
  result?: SliceLoopResult
}

/**
 * The OL-7.3b conductor hook: when the just-written todos are a typed DAG with
 * pending slices, convert them, run the slice loop (each slice a
 * child-session dispatch), and mirror each slice `in_progress` while it runs
 * then `completed` when the loop finishes. Any internal failure (probe,
 * dispatch, ladder, or a malformed DAG) is caught at this boundary — that is
 * crash safety, not an opt-out — metered, and turned into a graceful
 * `{engaged:false, fellBack:true}` so a broken orchestrator can never kill the
 * user's turn; the caller then proceeds on the legacy path. Returns
 * `{engaged:false}` (no fallback) when the todos are not an engageable DAG,
 * keeping the no-typed-slices path work-free — and again, past that gate,
 * when the OL-9.5c benefit gate (`shouldOrchestrate`) finds the resulting
 * slices offer no real parallelism and are too small to justify the split;
 * that case is also work-free (no meter) — inline is simply cheaper. Only
 * non-terminal typed todos become slices (`todosToLoopSlices`'s
 * `isDispatchableSlice` filter), so a `completed`/`failed`/`cancelled` slice
 * from an earlier engagement is never re-dispatched. OL-9.3c finally-write:
 * every index this run marks `in_progress` is guaranteed a terminal status
 * (settled to `failed` if nothing else claimed it) no matter how the run
 * ends — a child crash, an abort, a dispatch throw, or the catch above must
 * never leave a slice's mirrored todo orphaned `in_progress`. #53/#54: before
 * any of that, a flagged (ambiguous/hard) turn passes the resolution gate
 * first — `decompose-now` falls straight into the path above unchanged;
 * `resolve-first`/`ask-user` both return `{engaged:false}` without touching a
 * todo status, so this function's own crash-safety net is untouched by the
 * gate.
 *
 * @sem domain=routing role=orchestrator
 */
export async function runConductorOrchestration(
  deps: ConductorOrchestrationDeps,
): Promise<ConductorOrchestrationResult> {
  let todos: readonly OrchestrationTodo[]
  try {
    todos = await deps.getTodos()
  } catch (err) {
    deps.meterFallback?.(err)
    return { engaged: false, fellBack: true }
  }
  if (!hasPendingTypedSlices(todos)) return { engaged: false }

  // Serialize every status write so the live read-modify-write of the whole todo
  // list never races (a wave dispatches slices concurrently via Promise.all).
  let chain: Promise<void> = Promise.resolve()
  const setStatus = (todoIndex: number, status: string): Promise<void> => {
    chain = chain.then(() => deps.setTodoStatus(todoIndex, status))
    return chain
  }

  // OL-9.3c: track every index marked in_progress and which of those reached a
  // terminal status through the normal completion path, so the finally below
  // can sweep the rest instead of leaving them stuck.
  const marked = new Set<number>()
  const settled = new Set<number>()
  const settle = (idx: number, status: string): Promise<void> => {
    settled.add(idx)
    return setStatus(idx, status)
  }

  try {
    // #53/#54 resolution gate (Option A, structural) — a flagged
    // (ambiguous/hard) turn resolves its approach before committing to cheap
    // slicing, gated by validatePlan's STRUCTURAL-ONLY check. Requires
    // deps.sessionID (the resolution-store key); absent it — a caller/test
    // double that predates this gate — a flagged turn falls straight through
    // to the decompose path below, unchanged from before the gate existed.
    // P4: a continuation turn stands the gate down — the inherited arming may
    // still read hard/ambiguous, but the task already passed resolution on
    // the fresh turn that started it; re-entering resolve-first would re-pay
    // a pass the user's follow-up is steering, not restarting.
    if (deps.sessionID !== undefined && deps.continuation !== true) {
      const flagged = deps.arming?.ambiguity === "ambiguous" || deps.arming?.hardness === "hard"
      if (flagged) {
        const sessionID = deps.sessionID
        const candidatePlan = todosToPlanNodes(todos)
        // Structural-only validity (todo-derived plans carry no node fields).
        // Kept for the onResolutionGate telemetry callback; resolutionDecision
        // recomputes the same structural check internally now that
        // `requireNodeFields` is threaded (see below).
        const candidatePlanValid = validatePlan(candidatePlan, RESOLUTION_GATE_BUDGET, {
          requireNodeFields: false,
        }).ok
        const resolveAttempts = getResolveAttempts(sessionID)
        // OL-9.0b's own headless marker (run.ts:263) — the same "is a real
        // user present" signal permission/index.ts's ask() backstop reads.
        const interactive = process.env["OPENCODE_HEADLESS"] !== "1"
        // #61: resolutionDecision is the single source of truth for EVERY
        // branch, including the step-2 valid-plan short-circuit. Threading
        // `requireNodeFields: false` makes its internal validatePlan check
        // structural-only, so a todo-derived plan (no objective/outputShape/
        // successCriterion; see todosToPlanNodes) can actually satisfy it.
        // Before this, resolutionDecision re-validated with the default
        // requireNodeFields:true and that short-circuit could never fire for a
        // todo plan, forcing the gate to bypass it with a hand-rolled check.
        const mode: ResolutionMode = resolutionDecision({
          ambiguity: deps.arming?.ambiguity,
          hardness: deps.arming?.hardness,
          candidatePlan,
          budget: RESOLUTION_GATE_BUDGET,
          requireNodeFields: false,
          interactive,
          needsUserInput: resolveAttempts >= 1,
          // 1b — an armed vague diagnosis localizes inline, then keeps fixing
          // INLINE and never decomposes (11885: decompose-after-localize 0/4
          // REAL FAIL vs inline 3/3 REAL PASS).
          armLocalization: deps.arming?.armLocalization === true,
          resolveAttempts,
        }).mode
        deps.onResolutionGate?.({ flagged, mode, candidatePlanValid, resolveAttempts })
        if (mode === "resolve-first") {
          incResolveAttempts(sessionID)
          // P12 (resolve-first residual case): the resolution pass's brief
          // must match the turn's shape — an armed vague diagnosis resolves by
          // localizing; anything else (ambiguous build/audit) resolves by
          // producing the plan, never by hunting a bug that does not exist.
          if (deps.appendTodos)
            await deps.appendTodos(deps.arming?.armLocalization === true ? LOCALIZATION_PREPASS_TODO : PLAN_PREPASS_TODO)
          return { engaged: false }
        }
        if (mode === "ask-user") {
          deps.askUser?.(resolutionClarifyingQuestion(deps.arming))
          return { engaged: false }
        }
        if (mode === "continue-inline") {
          // Armed turn that already localized — the conductor keeps working the
          // todos INLINE (they stay plain todos); orchestration never engages,
          // nothing is appended or asked. The grind valve is the only escalation
          // (11885: decompose-after-localize 0/4 REAL FAIL vs inline 3/3 REAL PASS).
          return { engaged: false }
        }
        // mode === "decompose-now" — fall through to the slice path below.
      }
    }

    // L4.2 degraded stand-down (11964: $0.3467 orchestrated vs $0.0985 the same
    // ticket conductor-solo): a degraded turn-read (verdict===null →
    // DEGRADED_ARMING, `degraded:true`) keeps the conductor INLINE for the whole
    // turn — its own mid-turn todos are tracked but must NOT flow into tiered
    // slices (the structural-cell allocation design/untestable→reasoner/oracle is
    // exactly what bought the overrun on an ex-solo ticket). The ONE escape hatch
    // is the grind valve's planted design prepass (GRIND_DESIGN_SLICE_CONTENT),
    // which MUST still orchestrate so a stalled degraded turn can escalate on
    // evidence rather than never being able to at all. Gating on the valve todo's
    // own content marker, never a copy of the arming policy.
    const degraded = deps.arming?.degraded === true
    const orchestratable = (t: OrchestrationTodo): boolean =>
      isDispatchableSlice(t) && (!degraded || t.content === GRIND_DESIGN_SLICE_CONTENT)
    if (degraded) {
      const heldInline = todos.filter((t) => isDispatchableSlice(t) && t.content !== GRIND_DESIGN_SLICE_CONTENT).length
      if (heldInline > 0)
        deps.onDegradedStandDown?.({
          conductorTodos: heldInline,
          grindEscapeHatch: todos.some((t) => t.content === GRIND_DESIGN_SLICE_CONTENT),
        })
    }

    const typedIndices = todos.map((t, i) => (orchestratable(t) ? i : -1)).filter((i) => i >= 0)
    if (typedIndices.length === 0) return { engaged: false }
    const engagedTodos = degraded ? todos.filter(orchestratable) : todos
    const slices = await todosToLoopSlices(engagedTodos, deps.probes, deps.arming, {
      researchShaped: deps.researchShaped,
      fallbackFiles: deps.turnFiles,
    })
    if (!shouldOrchestrate(slices, deps.goalCount)) return { engaged: false }
    const todoIndexOf = (sliceId: string): number | undefined => {
      const k = slices.findIndex((s) => s.id === sliceId)
      return k >= 0 ? typedIndices[k] : undefined
    }

    const wrappedDispatch: ConductorSliceDispatch = (req) => {
      if (!req.escalated) {
        const idx = todoIndexOf(req.sliceId)
        if (idx !== undefined && !marked.has(idx)) {
          marked.add(idx)
          void setStatus(idx, "in_progress")
        }
      }
      return deps.dispatch(req)
    }

    const result = await runConductorSliceLoop(slices, wrappedDispatch, deps.options)

    for (const outcome of result.outcomes) {
      const idx = todoIndexOf(outcome.id)
      // P6a: a blocked slice was never dispatched (its dep terminal-failed) —
      // "cancelled", not "completed" (nothing ran) and not "failed" (nothing
      // was attempted). It re-enters via the re-decomposition coverage gap.
      if (idx !== undefined) await settle(idx, outcome.state === "blocked" ? "cancelled" : "completed")
    }
    await chain

    // #55 mid-flight re-decomposition (§4.2): once a run has settled, evaluate
    // the re-decomposition triggers against its outcomes. A slice that settled
    // "unverified" (rejected at the top tier, accepted-with-warning) is a
    // coverage gap — real work we could not confirm. `new-items` re-enters the
    // resolve→decompose loop by planting a DISTINCT re-plan seed: the todo-list
    // change re-fires this hook, which passes the resolution gate again and
    // re-decomposes the uncovered work into smaller checkable slices. Bounded
    // by the SAME resolution-store counter as the prior-resolution loop (one
    // unified per-session recursion-depth budget), so it always terminates.
    // Needs a real session + append port; a legacy/test double skips it. Every
    // trigger is telemetered even when only `new-items` is acted on.
    if (deps.sessionID !== undefined && deps.appendTodos !== undefined) {
      const signals = redecompositionSignalsFromOutcomes(result.outcomes)
      const triggers = redecompositionCheck(signals)
      const redecompAttempts = getResolveAttempts(deps.sessionID)
      const reseeded = triggers.includes("new-items") && redecompAttempts < MAX_RESOLVE_ATTEMPTS
      if (reseeded) {
        incResolveAttempts(deps.sessionID)
        await deps.appendTodos(REDECOMPOSITION_PREPASS_TODO)
      }
      deps.onRedecomposition?.({
        triggers,
        coverageGaps: signals.coverageGaps ?? 0,
        escalated: result.outcomes.filter((o) => o.state === "escalated").length,
        reseeded,
        redecompAttempts,
      })
    }

    return { engaged: result.engaged, result }
  } catch (err) {
    deps.meterFallback?.(err)
    return { engaged: false, fellBack: true }
  } finally {
    for (const idx of marked) {
      if (!settled.has(idx)) await settle(idx, "failed")
    }
    await chain
  }
}

// ---------------------------------------------------------------------------
// OL-9.4b — stop slices from re-deriving repo basics: a static repo primer
// plus a completed-slice digest ledger, both injected into the child prompt.
// ---------------------------------------------------------------------------

/** Top-level directory entries the repo primer never descends into or lists. */
const PRIMER_SKIP_DIRS = new Set(["node_modules", ".git", "dist"])

/** Hard cap on tree entries so a huge monorepo root can't blow up the primer. */
const PRIMER_MAX_ENTRIES = 60

export interface RepoPrimerOptions {
  /** Directory to root the tree + package.json lookup at; defaults to process.cwd(). */
  readonly cwd?: string
  readonly maxEntries?: number
}

/** List one directory's children (name, sorted), skipping PRIMER_SKIP_DIRS; "" on any read error. */
function listDirEntries(dir: string): Array<{ name: string; isDirectory: boolean }> {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => !PRIMER_SKIP_DIRS.has(d.name))
      .map((d) => ({ name: d.name, isDirectory: d.isDirectory() }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

function listTopTwoLevels(cwd: string, maxEntries: number): string[] {
  const out: string[] = []
  for (const entry of listDirEntries(cwd)) {
    if (out.length >= maxEntries) break
    out.push(entry.isDirectory ? `${entry.name}/` : entry.name)
    if (!entry.isDirectory) continue
    for (const child of listDirEntries(join(cwd, entry.name))) {
      if (out.length >= maxEntries) break
      out.push(`  ${entry.name}/${child.name}${child.isDirectory ? "/" : ""}`)
    }
  }
  return out
}

function summarizePackageJson(cwd: string): string | undefined {
  const pkgPath = join(cwd, "package.json")
  if (!existsSync(pkgPath)) return undefined
  try {
    const raw = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      name?: string
      scripts?: Record<string, string>
      workspaces?: unknown
    }
    const scripts = raw.scripts ? Object.keys(raw.scripts) : []
    return [
      `package.json: name=${raw.name ?? "(unnamed)"}`,
      `scripts=[${scripts.join(", ")}]`,
      `workspaces=${raw.workspaces ? "yes" : "no"}`,
    ].join(", ")
  } catch {
    return undefined
  }
}

/**
 * Render a bounded top-2-level file tree of `cwd` (node_modules/.git/dist
 * skipped, ~60 entries max) plus a one-line package.json summary, so slice
 * children stop re-deriving repo basics — live-run evidence showed parallel
 * wave-1 slices each independently re-reading package.json and re-listing
 * directories before their real work. Disk-only and best-effort: an
 * unreadable cwd or a missing/malformed package.json degrades to a shorter
 * primer, never a throw. Cheap enough to build once per orchestration run and
 * reuse across every dispatched slice.
 *
 * @sem domain=infrastructure role=digest
 */
export function buildRepoPrimer(opts?: RepoPrimerOptions): string {
  const cwd = opts?.cwd ?? process.cwd()
  const maxEntries = opts?.maxEntries ?? PRIMER_MAX_ENTRIES
  const sections: string[] = []
  const tree = listTopTwoLevels(cwd, maxEntries)
  if (tree.length > 0) sections.push(tree.join("\n"))
  const manifest = summarizePackageJson(cwd)
  if (manifest) sections.push(manifest)
  // 12039 tuning (M1): name the repo's REAL test harness so no slice guesses
  // one (the live failure: a runner guessed `pytest` on a django checkout and
  // the whole DAG settled unverified).
  const harness = detectPythonHarness(cwd)
  if (harness)
    sections.push(
      `Test harness (detected): \`${harness.template}\` — run tests ONLY through this harness${
        harness.kind === "django-runtests" ? "; this repo does NOT use pytest" : ""
      }.`,
    )
  if (sections.length === 0) return ""
  return [
    "## Repo primer (already established — do NOT re-list directories or re-read package.json for orientation)",
    ...sections,
  ].join("\n\n")
}

/** One completed slice's output, as tracked by the dispatch closure for later-wave ledger entries. */
export interface SliceDigestEntry {
  readonly id: string
  readonly text: string
}

/** Per-entry and whole-section char caps for the digest ledger — bounds cost as waves accumulate. */
const LEDGER_PER_DIGEST_MAX_CHARS = 1500
const LEDGER_TOTAL_MAX_CHARS = 5000

/**
 * Render the "established by earlier slices" section for a later-wave
 * dispatch: each completed slice's output truncated to a per-digest cap, the
 * whole section bounded by a total cap so a long-running DAG's ledger can't
 * grow unbounded. Empty input (wave 1, or nothing has completed yet) renders
 * "" so callers can drop it with the same `.filter(Boolean)` used for the
 * other optional prompt sections.
 *
 * @sem domain=infrastructure role=digest
 */
export function renderSliceDigestLedger(
  entries: readonly SliceDigestEntry[],
  opts?: { perDigestMaxChars?: number; totalMaxChars?: number },
): string {
  if (entries.length === 0) return ""
  const perDigestMaxChars = opts?.perDigestMaxChars ?? LEDGER_PER_DIGEST_MAX_CHARS
  const totalMaxChars = opts?.totalMaxChars ?? LEDGER_TOTAL_MAX_CHARS
  let budget = totalMaxChars
  const blocks: string[] = []
  for (const entry of entries) {
    const text = entry.text.length > perDigestMaxChars ? `${entry.text.slice(0, perDigestMaxChars)}…` : entry.text
    const block = `### ${entry.id}\n${text}`
    if (block.length > budget) break
    blocks.push(block)
    budget -= block.length
  }
  if (blocks.length === 0) return ""
  return ["## Established by earlier slices (trust these findings; do not re-derive them)", ...blocks].join("\n\n")
}
