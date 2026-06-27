/**
 * Aggregates per-run results into a scored shortlist, groups by tier, and
 * renders the human-readable report printed to stdout.
 * @sem domain=eval role=scoring
 */

import type { RunResult, ScoredShortlist, Tier, TierScore } from "./types.js"

const TIERS: Tier[] = ["conductor", "executor", "oracle"]

/**
 * Groups raw RunResults by tier+model and computes aggregate metrics.
 * Multiple fixtures for the same model+tier are averaged / summed.
 */
export function score(results: RunResult[]): ScoredShortlist {
  // Group by tier → modelName → runs[]
  const byTierModel = new Map<string, RunResult[]>()
  for (const r of results) {
    const key = `${r.tier}::${r.modelName}`
    const bucket = byTierModel.get(key) ?? []
    bucket.push(r)
    byTierModel.set(key, bucket)
  }

  const shortlist: ScoredShortlist = {
    conductor: [],
    executor: [],
    oracle: [],
  }

  for (const [key, runs] of byTierModel) {
    const [tier] = key.split("::") as [Tier, string]
    const passCount = runs.filter((r) => r.pass).length
    const avgLatencyMs = runs.reduce((s, r) => s + r.latencyMs, 0) / runs.length
    const totalInputTokens = runs.reduce((s, r) => s + r.inputTokens, 0)
    const totalOutputTokens = runs.reduce((s, r) => s + r.outputTokens, 0)
    const totalCostUsd = runs.reduce((s, r) => s + r.costUsd, 0)

    const ts: TierScore = {
      tier,
      modelName: runs[0]!.modelName,
      passRate: passCount / runs.length,
      avgLatencyMs,
      totalInputTokens,
      totalOutputTokens,
      totalCostUsd,
      runs,
    }
    shortlist[tier].push(ts)
  }

  // Sort each tier by pass-rate desc, then cost asc.
  for (const tier of TIERS) {
    shortlist[tier].sort((a, b) => {
      if (b.passRate !== a.passRate) return b.passRate - a.passRate
      return a.totalCostUsd - b.totalCostUsd
    })
  }

  return shortlist
}

/** Renders a human-readable scored shortlist to a string. */
export function renderReport(shortlist: ScoredShortlist, dryRun: boolean): string {
  const lines: string[] = []

  const tag = dryRun ? " [DRY-RUN / mock responses]" : ""
  lines.push(`\necon eval harness — scored shortlist${tag}`)
  lines.push("=".repeat(60))

  for (const tier of TIERS) {
    const scores = shortlist[tier]
    if (scores.length === 0) continue

    lines.push(`\n## Tier: ${tier.toUpperCase()}`)
    lines.push("-".repeat(40))

    for (const [i, ts] of scores.entries()) {
      const rank = i + 1
      const passLabel = `${(ts.passRate * 100).toFixed(0)}% pass (${ts.runs.filter((r) => r.pass).length}/${ts.runs.length})`
      const costLabel = `$${ts.totalCostUsd.toFixed(6)} total`
      const latLabel = `${ts.avgLatencyMs.toFixed(0)} ms avg`
      const tokLabel = `${ts.totalInputTokens}↑ / ${ts.totalOutputTokens}↓ tokens`
      lines.push(`  ${rank}. ${ts.modelName}`)
      lines.push(`     pass=${passLabel}  latency=${latLabel}  tokens=${tokLabel}  cost=${costLabel}`)

      for (const r of ts.runs) {
        const icon = r.pass ? "✓" : "✗"
        const errSuffix = r.error ? `  [ERROR: ${r.error}]` : ""
        lines.push(`       ${icon} ${r.fixtureId}${errSuffix}`)
      }
    }
  }

  lines.push("")
  return lines.join("\n")
}
