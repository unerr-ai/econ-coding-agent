/**
 * Loop-adherence case set — a handful of conductor turns covering a full
 * multi-step task, a read-only recon task, and a trivial lookup, each with
 * a canned trace standing in for a live conductor run.
 * @sem domain=eval role=fixtures
 */

import type { LoopCase } from "./loop-types.js"

/**
 * All cases run by the loop-adherence eval. Each case's mockTrace is a
 * compliant trace, so the eval passes in dry-run mode without any model
 * call — extend by adding entries to the exported array.
 */
export const LOOP_CASES: LoopCase[] = [
  // ── full loop: multi-step feature, expects meta-plan + list + delegation + verify ──
  {
    id: "multi-step-feature",
    prompt: "Add a retry flag to the fetch client and wire it through the CLI, with tests.",
    nontrivial: true,
    expectDelegation: true,
    expectVerification: true,
    threshold: 1.0,
    mockTrace: {
      textParts: [
        "I'll plan this: 1) find the fetch client and CLI wiring, 2) add the retry option, " +
          "3) wire it through the CLI flag, 4) add tests, 5) verify with typecheck + targeted tests.",
      ],
      toolCalls: [
        {
          name: "todowrite",
          input: { todos: ["find fetch client", "add retry flag", "wire CLI", "add tests", "verify"] },
        },
        { name: "task", input: { subagent_type: "unerr-junior", description: "find the fetch client and CLI wiring" } },
        { name: "task", input: { subagent_type: "unerr-worker", description: "add retry option + CLI flag + tests" } },
        {
          name: "task",
          input: { subagent_type: "unerr-junior", description: "run typecheck and targeted tests to verify the change" },
        },
      ],
    },
  },

  // ── read-only recon: delegation expected, nothing to edit or verify ────────
  {
    id: "read-only-investigation",
    prompt: "Where is retry currently handled across the fetch client and its callers?",
    nontrivial: true,
    expectDelegation: true,
    expectVerification: false,
    threshold: 1.0,
    mockTrace: {
      textParts: [
        "My approach: delegate a read-only trace of the fetch client and its callers, then summarize.",
      ],
      toolCalls: [
        { name: "todowrite", input: { todos: ["trace fetch client", "trace callers", "summarize"] } },
        {
          name: "task",
          input: { subagent_type: "unerr-junior", description: "trace retry handling across the fetch client and callers" },
        },
      ],
    },
  },

  // ── trivial turn: single fact lookup, loop is not expected to fire ─────────
  {
    id: "trivial-lookup",
    prompt: "What port does the dev server run on?",
    nontrivial: false,
    expectDelegation: false,
    expectVerification: false,
    threshold: 1.0,
    mockTrace: {
      textParts: ["3000."],
      toolCalls: [],
    },
  },

  // ── side-task delegation: fix lands, cross-TZ jest matrix delegated to a runner ──
  // side-task instead of run inline (modeled on the dayjs #3123 trace failure — 14
  // jest commands run inline with zero task calls).
  {
    id: "side-task-delegation",
    prompt: "Fix the dayjs UTC-offset parsing bug (issue #3123) and confirm it holds across timezones.",
    nontrivial: true,
    expectDelegation: true,
    expectVerification: true,
    threshold: 1.0,
    mockTrace: {
      textParts: [
        "Fix verified locally once; I'll delegate the cross-TZ jest matrix to a runner side-task, " +
          "then review its digest before reporting.",
      ],
      toolCalls: [
        {
          name: "todowrite",
          input: {
            todos: [
              "apply the UTC-offset fix",
              "verify locally once",
              "delegate cross-TZ jest matrix to a runner side-task",
              "review runner digest",
              "report",
            ],
          },
        },
        {
          name: "task",
          input: {
            subagent_type: "runner",
            description: "run the cross-timezone jest verification matrix and report a pass/fail digest",
            prompt:
              "Verify the UTC-offset fix holds across timezones by running these suites and reporting " +
              "pass/fail per run:\n" +
              "TZ=America/Sao_Paulo npx jest test/parse.test.js\n" +
              "TZ=Pacific/Kiritimati npx jest test/utc.test.js\n" +
              "TZ=Asia/Kolkata npx jest test/timezone.test.js\n" +
              "TZ=Pacific/Apia npx jest test/plugin/utc.test.js",
          },
        },
      ],
    },
  },
]
