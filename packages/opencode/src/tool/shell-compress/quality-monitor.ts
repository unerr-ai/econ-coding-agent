/**
 * Compression quality feedback loop for shell-compress — watches whether a
 * compressed command's output makes the agent re-run the same command, and
 * puts a content category into "conservative" mode (the caller should skip
 * the lossy passthrough/omni strategy) once over-compression repeats. State
 * is per-instance but hydrates from disk on creation, so signals a prior
 * `opencode run` process persisted are visible to the next one instead of
 * every process starting blind.
 *
 * Ported from unerr-cli src/proxy/compression-quality-monitor.ts, trimmed to
 * econ's needs: no Layer 6 format-encoder tiering (econ has no format
 * encoder), and re-run detection is driven by normalized-command matching
 * (`noteCommandExecution`) instead of a caller-supplied retry/re-request flag.
 *
 * @sem domain=tool role=quality-monitor
 */

import type { OutputCategory } from "./classifier"
import { normalizeShellCommand } from "./classifier"
import {
  appendAuditLine,
  writeAdaptiveState,
  readAdaptiveState,
  readRecentAuditEntries,
  DEFAULT_STATE_DIR,
} from "./compression-log"
import type { AdaptiveStateSnapshot } from "./compression-log"

export const OVER_COMPRESSION_THRESHOLD = 3
export const GOOD_STREAK_THRESHOLD = 10
export const FEEDBACK_WINDOW_MS = 60_000

export interface CompressionEvent {
  command: string
  category: OutputCategory
  confidence: number
  rawTokens: number
  returnedTokens: number
  ratio: number
  timestamp: number
}

export interface CompressionQualityMonitorOptions {
  /** Override the on-disk state directory — tests point this at a tmp dir; omit for the default under Global.Path.data. */
  stateDir?: string
}

export interface CompressionQualityMonitor {
  recordCompression(event: CompressionEvent): void
  noteCommandExecution(command: string, timestamp: number): void
  isConservative(category: OutputCategory): boolean
  /**
   * Resolves once cross-process hydration (adaptive-state JSON + recent
   * audit JSONL) has been merged into this instance. The three methods
   * above are safe to call before this resolves — hydration never
   * clobbers in-memory state — but a caller that needs to OBSERVE the
   * prior process's state must await it first: in particular the shell
   * tool awaits it before noteCommandExecution, because a one-shot
   * `opencode run` process's first execution IS the cross-process re-run
   * we want to match, and it would otherwise race the disk read and lose.
   */
  ready: Promise<void>
}

interface PendingEvent {
  normalizedCommand: string
  category: OutputCategory
  timestamp: number
}

/**
 * Normalizes a shell command for re-run matching: trim + collapse whitespace
 * (via classifier's normalizeShellCommand), then drop trailing pipe segments
 * and a trailing `2>&1` stderr merge — so `cmd 2>&1 | tail -50` still
 * identifies the same underlying command as `cmd`.
 *
 * @sem domain=tool role=quality-monitor
 */
export function normalizeCommandForFeedback(command: string): string {
  const collapsed = normalizeShellCommand(command)
  const beforePipe = collapsed.split("|")[0] ?? collapsed
  return beforePipe.replace(/\s*2>&1\s*$/, "").trim()
}

/**
 * Creates a compression quality monitor instance. State (signal counts,
 * good streaks, conservative flags, pending re-run events) lives in-memory
 * per instance for synchronous access, but a fire-and-forget hydrate() is
 * kicked off here that loads a prior process's persisted state
 * (adaptive-state JSON + recent audit JSONL, both best-effort reads) into
 * that same in-memory state — so `opencode run`'s one-process-per-invocation
 * lifecycle doesn't reset re-run detection every time.
 *
 * recordCompression/noteCommandExecution/isConservative stay fully
 * synchronous and are safe to call before hydration resolves: merge only
 * ever *fills in* a category the map/set hasn't recorded locally yet
 * (`.has()`-guarded for the count maps; a plain union-add for the
 * conservative set, which is safe because hydration only ever adds
 * membership, never revokes it — a local decay-driven removal during the
 * hydration race window is a same-category, ~10-good-streak event that
 * cannot complete inside a sub-second disk read). In-memory writes always
 * win over the disk snapshot. Await the returned `ready` promise to observe
 * hydration having completed — required before a noteCommandExecution that
 * must match a PRIOR process's pending events (shell.ts does this).
 *
 * @sem domain=tool role=quality-monitor
 */
export function createCompressionQualityMonitor(
  opts: CompressionQualityMonitorOptions = {},
): CompressionQualityMonitor {
  const stateDir = opts.stateDir ?? DEFAULT_STATE_DIR
  const pending: PendingEvent[] = []
  const overCompressionCounts = new Map<OutputCategory, number>()
  const goodStreaks = new Map<OutputCategory, number>()
  const conservative = new Set<OutputCategory>()

  // Persistence stays fire-and-forget for callers, but individual writes are
  // chained so they land in call order — two unawaited snapshot writes racing
  // each other could otherwise leave the OLDER state on disk, and the next
  // process would hydrate a stale count.
  let writeChain: Promise<void> = Promise.resolve()

  function persistState(): void {
    const snapshot: AdaptiveStateSnapshot = {
      overCompressionCounts: Object.fromEntries(overCompressionCounts) as Partial<Record<OutputCategory, number>>,
      goodStreaks: Object.fromEntries(goodStreaks) as Partial<Record<OutputCategory, number>>,
      conservativeCategories: [...conservative],
    }
    writeChain = writeChain.then(() => writeAdaptiveState(stateDir, snapshot))
  }

  // Loads the previous process's persisted state into this instance.
  // Merge rule: disk data only fills gaps, it never overwrites a category
  // this instance has already touched itself (see the doc comment above
  // for why that's sufficient without a separate "touched" bookkeeping
  // structure). Pending re-run events are reconstructed from the audit
  // JSONL tail so a re-run that lands in a *new* process still matches.
  async function hydrate(): Promise<void> {
    const now = Date.now()
    const [snapshot, recentEntries] = await Promise.all([
      readAdaptiveState(stateDir),
      readRecentAuditEntries(stateDir, now - FEEDBACK_WINDOW_MS),
    ])

    if (snapshot) {
      for (const [category, count] of Object.entries(snapshot.overCompressionCounts)) {
        if (typeof count !== "number") continue
        if (overCompressionCounts.has(category as OutputCategory)) continue
        overCompressionCounts.set(category as OutputCategory, count)
      }
      for (const [category, streak] of Object.entries(snapshot.goodStreaks)) {
        if (typeof streak !== "number") continue
        if (goodStreaks.has(category as OutputCategory)) continue
        goodStreaks.set(category as OutputCategory, streak)
      }
      for (const category of snapshot.conservativeCategories) {
        conservative.add(category)
      }
    }

    for (const entry of recentEntries) {
      const normalizedCommand = normalizeCommandForFeedback(entry.command)
      const alreadyPending = pending.some(
        (ev) =>
          ev.normalizedCommand === normalizedCommand &&
          ev.timestamp === entry.timestamp &&
          ev.category === entry.category,
      )
      if (alreadyPending) continue
      pending.push({ normalizedCommand, category: entry.category, timestamp: entry.timestamp })
    }
  }

  const ready = hydrate().catch(() => {
    // hydrate()'s own reads are already best-effort (never throw), but
    // guard regardless — a bug here must never surface into the
    // synchronous compression hot path.
  })

  // Ages out any pending event older than the feedback window as a "good"
  // (non-retried) compression, feeding the good-streak decay counter.
  function reconcile(now: number): void {
    for (let i = pending.length - 1; i >= 0; i--) {
      const ev = pending[i]!
      if (now - ev.timestamp <= FEEDBACK_WINDOW_MS) continue
      pending.splice(i, 1)
      const streak = (goodStreaks.get(ev.category) ?? 0) + 1
      if (streak >= GOOD_STREAK_THRESHOLD) {
        conservative.delete(ev.category)
        goodStreaks.set(ev.category, 0)
      } else {
        goodStreaks.set(ev.category, streak)
      }
    }
  }

  function recordCompression(event: CompressionEvent): void {
    reconcile(event.timestamp)
    pending.push({
      normalizedCommand: normalizeCommandForFeedback(event.command),
      category: event.category,
      timestamp: event.timestamp,
    })

    const savedPct = Math.max(0, (1 - event.ratio) * 100)
    const auditEntry = {
      command: event.command,
      category: event.category,
      confidence: event.confidence,
      rawTokens: event.rawTokens,
      returnedTokens: event.returnedTokens,
      ratio: event.ratio,
      savedPct,
      timestamp: event.timestamp,
    }
    writeChain = writeChain.then(() => appendAuditLine(stateDir, auditEntry))
    persistState()
  }

  function noteCommandExecution(command: string, timestamp: number): void {
    reconcile(timestamp)
    const normalized = normalizeCommandForFeedback(command)
    for (let i = pending.length - 1; i >= 0; i--) {
      const ev = pending[i]!
      if (ev.normalizedCommand !== normalized) continue
      if (timestamp - ev.timestamp > FEEDBACK_WINDOW_MS) continue

      pending.splice(i, 1)
      goodStreaks.set(ev.category, 0)
      const count = (overCompressionCounts.get(ev.category) ?? 0) + 1
      if (count >= OVER_COMPRESSION_THRESHOLD) {
        conservative.add(ev.category)
        overCompressionCounts.set(ev.category, 0)
      } else {
        overCompressionCounts.set(ev.category, count)
      }
      persistState()
      return
    }
  }

  function isConservative(category: OutputCategory): boolean {
    return conservative.has(category)
  }

  return { recordCompression, noteCommandExecution, isConservative, ready }
}
