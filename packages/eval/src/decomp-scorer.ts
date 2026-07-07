/**
 * Scores a decomposition-quality case (OL-7.4): converts its canned
 * conductor todos into a slice DAG via the real `todosToLoopSlices` and
 * allocates each slice via the real `allocateSlice` — then compares the
 * result against the case's hand-labeled expected slices. Pure/offline: no
 * model call, no live probe (fixtures always pre-tag
 * `coupling`/`testStrength`, so the OL-7.9 probe functions are never
 * invoked — see `unreachableProbes`).
 *
 * Dependency/cycle soundness (`deps_sane`) is checked with the package's
 * public `planWaves` (the DAG-ordering scheduler from `slice-loop.ts`) — it
 * throws on an unknown dependency id or a dependency cycle, which
 * `checkDepsSane` catches and reports as a note.
 * @sem domain=eval role=scoring
 */

import { allocateSlice, planWaves, type LoopSlice } from "@opencode-ai/code-intelligence"
import { todosToLoopSlices, type SliceProbes } from "opencode/session/slice-orchestrator"
import type { DecompCase, DecompResult, DecompSignals, ExpectedSlice } from "./decomp-types.js"

/**
 * Probe stand-in that always throws — every fixture pre-tags
 * `coupling`/`testStrength` on its todos, so `todosToLoopSlices` must never
 * fall through to a live probe. A throw here means a case fixture is
 * missing a tag, not a real probe failure.
 */
const unreachableProbes: SliceProbes = {
  probeCoupling: () => {
    throw new Error("decomp-scorer: probeCoupling invoked — fixture todo is missing a coupling tag")
  },
  probeTestStrength: () => {
    throw new Error("decomp-scorer: probeTestStrength invoked — fixture todo is missing a testStrength tag")
  },
}

function findSlice(slices: readonly LoopSlice[], content: string): LoopSlice | undefined {
  return slices.find((s) => s.prompt === content)
}

/** No missed/unresolved dependency and no cycle, and every expected dep edge is present. */
function checkDepsSane(slices: readonly LoopSlice[], expected: readonly ExpectedSlice[], notes: string[]): boolean {
  try {
    planWaves(slices)
  } catch (err) {
    notes.push(`deps_sane: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
  let ok = true
  for (const exp of expected) {
    const slice = findSlice(slices, exp.content)
    if (!slice) {
      notes.push(`deps_sane: no produced slice for expected "${exp.content}"`)
      ok = false
      continue
    }
    const actual = new Set(slice.deps ?? [])
    const wanted = new Set(exp.deps ?? [])
    if (actual.size !== wanted.size || [...wanted].some((d) => !actual.has(d))) {
      notes.push(`deps_sane: "${exp.content}" deps [${[...actual].join(", ")}] != expected [${[...wanted].join(", ")}]`)
      ok = false
    }
  }
  return ok
}

/** Every expected slice's produced sliceType matches the hand-labeled expectation. */
function checkSliceTypesValid(slices: readonly LoopSlice[], expected: readonly ExpectedSlice[], notes: string[]): boolean {
  let ok = true
  for (const exp of expected) {
    const slice = findSlice(slices, exp.content)
    if (!slice || slice.sliceType !== exp.sliceType) {
      notes.push(`slice_types_valid: "${exp.content}" sliceType=${slice?.sliceType} != expected ${exp.sliceType}`)
      ok = false
    }
  }
  return ok
}

/** The produced slice count matches the expected count — catches over- or under-fragmentation. */
function checkNoOverFragmentation(slices: readonly LoopSlice[], expected: readonly ExpectedSlice[], notes: string[]): boolean {
  if (slices.length !== expected.length) {
    notes.push(`no_over_fragmentation: produced ${slices.length} slices, expected ${expected.length}`)
    return false
  }
  return true
}

/**
 * For every slice flagged `needHintShouldBeIgnored`, the real allocator's
 * tier must NOT equal the (over-eager) `need` hint the todo carried — the
 * safety-net invariant (OL-7.2) must have held.
 */
function checkNeedNotOverEscalating(
  slices: readonly LoopSlice[],
  expected: readonly ExpectedSlice[],
  notes: string[],
): boolean {
  let ok = true
  for (const exp of expected) {
    if (!exp.needHintShouldBeIgnored) continue
    const slice = findSlice(slices, exp.content)
    if (!slice) {
      ok = false
      continue
    }
    const allocation = allocateSlice({
      sliceType: slice.sliceType,
      coupling: slice.coupling,
      testStrength: slice.testStrength,
      need: slice.need,
    })
    if (allocation.tier === slice.need) {
      notes.push(`need_not_over_escalating: "${exp.content}" tier was raised to the need hint "${slice.need}"`)
      ok = false
    }
  }
  return ok
}

/** Every slice's real `allocateSlice` output (tier + verifier rung) matches its expected matrix cell. */
function checkAllocationMatchesCell(
  slices: readonly LoopSlice[],
  expected: readonly ExpectedSlice[],
  notes: string[],
): boolean {
  let ok = true
  for (const exp of expected) {
    const slice = findSlice(slices, exp.content)
    if (!slice) {
      ok = false
      continue
    }
    const allocation = allocateSlice({
      sliceType: slice.sliceType,
      coupling: slice.coupling,
      testStrength: slice.testStrength,
      need: slice.need,
    })
    if (allocation.tier !== exp.tier || allocation.verification !== exp.verification) {
      notes.push(
        `allocation_matches_cell: "${exp.content}" got tier=${allocation.tier}/verification=${allocation.verification}` +
          ` != expected tier=${exp.tier}/verification=${exp.verification}`,
      )
      ok = false
    }
  }
  return ok
}

/**
 * Scores one case: runs its `mockTodos` through the real `todosToLoopSlices`
 * (probes unreachable — every fixture is pre-tagged) and checks the five
 * OL-7.4 signals against `expectedSlices`. All five signals are always
 * applicable, so the weighted score is their equal-weighted average.
 */
export async function scoreDecompCase(decompCase: DecompCase): Promise<DecompResult> {
  const notes: string[] = []
  const slices = await todosToLoopSlices(decompCase.mockTodos, unreachableProbes)

  const signals: DecompSignals = {
    slice_types_valid: checkSliceTypesValid(slices, decompCase.expectedSlices, notes),
    deps_sane: checkDepsSane(slices, decompCase.expectedSlices, notes),
    no_over_fragmentation: checkNoOverFragmentation(slices, decompCase.expectedSlices, notes),
    need_not_over_escalating: checkNeedNotOverEscalating(slices, decompCase.expectedSlices, notes),
    allocation_matches_cell: checkAllocationMatchesCell(slices, decompCase.expectedSlices, notes),
  }

  const keys = Object.keys(signals) as (keyof DecompSignals)[]
  const weightedScore = keys.reduce((sum, k) => sum + (signals[k] ? 1 : 0), 0) / keys.length

  return {
    caseId: decompCase.id,
    signals,
    weightedScore,
    threshold: decompCase.threshold,
    pass: weightedScore >= decompCase.threshold,
    notes,
  }
}

/** Renders a human-readable report for a set of decomposition-quality results. */
export function renderDecompReport(results: DecompResult[]): string {
  const lines: string[] = []
  lines.push("\necon eval — decomposition quality (OL-7.4)")
  lines.push("=".repeat(60))
  for (const r of results) {
    const icon = r.pass ? "✓" : "✗"
    lines.push(`  ${icon} ${r.caseId}  score=${r.weightedScore.toFixed(2)} (threshold=${r.threshold})`)
    lines.push(
      `       types=${r.signals.slice_types_valid} deps=${r.signals.deps_sane} ` +
        `fragmentation=${r.signals.no_over_fragmentation} need=${r.signals.need_not_over_escalating} ` +
        `allocation=${r.signals.allocation_matches_cell}`,
    )
    for (const note of r.notes) lines.push(`       - ${note}`)
  }
  lines.push("")
  return lines.join("\n")
}
