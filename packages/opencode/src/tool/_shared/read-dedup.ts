/**
 * Session-scoped read-dedup memo shared by the read and write tools.
 * Remembers, per (sessionID, filePath), the whole-file content hash and
 * every line range already covered this session — delivered by a read, or
 * freshly defined by a write — so a requested range that is a *subset* of an
 * already-covered range on the same unchanged file counts as a hit too, not
 * just a byte-identical repeat of the same (offset, limit). A live trace
 * showed a 15-line slice re-read after the same file had already been read
 * in full, which an exact-key match couldn't catch; a second trace showed a
 * full re-read of a file the agent had itself just written, since only reads
 * had ever seeded the memo.
 *
 * Invalidation: (a) a changed file's whole-file hash naturally misses the
 * stored one on the next call, which drops every stored range for that path
 * and re-arms with the fresh hash; (b) ranges expire after READ_DEDUP_TTL_MS
 * so a post-compaction session (whose prior tool outputs may no longer be in
 * context) stops firing. TTL was chosen over wiring a real session.compacted
 * hook or a compaction-count epoch: read.ts's Tool.define layer (FSUtil |
 * Instruction | LSP | Scope) has no session/compaction service in scope, and
 * the compaction-count alternative (session/compaction.ts's
 * completedCompactions) is internal/unexported and would need its
 * message/part shape reconstructed to test — a conservative TTL bounds the
 * same staleness window with no cross-module coupling.
 *
 * @sem domain=intelligence role=cache
 */

import { createHash } from "node:crypto"
import { Effect, Stream } from "effect"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Conservative invalidation window — see module doc for why TTL over a compaction hook. */
const READ_DEDUP_TTL_MS = 30 * 60 * 1000

/** Max ranges retained per session (across every file) before the oldest is evicted (LRU). */
const MAX_ENTRIES_PER_SESSION = 200

// ---------------------------------------------------------------------------
// Shared per-line file hash — read.ts's streaming lines() and this module's
// own computeContentHash() (used by seedReadDedup) both drive the same
// accumulator, so a hash computed at write time is byte-for-byte identical to
// one computed while streaming the same content back off disk.
// ---------------------------------------------------------------------------

/** Mirrors read.ts's delivered-line-length cap — kept here so the write-time cap simulation below truncates a line the same way before sizing it. */
export const READ_MAX_LINE_LENGTH = 2000
const READ_MAX_LINE_SUFFIX = `... (line truncated to ${READ_MAX_LINE_LENGTH} chars)`
/** Mirrors read.ts's delivered-byte cap per read call. */
export const READ_MAX_BYTES = 50 * 1024

/**
 * Incremental per-line sha256, matching read.ts's lines() hashing exactly:
 * every line's raw (pre-truncation) text is hashed in stream order, with a
 * bare "\n" fed between lines (none before the first, none trailing after
 * the last). Both the streaming read and the whole-content write seed drive
 * this same accumulator so their digests agree byte-for-byte.
 */
export class IncrementalLineHasher {
  private readonly hasher = createHash("sha256")
  private lineCount = 0

  update(text: string): void {
    if (this.lineCount > 0) this.hasher.update("\n")
    this.hasher.update(text, "utf8")
    this.lineCount += 1
  }

  digest(): string {
    return this.hasher.digest("hex")
  }
}

/** Split content into lines the same way read.ts's stream does (effect's Stream.splitLines) — a trailing newline does not produce an extra empty final line. */
function splitContentLines(content: string): readonly string[] {
  return Effect.runSync(Stream.make(content).pipe(Stream.splitLines, Stream.runCollect))
}

export interface ContentHashResult {
  fileHash: string
  lineCount: number
  /** True when read.ts's own delivered-byte cap would cut a real read of this content short partway through — its computed hash would then be partial, never matching this whole-content one, so the caller must skip seeding rather than store an unreachable hash. */
  exceedsReadCap: boolean
}

/**
 * Compute the whole-content hash + line count read.ts would produce for a
 * read spanning the entire file, and detect whether read.ts's own MAX_BYTES
 * cap would cut such a read short before EOF (in which case the two hashes
 * can never agree — see ContentHashResult.exceedsReadCap).
 */
export function computeContentHash(content: string): ContentHashResult {
  const lines = splitContentLines(content)
  const hasher = new IncrementalLineHasher()
  let bytes = 0

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]
    hasher.update(text)

    const delivered = text.length > READ_MAX_LINE_LENGTH ? text.slice(0, READ_MAX_LINE_LENGTH) + READ_MAX_LINE_SUFFIX : text
    bytes += Buffer.byteLength(delivered, "utf-8") + (i > 0 ? 1 : 0)
    if (bytes > READ_MAX_BYTES) {
      // read.ts's stream would stop right here (ReadStop) on a real read —
      // its returned hash would only cover lines up to this point, not the
      // rest of the file, so the digest below is not a whole-content hash
      // and must not be seeded.
      return { fileHash: hasher.digest(), lineCount: lines.length, exceedsReadCap: true }
    }
  }

  return { fileHash: hasher.digest(), lineCount: lines.length, exceedsReadCap: false }
}

/** A delivered line interval: [start, end) — half-open, 1-indexed start. */
interface StoredRange {
  start: number
  end: number
  timestamp: number
  /** Assistant step (messageID) whose result delivered this range — L3.2 stub
   * provenance ("unchanged since step N"), so the model can find the prior
   * result instead of guessing. Optional: pure state-layer callers (tests)
   * may omit it; read.ts/write.ts always supply it. */
  messageID?: string
}

interface FileMemo {
  /** Hash of the whole file's content as of the read that produced these ranges. */
  fileHash: string
  ranges: StoredRange[]
}

interface OrderEntry {
  filePath: string
  range: StoredRange
}

interface SessionMemo {
  files: Map<string, FileMemo>
  /** Insertion/most-recently-touched order of every range in the session, for the LRU cap. */
  order: OrderEntry[]
}

/** Module-level, process-scoped store: sessionID -> per-file memo + session-wide LRU order. */
const sessions = new Map<string, SessionMemo>()

/** Move (or insert) a range to the MRU end of the session's order, evicting the LRU tail past the cap. */
function touch(sessionMemo: SessionMemo, filePath: string, range: StoredRange): void {
  const idx = sessionMemo.order.findIndex((entry) => entry.range === range)
  if (idx !== -1) sessionMemo.order.splice(idx, 1)
  sessionMemo.order.push({ filePath, range })

  while (sessionMemo.order.length > MAX_ENTRIES_PER_SESSION) {
    const evicted = sessionMemo.order.shift()
    if (!evicted) break
    const memo = sessionMemo.files.get(evicted.filePath)
    if (!memo) continue
    const i = memo.ranges.indexOf(evicted.range)
    if (i !== -1) memo.ranges.splice(i, 1)
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Hash a full string of content — used to detect a changed file. */
export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex")
}

export interface ReadDedupResult {
  /** True when the requested range is covered by an already-delivered, unchanged, unexpired range. */
  hit: boolean
  /** When hit: whether the covering range is exactly the requested range (vs. a strict superset). */
  exact?: boolean
  /** When hit: the stored range that covers the request — used to word a strict-subset notice. */
  covering?: { start: number; end: number }
  /** When hit: the step (messageID) that delivered the covering range — L3.2 "unchanged since step N". */
  messageID?: string
}

/**
 * Check-and-record a read against the session's per-file memo. A hit
 * requires: not `force`, the file's content hash unchanged since the range
 * was stored, and the requested [start, end) contained within a stored range
 * that hasn't expired (TTL). An exact repeat is just the subset case where
 * the covering range equals the request. On a fileHash mismatch every stored
 * range for that path is dropped and the memo re-arms with this read. `force`
 * bypasses the hit check but still records the read. `now` is test-injectable;
 * defaults to `Date.now()`.
 */
export function checkReadDedup(input: {
  sessionID: string
  filePath: string
  start: number
  end: number
  fileHash: string
  /** Current assistant step — recorded with the range for L3.2 stub provenance. */
  messageID?: string
  force?: boolean
  now?: number
}): ReadDedupResult {
  const now = input.now ?? Date.now()

  let sessionMemo = sessions.get(input.sessionID)
  if (!sessionMemo) {
    sessionMemo = { files: new Map(), order: [] }
    sessions.set(input.sessionID, sessionMemo)
  }

  let fileMemo = sessionMemo.files.get(input.filePath)
  if (fileMemo && fileMemo.fileHash !== input.fileHash) {
    // Content changed — drop every stored range for this path; re-arm below.
    sessionMemo.order = sessionMemo.order.filter((entry) => entry.filePath !== input.filePath)
    fileMemo = undefined
  }

  if (!input.force && fileMemo) {
    const covering = fileMemo.ranges.find(
      (range) => input.start >= range.start && input.end <= range.end && now - range.timestamp < READ_DEDUP_TTL_MS,
    )
    if (covering) {
      // No new information delivered — refresh the covering range's recency
      // instead of growing the memo with a redundant entry. Provenance stays
      // on the step that actually delivered the data, never the repeat.
      covering.timestamp = now
      touch(sessionMemo, input.filePath, covering)
      return {
        hit: true,
        exact: covering.start === input.start && covering.end === input.end,
        covering: { start: covering.start, end: covering.end },
        messageID: covering.messageID,
      }
    }
  }

  if (!fileMemo) {
    fileMemo = { fileHash: input.fileHash, ranges: [] }
    sessionMemo.files.set(input.filePath, fileMemo)
  }

  const range: StoredRange = { start: input.start, end: input.end, timestamp: now, messageID: input.messageID }
  fileMemo.ranges.push(range)
  touch(sessionMemo, input.filePath, range)

  return { hit: false }
}

/**
 * Drop every stored range for one file in one session. L3.2 guard
 * (docs/design/turn-cache-economics.md §5-L3 item 2): the session wrapper
 * (session/tools.ts) calls this when a read result was cut by the per-result
 * ceiling (L2.4) AFTER the memo had already recorded its range as delivered —
 * the model never saw the full range, so a later identical read must
 * re-deliver, never stub toward truncated data. (The aggregate L1.3 cut now
 * happens later, in step-budget.ts's water-filling pass, outside this
 * wrapper's visibility — a known, accepted gap.) Per-file and implicit; the
 * rest of the session memo stands.
 */
export function dropReadDedup(sessionID: string, filePath: string): void {
  const sessionMemo = sessions.get(sessionID)
  if (!sessionMemo) return
  if (!sessionMemo.files.delete(filePath)) return
  sessionMemo.order = sessionMemo.order.filter((entry) => entry.filePath !== filePath)
}

/**
 * Seed the dedup memo straight from a just-written file's content, without
 * waiting for a subsequent read to populate it — a write defines the file's
 * new whole-file state, so it replaces any ranges already stored for the
 * path rather than merging with them. Silently skips when
 * computeContentHash flags that read.ts's own byte cap would keep a real
 * read from ever reproducing this hash (see ContentHashResult.exceedsReadCap).
 * Best-effort by construction: never throws on a normal input, so callers
 * (write.ts) can call it without risking the write itself.
 */
export function seedReadDedup(input: {
  sessionID: string
  filePath: string
  content: string
  /** The writing step — a later dedup stub cites it as the range's provenance. */
  messageID?: string
  now?: number
}): void {
  const { fileHash, lineCount, exceedsReadCap } = computeContentHash(input.content)
  if (exceedsReadCap) return

  const now = input.now ?? Date.now()

  let sessionMemo = sessions.get(input.sessionID)
  if (!sessionMemo) {
    sessionMemo = { files: new Map(), order: [] }
    sessions.set(input.sessionID, sessionMemo)
  }

  // A write defines the new file state — drop every previously stored range
  // for this path; they describe content that no longer exists.
  sessionMemo.order = sessionMemo.order.filter((entry) => entry.filePath !== input.filePath)

  const fileMemo: FileMemo = { fileHash, ranges: [] }
  sessionMemo.files.set(input.filePath, fileMemo)

  const range: StoredRange = { start: 1, end: lineCount + 1, timestamp: now, messageID: input.messageID }
  fileMemo.ranges.push(range)
  touch(sessionMemo, input.filePath, range)
}

/** Evict all memo entries — intended for tests only. */
export function clearReadDedup(): void {
  sessions.clear()
}
