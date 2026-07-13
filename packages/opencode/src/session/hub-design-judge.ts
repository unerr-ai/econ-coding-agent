/**
 * Wave 7 — hub-design judge: a synchronous, reasoner-tier LLM call that
 * fires at the hub-shopping trigger (prompt.ts's `hubDesignDispatch`, right
 * after the L4.2 grind valve) once a session has bounced two DISTINCT
 * shared hub files in one turn. Wave 6's fix was a todo-plant the conductor
 * routinely clobbered/ignored — it spawned its own paraphrased Task
 * subagent, generic delegation routed that to the executor tier, and the
 * executor handed back a symptom-layer verdict the conductor then
 * implemented. This module makes the design call itself: given the issue
 * text, the bounced files, and graph-grounded definition sites for the
 * issue's named symbols, it decides the ROOT-MOST fix site and returns the
 * verdict for the trigger to inject directly into its nudge — never a
 * todo the model can ignore. Same DEGRADED-sentinel, provider-free,
 * `complete`-callback-injection discipline as `repro-fidelity-judge.ts`.
 *
 * @sem domain=routing role=hub-design-judge
 */
import { extractJsonObject } from "../util/json-extract"
import { HUB_DESIGN_SYSTEM_PROMPT } from "./prompts/judges"

/**
 * The hub-design verdict: the ROOT-MOST fix site the judge decided on —
 * the file and entity that DEFINE the misbehaving class or function, plus
 * the concrete change to make there.
 *
 * @sem domain=routing role=hub-design-judge
 */
export interface HubDesignVerdict {
  readonly file: string
  readonly entity: string
  readonly change: string
}

/**
 * The ONE posture a malformed/failed judge call resolves to: an empty
 * verdict the caller (prompt.ts) recognizes by reference and falls back to
 * `hubDesignDegradedNudgeText` for — never a guessed file/entity/change.
 *
 * @sem domain=routing role=hub-design-judge
 */
export const DEGRADED_HUB_DESIGN: HubDesignVerdict = { file: "", entity: "", change: "" }

/**
 * One request to the injected completion — the caller (prompt.ts) owns the
 * provider path and tier resolution; this module never names a model.
 *
 * @sem domain=routing role=hub-design-judge
 */
export type HubDesignComplete = (request: { system: string; user: string }) => Promise<string>

/**
 * Input to `runHubDesignJudge`: the turn's issue text, the hub files edits
 * have already bounced on, and the graph-grounded definition sites for the
 * issue's named symbols (from `graph-tools.ts`'s
 * `issueSymbolDefinitionSites` — this module never touches the graph
 * itself), plus the injected completion port.
 *
 * @sem domain=routing role=hub-design-judge
 */
export interface RunHubDesignJudgeInput {
  readonly issueText: string
  readonly bouncedFiles: readonly string[]
  readonly definitionSites: readonly { symbol: string; kind: string; file: string }[]
  readonly complete: HubDesignComplete
}

/** Builds the user prompt: the issue, the denied hub files, and the graph's definition-site evidence. */
function buildHubDesignUserPrompt(input: {
  issueText: string
  bouncedFiles: readonly string[]
  definitionSites: readonly { symbol: string; kind: string; file: string }[]
}): string {
  const { issueText, bouncedFiles, definitionSites } = input
  const sitesText = definitionSites.length
    ? definitionSites.map((s) => `${s.symbol} — ${s.kind} — ${s.file}`).join("\n")
    : "(none found)"
  return (
    `## Issue\n${issueText}\n\n` +
    `## Denied edit sites\nEdits so far were DENIED on these shared hub files (do not name them unless one is genuinely the defining module): ${bouncedFiles.join(", ")}\n\n` +
    `## Definition sites of symbols the issue names (from the code graph)\n${sitesText}\n\n` +
    `## Question\nWhich module DEFINES the misbehaving class or function, and what is the concrete fix there?`
  )
}

/**
 * Parse the judge's raw completion into a verdict: extracts the first
 * balanced JSON object and validates `file`, `entity`, and `change` are
 * all non-empty (after trim) strings. Any missing/blank/non-string field,
 * no balanced JSON, or malformed JSON returns `null` — never throws.
 *
 * @sem domain=routing role=hub-design-judge
 */
export function parseHubDesignResponse(raw: string): HubDesignVerdict | null {
  if (!raw) return null
  const jsonText = extractJsonObject(raw)
  if (!jsonText) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return null
  }

  if (typeof parsed !== "object" || parsed === null) return null
  const candidate = parsed as Record<string, unknown>
  const file = typeof candidate.file === "string" ? candidate.file.trim() : ""
  const entity = typeof candidate.entity === "string" ? candidate.entity.trim() : ""
  const change = typeof candidate.change === "string" ? candidate.change.trim() : ""
  if (!file || !entity || !change) return null

  return { file, entity, change }
}

/**
 * Run the hub-design judge: ONE forced-JSON completion deciding the
 * root-most fix site for a hub-shopping turn — no retry, this fires at
 * most once per turn (the caller enforces that). A thrown `complete`, or
 * any parse failure, degrades to `DEGRADED_HUB_DESIGN` — the caller falls
 * back to asking the model to re-derive the site itself, never blocks.
 *
 * @sem domain=routing role=hub-design-judge
 */
export async function runHubDesignJudge(input: RunHubDesignJudgeInput): Promise<HubDesignVerdict> {
  const { issueText, bouncedFiles, definitionSites, complete } = input
  let raw: string
  try {
    raw = await complete({
      system: HUB_DESIGN_SYSTEM_PROMPT,
      user: buildHubDesignUserPrompt({ issueText, bouncedFiles, definitionSites }),
    })
  } catch {
    return DEGRADED_HUB_DESIGN
  }
  return parseHubDesignResponse(raw) ?? DEGRADED_HUB_DESIGN
}
