/**
 * Compiled-brief assembler for oracle (large-tier) escalation: converts
 * structured inputs — problem, question, output shape, code-intelligence slices,
 * prior attempts — into a compact string the oracle sees instead of a raw
 * transcript, keeping the oracle's token share minimal and the savings identity
 * intact.
 *
 * @sem domain=intelligence role=utilities
 */

import { estimateTokens, smartTruncate } from "./trim.js"
import type { ReconBundle } from "./index.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single prior-attempt summary drawn from canonical state. */
export interface AttemptSummary {
  /** The task that was attempted. */
  readonly task: string
  /** Outcome of the attempt. */
  readonly status: "success" | "failure" | "in-progress"
  /** Error message when status is "failure". */
  readonly error?: string
}

/**
 * Deterministic failure evidence for an escalation brief (OL-2.2 / OL-7.3):
 * what the cheap attempt failed on and the verifier verdict that rejected it —
 * NOT the raw transcript. This is what turns a plain oracle brief into an
 * *escalation* brief: the oracle sees the failing rung, its reason, and a few
 * concrete deterministic evidence lines (a failing command's stderr, a
 * behavior-monitor flag), so it fixes the actual defect instead of re-deriving
 * it. Kept small and prefix-stable so the oracle cache still hits (OL-3.7).
 */
export interface FailureEvidence {
  /** The verifier rung that rejected the cheap attempt (sound / behavior / qe / judge). */
  readonly rung: string
  /** Human-readable verdict reason from the rejecting rung. */
  readonly verdict: string
  /**
   * Concrete, deterministic evidence lines — failing-command stderr snippets,
   * behavior-monitor flags, type errors. Explicitly NOT the transcript.
   */
  readonly evidence?: readonly string[]
  /** A "MISSING: ..." statement (OL-9.4c) naming the evidence that would have passed the rejecting rung — rendered fixed, never trimmed. */
  readonly missing?: string
}

/** Structured inputs for compileBrief. */
export interface BriefInput {
  /** Problem statement driving this oracle escalation. */
  readonly problem: string
  /** The specific question the oracle must answer. */
  readonly question: string
  /** Expected output format or shape (e.g. "JSON array of {name, score}"). */
  readonly outputShape: string
  /** Code/context slices prepared by the caller (entity bodies, notes, etc.). */
  readonly slices: readonly string[]
  /** Prior attempts from canonical state. */
  readonly attempts: readonly AttemptSummary[]
  /**
   * Deterministic failure evidence when this brief escalates a rejected cheap
   * attempt (OL-2.2 / OL-7.3). Omitted for a first-hop oracle brief; present on
   * an escalation so the oracle sees what failed before the wiring.
   */
  readonly failure?: FailureEvidence
  /** Target token budget for the compiled brief (default 8 000). */
  readonly tokenBudget?: number
}

/**
 * Compiled brief ready for the oracle tier.
 * The oracle receives `text` only — no raw transcript, no session internals.
 */
export interface OracleBrief {
  /** Plain-text rendering of the brief (what the oracle receives). */
  readonly text: string
  /** Estimated tokens in the compiled text. */
  readonly estimatedTokens: number
  /** Budget that was applied. */
  readonly tokenBudget: number
  /** True when any slices or attempts were trimmed to fit within budget. */
  readonly trimmed: boolean
}

/**
 * Lightweight view of canonical state — only the fields briefFromContext reads.
 * Shape-compatible with SessionCanonicalState.CanonicalState; no Effect deps.
 */
export interface CanonicalStateFragment {
  readonly attempts: ReadonlyArray<{
    readonly payload: Record<string, unknown>
  }>
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** Default token budget when none is supplied. */
const DEFAULT_BUDGET = 8_000

/**
 * Fraction of the remaining budget (after fixed sections) allocated to slices.
 * The rest (ATTEMPT_BUDGET_RATIO = 1 - SLICE_BUDGET_RATIO) goes to attempts.
 */
const SLICE_BUDGET_RATIO = 0.6

/** Estimated token overhead for section headings and structural newlines. */
const HEADER_OVERHEAD_TOKENS = 60

// ---------------------------------------------------------------------------
// compileBrief
// ---------------------------------------------------------------------------

/**
 * Assemble a compact oracle brief from structured inputs, trimming variable
 * content (slices, attempts) to fit within the token budget.
 *
 * Ordering (fixed):
 *   1. Problem statement   — always included, never trimmed
 *   2. Question            — always included, never trimmed
 *   3. Expected output shape — always included, never trimmed
 *   4. Context slices      — trimmed greedily in order until budget exhausted
 *   5. Prior attempts      — trimmed as a block from what remains
 *
 * The oracle therefore always sees the core directive before any supporting
 * context. Slices and attempts are only elided when they exceed the budget.
 * When `failure.missing` is set, its "MISSING: ..." line (OL-9.4c) is rendered
 * fixed inside the Failure Evidence section — never trimmed.
 *
 * @sem domain=intelligence role=utilities
 */
export function compileBrief(input: BriefInput): OracleBrief {
  const budget = Math.max(input.tokenBudget ?? DEFAULT_BUDGET, 200)

  // ── Fixed sections (always included) ────────────────────────────────────
  // Failure evidence, when present, is fixed (never trimmed) and comes right
  // after the core directive: an escalated oracle must see what the cheap
  // attempt failed on and the rejecting verdict before any supporting wiring.
  const fixedParts = [
    `## Problem\n${input.problem}`,
    `## Question\n${input.question}`,
    `## Expected Output Shape\n${input.outputShape}`,
  ]
  if (input.failure) {
    const lines = [
      `Rejected at the ${input.failure.rung} verifier rung.`,
      `Verdict: ${input.failure.verdict}`,
    ]
    if (input.failure.missing) lines.push(input.failure.missing)
    if (input.failure.evidence && input.failure.evidence.length > 0) {
      lines.push("Evidence:", ...input.failure.evidence.map((e) => `- ${e}`))
    }
    fixedParts.push(`## Failure Evidence\n${lines.join("\n")}`)
  }
  const fixedText = fixedParts.join("\n\n")

  const fixedTokens = estimateTokens(fixedText) + HEADER_OVERHEAD_TOKENS
  const remainingBudget = Math.max(budget - fixedTokens, 0)

  const sliceBudget = Math.floor(remainingBudget * SLICE_BUDGET_RATIO)
  const attemptBudget = remainingBudget - sliceBudget

  // ── Slices: allocate greedily in input order ─────────────────────────────
  let trimmed = false
  const trimmedSlices: string[] = []
  let sliceTokensUsed = 0

  for (const slice of input.slices) {
    const available = Math.max(sliceBudget - sliceTokensUsed, 0)
    if (available <= 0) {
      trimmed = true
      break
    }
    const result = smartTruncate(slice, { budget: available })
    if (result.truncated) trimmed = true
    trimmedSlices.push(result.text)
    sliceTokensUsed += result.tokensUsed
  }

  const slicesSection =
    trimmedSlices.length > 0
      ? `## Context Slices\n${trimmedSlices.join("\n\n---\n\n")}`
      : ""

  // ── Attempts: render as a block and trim as one unit ────────────────────
  let attemptsSection = ""
  if (input.attempts.length > 0) {
    const attemptsRaw = input.attempts
      .map((a, i) => {
        const lines = [`Attempt ${i + 1}: ${a.task}`, `Status: ${a.status}`]
        if (a.error) lines.push(`Error: ${a.error}`)
        return lines.join("\n")
      })
      .join("\n\n")

    const result = smartTruncate(attemptsRaw, { budget: Math.max(attemptBudget, 50) })
    if (result.truncated) trimmed = true
    attemptsSection = `## Prior Attempts\n${result.text}`
  }

  // ── Assemble in prescribed order ────────────────────────────────────────
  const parts = [fixedText, slicesSection, attemptsSection].filter(Boolean)
  const text = parts.join("\n\n")

  return {
    text,
    estimatedTokens: estimateTokens(text),
    tokenBudget: budget,
    trimmed,
  }
}

// ---------------------------------------------------------------------------
// briefFromContext — convenience adapter
// ---------------------------------------------------------------------------

/**
 * Map a code-intelligence ReconBundle + a canonical-state fragment into a
 * compiled oracle brief. Extracts entity signatures and anchored notes as
 * slices; maps attempt payload rows to AttemptSummary.
 *
 * Keeps brief.ts a pure assembler: no Effect, no DB, no session imports —
 * callers are responsible for loading recon and canonical state.
 *
 * @sem domain=intelligence role=utilities
 */
export function briefFromContext(
  recon: ReconBundle,
  canonicalState: CanonicalStateFragment,
  question: string,
  outputShape: string,
  opts?: { problem?: string; tokenBudget?: number },
): OracleBrief {
  // Anchored notes come first — they carry conventions the oracle must honour.
  // notes is now AnchoredNote[]; serialise each to a compact one-line string.
  const noteSlices = recon.notes
    .filter((n) => n.content && n.content.trim().length > 0)
    .map((n) => `[${n.kind}|${n.anchor}|${n.polarity}] ${n.content}`)

  // Entity signatures: concise structural slices (no full bodies).
  const entitySlices = recon.entities.map((e) => {
    const lines = [`${e.kind} \`${e.name}\` — ${e.filePath}:${e.lineStart}–${e.lineEnd}`]
    if (e.signature) lines.push(`Signature: ${e.signature}`)
    if (e.domain) lines.push(`Domain: ${e.domain}`)
    return lines.join("\n")
  })

  const slices = [...noteSlices, ...entitySlices]

  // Map CanonicalStateRow payload objects to AttemptSummary.
  const attempts: AttemptSummary[] = canonicalState.attempts.map((row) => {
    const p = row.payload
    const status =
      p["status"] === "success" || p["status"] === "failure" || p["status"] === "in-progress"
        ? (p["status"] as AttemptSummary["status"])
        : "in-progress"
    return {
      task: typeof p["task"] === "string" ? p["task"] : "(unknown task)",
      status,
      error: typeof p["error"] === "string" ? p["error"] : undefined,
    }
  })

  return compileBrief({
    problem: opts?.problem ?? question,
    question,
    outputShape,
    slices,
    attempts,
    tokenBudget: opts?.tokenBudget,
  })
}
