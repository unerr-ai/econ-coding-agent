/**
 * Dedicated `git status` parser — strips boilerplate, groups files by dir.
 * Ported from unerr-cli src/proxy/shell-strategies/git-status.ts — no external deps.
 * ~70-85% token savings vs. raw output; returns null on unrecognized formats.
 */

const HELP_RE = /^\s*\(use\b.*\)\s*$/i
const BRANCH_RE = /^On branch (.+)$/
const TRACKING_RE = /^Your branch is (.+)$/
const SECTION_HEADERS = new Map<string, string>([
  ["Changes to be committed:", "staged"],
  ["Changes not staged for commit:", "modified"],
  ["Untracked files:", "untracked"],
  ["Unmerged paths:", "unmerged"],
])

type Bucket = "staged" | "modified" | "untracked" | "unmerged"

interface DirAgg {
  total: number
  byExt: Map<string, number>
}

function extOf(p: string): string {
  const base = p.slice(p.lastIndexOf("/") + 1)
  const dot = base.lastIndexOf(".")
  if (dot <= 0 || dot === base.length - 1) return "(no-ext)"
  return base.slice(dot).toLowerCase()
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/")
  return i >= 0 ? `${p.slice(0, i)}/` : "./"
}

function topExt(byExt: Map<string, number>, k = 3): string {
  const sorted = [...byExt.entries()].sort((a, b) => b[1] - a[1])
  return sorted
    .slice(0, k)
    .map(([ext, n]) => `${n} ${ext}`)
    .join(", ")
}

/**
 * Compress `git status` output. Returns null if input doesn't look like
 * default git status format (e.g. porcelain v2) so caller can fall back.
 */
export function compressGitStatus(raw: string): string | null {
  const lines = raw.replace(/\r\n/g, "\n").split("\n")
  if (lines.length === 0) return null

  if (!lines.some((l) => /^On branch /.test(l) || /^HEAD detached/.test(l))) return null

  let branch = ""
  let tracking = ""
  let currentBucket: Bucket | null = null
  const buckets: Record<Bucket, { files: string[]; statuses: Map<string, number> }> = {
    staged: { files: [], statuses: new Map() },
    modified: { files: [], statuses: new Map() },
    untracked: { files: [], statuses: new Map() },
    unmerged: { files: [], statuses: new Map() },
  }
  let trailingMsg = ""

  for (const line of lines) {
    if (!line.trim()) continue
    if (HELP_RE.test(line)) continue

    const branchMatch = line.match(BRANCH_RE)
    if (branchMatch) {
      branch = branchMatch[1] ?? ""
      continue
    }

    const trackingMatch = line.match(TRACKING_RE)
    if (trackingMatch) {
      tracking = trackingMatch[1] ?? ""
      continue
    }

    const sectionKey = SECTION_HEADERS.get(line.trim())
    if (sectionKey) {
      currentBucket = sectionKey as Bucket
      continue
    }

    if (
      /^(?:no changes added to commit|nothing to commit|nothing added|on branch \S+ nothing|.*working tree clean)/i.test(
        line.trim(),
      )
    ) {
      trailingMsg = line
        .trim()
        .replace(/\s*\(use\b[^)]*\)\s*/g, "")
        .trim()
      currentBucket = null
      continue
    }

    if (currentBucket) {
      if (!line.startsWith("\t") && !line.startsWith("    ")) {
        currentBucket = null
        continue
      }
      const stripped = line.replace(/^\t/, "").trim()
      if (!stripped) continue
      const m = stripped.match(/^([a-zA-Z ]+):\s+(.+?)(?:\s+->\s+(.+))?$/)
      if (m) {
        const status = m[1]?.trim() ?? ""
        const p = (m[3] ?? m[2] ?? "").trim()
        buckets[currentBucket].files.push(p)
        buckets[currentBucket].statuses.set(status, (buckets[currentBucket].statuses.get(status) ?? 0) + 1)
      } else {
        buckets[currentBucket].files.push(stripped)
      }
    }
  }

  const totalFiles =
    buckets.staged.files.length +
    buckets.modified.files.length +
    buckets.untracked.files.length +
    buckets.unmerged.files.length

  if (totalFiles === 0 && !branch) return null

  const out: string[] = []
  const branchLine = branch ? (tracking ? `branch=${branch}; ${tracking}` : `branch=${branch}`) : ""
  if (branchLine) out.push(branchLine)

  const sectionOrder: Bucket[] = ["staged", "modified", "untracked", "unmerged"]
  for (const bucket of sectionOrder) {
    const b = buckets[bucket]
    if (b.files.length === 0) continue
    const statusSummary =
      b.statuses.size > 0
        ? ` (${[...b.statuses.entries()].map(([s, n]) => `${n} ${s}`).join(", ")})`
        : ""
    out.push(`${bucket}: ${b.files.length}${statusSummary}`)
    if (b.files.length <= 6) {
      for (const f of b.files) out.push(`  ${f}`)
    } else {
      const byDir = new Map<string, DirAgg>()
      for (const f of b.files) {
        const dir = dirOf(f)
        let agg = byDir.get(dir)
        if (!agg) {
          agg = { total: 0, byExt: new Map() }
          byDir.set(dir, agg)
        }
        agg.total++
        const ext = extOf(f)
        agg.byExt.set(ext, (agg.byExt.get(ext) ?? 0) + 1)
      }
      const sortedDirs = [...byDir.entries()].sort((a, b2) => b2[1].total - a[1].total)
      for (const [dir, agg] of sortedDirs.slice(0, 8)) {
        out.push(`  ${dir} (${agg.total}: ${topExt(agg.byExt)})`)
      }
      if (sortedDirs.length > 8) out.push(`  … ${sortedDirs.length - 8} more directories`)
    }
  }

  if (trailingMsg) out.push(trailingMsg)
  return out.join("\n")
}
