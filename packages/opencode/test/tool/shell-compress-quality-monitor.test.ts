/**
 * Unit tests for the compression quality feedback loop (no real shell):
 *  1. signal counting per category + 3 signals flips isConservative to true
 *  2. 60s feedback-window boundary (t+59s counts, t+61s doesn't)
 *  3. 10 good (non-retried) compressions decay a category back out of conservative mode
 *  4. command normalization matches `cmd` vs `cmd 2>&1 | tail -50`
 *  5. JSONL audit line + adaptive-state JSON are written when the state dir is available
 *  6. cross-process hydration: a fresh instance on the same state dir sees a prior
 *     instance's signals (counts, conservative flags, in-window pending events),
 *     degrades silently on corrupt files, and round-trips the merged state
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { appendFile, mkdtemp, readFile, rm, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import type { OutputCategory } from "../../src/tool/shell-compress/classifier"
import {
  createCompressionQualityMonitor,
  normalizeCommandForFeedback,
  type CompressionEvent,
} from "../../src/tool/shell-compress/quality-monitor"
import {
  appendAuditLine,
  readRecentAuditEntries,
  writeAdaptiveState,
  type CompressionAuditEntry,
} from "../../src/tool/shell-compress/compression-log"

const CATEGORY: OutputCategory = "log_text"

function makeEvent(overrides: Partial<CompressionEvent> = {}): CompressionEvent {
  return {
    command: "npm test",
    category: CATEGORY,
    confidence: 0.8,
    rawTokens: 1000,
    returnedTokens: 100,
    ratio: 0.1,
    timestamp: 0,
    ...overrides,
  }
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "econ-quality-monitor-"))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe("createCompressionQualityMonitor — signal counting", () => {
  it("counts an over-compression signal when a re-run matches within the window, none before 3", () => {
    const monitor = createCompressionQualityMonitor({ stateDir: tmpDir })

    for (let i = 0; i < 2; i++) {
      const t = i * 200_000
      monitor.recordCompression(makeEvent({ timestamp: t }))
      monitor.noteCommandExecution("npm test", t + 5_000)
      expect(monitor.isConservative(CATEGORY)).toBe(false)
    }

    // Third signal trips the threshold.
    const t = 2 * 200_000
    monitor.recordCompression(makeEvent({ timestamp: t }))
    monitor.noteCommandExecution("npm test", t + 5_000)
    expect(monitor.isConservative(CATEGORY)).toBe(true)
  })

  it("does not flag categories that never saw a re-run", () => {
    const monitor = createCompressionQualityMonitor({ stateDir: tmpDir })
    monitor.recordCompression(makeEvent({ timestamp: 0 }))
    expect(monitor.isConservative(CATEGORY)).toBe(false)
  })
})

describe("createCompressionQualityMonitor — 60s feedback window boundary", () => {
  it("counts a re-run at t+59s", () => {
    const monitor = createCompressionQualityMonitor({ stateDir: tmpDir })
    const t = 1_000_000
    monitor.recordCompression(makeEvent({ timestamp: t }))
    monitor.noteCommandExecution("npm test", t + 59_000)

    // One signal isn't enough to trip conservative mode yet — confirm the
    // signal registered by driving it to the threshold with two more, all
    // well inside their own windows.
    monitor.recordCompression(makeEvent({ timestamp: t + 100_000 }))
    monitor.noteCommandExecution("npm test", t + 100_000 + 1_000)
    monitor.recordCompression(makeEvent({ timestamp: t + 200_000 }))
    monitor.noteCommandExecution("npm test", t + 200_000 + 1_000)
    expect(monitor.isConservative(CATEGORY)).toBe(true)
  })

  it("does not count a re-run at t+61s", () => {
    const monitor = createCompressionQualityMonitor({ stateDir: tmpDir })
    const t = 1_000_000
    monitor.recordCompression(makeEvent({ timestamp: t }))
    monitor.noteCommandExecution("npm test", t + 61_000)

    // Drive two more (in-window) signals — if the t+61s re-run had counted,
    // this would be the 3rd signal and trip conservative mode. It shouldn't.
    monitor.recordCompression(makeEvent({ timestamp: t + 200_000 }))
    monitor.noteCommandExecution("npm test", t + 200_000 + 1_000)
    monitor.recordCompression(makeEvent({ timestamp: t + 400_000 }))
    monitor.noteCommandExecution("npm test", t + 400_000 + 1_000)
    expect(monitor.isConservative(CATEGORY)).toBe(false)
  })
})

describe("createCompressionQualityMonitor — good-streak decay", () => {
  it("decays a category back out of conservative mode after 10 good compressions", () => {
    const monitor = createCompressionQualityMonitor({ stateDir: tmpDir })

    // Trip conservative mode with 3 signals.
    for (let i = 0; i < 3; i++) {
      const t = i * 200_000
      monitor.recordCompression(makeEvent({ timestamp: t }))
      monitor.noteCommandExecution("npm test", t + 1_000)
    }
    expect(monitor.isConservative(CATEGORY)).toBe(true)

    // 11 compressions spaced >60s apart: each new call ages the previous
    // one out of the window as "good" (never matched by a re-run). The
    // first call has nothing to age out, so 11 calls produce 10 good
    // resolutions — enough to hit the decay threshold.
    const base = 1_000_000
    for (let i = 0; i < 11; i++) {
      monitor.recordCompression(makeEvent({ timestamp: base + i * 70_000 }))
    }

    expect(monitor.isConservative(CATEGORY)).toBe(false)
  })
})

describe("normalizeCommandForFeedback", () => {
  it("matches a bare command against the same command piped to tail with stderr merged", () => {
    expect(normalizeCommandForFeedback("npm test")).toBe(normalizeCommandForFeedback("npm test 2>&1 | tail -50"))
  })

  it("collapses internal whitespace", () => {
    expect(normalizeCommandForFeedback("  npm   test  ")).toBe(normalizeCommandForFeedback("npm test"))
  })
})

describe("createCompressionQualityMonitor — persistence", () => {
  it("writes a JSONL audit line and an adaptive-state snapshot when the state dir is available", async () => {
    const monitor = createCompressionQualityMonitor({ stateDir: tmpDir })
    monitor.recordCompression(makeEvent({ timestamp: 0, command: "npm test", ratio: 0.2 }))

    // Persistence is fire-and-forget async — give the microtask queue a turn.
    await new Promise((resolve) => setTimeout(resolve, 50))

    const auditRaw = await readFile(path.join(tmpDir, "compression-quality.jsonl"), "utf8")
    const lines = auditRaw.trim().split("\n")
    expect(lines.length).toBe(1)
    const entry = JSON.parse(lines[0]!)
    expect(entry.command).toBe("npm test")
    expect(entry.category).toBe(CATEGORY)
    expect(entry.ratio).toBe(0.2)
    expect(entry.savedPct).toBeCloseTo(80)

    const stateRaw = await readFile(path.join(tmpDir, "adaptive-state.json"), "utf8")
    const state = JSON.parse(stateRaw)
    expect(state.conservativeCategories).toEqual([])
  })
})

function makeAuditEntry(overrides: Partial<CompressionAuditEntry> = {}): CompressionAuditEntry {
  return {
    command: "npm test",
    category: CATEGORY,
    confidence: 0.8,
    rawTokens: 1000,
    returnedTokens: 100,
    ratio: 0.1,
    savedPct: 90,
    timestamp: 0,
    ...overrides,
  }
}

// Hydration filters the audit tail against wall-clock now, so unlike the
// synthetic-time tests above these use Date.now()-relative timestamps.
describe("createCompressionQualityMonitor — cross-process hydration", () => {
  it("accumulates over-compression signals across instances on the same state dir", async () => {
    const now = Date.now()
    const first = createCompressionQualityMonitor({ stateDir: tmpDir })
    await first.ready

    // Two signal pairs in the first "process" — one short of the threshold.
    first.recordCompression(makeEvent({ timestamp: now - 20_000 }))
    first.noteCommandExecution("npm test", now - 19_000)
    first.recordCompression(makeEvent({ timestamp: now - 10_000 }))
    first.noteCommandExecution("npm test", now - 9_000)
    expect(first.isConservative(CATEGORY)).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 50)) // flush fire-and-forget persists

    // A fresh instance (fresh process) hydrates the count AND the recent
    // pending events from the audit tail, so its first re-run observation
    // is the third signal — the flip the live test 2.1 found missing.
    const second = createCompressionQualityMonitor({ stateDir: tmpDir })
    await second.ready
    expect(second.isConservative(CATEGORY)).toBe(false)
    second.noteCommandExecution("npm test", now)
    expect(second.isConservative(CATEGORY)).toBe(true)
  })

  it("hydrates pending events only from within the feedback window", async () => {
    const now = Date.now()
    await appendAuditLine(tmpDir, makeAuditEntry({ command: "npm run lint", category: "tabular", timestamp: now - 30_000 }))
    await appendAuditLine(tmpDir, makeAuditEntry({ command: "npm run lint", category: "tabular", timestamp: now - 90_000 }))

    const entries = await readRecentAuditEntries(tmpDir, now - 60_000)
    expect(entries.length).toBe(1)
    expect(entries[0]!.timestamp).toBe(now - 30_000)

    const monitor = createCompressionQualityMonitor({ stateDir: tmpDir })
    await monitor.ready
    // The 30s-old entry hydrated as pending: one matching re-run → count 1.
    // The 90s-old entry must not have hydrated: if it had, reconcile() would
    // age it out as a "good" compression and bump the goodStreaks counter.
    monitor.noteCommandExecution("npm run lint", now)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const state = JSON.parse(await readFile(path.join(tmpDir, "adaptive-state.json"), "utf8"))
    expect(state.overCompressionCounts.tabular).toBe(1)
    expect(state.goodStreaks.tabular ?? 0).toBe(0)
  })

  it("degrades silently when the persisted files are corrupt", async () => {
    await writeFile(path.join(tmpDir, "adaptive-state.json"), "{ not json", "utf8")
    await appendFile(
      path.join(tmpDir, "compression-quality.jsonl"),
      `garbage line\n{"command":"npm test","category":\n${JSON.stringify(makeAuditEntry({ timestamp: Date.now() - 5_000 }))}\n`,
      "utf8",
    )

    const monitor = createCompressionQualityMonitor({ stateDir: tmpDir })
    await monitor.ready
    expect(monitor.isConservative(CATEGORY)).toBe(false)
    // Still fully functional after the failed/partial hydration — and the one
    // valid JSONL line among the garbage did hydrate as pending.
    monitor.noteCommandExecution("npm test", Date.now())
    await new Promise((resolve) => setTimeout(resolve, 50))
    const state = JSON.parse(await readFile(path.join(tmpDir, "adaptive-state.json"), "utf8"))
    expect(state.overCompressionCounts[CATEGORY]).toBe(1)
  })

  it("round-trips hydrated + local state through persistState", async () => {
    await writeAdaptiveState(tmpDir, {
      overCompressionCounts: { yaml: 2 },
      goodStreaks: {},
      conservativeCategories: ["diff"],
    })

    const monitor = createCompressionQualityMonitor({ stateDir: tmpDir })
    await monitor.ready
    expect(monitor.isConservative("diff")).toBe(true)

    // A local event triggers persistState — the written snapshot must carry
    // the merged (hydrated + local) state, not just this instance's writes.
    monitor.recordCompression(makeEvent({ timestamp: Date.now() }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    const state = JSON.parse(await readFile(path.join(tmpDir, "adaptive-state.json"), "utf8"))
    expect(state.conservativeCategories).toContain("diff")
    expect(state.overCompressionCounts.yaml).toBe(2)
  })
})
