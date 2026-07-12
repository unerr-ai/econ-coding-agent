/**
 * F9a — repro-fidelity judge: a cheap, one-shot LLM check that fires once
 * per turn, at pin time (prompt.ts's SM4 site, `turn_probe_pinned_from_red`),
 * on the reproduction script the engine just pinned as the turn's
 * verification contract. Live failures showed a repro that pins HONESTLY —
 * it does fail on the unpatched code — while still asserting the WRONG
 * expectation: a rendered/serialized surface that hides the real type, or a
 * downstream effect instead of the exact expression the issue names, so a
 * green fix still fails the real grader. The judge reports facts
 * (`faithful` + concrete `gaps`); it never blocks the pin, and any
 * parse/call failure degrades silently to `DEGRADED_REPRO_FIDELITY` — the
 * same no-op discipline as `arming-judge.ts`'s `DEGRADED_ARMING`.
 *
 * @sem domain=routing role=repro-judge
 */
import { extractJsonObject } from "../util/json-extract"
import { REPRO_FIDELITY_SYSTEM_PROMPT } from "./prompts/judges"

/** Hard cap on gaps per verdict — enforced on parse, not just requested in the prompt. */
export const REPRO_FIDELITY_MAX_GAPS = 3
/** Per-gap character cap — enforced on parse, not just requested in the prompt. */
export const REPRO_FIDELITY_MAX_GAP_CHARS = 120

/**
 * The repro-fidelity verdict: whether the pinned reproduction's asserts
 * actually pin the issue's real expectation, plus up to
 * `REPRO_FIDELITY_MAX_GAPS` concrete gaps when they don't.
 *
 * @sem domain=routing role=repro-judge
 */
export interface ReproFidelityVerdict {
  readonly faithful: boolean
  readonly gaps: readonly string[]
}

/**
 * The ONE posture a malformed/failed judge call resolves to: silent no-op —
 * assume faithful, no gaps. Same discipline as `arming-judge.ts`'s
 * `DEGRADED_ARMING`: a judge that cannot answer must never block the pin or
 * inject a nudge, only a confident REJECT can.
 *
 * @sem domain=routing role=repro-judge
 */
export const DEGRADED_REPRO_FIDELITY: ReproFidelityVerdict = { faithful: true, gaps: [] }

/**
 * One request to the injected completion — the caller (prompt.ts) owns the
 * provider path and tier resolution; this module never names a model.
 *
 * @sem domain=routing role=repro-judge
 */
export type ReproFidelityComplete = (request: { system: string; user: string }) => Promise<string>

/**
 * Input to `runReproFidelityJudge`: the turn's issue text and the pinned
 * repro file's content (the caller reads the file — this module never
 * touches the filesystem), plus the injected completion port.
 *
 * @sem domain=routing role=repro-judge
 */
export interface RunReproFidelityJudgeInput {
  readonly issueText: string
  readonly reproContent: string
  readonly complete: ReproFidelityComplete
}

/**
 * Parse the judge's raw completion into a verdict: extracts the first
 * balanced JSON object, validates `faithful` is a boolean, and clamps
 * `gaps` to at most `REPRO_FIDELITY_MAX_GAPS` non-empty string entries of at
 * most `REPRO_FIDELITY_MAX_GAP_CHARS` characters each (a non-string entry is
 * dropped, not corrected). No balanced JSON, malformed JSON, or an invalid
 * `faithful` field returns `null` — never throws.
 *
 * @sem domain=routing role=repro-judge
 */
export function parseReproFidelityResponse(raw: string): ReproFidelityVerdict | null {
  if (!raw) return null
  const jsonText = extractJsonObject(raw)
  if (!jsonText) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return null
  }

  if (typeof parsed !== "object" || parsed === null) return null
  const candidate = parsed as Record<string, unknown>
  if (typeof candidate.faithful !== "boolean") return null

  const gaps: string[] = Array.isArray(candidate.gaps)
    ? candidate.gaps
        .filter((g): g is string => typeof g === "string" && g.trim().length > 0)
        .slice(0, REPRO_FIDELITY_MAX_GAPS)
        .map((g) => (g.length > REPRO_FIDELITY_MAX_GAP_CHARS ? g.slice(0, REPRO_FIDELITY_MAX_GAP_CHARS) : g))
    : []

  return { faithful: candidate.faithful, gaps }
}

/**
 * Run the repro-fidelity judge: ONE forced-JSON completion checking the
 * pinned repro's asserts against the issue text — no retry, this fires at
 * most once per turn (the caller enforces that). A thrown `complete`, or any
 * parse failure, degrades to `DEGRADED_REPRO_FIDELITY` (assume faithful) —
 * never blocks the pin, never throws.
 *
 * @sem domain=routing role=repro-judge
 */
export async function runReproFidelityJudge(input: RunReproFidelityJudgeInput): Promise<ReproFidelityVerdict> {
  const { issueText, reproContent, complete } = input
  let raw: string
  try {
    raw = await complete({
      system: REPRO_FIDELITY_SYSTEM_PROMPT,
      user: `## Issue\n${issueText}\n\n## Pinned reproduction\n${reproContent}`,
    })
  } catch {
    return DEGRADED_REPRO_FIDELITY
  }
  return parseReproFidelityResponse(raw) ?? DEGRADED_REPRO_FIDELITY
}
