/**
 * §1.1b arming judge — the one cheap, evidence-grounded LLM call that decides
 * whether a turn needs a LOCALIZATION PRE-PASS (a dedicated step that finds the
 * root-cause code location BEFORE any fix is written) or can go straight to the
 * change. It replaces the brittle regex "doors" — `roundUpTriageShapes`'s
 * file-target test and `autoTypeTodos`'s todo file-target test — that
 * syntactically guessed groundedness and over-fired the reasoner path
 * (django-12039: a trivial, file-named whitespace bug cascaded to the oracle at
 * $0.31 because a subsystem-token count read GitHub-URL path segments as "hard").
 * A string matcher only sees the syntax; the judge reads the prompt plus the
 * triage verdict as EVIDENCE and returns ONE decision both doors consume — arm
 * localization?, how hard is the task, and the evidence it grounded that on.
 *
 * Pure and provider-agnostic: the model call is injected via the same
 * `TriageComplete` port turn-triage uses, so this module never binds to a real
 * provider or session — the session layer supplies the conductor-tier call.
 *
 * @sem domain=routing role=extractor
 */
import type { TriageComplete, TriageVerdict } from "./turn-triage"

/** How hard the fix is once found — drives planner-vs-localizer seed selection downstream (§1.2). */
export type ArmingHardness = "trivial" | "moderate" | "hard"

/** Whether the task admits more than one reading — surfaced for the escalation logic, advisory today. */
export type ArmingAmbiguity = "clear" | "ambiguous"

/** The arming judge's verdict: the single evidence-grounded decision both localization doors read. */
export interface ArmingVerdict {
  /** THE decision — plant a localization pre-pass before any fix is attempted. */
  readonly armLocalization: boolean
  /** Do we already know WHERE to fix (a concrete file/module or an unambiguous edit site)? */
  readonly localized: boolean
  readonly hardness: ArmingHardness
  readonly ambiguity: ArmingAmbiguity
  /** The exact span of the task that decided `localized` — makes the call auditable, never invented. */
  readonly evidence: string
}

/** The narrow slice the orchestration doors consume (skeleton seed gate + autoTypeTodos net). */
export type ArmingDecision = Pick<ArmingVerdict, "armLocalization" | "hardness">

const ARMING_HARDNESS: ReadonlySet<ArmingHardness> = new Set(["trivial", "moderate", "hard"])
const ARMING_AMBIGUITY: ReadonlySet<ArmingAmbiguity> = new Set(["clear", "ambiguous"])

/** Blocking cap on the arming call — same budget as turn-triage's live-gateway measurement (§4.1). */
export const ARMING_TIMEOUT_MS = 8000

/** Stable single-line prefix of the system prompt — lets a scripted LLM stub recognize an arming request without duplicating the full text. */
export const ARMING_PROMPT_MARKER = "You are the localization-arming judge"

const ARMING_SYSTEM_PROMPT = `${ARMING_PROMPT_MARKER}. Decide ONE thing: does this task need a LOCALIZATION PRE-PASS — a dedicated step that finds the root-cause code location BEFORE any fix is written — or is the fix site already known well enough to go straight to the change? Output JSON only — no prose, no markdown fences.

Ground every part of your decision in EVIDENCE from the task. Do not guess from the task's topic or difficulty in the abstract; cite what the text actually tells you.

Decide "localized" (we already know WHERE to fix — do NOT arm):
- the task names a concrete code location in THIS repo: a file path, a file name, or a module, OR
- the exact edit site is otherwise unambiguous from the text.

Decide NOT localized (arm the pre-pass):
- only a symptom or behaviour is described ("crashes on startup", "returns the wrong value"), OR
- only a class, API, feature, or symbol NAME is given — naming "QuerySet.delete" or "the enum getter" is NOT knowing the file or method to edit.

Also rate "hardness":
- "trivial": one obvious edit site, mechanical.
- "moderate": a bounded fix that still has to be found.
- "hard": cross-layer or multi-subsystem, or a fix that needs a plan even when the file is known.

Rules:
- A named file path (or file name / module) ⇒ localized ⇒ armLocalization=false, UNLESS hardness is "hard" — on a hard bug, knowing the file is not knowing the function + mechanism + minimal fix, so arm anyway.
- No code-location evidence at all ⇒ not localized ⇒ armLocalization=true.
- When the location evidence is genuinely balanced, prefer armLocalization=true — a cheap pre-pass beats an expensive wrong guess.
- "ambiguity" is "ambiguous" when the task could be read more than one way, else "clear".
- "evidence" quotes or paraphrases the exact span of the task that decided "localized" — never invent one.

Output exactly this JSON shape and nothing else:
{"armLocalization":true,"localized":false,"hardness":"moderate","ambiguity":"clear","evidence":"..."}`

/** One todo item's minimal shape the judge reads as extra evidence (Door-2 context) — kept structural to avoid importing the orchestrator (no cycle). */
export interface ArmingTodoContext {
  readonly content: string
  readonly status: string
}

export interface JudgeArmingInput {
  readonly userPrompt: string
  /** The turn-triage verdict, passed as advisory evidence (goal shapes the extractor read). */
  readonly verdict?: TriageVerdict | null
  /** The conductor's todo items so far, when the judge runs at the todowrite door. */
  readonly todos?: readonly ArmingTodoContext[]
  readonly complete: TriageComplete
  /** Fired when a completed attempt fails parse validation and the one retry launches — the caller's telemetry hook. */
  readonly onParseRetry?: () => void
}

/**
 * Render the judge's user message: the task verbatim, plus the triage verdict
 * and any current plan as clearly-labelled ADVISORY evidence. The judge is told
 * to ground in the task text, so the verdict is context, never the answer.
 *
 * @sem domain=routing role=extractor
 */
export function buildArmingUser(input: {
  userPrompt: string
  verdict?: TriageVerdict | null
  todos?: readonly ArmingTodoContext[]
}): string {
  const parts: string[] = [`TASK:\n${input.userPrompt}`]
  if (input.verdict && input.verdict.goals.length > 0) {
    const goals = input.verdict.goals.map((g) => `- [${g.shape}] ${g.quote}`).join("\n")
    parts.push(`TRIAGE (advisory — the extractor's read of the goals):\n${goals}`)
  }
  const activeTodos = (input.todos ?? []).filter((t) => t.content.trim().length > 0)
  if (activeTodos.length > 0) {
    const rows = activeTodos.map((t) => `- (${t.status}) ${t.content}`).join("\n")
    parts.push(`CURRENT PLAN (the conductor's todo items so far):\n${rows}`)
  }
  return parts.join("\n\n")
}

/**
 * Parse + validate the judge's raw JSON into an `ArmingVerdict`. Tolerant of a
 * ```json fence (some models add one despite the instruction) but otherwise
 * strict: an invalid `hardness`/`ambiguity`, a non-boolean decision, or
 * malformed JSON fails to null so the caller degrades to `heuristicArming`.
 * Never throws.
 *
 * @sem domain=routing role=extractor
 */
export function parseArmingResponse(raw: string): ArmingVerdict | null {
  if (!raw) return null
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")

  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const raw2 = parsed as Record<string, unknown>

  if (typeof raw2.armLocalization !== "boolean") return null
  const hardness = raw2.hardness
  if (typeof hardness !== "string" || !ARMING_HARDNESS.has(hardness as ArmingHardness)) return null
  const ambiguity = raw2.ambiguity
  if (typeof ambiguity !== "string" || !ARMING_AMBIGUITY.has(ambiguity as ArmingAmbiguity)) return null

  // `localized` is advisory; default it to the inverse of the decision when the
  // model omits or malforms it, so a good decision is never dropped over a
  // secondary field.
  const localized = typeof raw2.localized === "boolean" ? raw2.localized : !raw2.armLocalization
  const evidence = typeof raw2.evidence === "string" ? raw2.evidence : ""

  return {
    armLocalization: raw2.armLocalization,
    localized,
    hardness: hardness as ArmingHardness,
    ambiguity: ambiguity as ArmingAmbiguity,
    evidence,
  }
}

async function raceTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("arming-judge: timed out")), timeoutMs)
    })
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Run the arming judge: one forced-schema request on the conductor tier,
 * `ARMING_TIMEOUT_MS` blocking cap, evidence-grounded system prompt. A completed
 * attempt that fails `parseArmingResponse` retries ONCE (an extraction flake is
 * cheap to re-ask); a timeout or a rejected `complete` never retries. Returns
 * `null` when both attempts fail — the caller falls back to `heuristicArming`
 * (which reads the triage shape, never a regex) so the doors are always fed a
 * decision.
 *
 * @sem domain=routing role=extractor
 */
export async function judgeArming(input: JudgeArmingInput): Promise<ArmingVerdict | null> {
  const { userPrompt, verdict, todos, complete } = input
  const user = buildArmingUser({ userPrompt, verdict, todos })
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw: string
    try {
      raw = await raceTimeout(
        complete({ system: ARMING_SYSTEM_PROMPT, user, timeoutMs: ARMING_TIMEOUT_MS }),
        ARMING_TIMEOUT_MS,
      )
    } catch {
      return null
    }
    const decision = parseArmingResponse(raw)
    if (decision) return decision
    if (attempt === 0) input.onParseRetry?.()
  }
  return null
}

/**
 * Degrade path when the judge is unavailable (timeout / parse fail / no verdict):
 * derive the arming decision from the triage SHAPE — a semantic signal the LLM
 * extractor already produced — never from a file-target regex. Arms when any
 * goal is diagnosis-vague or flagged needsPlan; hardness rises to "hard" only on
 * a needsPlan goal. With no verdict at all it stands down (armLocalization=false)
 * rather than blindly arm, matching turn-triage's own degrade-open posture.
 *
 * @sem domain=routing role=extractor
 */
export function heuristicArming(verdict?: TriageVerdict | null): ArmingVerdict {
  if (!verdict || verdict.goals.length === 0) {
    return { armLocalization: false, localized: true, hardness: "moderate", ambiguity: "clear", evidence: "degraded: no triage verdict" }
  }
  const needsPlan = verdict.goals.some((g) => g.needsPlan)
  const vague = verdict.goals.some((g) => g.shape === "diagnosis-vague")
  const arm = needsPlan || vague
  return {
    armLocalization: arm,
    localized: !arm,
    hardness: needsPlan ? "hard" : arm ? "moderate" : "trivial",
    ambiguity: verdict.confidence === "low" ? "ambiguous" : "clear",
    evidence: "degraded: derived from triage shape (judge unavailable)",
  }
}
