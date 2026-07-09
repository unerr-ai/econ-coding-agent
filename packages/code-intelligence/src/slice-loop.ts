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
 * reject works the tier ladder, capped at a per-slice `maxAttempts` total
 * dispatches (one rescue hop for a normal slice, none at all for a read-only
 * recon/verify slice; run-8 post-mortem: an un-capped ladder re-ran identical
 * work up to 4x per slice with no new signal) with a compiled failure brief
 * per hop (brief.ts), re-verifying each rescue and recording every discarded
 * attempt as double-pay (double-pay.ts). A rejected attempt first squeezes
 * the SAME tier while its failure signature keeps changing (M2,
 * SAME_TIER_RETRY_BUDGET) and climbs only once it stalls, bounded by `maxClimbs`
 * for every slice alike; consequence (high coupling or risk — the allocator's
 * tiebreak) no longer buys extra generator climbs (it routes the judge verifier
 * instead, allocation.ts) — a critical slice we still cannot verify soft-settles
 * LOUDLY for review (M3) rather than force-authoring at the oracle. Slices run
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
 * drilldown (U6). A green verdict on a prior-flagged (ambiguous/hard) slice
 * still passes through the posterior-uncertainty gate (task #48,
 * posterior-uncertainty.ts): a high-uncertainty signal (from the dispatch's
 * own logprobs, or the optional `confidenceGenerate` fallback) earns ONE
 * extra generator escalation even though verification already passed,
 * reported via `onProvenance` as `"posterior-uncertain-review"` — every
 * unflagged or confident slice accepts on green unchanged. Slice relations
 * are derived, never extracted (P6): before waves, an optional `editScopeOf`
 * probe predicts each editing slice's file scope — two same-wave slices with
 * overlapping scopes serialize via an implicit dep (P6b; overlap only ever
 * ADDS ordering, a declared dep is never dropped, and the edge is recorded
 * in `telemetry.implicitDeps` so a trace shows why they serialized), and the
 * same scope intersected with `deps.parentScope` feeds the venue rule's
 * `sameFilesInScope` (P6c — the venue verdict stays telemetry-only via
 * `onEvaluation`; dispatch still always spawns a child). A dependency
 * (declared or implicit) that settles terminal-failed — ladder exhausted
 * with a rejecting verdict, never the OL-9.5d accepted-unverified — blocks
 * its dependents instead of dispatching them (P6a): they settle `"blocked"`
 * with `blockedBy`, the block cascades transitively, and the count feeds
 * re-decomposition as coverage-gap input rather than vanishing silently.
 *
 * @sem domain=routing role=orchestrator
 */

import {
  allocateSlice,
  ALLOCATION_RISK_TIEBREAK,
  type SliceAllocation,
  type SliceAllocationInput,
  type SliceType,
  type Coupling,
  type TestStrength,
  type SliceHardness,
  type SliceAmbiguity,
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
import {
  sliceTransition,
  initialSliceState,
  isSliceTerminal,
  type SliceMachineState,
  type SliceTransitionCtx,
  type SliceVerdictLike,
} from "./orchestration-fsm.js"
import { posteriorEscalation, signalFromConfidence, type UncertaintySignal } from "./posterior-uncertainty.js"

// ---------------------------------------------------------------------------
// Slice + dispatch types
// ---------------------------------------------------------------------------

/**
 * One node in the decomposition DAG the loop executes. `coupling`/`testStrength`
 * come pre-tagged from the OL-7.9 probes at decompose time (the loop does not
 * re-probe — that is the caller's job); `verifyCommands` is the sound-rung spec
 * for a testable slice, and `probeCommand` is its optional pinned red→green
 * reproduction (verifier.ts's separate probe rung); `wiring` is the
 * deterministic graph facts already woven for this slice (OL-7.7). All
 * allocation-facing fields are optional so a partially-tagged slice still
 * allocates defensively (allocation.ts).
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
  /** OL-3 code-structural risk (0–100); an in-cell tiebreaker only, and the M3 escalation-floor criticality signal (isCritical). */
  risk?: number
  /** True when this slice depends on a design slice whose output carries the concrete patch (design-emits-the-patch). */
  specBacked?: boolean
  /** Arming-judge task difficulty (hardness); a GENERATOR-tier lever — `hard` floors this slice's author at the reasoner (allocation.ts difficulty floor). */
  hardness?: SliceHardness
  /** Arming-judge task ambiguity; a GENERATOR-tier lever that overrides the testable clamp (a sound check can't catch a misinterpretation). */
  ambiguity?: SliceAmbiguity
  /** Sound-rung commands (typecheck / test / lint) for a testable slice. */
  verifyCommands?: readonly VerifyCommand[]
  /** A pinned reproduction that must transition red→green (verifier.ts's separate probe rung) — threaded into the ladder's spec alongside `verifyCommands`. */
  probeCommand?: VerifyCommand
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

/** What a dispatch returns: the output, the trajectory to monitor, usage for double-pay, and (task #48) an optional posterior-uncertainty signal. */
export interface SliceDispatchResult {
  /** The tier's final text output. */
  text: string
  /** What the tier touched (file edits + commands) — fed to the behavior monitor (F15). */
  trajectory: SliceTrajectory
  /** Cost/tokens for the honest net receipt; when absent the loop records zeros + the tier's model. */
  usage?: { model: string; cost: number; tokens: TurnTokens }
  /**
   * Host-populated posterior-uncertainty reading (task #48/#56) when logprobs
   * were available for this dispatch — e.g. `signalFromPerplexity(perplexityFromLogprobs(answerChannelTokens(...)))`.
   * Absent ⇒ the accept-on-green gate falls back to `deps.confidenceGenerate` (if injected) or skips the gate entirely.
   */
  uncertainty?: UncertaintySignal
}

/**
 * Everything the loop depends on from the outside world. All optional deps
 * degrade safely: no runner ⇒ sound rung inapplicable; no judge ⇒ judge rung
 * skipped; no QE sampler ⇒ QE fallback skipped; no confidenceGenerate ⇒ the
 * posterior-uncertainty gate's verbalized fallback skipped (task #48); no
 * dispatchTimeout/loopTimeout ⇒ a real wall-clock race (OL-9.3e). `dispatch`
 * is the only required dep — it is the sub-agent spawn (live: the task tool;
 * tests: a double).
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
  /**
   * Verbalized self-confidence fallback (task #48's posterior-uncertainty gate):
   * asks the generator to self-report confidence (0 = none, 1 = certain) in its
   * own just-accepted answer. Consulted ONLY when a green cheap attempt has no
   * `result.uncertainty` AND the slice was prior-flagged (ambiguous/hard).
   * Absent ⇒ that fallback is skipped — a prior-flagged green slice with no
   * logprob signal and no confidence dep accepts unchanged.
   */
  confidenceGenerate?: (sliceId: string) => Promise<number>
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
  /**
   * Graph-predicted file scope of an EDITING slice (P6b/P6c) — read-only
   * recon/verify slices are never probed (`isReadOnlySlice`). Two consumers:
   * same-wave editing slices with intersecting scopes gain an implicit
   * serializing dep (P6b), and the scope's intersection with `parentScope`
   * feeds the venue rule's `sameFilesInScope` (P6c). Absent ⇒ both stay off —
   * the wave plan is byte-identical and `sameFilesInScope` stays false.
   */
  editScopeOf?: (slice: LoopSlice) => Promise<ReadonlySet<string>> | ReadonlySet<string>
  /** The tier of the thread requesting this loop — the venue rule's `requestingTier` (P6c). Defaults to "conductor", the production caller. */
  requestingTier?: EconTier
  /** Files the parent thread already has in scope (P6c): a slice whose predicted scope (`editScopeOf`) intersects it evaluates `sameFilesInScope: true`. Absent — or no probe — ⇒ false. */
  parentScope?: ReadonlySet<string>
}

// ---------------------------------------------------------------------------
// Per-slice outcome + loop result
// ---------------------------------------------------------------------------

/** Terminal state of one slice in the machine. */
export type SliceState =
  | "accepted" // cheap attempt passed verification
  | "escalated" // cheap attempt rejected → climbed the ladder; a higher tier's re-verified output accepted
  | "unverified" // rejected but already at the top tier (no higher tier / hatch off) — accepted with a warning
  | "blocked" // never dispatched (P6a): a dependency settled terminal-failed, or was itself blocked — see `blockedBy`

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
  /** Present only when state is "blocked" (P6a): the dependency ids — declared or P6b-implicit — that settled terminal-failed (or were themselves blocked) and stopped this slice from dispatching. */
  blockedBy?: string[]
}

/** One P6b serialization edge: `sliceId` gained an implicit dep on `dependsOn` because their predicted edit scopes shared `overlap` — the trace record for why two would-be-parallel slices ran in series. */
export interface ImplicitScopeDep {
  sliceId: string
  dependsOn: string
  overlap: readonly string[]
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
  /** Slices never dispatched because a dependency settled terminal-failed (P6a) — each appears in outcomes as state "blocked"; re-decomposition counts them as coverage gaps. */
  blocked: number
  /** P6b implicit serialization edges added by the scope-overlap check. Always empty without an `editScopeOf` probe. */
  implicitDeps: readonly ImplicitScopeDep[]
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

/**
 * A high-consequence slice — high coupling, or risk above the allocator's
 * tiebreak (`ALLOCATION_RISK_TIEBREAK`). Consequence NEVER buys generator climbs
 * (blast-radius routes the judge verifier in allocation.ts, not the author); this
 * flag's only job is to mark an unverifiable settle as LOUD-for-review (M3) rather
 * than a silent accept. Read-only (recon/verify) slices are excluded by the caller.
 *
 * @sem domain=routing role=allocator
 */
function isCritical(slice: LoopSlice): boolean {
  return slice.coupling === "high" || (slice.risk ?? 0) > ALLOCATION_RISK_TIEBREAK
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
 * `slice.probeCommand` (if set) rides along on `spec.probeCommand` untouched —
 * the ladder's separate probe rung, orthogonal to this rung mapping.
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
    spec: { commands, ...(slice.probeCommand ? { probeCommand: slice.probeCommand } : {}) },
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
// Same-tier squeeze retry (M2) — a rejected attempt retries the SAME tier
// while its failure signature is still converging, and climbs only on stall.
// ---------------------------------------------------------------------------

/** A reject verdict's identity for squeeze/stall comparison: same rung + same MISSING line means no new information surfaced. */
function verdictSignature(verdict: VerifierVerdict): string {
  return `${verdict.rung}|${verdict.missing ?? ""}`
}

/**
 * One rescue hop: build the escalation brief from the rejected attempt (the
 * EXISTING `buildEscalationBrief` path — a same-tier squeeze retry (M2)
 * carries the same rejected-diff-as-advice brief a tier climb does), dispatch
 * `targetTier` (equal to `atTier` for a squeeze retry, higher for a climb),
 * re-verify, and record the discarded attempt as double-pay. Shared by the
 * squeeze-retry and climb paths in `runSlice` so both go through one
 * dispatch/verify/ledger path — the only difference is the target tier and
 * the provenance reason.
 */
async function dispatchRescueHop(args: {
  slice: LoopSlice
  deps: SliceLoopDeps
  ledger: DoublePayLedger
  allocation: SliceAllocation
  atTier: EconTier
  targetTier: EconTier
  attempt: SliceDispatchResult
  attemptVerdict: VerifierVerdict
  currentHash: string | undefined
  baseTimeoutMs: number
  dispatchTimeout: NonNullable<SliceLoopDeps["dispatchTimeout"]>
  tierModel: (tier: EconTier) => string
  attempts: number
  sameFilesInScope: boolean
}): Promise<{
  result: SliceDispatchResult
  verdict: VerifierVerdict
  escalation: NonNullable<SliceOutcome["escalation"]>
  currentHash: string | undefined
}> {
  const { slice, deps, ledger, allocation, atTier, targetTier, attempt, attemptVerdict, baseTimeoutMs, dispatchTimeout, tierModel, attempts, sameFilesInScope } = args
  const squeeze = targetTier === atTier

  // Escalation provenance (U3): one line per hop naming why it moved — closes
  // the live-fire decode gap where INFO logs never showed this. A squeeze
  // retry is marked distinctly (fromTier === toTier + a "squeeze-retry"
  // reason prefix) so the trace shows max-out-the-tier vs a real climb.
  deps.onProvenance?.({
    sliceId: slice.id,
    fromTier: atTier,
    toTier: targetTier,
    rungReason: squeeze ? `squeeze-retry: ${attemptVerdict.reason}` : attemptVerdict.reason,
  })

  // Pre-dispatch re-evaluation on escalation re-entry (U4, §4.2): a rung
  // reject IS a signal delta. Observational at this hop — `targetTier` still
  // governs the actual dispatch tier; this call reports what the evaluator
  // would decide, for the receipt's evaluator drilldown (U6).
  const reEvalVerdict = evaluate(
    buildEvalContext(slice, deps, { attempts, lastRejectReason: attemptVerdict.reason }, { lastTier: atTier, signalDelta: true }, sameFilesInScope),
  )
  deps.onEvaluation?.({ sliceId: slice.id, tier: reEvalVerdict.tier, venue: reEvalVerdict.venue, reasons: reEvalVerdict.reasons })

  // Capture the rejected attempt's diff BEFORE restoring, so the brief can
  // carry it as advice; restore returns the tree to clean before the next
  // hop is dispatched (U3, OL-ORCH-1.6/4.3).
  const revertedDiff = await captureAndRestore(deps, args.currentHash)
  const brief = buildEscalationBrief(slice, allocation, attemptVerdict, attempt, revertedDiff)
  const hopTimeoutMs = Math.ceil(baseTimeoutMs * ESCALATION_TIMEOUT_FACTOR)
  const currentHash = await trackBeforeAttempt(slice, deps)
  const dispatched = await dispatchWithBudget(
    deps.dispatch,
    dispatchTimeout,
    { sliceId: slice.id, tier: targetTier, prompt: brief.text, escalated: true, sliceType: slice.sliceType },
    hopTimeoutMs,
  )
  const hopResult = dispatched.result

  const record = recordEscalation({
    turnId: slice.id,
    cheap: {
      model: attempt.usage?.model ?? tierModel(atTier),
      cost: attempt.usage?.cost ?? 0,
      tokens: attempt.usage?.tokens ?? zeroTokens(),
    },
    oracle: {
      model: hopResult.usage?.model ?? tierModel(targetTier),
      cost: hopResult.usage?.cost ?? 0,
      tokens: hopResult.usage?.tokens ?? zeroTokens(),
    },
    emit: deps.onEscalation,
  })
  ledger.add(record)

  const hopTrajectory: SliceTrajectory = {
    ...hopResult.trajectory,
    ...(slice.isTestSlice ? { isTestSlice: true } : {}),
    isReadOnlySlice: isReadOnlySlice(slice.sliceType),
  }
  // The prior attempt's case count travels into the re-verify so a rescue
  // that "fixes" the suite by shrinking it rejects the sound rung (B6).
  const priorCaseCount = attemptVerdict.sound.caseCount
  const hopVerdict =
    dispatched.verdict ??
    (await runVerifierLadder(buildLadderInput(slice, allocation, { ...hopResult, trajectory: hopTrajectory }, deps, priorCaseCount)))

  return {
    result: hopResult,
    verdict: hopVerdict,
    escalation: { tier: targetTier, brief, result: hopResult, record },
    currentHash,
  }
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

/**
 * P6b — scope-overlap serialization: two slices that would run in the same
 * wave with intersecting predicted edit scopes gain an implicit dep from the
 * later slice (input order) to the earlier one, turning "no concurrent
 * same-file edits" from prompt discipline into a computed fact. Overlap only
 * ever ADDS ordering — declared deps are merged, never dropped (they carry
 * information flow via `withUpstreamContext`, not just file ordering). Two
 * same-wave slices can never have a dependency path between them (a
 * topological-wave invariant), so the added later→earlier edges cannot form
 * a cycle: within a wave they are monotone in input order, and any
 * cross-wave path strictly increases the wave number — `planWaves`' cycle
 * detection stays as the backstop regardless. Iterates to a fixpoint because
 * re-planning after one serialization can push a third overlapping slice
 * into a shared wave it wasn't checked against. Read-only slices carry no
 * scope (never probed) and are exempt; an empty scope map returns the
 * declared-deps plan byte-identical.
 */
function serializeOverlappingScopes(
  slices: readonly LoopSlice[],
  scopes: ReadonlyMap<string, ReadonlySet<string>>,
): { planned: readonly LoopSlice[]; waves: string[][]; implicitDeps: ImplicitScopeDep[] } {
  const inputIndex = new Map(slices.map((s, i) => [s.id, i]))
  const implicit = new Map<string, Set<string>>()
  const implicitDeps: ImplicitScopeDep[] = []

  const withImplicit = (): LoopSlice[] =>
    slices.map((s) => {
      const extra = implicit.get(s.id)
      return extra?.size ? { ...s, deps: [...(s.deps ?? []), ...extra] } : s
    })

  let planned: readonly LoopSlice[] = withImplicit()
  let waves = planWaves(planned)
  if (scopes.size === 0) return { planned, waves, implicitDeps }

  for (;;) {
    let added = false
    for (const wave of waves) {
      const scoped = wave.filter((id) => scopes.has(id)).sort((a, b) => inputIndex.get(a)! - inputIndex.get(b)!)
      for (let i = 0; i < scoped.length; i++) {
        for (let j = i + 1; j < scoped.length; j++) {
          const earlier = scoped[i]!
          const later = scoped[j]!
          if (implicit.get(later)?.has(earlier)) continue
          const overlap = [...scopes.get(later)!].filter((f) => scopes.get(earlier)!.has(f))
          if (overlap.length === 0) continue
          let edges = implicit.get(later)
          if (!edges) implicit.set(later, (edges = new Set()))
          edges.add(earlier)
          implicitDeps.push({ sliceId: later, dependsOn: earlier, overlap })
          added = true
        }
      }
    }
    if (!added) break
    planned = withImplicit()
    waves = planWaves(planned)
  }

  return { planned, waves, implicitDeps }
}

/**
 * P6a — does a settled dependency block its dependents? Terminal-failed means
 * the ladder exhausted with a rejecting verdict: state "unverified" AND
 * `verdict.accepted === false` (the FSM's exhaustion settle). The OL-9.5d
 * accepted-flagged-unverified path shares the "unverified" state but carries
 * an ACCEPTING verdict — absence of a check is not evidence of failure, so it
 * never blocks. A blocked dep cascades.
 */
function blocksDependents(outcome: SliceOutcome): boolean {
  return outcome.state === "blocked" || (outcome.state === "unverified" && !outcome.verdict.accepted)
}

/**
 * The outcome of a slice that was never dispatched (P6a): a synthetic reject
 * verdict on rung "blocked" (the timeout-verdict precedent) naming the
 * blocking deps, zero attempts, and the base allocation it WOULD have run
 * on — `evaluate()`/`onEvaluation` never fire because nothing dispatches.
 */
function blockedOutcome(slice: LoopSlice, blockedBy: string[], deps: SliceLoopDeps): SliceOutcome {
  const allocation = (deps.allocate ?? allocateSlice)({
    sliceType: slice.sliceType,
    coupling: slice.coupling,
    testStrength: slice.testStrength,
    need: slice.need,
    risk: slice.risk,
    specBacked: slice.specBacked,
  })
  const depNoun = blockedBy.length === 1 ? "dependency" : "dependencies"
  return {
    id: slice.id,
    state: "blocked",
    tier: allocation.tier,
    verification: allocation.verification,
    allocation,
    verdict: {
      accepted: false,
      rung: "blocked",
      reason: `slice "${slice.id}" was not dispatched — ${depNoun} [${blockedBy.join(", ")}] settled terminal-failed or blocked`,
      sound: { rung: "sound", pass: false, failures: [], applicable: false },
      behavior: { suspicious: false, flags: [] },
      missing: `MISSING: a completed, non-failed result for ${depNoun} [${blockedBy.join(", ")}] — this slice never ran; re-decomposition owns it now.`,
    },
    output: "",
    attempts: 0,
    blockedBy,
  }
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
 * Runaway backstop on total dispatch calls (the cheap attempt plus every
 * squeeze retry and climb) for a normal (mechanical/design) slice — a fail-
 * safe ceiling, not the real control. The real controls are the
 * convergence-gated same-tier squeeze budget (`SAME_TIER_RETRY_BUDGET`, reset
 * on every climb), the non-critical climb depth (`maxClimbs` in `runSlice`),
 * the signature-stall guard (a repeated verdict signature climbs immediately
 * instead of spending more squeeze budget), and the tier ceiling — together
 * these already prevent the run-8 regression (an un-capped ladder re-running
 * identical work up to 4x per slice, 8 briefs -> 62 runner sessions) without
 * needing a tight flat cap, so this backstop can sit high. Read-only
 * (recon/verify) slices override this to 1 instead (see `defaultMaxAttempts`)
 * and never squeeze or climb regardless of this value: a failed verify there
 * is information for the parent, not grounds to re-run. Overridable per-run
 * via `SliceLoopDeps.maxAttempts`. Tunable.
 */
export const MAX_SLICE_ATTEMPTS = 8

/**
 * Max same-tier squeeze retries (M2) — per tier, reset on every climb —
 * before a still-converging-but-rejecting attempt is forced to climb
 * instead. This is the real squeeze control, independent of
 * `MAX_SLICE_ATTEMPTS` (a backstop) and of `maxClimbs` (the separate climb
 * depth in `runSlice`): a stalled squeeze must never deny a climb. Tunable.
 */
export const SAME_TIER_RETRY_BUDGET = 2

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
 * site (first dispatch vs. escalation re-entry). The venue inputs are real
 * (P6c): `requestingTier` from `deps.requestingTier` (defaulting to the
 * production caller, the conductor) and `sameFilesInScope` computed once per
 * slice in `runSliceLoop` from the `editScopeOf` scope ∩ `deps.parentScope`.
 */
function buildEvalContext(
  slice: LoopSlice,
  deps: SliceLoopDeps,
  history: EvalContext["history"],
  hysteresis: EvalContext["hysteresis"],
  sameFilesInScope: boolean,
): EvalContext {
  return {
    sliceType: slice.sliceType,
    coupling: slice.coupling,
    testStrength: slice.testStrength,
    need: slice.need,
    risk: slice.risk,
    specBacked: slice.specBacked,
    hardness: slice.hardness,
    ambiguity: slice.ambiguity,
    triage: {},
    history,
    riskNotes: [],
    verifyStrength: {
      hasVerifyCommands: (slice.verifyCommands?.length ?? 0) > 0,
      testStrength: slice.testStrength,
    },
    containmentAvailable: !!deps.snapshot,
    venue: {
      requestingTier: deps.requestingTier ?? "conductor",
      sameFilesInScope,
      readOnlyParallel: isReadOnlySlice(slice.sliceType),
    },
    hysteresis,
  }
}

/** Run one slice: evaluate (allocate → tier/venue) → cheap dispatch → verify → (accept | climb the ladder, re-evaluating + re-verifying each hop). Each dispatch is wall-clock capped per the slice's type (OL-9.3e). `sameFilesInScope` is the P6c venue input, precomputed per slice by `runSliceLoop`. */
async function runSlice(
  slice: LoopSlice,
  deps: SliceLoopDeps,
  ledger: DoublePayLedger,
  sameFilesInScope: boolean,
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
  const firstVerdict = evaluate(buildEvalContext(slice, deps, { attempts: 0 }, { signalDelta: false }, sameFilesInScope))
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

  // Consequence (isCritical) no longer blocks a vacuous accept to force a generator
  // climb — that was the 12039 double-pay (pay the oracle to re-author something
  // still unverifiable). A judge-verified critical slice accepts at any tier; a
  // slice we cannot verify soft-settles LOUDLY for review below (deps.onProvenance),
  // never by force-authoring at the oracle.

  const settleAccepted = (v: VerifierVerdict, out: SliceDispatchResult, atAttempts: number, esc?: SliceOutcome["escalation"]): SliceOutcome => ({
    id: slice.id,
    // An untestable-slice accept (verdict.unverified, OL-9.5d) still needs to
    // surface as unverified downstream — it wasn't actually checked.
    state: v.unverified ? "unverified" : esc ? "escalated" : "accepted",
    tier: allocation.tier,
    verification: allocation.verification,
    allocation,
    verdict: v,
    output: out.text,
    attempts: atAttempts,
    ...(esc ? { escalation: esc } : {}),
  })

  if (verdict.accepted) {
    // Posterior-uncertainty gate (task #48, posterior-uncertainty.ts): a green
    // sound-rung verdict only proves the code RUNS, never that it solved the
    // RIGHT problem. On a prior-flagged (ambiguous/hard) slice with a
    // high-uncertainty signal, ONE generator escalation still fires even
    // though verification already passed; every other slice (unflagged, or
    // flagged-but-confident) accepts unchanged — the cost-thesis guard lives
    // in `posteriorEscalation` itself, this is just the one-shot dispatch.
    const priorFlagged = slice.ambiguity === "ambiguous" || slice.hardness === "hard"
    if (priorFlagged && !isReadOnlySlice(slice.sliceType) && maxAttempts >= 2) {
      const posteriorSignal =
        cheap.uncertainty ??
        (deps.confidenceGenerate ? signalFromConfidence(await deps.confidenceGenerate(slice.id)) : undefined)
      const posteriorTargetTier = escalateTier(allocation.tier)
      if (posteriorTargetTier !== allocation.tier && posteriorEscalation(posteriorSignal, slice)) {
        deps.onProvenance?.({
          sliceId: slice.id,
          fromTier: allocation.tier,
          toTier: posteriorTargetTier,
          rungReason: "posterior-uncertain-review",
        })
        // Snapshot the cheap-accepted tree (if bracketed) before the hop reverts
        // to the pre-cheap baseline — the restore path below needs it back if
        // the second opinion doesn't hold up under re-verification.
        const acceptedHash = deps.snapshot ? await deps.snapshot.track() : undefined
        const posteriorHop = await dispatchRescueHop({
          slice,
          deps,
          ledger,
          allocation,
          atTier: allocation.tier,
          targetTier: posteriorTargetTier,
          attempt: cheap,
          attemptVerdict: verdict,
          currentHash,
          baseTimeoutMs,
          dispatchTimeout,
          tierModel,
          attempts: 1,
          sameFilesInScope,
        })
        if (posteriorHop.verdict.accepted) {
          return settleAccepted(posteriorHop.verdict, posteriorHop.result, 2, posteriorHop.escalation)
        }
        // The second opinion did not re-verify — never force-replace a
        // proven-green result with one that failed re-verification; restore
        // the cheap-accepted tree (when bracketed) and keep the cheap output.
        if (deps.snapshot && acceptedHash !== undefined) await deps.snapshot.restore(acceptedHash)
        return settleAccepted(verdict, cheap, 2)
      }
    }
    return settleAccepted(verdict, cheap, 1)
  }

  // --- Rejected (or a critical slice's vacuous accept, M3) → work the ladder,
  // each rescue RE-VERIFIED before it is trusted — a conductor rescue cannot
  // be blind-accepted the way the old straight-to-oracle hop was. A genuine
  // reject first RETRIES THE SAME TIER while its failure signature is still
  // converging (M2, SAME_TIER_RETRY_BUDGET, reset on every climb) — squeezing
  // the cheap tier before paying for a climb — and only climbs on stall (the
  // signature repeats, or the squeeze budget is spent). The climb itself is
  // gated by `maxClimbs`, NOT by the total attempt count: a non-critical
  // slice always reaches at least the conductor before it may settle
  // unverified (a stalled squeeze must never deny the climb) and climbs at
  // most once more beyond that (the cost cap — the conductor rescue is the
  // affordable ceiling for a non-critical slice); a critical slice (M3)
  // bypasses `maxClimbs` via `forceFloorClimb` and climbs every tier up to
  // the oracle. `MAX_SLICE_ATTEMPTS` (`defaultMaxAttempts` unless overridden)
  // is a runaway backstop on total dispatches, not the real control — the
  // signature-stall guard already prevents the run-8 regression (an
  // un-capped ladder re-running identical work up to 4x per slice, 8 briefs
  // -> 62 runner sessions) since a squeeze only fires while NEW evidence
  // keeps surfacing. Read-only (recon/verify) slices never squeeze or climb
  // (maxClimbs=0), matching their 1-dispatch `defaultMaxAttempts` cap.
  // Climb depth (the cost cap), uniform across consequence: every slice — critical
  // or not — climbs at most once beyond the cheap tier (to the conductor for an
  // executor-first slice) before it may settle unverified. Consequence no longer
  // buys extra climbs (the reframe: blast-radius routes the judge verifier, not the
  // author); predicted difficulty was already priced up-front by allocateSlice's
  // difficulty floor. Zero for a read-only (recon/verify) slice: it never climbs at
  // all, matching `defaultMaxAttempts` — the `ceiling` backstop alone (below) does
  // not block a first climb (a recon's ceiling IS the conductor, and verify's
  // ceiling is the oracle), so this must be the real gate now that the attempt
  // count no longer is.
  const maxClimbs = isReadOnlySlice(slice.sliceType) ? 0 : 1

  // Ladder ceiling: recon is read-only investigation — it never deserves an
  // oracle-priced rescue; verify has no special ceiling of its own (maxClimbs
  // above is what actually stops it at 0 climbs). This stays as the tier-side
  // backstop for a caller-overridden maxClimbs/maxAttempts.
  const ceiling: EconTier = slice.sliceType === "recon" ? "conductor" : "oracle"
  const readOnly = isReadOnlySlice(slice.sliceType)
  const critical = isCritical(slice)

  /** `sliceTransition`'s `escalate`: the next tier up, or `undefined` once climbing would pass this slice's ceiling. */
  const escalate = (tier: EconTier): EconTier | undefined => {
    const higher = escalateTier(tier)
    return higher === tier || LADDER_RANK[higher] > LADDER_RANK[ceiling] ? undefined : higher
  }

  const settleUnverified = async (atAttempts: number): Promise<SliceOutcome> => {
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
      attempts: atAttempts,
      ...(escalation ? { escalation } : {}),
      ...(revertedDiff !== undefined ? { revertedDiff } : {}),
    }
  }

  // The explicit slice FSM (orchestration-fsm.ts) is the single source of
  // truth for the squeeze-vs-climb-vs-settle decision that used to live in an
  // implicit local tuple (attempts/sameTierRetries/climbs/atTier/
  // lastSignatureAtTier) — `isSliceTerminal` gates every iteration below, so
  // a settled slice is never re-dispatched (the run-8 "never marks slices
  // settled" blocker). `attempt`/`attemptVerdict`/`escalation` still track
  // the latest dispatch's output; everything the loop used to thread by hand
  // now lives in `state`.
  let attempt = cheap
  let attemptVerdict = verdict
  let escalation: SliceOutcome["escalation"]
  let state: SliceMachineState = initialSliceState(allocation.tier)

  for (;;) {
    const fromTier = state.atTier
    const preAttempts = state.attempts
    const ctx: SliceTransitionCtx = {
      sameTierRetryBudget: attemptVerdict.accepted ? 0 : SAME_TIER_RETRY_BUDGET,
      maxClimbs,
      maxAttempts,
      isReadOnly: readOnly,
      isCritical: critical,
      escalate,
    }
    const fsmVerdict: SliceVerdictLike = {
      accepted: attemptVerdict.accepted,
      signature: verdictSignature(attemptVerdict),
    }
    state = sliceTransition(state, { type: "verdict", verdict: fsmVerdict }, ctx)

    if (isSliceTerminal(state)) {
      const { outcome, attempts: settledAttempts } = state.terminal
      if (outcome === "accepted" || outcome === "escalated") {
        return settleAccepted(attemptVerdict, attempt, settledAttempts, escalation)
      }
      // "unverified" (ladder exhausted) or "abandoned" (unreachable from this
      // per-slice ladder — no budget-exhausted event is ever raised here;
      // kept only for exhaustiveness with the shared FSM's outcome union).
      if (critical && !readOnly) {
        // A critical slice we could not verify settles LOUDLY for review (M3) —
        // consequence flags it for the turn owner instead of force-authoring at
        // the oracle (blast-radius routes the judge verifier, never the author).
        deps.onProvenance?.({ sliceId: slice.id, fromTier, toTier: fromTier, rungReason: "critical-unverified-review" })
      }
      return await settleUnverified(settledAttempts)
    }

    // Not terminal — the reducer already decided squeeze (same tier) vs climb
    // (state.atTier raised); dispatch that hop through the existing rescue path.
    const hop = await dispatchRescueHop({
      slice, deps, ledger, allocation, atTier: fromTier, targetTier: state.atTier,
      attempt, attemptVerdict, currentHash, baseTimeoutMs, dispatchTimeout, tierModel, attempts: preAttempts, sameFilesInScope,
    })
    currentHash = hop.currentHash
    escalation = hop.escalation
    attempt = hop.result
    attemptVerdict = hop.verdict
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

  // P6b/P6c — predicted edit scopes, probed once per editing slice (read-only
  // recon/verify slices are exempt). No probe ⇒ empty map ⇒ the declared-deps
  // wave plan byte-identical and every sameFilesInScope false.
  const scopes = new Map<string, ReadonlySet<string>>()
  if (deps.editScopeOf) {
    const probe = deps.editScopeOf
    await Promise.all(
      slices
        .filter((s) => !isReadOnlySlice(s.sliceType))
        .map(async (s) => {
          scopes.set(s.id, await probe(s))
        }),
    )
  }
  const { planned, waves, implicitDeps } = serializeOverlappingScopes(slices, scopes)

  // P6c — sameFilesInScope per slice: predicted scope ∩ the parent thread's
  // open files. Either seam absent ⇒ false (an honest default, not a hardcode).
  const parentScope = deps.parentScope
  const sameFilesInScope = (id: string): boolean => {
    const scope = scopes.get(id)
    if (!scope || !parentScope) return false
    for (const file of scope) if (parentScope.has(file)) return true
    return false
  }

  const byId = new Map(planned.map((s) => [s.id, s]))
  const outcomes = new Map<string, SliceOutcome>()
  const loopTimeout = deps.loopTimeout ?? raceTimeout
  const loopBudgetMs = overallLoopBudgetMs(slices)

  const runWaves = async (): Promise<void> => {
    for (const wave of waves) {
      // P6a — a dependency (declared or P6b-implicit) that settled
      // terminal-failed blocks this slice BEFORE any spend; a blocked dep
      // cascades. Dependents always sit in later waves, so every dep's
      // outcome is already settled here.
      const dispatchable: string[] = []
      for (const id of wave) {
        const slice = byId.get(id)!
        const blockedBy = (slice.deps ?? []).filter((d) => {
          const dep = outcomes.get(d)
          return dep !== undefined && blocksDependents(dep)
        })
        if (blockedBy.length > 0) outcomes.set(id, blockedOutcome(slice, blockedBy, deps))
        else dispatchable.push(id)
      }
      const settled = await Promise.all(
        dispatchable.map((id) => runSlice(withUpstreamContext(byId.get(id)!, outcomes), deps, ledger, sameFilesInScope(id))),
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
  const blocked = outcomeList.filter((o) => o.state === "blocked").length
  const slicesDispatched = outcomeList.length - blocked
  const firstAttemptPasses = outcomeList.filter((o) => o.state !== "blocked" && o.attempts === 1).length
  const totalAttempts = outcomeList.reduce((sum, o) => sum + o.attempts, 0)
  const telemetry: SliceLoopTelemetry = {
    slicesDispatched,
    firstAttemptPasses,
    totalAttempts,
    attemptsPerSlice: slicesDispatched > 0 ? totalAttempts / slicesDispatched : 0,
    firstPassRate: slicesDispatched > 0 ? firstAttemptPasses / slicesDispatched : 0,
    blocked,
    implicitDeps,
  }

  return {
    engaged: true,
    outcomes: outcomeList,
    waves,
    ledger: ledger.snapshot(),
    telemetry,
  }
}
