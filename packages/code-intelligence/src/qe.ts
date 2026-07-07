/**
 * Quality-estimation (QE) veto: catches the *silent* quality cliff that
 * self-reported abstention misses — a cheap-tier answer that is confidently
 * wrong. Draws a couple of samples for the same turn and vetoes acceptance
 * when they disagree, independent of whether the model itself abstained.
 *
 * Contract (OL-3.5a pseudo, DECOMPOSITION_ORCHESTRATION_PLAN.md §4.3/6):
 *   if abstained(out) or qe_low(out): escalate()
 *
 * The decision core (qeVerdict) is pure and deterministic — no LLM call, no
 * I/O — so it is unit-testable on fixed sample strings. The orchestration
 * wrapper (runQeVeto) is the only async piece: it calls a caller-supplied
 * sampler to draw the extra sample(s) and is bounded by a hard budget so QE
 * can never block a turn (budget exceeded → verdict "skipped", pass-through).
 *
 * @sem domain=routing role=qe-veto
 */

import { detectAbstention, type ConductorResult, type AbstentionResult } from "./abstention.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Agreement score in [0, 1] below which qeVerdict returns "veto". */
export const DEFAULT_AGREEMENT_THRESHOLD = 0.6

/** Default number of *additional* samples drawn beyond the first (N=2 total per the plan). */
export const DEFAULT_SAMPLE_COUNT = 1

/** Default hard wall-clock budget (ms) for drawing extra samples before skipping QE. */
export const DEFAULT_BUDGET_MS = 8000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for the pure agreement check. */
export interface QeOptions {
  /** Agreement score in [0, 1] below which the verdict is "veto". Default DEFAULT_AGREEMENT_THRESHOLD. */
  agreementThreshold?: number
}

/** Result of the pure self-consistency check across samples. */
export interface QeVerdict {
  verdict: "pass" | "veto"
  /** Mean pairwise token-overlap similarity across all samples, in [0, 1]. */
  agreement: number
  /** Human-readable explanation of the verdict. */
  reason: string
}

/** Options for the orchestration wrapper. */
export interface RunQeVetoOptions extends QeOptions {
  /** Number of *additional* samples to draw beyond the first. Default DEFAULT_SAMPLE_COUNT. */
  sampleCount?: number
  /** Hard wall-clock budget (ms) for drawing the extra samples. Default DEFAULT_BUDGET_MS. */
  budgetMs?: number
  /** Optional hook to estimate the token cost of a drawn sample (for savings accounting upstream). */
  estimateTokenCost?: (sample: string) => number
}

/** Result of the orchestration wrapper: the verdict plus measured cost. */
export interface RunQeVetoResult extends Omit<QeVerdict, "verdict"> {
  verdict: "pass" | "veto" | "skipped"
  /** All samples compared (first sample + any drawn extras). */
  samples: string[]
  /** Wall-clock time spent drawing extra samples, in ms. */
  latencyMs: number
  /** Sum of estimateTokenCost(sample) over the drawn extra samples, when the hook is supplied. */
  estimatedTokenCost?: number
}

/** Result of the combined abstention + QE veto entry point. */
export interface ShouldVetoCheapOutputResult {
  /** true when the turn should escalate (abstained OR qe_low). */
  veto: boolean
  /** Human-readable explanation of the combined decision. */
  reason: string
  abstention: AbstentionResult
  /** Present only when QE actually ran (skipped when abstention already short-circuited). */
  qe?: RunQeVetoResult
}

// ---------------------------------------------------------------------------
// qeVerdict — the pure decision core
// ---------------------------------------------------------------------------

const TOKEN_SPLIT_RE = /[^a-z0-9_]+/i

function tokenize(sample: string): Set<string> {
  return new Set(sample.toLowerCase().split(TOKEN_SPLIT_RE).filter(Boolean))
}

/** Jaccard similarity between two token sets: |intersection| / |union|, in [0, 1]. */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let intersection = 0
  for (const token of a) {
    if (b.has(token)) intersection++
  }
  const union = a.size + b.size - intersection
  return union === 0 ? 1 : intersection / union
}

/**
 * Compares N samples of the same turn's output and vetoes acceptance when
 * they diverge — the self-consistency signal that catches silent-wrong cheap
 * output (F7). Pure: no I/O, no side effects, deterministic on its inputs.
 *
 * Similarity is normalized token overlap (Jaccard) averaged over every
 * sample pair. Fewer than two samples means there is nothing to compare, so
 * the verdict defaults to "pass" (never veto on insufficient evidence).
 *
 * @sem domain=routing role=qe-veto
 */
export function qeVerdict(samples: string[], opts: QeOptions = {}): QeVerdict {
  const threshold = opts.agreementThreshold ?? DEFAULT_AGREEMENT_THRESHOLD

  if (samples.length < 2) {
    return {
      verdict: "pass",
      agreement: 1,
      reason: "fewer than 2 samples — nothing to compare, defaulting to pass",
    }
  }

  const tokenSets = samples.map(tokenize)
  let total = 0
  let pairs = 0
  for (let i = 0; i < tokenSets.length; i++) {
    for (let j = i + 1; j < tokenSets.length; j++) {
      total += jaccardSimilarity(tokenSets[i]!, tokenSets[j]!)
      pairs++
    }
  }
  const agreement = pairs === 0 ? 1 : total / pairs

  if (agreement < threshold) {
    return {
      verdict: "veto",
      agreement,
      reason: `sample agreement=${agreement.toFixed(2)} < threshold=${threshold} — samples diverge, silent-wrong risk`,
    }
  }

  return {
    verdict: "pass",
    agreement,
    reason: `sample agreement=${agreement.toFixed(2)} >= threshold=${threshold}`,
  }
}

// ---------------------------------------------------------------------------
// runQeVeto — the orchestration wrapper
// ---------------------------------------------------------------------------

/** Unique sentinel used to detect the budget timeout branch of the sample race. */
const BUDGET_TIMEOUT = Symbol("qe-budget-timeout")

/**
 * Draws the extra sample(s) needed for qeVerdict via a caller-supplied
 * sampler (no model client is hardwired here) and returns the verdict plus
 * measured latency and a token-cost estimate hook. Bounded by a hard budget:
 * if drawing samples would exceed it, QE is skipped and the turn passes
 * through — QE must never block a turn.
 *
 * @sem domain=routing role=qe-veto
 */
export async function runQeVeto(
  firstSample: string,
  generate: () => Promise<string>,
  opts: RunQeVetoOptions = {},
): Promise<RunQeVetoResult> {
  const {
    sampleCount = DEFAULT_SAMPLE_COUNT,
    budgetMs = DEFAULT_BUDGET_MS,
    estimateTokenCost,
    ...qeOpts
  } = opts

  const start = Date.now()

  if (budgetMs <= 0) {
    return {
      verdict: "skipped",
      agreement: 1,
      reason: "qe budget is zero — skipping, pass-through",
      samples: [firstSample],
      latencyMs: 0,
    }
  }

  const samples = [firstSample]
  let timedOut = false

  for (let i = 0; i < sampleCount; i++) {
    const remaining = budgetMs - (Date.now() - start)
    if (remaining <= 0) {
      timedOut = true
      break
    }

    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<typeof BUDGET_TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(BUDGET_TIMEOUT), remaining)
    })

    let sample: string | typeof BUDGET_TIMEOUT
    try {
      sample = await Promise.race([generate(), timeout])
    } catch {
      // Sampler failed — degrade safely by skipping QE rather than blocking the turn.
      clearTimeout(timer!)
      timedOut = true
      break
    }
    clearTimeout(timer!)

    if (sample === BUDGET_TIMEOUT) {
      timedOut = true
      break
    }
    samples.push(sample)
  }

  const latencyMs = Date.now() - start

  if (timedOut || samples.length < 2) {
    return {
      verdict: "skipped",
      agreement: 1,
      reason: timedOut
        ? `qe budget of ${budgetMs}ms exceeded — skipping, pass-through`
        : "no extra sample drawn — skipping, pass-through",
      samples,
      latencyMs,
    }
  }

  const verdict = qeVerdict(samples, qeOpts)
  const estimatedTokenCost = estimateTokenCost
    ? samples.slice(1).reduce((sum, sample) => sum + estimateTokenCost(sample), 0)
    : undefined

  return { ...verdict, samples, latencyMs, estimatedTokenCost }
}

// ---------------------------------------------------------------------------
// shouldVetoCheapOutput — the combined entry point for the slice loop
// ---------------------------------------------------------------------------

/**
 * Combines the existing abstention signal with the QE veto per the OL-3.5a
 * pseudo (`if abstained(out) or qe_low(out): escalate()`). Abstention is
 * checked first and short-circuits: when the conductor already signalled
 * unsure there is no need to spend a QE sample, so `generate` is never
 * called. Otherwise draws the extra sample(s) via `runQeVeto` and vetoes on
 * low agreement. This is the single entry point the slice loop (OL-7.3) wires.
 *
 * @sem domain=routing role=qe-veto
 */
export async function shouldVetoCheapOutput(
  conductorResult: ConductorResult,
  generate: () => Promise<string>,
  opts: RunQeVetoOptions = {},
): Promise<ShouldVetoCheapOutputResult> {
  const abstention = detectAbstention(conductorResult)
  if (abstention.abstained) {
    return {
      veto: true,
      reason: `abstained: ${abstention.reason}`,
      abstention,
    }
  }

  const qe = await runQeVeto(conductorResult.text ?? "", generate, opts)
  const veto = qe.verdict === "veto"

  return {
    veto,
    reason: veto ? `qe veto: ${qe.reason}` : `no veto: ${qe.reason}`,
    abstention,
    qe,
  }
}
