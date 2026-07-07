/**
 * Scores everyday-capability cases (OL-7.12) — trivial-turn latency delta,
 * clarify-vs-guess correctness, and multi-turn coherence after compaction —
 * and rolls per-case results up into the combined flip-gate verdict (per
 * DECOMPOSITION_ORCHESTRATION_PLAN.md §6/§8). Orchestration is unconditional
 * in production as of 2026-07-04, so this remains a quality bar, not a
 * default-flip gate.
 * @sem domain=eval role=scoring
 */

import type {
  ClarifyCase,
  CoherenceCase,
  EverydayCase,
  EverydayMetric,
  EverydayResult,
  EverydayTurn,
  FlipGateSummary,
  LatencyCase,
} from "./everyday-types.js"
import { TEST_POOR_REPOS } from "./test-poor-repos.js"

/** Heuristic: does this turn's text read like a clarifying question rather than a guess-and-act? */
const CLARIFY_QUESTION_RE = /\?\s*$/
const CLARIFY_KEYWORD_RE = /\b(which|could you clarify|do you mean|can you confirm|not sure|ambiguous|to confirm)\b/i

function looksLikeClarifyingQuestion(turn: EverydayTurn): boolean {
  const text = turn.textParts.join(" ").trim()
  if (!text) return false
  return CLARIFY_QUESTION_RE.test(text) || CLARIFY_KEYWORD_RE.test(text)
}

function scoreLatencyCase(c: LatencyCase): EverydayResult {
  const delta = c.decomposeLatencyMs - c.baselineLatencyMs
  const pass = delta <= c.maxDeltaMs
  return {
    caseId: c.id,
    metric: c.metric,
    score: delta,
    threshold: c.maxDeltaMs,
    pass,
    detail: `decompose-baseline delta=${delta}ms (max=${c.maxDeltaMs}ms)`,
  }
}

function scoreClarifyCase(c: ClarifyCase): EverydayResult {
  const clarified = looksLikeClarifyingQuestion(c.mockTrace)
  // ambiguous prompt → correct behavior is to clarify; unambiguous control → correct behavior is to NOT clarify.
  const correct = c.ambiguous ? clarified : !clarified
  const score = correct ? 1 : 0
  return {
    caseId: c.id,
    metric: c.metric,
    score,
    threshold: c.threshold,
    pass: score >= c.threshold,
    detail: `ambiguous=${c.ambiguous} clarified=${clarified}`,
  }
}

function scoreCoherenceCase(c: CoherenceCase): EverydayResult {
  const scoredTurn = c.mockTurns[c.compactionAtTurn]
  const scoredText = (scoredTurn?.textParts ?? []).join(" ").toLowerCase()
  const recalled = scoredText.includes(c.factToRecall.toLowerCase())
  const score = recalled ? 1 : 0
  return {
    caseId: c.id,
    metric: c.metric,
    score,
    threshold: c.threshold,
    pass: score >= c.threshold,
    detail: `fact "${c.factToRecall}" ${recalled ? "recalled" : "lost"} at turn ${c.compactionAtTurn} (post-compaction)`,
  }
}

/** Scores one everyday-capability case against its own gate. */
export function scoreEverydayCase(c: EverydayCase): EverydayResult {
  switch (c.metric) {
    case "trivial_latency":
      return scoreLatencyCase(c)
    case "clarify_vs_guess":
      return scoreClarifyCase(c)
    case "multiturn_coherence":
      return scoreCoherenceCase(c)
  }
}

/**
 * Rolls scored results up into the combined flip-gate verdict: every metric
 * category must have a 100% pass rate among its cases, and the case set must
 * include at least one test-poor repo (the honesty condition OL-7.12 exists
 * to enforce — a set with no test-poor repo cannot claim this gate).
 */
export function evaluateFlipGate(cases: EverydayCase[], results: EverydayResult[]): FlipGateSummary {
  const metrics: EverydayMetric[] = ["trivial_latency", "clarify_vs_guess", "multiturn_coherence"]
  const perMetric = {} as FlipGateSummary["perMetric"]
  for (const metric of metrics) {
    const forMetric = results.filter((r) => r.metric === metric)
    const passCount = forMetric.filter((r) => r.pass).length
    perMetric[metric] = {
      pass: forMetric.length > 0 && passCount === forMetric.length,
      passRate: forMetric.length > 0 ? passCount / forMetric.length : 0,
      count: forMetric.length,
    }
  }

  const repoIdsInCases = new Set(
    cases.flatMap((c) => (c.metric === "trivial_latency" ? (c.repoId ? [c.repoId] : []) : [c.repoId])),
  )
  const includesTestPoorRepo = TEST_POOR_REPOS.some((r) => repoIdsInCases.has(r.id))

  const pass = includesTestPoorRepo && metrics.every((m) => perMetric[m].pass)

  return { pass, perMetric, includesTestPoorRepo, results }
}

/** Renders a human-readable report — the pass/fail summary CP-D cites for the default-flip criterion. */
export function renderEverydayReport(summary: FlipGateSummary): string {
  const lines: string[] = []
  lines.push("\necon eval — everyday capability (OL-7.12 honesty gate)")
  lines.push("=".repeat(60))
  for (const r of summary.results) {
    const icon = r.pass ? "✓" : "✗"
    lines.push(`  ${icon} [${r.metric}] ${r.caseId} — ${r.detail}`)
  }
  lines.push("-".repeat(60))
  for (const [metric, m] of Object.entries(summary.perMetric)) {
    const icon = m.pass ? "✓" : "✗"
    lines.push(`  ${icon} ${metric}: ${(m.passRate * 100).toFixed(0)}% (${m.count} case(s))`)
  }
  lines.push(`  test-poor repo in set: ${summary.includesTestPoorRepo ? "yes" : "NO"}`)
  lines.push("=".repeat(60))
  lines.push(`FLIP GATE: ${summary.pass ? "PASS — cites clear for OL-7.6 default flip" : "FAIL — default stays risk-veto"}`)
  lines.push("")
  return lines.join("\n")
}
