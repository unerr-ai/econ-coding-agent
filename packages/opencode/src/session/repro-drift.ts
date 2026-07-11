// Repro-drift classifier — the NUDGE_V2-style tiered anti-drift port onto the
// repro-first contract (targeted, event-triggered, once-per-kind, silent
// otherwise). Two strict 11790 runs showed the conductor never authoring a
// pinnable `repro_issue.*` file: inline `python -c` one-liners for 12 steps
// in one run, an attempt to edit the existing suite (denied) in the other.
// This module distils one observed SM4 step into the drift kinds it
// exhibits; prompt.ts's SM4 block Set-tracks which kinds already nudged this
// turn and fires at most once per kind, escalating once past a threshold.

import { reproSpecificity } from "./slice-orchestrator"

export type ReproDriftKind = "inline-repro" | "suite-edit-denied" | "unpinnable-red"

// A failed command shaped like a throwaway inline invocation (`python -c`,
// `python3 -c`, `node -e`, or a shell heredoc `<<`) rather than a standalone
// file the turn-end gate can re-run and pin.
const INLINE_EXEC_SHAPE_RE = /\b(?:python3?|node)\s+-[ce]\b|<<-?\s*['"]?[A-Za-z_]\w*['"]?/i
// The inline command actually carries a check (not just setup/prose) — an
// assertion, a raised exception, or a JS-style expect() call.
const ASSERTION_CONTENT_RE = /\b(?:assert|raise)\b|expect\s*\(/i

// The no-test-edit gate's deny reason (edit-governance.ts's
// `testEditDenialMessage`) always opens with this phrase. Mirrors prompt.ts's
// `scanGateBlocks` part-scanning shape: an errored edit/write tool part
// carries its reason in `state.error`, not `state.output`.
const EDIT_WRITE_TOOLS = new Set(["edit", "write", "apply_patch"])
const SUITE_EDIT_DENIED_RE = /no-test-edit gate/i

function hasSuiteEditDenial(parts: readonly unknown[]): boolean {
  for (const raw of parts) {
    const part = raw as { type?: string; tool?: string; state?: { status?: string; error?: string } }
    if (part?.type !== "tool" || !part.tool || !EDIT_WRITE_TOOLS.has(part.tool)) continue
    if (part.state?.status !== "error") continue
    if (SUITE_EDIT_DENIED_RE.test(part.state?.error ?? "")) return true
  }
  return false
}

/**
 * The repro-first anti-drift signals a single observed step carries: an
 * inline one-liner standing in for a pinnable file, a suite-edit denial that
 * needs redirecting toward a scratch repro, or every failed command this
 * step ran being structurally unpinnable (whole-suite or multi-line/batched
 * — same rule as `reproSpecificity`). Pure and step-scoped, like
 * turn-supervisor's `observeStep`; the caller Set-tracks which kinds already
 * fired this turn so each nudges at most once, silent otherwise.
 *
 * @sem domain=routing role=digest
 */
export function classifyReproDrift(input: {
  failedCommands: readonly string[]
  parts: readonly unknown[]
}): ReproDriftKind[] {
  const kinds: ReproDriftKind[] = []
  if (input.failedCommands.some((cmd) => INLINE_EXEC_SHAPE_RE.test(cmd) && ASSERTION_CONTENT_RE.test(cmd))) {
    kinds.push("inline-repro")
  }
  if (hasSuiteEditDenial(input.parts)) {
    kinds.push("suite-edit-denied")
  }
  if (
    input.failedCommands.length > 0 &&
    input.failedCommands.every((cmd) => reproSpecificity({ kind: "test", command: cmd }) === 0)
  ) {
    kinds.push("unpinnable-red")
  }
  return kinds
}
