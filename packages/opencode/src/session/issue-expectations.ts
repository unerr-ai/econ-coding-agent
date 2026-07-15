// Round-F wave, §6 (docs/features/08-signal-bus.md) — pure, mechanical, no LLM.

const MAX_LITERALS = 8
const MIN_VALUE_LEN = 2
const MAX_VALUE_LEN = 120
const MAX_SOURCE_LEN = 160

/** Prose markers that signal a quoted/backticked span nearby is the DESIRED value. */
const EXPECTED_MARKER_RE = /\bexpected\b|\bshould\s+(?:be|return|render|print|produce)\b/gi
/** Prose markers that signal a quoted/backticked span nearby is the CURRENT (buggy) value. */
const ACTUAL_MARKER_RE = /\binstead of\b|\brather than\b|\bgot\b|\bactual\b|\breturns\b/gi

/** A worked-example marker line introducing the DESIRED statement — value is whatever follows the marker's colon on the same line, or, when that's empty, the next non-empty line taken whole (the 12039 shape: a bare unquoted CREATE INDEX line after "The following would be expected:"). */
const EXPECTED_PROSE_BLOCK_RE = /\b(?:would be expected|should be|should generate|expected output)\b.*?:\s*(.*)$/i
/** The CURRENT (buggy) mirror of EXPECTED_PROSE_BLOCK_RE — e.g. "Will generate ... statement:\n<bare buggy line>". */
const ACTUAL_PROSE_BLOCK_RE = /\b(?:instead of|rather than|currently generates?|will generate)\b.*?:\s*(.*)$/i

/** A fenced-code line shaped like an assertion — its quoted/backticked literal(s) are the expected value under test. */
const ASSERTION_LINE_RE = /\bassert\b|assertEqual|==|!=/i
/** A fenced-code line ending in an "expected:"-style header — the NEXT line is taken whole as the expected value. */
const EXPECTED_BLOCK_HEADER_RE = /\b(?:expected(?:\s+output)?|should\s+be)\s*:\s*$/i
/** A fenced-code traceback line naming the raised error class — the final match in the text wins. */
const ERROR_LINE_RE = /^[A-Za-z_][\w.]*(?:Error|Exception)\s*:\s*.+$/

/** Common words that survive quoting/backticking but never name a value — dropped per the conservative extraction rule. */
const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "to", "of", "in", "on", "for",
  "and", "or", "not", "this", "that", "it", "will", "with", "as", "at", "by", "if",
])

/**
 * A single mechanically-extracted issue literal — its value, whether it names
 * the expected value, the current (actual) value, or a raised error, and the
 * trimmed source line it was pulled from. Feeds the repro seed contract, the
 * fidelity judge's required-literal coverage check, and the oracle-inversion
 * detector (§5/§8 of the signal-bus doc).
 *
 * @sem domain=routing role=type
 */
export interface IssueExpectation {
  value: string
  kind: "expected" | "actual" | "error"
  source: string
}

/** True when the trimmed value is a bare single-digit number, a stopword, or outside the 2-120 char window — never a real literal. */
function isValidValue(value: string): boolean {
  if (value.length < MIN_VALUE_LEN || value.length > MAX_VALUE_LEN) return false
  if (/^\d$/.test(value)) return false
  if (STOPWORDS.has(value.toLowerCase())) return false
  return true
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text
}

/** Non-overlapping quoted/backticked spans in one line, in left-to-right order, with their start offset for marker-distance ranking. Backticks are claimed first (an issue author fencing text as code is the strongest signal) so a quote mark inside a backtick span is never re-split. */
function extractLiteralSpans(line: string): Array<{ value: string; start: number }> {
  const spans: Array<{ value: string; start: number }> = []
  const claimed: Array<[number, number]> = []
  const overlapsClaimed = (start: number, end: number) => claimed.some(([cs, ce]) => start < ce && end > cs)

  const backtickRe = /`([^`]+)`/g
  let m: RegExpExecArray | null
  while ((m = backtickRe.exec(line))) {
    spans.push({ value: m[1], start: m.index })
    claimed.push([m.index, m.index + m[0].length])
  }

  const doubleQuoteRe = /"([^"\n]+)"/g
  while ((m = doubleQuoteRe.exec(line))) {
    const end = m.index + m[0].length
    if (overlapsClaimed(m.index, end)) continue
    spans.push({ value: m[1], start: m.index })
    claimed.push([m.index, end])
  }

  const singleQuoteRe = /'([^'\n]+)'/g
  while ((m = singleQuoteRe.exec(line))) {
    const end = m.index + m[0].length
    if (overlapsClaimed(m.index, end)) continue
    spans.push({ value: m[1], start: m.index })
    claimed.push([m.index, end])
  }

  return spans.sort((a, b) => a.start - b.start)
}

function markerPositions(line: string, marker: RegExp): number[] {
  const positions: number[] = []
  const localRe = new RegExp(marker.source, marker.flags)
  let m: RegExpExecArray | null
  while ((m = localRe.exec(line))) positions.push(m.index)
  return positions
}

/** The kind of the nearest marker (by character distance) to a literal span's start, or null when the line carries neither marker type. */
function nearestMarkerKind(
  spanStart: number,
  expectedPositions: number[],
  actualPositions: number[],
): "expected" | "actual" | null {
  let bestKind: "expected" | "actual" | null = null
  let bestDist = Infinity
  for (const p of expectedPositions) {
    const d = Math.abs(p - spanStart)
    if (d < bestDist) {
      bestDist = d
      bestKind = "expected"
    }
  }
  for (const p of actualPositions) {
    const d = Math.abs(p - spanStart)
    if (d < bestDist) {
      bestDist = d
      bestKind = "actual"
    }
  }
  return bestKind
}

/**
 * Conservative, precision-over-recall mechanical extraction of issue-derived
 * expected/actual/error literals — no LLM, no graph. Pulls marker-adjacent
 * quoted/backticked spans from prose ("expected `X`", "actual output `Y`"),
 * assertion-shaped and expected-block lines inside fenced code, prose-marker
 * worked examples whose statement line carries no quotes at all ("The
 * following would be expected:" / "Will generate ...:", 12039's bare
 * CREATE INDEX pair), and the traceback's final error line — deduped and
 * capped at 8 values 2-120 chars long.
 *
 * @sem domain=routing role=analysis
 */
export function extractIssueExpectations(issueText: string): { literals: IssueExpectation[] } {
  const out: IssueExpectation[] = []
  const seen = new Set<string>()

  const add = (rawValue: string, kind: IssueExpectation["kind"], rawSource: string) => {
    if (out.length >= MAX_LITERALS) return
    const value = rawValue.trim()
    if (!isValidValue(value)) return
    if (seen.has(value)) return
    seen.add(value)
    out.push({ value, kind, source: truncate(rawSource.trim(), MAX_SOURCE_LEN) })
  }

  if (!issueText) return { literals: [] }

  const lines = issueText.split("\n")
  let inCodeBlock = false
  let lastErrorLine: string | null = null

  for (let i = 0; i < lines.length && out.length < MAX_LITERALS; i++) {
    const rawLine = lines[i]
    const trimmedLine = rawLine.trim()

    if (trimmedLine.startsWith("```")) {
      inCodeBlock = !inCodeBlock
      continue
    }

    if (inCodeBlock) {
      if (EXPECTED_BLOCK_HEADER_RE.test(trimmedLine) && i + 1 < lines.length) {
        const nextLine = lines[i + 1].trim()
        if (nextLine.length > 0) {
          add(nextLine, "expected", nextLine)
          i++
          continue
        }
      }
      if (ERROR_LINE_RE.test(trimmedLine)) lastErrorLine = trimmedLine
      if (ASSERTION_LINE_RE.test(rawLine)) {
        for (const span of extractLiteralSpans(rawLine)) add(span.value, "expected", trimmedLine)
      }
      continue
    }

    // Prose-marker worked example: "The following would be expected:" / "Will
    // generate ... statement:" introducing a bare (unquoted) statement line —
    // the 12039 shape a quoted/backticked-span scan below never sees.
    const expectedBlock = trimmedLine.match(EXPECTED_PROSE_BLOCK_RE)
    const actualBlock = expectedBlock ? null : trimmedLine.match(ACTUAL_PROSE_BLOCK_RE)
    if (expectedBlock || actualBlock) {
      const blockKind: IssueExpectation["kind"] = expectedBlock ? "expected" : "actual"
      const inlineValue = (expectedBlock ?? actualBlock)![1].trim()
      if (inlineValue) {
        add(inlineValue, blockKind, trimmedLine)
        continue
      }
      const nextLine = i + 1 < lines.length ? lines[i + 1].trim() : ""
      if (nextLine.length > 0 && !nextLine.startsWith("```")) {
        add(nextLine, blockKind, `${trimmedLine} ${nextLine}`)
        i++
        continue
      }
    }

    const spans = extractLiteralSpans(rawLine)
    if (spans.length === 0) continue
    const expectedPositions = markerPositions(rawLine, EXPECTED_MARKER_RE)
    const actualPositions = markerPositions(rawLine, ACTUAL_MARKER_RE)
    if (expectedPositions.length === 0 && actualPositions.length === 0) continue
    for (const span of spans) {
      const kind = nearestMarkerKind(span.start, expectedPositions, actualPositions)
      if (!kind) continue
      add(span.value, kind, trimmedLine)
    }
  }

  if (lastErrorLine) add(lastErrorLine, "error", lastErrorLine)

  return { literals: out.slice(0, MAX_LITERALS) }
}

const MAX_THRESHOLDS = 3
const MAX_QUOTE_LEN = 200

/** A numeric-boundary rule word — without one of these in the SAME sentence as the number, a threshold pattern is just an example count, never a stated rule. */
const RULE_FORCE_RE = /\b(?:must|should|interpret|treat|consider|required)\b/i
/** A stated numeric boundary: "more than/at least/less than/over N" or "N or more". Group 1 or group 2 holds the digits depending on which side of the alternation matched. */
const THRESHOLD_VALUE_RE = /\b(?:more than|at least|less than|over)\s+(\d+)\b|\b(\d+)\s+or\s+more\b/gi

/** The [start, end) offsets of the sentence containing `index` — bounded by the nearest ".", "!", "?", or ":" on either side (":" only opens a sentence, so a lead-in like "the following quote:" doesn't drag the whole preceding paragraph into the match). Whitespace (including hard line-wraps mid-sentence, as RFC 7231 prose does) is assumed already collapsed by the caller. */
function sentenceBounds(text: string, index: number): { start: number; end: number } {
  let start = 0
  for (const ch of [".", "!", "?", ":"]) {
    const p = text.lastIndexOf(ch, index)
    if (p + 1 > start) start = p + 1
  }
  let end = text.length
  for (const ch of [".", "!", "?"]) {
    const p = text.indexOf(ch, index)
    if (p !== -1 && p + 1 < end) end = p + 1
  }
  return { start, end }
}

/**
 * A stated numeric-boundary rule pulled from issue prose — its value and the
 * containing sentence, quoted verbatim. Feeds the fidelity judge's
 * required-coverage list alongside `IssueExpectation` (11848's RFC 7231
 * "more than 50 years ... MUST interpret" two-digit-year rule).
 *
 * @sem domain=routing role=type
 */
export interface IssueThreshold {
  readonly value: number
  readonly quote: string
}

/**
 * Conservative extraction of stated numeric threshold/boundary rules: a
 * "more than/at least/less than/over N" or "N or more" match only counts
 * when its own sentence also carries rule-force wording (MUST/should/
 * interpret/treat/consider/required) — an incidental count never qualifies.
 * Deduped by value and capped at 3. No LLM, no graph.
 *
 * @sem domain=routing role=analysis
 */
export function extractIssueThresholds(issueText: string): readonly IssueThreshold[] {
  if (!issueText) return []
  const flattened = issueText.replace(/\s+/g, " ")
  const out: IssueThreshold[] = []
  const seen = new Set<number>()

  const re = new RegExp(THRESHOLD_VALUE_RE.source, THRESHOLD_VALUE_RE.flags)
  let m: RegExpExecArray | null
  while ((m = re.exec(flattened))) {
    if (out.length >= MAX_THRESHOLDS) break
    const value = Number(m[1] ?? m[2])
    if (!Number.isFinite(value) || seen.has(value)) continue
    const { start, end } = sentenceBounds(flattened, m.index)
    const sentence = flattened.slice(start, end).trim()
    if (!RULE_FORCE_RE.test(sentence)) continue
    seen.add(value)
    out.push({ value, quote: truncate(sentence, MAX_QUOTE_LEN) })
  }

  return out
}

/**
 * The oracle-inversion verdict (§5): whether a failing assertion's output
 * shows the code PRODUCING the issue's stated desired value while the
 * assertion still expects the value the issue calls wrong — the 11815 trap
 * where the pin-green pressure chain rejects the gold-equivalent fix.
 *
 * @sem domain=routing role=type
 */
export interface OracleInversionVerdict {
  inverted: boolean
  /** The issue-stated desired literal found on the failure's produced side. */
  desiredLiteral?: string
  /** The issue-stated buggy literal the failing assertion still expects. */
  buggyLiteral?: string
}

/** A red-tail line that is part of an assertion-comparison failure (unittest one-line `X != Y`, pytest `E assert`, or the unified-diff pair unittest prints for long strings). */
const COMPARISON_FAILURE_RE = /AssertionError|assertEqual|^\s*E?\s*assert\b|!=|^\s*[-+]\s/m

/** An enum subscript-form reference (`X['NAME']` / `X["NAME"]`) — the form-class rung's signal that an expected literal names the desired (name-form) serialization. */
const SUBSCRIPT_FORM_RE = /\b([A-Za-z_][A-Za-z0-9_]*)\[(['"])[^'"\]]+\2\]/

/**
 * Two-rung ordering heuristic over the M4 gate's red output tail.
 *
 * Rung 1 (literal, always runs first): inversion is declared only when (a)
 * the tail is a comparison failure — a crash or import error never
 * qualifies, (b) BOTH an issue-stated desired ("expected"-kind) literal AND
 * an issue-stated buggy ("actual"-kind) literal appear inside the assertion
 * region, and (c) the desired literal appears FIRST — unittest and pytest
 * print the computed/produced side before the assertion's expectation
 * (`AssertionError: <computed> != <expected>`, diff `-` line = first arg),
 * so desired-before-buggy means the fix already produces what the issue
 * asked for and the visible test encodes the bug.
 *
 * Rung 2 (form-class, gated on `opts.fromTrackedSuite === true`, tried only
 * when rung 1 found nothing): covers the django-11815 shape where the issue
 * extractor stores a single expected-kind literal in enum subscript form
 * (`X['NAME']`) with no "actual"-kind counterpart, so rung 1 is structurally
 * blind. The gate is PROVENANCE: the red must come from a COMMITTED tracked
 * visible test — an F16-promoted pin (a previously-green tracked neighbor)
 * or an F18 seen-red whose command targets the committed suite — so when
 * the region shows the SAME trailing identifier in both subscript form and
 * call form (`X('value')`), the fix already produces the issue-desired form
 * while the committed test still expects the value form. Never runs on the
 * agent's own scratch repro, which legitimately expects the desired form
 * ahead of an unfixed producer.
 *
 * Any ambiguity on either rung (missing side, no comparison shape, tie, no
 * qualifying identifier) returns inverted:false — the gate then behaves
 * exactly as before round F/G.
 *
 * @sem domain=routing role=analysis
 */
export function detectOracleInversion(
  redOutputTail: string | undefined,
  literals: readonly IssueExpectation[],
  opts?: { fromTrackedSuite?: boolean },
): OracleInversionVerdict {
  if (!redOutputTail) return { inverted: false }
  const desired = literals.filter((l) => l.kind === "expected")
  const buggy = literals.filter((l) => l.kind === "actual")

  const lines = redOutputTail.split("\n")
  const firstComparisonLine = lines.findIndex((line) => COMPARISON_FAILURE_RE.test(line))
  if (firstComparisonLine < 0) return { inverted: false }
  const assertionRegion = lines.slice(firstComparisonLine).join("\n")

  if (desired.length > 0 && buggy.length > 0) {
    const firstIndexOf = (candidates: readonly IssueExpectation[]): { index: number; value: string } | null => {
      let best: { index: number; value: string } | null = null
      for (const candidate of candidates) {
        const index = assertionRegion.indexOf(candidate.value)
        if (index >= 0 && (best === null || index < best.index)) best = { index, value: candidate.value }
      }
      return best
    }

    const desiredHit = firstIndexOf(desired)
    const buggyHit = firstIndexOf(buggy)
    if (desiredHit && buggyHit && desiredHit.index < buggyHit.index) {
      return { inverted: true, desiredLiteral: desiredHit.value, buggyLiteral: buggyHit.value }
    }
  }

  if (opts?.fromTrackedSuite !== true) return { inverted: false }

  // Form-class rung (django-11815): a tracked committed test carried these
  // expectations before this turn, so if the region shows the SAME identifier
  // in both the issue's subscript form and a value-call form, the assertion —
  // not the fix — is stale. Gated to tracked-suite provenance only; an
  // agent's own fresh repro expecting the desired form ahead of an unfixed
  // producer is normal, not inversion.
  const hasSubscriptDesired = desired.some((l) => SUBSCRIPT_FORM_RE.test(l.value))
  if (!hasSubscriptDesired) return { inverted: false }

  const subscriptMatches = [...assertionRegion.matchAll(new RegExp(SUBSCRIPT_FORM_RE.source, "g"))]
  for (const match of subscriptMatches) {
    const ident = match[1]
    const callFormRe = new RegExp(`(?:[A-Za-z_][\\w.]*\\.)?\\b${ident}\\((['"])[^'"]*\\1\\)`)
    const callMatch = assertionRegion.match(callFormRe)
    // Same produced-side-prints-first heuristic as rung 1: the subscript
    // (desired-form) instance must appear BEFORE the call-form instance —
    // call-form-first means the code is still PRODUCING the value form and
    // the expectation is the desired form, i.e. the test agrees with the
    // issue and the fix is simply wrong; never inversion.
    if (callMatch && callMatch.index !== undefined && (match.index ?? 0) < callMatch.index) {
      return { inverted: true, desiredLiteral: match[0], buggyLiteral: callMatch[0] }
    }
  }
  return { inverted: false }
}
