// Standalone OFFLINE dev harness for the localization-arming decision — scores
// the REAL arming-judge pipeline (heuristicArming / judgeArming) against a
// labeled corpus so the arming logic can be iterated without full arena runs.
// Plain script, NOT a *.test.ts: run via `bun run test/arming-rig/run.ts`
// from packages/opencode. `bun test` does not pick this file up (its name
// doesn't match the *.test.ts/*.spec.ts patterns bun test scans for).
import { autoTypeTodos, buildTriageTodoSkeleton } from "../../src/session/slice-orchestrator"
import { LOCALIZATION_SLICE_CONTENT } from "../../src/session/prompts/seeds"
import { heuristicArming, judgeArming, type ArmingVerdict } from "../../src/session/arming-judge"
import { runTurnTriage, type TriageComplete, type TriageCompleteRequest } from "../../src/session/turn-triage"
import { ECON_TIER_BINDING } from "../../../code-intelligence/src/model-registry"
import type { ArmingScenario, TriageVerdict } from "./types"

// Fallback corpus — used only when ./corpus.ts (authored in parallel by a
// sibling agent against types.ts) is missing or exports an empty CORPUS, so
// this script stays runnable standalone.
const STUB_CORPUS: readonly ArmingScenario[] = [
  {
    id: "stub-grounded-with-file",
    prompt: "Fix the off-by-one bound check in packages/core/src/util/range.ts",
    mockVerdict: {
      goals: [
        {
          quote: "Fix the off-by-one bound check in packages/core/src/util/range.ts",
          shape: "diagnosis-grounded",
          deliverable: "corrected range bound",
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: false,
      reason: "prompt already names a file target — no localization pre-pass needed",
    },
    note: "stub fallback: grounded + file target",
  },
  {
    id: "stub-grounded-no-file",
    prompt: "The enum renders the wrong label somewhere in the display logic — please fix it",
    mockVerdict: {
      goals: [
        {
          quote: "The enum renders the wrong label somewhere in the display logic",
          shape: "diagnosis-grounded",
          deliverable: "corrected label",
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: true,
      reason: "grounded bug with no file target should round up to diagnosis-vague and arm localization",
    },
    note: "stub fallback: grounded, no file target",
  },
]

// Non-literal specifier: keeps `tsgo --noEmit` from failing static module
// resolution before corpus.ts exists (dynamic import with a computed
// specifier is typed `any`, not resolved at compile time).
const CORPUS_MODULE_PATH = "./corpus"

async function loadCorpus(): Promise<readonly ArmingScenario[]> {
  try {
    const mod = (await import(CORPUS_MODULE_PATH)) as { CORPUS?: readonly ArmingScenario[] }
    if (mod.CORPUS && mod.CORPUS.length > 0) return mod.CORPUS
  } catch {
    // corpus.ts missing, or failing to import — fall through to the stub.
  }
  console.log("[arming-rig] ./corpus.ts missing/empty — using the 2-item inline stub\n")
  return STUB_CORPUS
}

// Live mode gate: RIG_LIVE=1 hits the real econ gateway (spends money); no env
// (the default) stays fully deterministic — scoreScenario never reaches
// gatewayComplete unless this is true.
const RIG_LIVE = process.env.RIG_LIVE === "1"

const GATEWAY_BASE_URL =
  process.env.ECON_CONDUCTOR_BASE_URL ?? process.env.ECON_BASE_URL ?? "https://econ-litellm.fly.dev/v1"
const GATEWAY_API_KEY = process.env.LITELLM_API_KEY ?? process.env.OPENAI_API_KEY
// Pinned to the CONDUCTOR TIER, not a model: the rig exercises whichever
// model the registry currently binds to "conductor" — no model-name literal
// or model-name env anywhere in this file, only the tier→model SSOT.
const GATEWAY_MODEL = ECON_TIER_BINDING.conductor

// The one real `TriageComplete` port: POSTs {system,user} to the econ conductor
// endpoint and returns the assistant message content. Shared by liveTriage and
// liveArming — both build their own system+user prompts internally, this only
// carries the request across the wire (mirrors packages/eval/src/index.ts's
// gateway call).
const gatewayComplete: TriageComplete = async (request: TriageCompleteRequest): Promise<string> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), request.timeoutMs)
  try {
    const res = await fetch(`${GATEWAY_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${GATEWAY_API_KEY}`,
      },
      body: JSON.stringify({
        model: GATEWAY_MODEL,
        // Reasoning left ON (no reasoning_effort:"none") to MIRROR production: the arming
        // dispatch un-mutes the conductor (prompt.ts armingDispatch `unmuteReasoning:true`)
        // so minimax can reason through grounding strength — muted, it over-fires
        // STRONG-grounded diagnoses (grounded-stacktrace / grounded-symbol-plus-file;
        // PROMPT_SLICING_CORPUS.md R2). 12s ARMING_TIMEOUT_MS covers the ~3s thinking cost.
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
        temperature: 0,
      }),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`gateway ${res.status}: ${await res.text()}`)
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    return json.choices?.[0]?.message?.content ?? ""
  } finally {
    clearTimeout(timer)
  }
}

// Live-triage seam: runs the real `runTurnTriage` extractor against the
// gateway. Only reached from scoreScenario when RIG_LIVE=1.
async function liveTriage(prompt: string): Promise<TriageVerdict> {
  const verdict = await runTurnTriage({ userPrompt: prompt, complete: gatewayComplete })
  if (!verdict) throw new Error("liveTriage: runTurnTriage returned null (timeout or parse failure)")
  return verdict
}

// Live-arming seam: runs the real `judgeArming` judge against the gateway.
// Only reached from scoreScenario when RIG_LIVE=1.
async function liveArming(input: { userPrompt: string; verdict: TriageVerdict }): Promise<ArmingVerdict> {
  const arming = await judgeArming({ userPrompt: input.userPrompt, verdict: input.verdict, complete: gatewayComplete })
  if (!arming) throw new Error("liveArming: judgeArming returned null (timeout or parse failure)")
  return arming
}

type CaseVerdict = "ok" | "over-fire" | "under-fire" | "error"

interface ScoreRow {
  id: string
  note: string
  expected: boolean
  actual: string
  seed: string
  verdict: CaseVerdict
  shapes: string
  /** Live mode only: the arming judge's grounding string, printed per row so it can be eyeballed. */
  evidence?: string
}

async function scoreScenario(scenario: ArmingScenario): Promise<ScoreRow> {
  const note = scenario.note ?? "-"
  const expected = scenario.expect.localizationArmed

  let verdict: TriageVerdict
  let arming: ArmingVerdict
  try {
    if (RIG_LIVE) {
      // Live mode validates the REAL judge: triage still honors a mock verdict
      // when the scenario pins one, but arming always runs the live gateway.
      verdict = scenario.mockVerdict ?? (await liveTriage(scenario.prompt))
      arming = await liveArming({ userPrompt: scenario.prompt, verdict })
    } else {
      if (!scenario.mockVerdict) {
        throw new Error("deterministic mode requires scenario.mockVerdict — set RIG_LIVE=1 to hit the real gateway")
      }
      verdict = scenario.mockVerdict
      arming = heuristicArming(verdict)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { id: scenario.id, note, expected, actual: `error: ${message}`, seed: "—", verdict: "error", shapes: "-" }
  }

  // Arming judge decides (heuristicArming deterministic / judgeArming live);
  // the skeleton + autoTypeTodos net then materializes the writer pre-pass
  // from that decision.
  const skeleton = buildTriageTodoSkeleton(verdict, arming)
  const typed = autoTypeTodos(scenario.todos ?? skeleton, arming.armLocalization)
  // The pre-pass engages the expensive reasoner tier, so over/under-fire is
  // measured on "any pre-pass armed"; the `seed` column shows whether the
  // single writer pre-pass was planted.
  const seed = typed.some((t) => t.content === LOCALIZATION_SLICE_CONTENT) ? "localization" : "—"
  const actualArmed = seed !== "—"
  const shapes = verdict.goals.map((g) => g.shape).join(", ") || "-"

  const caseVerdict: CaseVerdict = actualArmed === expected ? "ok" : expected ? "under-fire" : "over-fire"
  return {
    id: scenario.id,
    note,
    expected,
    actual: String(actualArmed),
    seed,
    verdict: caseVerdict,
    shapes,
    evidence: RIG_LIVE ? arming.evidence : undefined,
  }
}

const corpus = await loadCorpus()
const rows: ScoreRow[] = []
// Sequential (not Promise.all) — gentle on the gateway when RIG_LIVE=1.
for (const scenario of corpus) {
  const row = await scoreScenario(scenario)
  rows.push(row)
  if (RIG_LIVE) console.log(`[${row.id}] ${row.verdict} — evidence: ${row.evidence ?? "(none — scenario errored)"}`)
}

console.table(
  rows.map(({ id, note, expected, actual, seed, verdict, shapes }) => ({ id, note, expected, actual, seed, verdict, shapes })),
)

const ok = rows.filter((r) => r.verdict === "ok").length
const overFire = rows.filter((r) => r.verdict === "over-fire").length
const underFire = rows.filter((r) => r.verdict === "under-fire").length
const errored = rows.filter((r) => r.verdict === "error").length

console.log(`${ok} ok, ${overFire} over-fire, ${underFire} under-fire${errored > 0 ? `, ${errored} error` : ""}`)

process.exit(rows.every((r) => r.verdict === "ok") ? 0 : 1)
