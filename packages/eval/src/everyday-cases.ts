/**
 * Everyday-capability case set (OL-7.12) — trivial-turn latency, clarify-vs-
 * guess, and multi-turn coherence cases, each scoped to a test-poor fixture
 * repo (see test-poor-repos.ts) so the untestable allocation column and the
 * QE/judge verifier rungs are what's actually being exercised, not the
 * sound-test rung. Each case's canned fields are a golden (correct-behavior)
 * trace, so the offline eval passes without any model call — extend by
 * adding entries to the exported array.
 * @sem domain=eval role=fixtures
 */

import type { EverydayCase } from "./everyday-types.js"

export const EVERYDAY_CASES: EverydayCase[] = [
  // ── trivial-turn latency: decomposition ceremony must not tax a simple ask ──
  {
    id: "trivial-latency-dev-port",
    metric: "trivial_latency",
    repoId: "tiny-cli-tool",
    prompt: "What port does the dev server run on?",
    baselineLatencyMs: 900,
    decomposeLatencyMs: 950,
    // Initial gate ceiling — no numeric threshold is pinned in the plan doc (design-first);
    // tune once OL-7.6 live A/B numbers exist. Intent: a single-fact trivial lookup should
    // not pay for a meta-plan/task-list/delegation round-trip.
    maxDeltaMs: 250,
  },
  {
    id: "trivial-latency-file-count",
    metric: "trivial_latency",
    repoId: "legacy-report-scripts",
    prompt: "How many script files are in this repo?",
    baselineLatencyMs: 850,
    decomposeLatencyMs: 950,
    maxDeltaMs: 250,
  },

  // ── clarify-vs-guess: ambiguous asks on a test-poor repo should ask, not guess ──
  {
    id: "clarify-ambiguous-date-format",
    metric: "clarify_vs_guess",
    repoId: "tiny-cli-tool",
    prompt: "Make the date formatting consistent.",
    ambiguous: true,
    threshold: 1.0,
    mockTrace: {
      textParts: [
        "This repo's date formatting isn't consistent in one direction: format.ts uses ISO " +
          "(YYYY-MM-DD), but I don't see a documented target. Which format should it converge on — " +
          "ISO, or something else?",
      ],
      toolCalls: [],
      latencyMs: 1100,
    },
  },
  {
    id: "clarify-ambiguous-send-report",
    metric: "clarify_vs_guess",
    repoId: "legacy-report-scripts",
    prompt: "Send the report.",
    ambiguous: true,
    threshold: 1.0,
    mockTrace: {
      textParts: [
        "There are two distribution lists wired in send-email.js (ops-weekly@ and leads-weekly@) " +
          "and no default. Which one should this send to?",
      ],
      toolCalls: [],
      latencyMs: 1050,
    },
  },
  {
    id: "clarify-control-add-license",
    metric: "clarify_vs_guess",
    repoId: "tiny-cli-tool",
    prompt: "Add an MIT LICENSE file to this repo.",
    ambiguous: false,
    threshold: 1.0,
    mockTrace: {
      textParts: ["Added a standard MIT LICENSE file at the repo root."],
      toolCalls: [{ name: "write", input: { file_path: "LICENSE" } }],
      latencyMs: 800,
    },
  },

  // ── multi-turn coherence: a fact from turn 1 must survive compaction ────────
  {
    id: "coherence-node-version-target",
    metric: "multiturn_coherence",
    repoId: "tiny-cli-tool",
    turnPrompts: [
      "We're targeting Node 18 for this tool, not Node 20 — keep that in mind going forward.",
      "Add a helper that formats a percentage.",
      "Now double-check the helper you just added doesn't use anything Node-18-incompatible.",
    ],
    compactionAtTurn: 2,
    factToRecall: "node 18",
    threshold: 1.0,
    mockTurns: [
      { textParts: ["Noted — Node 18 target."], toolCalls: [], latencyMs: 700 },
      {
        textParts: ["Added formatPercentage(n) to src/format.ts."],
        toolCalls: [{ name: "edit", input: { file_path: "src/format.ts" } }],
        latencyMs: 1200,
      },
      {
        textParts: [
          "Checked formatPercentage against the Node 18 target we agreed on earlier — it only uses " +
            "Intl.NumberFormat, which is available since Node 12, so it's fine.",
        ],
        toolCalls: [],
        latencyMs: 900,
      },
    ],
  },
]
