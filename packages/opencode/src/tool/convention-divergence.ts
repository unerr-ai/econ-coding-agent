/**
 * Wave-11 stage 1+2: a pure, language-agnostic detector for the "established
 * receiver, novel method" shape (an agent adding `datetime.datetime.now()`
 * beside a file's existing `datetime.datetime(...)` constructor calls, never
 * noticing the file's own `.now()`-free history or
 * the disambiguating docstring nearby), plus the pure gate decision and
 * per-session deny-once store that wire it into edit.ts/write.ts's edit
 * path. It never knows or names the right answer — it only flags that a
 * bounded re-read of the receiver's existing uses is warranted before the
 * edit lands.
 *
 * @sem domain=intelligence role=analysis
 */

export interface ReceiverMethodDivergence {
  receiver: string
  method: string
  receiverSites: number[]
}

const IDENT = String.raw`[A-Za-z_]\w*`
const STOP_RECEIVERS = new Set(["self", "cls", "this"])
const RECEIVER_SITE_CAP = 3
const MIN_METHOD_LEN = 3

/** Strip a trailing line comment (`#` or `//`, whichever starts first) — line-level only, no string-literal awareness. */
function stripLineComment(line: string): string {
  const hashIdx = line.indexOf("#")
  const slashIdx = line.indexOf("//")
  const idx = hashIdx >= 0 && slashIdx >= 0 ? Math.min(hashIdx, slashIdx) : Math.max(hashIdx, slashIdx)
  return idx >= 0 ? line.slice(0, idx) : line
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Every `R.m(` dotted-receiver call found in `text`, comment-stripped, line by line. */
function findReceiverMethodCalls(text: string): Array<{ receiver: string; method: string }> {
  const receiverCallRe = new RegExp(String.raw`\b((?:${IDENT}\.)+)(${IDENT})\(`, "g")
  const found: Array<{ receiver: string; method: string }> = []
  for (const rawLine of text.split("\n")) {
    const line = stripLineComment(rawLine)
    receiverCallRe.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = receiverCallRe.exec(line))) {
      found.push({ receiver: m[1].slice(0, -1), method: m[2] })
    }
  }
  return found
}

/** Line numbers (1-based, capped) where `beforeLines` calls `receiver` with a method other than `method`, or invokes `receiver(` directly. */
function receiverSitesInBefore(beforeLines: string[], receiver: string, method: string): number[] {
  const escaped = escapeRegex(receiver)
  const otherMethodCallRe = new RegExp(String.raw`\b${escaped}\.${IDENT}\(`)
  const directCallRe = new RegExp(String.raw`\b${escaped}\(`)
  const sites: number[] = []
  for (let i = 0; i < beforeLines.length && sites.length < RECEIVER_SITE_CAP; i++) {
    const line = beforeLines[i]
    if (otherMethodCallRe.test(line) || directCallRe.test(line)) sites.push(i + 1)
  }
  return sites
}

/**
 * Detects the first added `R.m(` dotted-receiver call whose receiver `R` is
 * already established elsewhere in `beforeContent` (another method call or a
 * direct `R(` invocation) but whose exact `R.m(` pairing never occurs there —
 * an established receiver's usage surface extended with a method the file
 * never called, the tell that nearby in-file evidence deserves a re-read.
 * Language-agnostic: matches the dotted-receiver call shape alone (no
 * per-file-extension or per-syntax tuning), strips `#`/`//` line comments at
 * line level, and excludes self/cls/this receivers. Returns the first
 * divergence found, or null.
 *
 * @sem domain=intelligence role=analysis
 */
export function detectReceiverMethodDivergence(input: {
  beforeContent: string
  addedText: string
}): ReceiverMethodDivergence | null {
  const { beforeContent, addedText } = input
  const beforeLines = beforeContent.split("\n").map(stripLineComment)
  const addedCalls = findReceiverMethodCalls(addedText)

  for (const { receiver, method } of addedCalls) {
    if (method.length < MIN_METHOD_LEN) continue
    const firstSegment = receiver.split(".")[0]
    if (STOP_RECEIVERS.has(firstSegment)) continue

    const exactCallRe = new RegExp(String.raw`\b${escapeRegex(receiver)}\.${escapeRegex(method)}\(`)
    if (beforeLines.some((line) => exactCallRe.test(line))) continue // R.m( already present — not a divergence

    const receiverSites = receiverSitesInBefore(beforeLines, receiver, method)
    if (receiverSites.length === 0) continue // receiver never established in this file — not a divergence

    return { receiver, method, receiverSites }
  }
  return null
}

/** Lines present in `after` but not in `before` — a line-set difference (not a true diff), joined back into a newline-separated string so the result feeds `detectReceiverMethodDivergence`'s `addedText` param directly. */
export function addedLines(before: string, after: string): string {
  const beforeSet = new Set(before.split("\n"))
  return after
    .split("\n")
    .filter((line) => !beforeSet.has(line))
    .join("\n")
}

// ---------------------------------------------------------------------------
// Round-F §7 stage 3 — semantic method families: methods that are mutually
// ambiguous variants of the same idea (datetime.datetime's
// now()/utcnow() differ only in timezone) so an identical retry past the
// first deny gets one more evidence-bearing check before it is allowed to
// pass silently.
// ---------------------------------------------------------------------------

/** Known ambiguous semantic families, keyed by family name — exported so tests (and future family additions) can assert membership directly instead of re-deriving it. */
export const SEMANTIC_METHOD_FAMILIES: Record<string, readonly string[]> = {
  "time/tz": ["now", "utcnow", "localtime", "today"],
}

/** The family `method` belongs to, or null if it isn't a known ambiguous variant. */
function familyOf(method: string): string | null {
  for (const family of Object.keys(SEMANTIC_METHOD_FAMILIES)) {
    if (SEMANTIC_METHOD_FAMILIES[family].includes(method)) return family
  }
  return null
}

/** Line numbers (1-based, capped) where comment-stripped `beforeLines` calls `receiver.method(`. */
function memberCallSites(beforeLines: string[], receiver: string, method: string): number[] {
  const callRe = new RegExp(String.raw`\b${escapeRegex(receiver)}\.${escapeRegex(method)}\(`)
  const sites: number[] = []
  for (let i = 0; i < beforeLines.length && sites.length < RECEIVER_SITE_CAP; i++) {
    if (callRe.test(beforeLines[i])) sites.push(i + 1)
  }
  return sites
}

/** Per-line "is this a comment or inside a docstring block" flag for RAW (comment-intact) `beforeLines` — tracks `#`/`//` full-line comments plus `"""`/`'''` triple-quote block state across lines, so a token inside a multi-line docstring BODY ("...in UTC." appearing mid-docstring, not on the opening-quote line) is still found. */
function commentOrDocstringLineFlags(beforeLines: string[]): boolean[] {
  const flags = new Array<boolean>(beforeLines.length).fill(false)
  let openTriple: string | null = null
  for (let i = 0; i < beforeLines.length; i++) {
    const line = beforeLines[i]
    if (openTriple) {
      flags[i] = true
      if (line.includes(openTriple)) openTriple = null
      continue
    }
    if (line.trim().length > 0 && stripLineComment(line).trim().length === 0) flags[i] = true
    const marker = line.includes('"""') ? '"""' : line.includes("'''") ? "'''" : null
    if (marker) {
      flags[i] = true
      const closesOnSameLine = line.indexOf(marker, line.indexOf(marker) + marker.length) !== -1
      if (!closesOnSameLine) openTriple = marker
    }
  }
  return flags
}

const FAMILY_DOCSTRING_TOKEN = "UTC"

/** Opposite-member evidence for a divergence whose method belongs to a known ambiguous semantic family — either another family member's call-site line numbers on the same receiver, or the docstring/comment disambiguating token. */
export interface FamilyConflictEvidence {
  family: string
  kind: "call" | "docstring"
  member?: string
  lines?: number[]
  token?: string
}

/**
 * Round-F §7 stage 3 — the convention-divergence gate's evidence-bearing
 * second rung: on an identical retry past the first deny, this decides
 * whether the file itself corroborates that the two family members are NOT
 * interchangeable here — an existing call to another family member on the
 * same receiver, or the disambiguating "UTC" token on a comment/docstring
 * line anywhere in the file (the file's own docstring
 * already said UTC). Pure and bounded — no family match or no evidence
 * returns null, and the gate then passes on retry exactly as it did before
 * round F.
 *
 * @sem domain=intelligence role=analysis
 */
export function detectFamilyConflictEvidence(input: {
  beforeContent: string
  receiver: string
  method: string
}): FamilyConflictEvidence | null {
  const family = familyOf(input.method)
  if (family === null) return null

  const beforeLinesRaw = input.beforeContent.split("\n")
  const beforeLinesStripped = beforeLinesRaw.map(stripLineComment)

  for (const member of SEMANTIC_METHOD_FAMILIES[family]) {
    if (member === input.method) continue
    const lines = memberCallSites(beforeLinesStripped, input.receiver, member)
    if (lines.length > 0) return { family, kind: "call", member, lines }
  }

  const docFlags = commentOrDocstringLineFlags(beforeLinesRaw)
  for (let i = 0; i < beforeLinesRaw.length; i++) {
    if (docFlags[i] && beforeLinesRaw[i].includes(FAMILY_DOCSTRING_TOKEN)) {
      return { family, kind: "docstring", token: FAMILY_DOCSTRING_TOKEN }
    }
  }
  return null
}

/**
 * Wave 11 stage 2 — per-session "already denied" flag for the
 * convention-divergence gate, mirroring unverified-finish-store.ts's
 * pattern: keyed by sessionID, set once the gate denies, read before every
 * later edit attempt so the deny is bounded to ONE per session TOTAL (not
 * per file).
 *
 * @sem domain=intelligence role=config
 */
const conventionDivergenceDeniedBySession = new Set<string>()

/** Whether this session's convention-divergence gate already spent its one deny. */
export function hasDeniedConventionDivergence(sessionID: string): boolean {
  return conventionDivergenceDeniedBySession.has(sessionID)
}

/** Record that the convention-divergence gate denied this session's edit once. */
export function markConventionDivergenceDenied(sessionID: string): void {
  conventionDivergenceDeniedBySession.add(sessionID)
}

/**
 * Round-F §7 — per-session "already denied a SECOND time" flag: the
 * convention-divergence gate's evidence-bearing second rung fires at most
 * once per session, mirroring `conventionDivergenceDeniedBySession`'s own
 * one-per-session bound — a third identical attempt always passes
 * (fail-open).
 *
 * @sem domain=intelligence role=config
 */
const conventionDivergenceDeniedSecondBySession = new Set<string>()

/** Whether this session's convention-divergence gate already spent its one SECOND deny (the round-F evidence-bearing rung). */
export function hasDeniedConventionDivergenceSecond(sessionID: string): boolean {
  return conventionDivergenceDeniedSecondBySession.has(sessionID)
}

/** Record that the convention-divergence gate denied this session's edit a SECOND time. */
export function markConventionDivergenceDeniedSecond(sessionID: string): void {
  conventionDivergenceDeniedSecondBySession.add(sessionID)
}

export type ConventionDivergenceGateAction = "deny" | "pass-retry" | "deny-second" | "silent"

/**
 * Pure gate decision for the convention-divergence bounce — armed only
 * within the hub-edit gate's own armed scope (fix-shaped root turns +
 * inheriting children; callers pass `hubEditGateArmed(sessionID)` from
 * edit-governance.ts as `armed`, mirroring evaluateHubEditGate's own arming
 * check rather than a separate arm/disarm cycle), skipped for test-like
 * paths and brand-new file creation, and — once a divergence is present —
 * returns "deny" the first time in a session. Round F §7 adds one more
 * evidence-bearing rung on the identical retry that follows: if the denied
 * divergence's method belongs to a known ambiguous semantic family
 * (`familyEvidence` non-null — see `detectFamilyConflictEvidence`) AND the
 * session hasn't already spent its one second deny, returns "deny-second"
 * ONCE; every later would-fire in that same session (no family/evidence
 * match, or the second deny already spent) returns "pass-retry". So the
 * total is bounded to AT MOST two denies per session, never per file.
 *
 * @sem domain=intelligence role=analysis
 */
export function evaluateConventionDivergenceGate(input: {
  armed: boolean
  isTestPath: boolean
  isNewFile: boolean
  divergence: ReceiverMethodDivergence | null
  alreadyDenied: boolean
  familyEvidence?: FamilyConflictEvidence | null
  alreadyDeniedSecond?: boolean
}): ConventionDivergenceGateAction {
  if (!input.armed) return "silent"
  if (input.isTestPath) return "silent"
  if (input.isNewFile) return "silent"
  if (input.divergence === null) return "silent"
  if (!input.alreadyDenied) return "deny"
  if (input.alreadyDeniedSecond) return "pass-retry"
  if (input.familyEvidence) return "deny-second"
  return "pass-retry"
}

/** Would `evaluateConventionDivergenceGate` deny this edit outright (either the first OR the round-F evidence-bearing second deny)? Pure boolean convenience wrapper — mirrors turn-supervisor.ts's `shouldDenyUnverifiedFinish` shape so tests don't need the tool harness. */
export function shouldDenyConventionDivergence(input: {
  armed: boolean
  isTestPath: boolean
  isNewFile: boolean
  divergence: ReceiverMethodDivergence | null
  alreadyDenied: boolean
  familyEvidence?: FamilyConflictEvidence | null
  alreadyDeniedSecond?: boolean
}): boolean {
  const action = evaluateConventionDivergenceGate(input)
  return action === "deny" || action === "deny-second"
}
