/**
 * §1.1/§4.1 turn-read — the ONE forced-JSON, temperature-0 LLM call that opens
 * every turn (P1-alt): read the user's prompt once and extract its goals and
 * constraints, plus per-diagnosis-goal localization EVIDENCE (locationNamed /
 * fixSpecified with verbatim quotes, and the judged hardness/ambiguity). The
 * model reports facts; the arming decision itself is a pure code table over
 * this verdict (`decideArming`, arming-judge.ts) — never the model's call.
 * Pure and provider-agnostic: the model call is injected via `complete`
 * (`turnReadDispatch`, session/prompt.ts, supplies the real conductor-tier
 * completion), so this module never binds to a real provider or session.
 * Extraction only, never invention: every quote is validated as a verbatim,
 * case-sensitive substring of the source prompt, and the module never plans,
 * localizes, or designs.
 *
 * @sem domain=routing role=extractor
 */
import { extractJsonObject } from "../util/json-extract"
import { TURN_READ_SYSTEM_PROMPT } from "./prompts/judges"

// ---------------------------------------------------------------------------
// The verdict shape — docs/architecture/ORCHESTRATION_MECHANISM.md §4.1
// ---------------------------------------------------------------------------

/** One extracted goal's shape — never a task label, always evidence-grounded. */
export type TriageGoalShape =
  | "diagnosis-vague"
  | "diagnosis-grounded"
  | "build"
  | "refactor"
  | "audit"
  | "qa"
  | "research"
  | "run-only"

/** One extracted constraint's arming category. */
export type TriageConstraintKind = "no-test-edit" | "no-edits" | "scope-limit" | "no-new-files" | "other"

/** How cleanly the extraction went — a low verdict escalates the turn-read itself one tier up (§4.1). */
export type TriageConfidence = "high" | "low"

/** P4 §4b — the turn's role: fresh work, or a continuation (steering/iteration on the session's existing deliverable). Absent reads as "fresh". */
export type TurnRole = "fresh" | "continuation"

/** How hard the fix is once found — judged per diagnosis goal by the turn-read; drives the difficulty floor and seed selection downstream (§1.2). */
export type ArmingHardness = "trivial" | "moderate" | "hard"

/** Whether a goal admits more than one reading — judged per diagnosis goal by the turn-read. */
export type ArmingAmbiguity = "clear" | "ambiguous"

/**
 * P1-alt — the per-diagnosis-goal evidence facts the turn-read reports. A
 * `true` fact only survives parsing when backed by a verbatim quote from the
 * prompt; an unbacked claim degrades to `false` (the conservative,
 * arm-leaning posture). The arming decision is computed from these in code
 * (`decideArming`), never by the model.
 */
export interface TriageGoalEvidence {
  readonly locationNamed: boolean
  readonly locationQuote?: string
  readonly fixSpecified: boolean
  readonly fixQuote?: string
  readonly hardness?: ArmingHardness
  readonly ambiguity?: ArmingAmbiguity
}

/** One goal extracted from the prompt. `quote` is validated verbatim before this is ever constructed. */
export interface TriageGoal {
  readonly quote: string
  readonly shape: TriageGoalShape
  readonly deliverable: string
  readonly dependsOn?: readonly number[]
  readonly needsPlan?: boolean
  /** Present when the goal's evidence section validated; absent evidence is read conservatively downstream (unlocated, no handed fix). */
  readonly evidence?: TriageGoalEvidence
}

/** One constraint extracted from the prompt — arms a hard gate once wired (§1.2). */
export interface TriageConstraint {
  readonly quote: string
  readonly kind: TriageConstraintKind
}

/** `runTurnRead`'s / `parseTurnReadResponse`'s output: the turn's goals, constraints, evidence, and confidence. */
export interface TriageVerdict {
  readonly goals: readonly TriageGoal[]
  readonly constraints: readonly TriageConstraint[]
  readonly confidence: TriageConfidence
  /** P4 — "continuation" only on pure steering/iteration messages; absent (older mocks/stubs) reads as "fresh". */
  readonly turnRole?: TurnRole
}

const TRIAGE_GOAL_SHAPES: ReadonlySet<TriageGoalShape> = new Set([
  "diagnosis-vague",
  "diagnosis-grounded",
  "build",
  "refactor",
  "audit",
  "qa",
  "research",
  "run-only",
])

const TRIAGE_CONSTRAINT_KINDS: ReadonlySet<TriageConstraintKind> = new Set([
  "no-test-edit",
  "no-edits",
  "scope-limit",
  "no-new-files",
  "other",
])

const ARMING_HARDNESS: ReadonlySet<ArmingHardness> = new Set(["trivial", "moderate", "hard"])
const ARMING_AMBIGUITY: ReadonlySet<ArmingAmbiguity> = new Set(["clear", "ambiguous"])

/** Hard cap on goals per verdict (§4.1) — a verdict claiming more fails validation entirely. */
export const TRIAGE_MAX_GOALS = 7

/**
 * Q-B partial-accept: an invalid evidence section never sinks its goal — it is
 * dropped (`undefined`), and the decision table then reads the conservative
 * posture (locationNamed=false, fixSpecified=false, hardness/ambiguity
 * undefined). A `true` claim must carry its verbatim quote or it degrades to
 * `false` — evidence is auditable, never asserted.
 */
function parseEvidence(entry: unknown, userPrompt: string): TriageGoalEvidence | undefined {
  if (typeof entry !== "object" || entry === null) return undefined
  const raw = entry as Record<string, unknown>

  const locationQuote =
    typeof raw.locationQuote === "string" && raw.locationQuote.length > 0 && userPrompt.includes(raw.locationQuote)
      ? raw.locationQuote
      : undefined
  const fixQuote =
    typeof raw.fixQuote === "string" && raw.fixQuote.length > 0 && userPrompt.includes(raw.fixQuote)
      ? raw.fixQuote
      : undefined
  const hardness =
    typeof raw.hardness === "string" && ARMING_HARDNESS.has(raw.hardness as ArmingHardness)
      ? (raw.hardness as ArmingHardness)
      : undefined
  const ambiguity =
    typeof raw.ambiguity === "string" && ARMING_AMBIGUITY.has(raw.ambiguity as ArmingAmbiguity)
      ? (raw.ambiguity as ArmingAmbiguity)
      : undefined

  return {
    locationNamed: raw.locationNamed === true && locationQuote !== undefined,
    ...(locationQuote !== undefined ? { locationQuote } : {}),
    fixSpecified: raw.fixSpecified === true && fixQuote !== undefined,
    ...(fixQuote !== undefined ? { fixQuote } : {}),
    ...(hardness !== undefined ? { hardness } : {}),
    ...(ambiguity !== undefined ? { ambiguity } : {}),
  }
}

function parseGoal(entry: unknown, userPrompt: string): TriageGoal | null {
  if (typeof entry !== "object" || entry === null) return null
  const raw = entry as Record<string, unknown>

  const quote = typeof raw.quote === "string" ? raw.quote : ""
  if (!quote || !userPrompt.includes(quote)) return null

  const shape = raw.shape
  if (typeof shape !== "string" || !TRIAGE_GOAL_SHAPES.has(shape as TriageGoalShape)) return null

  const deliverable = typeof raw.deliverable === "string" ? raw.deliverable : ""
  const dependsOn =
    Array.isArray(raw.dependsOn) && raw.dependsOn.every((n) => typeof n === "number")
      ? (raw.dependsOn as number[])
      : undefined
  const needsPlan = typeof raw.needsPlan === "boolean" ? raw.needsPlan : undefined
  const evidence = parseEvidence(raw.evidence, userPrompt)

  return {
    quote,
    shape: shape as TriageGoalShape,
    deliverable,
    ...(dependsOn !== undefined ? { dependsOn } : {}),
    ...(needsPlan !== undefined ? { needsPlan } : {}),
    ...(evidence !== undefined ? { evidence } : {}),
  }
}

function parseConstraint(entry: unknown, userPrompt: string): TriageConstraint | null {
  if (typeof entry !== "object" || entry === null) return null
  const raw = entry as Record<string, unknown>

  const quote = typeof raw.quote === "string" ? raw.quote : ""
  if (!quote || !userPrompt.includes(quote)) return null

  const kind = raw.kind
  if (typeof kind !== "string" || !TRIAGE_CONSTRAINT_KINDS.has(kind as TriageConstraintKind)) return null

  return { quote, kind: kind as TriageConstraintKind }
}

/**
 * Parse + validate the model's raw output into a `TriageVerdict`. Tolerant
 * of a reasoning preamble or trailing prose around the JSON — extracts the
 * first balanced top-level `{...}` object (`extractJsonObject`) before
 * parsing, since a reasoning conductor can stream commentary alongside the
 * answer (§4.1, prompt.ts `turnReadDispatch`). Extraction-only enforcement
 * lives entirely here otherwise: a goal or constraint whose `quote` isn't a
 * verbatim, case-sensitive substring of `userPrompt` is dropped, not
 * corrected; an invalid `shape`/`kind` drops the whole entry; zero surviving
 * goals, or more than `TRIAGE_MAX_GOALS`, fails the verdict outright —
 * EXCEPT that a "continuation" verdict may carry zero goals (P4: a pure
 * steering message has nothing to extract); no balanced JSON object, or
 * malformed JSON, fails outright. The evidence section is partial-accept
 * (Q-B): an invalid evidence object is dropped while its goal survives.
 * Never throws.
 *
 * @sem domain=routing role=extractor
 */
export function parseTurnReadResponse(raw: string, userPrompt: string): TriageVerdict | null {
  if (!raw || !userPrompt) return null

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

  const turnRole: TurnRole = candidate.turnRole === "continuation" ? "continuation" : "fresh"

  const goals: TriageGoal[] = []
  if (Array.isArray(candidate.goals)) {
    for (const entry of candidate.goals) {
      const goal = parseGoal(entry, userPrompt)
      if (goal) goals.push(goal)
    }
  }
  if (goals.length > TRIAGE_MAX_GOALS) return null
  if (goals.length === 0 && turnRole !== "continuation") return null

  const constraints: TriageConstraint[] = []
  if (Array.isArray(candidate.constraints)) {
    for (const entry of candidate.constraints) {
      const constraint = parseConstraint(entry, userPrompt)
      if (constraint) constraints.push(constraint)
    }
  }

  const confidence: TriageConfidence = candidate.confidence === "high" ? "high" : "low"

  return { goals, constraints, confidence, turnRole }
}

// ---------------------------------------------------------------------------
// P4 §4b — the pre-LLM continuation short-circuit
// ---------------------------------------------------------------------------

/** Upper bound (exclusive) on a prompt the short-circuit will even consider — real work is longer. */
export const CONTINUATION_MAX_PROMPT_CHARS = 80

// The anaphora/ack shapes — anchored FULL-message matches, deliberately tiny
// and conservative: false continuation on real work is the failure to avoid,
// so anything not on this list pays the turn-read and lets the model's
// `turnRole` decide. This is a cost optimization, not a taxonomy — it never
// assigns a shape.
const CONTINUATION_ACK_RES: readonly RegExp[] = [
  /^(?:ok(?:ay)?[,.!\s]*)?(?:yes[,.!\s]*)?(?:please\s+)?(?:go ahead|do it|continue|proceed|try again|keep going)[.!\s]*$/i,
  /^(?:it(?:'s| is)\s+)?still\s+(?:broken|failing|not working|the same)[.!\s]*$/i,
  /^that didn'?t (?:work|help)[.!\s]*$/i,
  /^same (?:error|failure|problem)(?:\s+as before)?[.!\s]*$/i,
]

// Path-shaped or code-shaped tokens — a slash, backtick, brackets, an
// extension-like dot, a flag, or a snake_case underscore means the message
// carries concrete work detail and must reach the turn-read.
const CODE_SHAPED_TOKEN_RE = /[\/\\`(){}\[\];=_]|\.\w|--?\w/

/**
 * P4 — should this prompt skip the turn-read call entirely and be treated as
 * a continuation? True only for a short (<`CONTINUATION_MAX_PROMPT_CHARS`),
 * code-free message that IS one of the anaphora/ack shapes ("go ahead",
 * "still broken", "that didn't work"). The caller must additionally require
 * that the session has prior turns — a first message can never continue
 * anything. When in doubt this returns false: the model call is the arbiter.
 *
 * @sem domain=routing role=router
 */
export function isContinuationShortCircuit(userPrompt: string): boolean {
  const prompt = userPrompt.trim()
  if (prompt.length === 0 || prompt.length >= CONTINUATION_MAX_PROMPT_CHARS) return false
  if (CODE_SHAPED_TOKEN_RE.test(prompt)) return false
  return CONTINUATION_ACK_RES.some((re) => re.test(prompt))
}

// ---------------------------------------------------------------------------
// The call itself — one blocking, forced-JSON request on the conductor tier
// ---------------------------------------------------------------------------

/** Blocking cap on the turn-read call (§4.1) — the merged call inherits the old arming cap: the conductor reasons through the evidence fields (~510-token chain-of-thought, ~3.2s median on a live probe), so 12s leaves headroom for cold-start + provider jitter while still capping the user's turn-open wait on a true hang. The two old calls stacked to 22s worst-case; this is the whole budget now. */
export const TURN_READ_TIMEOUT_MS = 12000

/** One request to the injected completion — the dispatch (prompt.ts) owns the provider path. */
export interface TriageCompleteRequest {
  readonly system: string
  readonly user: string
  readonly timeoutMs: number
}

/** The injected completion port: the session layer supplies the real conductor-tier call. */
export type TriageComplete = (request: TriageCompleteRequest) => Promise<string>

export interface RunTurnReadInput {
  readonly userPrompt: string
  readonly complete: TriageComplete
  /** Fired when a completed attempt fails parse validation and the one retry launches — the caller's telemetry hook (case-3 tierfire3 decode: a silent null closed the whole decomposition path with no trace of why). */
  readonly onParseRetry?: () => void
  /** Override the blocking cap (defaults to TURN_READ_TIMEOUT_MS) — tests pass a small value to avoid a real wall-clock wait. */
  readonly timeoutMs?: number
}

async function raceTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("turn-read: timed out")), timeoutMs)
    })
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Run the turn-read call: one forced-JSON request on the conductor tier,
 * `TURN_READ_TIMEOUT_MS` blocking cap, extraction-only system prompt. A
 * completed attempt that fails `parseTurnReadResponse`'s validation retries
 * ONCE (case-3 tierfire3: one extraction flake nulled the verdict and
 * silently closed the whole decomposition path — a cheap re-ask is cheap
 * insurance); timeout or a rejected `complete` never retries — that budget is
 * already spent, and stacking a second blocking wait on a slow gateway
 * doubles the turn-open stall. Returns `null` when both attempts fail — the
 * caller (prompt.ts) then re-asks ONCE on the reasoner tier and, still null,
 * degrades NEUTRALLY (P5): no preamble, no skeleton, arming stands down.
 *
 * @sem domain=routing role=extractor
 */
export async function runTurnRead(input: RunTurnReadInput): Promise<TriageVerdict | null> {
  const { userPrompt, complete } = input
  const timeoutMs = input.timeoutMs ?? TURN_READ_TIMEOUT_MS
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw: string
    try {
      raw = await raceTimeout(complete({ system: TURN_READ_SYSTEM_PROMPT, user: userPrompt, timeoutMs }), timeoutMs)
    } catch {
      return null
    }
    const verdict = parseTurnReadResponse(raw, userPrompt)
    if (verdict) return verdict
    if (attempt === 0) input.onParseRetry?.()
  }
  return null
}

// ---------------------------------------------------------------------------
// Telemetry — a lean per-verdict summary for the `turn_triage` log line
// ---------------------------------------------------------------------------

export interface TriageTelemetrySummary {
  readonly goalCount: number
  readonly shapes: readonly TriageGoalShape[]
  readonly constraintKinds: readonly TriageConstraintKind[]
  readonly confidence: TriageConfidence
  readonly turnRole: TurnRole
}

/**
 * Summarize a verdict for logging (§1.8 receipt trace) — no prose, just the
 * counts and enums a log line needs.
 *
 * @sem domain=routing role=extractor
 */
export function triageTelemetry(verdict: TriageVerdict): TriageTelemetrySummary {
  return {
    goalCount: verdict.goals.length,
    shapes: verdict.goals.map((goal) => goal.shape),
    constraintKinds: verdict.constraints.map((constraint) => constraint.kind),
    confidence: verdict.confidence,
    turnRole: verdict.turnRole ?? "fresh",
  }
}
