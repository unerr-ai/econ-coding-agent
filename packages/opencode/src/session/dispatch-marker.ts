import {
  TURN_READ_PROMPT_MARKER,
  REPRO_FIDELITY_PROMPT_MARKER,
  HUB_DESIGN_PROMPT_MARKER,
  SLICE_CONFIDENCE_PROBE_MARKER,
} from "./prompts/judges"
import { CROSS_MODEL_JUDGE_PROMPT_MARKER } from "../../../code-intelligence/src/judge"

/**
 * Registry of every root-turn orchestration-dispatch call's stable prompt
 * lead-in (turn-read, repro-fidelity, hub-design, the cross-model verifier
 * judge, the slice confidence probe) — a housekeeping `generateText`
 * completion that runs ahead of or beside the main turn round, never as
 * part of it. Each entry is existing prompt text (nothing added), so a real
 * provider sees byte-for-byte the same request it always did; a test
 * harness matches a request's serialized body against this list to answer
 * dispatch calls out-of-band without shifting the main round's scripted
 * reply queue or counting toward its call tally. Add a future dispatch's
 * marker here so the harness picks it up without a separate wire-up.
 *
 * @sem domain=routing role=dispatch-marker
 */
export const DISPATCH_PROMPT_MARKERS: readonly string[] = [
  TURN_READ_PROMPT_MARKER,
  REPRO_FIDELITY_PROMPT_MARKER,
  HUB_DESIGN_PROMPT_MARKER,
  CROSS_MODEL_JUDGE_PROMPT_MARKER,
  SLICE_CONFIDENCE_PROBE_MARKER,
]

/** True when a provider chat-completion request `body` belongs to one of the dispatches listed in `DISPATCH_PROMPT_MARKERS` — matched by that dispatch's own stable prompt lead-in, never by call order or count. */
export function isDispatchRequest(body: unknown): boolean {
  if (!body || typeof body !== "object") return false
  const text = JSON.stringify(body)
  return DISPATCH_PROMPT_MARKERS.some((marker) => text.includes(marker))
}
