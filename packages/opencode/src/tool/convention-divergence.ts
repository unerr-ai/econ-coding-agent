/**
 * Wave-11 stage 1+2: a pure, language-agnostic detector for the "established
 * receiver, novel method" shape (django-11848 A4 red — the agent added
 * `datetime.datetime.now()` beside the file's existing `datetime.datetime(...)`
 * constructor calls, never noticing the file's own `.now()`-free history or
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

export type ConventionDivergenceGateAction = "deny" | "pass-retry" | "silent"

/**
 * Pure gate decision for the convention-divergence bounce — armed only
 * within the hub-edit gate's own armed scope (fix-shaped root turns +
 * inheriting children; callers pass `hubEditGateArmed(sessionID)` from
 * edit-governance.ts as `armed`, mirroring evaluateHubEditGate's own arming
 * check rather than a separate arm/disarm cycle), skipped for test-like
 * paths and brand-new file creation, and — once a divergence is present —
 * returns "deny" the first time in a session and "pass-retry" (never
 * blocking again) on every later would-fire in that same session, so the
 * deny is bounded to ONE per session TOTAL, not per file.
 *
 * @sem domain=intelligence role=analysis
 */
export function evaluateConventionDivergenceGate(input: {
  armed: boolean
  isTestPath: boolean
  isNewFile: boolean
  divergence: ReceiverMethodDivergence | null
  alreadyDenied: boolean
}): ConventionDivergenceGateAction {
  if (!input.armed) return "silent"
  if (input.isTestPath) return "silent"
  if (input.isNewFile) return "silent"
  if (input.divergence === null) return "silent"
  return input.alreadyDenied ? "pass-retry" : "deny"
}

/** Would `evaluateConventionDivergenceGate` deny this edit outright? Pure boolean convenience wrapper — mirrors turn-supervisor.ts's `shouldDenyUnverifiedFinish` shape so tests don't need the tool harness. */
export function shouldDenyConventionDivergence(input: {
  armed: boolean
  isTestPath: boolean
  isNewFile: boolean
  divergence: ReceiverMethodDivergence | null
  alreadyDenied: boolean
}): boolean {
  return evaluateConventionDivergenceGate(input) === "deny"
}
