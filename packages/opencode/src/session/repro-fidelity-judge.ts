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
 * (§6, `requiredLiterals`) the repro never asserts. RF-5 adds a third
 * deterministic tooth of the same shape — `detectStringifiedMirrorAssert` +
 * `applyStringifiedMirrorGap` catch an assert whose EXPECTED side is
 * coerced through `str(...)` (django-11790: the repro's own pinned assert
 * stringified the mirror and a `str()` fix passed it while the hidden
 * test's typed assert then failed) — plus an optional `statedRules` rubric
 * threaded through `runReproFidelityJudge` that asks the judge to check
 * both sides of an issue-stated numeric boundary are exercised. RF-8 adds a
 * fifth tooth for the same repro's later evasion: after a fidelity nudge,
 * the agent rewrote the pinned assert into `if`/`failures.append` form,
 * dodging every assert-anchored detector above. `detectNumericStringConflict`
 * is shape-independent — it flags a quoted pure-integer literal (`'150'`)
 * compared/assertEqual'd on one line while the same digit sequence appears
 * bare elsewhere in the script, the internal type conflict a `str()` fix
 * cannot resolve. `applyNumericStringConflictGap` merges it the same way as
 * RF-5, and `detectTypeUnfaithfulRepro` composes the two into the
 * high-precision subset a finish-time re-check can safely gate on.
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
 * directly, `runReproFidelityJudge` itself never consumes it. The optional
 * `statedRules` (issue-stated numeric boundary rules, e.g. django-11848's
 * "more than 50 years in the future") IS consumed by `runReproFidelityJudge`
 * itself — rendered into the judge prompt as a rubric asking it to check
 * both sides of each boundary are exercised; absent/empty changes nothing.
 *
 * @sem domain=routing role=repro-judge
 */
export interface RunReproFidelityJudgeInput {
  readonly issueText: string
  readonly reproContent: string
  readonly complete: ReproFidelityComplete
  readonly requiredLiterals?: readonly string[]
  readonly statedRules?: readonly string[]
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
 * Render the optional `statedRules` rubric block appended to the judge
 * prompt — one instruction covering every quoted rule, asking the judge to
 * check both sides of each issue-stated numeric boundary are exercised.
 * Returns `""` when `statedRules` is absent/empty, so the prompt is
 * byte-for-byte unchanged for callers that never pass it.
 */
function renderStatedRulesRubric(statedRules: readonly string[] | undefined): string {
  if (!statedRules || statedRules.length === 0) return ""
  const quoted = statedRules.map((rule) => `- "${rule}"`).join("\n")
  return (
    `\n\n## Stated boundary rules\n` +
    `The issue states these numeric boundary rules. For each, a faithful repro must ` +
    `assert behavior on BOTH sides of the stated boundary; if it exercises only one ` +
    `side (or neither), report a gap naming the missing side.\n${quoted}`
  )
}

/**
 * Run the repro-fidelity judge: ONE forced-JSON completion checking the
 * pinned repro's asserts against the issue text — no retry, this fires at
 * most once per turn (the caller enforces that). When `statedRules` is
 * non-empty, the prompt gains a rubric section naming each rule (pure
 * plumbing — no new call, no behavior change when absent/empty). A thrown
 * `complete`, or any parse failure, degrades to `DEGRADED_REPRO_FIDELITY`
 * (assume faithful) — never blocks the pin, never throws.
 *
 * @sem domain=routing role=repro-judge
 */
export async function runReproFidelityJudge(input: RunReproFidelityJudgeInput): Promise<ReproFidelityVerdict> {
  const { issueText, reproContent, complete, statedRules } = input
  let raw: string
  try {
    raw = await complete({
      system: REPRO_FIDELITY_SYSTEM_PROMPT,
      user: `## Issue\n${issueText}\n\n## Pinned reproduction\n${reproContent}${renderStatedRulesRubric(statedRules)}`,
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

/** Locates a single `assertEqual`/`assertNotEqual(` call — the gate for both the assertion-line check and the arg extractor below. */
const ASSERT_EQUAL_CALL = /\bassert(?:Not)?Equal\s*\(/
/** `== str(` or `!= str(` anywhere on the line — the expected side of a comparison coerced to a string. */
const STRINGIFIED_EXPECTED_SIDE = /(?:==|!=)\s*\bstr\(/

/**
 * Extract the two comma-separated arguments of a single assertEqual/
 * assertNotEqual(...) call on one line, tracking paren/bracket depth so a
 * nested `str(...)` call or a `[...]` subscript doesn't split at the wrong
 * comma. Returns `undefined` when the line has no such call or its
 * parens/brackets don't balance.
 */
function extractAssertEqualArgs(line: string): [string, string] | undefined {
  const match = ASSERT_EQUAL_CALL.exec(line)
  if (!match) return undefined
  const start = match.index + match[0].length
  let depth = 1
  let commaIndex = -1
  let end = -1
  for (let i = start; i < line.length; i++) {
    const ch = line[i]
    if (ch === "(" || ch === "[") depth++
    else if (ch === ")" || ch === "]") {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    } else if (ch === "," && depth === 1 && commaIndex === -1) {
      commaIndex = i
    }
  }
  if (commaIndex === -1 || end === -1) return undefined
  return [line.slice(start, commaIndex).trim(), line.slice(commaIndex + 1, end).trim()]
}

/**
 * Extract the two operands of a plain `assert A == B` / `assert A != B`
 * statement — the assert-statement form `extractAssertEqualArgs` does NOT
 * cover (that one is for `assertEqual(...)`/`assertNotEqual(...)` calls).
 * Splits on the first top-level `==`/`!=` (bracket depth 0), then drops a
 * trailing `, "<message>"` off the RHS. Returns `undefined` when the line is
 * not a plain `assert` comparison.
 */
function extractAssertComparisonSides(line: string): [string, string] | undefined {
  if (!/^assert\s/.test(line)) return undefined
  const body = line.replace(/^assert\s+/, "")
  let depth = 0
  let opIndex = -1
  for (let i = 0; i < body.length - 1; i++) {
    const ch = body[i]
    if (ch === "(" || ch === "[" || ch === "{") depth++
    else if (ch === ")" || ch === "]" || ch === "}") depth--
    else if (depth === 0 && (body.slice(i, i + 2) === "==" || body.slice(i, i + 2) === "!=")) {
      opIndex = i
      break
    }
  }
  if (opIndex === -1) return undefined
  const lhs = body.slice(0, opIndex).trim()
  let rhs = body.slice(opIndex + 2)
  let d = 0
  for (let i = 0; i < rhs.length; i++) {
    const ch = rhs[i]
    if (ch === "(" || ch === "[" || ch === "{") d++
    else if (ch === ")" || ch === "]" || ch === "}") d--
    else if (ch === "," && d === 0) {
      rhs = rhs.slice(0, i)
      break
    }
  }
  return [lhs, rhs.trim()]
}

/** Whether `arg` is a bare `str(...)` wrap — the coercion side of the stringified-mirror pattern. */
function isStrWrap(arg: string): boolean {
  return /^str\(.*\)$/.test(arg)
}

/** Whether `arg` is a bare string/number literal — never the "typed source" side of the pattern. */
function isLiteral(arg: string): boolean {
  return /^['"]/.test(arg) || /^-?\d+(?:\.\d+)?$/.test(arg)
}

/** Whether `arg` is an attribute/subscript access chain (`x.y`, `x['y']`) and not a literal. */
function isAttrOrSubscriptChain(arg: string): boolean {
  return (arg.includes(".") || arg.includes("[")) && !isLiteral(arg)
}

/**
 * RF-5 — detect whether an assertion line's EXPECTED side is coerced to a
 * string instead of comparing the typed source value directly: a plain
 * `assert x == str(y)` / `assert x != str(y)`, or an `assertEqual(A, B)` /
 * `assertNotEqual(A, B)` where one arg is `str(<chain>)` and the other is an
 * attribute/subscript access chain (not a literal). Also resolves ONE hop of
 * variable indirection: an `expected = str(<chain>)` binding followed by a
 * plain `assert <chain> == expected` — django-11790's evasion draw pinned
 * exactly this aliased form to keep `str(` off the assertion line, while a
 * `str()` source fix passed it and the hidden test's typed assert then failed.
 * Returns the offending line, trimmed, or `undefined` when nothing matches.
 * Conservative on purpose: stringifying the SUBJECT under test
 * (`assert str(x) == '1'`, `assertEqual(str(member), 'value')`, or the aliased
 * `actual = str(member); assert actual == '1'`) is legitimate
 * `__str__`/rendering coverage and never fires — the literal side is not an
 * attribute/subscript chain, so the asymmetric guard stays silent — and a bare
 * `str(` outside an assert/assertEqual/assertNotEqual line (a print, an
 * f-string) never fires either.
 *
 * @sem domain=routing role=repro-judge
 */
export function detectStringifiedMirrorAssert(reproContent: string): string | undefined {
  const lines = reproContent.split("\n")
  // One-hop indirection: identifiers bound to a bare `str(...)` wrap
  // (`expected = str(field.max_length)`), so an assert comparing that alias
  // against a typed chain (`assert attr == expected`) is caught the same as
  // the inline `== str(...)` form.
  const strAliases = new Set<string>()
  for (const rawLine of lines) {
    const bind = /^(\w+)\s*=\s*(str\(.*\))$/.exec(rawLine.trim())
    if (bind && isStrWrap(bind[2])) strAliases.add(bind[1])
  }
  const isStrOrAlias = (arg: string) => isStrWrap(arg) || strAliases.has(arg)

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    const isAssertionLine = /^assert\s+/.test(line) || ASSERT_EQUAL_CALL.test(line)
    if (!isAssertionLine) continue

    if (STRINGIFIED_EXPECTED_SIDE.test(line)) return line

    const args = extractAssertEqualArgs(line) ?? extractAssertComparisonSides(line)
    if (!args) continue
    const [first, second] = args
    if ((isStrOrAlias(first) && isAttrOrSubscriptChain(second)) || (isStrOrAlias(second) && isAttrOrSubscriptChain(first))) {
      return line
    }
  }
  return undefined
}

/**
 * RF-5 — the static explanation appended after the offending line in the
 * gap `applyStringifiedMirrorGap` merges — demands the typed source value
 * over a stringified mirror of it.
 *
 * @sem domain=routing role=repro-judge
 */
export const STRINGIFIED_MIRROR_GAP =
  "assert the typed source value instead (e.g. == field.max_length, the int), never str(...) of it; string coercion hides exactly the type difference hidden tests assert."

/**
 * RF-5 — force a fidelity gap when the pinned script's asserts stringify
 * the expected side of a typed comparison, regardless of what the LLM judge
 * said: a no-op (same reference returned) when `detectStringifiedMirrorAssert`
 * finds nothing, otherwise overrides to `faithful:false` with a gap naming
 * the offending line verbatim, PREPENDED to any existing gaps (deduped
 * against an identical gap already present anywhere in the list) and
 * reclamped to `REPRO_FIDELITY_MAX_GAPS` — as the outermost tooth in the
 * verdict chain this one must survive the cap, so it goes first and lets
 * earlier teeth's gaps be the ones evicted.
 *
 * @sem domain=routing role=repro-judge
 */
export function applyStringifiedMirrorGap(verdict: ReproFidelityVerdict, reproContent: string): ReproFidelityVerdict {
  const line = detectStringifiedMirrorAssert(reproContent)
  if (line === undefined) return verdict
  const gap = `your repro asserts a STRINGIFIED mirror (\`${line}\`) — ${STRINGIFIED_MIRROR_GAP}`
  if (verdict.gaps.includes(gap)) return verdict
  return {
    faithful: false,
    gaps: [gap, ...verdict.gaps].slice(0, REPRO_FIDELITY_MAX_GAPS),
  }
}

/** A `==`/`!=` comparison operator — half the gate (alongside an assertEqual/assertNotEqual call) for the numeral/string conflict check below. */
const EQUALITY_OP = /==|!=/
/** A full quoted token that is ONLY digits — `'150'`, `"254"` — never `'3.9'`, `'"name" DESC'`, `'foo'`; the "compared as a string" side of the conflict. */
const QUOTED_PURE_INT = /(['"])(\d+)\1/
/** Lines protected from the check below — subject-stringify (`assert str(choice) == '1'`) and repr shapes are the desired discriminator for enum/repr bugs, never flagged. */
const NUMERIC_CONFLICT_PROTECTED = /\bstr\(|repr\(|!r|%r/

/** Blank out quoted string literals (no escape handling, same simplicity as the rest of this file) so a digit-sequence match afterward is guaranteed to be a BARE token, never one living inside a string literal. */
function stripQuotedLiterals(content: string): string {
  return content.replace(/'[^'\n]*'|"[^"\n]*"/g, (quoted) => " ".repeat(quoted.length))
}

/**
 * RF-8 — detect a comparison that asserts a numeral as a STRING on one line
 * while the same digit sequence is compared/assigned/passed as a BARE
 * integer elsewhere in the repro: a `==`/`!=` comparison (or an
 * `assertEqual`/`assertNotEqual(` call) whose one side is a full quoted
 * pure-integer token (`'150'`, never `'3.9'` or `'"name" DESC'`), where that
 * same digit sequence also appears, unquoted and word-boundary-matched,
 * anywhere else in the script — django-11790's final pinned repro, rewritten
 * to `if`/`failures.append` after a fidelity nudge specifically to dodge
 * every assert-anchored detector in this file: `if field.max_length != 150`
 * (bare int) alongside `if widget.attrs.get('maxlength') != '150'` (the same
 * numeral, quoted) is exactly the internal type conflict the hidden test's
 * typed assert catches and a `str()` source fix does not. Works on any line
 * shape (if-condition, assert, unittest call) — that is the point, since the
 * evasion was structural, not assert-specific. Skips a line containing
 * `str(`, `repr(`, `!r`, or `%r` — stringifying the SUBJECT
 * (`assert str(choice) == '1'`) is the desired shape for enum/repr coverage
 * and never fires. Returns a message naming both the quoted-side line and
 * the bare-int line it conflicts with, verbatim, or `undefined` when nothing
 * matches. Known limitation (accepted): relatedness of the two occurrences is
 * approximated by whole-repro digit co-occurrence, so two genuinely unrelated
 * values sharing a numeral (`status_code == '200'` + `bytes_written = 200`)
 * can trip it — a same-variable requirement would MISS 11790, whose conflict
 * spans different attributes (`field.max_length` vs `attrs['maxlength']`). The
 * cost of a false positive is bounded: the finish re-check denies once with a
 * nudge and then passes loud, never a wrong verdict.
 *
 * @sem domain=routing role=repro-judge
 */
export function detectNumericStringConflict(reproContent: string): string | undefined {
  const rawLines = reproContent.split("\n")
  const strippedLines = rawLines.map(stripQuotedLiterals)
  const strippedContent = strippedLines.join("\n")

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i].trim()
    if (!line) continue
    if (NUMERIC_CONFLICT_PROTECTED.test(line)) continue
    if (!EQUALITY_OP.test(line) && !ASSERT_EQUAL_CALL.test(line)) continue

    const quotedIntPattern = new RegExp(QUOTED_PURE_INT.source, "g")
    let match: RegExpExecArray | null
    while ((match = quotedIntPattern.exec(line)) !== null) {
      const digits = match[2]
      const bareRegex = new RegExp(`\\b${digits}\\b`)
      if (!bareRegex.test(strippedContent)) continue
      const bareLineIndex = strippedLines.findIndex((stripped, idx) => idx !== i && bareRegex.test(stripped))
      const bareLine = (bareLineIndex === -1 ? rawLines[i] : rawLines[bareLineIndex]).trim()
      return `type conflict: "${line}" asserts ${digits} as a STRING, while "${bareLine}" compares the same ${digits} as a bare integer`
    }
  }
  return undefined
}

/**
 * RF-8 — the static explanation appended after `detectNumericStringConflict`'s
 * message in the gap `applyNumericStringConflictGap` merges — same
 * discriminator as `STRINGIFIED_MIRROR_GAP`: assert the typed value against
 * its natural source, not the quoted numeral.
 *
 * @sem domain=routing role=repro-judge
 */
export const NUMERIC_STRING_CONFLICT_GAP =
  "the quoted-numeral side asserts the STRING representation; assert the typed value against its natural source instead (e.g. == field.max_length, not == '150')."

/**
 * RF-8 — force a fidelity gap when the pinned script asserts the same
 * numeral as a string on one line and a bare integer on another, regardless
 * of what the LLM judge said: a no-op (same reference returned) when
 * `detectNumericStringConflict` finds nothing, otherwise overrides to
 * `faithful:false` with a gap naming the conflict verbatim, PREPENDED to any
 * existing gaps (deduped against an identical gap already present anywhere
 * in the list) and reclamped to `REPRO_FIDELITY_MAX_GAPS` — same prepend
 * pattern as `applyStringifiedMirrorGap` so its gap survives the cap; chained
 * outside it, this is the new outermost tooth.
 *
 * @sem domain=routing role=repro-judge
 */
export function applyNumericStringConflictGap(
  verdict: ReproFidelityVerdict,
  reproContent: string,
): ReproFidelityVerdict {
  const conflict = detectNumericStringConflict(reproContent)
  if (conflict === undefined) return verdict
  const gap = `${conflict} — ${NUMERIC_STRING_CONFLICT_GAP}`
  if (verdict.gaps.includes(gap)) return verdict
  return {
    faithful: false,
    gaps: [gap, ...verdict.gaps].slice(0, REPRO_FIDELITY_MAX_GAPS),
  }
}

/**
 * RF-8 — the finish-time re-check's HIGH-PRECISION composite:
 * `detectStringifiedMirrorAssert(reproContent) ?? detectNumericStringConflict(reproContent)`.
 * Both are structural, assert-shape-independent conflicts between a typed
 * value and its stringified mirror. The rendered/serialized-surface (RF-4)
 * and assertion-teeth (F14b) classes are deliberately excluded here — a
 * repro may legitimately assert rendered output when the issue IS about
 * rendered output (e.g. a SQL-string DDL bug), so those stay judge-only /
 * pin-time-only rather than blocking a finish.
 *
 * @sem domain=routing role=repro-judge
 */
export function detectTypeUnfaithfulRepro(reproContent: string): string | undefined {
  return detectStringifiedMirrorAssert(reproContent) ?? detectNumericStringConflict(reproContent)
}
