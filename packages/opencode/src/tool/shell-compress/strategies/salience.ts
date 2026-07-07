/**
 * Salience guard shared by shell-compress strategies — identifies lines that
 * carry failure/diagnostic signal and therefore must never be silently
 * dropped by a lossy collapse. Salient lines may still be deduplicated, but
 * only with an explicit occurrence count.
 *
 * @sem domain=tool role=compressor
 */

// v1 pattern set — tuned to favor recall: a false positive keeps one extra
// line, a false negative can hide a real failure (the 2026-07-05 incident
// where a compressed test summary dropped "4 failed").
const SALIENT_PATTERNS: RegExp[] = [
  /\berrors?\b/i,
  /\bfail(s|ed|ure|ures|ing)?\b/i,
  /\b(exception|panic(ked)?|fatal|abort(ed)?|segfault|traceback)\b/i,
  /\bassert(ion)?s?\b/i,
  // Language exception class names are written as one token with no boundary
  // before "Error" (pytest: "AssertionError: ..."), so the generic \berrors?\b
  // above misses them — test-results.ts's compressFallback relied on a local
  // heuristic for exactly this case before it was reconciled onto isSalientLine.
  /\bassertionerror\b/i,
  /\bexit(ed)?\s+(with\s+)?code\s+[1-9]/i,
  /[✗✕●]/,
  // A denied/rejected path or operation (find: '...': Permission denied,
  // access denied) is a diagnostic worth surfacing through tree-paths' fold
  // just like any other failure signal.
  /\bdenied\b/i,
]

/**
 * True when a line carries failure/diagnostic signal that a compression
 * strategy must not silently drop — consult before folding any line away.
 *
 * @sem domain=tool role=compressor
 */
export function isSalientLine(line: string): boolean {
  if (!line) return false
  for (const re of SALIENT_PATTERNS) {
    if (re.test(line)) return true
  }
  return false
}
