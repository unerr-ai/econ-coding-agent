// Standalone OFFLINE dev harness for the localization-arming decision — drives
// the P1-alt pipeline end to end (turn-read verdict evidence → the PURE
// `decideArming` table → skeleton + autoTypeTodos seed planting) against a
// labeled corpus, so the arming policy can be iterated without full arena runs.
// P4 rows drive the CONTINUATION pipeline instead: the pre-LLM short-circuit
// (or the mock verdict's turnRole) routes the row to the inherit path — no
// skeleton reseed, arming inherited from `priorMockVerdict`'s decision — and
// arming is scored on the seeds THIS TURN plants (a settled seed already in
// `todos` never counts, which is exactly the no-re-arm rule).
// Plain script, NOT a *.test.ts: run via `bun run test/arming-rig/run.ts`
// from packages/opencode. `bun test` does not pick this file up (its name
// doesn't match the *.test.ts/*.spec.ts patterns bun test scans for).
import { autoTypeTodos, buildTriageTodoSkeleton } from "../../src/session/slice-orchestrator"
import { LOCALIZATION_SLICE_CONTENT, PLAN_SLICE_CONTENT } from "../../src/session/prompts/seeds"
import { decideArming, type ArmingVerdict } from "../../src/session/arming-judge"
import {
  runTurnRead,
  isContinuationShortCircuit,
  type TriageComplete,
  type TriageCompleteRequest,
} from "../../src/session/turn-triage"
import { ECON_TIER_BINDING } from "../../../code-intelligence/src/model-registry"
import type { ArmingScenario, TriageVerdict, OrchestrationTodo } from "./types"

// Fallback corpus — used only when ./corpus.ts is missing or exports an empty
// CORPUS, so this script stays runnable standalone.
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
          evidence: {
            locationNamed: true,
            locationQuote: "packages/core/src/util/range.ts",
            fixSpecified: false,
            hardness: "trivial",
            ambiguity: "clear",
          },
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
          evidence: { locationNamed: false, fixSpecified: false, hardness: "moderate", ambiguity: "clear" },
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: true,
      seedKind: "localization",
      reason: "no location evidence — the decision table arms localization",
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
// endpoint and returns the assistant message content. MIRRORS production's
// turnReadDispatch (prompt.ts): temperature 0 (P2a) and no reasoning_effort
// override — the conductor reasons through the evidence fields at its
// provider default.
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

// Live turn-read seam: runs the real `runTurnRead` extractor against the
// gateway (goals + evidence in ONE call). Only reached from scoreScenario
// when RIG_LIVE=1. The arming decision is CODE in both modes — live mode
// validates the extraction, never a model-made decision.
async function liveTurnRead(prompt: string): Promise<TriageVerdict> {
  const verdict = await runTurnRead({ userPrompt: prompt, complete: gatewayComplete })
  if (!verdict) throw new Error("liveTurnRead: runTurnRead returned null (timeout or parse failure)")
  return verdict
}

type CaseVerdict = "ok" | "over-fire" | "under-fire" | "wrong-seed" | "wrong-role" | "wrong-shape" | "error"

interface ScoreRow {
  id: string
  note: string
  expected: boolean
  actual: string
  seed: string
  role: string
  verdict: CaseVerdict
  shapes: string
  /** The decision table's grounding string, printed per row so it can be eyeballed. */
  evidence?: string
}

/** The seeds THIS TURN planted: present in the materialized list but not in the session's pre-existing todos — a settled seed from a prior turn never counts as armed (the P4 no-re-arm rule). */
function newlyPlantedSeeds(materialized: readonly OrchestrationTodo[], existing: readonly OrchestrationTodo[]): string[] {
  const baseline = new Set(existing.map((t) => t.content))
  return [
    ...(materialized.some((t) => t.content === LOCALIZATION_SLICE_CONTENT) && !baseline.has(LOCALIZATION_SLICE_CONTENT)
      ? ["localization"]
      : []),
    ...(materialized.some((t) => t.content === PLAN_SLICE_CONTENT) && !baseline.has(PLAN_SLICE_CONTENT) ? ["plan"] : []),
  ]
}

async function scoreScenario(scenario: ArmingScenario): Promise<ScoreRow> {
  const note = scenario.note ?? "-"
  const expected = scenario.expect.localizationArmed
  const existingTodos = scenario.todos ?? []

  // P4 — the continuation pipeline, mirroring prompt.ts's turn open: the
  // pre-LLM short-circuit fires only when the session has prior turns
  // (modeled by priorMockVerdict); otherwise the (mock) turn-read's turnRole
  // decides. Role mismatches against the row's expectation score wrong-role.
  const hasPriorTurns = scenario.priorMockVerdict !== undefined
  const shortCircuited = hasPriorTurns && isContinuationShortCircuit(scenario.prompt)
  if (scenario.expect.shortCircuit !== undefined && shortCircuited !== scenario.expect.shortCircuit) {
    return {
      id: scenario.id,
      note,
      expected,
      actual: `short-circuit=${shortCircuited}, expected ${scenario.expect.shortCircuit}`,
      seed: "—",
      role: shortCircuited ? "short-circuit" : "fresh",
      verdict: "wrong-role",
      shapes: "-",
    }
  }

  let verdict: TriageVerdict | undefined
  let arming: ArmingVerdict
  let continuation = shortCircuited
  try {
    if (!shortCircuited) {
      if (RIG_LIVE) {
        // Live mode validates the REAL extraction: a scenario that pins a mock
        // verdict keeps it; otherwise the merged turn-read runs on the gateway.
        verdict = scenario.mockVerdict ?? (await liveTurnRead(scenario.prompt))
      } else {
        if (!scenario.mockVerdict) {
          throw new Error("deterministic mode requires scenario.mockVerdict — set RIG_LIVE=1 to hit the real gateway")
        }
        verdict = scenario.mockVerdict
      }
      if (hasPriorTurns && verdict.turnRole === "continuation") continuation = true
    }
    // P1-alt: the arming decision is the PURE code table in BOTH modes. A
    // continuation INHERITS the prior turn's stored decision (P4) instead of
    // recomputing from this turn's text.
    arming = continuation ? decideArming(scenario.priorMockVerdict) : decideArming(verdict)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      id: scenario.id,
      note,
      expected,
      actual: `error: ${message}`,
      seed: "—",
      role: "-",
      verdict: "error",
      shapes: "-",
    }
  }

  // Shape boundary rows (P3 — e.g. adds-behavior must classify build, never
  // refactor): when the row pins an expected shape and a verdict was
  // consumed, some goal must carry it. Deterministic mocks encode the correct
  // answer by construction; live mode (RIG_LIVE=1) scores the real extractor.
  if (scenario.expect.shape !== undefined && verdict && !verdict.goals.some((g) => g.shape === scenario.expect.shape)) {
    return {
      id: scenario.id,
      note,
      expected,
      actual: `no ${scenario.expect.shape} goal in [${verdict.goals.map((g) => g.shape).join(", ")}]`,
      seed: "—",
      role: "fresh",
      verdict: "wrong-shape",
      shapes: verdict.goals.map((g) => g.shape).join(", ") || "-",
    }
  }

  const actualRole = continuation ? "continuation" : "fresh"
  if ((scenario.expect.turnRole ?? "fresh") !== actualRole) {
    return {
      id: scenario.id,
      note,
      expected,
      actual: `turnRole=${actualRole}, expected ${scenario.expect.turnRole ?? "fresh"}`,
      seed: "—",
      role: actualRole,
      verdict: "wrong-role",
      shapes: verdict?.goals.map((g) => g.shape).join(", ") || "-",
    }
  }

  // The decision table decides; the skeleton + autoTypeTodos net then
  // materializes the frame pre-pass from that decision. A continuation turn
  // SKIPS the skeleton reseed (P4) — only the Door-2 net runs, over the
  // session's existing todo list, with the inherited decision.
  const typed = continuation
    ? autoTypeTodos(existingTodos, arming.armLocalization)
    : autoTypeTodos(scenario.todos ?? buildTriageTodoSkeleton(verdict!, arming), arming.armLocalization)
  // The pre-pass engages the expensive reasoner tier, so over/under-fire is
  // measured on "any pre-pass THIS TURN planted"; the `seed` column reports
  // WHICH kind (P12): the diagnosis localization writer, the hard-build plan
  // seed, or none. Seeds already on the session list (a settled prior
  // pre-pass) never count — the P4 no-re-arm rule.
  const seedKinds = newlyPlantedSeeds(typed, existingTodos)
  const seed = seedKinds.length > 0 ? seedKinds.join("+") : "—"
  const actualArmed = seedKinds.length > 0
  const shapes = verdict?.goals.map((g) => g.shape).join(", ") || (continuation ? "(inherited)" : "-")

  // Armed rows must also plant the EXPECTED seed kind (planner-vs-localizer is
  // no longer invisible): kind mismatch — or a corpus row missing its seedKind
  // label — scores wrong-seed even though "any pre-pass" armed correctly.
  const caseVerdict: CaseVerdict =
    actualArmed !== expected
      ? expected
        ? "under-fire"
        : "over-fire"
      : expected && seed !== scenario.expect.seedKind
        ? "wrong-seed"
        : "ok"
  return {
    id: scenario.id,
    note,
    expected,
    actual: String(actualArmed),
    seed,
    role: shortCircuited ? "short-circuit" : actualRole,
    verdict: caseVerdict,
    shapes,
    evidence: arming.evidence,
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
  rows.map(({ id, note, expected, actual, seed, role, verdict, shapes }) => ({
    id,
    note,
    expected,
    actual,
    seed,
    role,
    verdict,
    shapes,
  })),
)

const ok = rows.filter((r) => r.verdict === "ok").length
const overFire = rows.filter((r) => r.verdict === "over-fire").length
const underFire = rows.filter((r) => r.verdict === "under-fire").length
const wrongSeed = rows.filter((r) => r.verdict === "wrong-seed").length
const wrongRole = rows.filter((r) => r.verdict === "wrong-role").length
const wrongShape = rows.filter((r) => r.verdict === "wrong-shape").length
const errored = rows.filter((r) => r.verdict === "error").length

console.log(
  `${ok} ok, ${overFire} over-fire, ${underFire} under-fire, ${wrongSeed} wrong-seed, ${wrongRole} wrong-role, ${wrongShape} wrong-shape${errored > 0 ? `, ${errored} error` : ""}`,
)

process.exit(rows.every((r) => r.verdict === "ok") ? 0 : 1)
