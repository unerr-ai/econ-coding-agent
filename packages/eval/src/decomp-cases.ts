/**
 * Decomposition-quality case set (OL-7.4) — a handful of realistic coding
 * task prompts, each with a canned conductor todo output (standing in for
 * a live decomposition) and a hand-labeled expected slice DAG covering all
 * four (coupling × test-strength) matrix cells plus the design-forces-oracle
 * and need-hint-safety-net invariants.
 * @sem domain=eval role=fixtures
 */

import type { DecompCase } from "./decomp-types.js"

/**
 * All cases run by the decomposition-quality eval. Each case's `mockTodos`
 * is a compliant conductor output, so the eval passes in dry-run mode
 * without any model call — extend by adding entries to the exported array.
 */
export const DECOMP_CASES: DecompCase[] = [
  // ── the doc's §4.4 worked example: design → high-coupling·testable propagation → low-coupling·testable verify ──
  {
    id: "migrate-auth-token-refresh",
    prompt: "Migrate the auth middleware to add token refresh, and propagate the change to all callers.",
    threshold: 1.0,
    mockTodos: [
      {
        content: "design the token-refresh interface for the auth middleware",
        status: "pending",
        sliceType: "design",
        need: "oracle",
        coupling: "high",
        testStrength: "untestable",
      },
      {
        content: "propagate the token-refresh signature to all ~40 callers",
        status: "pending",
        sliceType: "mechanical",
        need: "executor",
        deps: ["design the token-refresh interface for the auth middleware"],
        coupling: "high",
        testStrength: "testable",
      },
      {
        content: "run the final typecheck and targeted tests to verify the migration",
        status: "pending",
        sliceType: "verify",
        need: "executor",
        deps: ["propagate the token-refresh signature to all ~40 callers"],
        coupling: "low",
        testStrength: "testable",
      },
    ],
    expectedSlices: [
      {
        content: "design the token-refresh interface for the auth middleware",
        sliceType: "design",
        deps: [],
        coupling: "high",
        testStrength: "untestable",
        tier: "oracle",
        verification: "judge",
      },
      {
        content: "propagate the token-refresh signature to all ~40 callers",
        sliceType: "mechanical",
        deps: ["design the token-refresh interface for the auth middleware"],
        coupling: "high",
        testStrength: "testable",
        tier: "executor",
        verification: "sound",
      },
      {
        content: "run the final typecheck and targeted tests to verify the migration",
        sliceType: "verify",
        deps: ["propagate the token-refresh signature to all ~40 callers"],
        coupling: "low",
        testStrength: "testable",
        tier: "executor",
        verification: "sound",
      },
    ],
  },

  // ── low-coupling · testable: the bulk-of-coding cell ──────────────────────
  {
    id: "single-file-retry-flag",
    prompt: "Add a --retry flag to the fetch client (single file, already covered by existing tests).",
    threshold: 1.0,
    mockTodos: [
      {
        content: "add a --retry flag to the fetch client (single file, covered by tests)",
        status: "pending",
        sliceType: "mechanical",
        need: "executor",
        coupling: "low",
        testStrength: "testable",
      },
    ],
    expectedSlices: [
      {
        content: "add a --retry flag to the fetch client (single file, covered by tests)",
        sliceType: "mechanical",
        deps: [],
        coupling: "low",
        testStrength: "testable",
        tier: "executor",
        verification: "sound",
      },
    ],
  },

  // ── low-coupling · untestable: QE self-consistency, no design tag ─────────
  {
    id: "onboarding-email-copy",
    prompt: "The onboarding email subject line reads awkwardly — investigate and propose better wording.",
    threshold: 1.0,
    mockTodos: [
      {
        content: "investigate the onboarding email subject line and propose better wording (no test covers prose)",
        status: "pending",
        sliceType: "recon",
        need: "executor",
        coupling: "low",
        testStrength: "untestable",
      },
    ],
    expectedSlices: [
      {
        content: "investigate the onboarding email subject line and propose better wording (no test covers prose)",
        sliceType: "recon",
        deps: [],
        coupling: "low",
        testStrength: "untestable",
        tier: "executor",
        verification: "qe",
      },
    ],
  },

  // ── high-coupling · untestable: the residual, reached WITHOUT a design tag ──
  {
    id: "sync-protocol-handshake-trace",
    prompt: "Trace how the sync protocol's handshake threads through the CLI and desktop clients (no test covers it).",
    threshold: 1.0,
    mockTodos: [
      {
        content: "trace how the sync protocol's handshake threads through the CLI and desktop clients (no test covers it)",
        status: "pending",
        sliceType: "recon",
        need: "executor",
        coupling: "high",
        testStrength: "untestable",
      },
    ],
    expectedSlices: [
      {
        content: "trace how the sync protocol's handshake threads through the CLI and desktop clients (no test covers it)",
        sliceType: "recon",
        deps: [],
        coupling: "high",
        testStrength: "untestable",
        tier: "oracle",
        verification: "judge",
      },
    ],
  },

  // ── need-hint safety-net invariant: an over-eager "oracle" hint on a testable slice must be ignored ──
  {
    id: "config-key-rename-over-eager-hint",
    prompt: "Rename the `foo` config key to `bar` across the 2 files that reference it (already type-checked).",
    threshold: 1.0,
    mockTodos: [
      {
        content: "rename the foo config key to bar across the 2 referencing files (type-checked, no design decision)",
        status: "pending",
        sliceType: "mechanical",
        need: "oracle",
        coupling: "low",
        testStrength: "testable",
      },
    ],
    expectedSlices: [
      {
        content: "rename the foo config key to bar across the 2 referencing files (type-checked, no design decision)",
        sliceType: "mechanical",
        deps: [],
        coupling: "low",
        testStrength: "testable",
        tier: "executor",
        verification: "sound",
        needHintShouldBeIgnored: true,
      },
    ],
  },
]
