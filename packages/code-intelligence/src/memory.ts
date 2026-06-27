/**
 * Anchored-memory layer for the four-moment active-cognition contract: inject
 * recalled notes at prompt-receipt, capture sentinel saves at task-end, and
 * store/query them so the next session starts with live context rather than
 * blank state.
 *
 * @sem domain=intelligence role=query
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Classifies the epistemic weight of a stored note — rules and warnings carry
 * stronger obligations than facts or decisions.
 *
 * @sem domain=intelligence role=utilities
 */
export type NoteKind = "cnv" | "rul" | "wrn" | "dec" | "blk" | "fct"

/**
 * Signals whether the note recommends, prohibits, or ambiguously describes a
 * behaviour — lets callers render and filter by intent.
 *
 * @sem domain=intelligence role=utilities
 */
export type Polarity = "+" | "-" | "~"

/**
 * A single piece of project knowledge pinned to a file, entity, or glob anchor
 * so the memory layer can surface it precisely when its anchor is in scope.
 *
 * @sem domain=intelligence role=query
 */
export interface AnchoredNote {
  kind: NoteKind
  anchor: string
  polarity: Polarity
  content: string
  confidence?: number
}

/**
 * Names the four required moments in the active-cognition contract; callers
 * use this to track which moment they are currently executing.
 *
 * @sem domain=intelligence role=utilities
 */
export type FourMoment =
  | "prompt-receipt"
  | "anchor-query"
  | "cite-in-plan"
  | "save-at-end"

/**
 * Persistence surface for anchored notes — abstracts the backing store so
 * tests can use InMemoryMemoryStore while the runtime uses a durable driver.
 *
 * @sem domain=intelligence role=query
 */
export interface MemoryStore {
  recallForAnchors(anchors: string[]): Promise<AnchoredNote[]>
  save(note: AnchoredNote): Promise<void>
  /**
   * Attempt to parse raw user text (e.g. "always use X") into an AnchoredNote.
   * Returns null when the text does not match a recognised capture pattern;
   * full implementation is deferred to the runtime capture layer.
   */
  captureRule(text: string): AnchoredNote | null
}

// ---------------------------------------------------------------------------
// parseSentinels
// ---------------------------------------------------------------------------

/**
 * Scans agent output for `unerr-save: note <wire>` lines and converts each
 * into a typed AnchoredNote — this is the zero-round-trip sentinel-save path
 * that the Stop hook calls before persisting notes to the store.
 *
 * @sem domain=intelligence role=utilities
 */
export function parseSentinels(text: string): AnchoredNote[] {
  const PREFIX = "unerr-save: note "
  const results: AnchoredNote[] = []

  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith(PREFIX)) continue

    const wire = trimmed.slice(PREFIX.length)
    // Wire format: kind|anchor|polarity|content
    // Content may itself contain `|` — split into at most 4 parts.
    const parts = wire.split("|")
    if (parts.length < 4) continue

    const [kindRaw, anchor, polarityRaw, ...rest] = parts
    const content = rest.join("|")

    const validKinds: NoteKind[] = ["cnv", "rul", "wrn", "dec", "blk", "fct"]
    const validPolarities: Polarity[] = ["+", "-", "~"]

    if (!validKinds.includes(kindRaw as NoteKind)) continue
    if (!validPolarities.includes(polarityRaw as Polarity)) continue

    results.push({
      kind: kindRaw as NoteKind,
      anchor,
      polarity: polarityRaw as Polarity,
      content,
    })
  }

  return results
}

// ---------------------------------------------------------------------------
// InMemoryMemoryStore
// ---------------------------------------------------------------------------

/**
 * In-process memory store backed by a plain array — used in tests and as the
 * initial scaffold before a durable SQLite-backed store is wired in.
 *
 * @sem domain=intelligence role=indexing
 */
export class InMemoryMemoryStore implements MemoryStore {
  private notes: AnchoredNote[] = []

  async recallForAnchors(anchors: string[]): Promise<AnchoredNote[]> {
    return this.notes.filter((n) => anchors.includes(n.anchor))
  }

  async save(note: AnchoredNote): Promise<void> {
    this.notes.push(note)
  }

  /**
   * Rule-capture from raw text is deferred to the runtime capture layer;
   * returns null in all cases for this stub implementation.
   */
  captureRule(_text: string): AnchoredNote | null {
    return null
  }
}
