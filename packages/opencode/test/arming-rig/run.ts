// Standalone OFFLINE dev harness for the localization-arming decision — scores
// the REAL arming-judge pipeline (heuristicArming / judgeArming) against a
// labeled corpus so the arming logic can be iterated without full arena runs.
// Plain script, NOT a *.test.ts: run via `bun run test/arming-rig/run.ts`
// from packages/opencode. `bun test` does not pick this file up (its name
// doesn't match the *.test.ts/*.spec.ts patterns bun test scans for).
import {
  autoTypeTodos,
  buildTriageTodoSkeleton,
  LOCALIZATION_SLICE_CONTENT,
  PLANNER_SLICE_CONTENT,
} from "../../src/session/slice-orchestrator"
import { heuristicArming, type ArmingVerdict } from "../../src/session/arming-judge"
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

// Live-triage seam. Wiring a real model/gateway call here means adapting a
// `TriageComplete` (system, user) => text callback bound to a live provider —
// non-trivial for this offline harness — so every scenario runs deterministic
// (scenario.mockVerdict) until this is filled in. See `runTurnTriage` in
// packages/opencode/src/session/turn-triage.ts for the real entrypoint to
// wire in once that adapter exists.
async function liveTriage(prompt: string): Promise<TriageVerdict> {
  void prompt
  throw new Error("live mode not wired yet — TODO")
}

// Live-arming seam. Wiring a real model/gateway call here means adapting the
// same `TriageComplete` (system, user) => text callback the judge needs
// (`judgeArming({ userPrompt, verdict, complete })`) bound to a live provider —
// non-trivial for this offline harness — so every scenario runs deterministic
// (heuristicArming) until this is filled in. See `judgeArming` in
// packages/opencode/src/session/arming-judge.ts for the real entrypoint to
// wire in once that adapter exists.
async function liveArming(prompt: string, verdict: TriageVerdict): Promise<ArmingVerdict> {
  void prompt
  void verdict
  throw new Error("live mode not wired yet — TODO")
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
}

async function scoreScenario(scenario: ArmingScenario): Promise<ScoreRow> {
  const note = scenario.note ?? "-"
  const expected = scenario.expect.localizationArmed

  let verdict: TriageVerdict
  let arming: ArmingVerdict
  try {
    verdict = scenario.mockVerdict ?? (await liveTriage(scenario.prompt))
    arming = scenario.mockVerdict ? heuristicArming(verdict) : await liveArming(scenario.prompt, verdict)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { id: scenario.id, note, expected, actual: `error: ${message}`, seed: "—", verdict: "error", shapes: "-" }
  }

  // Arming judge decides (heuristicArming here, judgeArming once live is
  // wired); the skeleton + autoTypeTodos net then materializes the
  // localization pre-pass from that decision.
  const skeleton = buildTriageTodoSkeleton(verdict, arming)
  const typed = autoTypeTodos(scenario.todos ?? skeleton, arming.armLocalization)
  // A pre-pass of EITHER flavor engages the expensive reasoner/oracle tier, so
  // over/under-fire is measured on "any pre-pass armed"; the `seed` column shows
  // which flavor (localization vs the plan-first planner) the decision produced.
  const seed = typed.some((t) => t.content === LOCALIZATION_SLICE_CONTENT)
    ? "localization"
    : typed.some((t) => t.content === PLANNER_SLICE_CONTENT)
      ? "planner"
      : "—"
  const actualArmed = seed !== "—"
  const shapes = verdict.goals.map((g) => g.shape).join(", ") || "-"

  const caseVerdict: CaseVerdict = actualArmed === expected ? "ok" : expected ? "under-fire" : "over-fire"
  return { id: scenario.id, note, expected, actual: String(actualArmed), seed, verdict: caseVerdict, shapes }
}

const corpus = await loadCorpus()
const rows: ScoreRow[] = []
for (const scenario of corpus) rows.push(await scoreScenario(scenario))

console.table(
  rows.map(({ id, note, expected, actual, seed, verdict, shapes }) => ({ id, note, expected, actual, seed, verdict, shapes })),
)

const ok = rows.filter((r) => r.verdict === "ok").length
const overFire = rows.filter((r) => r.verdict === "over-fire").length
const underFire = rows.filter((r) => r.verdict === "under-fire").length
const errored = rows.filter((r) => r.verdict === "error").length

console.log(`${ok} ok, ${overFire} over-fire, ${underFire} under-fire${errored > 0 ? `, ${errored} error` : ""}`)

process.exit(rows.every((r) => r.verdict === "ok") ? 0 : 1)
