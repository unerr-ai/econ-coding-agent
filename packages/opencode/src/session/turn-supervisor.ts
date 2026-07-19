/**
 * Root-turn step observation for the inline-loop stuck supervisor: distils one
 * completed assistant step's tool parts into the StepObservation the supervisor
 * keys on (a re-issued call, a repeated failing result, a test-file edit, a
 * slow/timeout-killed command) plus the shell commands that appear to have
 * failed — the probe-from-red pool the turn-end gate pins a reproduction from.
 * Pure: no Effect, no shell, no session, so it is table-testable; mirrors
 * extractTrajectory's completed-part reading so the two seams agree on what a
 * step is.
 *
 * @sem domain=routing role=digest
 */
import type { StepObservation } from "../../../code-intelligence/src/orchestration-fsm"
import { isTestFilePath, pathsRefer } from "../tool/edit-governance"

const FILE_EDIT_TOOLS = new Set(["edit", "write", "apply_patch"])
const COMMAND_TOOLS = new Set(["shell", "bash"])
const READ_TOOLS = new Set(["read"])

// The most identifying string in a tool's input — a human-readable prefix for
// the signature (the file, pattern, or sub-agent it acted on).
const IDENTITY_KEYS = ["filePath", "path", "pattern", "query", "url", "description", "prompt"]
function identifyingInput(input: Record<string, unknown>): string {
  for (const key of IDENTITY_KEYS) {
    const value = input[key]
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 200)
  }
  return ""
}

// Compact stable hash (FNV-1a) of a tool call's full input, so the signature
// reflects WHAT the step did, not just which file it touched.
function hashString(s: string): string {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h.toString(36)
}

// The resultless-repeat signature for a non-command tool: `tool:target#hash(input)`.
// Keying on the FULL input — not just the path — is what keeps the supervisor from
// mistaking normal work for a loop: three DIFFERENT edits to one file (import, then
// collect, then the delete loop) hash differently and read as progress, while only
// the SAME call re-issued verbatim collides. And a burst of DIVERSE reads/spawns
// yields diverse signatures rather than the same empty one. Both were run-11885
// false positives that escalated to the reasoner before a test ran (v1: empty
// read/spawn signatures; v2: path-only edit signatures) — a 3× cost regression.
function actionKey(tool: string, input: Record<string, unknown>): string {
  let payload = ""
  try {
    payload = JSON.stringify(input).slice(0, 4000)
  } catch {
    payload = ""
  }
  return `${tool}:${identifyingInput(input)}#${hashString(payload)}`
}

/** Minimal structural view of a completed tool part — mirrors slice-orchestrator's ToolPartLike, plus the result output and timing (state.time is populated by the processor on every completed/error tool part). */
interface ToolPartLike {
  type: string
  tool?: string
  state?: { status?: string; input?: Record<string, unknown>; output?: string; time?: { start: number; end?: number } }
}

// A command "failed" when the tool errored or its output carries a failure
// marker. Deliberately generous: this only decides whether a command is worth
// re-running as a probe candidate — deriveTurnProbe re-runs it and the actual
// exit code is the authority on red/green.
const FAILURE_RE =
  /\b(?:FAILED|FAIL|ERROR|ERRORS|Traceback|AssertionError|Exception|panic:|\d+\s+failed|not ok|assertion\s+failed)\b/i

function looksFailed(status: string, output: string): boolean {
  if (status === "error") return true
  return FAILURE_RE.test(output)
}

/**
 * Strip run-to-run noise (durations, timestamps, hex addresses, temp paths) so
 * an identical failure hashes identically across re-runs while its assertion
 * text — the actual signal — survives. Capped so a huge log can't dominate the
 * signature.
 */
export function normalizeResult(output: string): string {
  return output
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|seconds?|minutes?)\b/gi, "·t")
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}\S*/g, "·ts")
    .replace(/0x[0-9a-fA-F]+/g, "·hex")
    .replace(/(?:\/tmp\/|\/private\/|\/var\/folders\/)\S+/g, "·tmp")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000)
}

export interface StepObservationResult {
  observation: StepObservation
  /**
   * Commands the step ran that appear to have failed, in order — the
   * probe-from-red candidate pool. deriveTurnProbe filters these to test
   * reproductions and confirms redness by re-running, so false positives here
   * are harmless.
   */
  failedCommands: string[]
}

/**
 * A command running at or beyond this duration is slow enough to be an
 * environment signal — a CPU-starved shared host or a timeout-killed shell —
 * rather than genuine model stuckness. The stuck supervisor's repeated-red
 * rung reclassifies to `environment-slow` when the identical-failure streak
 * carries this signal.
 */
export const SLOW_COMMAND_MS = 60_000

/**
 * Distil one completed assistant step's parts into a StepObservation plus the
 * shell commands that looked like failures. `isTestSlice` suppresses the
 * test-file-edit tell for a turn where editing tests is legitimate (the gate is
 * not armed), so it never misreads sanctioned test work as fake-green.
 */
export function observeStep(parts: readonly unknown[], opts?: { isTestSlice?: boolean }): StepObservationResult {
  const toolTokens: string[] = []
  const resultTokens: string[] = []
  const failedCommands: string[] = []
  const readFiles: string[] = []
  let editedTestFile: string | undefined
  let ranCommand = false
  let progressed = false
  let slowCommand = false

  for (const raw of parts) {
    const part = raw as ToolPartLike
    if (part?.type !== "tool" || !part.tool) continue
    const status = part.state?.status ?? "completed"
    if (status !== "completed" && status !== "error") continue
    const input = part.state?.input ?? {}

    if (FILE_EDIT_TOOLS.has(part.tool)) {
      const filePath = (input["filePath"] ?? input["path"]) as string | undefined
      // Signature keys on the FULL input (via actionKey), so several different edits
      // to one file yield distinct signatures and read as progress, not a repeat.
      toolTokens.push(actionKey(part.tool, input))
      // A landed edit is a productive action — it clears the reread tally.
      if (status === "completed") progressed = true
      // Only a completed edit to a tracked test file, on a turn that forbids
      // test edits, is the fake-green tell — a denied attempt (status "error")
      // never modified anything and a sanctioned test turn is exempt.
      if (!opts?.isTestSlice && status === "completed" && filePath && !editedTestFile && isTestFilePath(filePath))
        editedTestFile = filePath
    } else if (COMMAND_TOOLS.has(part.tool)) {
      const command = typeof input["command"] === "string" ? (input["command"] as string).trim() : ""
      if (!command) continue
      ranCommand = true
      progressed = true // running a command is a productive action — clears the reread tally
      const output = typeof part.state?.output === "string" ? part.state.output : ""
      toolTokens.push(`${part.tool}:${command}`)
      resultTokens.push(`${status}|${normalizeResult(output)}`)
      if (looksFailed(status, output)) failedCommands.push(command)
      // Duration is the environment signal: a timeout-killed command runs ≈ the
      // bash timeout, so it qualifies here the same as a genuinely slow one —
      // both mean the shell, not the model, is the bottleneck.
      const time = part.state?.time
      if (time?.start !== undefined && time?.end !== undefined && time.end - time.start >= SLOW_COMMAND_MS) {
        slowCommand = true
      }
    } else {
      // Any other tool (read/grep/glob/list/task/webfetch/…) still distinguishes
      // the step: actionKey tracks it by tool + a hash of its full input, so a burst
      // of varied exploration reads as varied, not as a repeat. Resultless — never
      // touches the red tally. A file read is also tallied for the reread signal.
      toolTokens.push(actionKey(part.tool, input))
      if (READ_TOOLS.has(part.tool)) {
        const filePath = (input["filePath"] ?? input["path"]) as string | undefined
        if (filePath) readFiles.push(filePath)
      }
    }
  }

  return {
    observation: {
      toolSignature: toolTokens.join("|"),
      // Only a step that ran a command carries a result signature — an
      // edit-only or read-only step leaves the red tally untouched, which is
      // how the supervisor tolerates interleaved edits between re-runs.
      resultSignature: ranCommand ? resultTokens.join("|") : undefined,
      editedTestFile,
      readFiles,
      // A landed edit or a run command is progress — it resets the reread tally,
      // so a read that follows real work reads as re-verification, not circling.
      progressed,
      // At least one command this step ran took >= SLOW_COMMAND_MS (or was
      // timeout-killed) — the stuck supervisor's repeated-red rung reads this
      // to reclassify as environment-slow instead of escalating the model.
      slowCommand,
    },
    failedCommands,
  }
}

// ---------------------------------------------------------------------------
// L4.2 — the grind valve (SM4's step-budget rung)
// ---------------------------------------------------------------------------

/**
 * Soft step budget for an INLINE conductor turn before the valve may open.
 * django-11885 evidence (tracker tuning log 2026-07-10): the honest pass
 * ground 179 inline edit-test-edit steps ($0.8447) that the stuck supervisor
 * never caught — the steps were DIVERSE (different edits, different reds), so
 * no repetition pathology fired; the pathology was volume without convergence.
 */
export const GRIND_VALVE_STEPS = 60

/** How many recent steps must lack a green verify for the budget crossing to count as a stall — a run that is still landing green checks past the budget is converging, not grinding. */
export const GRIND_VALVE_STALL_WINDOW = 15

/** The valve's evidence when it opens — logged verbatim on the `grind_valve` line. */
export interface GrindValveSignal {
  /** The observed step index (1-based) at which the valve opened. */
  step: number
  /** Steps since the last green verify; equals `step` when no command has ever run green this turn. */
  stepsSinceGreen: number
}

export interface GrindValve {
  /** Feed one step's distilled result; returns the open signal exactly once, else undefined. */
  observe(step: StepObservationResult): GrindValveSignal | undefined
}

/**
 * Build the once-per-turn grind valve that watches the SAME per-step stream
 * the SM4 stuck supervisor observes (prompt.ts feeds both from one
 * `observeStep` call — the valve is SM4's budget rung, not a parallel
 * watcher). It opens when the turn crosses `GRIND_VALVE_STEPS` observed steps
 * AND no step in the last `GRIND_VALVE_STALL_WINDOW` was a green verify. A
 * green verify reuses the existing `looksFailed` signal: a step that ran at
 * least one command (`resultSignature` set) with an EMPTY `failedCommands`
 * pool — no second green-ness tracker exists. On open, the caller proposes
 * ONE reasoner design slice through the existing delegation machinery
 * (`GRIND_DESIGN_PREPASS_TODO` → the OL-7.3b slice hook); a fired valve never
 * re-fires — `observe` keeps consuming steps but returns undefined forever.
 *
 * @sem domain=routing role=orchestrator
 */
export function createGrindValve(): GrindValve {
  let step = 0
  let lastGreenStep = 0
  let fired = false
  return {
    observe(result) {
      step += 1
      // The green-verify signal: ran >=1 command, none looked failed
      // (looksFailed populated failedCommands above). An edit-only or
      // read-only step has no resultSignature and can never reset the stall.
      if (result.observation.resultSignature !== undefined && result.failedCommands.length === 0) {
        lastGreenStep = step
      }
      if (fired) return undefined
      const stepsSinceGreen = step - lastGreenStep
      if (step >= GRIND_VALVE_STEPS && stepsSinceGreen >= GRIND_VALVE_STALL_WINDOW) {
        fired = true
        return { step, stepsSinceGreen }
      }
      return undefined
    },
  }
}

// ---------------------------------------------------------------------------
// L1.2c — the batch-momentum watcher (round-trip economy rung)
// ---------------------------------------------------------------------------

/**
 * Consecutive single-call steps before the batch-momentum nudge fires. Three
 * is the smallest run that reads as a pattern rather than coincidence: the
 * live probes (fw-batch-probe round 2, 2026-07-10) showed three single-call
 * history steps already drag the default tier from 3/3 spontaneous batching
 * to 1/3.
 */
export const BATCH_NUDGE_AFTER_SINGLE_STEPS = 3

/** Minimum steps between firings — the reminder is recency-effective for the step right after it; re-nudging every step would pollute the transcript for no marginal effect. */
export const BATCH_NUDGE_REARM_STEPS = 8

/** The watcher's evidence when it fires — logged verbatim on the `batch_nudge` line. */
export interface BatchMomentumSignal {
  /** The observed step index (1-based) at which the nudge fired. */
  step: number
  /** Length of the current run of consecutive single-call steps. */
  consecutiveSingleCalls: number
}

export interface BatchMomentumWatcher {
  /** Feed one completed step's tool-call count; returns a fire signal when the nudge should inject, else undefined. */
  observe(toolCallCount: number): BatchMomentumSignal | undefined
}

/**
 * Build the batch-momentum watcher (turn-cache-economics.md §5-L1): the
 * default tier batches tool calls natively on a clean transcript but imitates
 * its own history once it carries a run of single-call messages, and a
 * recency-positioned reminder recovers batching where the system-prompt
 * BATCH_RULE alone does not (fw-batch-probe rounds 1–3: stack clean 12/12,
 * poisoned history 2/6 despite the rule, tail reminder 6/6). Fires after
 * `BATCH_NUDGE_AFTER_SINGLE_STEPS` consecutive single-call steps, re-arming
 * every `BATCH_NUDGE_REARM_STEPS` steps while the run persists. A multi-call
 * step resets the run (momentum broken — imitation now works for us); a
 * zero-call step is neutral (text-only steps neither prove nor disprove
 * batching).
 *
 * @sem domain=routing role=orchestrator
 */
export function createBatchMomentumWatcher(): BatchMomentumWatcher {
  let step = 0
  let consecutive = 0
  let lastFiredStep = -BATCH_NUDGE_REARM_STEPS
  return {
    observe(toolCallCount) {
      step += 1
      if (toolCallCount >= 2) {
        consecutive = 0
        return undefined
      }
      if (toolCallCount === 1) consecutive += 1
      if (consecutive >= BATCH_NUDGE_AFTER_SINGLE_STEPS && step - lastFiredStep >= BATCH_NUDGE_REARM_STEPS) {
        lastFiredStep = step
        return { step, consecutiveSingleCalls: consecutive }
      }
      return undefined
    },
  }
}

// ---------------------------------------------------------------------------
// Round-H — identical-run dedupe (probe_rerun_dedupe): the same shell command
// producing byte-identical output for the 3rd+ time carries zero new
// information (django-11815: ~72 repro re-runs, roughly half byte-identical).
// ---------------------------------------------------------------------------

/** A command must repeat this many times with an identical (normalized) output before it counts as a no-information rerun — the first two runs could be a legitimate confirm-then-reconfirm. */
export const IDENTICAL_RUN_THRESHOLD = 3

/** The dedupe tracker's evidence when it fires — logged verbatim on the `probe_rerun_dedupe` line. */
export interface RerunDedupeSignal {
  command: string
  /** How many times this command has now produced this exact (normalized) output, back to back. */
  occurrence: number
}

export interface RerunDedupeTracker {
  /** Feed one completed step's raw parts; returns a signal the first time a command crosses `IDENTICAL_RUN_THRESHOLD` byte-identical (normalized) reruns since its counter last reset, else undefined. */
  observe(parts: readonly unknown[]): RerunDedupeSignal | undefined
}

/**
 * Build the once-per-command identical-run dedupe tracker: per command
 * string, tallies consecutive runs whose `normalizeResult`-normalized output
 * hashes the same. A DIFFERENT output resets that command's own counter (so
 * a flaky test — same command, different result — never trips it). ANY
 * completed edit landing in a step resets EVERY command's counter (an edit
 * is forward progress; the next rerun of a command is new information again).
 * Fires at most once per distinct command for the tracker's lifetime (one
 * tracker per turn) — a converted signal, never a repeated one.
 *
 * @sem domain=routing role=orchestrator
 */
export function createRerunDedupeTracker(): RerunDedupeTracker {
  const runs = new Map<string, { hash: string; count: number }>()
  const nudged = new Set<string>()
  return {
    observe(parts) {
      let sawEdit = false
      for (const raw of parts) {
        const part = raw as ToolPartLike
        if (part?.type !== "tool" || !part.tool) continue
        if (FILE_EDIT_TOOLS.has(part.tool) && (part.state?.status ?? "completed") === "completed") sawEdit = true
      }
      // An edit landing this step is forward progress — every command's
      // rerun history resets, so a legitimate re-verify after a real change
      // never misreads as a no-information repeat.
      if (sawEdit) runs.clear()

      let signal: RerunDedupeSignal | undefined
      for (const raw of parts) {
        const part = raw as ToolPartLike
        if (part?.type !== "tool" || !part.tool || !COMMAND_TOOLS.has(part.tool)) continue
        if ((part.state?.status ?? "completed") !== "completed") continue
        const input = part.state?.input ?? {}
        const command = typeof input["command"] === "string" ? (input["command"] as string).trim() : ""
        if (!command) continue
        const output = typeof part.state?.output === "string" ? part.state.output : ""
        const hash = hashString(normalizeResult(output))
        const prior = runs.get(command)
        const entry = prior && prior.hash === hash ? { hash, count: prior.count + 1 } : { hash, count: 1 }
        runs.set(command, entry)
        if (entry.count >= IDENTICAL_RUN_THRESHOLD && !nudged.has(command) && !signal) {
          nudged.add(command)
          signal = { command, occurrence: entry.count }
        }
      }
      return signal
    },
  }
}

// ---------------------------------------------------------------------------
// Wave 10 — real test-execution detection (unverified-finish gate)
// ---------------------------------------------------------------------------

const TEST_EXEC_INTERPRETER_RE = /^python(\d+(\.\d+)*)?$/
const TEST_EXEC_RUNNER_RE = /^runtests(\.py)?$/i

/**
 * True when `cmd` actually RUNS a python test suite at command position — the
 * start of the command, or right after `&&`/`;`/`|` — never merely reads or
 * greps for one. The 11885 autopsy: the agent's one `runtests.py`-matching
 * command was `cat tests/runtests.py` (a read), and `py_compile` was its only
 * verification before shipping a 36-line source patch — a plain substring
 * scan for "runtests.py"/"test" would have called that verified.
 * `cat`/`head`/`tail`/`sed`/`grep` never qualify no matter what their
 * arguments name, since only the executable at command position is checked;
 * a python interpreter additionally needs an argument naming "test" or
 * "runtests.py" (covers `-m pytest`, `manage.py test`, and a django
 * `runtests.py` invocation alike), while `pytest`/`runtests(.py)` invoked
 * directly qualify on the position token alone.
 *
 * @sem domain=routing role=gate
 */
export function looksLikeTestExecution(cmd: string): boolean {
  const segments = cmd
    .split(/&&|;|\|/)
    .map((segment) => segment.trim())
    .filter(Boolean)
  for (const segment of segments) {
    const tokens = segment.split(/\s+/).filter(Boolean)
    const head = tokens[0]
    if (!head) continue
    const basename = (head.split("/").pop() ?? head).toLowerCase()
    if (basename === "pytest" || TEST_EXEC_RUNNER_RE.test(basename)) return true
    if (TEST_EXEC_INTERPRETER_RE.test(basename)) {
      const rest = tokens.slice(1).join(" ").toLowerCase()
      if (rest.includes("test")) return true
    }
  }
  return false
}

/**
 * Pure gate decision for the unverified-finish gate — a FIX-SHAPED root turn
 * may not conclude silently after landing a non-test source edit with ZERO
 * real test executions, but only ONCE per session (`alreadyDenied`, tracked
 * in unverified-finish-store.ts) and never for a child session, which
 * inherits the parent's verification rather than owing its own.
 *
 * @sem domain=routing role=gate
 */
export function shouldDenyUnverifiedFinish(input: {
  isChildSession: boolean
  landedSourceEdits: boolean
  ranRealTest: boolean
  alreadyDenied: boolean
}): boolean {
  if (input.isChildSession) return false
  if (!input.landedSourceEdits) return false
  if (input.ranRealTest) return false
  if (input.alreadyDenied) return false
  return true
}

/** D4 (09-ops-hands) — headless completion re-entry's three possible outcomes. */
export type HeadlessCompletionReentryDecision = "proceed" | "wait" | "heartbeat-pass"

/**
 * Pure gate decision for D4's headless completion re-entry — a headless session must not
 * finish silently while background jobs it started (job tool, 09-ops-hands D1/D3) are still
 * running, but the hold must always terminate. Interactive sessions, sessions with no running
 * jobs, and a spent re-entry budget all "proceed" (the inert path, untouched when the feature
 * never applies); once every currently-running job has already fired its one heartbeat nudge
 * (heartbeat-flagged), a later finish "heartbeat-pass"es instead of holding forever — a
 * bounded-retry gate must never become an unbounded loop in bounded-retry costume.
 *
 * @sem domain=routing role=gate
 */
export function decideHeadlessCompletionReentry(input: {
  interactive: boolean
  runningJobIds: readonly string[]
  heartbeatFlaggedJobIds: ReadonlySet<string>
  reentryCount: number
  maxReentries: number
}): HeadlessCompletionReentryDecision {
  if (input.interactive) return "proceed"
  if (input.runningJobIds.length === 0) return "proceed"
  if (input.reentryCount >= input.maxReentries) return "proceed"
  if (input.runningJobIds.every((id) => input.heartbeatFlaggedJobIds.has(id))) return "heartbeat-pass"
  return "wait"
}

// ---------------------------------------------------------------------------
// H3 — patch-level sanity floor (deterministic, ~$0 cost shape)
// ---------------------------------------------------------------------------

const TEST_INFRA_FILE_RE =
  /(^|\/)conftest\.py$|(^|\/)setup\.(py|cfg)$|(^|\/)\.github\/workflows\/[^/]+\.ya?ml$|(^|\/)\.circleci\/config\.ya?ml$|(^|\/)\.gitlab-ci\.ya?ml$|(^|\/)azure-pipelines\.ya?ml$|(^|\/)\.travis\.ya?ml$/

/**
 * H3 — is this path a test-infrastructure file (conftest.py, setup.py/
 * setup.cfg, or a CI config) rather than application code? These are almost
 * never a legitimate FIX site — `detectPatchSanityGap` requires an explicit
 * issue-text justification before accepting a patch that touches ONLY files
 * like these.
 *
 * @sem domain=routing role=gate
 */
export function isTestInfraFilePath(filePath: string): boolean {
  return TEST_INFRA_FILE_RE.test(filePath.replaceAll("\\", "/"))
}

/** True when the issue text explicitly names EVERY one of the given (test-infra) files, by basename. */
function issueJustifiesTestInfra(issueText: string, patchFiles: readonly string[]): boolean {
  const haystack = issueText.toLowerCase()
  return patchFiles.every((f) => haystack.includes((f.split("/").pop() ?? f).toLowerCase()))
}

/** H3 — the two ways a landed patch can fail the sanity floor; `undefined` means the patch is sane. */
export type PatchSanityGapReason = "no-overlap" | "test-infra-unjustified"

/**
 * H3 — the deterministic patch-level sanity floor: extends the hub-design
 * judge's own sanity check (`hub-design-judge.ts`'s `pathsRefer`-against-
 * `definitionSites` floor, `runHubDesignJudge`) from one judge-picked file to
 * the WHOLE landed patch. `files(patch) ∩ (issue-named files/symbols ∪
 * localization-probe candidates)` empty ⇒ `"no-overlap"` — the astropy-7166
 * shape (a $1.31 escalated fix that shipped a conftest.py-only patch with
 * zero relation to the issue). A patch whose files ALL overlap but are ALSO
 * all test-infrastructure (`isTestInfraFilePath`) additionally needs the
 * issue text to explicitly name every one of them — a graph-coincidental
 * symbol match inside a conftest.py is not the same as the issue actually
 * asking for that file to change. Zero candidate sites (issue text too
 * sparse to resolve anything, or the graph never warmed) is nothing to check
 * the patch against, so this fails open (`undefined`) rather than
 * false-firing on missing evidence.
 *
 * @sem domain=routing role=gate
 */
export function detectPatchSanityGap(input: {
  patchFiles: readonly string[]
  candidateSites: readonly string[]
  issueText: string
}): PatchSanityGapReason | undefined {
  if (input.patchFiles.length === 0) return undefined
  if (input.candidateSites.length === 0) return undefined
  const overlaps = input.patchFiles.some((f) => input.candidateSites.some((site) => pathsRefer(site, f)))
  if (!overlaps) return "no-overlap"
  if (input.patchFiles.every(isTestInfraFilePath) && !issueJustifiesTestInfra(input.issueText, input.patchFiles)) {
    return "test-infra-unjustified"
  }
  return undefined
}

/**
 * H3 — pure gate decision wrapping `detectPatchSanityGap`'s reason: a
 * bug-shaped root turn's insane patch gets ONE reject-with-nudge cycle
 * (`alreadyDenied`, tracked in patch-sanity-store.ts), never for a child
 * session, which inherits the parent's verification rather than owing its
 * own — same shape as `shouldDenyUnverifiedFinish`.
 *
 * @sem domain=routing role=gate
 */
export function shouldDenyPatchSanity(input: {
  isChildSession: boolean
  reason: PatchSanityGapReason | undefined
  alreadyDenied: boolean
}): boolean {
  if (input.isChildSession) return false
  if (input.reason === undefined) return false
  if (input.alreadyDenied) return false
  return true
}
