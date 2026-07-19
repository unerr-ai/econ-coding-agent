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
import { HUB_DESIGN_SYSTEM_PROMPT } from "./prompts/judges"
import { pathsRefer } from "../tool/edit-governance"

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
 * Input to `runHubDesignJudge`: the turn's issue text (also the RF-7
 * grounding-floor input — omit it to skip that floor), the hub files edits
 * have already bounced on, and the graph-grounded definition sites for the
 * issue's named symbols (from `graph-tools.ts`'s
 * `issueSymbolDefinitionSites` — this module never touches the graph
 * itself), plus the injected completion port.
 *
 * @sem domain=routing role=hub-design-judge
 */
export interface RunHubDesignJudgeInput {
  readonly issueText?: string
  readonly bouncedFiles: readonly string[]
  readonly definitionSites: readonly { symbol: string; kind: string; file: string }[]
  readonly complete: HubDesignComplete
  /** H3: unified before/after hunks of the bounced files' current (wrong-layer) patch (optional) — the judge reads the actual diff instead of inferring it from `bouncedFiles`' names alone. */
  readonly diffHunks?: string
  /** H3: the issue's quoted expected/actual block, verbatim (optional). */
  readonly issueExpectedActual?: string
  /** H3: the H1 witness list this fix claims to cover (optional). */
  readonly witnesses?: readonly string[]
}

/**
 * Builds the user prompt: the issue, the denied hub files, and the graph's
 * definition-site evidence. H3: `diffHunks`/`issueExpectedActual`/
 * `witnesses` each add their own section when supplied — diff-aware
 * scaffolding in place of a prose summary; all absent leaves the prompt
 * byte-for-byte unchanged from before H3.
 */
function buildHubDesignUserPrompt(input: {
  issueText: string
  bouncedFiles: readonly string[]
  definitionSites: readonly { symbol: string; kind: string; file: string }[]
  diffHunks?: string
  issueExpectedActual?: string
  witnesses?: readonly string[]
}): string {
  const { issueText, bouncedFiles, definitionSites, diffHunks, issueExpectedActual, witnesses } = input
  const sitesText = definitionSites.length
    ? definitionSites.map((s) => `${s.symbol} — ${s.kind} — ${s.file}`).join("\n")
    : "(none found)"
  const sections = [
    `## Issue\n${issueText}`,
    `## Denied edit sites\nEdits so far were DENIED on these shared hub files (do not name them unless one is genuinely the defining module): ${bouncedFiles.join(", ")}`,
    `## Definition sites of symbols the issue names (from the code graph)\n${sitesText}`,
  ]
  if (issueExpectedActual && issueExpectedActual.trim().length > 0) {
    sections.push(`## Issue expected/actual\n${issueExpectedActual}`)
  }
  if (diffHunks && diffHunks.trim().length > 0) {
    sections.push(`## Current (bounced) patch (unified diff)\n${diffHunks}`)
  }
  if (witnesses && witnesses.length > 0) {
    sections.push(`## Witnesses the fix claims to cover\n${witnesses.map((w) => `- ${w}`).join("\n")}`)
  }
  sections.push(`## Question\nWhich module DEFINES the misbehaving class or function, and what is the concrete fix there?`)
  return sections.join("\n\n")
}

/**
 * Collects every top-level balanced `{...}` block in `raw`, in order of
 * appearance — brace-matching is string-aware (a quoted `{`/`}` never
 * miscounts depth), so a fenced block, reasoning prose, or trailing
 * commentary around any candidate is tolerated. An unbalanced trailing `{`
 * (no matching `}`) stops the scan there rather than emitting a partial
 * candidate.
 */
function extractJsonCandidates(raw: string): string[] {
  const candidates: string[] = []
  let cursor = 0
  while (cursor < raw.length) {
    const start = raw.indexOf("{", cursor)
    if (start === -1) break
    let depth = 0
    let inString = false
    let escaped = false
    let end = -1
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === "\\") escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') {
        inString = true
        continue
      }
      if (ch === "{") depth++
      else if (ch === "}") {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end === -1) break
    candidates.push(raw.slice(start, end + 1))
    cursor = end + 1
  }
  return candidates
}

/** Splits on runs of non-alphanumeric characters, dropping empty tokens. */
function tokenizeAlphanumeric(text: string): string[] {
  return text.split(/[^a-zA-Z0-9]+/).filter((token) => token.length > 0)
}

/**
 * RF-7 sanity floor: whether `verdict`'s `entity`/`change` share at least
 * one non-trivial token (length >= 4, case-insensitive) with `issueText` —
 * catches a verdict that names an entity/change the issue never mentions at
 * all (11964-A's `Q.__invert__`/De Morgan verdict against a Django
 * Choices/enum `str()` issue fails this trivially). Tokenizes on runs of
 * non-alphanumeric characters.
 *
 * @sem domain=routing role=hub-design-judge
 */
export function verdictGroundedInIssue(verdict: HubDesignVerdict, issueText: string): boolean {
  const tokens = tokenizeAlphanumeric(`${verdict.entity} ${verdict.change}`).filter((token) => token.length >= 4)
  if (tokens.length === 0) return false
  const haystack = issueText.toLowerCase()
  return tokens.some((token) => haystack.includes(token.toLowerCase()))
}

/**
 * Parse the judge's raw completion into a verdict: scans every top-level
 * balanced JSON object in the response and, walking from the LAST candidate
 * backward, returns the first one that parses and validates `file`,
 * `entity`, and `change` as all non-empty (after trim) strings — the reasoner
 * may emit reasoning prose, a fenced block, or even a discarded earlier
 * attempt before its final answer, and the final answer is what should win.
 * No candidate validates → returns `null` — never throws.
 *
 * @sem domain=routing role=hub-design-judge
 */
export function parseHubDesignResponse(raw: string): HubDesignVerdict | null {
  if (!raw) return null
  const candidates = extractJsonCandidates(raw)
  for (let i = candidates.length - 1; i >= 0; i--) {
    let parsed: unknown
    try {
      parsed = JSON.parse(candidates[i])
    } catch {
      continue
    }
    if (typeof parsed !== "object" || parsed === null) continue
    const candidate = parsed as Record<string, unknown>
    const file = typeof candidate.file === "string" ? candidate.file.trim() : ""
    const entity = typeof candidate.entity === "string" ? candidate.entity.trim() : ""
    const change = typeof candidate.change === "string" ? candidate.change.trim() : ""
    if (!file || !entity || !change) continue
    return { file, entity, change }
  }
  return null
}

/**
 * Run the hub-design judge: ONE forced-JSON completion deciding the
 * root-most fix site for a hub-shopping turn — no retry, this fires at
 * most once per turn (the caller enforces that). A thrown `complete`
 * degrades to `DEGRADED_HUB_DESIGN` WITH `rawHead` set to the thrown
 * error's string form, prefixed `"threw: "` and capped at 180 characters
 * (there is no completion text to sample, but the thrown error itself is
 * evidence of why); a parse failure, a verdict whose `file` is
 * not even path-like (no separator or dot — e.g. a hedged "unknown"), OR a
 * well-formed verdict whose `file` names none of the candidate
 * `definitionSites` (checked via `pathsRefer`, when the list is non-empty)
 * degrades to
 * `DEGRADED_HUB_DESIGN` WITH `rawHead` — the first 200 characters of the
 * raw completion — so the caller's degrade log carries evidence of what the
 * judge actually said instead of a bare "degraded" line. The site choice is
 * already made upstream by the graph's band-filtered allowlist; this judge
 * picks WHICH listed site and the concrete change, never a different file —
 * when `definitionSites` is empty, the judge's file choice stands
 * unchecked. The caller falls back to asking the model to re-derive the
 * site itself, never blocks. RF-7: when `issueText` is provided, a
 * well-formed (and allowlist-passing) verdict whose `entity`/`change` share
 * no non-trivial token with it (`verdictGroundedInIssue`) degrades the same
 * way, WITH `rawHead` — an unfounded verdict carries no design signal
 * either. Omitting `issueText` skips this floor entirely. H3: `diffHunks`/
 * `issueExpectedActual`/`witnesses` are optional diff-aware scaffolding
 * (`buildHubDesignUserPrompt`) — each absent leaves the prompt, and this
 * function's behavior, unchanged from before H3.
 *
 * @sem domain=routing role=hub-design-judge
 */
export async function runHubDesignJudge(
  input: RunHubDesignJudgeInput,
): Promise<{ verdict: HubDesignVerdict; rawHead?: string }> {
  const { issueText, bouncedFiles, definitionSites, complete, diffHunks, issueExpectedActual, witnesses } = input
  let raw: string
  try {
    raw = await complete({
      system: HUB_DESIGN_SYSTEM_PROMPT,
      user: buildHubDesignUserPrompt({
        issueText: issueText ?? "",
        bouncedFiles,
        definitionSites,
        diffHunks,
        issueExpectedActual,
        witnesses,
      }),
    })
  } catch (err) {
    return { verdict: DEGRADED_HUB_DESIGN, rawHead: "threw: " + String(err).slice(0, 180) }
  }
  const verdict = parseHubDesignResponse(raw)
  if (!verdict) return { verdict: DEGRADED_HUB_DESIGN, rawHead: raw.slice(0, 200) }
  // Sanity floor: a verdict whose file isn't even path-like (round-A4 live:
  // the model hedged with literal "unknown" when it had no candidate sites)
  // carries no design signal — degrade regardless of definitionSites.
  const verdictFile = verdict.file.trim()
  if (verdictFile === "" || (!verdictFile.includes("/") && !verdictFile.includes("."))) {
    return { verdict: DEGRADED_HUB_DESIGN, rawHead: raw.slice(0, 200) }
  }
  if (definitionSites.length > 0 && !definitionSites.some((site) => pathsRefer(site.file, verdict.file))) {
    return { verdict: DEGRADED_HUB_DESIGN, rawHead: raw.slice(0, 200) }
  }
  if (issueText !== undefined && !verdictGroundedInIssue(verdict, issueText)) {
    return { verdict: DEGRADED_HUB_DESIGN, rawHead: raw.slice(0, 200) }
  }
  return { verdict }
}
