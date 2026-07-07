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
import {
  runSliceLoop,
  tierModelRef,
  ECON_PERSONAS,
  planWaves,
  type EconPersona,
  type LoopSlice,
  type SliceLoopDeps,
  type SliceDispatchRequest,
  type SliceDispatchResult,
  type SliceLoopResult,
  type SliceTrajectory,
  type TrajectoryEvent,
  type CommandRunner,
  type VerifyCommand,
  type CommandResult,
  type EconTier,
  type ExtraRungFn,
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
 * therefore only reachable via the explicit field — no sliceType defaults to
 * them. Pure so the dispatch closure and tests share one source of truth.
 *
 * @sem domain=routing role=router
 */
export function personaForSlice(slice: Pick<OrchestrationTodo, "sliceType" | "persona">): EconPersona {
  if (typeof slice.persona === "string" && (ECON_PERSONAS as readonly string[]).includes(slice.persona)) {
    return slice.persona as EconPersona
  }
  switch (slice.sliceType) {
    case "recon":
      return "explorer"
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
 * shape), so neither can ever touch the working tree or a shell.
 *
 * @sem domain=routing role=config
 */
export function childSlicePermission(
  parent: readonly SlicePermissionRule[] | undefined,
  readOnly: boolean,
  persona?: EconPersona,
  deciderSeat = false,
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
 * Frame slices (localization / planner pre-pass) localize across a whole
 * unfamiliar repo — the researcher's web-lookup budget starves them: the
 * caseA live fire burned all 15 calls on searches and delivered NOTHING,
 * which re-derailed the turn exactly like the pre-fix runs.
 */
export const FRAME_SLICE_STEP_BUDGET = 35

/** Step budget for a slice: frame slices get their own allowance, everything else the persona's. */
export function sliceStepBudget(persona: EconPersona, sliceId?: string): number {
  if (sliceId === LOCALIZATION_SLICE_CONTENT || sliceId === PLANNER_SLICE_CONTENT) return FRAME_SLICE_STEP_BUDGET
  return PERSONA_STEP_BUDGET[persona]
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
  runCommand?: CommandRunner
  onEscalation?: SliceLoopDeps["onEscalation"]
  cwd?: string
  /** Execution-free RM rung (OL-7.8a); composed ahead of the judge in the ladder's extension slot. */
  rmRung?: ExtraRungFn
  /** U3 — failure-containment snapshot bracket (opencode's snapshot subsystem); absent ⇒ today's dirty-tree behavior. */
  snapshot?: SliceLoopDeps["snapshot"]
  /** U3 — escalation provenance sink (fromTier/toTier/rungReason), fired once per escalation hop. */
  onProvenance?: SliceLoopDeps["onProvenance"]
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
    }
  }

  const deps: SliceLoopDeps = {
    dispatch: wrappedDispatch,
    runCommand: options?.runCommand ?? makeShellCommandRunner({ cwd: options?.cwd }),
    judgeGenerate: options?.judgeGenerate,
    qeGenerate: options?.qeGenerate,
    onEscalation: options?.onEscalation,
    rmRung: options?.rmRung,
    snapshot: options?.snapshot,
    onProvenance: options?.onProvenance,
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

/** Path-shaped tokens (a `/` and a source extension) a slice's text names — fed to the probes. */
const SLICE_FILE_RE = /[\w./-]+\/[\w.-]+\.[a-z]{1,5}\b/gi

function extractSliceFiles(text: string): string[] {
  const seen = new Set<string>()
  for (const m of text.matchAll(SLICE_FILE_RE)) seen.add(m[0])
  return [...seen]
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

// OL-9.3f deterministic decomposition backstop: keyword→sliceType heuristic,
// checked in this priority order (recon before verify before mechanical) so a
// multi-keyword item (e.g. "investigate then fix") lands on the earlier,
// safer-to-run-first stage rather than the destructive one.
const RECON_KEYWORDS = /\b(explore|find|trace|investigate|map|where)\b/i
const VERIFY_KEYWORDS = /\b(test|run|verify|typecheck|lint|reproduce)\b/i
const MECHANICAL_KEYWORDS = /\b(implement|fix|apply|add|wire|rename|refactor)\b/i

function inferSliceType(content: string): string {
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
 * Content of the localization slice the diagnosis pre-pass appends to a
 * bug-shaped build turn. Exported so the boundary test asserts the injected
 * item verbatim.
 */
export const LOCALIZATION_SLICE_CONTENT =
  "Localize the root cause BEFORE any fix is attempted: name the exact file(s) and function(s) that must change, the defect mechanism (why the current behavior is wrong), and the minimal fix strategy — every claim backed by evidence (file/line or call edge). Trace the failure path from symptom to cause with the graph tools (graph search, callers) and targeted file reads. Do not write code or propose diffs: deliver targets, mechanism, and strategy only. Budget discipline: your tool-call budget is hard (~35 calls); reserve the final steps to WRITE the deliverable — a partial localization delivered beats a perfect one unwritten."

/**
 * Shape of the todo the diagnosis pre-pass injects: OrchestrationTodo plus the
 * `priority` the todowrite boundary's SessionTodo.Info persistence requires.
 */
export interface InjectedSliceTodo extends OrchestrationTodo {
  readonly priority: string
}

/** The one localization slice the diagnosis pre-pass arms — shared by the turn-open seed (F1) and the todowrite-time net in autoTypeTodos. */
export const LOCALIZATION_PREPASS_TODO: InjectedSliceTodo = {
  content: LOCALIZATION_SLICE_CONTENT,
  status: "pending",
  priority: "high",
  sliceType: "design",
  // Localization sets the whole turn's ceiling, so the entry rung rounds UP
  // (§2 / casting rule 2) — and without a need pin a LONE seed never opens
  // shouldOrchestrate's benefit gate and sits pending forever.
  need: "reasoner",
  persona: "researcher",
}

/**
 * Content of the planner slice the hard-shape pre-pass seeds (§8 planner
 * seat): one bounded PLAN artifact — the plan/execute split — authored on the
 * reasoner tier and executed by the conductor. Exported so the fold-back
 * relay recognizes the frame slice by id, same as LOCALIZATION_SLICE_CONTENT.
 */
export const PLANNER_SLICE_CONTENT =
  "Produce a bounded execution PLAN for this turn — a plan artifact, not code. Deliver exactly: (1) ranked candidate defect sites (file + function), each with the evidence that earns its rank; (2) one discriminating probe per candidate — a cheap command or check whose outcome separates it from the rest; (3) the fix layer(s) the evidence points to, with the risk/blast-radius of touching each; (4) an execution DAG of typed slices for the conductor to dispatch — per slice: content, sliceType (recon/mechanical/verify), and deps. Writing code, diffs, or edits is forbidden: targets, probes, layers, and the DAG only. Budget discipline: your tool-call budget is hard (~35 calls); reserve the final steps to WRITE the plan — a partial plan delivered beats a perfect plan unwritten."

/** The planner seat's seed (§8): the localization pre-pass's frame-slice shape pinned `need:"reasoner"` — a hard diagnosis turn buys one bounded plan up front, and the pin is what carries a lone frame slice through the shouldOrchestrate benefit gate. */
export const PLANNER_PREPASS_TODO: InjectedSliceTodo = {
  content: PLANNER_SLICE_CONTENT,
  status: "pending",
  priority: "high",
  sliceType: "design",
  need: "reasoner",
  persona: "researcher",
}

// F1 — turn-open prompt-shape detection. Defect evidence in the USER prompt:
// repair verbs or symptom language. Deliberately requires defect words — a
// build prompt's "should return X" spec language must not match.
const PROMPT_DEFECT_EVIDENCE_RE =
  /\b(?:fix|debug|resolve|repair|diagnose|bug|broken|wrong(?:ly)?|incorrect(?:ly)?|fails?|failing|failure|error|exception|crash(?:es|ing)?|regression|instead of|unexpected(?:ly)?|doesn'?t work|not working|misbehav\w*)\b/i

/**
 * F1 — should this user prompt arm the diagnosis pre-pass at TURN OPEN,
 * before the conductor's first step? True for the SWE-bench shape: defect
 * evidence present (symptom language or a repair verb) and NO concrete file
 * target named — the localization decision is still open, and it sets the
 * whole turn's ceiling. A prompt that names a file is Type-B grounded (the
 * conductor goes direct); a prompt with no defect words is a build/Q&A turn.
 * The old trigger sat at todowrite time, downstream of the conductor's
 * explore-first localization — cases 1A/1B showed it never fires there on
 * diagnosis turns (todos arrive as retro logs after the wrong-layer anchor).
 *
 * @sem domain=routing role=router
 */
export function shouldRunDiagnosisPrepass(userPrompt: string): boolean {
  if (!userPrompt) return false
  return PROMPT_DEFECT_EVIDENCE_RE.test(userPrompt) && !FILE_TARGET_RE.test(userPrompt)
}

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
  /\b(?:add|write|create|author|update|extend|adjust|modify|fix|repair|rewrite)\b[^.!?\n]{0,24}?\btests?\b(?!\s+(?:pass|passes|passing|still|go|stay|remain|green))/gi

// A negation directly before the verb means PROHIBITION, not authorization —
// the caseA live fire showed "Do not modify any test files" disarming the
// very gate that sentence asks for.
const TEST_WORK_NEGATION_RE = /\b(?:not|never|don'?t|won'?t|avoid|without|no)\s+(?:\w+\s+){0,2}$/i

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

// ---------------------------------------------------------------------------
// §8 — evidence-shape classification: the turn-open casting decision
// ---------------------------------------------------------------------------

/** The five §1 flow shapes a root turn can open as. */
export type TurnShapeCategory = "diagnosis-vague" | "diagnosis-grounded" | "build" | "audit" | "qa"

/** classifyTurnShape's verdict: the flow shape plus how cleanly the signals agreed. */
export interface TurnShape {
  readonly category: TurnShapeCategory
  readonly confidence: "high" | "low"
}

// Question-shaped prose — the Type-F default when no casting signal fires.
// The only NEW pattern the classifier introduces: every casting signal below
// reuses the F1/B3/F3 regexes verbatim, so the classifier can never disagree
// with the structural nets those regexes arm.
const QUESTION_SHAPE_RE = /\?|^\s*(?:what|why|how|where|when|which|who|explain|describe|summarize)\b/i

/**
 * §8 rule 1 — classify the turn on EVIDENCE SHAPE, never task class, with the
 * same regexes the structural nets run on: defect evidence (F1) splits
 * diagnosis-vague/grounded on the file-target test (shouldRunDiagnosisPrepass
 * IS the vague detector, so the pre-pass seed gate and this classifier cannot
 * drift); a build-imperative opener marks a build; judgment keywords mark an
 * audit. Deterministic and synchronous — no LLM tiebreak — so ambiguity is
 * surfaced instead of resolved: two casting signals firing at once, or none,
 * is `confidence:"low"` (the no-signal default is qa for question-shaped
 * prose, build otherwise). Priority mirrors the nets: defect outranks
 * everything (the seed gate must behave exactly as before it existed), and a
 * build opener stands the judgment reading down (autoTypeTodos' build-branch
 * rule).
 *
 * @sem domain=routing role=router
 */
export function classifyTurnShape(userPrompt: string): TurnShape {
  const prompt = userPrompt ?? ""
  const defect = PROMPT_DEFECT_EVIDENCE_RE.test(prompt)
  const judgment = JUDGMENT_KEYWORDS.test(prompt)
  const build = BUILD_IMPERATIVE_START.test(prompt)
  const conflict = [defect, judgment, build].filter(Boolean).length > 1
  if (defect) {
    return {
      category: shouldRunDiagnosisPrepass(prompt) ? "diagnosis-vague" : "diagnosis-grounded",
      confidence: conflict ? "low" : "high",
    }
  }
  if (build) return { category: "build", confidence: conflict ? "low" : "high" }
  if (judgment) return { category: "audit", confidence: "high" }
  return { category: QUESTION_SHAPE_RE.test(prompt) ? "qa" : "build", confidence: "low" }
}

// One casting playbook per shape (§8): ≤4 lines each, appended to the turn's
// system array tail — never a prefix swap. Tier-speak only.
const CATEGORY_PREAMBLE: Record<TurnShapeCategory, string> = {
  "diagnosis-vague": [
    "TURN SHAPE: diagnosis (vague symptom — no site named).",
    "A localization/plan pre-pass frames this turn; do not anchor on a cause before its result folds back.",
    "Accept a defect site only with a discriminating probe result attached — never narrative alone.",
    "If evidence contradicts the frame, enumerate at least two candidate layers with a cheap probe each.",
  ].join("\n"),
  "diagnosis-grounded": [
    "TURN SHAPE: diagnosis (grounded — the prompt names the site).",
    "Verify the named site before editing: one discriminating probe that confirms the mechanism, then the fix.",
    "No broad exploration — the localization decision already happened in the prompt.",
  ].join("\n"),
  build: [
    "TURN SHAPE: build.",
    "Type the plan: write the full pending list first; decided changes become typed slices and parallel-eligible slices run as a DAG.",
    "Give every check-run item a real runnable command — a verify slice without one cannot reject.",
  ].join("\n"),
  audit: [
    "TURN SHAPE: audit.",
    "Judgment items are dispatched reasoner slices — never judge inline; synthesis composes the slice verdicts.",
    "Keep your own steps to dispatch and relay.",
  ].join("\n"),
  qa: [
    "TURN SHAPE: Q&A.",
    "Answer directly with the graph/read tools; no decomposition, no todo slices, no plan.",
    "Prefer the smallest read that answers — an explorer child only for a genuinely broad sweep.",
  ].join("\n"),
}

/**
 * §8 rule 4 — the turn-scoped category preamble. Pure so the prompt seam and
 * tests share one source of truth.
 *
 * @sem domain=routing role=config
 */
export function categoryPreamble(category: TurnShapeCategory): string {
  return CATEGORY_PREAMBLE[category]
}

// §8 planner-seat hardness proxy — a deterministic stand-in for the turn-risk
// probe, whose result lands in createUserMessage (the plan-time reasoning
// raise) upstream of and invisible to the turn-open seed block. Two signals,
// either one suffices:
//   1. >=2 distinct subsystem tokens — dotted/camelCase/PascalCase/snake_case
//      identifiers or backticked spans (a vague prompt names no file, so
//      these are the only code anchors it can carry): the symptom already
//      spans more than one place.
//   2. a multi-sentence symptom carrying a cross-layer marker
//      (intermittent/race/after-upgrade …) — §2's framework-magic smell.
// Dotted segments require >=2 chars so "e.g"/"i.e" prose never counts.
const SUBSYSTEM_TOKEN_RE =
  /`[^`\n]{2,}`|\b[A-Za-z_$][\w$]+(?:\.[A-Za-z_$][\w$]+)+\b|\b[a-z][a-z0-9]*[A-Z]\w*\b|\b[A-Z][a-z0-9]+[A-Z]\w*\b|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g
const CROSS_LAYER_MARKER_RE =
  /\b(?:intermittent\w*|race|sometimes|occasionally|randomly|nondeterminis\w*|flak(?:y|ing|es)|deadlock|timing|under load|after (?:an? )?(?:upgrad|updat|migrat)\w*)\b/i

/**
 * §8 — is this diagnosis-vague turn HARD enough to buy the planner seat?
 *
 * @sem domain=routing role=router
 */
export function isHardDiagnosisPrompt(userPrompt: string): boolean {
  if (!userPrompt) return false
  const tokens = new Set<string>()
  for (const m of userPrompt.matchAll(SUBSYSTEM_TOKEN_RE)) tokens.add(m[0].toLowerCase())
  if (tokens.size >= 2) return true
  const sentences = userPrompt.split(/[.!?\n]+/).filter((s) => s.trim().length > 0)
  return sentences.length >= 2 && CROSS_LAYER_MARKER_RE.test(userPrompt)
}

/**
 * §8 casting, rule 2 (ambiguity rounds UP): the frame slice a diagnosis-vague
 * turn seeds at turn open — the reasoner planner for hard shapes, the
 * localization slice otherwise. One selection rule, shared by the prompt
 * loop's seed block and the tests.
 *
 * @sem domain=routing role=router
 */
export function diagnosisPrepassSeed(userPrompt: string): InjectedSliceTodo {
  return isHardDiagnosisPrompt(userPrompt) ? PLANNER_PREPASS_TODO : LOCALIZATION_PREPASS_TODO
}

// ---------------------------------------------------------------------------
// U1/U2 — turn triage: preamble + goal-tree skeleton
// (docs/architecture/ORCHESTRATION_MECHANISM.md §1.1, §1.2, §4.1, §4.5)
// ---------------------------------------------------------------------------

/**
 * §1.1/§4.1 — the turn-scoped preamble built from a non-null triage verdict:
 * lists every extracted goal (shape + deliverable) and constraint so the
 * conductor tracks each goal against its own todo instead of collapsing a
 * compound turn into one label. Pure and byte-stable for the turn — the same
 * verdict always yields the same string — so it rides the system-array tail
 * exactly like `categoryPreamble`, replacing it whenever triage is non-null.
 *
 * @sem domain=routing role=config
 */
export function triagePreamble(verdict: TriageVerdict): string {
  const lines = [
    `TURN SHAPE: triage (${verdict.goals.length} goal${verdict.goals.length === 1 ? "" : "s"} extracted, confidence=${verdict.confidence}).`,
  ]
  verdict.goals.forEach((goal, i) => {
    const tags = goal.needsPlan ? `${goal.shape}, needs-plan` : goal.shape
    lines.push(`${i + 1}. [${tags}] "${goal.quote}" — done when: ${goal.deliverable || "the goal is satisfied"}`)
  })
  for (const constraint of verdict.constraints) {
    lines.push(`CONSTRAINT (${constraint.kind}): "${constraint.quote}"`)
  }
  lines.push("Track each goal against its own todo; verify each independently — never conflate or drop one for another.")
  return lines.join("\n")
}

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

/** One writable turn-open skeleton row — `OrchestrationTodo` plus the `priority`/`parentID` fields `SessionTodo.Info` (§1.2/§4.5) carries. */
export interface TriageTodoRow extends OrchestrationTodo {
  readonly priority: string
  readonly parentID?: number
}

/**
 * §1.2/U2 — materialize the turn-open todo skeleton from a non-null triage
 * verdict: one root todo per goal (dependency order, `orderTriageGoals`), and
 * for any goal carrying `needsPlan` or shaped `diagnosis-vague`, one
 * frame-seed child (`diagnosisPrepassSeed`, reused verbatim) linked by the
 * goal-tree's `parentID` position index (goal -> task, one level — well
 * inside the tracker's depth-3 cap). Dedup is structural: exactly one seed
 * check per goal, so a goal can never carry two frame seeds.
 *
 * @sem domain=routing role=router
 */
export function buildTriageTodoSkeleton(verdict: TriageVerdict): TriageTodoRow[] {
  const order = orderTriageGoals(verdict.goals)
  const positionOf = new Map<number, number>()
  const todos: TriageTodoRow[] = []
  for (const origIdx of order) {
    positionOf.set(origIdx, todos.length)
    const goal = verdict.goals[origIdx]!
    todos.push({ content: goal.quote, status: "pending", priority: "medium" })
  }
  for (const origIdx of order) {
    const goal = verdict.goals[origIdx]!
    if (goal.needsPlan || goal.shape === "diagnosis-vague") {
      const seed = diagnosisPrepassSeed(goal.quote)
      todos.push({ ...seed, parentID: positionOf.get(origIdx)! })
    }
  }
  return todos
}

/**
 * Structural round-up net over the triage verdict (case-1 tierfire3 decode):
 * the extractor reads any entity mention ("TextChoices") as grounding, but a
 * symptom prompt that names no concrete code-file location still needs
 * localization before a fix — so a "diagnosis-grounded" goal in a prompt with
 * no FILE_TARGET_RE match rounds up to "diagnosis-vague", which re-arms the
 * skeleton's frame seed. Casting policy: ambiguity rounds UP for
 * decision-shaped stages (docs/design/failure-taxonomy.md §8). Returns the
 * verdict unchanged (same reference) when nothing rounds, so callers can
 * detect the flip by identity for telemetry.
 *
 * @sem domain=routing role=router
 */
export function roundUpTriageShapes(verdict: TriageVerdict, userPrompt: string): TriageVerdict {
  if (FILE_TARGET_RE.test(userPrompt)) return verdict
  if (!verdict.goals.some((g) => g.shape === "diagnosis-grounded")) return verdict
  return {
    ...verdict,
    goals: verdict.goals.map((g) => (g.shape === "diagnosis-grounded" ? { ...g, shape: "diagnosis-vague" } : g)),
  }
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
 * non-pending items are never retyped.
 *
 * One structural exception on the build-turn branch — the diagnosis pre-pass
 * (SWE-bench django-11964/11885 decode): when a build turn is bug-shaped (a
 * pending item opens with a repair verb) and NO active item names a concrete
 * file yet, the conductor is about to guess the root cause, and localization
 * is the decision that sets the whole turn's ceiling. The pre-pass appends one
 * typed localization slice — `design` allocates to the oracle tier
 * (judge-verified when untestable) and the researcher persona is read+fetch
 * only on the tightest step budget — a lean decider front-loaded before the
 * conductor's own checklist, never a second workhorse. Existing items are
 * never edited or reordered (append-only: `todo_N` positional deps must not
 * shift), and the injected slice is typed, so a second pass exits on the
 * typed-list guard — one injection per list, ever. Engagement, allocation,
 * lanes, and attempt caps all stay with the existing OL-9.5 machinery
 * downstream.
 *
 * The build branch's second net is the plan-first typing net (typeBuildPlan,
 * F3/B8). Precedence is by construction, not by ordering luck: the judgment
 * shape requires NO build-shaped active item, so an audit list never reaches
 * the build branch; the diagnosis pre-pass requires NO active file target
 * while the net requires two decided-change targets, so the two build-side
 * nets are disjoint; and a list the conductor typed itself exits at the top
 * guard before any net runs — self-typing, when it happens, wins.
 *
 * §4.2 rule 4 (venue affinity, U2, conservative v1): after a net above would
 * type the batch, a result of <= VENUE_INLINE_MAX_ITEMS items with no `need`
 * pin among them is discarded — the whole point of typing is to justify a
 * spawn, and a candidate set this small at the conductor's own tier never
 * clears that bar, so the batch is returned untyped for inline execution.
 *
 * @sem domain=routing role=router
 */
export function autoTypeTodos<T extends OrchestrationTodo>(todos: readonly T[]): (T | InjectedSliceTodo)[] {
  if (todos.some(isTypedSlice)) return [...todos]
  const active = todos.filter((t) => !TERMINAL_TODO_STATUSES.has(t.status))
  const typed = ((): (T | InjectedSliceTodo)[] => {
    if (active.some((t) => MECHANICAL_START.test(t.content) || isDecidedChange(t))) {
      const bugShaped = todos.some((t) => t.status === "pending" && DIAGNOSIS_START.test(t.content))
      const localized = active.some((t) => FILE_TARGET_RE.test(t.content))
      if (bugShaped && !localized) {
        return [...todos, LOCALIZATION_PREPASS_TODO]
      }
      return typeBuildPlan(todos)
    }
    return todos.map((t) => {
      // A leading bracket tag ("[audit] …", "[verdict] …") is presentation the
      // triage preamble taught the conductor, not content (case-2 tierfire3
      // decode: the suite run priced at reasoner because the tag's literal
      // "audit" judgment-typed it). Classify the BODY first: a tag-hidden
      // mechanical opener stays untyped, and a pure check-run with no judgment
      // language in its body types plain verify (runner) even inside an
      // audit-tagged list. The tag still counts as a judgment signal for items
      // whose body carries no keyword at all ("[verdict] SHIP or DO NOT SHIP").
      const body = t.content.replace(TODO_TAG_RE, "")
      if (t.status !== "pending" || MECHANICAL_START.test(body)) return t
      if (!JUDGMENT_KEYWORDS.test(body) && !TEST_AUTHORING_RE.test(body) && VERIFY_RUN_KEYWORDS.test(body))
        return { ...t, sliceType: "verify" }
      if (JUDGMENT_KEYWORDS.test(t.content)) return { ...t, sliceType: "verify", need: "reasoner" }
      if (VERIFY_RUN_KEYWORDS.test(t.content)) return { ...t, sliceType: "verify" }
      return t
    })
  })()
  // §4.2 rule 4 (venue affinity, conservative v1): a typed candidate set this
  // small, with nothing pinned above the conductor, earns nothing from a
  // spawn (§1.3) — leave it untyped so the conductor executes it inline
  // instead of paying a child's brief-compile + cold-cache-write cost.
  const newlyTyped = typed.filter(isTypedSlice)
  if (newlyTyped.length > 0 && newlyTyped.length <= VENUE_INLINE_MAX_ITEMS && newlyTyped.every((t) => !t.need)) {
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
 * that already reached a terminal status.
 *
 * @sem domain=routing role=digest
 */
export async function todosToLoopSlices(
  todos: readonly OrchestrationTodo[],
  probes: SliceProbes,
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

  // Design-emits-the-patch: a design slice that feeds a mechanical slice must end
  // with the concrete edit — the downstream executor transcribes, it does not invent.
  const PATCH_CONTRACT =
    "\n\nOutput contract: a mechanical slice will apply your design verbatim. End your output with the CONCRETE edit(s) — for each change: the file path, the precise location, and the exact new code (or a unified diff). Prose without the exact code is an incomplete result."
  const sliceTypeAt = new Map(typed.map((t, i) => [ids[i]!, t.sliceType]))
  const hasMechanicalDependent = (id: string): boolean =>
    typed.some((t, j) => effectiveDeps[j]!.includes(id) && t.sliceType === "mechanical")
  const dependsOnDesign = (i: number): boolean => effectiveDeps[i]!.some((d) => sliceTypeAt.get(d) === "design")

  // F2: a batch that authors tests legitimately edits test files — the
  // test-tree guard is skipped for the whole batch.
  const batchAuthorsTests = typed.some((t) => TEST_AUTHORING_RE.test(t.content))

  return Promise.all(
    typed.map(async (t, i): Promise<LoopSlice> => {
      const files = extractSliceFiles(t.content)
      const [coupling, testStrength] = await Promise.all([
        t.coupling ? Promise.resolve({ coupling: t.coupling as "low" | "high" }) : probes.probeCoupling(t.content, files),
        t.testStrength
          ? Promise.resolve({ testStrength: t.testStrength as "testable" | "untestable" })
          : probes.probeTestStrength(files),
      ])
      const deps = effectiveDeps[i]!.filter((d) => used.has(d))
      const isPatchEmittingDesign = t.sliceType === "design" && hasMechanicalDependent(ids[i]!)

      // F2 — sound-rung spec: a verify slice always wants commands; a testable
      // mechanical slice wants its edit checked the same way. Text-named
      // commands win; the repo-script probe fills in when the text names none.
      // The test-tree guard rides FIRST in every command-backed spec.
      const wantsCommands =
        t.sliceType === "verify" || (t.sliceType === "mechanical" && testStrength.testStrength === "testable")
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
        prompt: isPatchEmittingDesign ? `${t.content}${PATCH_CONTRACT}` : t.content,
        sliceType: t.sliceType as LoopSlice["sliceType"],
        need: t.need,
        deps: deps.length > 0 ? deps : undefined,
        coupling: coupling.coupling,
        testStrength: testStrength.testStrength,
        specBacked: t.sliceType === "mechanical" && dependsOnDesign(i) ? true : undefined,
        ...(verifyCommands.length > 0 ? { verifyCommands } : {}),
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
 * or a slice needs a tier above the executor (run-21: a lone judgment slice
 * pinned `need:"reasoner"` IS the benefit — a fresh-context higher-tier
 * verdict the lead model cannot produce inline — so it must not be declined
 * for being a width-1 DAG). A linear all-cheap chain — every wave width 1,
 * no raised need — gains nothing from being split: each child still pays its
 * own context re-derivation and the waves still serialize, so it is strictly
 * worse than handling the same work inline (run-8 evidence: 868 LLM calls
 * for one trivial, purely-linear issue). Applied once per engagement, right
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
  if (slices.some((s) => s.need === "reasoner" || s.need === "oracle")) return true
  if ((goalCount ?? 0) >= 2) return true
  return planWaves(slices).some((wave) => wave.length >= 2)
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
 * never leave a slice's mirrored todo orphaned `in_progress`.
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
    const typedIndices = todos.map((t, i) => (isDispatchableSlice(t) ? i : -1)).filter((i) => i >= 0)
    const slices = await todosToLoopSlices(todos, deps.probes)
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
      if (idx !== undefined) await settle(idx, "completed")
    }
    await chain
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
