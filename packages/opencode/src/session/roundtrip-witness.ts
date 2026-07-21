/**
 * H1 tooth 2 (gap-closure-plan §2.7, "roundtrip witness synthesis") — at
 * repro-seed time, detects whether the turn's focus entity has a
 * read<->write counterpart living beside it (same file — sibling entities
 * via BunSqliteGraph.getEntitiesInFile, no new index) so the repro-fidelity
 * gate can demand a roundtrip assert (parse -> write -> parse == original)
 * as an additional witness, converting one-sided fixes (observed shapes: a
 * parse-only fix, an inverted unescape, a param-never-threaded fix). The
 * name-pairing itself is pure and graph-free — `findRoundtripCounterpart`
 * only needs a candidate name list, so it is fully unit-testable without a
 * live graph; `synthesizeRoundtripWitness` is the thin async wrapper that
 * queries it.
 *
 * @sem domain=routing role=analysis
 */

/** The read<->write relation catalog a focus entity's name is checked against — each pair is mutual (either side may be the "focus"). */
const ROUNDTRIP_RELATION_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["parse", "serialize"],
  ["read", "write"],
  ["load", "dump"],
  ["escape", "unescape"],
  ["format", "parse"],
]

/** word -> every word that counts as its roundtrip counterpart, both directions of every pair above. */
const COUNTERPART_WORDS: ReadonlyMap<string, readonly string[]> = (() => {
  const out = new Map<string, string[]>()
  const add = (word: string, counterpart: string) => {
    const list = out.get(word) ?? []
    if (!list.includes(counterpart)) list.push(counterpart)
    out.set(word, list)
  }
  for (const [a, b] of ROUNDTRIP_RELATION_PAIRS) {
    add(a, b)
    add(b, a)
  }
  return out
})()

/** Splits a symbol/method name into lowercase words on camelCase, snake_case, and dotted (Class.method) boundaries. */
function tokenizeName(name: string): string[] {
  return name
    .replace(/[._]/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
}

/** Order-independent equality of two word lists — the "stem" that must match exactly on both sides of a candidate pair. */
function sameWordSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].sort()
  const sb = [...b].sort()
  return sa.every((w, i) => w === sb[i])
}

/**
 * Finds the sibling name whose relation-word matches `focusName`'s and whose
 * remaining words are identical (order-independent) — e.g. `parse_config`
 * pairs with `serialize_config`, `escape_html` pairs with `unescape_html`,
 * `Widget.read` pairs with `Widget.write`. Conservative, precision-over-
 * recall (same discipline as issue-expectations.ts): no relation word in the
 * focus name, or no sibling whose stem matches exactly, yields `undefined`.
 *
 * @sem domain=routing role=analysis
 */
export function findRoundtripCounterpart(focusName: string, siblingNames: readonly string[]): string | undefined {
  const focusTokens = tokenizeName(focusName)
  const focusWord = focusTokens.find((w) => COUNTERPART_WORDS.has(w))
  if (!focusWord) return undefined
  const counterpartWords = COUNTERPART_WORDS.get(focusWord)!
  const restTokens = focusTokens.filter((w) => w !== focusWord)

  for (const sibling of siblingNames) {
    if (sibling === focusName) continue
    const siblingTokens = tokenizeName(sibling)
    const siblingWord = siblingTokens.find((w) => counterpartWords.includes(w))
    if (!siblingWord) continue
    const siblingRest = siblingTokens.filter((w) => w !== siblingWord)
    if (sameWordSet(restTokens, siblingRest)) return sibling
  }
  return undefined
}

/** Structural subset of BunSqliteGraph this module needs — keeps it testable with a plain stub, never a live db. */
export interface EntityNameSource {
  getEntitiesInFile(filePath: string): Promise<ReadonlyArray<{ name: string }>>
}

/**
 * Queries the graph for the focus entity's file siblings and returns the
 * roundtrip counterpart name when one exists (`undefined` on no match or a
 * graph error — this never blocks the seed, only enriches it).
 *
 * @sem domain=routing role=analysis
 */
export async function synthesizeRoundtripWitness(
  graph: EntityNameSource,
  focusName: string,
  filePath: string,
): Promise<string | undefined> {
  try {
    const siblings = await graph.getEntitiesInFile(filePath)
    return findRoundtripCounterpart(
      focusName,
      siblings.map((e) => e.name),
    )
  } catch {
    return undefined
  }
}
