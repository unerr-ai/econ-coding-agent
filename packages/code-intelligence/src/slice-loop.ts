/**
 * The execute-cheap-then-verify slice loop (OL-7.3 + OL-2.2) — the pure
 * orchestration state machine that makes the decomposition-first architecture
 * live. Given a DAG of typed slices it: evaluates each slice's tier + venue
 * at dispatch (evaluator.ts's `evaluate()`, U4/§4.2 — allocation.ts's matrix
 * is its base, superseded only by the one sanctioned mechanical de-escalation
 * behind a strong safety net), dispatches it on the decided tier (injected),
 * gates the result through the verifier ladder mapped from the allocated rung
 * (verifier.ts + the cross-model judge of judge.ts) — an untestable slice with
 * no applicable check is accepted flagged unverified rather than rejected
 * (OL-9.5d: absence of a check is not evidence of failure) — and only a real
 * reject climbs the tier ladder, capped at a per-slice `maxAttempts` total
 * dispatches (one escalation hop for a normal slice, none at all for a
 * read-only recon/verify slice; run-8 post-mortem: an un-capped ladder re-ran
 * identical work up to 4x per slice with no new signal) with a compiled
 * failure brief per hop (brief.ts), re-verifying each rescue and
 * recording every discarded attempt as double-pay (double-pay.ts). Slices run
 * in dependency (topological) order; independent slices in a wave run in
 * parallel. Every dispatch is wall-clock capped per its slice type, and the
 * whole run is capped by a budget derived from the plan (OL-9.3e) — exhaustion
 * fails loud (a per-slice timeout feeds the normal escalation/fail path; the
 * overall budget throws) rather than a silent hang. Everything external — the
 * model dispatch, the shell command runner, the judge/QE samplers — is
 * injected, so the machine is pure and fully testable without a live model or
 * a real shell. Decomposition orchestration is unconditional (2026-07-04): the
 * loop always dispatches when called with slices, no flag gates it. Each
 * escalation brief states the rejecting rung's missing evidence as the
 * rescue's objective and lists files the prior attempt already read, so a
 * rescue builds on prior work instead of re-deriving it (OL-9.4c); the loop
 * also tracks first-pass/attempts telemetry per run for the savings receipt.
 * A rejected attempt is contained (U3, OL-ORCH-4.3): when a `snapshot` dep is
 * injected, every editable attempt (never a read-only recon/verify slice) is
 * bracketed by `track()`/`restore()`, so a reject's diff never lingers in the
 * tree — it rides the next escalation brief (or the final failure result on
 * ladder exhaustion) as bounded advice instead. Escalation provenance
 * (fromTier/toTier/why) is reported via the optional `onProvenance` dep. Every
 * evaluation (the first dispatch and each escalation re-entry) is also
 * reported via the optional `onEvaluation` dep, carrying the decided
 * tier/venue and the rule reasons behind them, for the receipt's evaluator
 * drilldown (U6).
 *
 * @sem domain=routing role=orchestrator
 */

import {
  allocateSlice,
  type SliceAllocation,
  type SliceAllocationInput,
  type SliceType,
  type Coupling,
  type TestStrength,
  type VerifierRung,
} from "./allocation.js"
import { evaluate, type EvalContext } from "./evaluator.js"
import {
  runVerifierLadder,
  type VerifierLadderInput,
  type VerifierVerdict,
  type VerifyCommand,
  type CommandRunner,
  type SliceTrajectory,
  type FileEditEvent,
  type CommandEvent,
  type FileReadEvent,
  type ExtraRungFn,
} from "./verifier.js"
import { judgeRung } from "./judge.js"
import { composeExtraRungs } from "./compose-rungs.js"
import { compileBrief, type FailureEvidence, type OracleBrief } from "./brief.js"
import { recordEscalation, DoublePayLedger, type EscalationCost, type TurnTokens, type LedgerSnapshot } from "./double-pay.js"
import { tierModelRef } from "./model-registry.js"
import type { EconTier } from "./region.js"

// ---------------------------------------------------------------------------
// Slice + dispatch types
// ---------------------------------------------------------------------------

/**
 * One node in the decomposition DAG the loop executes. `coupling`/`testStrength`
 * come pre-tagged from the OL-7.9 probes at decompose time (the loop does not
 * re-probe — that is the caller's job); `verifyCommands` is the sound-rung spec
 * for a testable slice; `wiring` is the deterministic graph facts already woven
 * for this slice (OL-7.7). All allocation-facing fields are optional so a
 * partially-tagged slice still allocates defensively (allocation.ts).
 *
 * @sem domain=routing role=type
 */
export interface LoopSlice {
  /** Stable id, unique within the DAG; referenced by other slices' `deps`. */
  id: string
  /** The slice task text — the base prompt the tier executes and the brief's problem. */
  prompt: string
  /** Ids of slices this one depends on; they complete before this slice runs. */
  deps?: readonly string[]
  sliceType?: SliceType
  coupling?: Coupling
  testStrength?: TestStrength
  /** Conductor minimum-tier hint (an EconTier name); allocation may raise, never lower. */
  need?: string
  /** OL-3 code-structural risk (0–100); an in-cell tiebreaker only. */
  risk?: number
  /** True when this slice depends on a design slice whose output carries the concrete patch (design-emits-the-patch). */
  specBacked?: boolean
  /** Sound-rung commands (typecheck / test / lint) for a testable slice. */
  verifyCommands?: readonly VerifyCommand[]
  /** True when this slice's own task is to author/modify tests (behavior monitor exemption). */
  isTestSlice?: boolean
  /** Deterministic wiring facts already assembled for this slice (OL-7.7) — fed to the judge and the escalation brief. */
  wiring?: string
  /** Expected output shape, surfaced in the escalation brief. */
  outputShape?: string
}

/** A single model dispatch the loop asks the host to run (cheap hop or escalation hop). */
export interface SliceDispatchRequest {
  sliceId: string
  /** The tier that must execute this dispatch (resolved to a model downstream via the registry). */
  tier: EconTier
  /** The prompt the tier executes: the slice prompt (+ wiring) on the cheap hop, a compiled brief on escalation. */
  prompt: string
  /** True on the escalation hop, false on the first cheap attempt. */
  escalated: boolean
  /** The slice's DAG node type, carried so the host can enforce the slice's lane (e.g. read-only). */
  sliceType?: SliceType
}

/**
 * The lane predicate for slice execution: recon and verify slices observe and
 * report — they must never mutate the working tree (a live recon slice editing
 * source raced the implement slice and corrupted its edit). The host enforces
 * this mechanically (a deny rule on the child session's edit permission), not
 * just in the prompt, and it applies to escalation rescues of the slice too.
 *
 * @sem domain=routing role=validator
 */
export function isReadOnlySlice(sliceType?: string): boolean {
  return sliceType === "recon" || sliceType === "verify"
}

/** What a dispatch returns: the output, the trajectory to monitor, and usage for double-pay. */
export interface SliceDispatchResult {
  /** The tier's final text output. */
  text: string
  /** What the tier touched (file edits + commands) — fed to the behavior monitor (F15). */
  trajectory: SliceTrajectory
  /** Cost/tokens for the honest net receipt; when absent the loop records zeros + the tier's model. */
  usage?: { model: string; cost: number; tokens: TurnTokens }
}

/**
 * Everything the loop depends on from the outside world. All optional deps
 * degrade safely: no runner ⇒ sound rung inapplicable; no judge ⇒ judge rung
 * skipped; no QE sampler ⇒ QE fallback skipped; no dispatchTimeout/loopTimeout
 * ⇒ a real wall-clock race (OL-9.3e). `dispatch` is the only required dep —
 * it is the sub-agent spawn (live: the task tool; tests: a double).
 *
 * @sem domain=routing role=type
 */
export interface SliceLoopDeps {
  /** Run one slice on a tier and return its output + trajectory. The sub-agent spawn seam. */
  dispatch: (req: SliceDispatchRequest) => Promise<SliceDispatchResult>
  /** Sound-rung command executor; omit to treat every slice as having no sound check. */
  runCommand?: CommandRunner
  /** Cross-model judge sampler — MUST be a different model family than the generator (§4.3). */
  judgeGenerate?: (prompt: string) => Promise<string>
  /** QE self-consistency extra-sample sampler for the untestable fallback rung (OL-3.5a). */
  qeGenerate?: (sliceId: string) => Promise<string>
  /** Allocation override for tests; defaults to the pure allocateSlice. */
  allocate?: (input: SliceAllocationInput) => SliceAllocation
  /** Double-pay telemetry sink; the loop always also accumulates into its own ledger. */
  onEscalation?: (record: EscalationCost) => void
  /** Tier→model resolver for double-pay records; defaults to the registry's tierModelRef. */
  tierModel?: (tier: EconTier) => string
  /**
   * Optional execution-free RM rung (OL-7.8a) for the ladder's extension slot. When
   * present it is composed AHEAD of the cross-model judge (§4.6 ladder order), so it
   * runs first on an untestable slice and the judge only fires if the RM abstains.
   * Absent ⇒ the extension slot is judge-only, byte-identical to the pre-RM path.
   */
  rmRung?: ExtraRungFn
  /**
   * Wraps one dispatch call in its slice's wall-clock cap (OL-9.3e); defaults to a
   * real timer race (`raceTimeout`). A test injects a synchronous double — e.g. one
   * that rejects with `SliceTimeoutError` — to simulate a timeout without a real wait.
   */
  dispatchTimeout?: <T>(promise: Promise<T>, timeoutMs: number) => Promise<T>
  /**
   * Wraps the loop's full run of waves in the overall budget derived from the plan
   * (OL-9.3e, see `overallLoopBudgetMs`); defaults to the same real timer race.
   * Exhaustion makes `runSliceLoop` throw — see its doc.
   */
  loopTimeout?: <T>(promise: Promise<T>, timeoutMs: number) => Promise<T>
  /**
   * Per-slice attempt cap override (OL-9.5d): total dispatch calls (the cheap
   * attempt plus every rescue hop) allowed before the ladder gives up and
   * returns "unverified" with the last verdict. Defaults to
   * `defaultMaxAttempts` — `MAX_SLICE_ATTEMPTS` (2) for a normal slice, 1 (no
   * ladder at all) for a read-only (recon/verify) slice. Tests inject this to
   * tune the cap without hardcoding it.
   */
  maxAttempts?: (slice: LoopSlice) => number
  /**
   * Failure-containment snapshot bracket (U3, OL-ORCH-4.3): when present, an
   * editable slice's attempt is bracketed by `track()` before dispatch; on a
   * reject, the diff since that hash is captured (bounded) and the tree is
   * `restore()`d BEFORE the next hop is built (or before the ladder gives
   * up) — the escalated tier (or the final failure result) sees the failed
   * diff as advice, never as residue left in the tree. Read-only
   * (recon/verify) slices are never bracketed (`isReadOnlySlice`) — nothing
   * to roll back. Absent ⇒ today's dirty-tree behavior, unchanged.
   */
  snapshot?: {
    /** Record the current tree state; may resolve undefined when there is nothing to snapshot. */
    track(): Promise<string | undefined>
    /** Restore the tree to a previously tracked hash. */
    restore(hash: string): Promise<void>
    /** Diff the tree against a previously tracked hash. */
    diff(hash: string): Promise<string>
  }
  /**
   * Escalation provenance sink (U3): fired once per escalation hop with the
   * rejecting rung's reason, so an INFO-level log can decode WHY a rung
   * escalated — the live-fire decode gap where INFO logs never carried this.
   * A no-op when absent.
   */
  onProvenance?: (e: { sliceId: string; fromTier: EconTier; toTier: EconTier; rungReason: string }) => void
  /**
   * Pre-dispatch evaluator sink (U4, ORCHESTRATION_MECHANISM.md §4.2): fired
   * once per `evaluate()` call — the first dispatch and each escalation
   * re-entry — with the decided tier/venue and the rule reasons that produced
   * them. A no-op when absent.
   */
  onEvaluation?: (e: { sliceId: string; tier: string; venue: string; reasons: string[] }) => void
}

// ---------------------------------------------------------------------------
// Per-slice outcome + loop result
// ---------------------------------------------------------------------------

/** Terminal state of one slice in the machine. */
export type SliceState =
  | "accepted" // cheap attempt passed verification
  | "escalated" // cheap attempt rejected → climbed the ladder; a higher tier's re-verified output accepted
  | "unverified" // rejected but already at the top tier (no higher tier / hatch off) — accepted with a warning

export interface SliceOutcome {
  id: string
  state: SliceState
  /** The tier the cheap attempt ran on. */
  tier: EconTier
  /** The verifier rung the allocation asked for. */
  verification: VerifierRung
  allocation: SliceAllocation
  /** The verifier ladder's verdict on the attempt the loop settled on (cheap, or the last rescue). */
  verdict: VerifierVerdict
  /** The output the loop accepted (cheap output, or the escalation's output). */
  output: string
  /** Total dispatch calls for this slice: 1 when the cheap attempt passed outright, N>1 for N-1 rescue hops (OL-9.4c). */
  attempts: number
  /** Present only when the slice escalated: the LAST hop's tier, compiled brief, and result. */
  escalation?: {
    tier: EconTier
    brief: OracleBrief
    result: SliceDispatchResult
    record: EscalationCost
  }
  /**
   * Present only when the ladder exhausted (no more tiers/attempts) AND the
   * last attempt's edits were reverted by the containment bracket (U3): the
   * bounded diff of what was tried and rolled back, for the turn owner to
   * inspect since no further escalation will see it.
   */
  revertedDiff?: string
}

/** Per-run first-pass/attempts telemetry (OL-9.4c) — how often the cheap tier's own first attempt already passed, attached data-only next to the double-pay ledger for a future receipt to render escalation rate. */
export interface SliceLoopTelemetry {
  /** Number of slices the loop dispatched this run. */
  slicesDispatched: number
  /** Slices whose cheap (first) attempt was accepted outright — no rescue needed. */
  firstAttemptPasses: number
  /** Total dispatch calls across all slices, including every rescue hop. */
  totalAttempts: number
  /** totalAttempts / slicesDispatched — 1.0 means no slice ever needed a rescue. */
  attemptsPerSlice: number
  /** firstAttemptPasses / slicesDispatched — the escalation-rarity signal OL-9.4c surfaces. */
  firstPassRate: number
}

export interface SliceLoopResult {
  /** Always true — the loop always dispatches when called; kept for a stable result shape. */
  engaged: boolean
  /** Per-slice outcomes, keyed by slice id (insertion order matches the input). */
  outcomes: SliceOutcome[]
  /** The execution waves (each inner array is a set of slice ids that ran in parallel). */
  waves: string[][]
  /** Double-pay totals for the net-savings receipt. */
  ledger: LedgerSnapshot
  /** First-pass/attempts telemetry (OL-9.4c) — data-only; the receipt layer renders it later. */
  telemetry: SliceLoopTelemetry
}

// ---------------------------------------------------------------------------
// Escalation tier ladder
// ---------------------------------------------------------------------------

/** Cheap → expensive ordering, mirrors allocation.ts TIER_RANK. */
const TIER_ORDER: EconTier[] = ["conductor", "executor", "reasoner", "oracle"]

/**
 * The tier a rejected slice escalates to — ONE hop up the capability ladder
 * executor → conductor → reasoner → oracle (user rule 2026-07-04: a failed
 * executor slice is rescued by the conductor first, ~10× cheaper than jumping
 * straight to the oracle). The oracle is the top of this ladder (the frontier
 * hatch OL-7.10 is a separate, flagged concern), so an oracle reject cannot
 * escalate and returns the same tier.
 *
 * @sem domain=routing role=allocator
 */
/** Ladder position per tier — used to enforce a slice's escalation ceiling (recon caps at conductor). */
const LADDER_RANK: Record<EconTier, number> = { executor: 0, conductor: 1, reasoner: 2, oracle: 3 }

export function escalateTier(tier: EconTier): EconTier {
  switch (tier) {
    case "executor":
      return "conductor"
    case "conductor":
      return "reasoner"
    case "reasoner":
      return "oracle"
    case "oracle":
      return "oracle"
  }
}

// ---------------------------------------------------------------------------
// Allocation → verifier-ladder rung mapping (the contract gap OL-7.3 closes)
// ---------------------------------------------------------------------------

/**
 * Map an allocation's requested verifier rung onto a concrete
 * `runVerifierLadder` input. The allocator emits one of sound|qe|judge; the
 * ladder runs sound → behavior gate → extraRung → QE. The mapping:
 *  - the sound rung + behavior gate ALWAYS run (behavior monitoring is F15, every slice);
 *  - `sound`  → the slice's verifyCommands drive the sound rung (testable);
 *  - `qe`     → sound-if-applicable, then the QE self-consistency fallback;
 *  - `judge`  → sound-if-applicable, then the cross-model judge (as the ladder's
 *               extraRung), then QE as a last degrade if the judge can't decide.
 * The optional RM rung (deps.rmRung, OL-7.8a) is composed ahead of the judge into
 * the single extraRung slot (§4.6 ladder order) — RM first, judge on RM abstain.
 * verifyCommands are always offered when a runner exists — the ladder decides
 * applicability — so a real check is never skipped just because the cell is qe/judge.
 *
 * @sem domain=routing role=verify-ladder
 */
export function buildLadderInput(
  slice: LoopSlice,
  allocation: SliceAllocation,
  result: SliceDispatchResult,
  deps: SliceLoopDeps,
  previousCaseCount?: number,
): VerifierLadderInput {
  const commands: VerifyCommand[] = deps.runCommand ? [...(slice.verifyCommands ?? [])] : []
  // Never invoked when commands is empty (runSoundCheck short-circuits), so a
  // throwing default is a safe placeholder when no runner is injected.
  const runner: CommandRunner =
    deps.runCommand ??
    (async () => {
      throw new Error("slice-loop: no command runner injected")
    })

  const input: VerifierLadderInput = {
    spec: { commands },
    runner,
    trajectory: result.trajectory,
    ...(previousCaseCount !== undefined ? { previousCaseCount } : {}),
  }

  // The extension slot holds at most one rung, but two can apply on an untestable
  // slice: the optional RM (deps.rmRung) and the cross-model judge (for a `judge`
  // allocation). Compose them in ladder order — RM ahead of judge (§4.6) — so the
  // single slot runs RM first and falls through to the judge when it abstains.
  const judge =
    allocation.verification === "judge" && deps.judgeGenerate
      ? judgeRung({
          task: slice.prompt,
          output: result.text,
          wiring: slice.wiring,
          generate: deps.judgeGenerate,
        })
      : undefined
  const extraRung = composeExtraRungs(deps.rmRung, judge)
  if (extraRung) input.extraRung = extraRung

  if (deps.qeGenerate) {
    const qeGenerate = deps.qeGenerate
    input.qe = {
      conductorResult: { text: result.text },
      generate: () => qeGenerate(slice.id),
    }
  }

  return input
}

// ---------------------------------------------------------------------------
// Escalation brief (OL-2.2) — compiled failure evidence, never the transcript
// ---------------------------------------------------------------------------

/** Pull bounded, deterministic evidence lines out of a reject verdict — no transcript. */
function collectFailureEvidence(verdict: VerifierVerdict): FailureEvidence {
  const evidence: string[] = []
  for (const f of verdict.sound.failures) {
    const detail = (f.stderr || f.stdout || "").trim().split("\n").slice(0, 3).join(" ").slice(0, 200)
    evidence.push(`${f.command.kind} \`${f.command.command}\` exited ${f.exitCode}${detail ? `: ${detail}` : ""}`)
  }
  for (const flag of verdict.behavior.flags) {
    evidence.push(`behavior: ${flag.kind}${flag.detail ? ` — ${flag.detail}` : ""}`)
  }
  if (verdict.extra?.detail) evidence.push(`${verdict.extra.rung}: ${verdict.extra.detail}`)
  if (verdict.qe && verdict.qe.veto) evidence.push(`qe: ${verdict.qe.reason}`)
  return { rung: verdict.rung, verdict: verdict.reason, evidence: evidence.slice(0, 8), missing: verdict.missing }
}

/** Default MISSING line when a reject verdict somehow carries none (defensive backstop — the ladder synthesizes one on every reject path). */
const DEFAULT_MISSING_EVIDENCE =
  "MISSING: the verifier ladder did not name specific missing evidence for this reject."

/** Files the prior attempt already read (OL-9.4c), deduped in first-seen order — feeds the escalation brief's "already read" section so a rescue trusts the digest instead of re-reading. */
function readFilesFromTrajectory(attempt: SliceDispatchResult): string[] {
  const reads = attempt.trajectory.events.filter((e): e is FileReadEvent => e.kind === "file-read")
  return [...new Set(reads.map((e) => e.filePath))]
}

/** Char cap on the prior attempt's output carried into a rescue brief (mirrors UPSTREAM_OUTPUT_CHAR_CAP). */
const RESCUE_CONTEXT_CHAR_CAP = 6000

/**
 * Digest what the failed attempt already gathered — its findings text plus the
 * files/commands it touched — so a rescue CONTINUES the work instead of
 * restarting it. Without this, every ladder hop re-explored the repo from zero
 * (observed live 2026-07-04: one recon slice re-read the same files across
 * four fresh sessions, one per hop).
 */
function digestPriorAttempt(attempt: SliceDispatchResult): string {
  const parts: string[] = []
  const text = attempt.text.trim()
  if (text) {
    parts.push(text.length > RESCUE_CONTEXT_CHAR_CAP ? `${text.slice(0, RESCUE_CONTEXT_CHAR_CAP)}\n…[truncated]` : text)
  }
  const edits = attempt.trajectory.events.filter((e): e is FileEditEvent => e.kind === "file-edit")
  const commands = attempt.trajectory.events.filter((e): e is CommandEvent => e.kind === "command")
  if (edits.length > 0) parts.push(`Files already edited: ${[...new Set(edits.map((e) => e.filePath))].join(", ")}`)
  if (commands.length > 0)
    parts.push(`Commands already run: ${commands.map((c) => c.command).slice(0, 10).join(" · ").slice(0, 500)}`)
  return parts.join("\n\n")
}

/**
 * Compile the escalation brief the higher tier sees instead of the transcript
 * (OL-2.2). The rejecting verdict's "MISSING: ..." line (OL-9.4c) is folded
 * into the question as the rescue's stated objective, and — when the prior
 * attempt read files — an "already read" list follows the prior-attempt
 * digest so the rescue trusts it instead of re-reading (OL-9.4c). When the
 * containment bracket (U3) reverted the prior attempt's edits, the bounded
 * diff rides along as a clearly labeled REVERTED section — context about a
 * failed approach, never code to keep.
 */
function buildEscalationBrief(
  slice: LoopSlice,
  allocation: SliceAllocation,
  verdict: VerifierVerdict,
  priorAttempt?: SliceDispatchResult,
  revertedDiff?: string,
): OracleBrief {
  const missing = verdict.missing ?? DEFAULT_MISSING_EVIDENCE
  const brief = compileBrief({
    problem: slice.prompt,
    question: `The cheaper ${allocation.tier} attempt was rejected at verification. Produce a correct result that passes the same checks. Your objective: ${missing}`,
    outputShape: slice.outputShape ?? "The corrected result for this slice.",
    slices: slice.wiring && slice.wiring.trim().length > 0 ? [slice.wiring] : [],
    attempts: [{ task: slice.prompt, status: "failure", error: verdict.reason }],
    failure: collectFailureEvidence(verdict),
  })

  const sections: string[] = []
  const digest = priorAttempt ? digestPriorAttempt(priorAttempt) : ""
  if (digest) sections.push(`## Prior attempt's gathered context (build on this — do NOT redo its recon)\n${digest}`)

  const reads = priorAttempt ? readFilesFromTrajectory(priorAttempt) : []
  if (reads.length > 0) {
    sections.push(
      `## Already read by the prior attempt — trust the digest above; re-read a file ONLY if the missing evidence requires quoting it\n${reads.join(", ")}`,
    )
  }

  if (revertedDiff) {
    sections.push(
      `## Prior attempt's diff — REVERTED\nThese edits have been REVERTED — the tree is clean; treat this as context about a failed approach, do not assume the edits exist.\n\n${revertedDiff}`,
    )
  }

  if (sections.length === 0) return brief
  return { ...brief, text: `${brief.text}\n\n${sections.join("\n\n")}` }
}

// ---------------------------------------------------------------------------
// Failure containment (U3, OL-ORCH-4.3) — bracket every editable attempt with
// a snapshot: track() before dispatch, restore() after a reject (before the
// next hop is built, or before the ladder gives up), the reverted diff riding
// along as bounded advice. Read-only (recon/verify) slices are never
// bracketed (isReadOnlySlice) — nothing to roll back; an absent `snapshot`
// dep makes every call here a no-op, leaving today's dirty-tree behavior
// byte-identical.
// ---------------------------------------------------------------------------

/** Char cap on the reverted diff carried into the escalation brief / failure result — bounded like the rest of the brief's evidence. */
const REVERTED_DIFF_CHAR_CAP = 4000

/** Snapshot the tree before a dispatch that can edit. No-op (undefined hash) for a read-only slice or an absent `snapshot` dep. */
async function trackBeforeAttempt(slice: LoopSlice, deps: SliceLoopDeps): Promise<string | undefined> {
  if (!deps.snapshot || isReadOnlySlice(slice.sliceType)) return undefined
  return deps.snapshot.track()
}

/**
 * Capture a rejected attempt's diff (bounded, truncation-marked) then restore
 * the tree to its pre-attempt hash — the next hop (or the failure result)
 * sees the failed diff as advice, never as residue. No-op when unbracketed
 * (no `snapshot` dep, or this attempt was never tracked — read-only slices).
 */
async function captureAndRestore(deps: SliceLoopDeps, hash: string | undefined): Promise<string | undefined> {
  if (!deps.snapshot || hash === undefined) return undefined
  const raw = await deps.snapshot.diff(hash)
  const diff = raw.length > REVERTED_DIFF_CHAR_CAP ? `${raw.slice(0, REVERTED_DIFF_CHAR_CAP)}\n…[truncated]` : raw
  await deps.snapshot.restore(hash)
  return diff
}

// ---------------------------------------------------------------------------
// DAG scheduling — topological waves (parallel within a wave, series across)
// ---------------------------------------------------------------------------

/**
 * Order slices into execution waves by their `deps`: each wave holds every
 * slice whose dependencies have all completed in earlier waves, so a wave's
 * slices are mutually independent and run in parallel while dependent slices
 * run in series (§5.1). Throws on an unknown dependency id or a dependency
 * cycle — a malformed DAG must fail loud, not silently drop a slice.
 *
 * @sem domain=routing role=orchestrator
 */
export function planWaves(slices: readonly LoopSlice[]): string[][] {
  const ids = new Set(slices.map((s) => s.id))
  for (const s of slices) {
    for (const d of s.deps ?? []) {
      if (!ids.has(d)) throw new Error(`slice-loop: slice "${s.id}" depends on unknown slice "${d}"`)
    }
  }

  const remaining = new Map(slices.map((s) => [s.id, new Set(s.deps ?? [])]))
  const done = new Set<string>()
  const waves: string[][] = []

  while (remaining.size > 0) {
    const wave = [...remaining.entries()].filter(([, deps]) => [...deps].every((d) => done.has(d))).map(([id]) => id)
    if (wave.length === 0) {
      throw new Error(`slice-loop: dependency cycle among slices [${[...remaining.keys()].join(", ")}]`)
    }
    for (const id of wave) {
      remaining.delete(id)
      done.add(id)
    }
    waves.push(wave)
  }

  return waves
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

function zeroTokens(): TurnTokens {
  return { input: 0, output: 0 }
}

// ---------------------------------------------------------------------------
// Per-slice + overall loop wall-clock budgets (OL-9.3e) — a frozen/wedged
// slice must fail loud, never hang until an outer kill (observed live: a
// frozen slice ran until a 30-minute outer timeout with nothing inside the
// loop bounding it).
// ---------------------------------------------------------------------------

/** Base wall-clock cap for a read-only (recon/verify) slice attempt, ms. Tunable. */
export const RECON_VERIFY_TIMEOUT_MS = 240_000
/** Base wall-clock cap for a mechanical/design slice attempt, ms — also the default for an untyped slice. Tunable. */
export const MECHANICAL_DESIGN_TIMEOUT_MS = 480_000
/** Multiplier applied to a slice's base cap for an escalation rescue hop — a higher tier may reason longer than the cheap tier it's rescuing. Tunable. */
export const ESCALATION_TIMEOUT_FACTOR = 1.5
/** Safety factor over the plan's summed per-slice caps for the whole loop's budget. Tunable. */
export const LOOP_BUDGET_FACTOR = 1.2

/**
 * Max total dispatch calls (the cheap attempt plus rescue hops) for a normal
 * (mechanical/design) slice — one cheap attempt plus at most ONE escalation
 * hop (OL-9.5d). Read-only (recon/verify) slices override this to 1 instead
 * (see `defaultMaxAttempts`): a failed verify there is information for the
 * parent, not grounds to re-run. Run-8 post-mortem: the un-capped ladder
 * re-ran identical work up to 4x per slice (8 briefs -> 62 runner sessions,
 * one "Apply the fix" dispatched 5x) because a reject alone carries no
 * diagnosis of what to change — laddering it further added no new signal.
 * Overridable per-run via `SliceLoopDeps.maxAttempts`. Tunable.
 */
export const MAX_SLICE_ATTEMPTS = 2

/** Default per-slice attempt cap (OL-9.5d): 1 for a read-only (recon/verify) slice — no ladder at all — `MAX_SLICE_ATTEMPTS` otherwise. */
function defaultMaxAttempts(slice: LoopSlice): number {
  return isReadOnlySlice(slice.sliceType) ? 1 : MAX_SLICE_ATTEMPTS
}

/** The base wall-clock cap for one slice attempt, before any escalation headroom. */
export function sliceTimeoutMs(sliceType?: SliceType): number {
  return isReadOnlySlice(sliceType) ? RECON_VERIFY_TIMEOUT_MS : MECHANICAL_DESIGN_TIMEOUT_MS
}

/**
 * The whole loop's wall-clock budget, derived from the plan: the sum of every
 * dispatched slice's own base cap (escalation headroom excluded — most slices
 * never escalate) times a small safety factor. Exceeding it fails the loop
 * loud (runSliceLoop throws) rather than letting a wedged wave wait
 * indefinitely — the same fail-loud philosophy as planWaves' cycle detection.
 */
export function overallLoopBudgetMs(slices: readonly LoopSlice[]): number {
  const total = slices.reduce((sum, s) => sum + sliceTimeoutMs(s.sliceType), 0)
  return Math.ceil(total * LOOP_BUDGET_FACTOR)
}

/** Thrown by the default timeout race when the wrapped promise doesn't settle before `ms` elapses. */
export class SliceTimeoutError extends Error {
  constructor(public readonly ms: number) {
    super(`timed out after ${ms}ms`)
    this.name = "SliceTimeoutError"
  }
}

/** Real-clock timeout race — the default for both `dispatchTimeout` and `loopTimeout`; a test injects a synchronous double instead of waiting on a real timer. */
async function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SliceTimeoutError(ms)), ms)
        const unrefable = timer as unknown as { unref?: () => void }
        unrefable.unref?.()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** One dispatch call's outcome: either the tier's result, or — on a wall-clock exhaustion — a synthetic reject verdict carrying timeout evidence + a MISSING line (OL-9.3e, OL-9.4c) that feeds the normal escalation/fail path. Never throws for a timeout. */
async function dispatchWithBudget(
  dispatch: SliceLoopDeps["dispatch"],
  dispatchTimeout: NonNullable<SliceLoopDeps["dispatchTimeout"]>,
  req: SliceDispatchRequest,
  timeoutMs: number,
): Promise<{ result: SliceDispatchResult; verdict?: VerifierVerdict }> {
  try {
    return { result: await dispatchTimeout(dispatch(req), timeoutMs) }
  } catch (err) {
    if (!(err instanceof SliceTimeoutError)) throw err
    return {
      result: { text: "", trajectory: { events: [] } },
      verdict: {
        accepted: false,
        rung: "timeout",
        reason: `slice "${req.sliceId}" exceeded its ${timeoutMs}ms wall-clock budget on the ${req.tier} tier — failed loud, no silent hang`,
        sound: { rung: "sound", pass: false, failures: [], applicable: false },
        behavior: { suspicious: false, flags: [] },
        missing: `MISSING: a completed dispatch within the ${timeoutMs}ms wall-clock budget on the ${req.tier} tier producing real output — not a timeout.`,
      },
    }
  }
}

/**
 * Assemble the pre-dispatch `EvalContext` (U4, §4.2) from what the loop
 * already knows about a slice at a given dispatch/re-dispatch point: no
 * triage read at this seam (triage lives upstream of the loop), no risk
 * notes threaded in yet, verify strength from the slice's own testStrength +
 * verifyCommands, containment availability from whether a snapshot dep was
 * injected, and the affinity/hysteresis fields the caller supplies per call
 * site (first dispatch vs. escalation re-entry).
 */
function buildEvalContext(
  slice: LoopSlice,
  deps: SliceLoopDeps,
  history: EvalContext["history"],
  hysteresis: EvalContext["hysteresis"],
): EvalContext {
  return {
    sliceType: slice.sliceType,
    coupling: slice.coupling,
    testStrength: slice.testStrength,
    need: slice.need,
    risk: slice.risk,
    specBacked: slice.specBacked,
    triage: {},
    history,
    riskNotes: [],
    verifyStrength: {
      hasVerifyCommands: (slice.verifyCommands?.length ?? 0) > 0,
      testStrength: slice.testStrength,
    },
    containmentAvailable: !!deps.snapshot,
    venue: {
      requestingTier: "conductor",
      sameFilesInScope: false,
      readOnlyParallel: isReadOnlySlice(slice.sliceType),
    },
    hysteresis,
  }
}

/** Run one slice: evaluate (allocate → tier/venue) → cheap dispatch → verify → (accept | climb the ladder, re-evaluating + re-verifying each hop). Each dispatch is wall-clock capped per the slice's type (OL-9.3e). */
async function runSlice(
  slice: LoopSlice,
  deps: SliceLoopDeps,
  ledger: DoublePayLedger,
): Promise<SliceOutcome> {
  const allocate = deps.allocate ?? allocateSlice
  const tierModel = deps.tierModel ?? tierModelRef
  const dispatchTimeout = deps.dispatchTimeout ?? raceTimeout
  const baseTimeoutMs = sliceTimeoutMs(slice.sliceType)
  const maxAttempts = (deps.maxAttempts ?? defaultMaxAttempts)(slice)

  // Pre-dispatch evaluation (U4, §4.2): evaluate() delegates the base tier to
  // allocate() (pins/ceilings/design floor/testable invariant unchanged) and
  // only adds the sanctioned de-escalation + venue/hysteresis rules on top —
  // a strict superset (evaluator.test.ts's fixture-equality regression test).
  const base = allocate({
    sliceType: slice.sliceType,
    coupling: slice.coupling,
    testStrength: slice.testStrength,
    need: slice.need,
    risk: slice.risk,
    specBacked: slice.specBacked,
  })
  const firstVerdict = evaluate(buildEvalContext(slice, deps, { attempts: 0 }, { signalDelta: false }))
  deps.onEvaluation?.({ sliceId: slice.id, tier: firstVerdict.tier, venue: firstVerdict.venue, reasons: firstVerdict.reasons })
  const allocation: SliceAllocation = { tier: firstVerdict.tier, verification: base.verification, reason: firstVerdict.reasons.join("; ") }

  let currentHash = await trackBeforeAttempt(slice, deps)
  const cheapAttempt = await dispatchWithBudget(
    deps.dispatch,
    dispatchTimeout,
    { sliceId: slice.id, tier: allocation.tier, prompt: slice.prompt, escalated: false, sliceType: slice.sliceType },
    baseTimeoutMs,
  )
  const cheap = cheapAttempt.result

  // Behavior-monitor exemptions ride on the trajectory: a declared test slice
  // permits test-file edits; a read-only slice (recon/verify) turns on the
  // bash-write guard over its command events (OL-9.3b).
  const trajectory: SliceTrajectory = {
    ...cheap.trajectory,
    ...(slice.isTestSlice ? { isTestSlice: true } : {}),
    isReadOnlySlice: isReadOnlySlice(slice.sliceType),
  }
  const verdict =
    cheapAttempt.verdict ?? (await runVerifierLadder(buildLadderInput(slice, allocation, { ...cheap, trajectory }, deps)))

  if (verdict.accepted) {
    return {
      id: slice.id,
      // An untestable-slice accept (verdict.unverified, OL-9.5d) still needs
      // to surface as unverified downstream — it wasn't actually checked.
      state: verdict.unverified ? "unverified" : "accepted",
      tier: allocation.tier,
      verification: allocation.verification,
      allocation,
      verdict,
      output: cheap.text,
      attempts: 1,
    }
  }

  // --- Rejected → climb the ladder up to `maxAttempts` total dispatches
  // (OL-9.5d), each rescue RE-VERIFIED before it is trusted — a conductor
  // rescue cannot be blind-accepted the way the old straight-to-oracle hop
  // was. The ladder no longer climbs unconditionally to the oracle: run-8
  // showed an un-capped ladder re-running identical work up to 4x per slice
  // (8 briefs -> 62 runner sessions, one "Apply the fix" dispatched 5x) with
  // no new signal, because a reject alone carries no diagnosis of what to
  // change. `maxAttempts` (`defaultMaxAttempts` unless overridden) caps this
  // at MAX_SLICE_ATTEMPTS (2) for a normal slice — one cheap attempt plus at
  // most ONE escalation hop — and at 1 (no ladder at all) for a read-only
  // (recon/verify) slice, where a failed verify is information for the
  // parent, not grounds to re-run. Exhausting either the tier ceiling or the
  // attempt cap accepts the last attempt flagged unverified (the frontier
  // hatch OL-7.10 is out of scope).
  let atTier = allocation.tier
  let attempt = cheap
  let attemptVerdict = verdict
  let escalation: SliceOutcome["escalation"]
  let attempts = 1

  // Ladder ceiling: recon is read-only investigation — it never deserves an
  // oracle-priced rescue. In practice this is now subsumed by the read-only
  // maxAttempts=1 cap below (recon/verify never reach a second dispatch), but
  // it stays as the tier-side backstop for a caller-overridden maxAttempts.
  const ceiling: EconTier = slice.sliceType === "recon" ? "conductor" : "oracle"

  for (;;) {
    const higher = escalateTier(atTier)
    if (higher === atTier || LADDER_RANK[higher] > LADDER_RANK[ceiling] || attempts >= maxAttempts) {
      // Ladder exhaustion: no further hop is coming, so the reverted diff (if
      // this attempt was bracketed) travels in the failure result itself
      // instead of a next brief — the turn owner decides from here (U3).
      const revertedDiff = await captureAndRestore(deps, currentHash)
      return {
        id: slice.id,
        state: "unverified",
        tier: allocation.tier,
        verification: allocation.verification,
        allocation,
        verdict: attemptVerdict,
        output: attempt.text,
        attempts,
        ...(escalation ? { escalation } : {}),
        ...(revertedDiff !== undefined ? { revertedDiff } : {}),
      }
    }

    // Escalation provenance (U3): one line per hop naming why it escalated —
    // closes the live-fire decode gap where INFO logs never showed this.
    deps.onProvenance?.({ sliceId: slice.id, fromTier: atTier, toTier: higher, rungReason: attemptVerdict.reason })

    // Pre-dispatch re-evaluation on escalation re-entry (U4, §4.2): a rung
    // reject IS a signal delta. Observational at this hop — the ladder's own
    // tier bump (`higher`, above) still governs the actual escalated dispatch
    // tier; this call reports what the evaluator would decide, for the
    // receipt's evaluator drilldown (U6).
    const reEvalVerdict = evaluate(
      buildEvalContext(
        slice,
        deps,
        { attempts, lastRejectReason: attemptVerdict.reason },
        { lastTier: atTier, signalDelta: true },
      ),
    )
    deps.onEvaluation?.({ sliceId: slice.id, tier: reEvalVerdict.tier, venue: reEvalVerdict.venue, reasons: reEvalVerdict.reasons })

    // Capture the rejected attempt's diff BEFORE restoring, so the brief can
    // carry it as advice; restore returns the tree to clean before the next
    // (higher-tier) hop is dispatched (U3, OL-ORCH-1.6/4.3).
    const revertedDiff = await captureAndRestore(deps, currentHash)
    const brief = buildEscalationBrief(slice, allocation, attemptVerdict, attempt, revertedDiff)
    const escalatedTimeoutMs = Math.ceil(baseTimeoutMs * ESCALATION_TIMEOUT_FACTOR)
    currentHash = await trackBeforeAttempt(slice, deps)
    const escalatedAttempt = await dispatchWithBudget(
      deps.dispatch,
      dispatchTimeout,
      { sliceId: slice.id, tier: higher, prompt: brief.text, escalated: true, sliceType: slice.sliceType },
      escalatedTimeoutMs,
    )
    const escalated = escalatedAttempt.result
    attempts += 1

    const record = recordEscalation({
      turnId: slice.id,
      cheap: {
        model: attempt.usage?.model ?? tierModel(atTier),
        cost: attempt.usage?.cost ?? 0,
        tokens: attempt.usage?.tokens ?? zeroTokens(),
      },
      oracle: {
        model: escalated.usage?.model ?? tierModel(higher),
        cost: escalated.usage?.cost ?? 0,
        tokens: escalated.usage?.tokens ?? zeroTokens(),
      },
      emit: deps.onEscalation,
    })
    ledger.add(record)

    const escalatedTrajectory: SliceTrajectory = {
      ...escalated.trajectory,
      ...(slice.isTestSlice ? { isTestSlice: true } : {}),
      isReadOnlySlice: isReadOnlySlice(slice.sliceType),
    }
    // The prior attempt's case count travels into the re-verify so a rescue
    // that "fixes" the suite by shrinking it rejects the sound rung (B6).
    const priorCaseCount = attemptVerdict.sound.caseCount
    attemptVerdict =
      escalatedAttempt.verdict ??
      (await runVerifierLadder(
        buildLadderInput(slice, allocation, { ...escalated, trajectory: escalatedTrajectory }, deps, priorCaseCount),
      ))
    escalation = { tier: higher, brief, result: escalated, record }
    atTier = higher
    attempt = escalated

    if (attemptVerdict.accepted) {
      return {
        id: slice.id,
        // Mirrors the cheap-attempt branch: an untestable-slice accept on the
        // rescue hop is still unverified, not a genuine escalated pass.
        state: attemptVerdict.unverified ? "unverified" : "escalated",
        tier: allocation.tier,
        verification: allocation.verification,
        allocation,
        verdict: attemptVerdict,
        output: attempt.text,
        escalation,
        attempts,
      }
    }
  }
}

/** Per-upstream-result cap inside a dependent slice's prompt — digests, not transcripts. */
const UPSTREAM_OUTPUT_CHAR_CAP = 6000

/**
 * Thread dependency outputs into a dependent slice's prompt. Without this the
 * design-emits-the-patch contract is dead on arrival: the implement slice would
 * never see the patch the design slice produced. Outputs are capped per
 * upstream slice so a chatty dependency cannot blow the child's context.
 *
 * @sem domain=routing role=digest
 */
export function withUpstreamContext(slice: LoopSlice, outcomes: ReadonlyMap<string, SliceOutcome>): LoopSlice {
  const upstream = (slice.deps ?? [])
    .map((d) => outcomes.get(d))
    .filter((o): o is SliceOutcome => o !== undefined && o.output.trim().length > 0)
  if (upstream.length === 0) return slice
  const sections = upstream.map((o) => {
    const body =
      o.output.length > UPSTREAM_OUTPUT_CHAR_CAP ? `${o.output.slice(0, UPSTREAM_OUTPUT_CHAR_CAP)}\n…[truncated]` : o.output
    return `### ${o.id} (${o.state})\n${body}`
  })
  return {
    ...slice,
    prompt: [slice.prompt, "## Upstream slice results (your inputs — build on these, do not redo them)", ...sections].join(
      "\n\n",
    ),
  }
}

/**
 * Run a decomposition DAG through the execute-cheap-then-verify loop (OL-7.3).
 * Unconditional — slices run in topological waves (parallel within a wave),
 * each cheap-first then verified, escalating only failures. Dependent slices
 * receive their dependencies' outputs inline (withUpstreamContext). The whole
 * run is bounded by an overall budget derived from the plan (OL-9.3e,
 * `overallLoopBudgetMs`); exhaustion THROWS — fail loud rather than let a
 * wedged wave wait indefinitely, the same philosophy as planWaves' cycle
 * detection — while a single slice's own timeout instead feeds the normal
 * escalation/fail path (see `runSlice`). Also returns first-pass/attempts
 * telemetry (OL-9.4c) next to the double-pay ledger, data-only for a future
 * receipt to render escalation rate.
 *
 * @sem domain=routing role=orchestrator
 */
export async function runSliceLoop(
  slices: readonly LoopSlice[],
  deps: SliceLoopDeps,
): Promise<SliceLoopResult> {
  const ledger = new DoublePayLedger()

  const waves = planWaves(slices)
  const byId = new Map(slices.map((s) => [s.id, s]))
  const outcomes = new Map<string, SliceOutcome>()
  const loopTimeout = deps.loopTimeout ?? raceTimeout
  const loopBudgetMs = overallLoopBudgetMs(slices)

  const runWaves = async (): Promise<void> => {
    for (const wave of waves) {
      const settled = await Promise.all(
        wave.map((id) => runSlice(withUpstreamContext(byId.get(id)!, outcomes), deps, ledger)),
      )
      for (const outcome of settled) outcomes.set(outcome.id, outcome)
    }
  }

  try {
    await loopTimeout(runWaves(), loopBudgetMs)
  } catch (err) {
    if (err instanceof SliceTimeoutError) {
      throw new Error(
        `slice-loop: overall budget of ${loopBudgetMs}ms exceeded — ${outcomes.size}/${slices.length} slice(s) completed before the timeout (never wait on a wedged wave indefinitely)`,
      )
    }
    throw err
  }

  // Preserve input order in the flat outcome list for a stable trace.
  const outcomeList = slices.map((s) => outcomes.get(s.id)!)
  const slicesDispatched = outcomeList.length
  const firstAttemptPasses = outcomeList.filter((o) => o.attempts === 1).length
  const totalAttempts = outcomeList.reduce((sum, o) => sum + o.attempts, 0)
  const telemetry: SliceLoopTelemetry = {
    slicesDispatched,
    firstAttemptPasses,
    totalAttempts,
    attemptsPerSlice: slicesDispatched > 0 ? totalAttempts / slicesDispatched : 0,
    firstPassRate: slicesDispatched > 0 ? firstAttemptPasses / slicesDispatched : 0,
  }

  return {
    engaged: true,
    outcomes: outcomeList,
    waves,
    ledger: ledger.snapshot(),
    telemetry,
  }
}
