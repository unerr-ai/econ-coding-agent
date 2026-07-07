/**
 * Persistence for the compression quality monitor — a per-event JSONL audit
 * log plus an adaptive-state JSON snapshot (signal counts, conservative
 * flags), with read counterparts so a fresh process can hydrate the signals
 * a prior process wrote. Every write is best-effort: a missing/unwritable
 * state directory degrades to a silent no-op instead of surfacing into the
 * shell-compress hot path. Reads are equally best-effort: a missing,
 * unreadable, or corrupt file degrades to null/empty rather than throwing.
 *
 * @sem domain=tool role=quality-monitor
 */

import path from "path"
import { appendFile, mkdir, open, readFile, writeFile } from "fs/promises"
import { Global } from "@opencode-ai/core/global"
import type { OutputCategory } from "./classifier"

export const DEFAULT_STATE_DIR = path.join(Global.Path.data, "shell-compress-quality")

const AUDIT_FILE_NAME = "compression-quality.jsonl"
const STATE_FILE_NAME = "adaptive-state.json"

// Cap on how much of the audit JSONL tail we read back — the log grows
// unbounded across a repo's lifetime, so re-run detection only ever needs
// the last FEEDBACK_WINDOW_MS or so of activity, not the whole file.
const AUDIT_TAIL_BYTES = 64 * 1024

export interface CompressionAuditEntry {
  command: string
  category: OutputCategory
  confidence: number
  rawTokens: number
  returnedTokens: number
  ratio: number
  savedPct: number
  timestamp: number
}

export interface AdaptiveStateSnapshot {
  overCompressionCounts: Partial<Record<OutputCategory, number>>
  goodStreaks: Partial<Record<OutputCategory, number>>
  conservativeCategories: OutputCategory[]
}

async function ensureStateDir(stateDir: string): Promise<boolean> {
  try {
    await mkdir(stateDir, { recursive: true })
    return true
  } catch {
    return false
  }
}

/** Appends one JSONL audit line for a compression event. Never throws. */
export async function appendAuditLine(stateDir: string, entry: CompressionAuditEntry): Promise<void> {
  try {
    if (!(await ensureStateDir(stateDir))) return
    await appendFile(path.join(stateDir, AUDIT_FILE_NAME), `${JSON.stringify(entry)}\n`, "utf8")
  } catch {
    // best-effort audit log — a disk error must never reach the compression path
  }
}

/** Overwrites the adaptive-state snapshot (signal counts + conservative flags). Never throws. */
export async function writeAdaptiveState(stateDir: string, snapshot: AdaptiveStateSnapshot): Promise<void> {
  try {
    if (!(await ensureStateDir(stateDir))) return
    await writeFile(path.join(stateDir, STATE_FILE_NAME), JSON.stringify(snapshot, null, 2), "utf8")
  } catch {
    // best-effort state snapshot — a disk error must never reach the compression path
  }
}

/**
 * Reads back the adaptive-state snapshot a prior process wrote, so a fresh
 * process can hydrate its in-memory signal counts instead of starting blind.
 * Never throws: a missing file, unreadable file, or a JSON payload that
 * doesn't match the expected shape all resolve to null.
 */
export async function readAdaptiveState(stateDir: string): Promise<AdaptiveStateSnapshot | null> {
  try {
    const raw = await readFile(path.join(stateDir, STATE_FILE_NAME), "utf8")
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as AdaptiveStateSnapshot).overCompressionCounts !== "object" ||
      (parsed as AdaptiveStateSnapshot).overCompressionCounts === null ||
      typeof (parsed as AdaptiveStateSnapshot).goodStreaks !== "object" ||
      (parsed as AdaptiveStateSnapshot).goodStreaks === null ||
      !Array.isArray((parsed as AdaptiveStateSnapshot).conservativeCategories)
    ) {
      return null
    }
    return parsed as AdaptiveStateSnapshot
  } catch {
    return null
  }
}

/**
 * Reads audit entries with `timestamp >= sinceMs` from the JSONL log, so a
 * fresh process can reconstruct pending re-run-detection state without
 * replaying the whole (unbounded-growth) file. Only reads the last
 * `AUDIT_TAIL_BYTES` of the file — re-run detection only ever cares about
 * recent activity, and a 64KB tail comfortably covers a busy feedback
 * window's worth of JSONL lines. The first line of a non-zero-offset read
 * is dropped as a possibly-truncated partial line. Never throws: a missing
 * file, an unreadable file, or a truncated/corrupt line all degrade
 * gracefully (a corrupt line is skipped, not fatal to the rest of the read).
 */
export async function readRecentAuditEntries(stateDir: string, sinceMs: number): Promise<CompressionAuditEntry[]> {
  const filePath = path.join(stateDir, AUDIT_FILE_NAME)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(filePath, "r")
    const { size } = await handle.stat()
    const length = Math.min(size, AUDIT_TAIL_BYTES)
    const start = size - length
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    const lines = buffer.toString("utf8").split("\n")
    if (start > 0) lines.shift() // drop the possibly-partial first line

    const entries: CompressionAuditEntry[] = []
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed: unknown = JSON.parse(trimmed)
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          typeof (parsed as CompressionAuditEntry).command !== "string" ||
          typeof (parsed as CompressionAuditEntry).category !== "string" ||
          typeof (parsed as CompressionAuditEntry).timestamp !== "number"
        ) {
          continue
        }
        const entry = parsed as CompressionAuditEntry
        if (entry.timestamp < sinceMs) continue
        entries.push(entry)
      } catch {
        // corrupt/truncated JSONL line — skip it, keep reading the rest
      }
    }
    return entries
  } catch {
    return []
  } finally {
    await handle?.close().catch(() => {})
  }
}
