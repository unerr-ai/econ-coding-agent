/**
 * Region-aware compressor for composite shell commands (`a && b && c`) whose
 * output interleaves more than one command's stdout. Splits the stripped
 * lines into contiguous same-category regions by sliding-window content
 * sniffing, compresses each region with its own strategy (or the omni
 * fallback when a region isn't confidently sniffable), and prefixes each
 * region with a `lines A–B` header so retrieval-on-demand can map back onto
 * the tee-saved full-output file.
 *
 * @sem domain=tool role=compressor
 */

import type { OutputCategory } from "../classifier"
import { scoreContent } from "../classifier"
import { applyStrategy } from "../index"
import { compressOmni } from "./omni"

const WINDOW_SIZE = 10
const STEP = 5
const REGION_CONFIDENCE = 0.75

type RegionCategory = OutputCategory | "unknown"

interface WindowTag {
  start: number
  end: number
  category: RegionCategory
}

interface Region {
  start: number
  end: number
  category: RegionCategory
}

function classifyWindow(windowLines: string[]): RegionCategory {
  const scored = scoreContent(windowLines)
  return scored && scored.score >= REGION_CONFIDENCE ? scored.category : "unknown"
}

/** Slide a ~WINDOW_SIZE-line window (step ~STEP) over the lines, sniffing each. */
function tagWindows(lines: string[]): WindowTag[] {
  const n = lines.length
  const windows: WindowTag[] = []
  if (n === 0) return windows
  if (n <= WINDOW_SIZE) {
    windows.push({ start: 0, end: n, category: classifyWindow(lines) })
    return windows
  }
  let start = 0
  while (start < n) {
    const end = Math.min(start + WINDOW_SIZE, n)
    windows.push({ start, end, category: classifyWindow(lines.slice(start, end)) })
    if (end >= n) break
    start += STEP
  }
  return windows
}

/** Per-line category: overlapping windows must agree, else conservatively "unknown". */
function lineCategories(lines: string[], windows: WindowTag[]): RegionCategory[] {
  const perLine: (RegionCategory | undefined)[] = new Array(lines.length)
  for (const w of windows) {
    for (let i = w.start; i < w.end; i++) {
      const existing = perLine[i]
      if (existing === undefined) perLine[i] = w.category
      else if (existing !== w.category) perLine[i] = "unknown"
    }
  }
  return perLine.map((c) => c ?? "unknown")
}

function toRuns(categories: RegionCategory[]): Region[] {
  const runs: Region[] = []
  let i = 0
  while (i < categories.length) {
    let j = i + 1
    while (j < categories.length && categories[j] === categories[i]) j++
    runs.push({ start: i, end: j, category: categories[i]! })
    i = j
  }
  return runs
}

/**
 * A category run shorter than one full window wasn't sustained long enough
 * to trust — downgrade it to "unknown" (conservative merge) and re-collapse
 * adjacent runs that now share a category.
 */
function enforceSustained(runs: Region[]): Region[] {
  const downgraded = runs.map((r): Region =>
    r.category !== "unknown" && r.end - r.start < WINDOW_SIZE ? { ...r, category: "unknown" } : r,
  )
  const merged: Region[] = []
  for (const r of downgraded) {
    const last = merged[merged.length - 1]
    if (last && last.category === r.category) last.end = r.end
    else merged.push({ ...r })
  }
  return merged
}

function formatHeader(region: Region): string {
  return `── lines ${region.start + 1}–${region.end} · ${region.category} ──`
}

/**
 * Split a composite command's stripped output into contiguous regions by
 * content sniffing, compress each region with its own strategy, and return
 * the assembled result — or null when the split isn't worth it (fewer than
 * two distinct-category regions — "unknown" counts as a category, since a
 * single confident region plus a leftover unknown tail still beats a flat
 * omni pass — or the result doesn't come out shorter), so the caller falls
 * back to the omni dedup-only path.
 */
export function compressMultiRegion(stripped: string, command: string, exitCode?: number): string | null {
  const lines = stripped.replace(/\r\n/g, "\n").split("\n")
  if (lines.length === 0) return null

  const windows = tagWindows(lines)
  const runs = enforceSustained(toRuns(lineCategories(lines, windows)))

  const distinctCategories = new Set(runs.map((r) => r.category))
  if (distinctCategories.size < 2) return null

  const parts: string[] = []
  for (const run of runs) {
    const regionText = lines.slice(run.start, run.end).join("\n")
    let body: string
    if (run.category === "unknown") {
      body = compressOmni(regionText)
    } else {
      try {
        body = applyStrategy(run.category, regionText, command, exitCode)
      } catch {
        body = compressOmni(regionText)
      }
    }
    parts.push(`${formatHeader(run)}\n${body}`)
  }

  const assembled = parts.join("\n")
  if (assembled.length >= stripped.length) return null
  return assembled
}
