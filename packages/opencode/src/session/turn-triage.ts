/**
 * §1.1/§4.1 turn triage — the one cheap, forced-schema LLM call that opens
 * every turn: read the user's prompt once and extract its goals and
 * constraints before anything else runs (docs/architecture/
 * ORCHESTRATION_MECHANISM.md §1.1, §4.1). Pure and provider-agnostic: the
 * model call itself is injected via `complete` so this module never binds
 * to a real provider or session — U1a builds the extraction contract only;
 * wiring `runTurnTriage` into the turn-open step (`session/prompt.ts`) and
 * materializing the todo skeleton from its verdict (§1.2/U2) are later
 * passes. Extraction only, never invention: every quote is validated as a
 * verbatim, case-sensitive substring of the source prompt, and the module
 * never plans, localizes, or designs.
 *
 * Adapter recon (for the later wiring pass, not wired here): OpenCode's
 * existing small-model calls — session title/summary generation — run
 * through the full hidden "primary agent" session machinery
 * (`packages/opencode/src/agent/agent.ts`, `AgentV2.ID.make("title")` /
 * `"summary"`, `PROMPT_TITLE` / `PROMPT_SUMMARY`, every tool permission
 * denied), not a lean single-call helper. The lowest-level building block,
 * `LLMNative.request` (`session/llm/native-request.ts`), still needs a full
 * `Provider.Model` plus AI-SDK-shaped messages, not a bare (system, user)
 * pair. No clean, reusable "(system, user) => text" helper exists today —
 * hence `complete` stays an injected seam for the session layer to adapt.
 *
 * @sem domain=routing role=extractor
 */

// ---------------------------------------------------------------------------
// The verdict shape — docs/architecture/ORCHESTRATION_MECHANISM.md §4.1
// ---------------------------------------------------------------------------

/** One extracted goal's shape — never a task label, always evidence-grounded. */
export type TriageGoalShape = "diagnosis-vague" | "diagnosis-grounded" | "build" | "audit" | "qa" | "run-only"

/** One extracted constraint's arming category. */
export type TriageConstraintKind = "no-test-edit" | "scope-limit" | "no-new-files" | "other"

/** How cleanly the extraction went — a low verdict escalates the triage call itself one tier up (§4.1). */
export type TriageConfidence = "high" | "low"

/** One goal extracted from the prompt. `quote` is validated verbatim before this is ever constructed. */
export interface TriageGoal {
  readonly quote: string
  readonly shape: TriageGoalShape
  readonly deliverable: string
  readonly dependsOn?: readonly number[]
  readonly needsPlan?: boolean
}

/** One constraint extracted from the prompt — arms a hard gate once wired (§1.2). */
export interface TriageConstraint {
  readonly quote: string
  readonly kind: TriageConstraintKind
}

/** `runTurnTriage`'s / `parseTriageResponse`'s output: the turn's goals, constraints, and confidence. */
export interface TriageVerdict {
  readonly goals: readonly TriageGoal[]
  readonly constraints: readonly TriageConstraint[]
  readonly confidence: TriageConfidence
}

const TRIAGE_GOAL_SHAPES: ReadonlySet<TriageGoalShape> = new Set([
  "diagnosis-vague",
  "diagnosis-grounded",
  "build",
  "audit",
  "qa",
  "run-only",
])

const TRIAGE_CONSTRAINT_KINDS: ReadonlySet<TriageConstraintKind> = new Set([
  "no-test-edit",
  "scope-limit",
  "no-new-files",
  "other",
])

/** Hard cap on goals per verdict (§4.1) — a verdict claiming more fails validation entirely. */
export const TRIAGE_MAX_GOALS = 7

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

  return {
    quote,
    shape: shape as TriageGoalShape,
    deliverable,
    ...(dependsOn !== undefined ? { dependsOn } : {}),
    ...(needsPlan !== undefined ? { needsPlan } : {}),
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
 * Extract the first balanced top-level JSON object from `raw` — brace-match
 * from the first `{` to its matching `}`, tracking string literals so a
 * quoted `{`/`}` never miscounts depth — so a reasoning preamble before the
 * JSON, or trailing prose after it, doesn't break parsing. Returns `null`
 * when no balanced object is found.
 */
function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{")
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escaped = false
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
      if (depth === 0) return raw.slice(start, i + 1)
    }
  }
  return null
}

/**
 * Parse + validate the model's raw output into a `TriageVerdict`. Tolerant
 * of a reasoning preamble or trailing prose around the JSON — extracts the
 * first balanced top-level `{...}` object (`extractJsonObject`) before
 * parsing, since an un-muted conductor can stream commentary alongside the
 * answer (§4.1, prompt.ts `triageDispatch`/`armingDispatch`). Extraction-only
 * enforcement lives entirely here otherwise: a goal or constraint whose
 * `quote` isn't a verbatim, case-sensitive substring of `userPrompt` is
 * dropped, not corrected; an invalid `shape`/`kind` drops the whole entry;
 * zero surviving goals, or more than `TRIAGE_MAX_GOALS`, fails the verdict
 * outright; no balanced JSON object, or malformed JSON, fails outright.
 * Never throws.
 *
 * @sem domain=routing role=extractor
 */
export function parseTriageResponse(raw: string, userPrompt: string): TriageVerdict | null {
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

  const goals: TriageGoal[] = []
  if (Array.isArray(candidate.goals)) {
    for (const entry of candidate.goals) {
      const goal = parseGoal(entry, userPrompt)
      if (goal) goals.push(goal)
    }
  }
  if (goals.length === 0 || goals.length > TRIAGE_MAX_GOALS) return null

  const constraints: TriageConstraint[] = []
  if (Array.isArray(candidate.constraints)) {
    for (const entry of candidate.constraints) {
      const constraint = parseConstraint(entry, userPrompt)
      if (constraint) constraints.push(constraint)
    }
  }

  const confidence: TriageConfidence = candidate.confidence === "high" ? "high" : "low"

  return { goals, constraints, confidence }
}

// ---------------------------------------------------------------------------
// The call itself — one blocking, forced-schema request on the conductor tier
// ---------------------------------------------------------------------------

/** Blocking cap on the triage call (§4.1) — schema-invalid or slower than this falls back to the heuristic classifier. 10s: un-muting the conductor for triage (see triageDispatch, prompt.ts) adds reasoning tokens — a live probe measured max ~7.7s wall (median ~1.9s), 96% of the old 8s cap, so 10s gives headroom. Kept below arming's 12s ARMING_TIMEOUT_MS: triage sits on every turn's critical path, so a gateway hang shouldn't stall turn-open longer than necessary. */
export const TRIAGE_TIMEOUT_MS = 10000

/** Stable, single-line prefix of `TRIAGE_SYSTEM_PROMPT` — lets an out-of-band test harness (e.g. a scripted LLM stub) recognize a turn-triage request by its system message without duplicating the full prompt text. */
export const TRIAGE_PROMPT_MARKER = "You are the turn-triage extractor"

const TRIAGE_SYSTEM_PROMPT = `${TRIAGE_PROMPT_MARKER}. Read the user's prompt once and extract its goals and constraints. Output JSON only — no prose, no markdown fences, no commentary.

Rules:
- Every "quote" field must be a VERBATIM, case-sensitive substring of the user's prompt. Never paraphrase, translate, summarize, or invent a quote — if you cannot cite an exact span, drop that goal or constraint.
- Never plan, localize, or propose how to do the work. This is extraction only.
- At most 7 goals. If the prompt genuinely names more, keep the 7 most load-bearing.
- "shape" is exactly one of: "diagnosis-vague" (a symptom that does not say where in this codebase the defect lives — needs localization before a fix; naming the misbehaving class, API, or feature does NOT ground it), "diagnosis-grounded" (a symptom that names the defect's code location: a file path, file name, or module of this repo), "build" (create/add/implement something new), "audit" (review/check/judge existing work), "qa" (a question, not a work item), "run-only" (execute something, no edit implied).
- "kind" (for constraints) is exactly one of: "no-test-edit", "scope-limit", "no-new-files", "other".
- "confidence" is "high" only when every goal and constraint is unambiguous; otherwise "low".

Output exactly this JSON shape and nothing else:
{"goals":[{"quote":"...","shape":"...","deliverable":"...","dependsOn":[0],"needsPlan":false}],"constraints":[{"quote":"...","kind":"..."}],"confidence":"high"}`

/** One request to the injected small-model completion — see the adapter recon note above. */
export interface TriageCompleteRequest {
  readonly system: string
  readonly user: string
  readonly timeoutMs: number
}

/** The injected completion port: the session layer supplies the real conductor-tier call later. */
export type TriageComplete = (request: TriageCompleteRequest) => Promise<string>

export interface RunTurnTriageInput {
  readonly userPrompt: string
  readonly complete: TriageComplete
  /** Fired when a completed attempt fails parse validation and the one retry launches — the caller's telemetry hook (case-3 tierfire3 decode: a silent null closed the whole decomposition path with no trace of why). */
  readonly onParseRetry?: () => void
}

async function raceTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("turn-triage: timed out")), timeoutMs)
    })
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Run the turn-triage call: one forced-schema request on the conductor tier,
 * `TRIAGE_TIMEOUT_MS` blocking cap, extraction-only system prompt. A completed
 * attempt that fails `parseTriageResponse`'s validation retries ONCE (case-3
 * tierfire3: one extraction flake nulled the verdict and silently closed the
 * whole decomposition path — a ~4s re-ask is cheap insurance); timeout or a
 * rejected `complete` never retries — that budget is already spent, and
 * stacking a second blocking wait on a slow gateway doubles the turn-open
 * stall. Returns `null` when both attempts fail — the caller falls back to
 * `classifyTurnShape` in every `null` case (§1.1 rule 3), never here.
 *
 * @sem domain=routing role=extractor
 */
export async function runTurnTriage(input: RunTurnTriageInput): Promise<TriageVerdict | null> {
  const { userPrompt, complete } = input
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw: string
    try {
      raw = await raceTimeout(
        complete({ system: TRIAGE_SYSTEM_PROMPT, user: userPrompt, timeoutMs: TRIAGE_TIMEOUT_MS }),
        TRIAGE_TIMEOUT_MS,
      )
    } catch {
      return null
    }
    const verdict = parseTriageResponse(raw, userPrompt)
    if (verdict) return verdict
    if (attempt === 0) input.onParseRetry?.()
  }
  return null
}

// ---------------------------------------------------------------------------
// Telemetry — a lean summary for the `triage_vs_heuristic` disagreement log
// ---------------------------------------------------------------------------

export interface TriageTelemetrySummary {
  readonly goalCount: number
  readonly shapes: readonly TriageGoalShape[]
  readonly constraintKinds: readonly TriageConstraintKind[]
  readonly confidence: TriageConfidence
}

/**
 * Summarize a verdict for logging (§1.8 receipt trace) — no prose, just the
 * counts and enums a log line or the `triage_vs_heuristic` disagreement
 * signal needs.
 *
 * @sem domain=routing role=extractor
 */
export function triageTelemetry(verdict: TriageVerdict): TriageTelemetrySummary {
  return {
    goalCount: verdict.goals.length,
    shapes: verdict.goals.map((goal) => goal.shape),
    constraintKinds: verdict.constraints.map((constraint) => constraint.kind),
    confidence: verdict.confidence,
  }
}
