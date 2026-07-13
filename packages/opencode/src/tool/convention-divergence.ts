/**
 * Wave-11 stage 1: a pure, language-agnostic detector for the "established
 * receiver, novel method" shape (django-11848 A4 red — the agent added
 * `datetime.datetime.now()` beside the file's existing `datetime.datetime(...)`
 * constructor calls, never noticing the file's own `.now()`-free history or
 * the disambiguating docstring nearby). It never knows or names the right
 * answer — it only flags that a bounded re-read of the receiver's existing
 * uses is warranted before the edit lands. Not wired into any gate yet.
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
