/**
 * F9a — repro-fidelity judge: a cheap, one-shot LLM check that fires once
 * per turn, at pin time (prompt.ts's SM4/F13d pin sites, both funneled
 * through `dispatchPinnedReproFidelity`), on the reproduction script just
 * pinned as the turn's verification contract. Live failures showed a repro
 * that pins HONESTLY — it does fail on the unpatched code — while still
 * asserting the WRONG expectation: a rendered/serialized surface that hides
 * the real type, or a downstream effect instead of the exact expression the
 * issue names, so a green fix still fails the real grader. The judge
 * reports facts (`faithful` + concrete `gaps`); it never blocks the pin, and
 * any parse/call failure degrades silently to `DEGRADED_REPRO_FIDELITY` —
 * the same no-op discipline as `arming-judge.ts`'s `DEGRADED_ARMING`. F14b
 * adds a deterministic backstop alongside the LLM verdict:
 * `hasAssertionTeeth` + `applyAssertionTeethGap` catch a script that only
 * prints a mismatch and exits 0 — a green run that can't actually fail,
 * which let a wrong fix ship on a live run despite an "ok" judge verdict.
 * RF-4 adds two more of the same shape: `detectRenderedAssert` +
 * `applyRenderedAssertGap` catch a repro whose asserts only pin a
 * rendered/serialized surface, and `missingRequiredLiterals` +
 * `applyRequiredLiteralsGap` force a gap for any issue-derived literal
 * (§6, `requiredLiterals`) the repro never asserts.
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
 * touches the filesystem), the injected completion port, plus the optional
 * §6 issue-derived `requiredLiterals` the caller wires in once the
 * issue-expectations extractor runs — `applyRequiredLiteralsGap` reads it
 * directly, `runReproFidelityJudge` itself never consumes it.
 *
 * @sem domain=routing role=repro-judge
 */
export interface RunReproFidelityJudgeInput {
  readonly issueText: string
  readonly reproContent: string
  readonly complete: ReproFidelityComplete
  readonly requiredLiterals?: readonly string[]
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

/**
 * F14b — the static gap merged in by `applyAssertionTeethGap` when
 * `hasAssertionTeeth` finds no real assertion in the pinned script.
 *
 * @sem domain=routing role=repro-judge
 */
export const ASSERTION_TEETH_GAP = "repro only prints — add an assertion that exits non-zero while the bug is present"

/** A literal nonzero first digit — "0" or no digits at all does not count. */
const NONZERO_FIRST_DIGIT = "[1-9]"

/**
 * F14b — whether a reproduction script can actually fail: true iff it
 * contains a real `assert`/`raise`/`throw`, or an exit call whose first
 * digit is a literal 1-9 (`sys.exit(1)`, `os._exit(2)`, bare `exit(1)`,
 * `process.exit(1)`, or shell `exit 1`). A script that only prints a
 * mismatch and exits 0 (or calls `sys.exit()` with no args) returns false —
 * it can go green while the bug it's meant to pin still lives, which is
 * exactly the gap a live run shipped a wrong fix on despite an "ok" judge
 * verdict. Deterministic and independent of the LLM judge; plain
 * word-boundary regexes, kept simple on purpose (e.g. a comment containing
 * the word "assertion" does not count — only the standalone word "assert"
 * does).
 *
 * @sem domain=routing role=repro-judge
 */
export function hasAssertionTeeth(content: string): boolean {
  return (
    /\bassert\b/.test(content) ||
    /\braise\b/.test(content) ||
    /\bthrow\b/.test(content) ||
    new RegExp(`\\bsys\\.exit\\(\\s*${NONZERO_FIRST_DIGIT}`).test(content) ||
    new RegExp(`\\bos\\._exit\\(\\s*${NONZERO_FIRST_DIGIT}`).test(content) ||
    new RegExp(`\\bprocess\\.exit\\(\\s*${NONZERO_FIRST_DIGIT}`).test(content) ||
    new RegExp(`\\bexit\\(\\s*${NONZERO_FIRST_DIGIT}`).test(content) ||
    new RegExp(`\\bexit\\s+${NONZERO_FIRST_DIGIT}\\d*\\b`).test(content)
  )
}

/**
 * F14b — force a fidelity gap when the pinned script has no assertion
 * teeth, regardless of what the LLM judge said: a no-op (same reference
 * returned) when `hasAssertionTeeth` is true, otherwise overrides to
 * `faithful:false` with `ASSERTION_TEETH_GAP` appended to any existing gaps
 * and reclamped to `REPRO_FIDELITY_MAX_GAPS`.
 *
 * @sem domain=routing role=repro-judge
 */
export function applyAssertionTeethGap(verdict: ReproFidelityVerdict, reproContent: string): ReproFidelityVerdict {
  if (hasAssertionTeeth(reproContent)) return verdict
  return {
    faithful: false,
    gaps: [...verdict.gaps, ASSERTION_TEETH_GAP].slice(0, REPRO_FIDELITY_MAX_GAPS),
  }
}

/** A variable name shape that signals a rendered/serialized surface rather than the API-level value. */
const RENDERED_VALUE_VAR = "(?:html|output|rendered|content|response)"
/** `assert <literal-or-expr> in <rendered-var>` — a substring-membership assert against a rendered value. */
const RENDERED_MEMBERSHIP_ASSERT = new RegExp(`\\bassert\\b.*\\bin\\s+${RENDERED_VALUE_VAR}\\b`, "i")
/** `assertIn(<needle>, <rendered-var>)` — the xunit-style shape of the same check. */
const RENDERED_MEMBERSHIP_ASSERT_IN = new RegExp(`\\bassertIn\\s*\\([^,]+,\\s*${RENDERED_VALUE_VAR}\\b`, "i")
/** The compared expression wrapped in a stringification form — `str(...)`, an f-string, `.format(...)`, or `render(...)`. */
const SERIALIZED_COMPARED_EXPRESSION = /\b(?:str\s*\(|f["']|\.format\s*\(|render\s*\()/i
/** A comparison the serialized-form check requires alongside the wrapper — `==`, `!=`, or membership `in`. */
const HAS_COMPARISON = /(==|!=|\bin\b)/

/**
 * RF-4 — detect whether the pinned repro's asserts are shaped over a
 * rendered/serialized surface rather than the API-level value: a substring
 * or `assertIn` membership check against a variable named `html`, `output`,
 * `rendered`, `content`, or `response`, or a compared expression that wraps
 * the value in `str(...)`, an f-string, `.format(...)`, or `render(...)`.
 * Returns the offending line as one-line evidence, or `undefined` when
 * nothing matches — conservative on purpose, only fires on a clear shape
 * (a plain typed-equality assert like `x.max_length == 254` never matches).
 *
 * @sem domain=routing role=repro-judge
 */
export function detectRenderedAssert(reproContent: string): string | undefined {
  for (const rawLine of reproContent.split("\n")) {
    const line = rawLine.trim()
    if (!line) continue
    if (RENDERED_MEMBERSHIP_ASSERT.test(line) || RENDERED_MEMBERSHIP_ASSERT_IN.test(line)) {
      return `substring-membership assert against a rendered value: "${line}"`
    }
    if (SERIALIZED_COMPARED_EXPRESSION.test(line) && HAS_COMPARISON.test(line)) {
      return `assert compares a serialized/rendered form of the value: "${line}"`
    }
  }
  return undefined
}

/**
 * RF-4 — the static gap merged in by `applyRenderedAssertGap` when
 * `detectRenderedAssert` finds a rendered/serialized-surface assert —
 * quotes the seed's own precedence clause (§11 point 2): assert the
 * API-level value, not its rendered form.
 *
 * @sem domain=routing role=repro-judge
 */
export const RENDERED_ASSERT_GAP =
  "assert the API-LEVEL value with == — rendered output hides type differences like '255' vs 255"

/**
 * RF-4 — force a fidelity gap when the pinned script's asserts are
 * rendered/serialized-surface-shaped, regardless of what the LLM judge
 * said: a no-op (same reference returned) when `detectRenderedAssert` finds
 * nothing, otherwise overrides to `faithful:false` with `RENDERED_ASSERT_GAP`
 * appended to any existing gaps and reclamped to `REPRO_FIDELITY_MAX_GAPS`.
 *
 * @sem domain=routing role=repro-judge
 */
export function applyRenderedAssertGap(verdict: ReproFidelityVerdict, reproContent: string): ReproFidelityVerdict {
  if (detectRenderedAssert(reproContent) === undefined) return verdict
  return {
    faithful: false,
    gaps: [...verdict.gaps, RENDERED_ASSERT_GAP].slice(0, REPRO_FIDELITY_MAX_GAPS),
  }
}

/**
 * RF-4 — the §6 issue-derived expected literals absent from the pinned
 * repro's content (plain substring check, case-sensitive) — `undefined`/
 * empty `requiredLiterals` yields no misses. The caller passes these in
 * once the issue-expectations extractor (§6) is wired up.
 *
 * @sem domain=routing role=repro-judge
 */
export function missingRequiredLiterals(
  reproContent: string,
  requiredLiterals: readonly string[] | undefined,
): readonly string[] {
  if (!requiredLiterals || requiredLiterals.length === 0) return []
  return requiredLiterals.filter((literal) => !reproContent.includes(literal))
}

/**
 * RF-4 — force a fidelity gap naming any required literal
 * `missingRequiredLiterals` finds absent from the repro, regardless of what
 * the LLM judge said: a no-op (same reference returned) when nothing is
 * missing, otherwise overrides to `faithful:false` with one gap naming the
 * missing literal(s), appended to any existing gaps and reclamped to
 * `REPRO_FIDELITY_MAX_GAPS`.
 *
 * @sem domain=routing role=repro-judge
 */
export function applyRequiredLiteralsGap(
  verdict: ReproFidelityVerdict,
  reproContent: string,
  requiredLiterals: readonly string[] | undefined,
): ReproFidelityVerdict {
  const missing = missingRequiredLiterals(reproContent, requiredLiterals)
  if (missing.length === 0) return verdict
  return {
    faithful: false,
    gaps: [...verdict.gaps, `repro never asserts the issue-stated literal(s): ${missing.join(", ")}`].slice(
      0,
      REPRO_FIDELITY_MAX_GAPS,
    ),
  }
}
