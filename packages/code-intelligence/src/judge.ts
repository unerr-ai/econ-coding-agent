/**
 * Cross-model judge rung (OL-7.8 / OL-7.3) — the verifier for an *untestable*
 * slice, where no sound check (compile / tests / types) exists to trust. A
 * different model *family* than the generator reads the finished output and
 * rules accept/reject, because a model self-judging its own work is unreliable
 * (§4.3). It plugs into the existing verifier ladder as its `ExtraRungFn`
 * extension point rather than modifying the ladder's sound/behavior/QE rungs,
 * and it reuses the same injected `generate()` pattern qe.ts uses — no model
 * client is hardwired here. Defensive: a judge error or an unparseable verdict
 * degrades to the next rung (returns undefined) rather than blocking the slice.
 * On a reject the judge is asked for a "MISSING: ..." line naming the evidence
 * that would flip its verdict (OL-9.4c); an unparseable one falls back to a
 * generic line so the escalation brief always states an objective.
 *
 * @sem domain=routing role=verify-ladder
 */

import type { ExtraRungFn, ExtraRungVerdict } from "./verifier.js"

/** The judge's parsed decision plus the raw text it was read from. */
export interface JudgeVerdict extends ExtraRungVerdict {
  rung: "judge"
  /** The judge model's raw reply, for the trace. */
  raw: string
}

/** Structured inputs for one cross-model judge call. */
export interface CrossModelJudgeInput {
  /** The slice task / question the output is supposed to satisfy. */
  readonly task: string
  /** The generator's output being judged (already the cheap tier's answer). */
  readonly output: string
  /** Deterministic wiring facts the judge should hold the output against (optional). */
  readonly wiring?: string
  /**
   * Injected sampler that calls a DIFFERENT model family than the generator and
   * returns the judge's raw reply. Self-judging is unreliable, so the caller is
   * responsible for pointing this at a cross-family tier (§4.3).
   */
  readonly generate: (prompt: string) => Promise<string>
}

/** Verdict-token scan: an explicit reject wins over an accept if both appear. */
const REJECT_RE = /\[\[REJECT\]\]|\bREJECT\b|\bFAIL(?:ED)?\b/i
const ACCEPT_RE = /\[\[ACCEPT\]\]|\bACCEPT\b|\bPASS(?:ED)?\b/i

/** Extracts the required "MISSING: ..." line from a reject reply (OL-9.4c). */
const MISSING_RE = /^MISSING:\s*(.+)$/im

/**
 * Render the judge prompt: a terse instruction to rule on the output against
 * the task (and wiring, when supplied) — including the boundary-input and
 * sibling-branch discipline checks — replying with a single [[ACCEPT]] or
 * [[REJECT]] token, a one-line reason, and — on reject — a "MISSING: ..." line
 * naming the evidence that would flip the verdict (OL-9.4c). Kept small and
 * stable so a judge tier's cache stays warm across slices.
 *
 * @sem domain=routing role=verify-ladder
 */
export function buildJudgePrompt(input: CrossModelJudgeInput): string {
  const parts = [
    "You are a cross-model verifier. Judge whether the OUTPUT below correctly and completely satisfies the TASK.",
    'Boundary inputs: for every repro input the output exercised, name its empty/zero/falsy variant ("" / 0 / [] / None / undefined) and state whether the change handles it — check, don\'t assume.',
    "Sibling branches: if the change edits one branch of a conditional or one member of a parallel case set, inspect the sibling branch(es) for the same defect and state the finding.",
    "Reply with exactly one verdict token — [[ACCEPT]] or [[REJECT]] — then a one-line reason.",
    'If you REJECT, add a final line starting with exactly "MISSING: " naming the concrete evidence that would have made you accept — e.g. a passing test run showing the specific assertion, not a plan to add one later.',
    `## Task\n${input.task}`,
  ]
  if (input.wiring && input.wiring.trim().length > 0) {
    parts.push(`## Wiring (deterministic facts the output must respect)\n${input.wiring}`)
  }
  parts.push(`## Output\n${input.output}`)
  return parts.join("\n\n")
}

/**
 * Run one cross-model judge call and parse its verdict. An explicit reject
 * token beats an accept token; a reply with neither, or a thrown sampler,
 * returns undefined so the verifier ladder degrades to its next rung (QE)
 * instead of treating an unparseable judge as a hard fail. On a reject, parses
 * the required "MISSING: ..." line (OL-9.4c) into the verdict so the
 * escalation brief can state a concrete objective instead of "try again";
 * an unparseable reject falls back to a generic MISSING line rather than
 * leaving the field empty.
 *
 * @sem domain=routing role=verify-ladder
 */
export async function runCrossModelJudge(input: CrossModelJudgeInput): Promise<JudgeVerdict | undefined> {
  let raw: string
  try {
    raw = await input.generate(buildJudgePrompt(input))
  } catch {
    return undefined
  }
  const rejected = REJECT_RE.test(raw)
  const accepted = ACCEPT_RE.test(raw)
  if (!rejected && !accepted) return undefined
  // Reject wins when both tokens are present — the safe direction to be wrong in.
  const pass = accepted && !rejected
  if (pass) {
    return { rung: "judge", pass, detail: raw.trim().slice(0, 240), raw }
  }
  const missingMatch = raw.match(MISSING_RE)
  const missing = missingMatch
    ? `MISSING: ${missingMatch[1].trim()}`
    : "MISSING: the judge rejected without naming what evidence would flip its verdict — treat any concrete, reproducible check result as sufficient."
  return {
    rung: "judge",
    pass,
    detail: raw.trim().slice(0, 240),
    raw,
    missing,
  }
}

/**
 * Adapt the cross-model judge into the verifier ladder's `ExtraRungFn` slot so
 * `runVerifierLadder` runs it between the (inapplicable) sound rung and the QE
 * fallback for an untestable slice. The ladder only reaches this when no sound
 * check applied and the trajectory was clean.
 *
 * @sem domain=routing role=verify-ladder
 */
export function judgeRung(input: CrossModelJudgeInput): ExtraRungFn {
  return async () => runCrossModelJudge(input)
}
