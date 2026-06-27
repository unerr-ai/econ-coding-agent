/**
 * Specialist library + dispatcher for econ's three-role team (S4.3).
 *
 * A specialist is a named, single-purpose role bound to a model tier. Each one
 * runs in its OWN child session (spawned via OpenCode's `task` tool) and returns
 * a compact digest rather than its raw transcript — keeping the orchestrator's
 * context lean. This module holds the specialists as DATA (name, tier, role
 * prompt, allowed tools) plus a pure dispatcher that compiles a specialist + a
 * concrete task into a `task`-tool invocation. No I/O, no side effects.
 *
 * Tier → agent: specialists are mapped onto the agents declared in opencode.json
 * (executor / conductor / reasoner / oracle) via TIER_AGENT. The "worker" tier is
 * a logical role filled by the mid-size `conductor` agent until a dedicated
 * worker agent exists.
 *
 * @sem domain=routing role=router
 */

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

/**
 * Logical model tier a specialist runs on.
 *   executor  — cheap ~9B stateless tool-caller (junior); recon/lint/docstrings.
 *   worker    — mid-size model that needs some judgement; tests/refactor/repair.
 *   conductor — the default mid-tier agent (also fills the worker role).
 *   oracle    — frontier reasoning model; review and high-stakes judgement.
 */
export type SpecialistTier = "executor" | "worker" | "conductor" | "oracle"

/**
 * Maps a logical specialist tier onto the OpenCode agent (subagent_type) that
 * runs it. These names MUST match the `agents` keys in opencode.json. The worker
 * role is filled by the mid-tier `conductor` agent until a dedicated worker
 * agent is declared.
 *
 * @sem domain=routing role=config
 */
export const TIER_AGENT: Record<SpecialistTier, string> = {
  executor: "executor",
  worker: "conductor",
  conductor: "conductor",
  oracle: "oracle",
}

// ---------------------------------------------------------------------------
// Specialist definition
// ---------------------------------------------------------------------------

/**
 * One specialist role: a single-purpose job bound to a tier, with a system-prompt
 * fragment (`role`) and the set of tool ids it is allowed to use. Pure data —
 * the dispatcher compiles it into a runnable `task` invocation.
 *
 * @sem domain=routing role=model
 */
export interface Specialist {
  /** Stable, kebab-case identifier (e.g. "recon", "test-author"). */
  name: string
  /** Logical tier this specialist runs on. */
  tier: SpecialistTier
  /** One-line summary of what the specialist does, for menus/logs. */
  description: string
  /**
   * System-prompt fragment defining the specialist's job and boundaries. Does
   * NOT include the digest contract — the dispatcher appends that uniformly.
   */
  role: string
  /** Tool ids this specialist is permitted to call in its child session. */
  tools: string[]
}

// ---------------------------------------------------------------------------
// Tool bundles (shared across specialists)
// ---------------------------------------------------------------------------

/** Read-only navigation tools: graph queries + plain reads/search. */
const READ_TOOLS = ["read", "grep", "glob", "graph"]
/** Edit-class tools that mutate the working tree. */
const EDIT_TOOLS = ["read", "edit", "write"]

// ---------------------------------------------------------------------------
// The library
// ---------------------------------------------------------------------------

/**
 * The econ specialist library, keyed by name. Grouped by tier:
 *   executor → recon, lint, docstrings
 *   worker   → test-author, refactor, codemod, dep-repair, repro
 *   oracle   → review (senior judgement; may also run on conductor)
 *
 * @sem domain=routing role=config
 */
export const SPECIALISTS: Record<string, Specialist> = {
  // --- executor tier (cheap, stateless) ---
  recon: {
    name: "recon",
    tier: "executor",
    description: "Read-only investigation: find/trace/map code and return a context digest.",
    role: "You are a recon specialist. Investigate the codebase to answer the task using read-only graph and search tools only. Do NOT edit any file. Trace the relevant entities, callers, and conventions.",
    tools: READ_TOOLS,
  },
  lint: {
    name: "lint",
    tier: "executor",
    description: "Run the linter/formatter and report violations (no source edits).",
    role: "You are a lint specialist. Run the project's lint/format commands and report the violations and their locations. Do NOT change source files unless the task explicitly asks you to auto-fix.",
    tools: ["read", "grep", "bash"],
  },
  docstrings: {
    name: "docstrings",
    tier: "executor",
    description: "Add or repair @sem doc comments on exported entities.",
    role: "You are a docstrings specialist. Add or repair the 1-2 sentence prose summary plus the `@sem domain=<tag> role=<tag>` line above exported entities named in the task. Change comments only — never the code behaviour.",
    tools: EDIT_TOOLS,
  },

  // --- worker tier (needs judgement) ---
  "test-author": {
    name: "test-author",
    tier: "worker",
    description: "Write or improve tests for the targeted code, then run them.",
    role: "You are a test-author specialist. Write or strengthen tests for the code named in the task, mirroring existing test conventions, then run only those test files and report pass/fail. Do NOT change production code to make a test pass.",
    tools: [...EDIT_TOOLS, "bash"],
  },
  refactor: {
    name: "refactor",
    tier: "worker",
    description: "Multi-site mechanical refactor: rename / extract / inline / move.",
    role: "You are a refactor specialist. Perform the mechanical refactor described, updating every affected site. Use graph references to find all call sites before editing. Preserve behaviour exactly.",
    tools: [...EDIT_TOOLS, "graph"],
  },
  codemod: {
    name: "codemod",
    tier: "worker",
    description: "Apply a repeated mechanical change across many files via one pass.",
    role: "You are a codemod specialist. Apply the described change across the matching files. Prefer a single command or script over editing files one by one. Report the set of files changed.",
    tools: [...EDIT_TOOLS, "bash", "grep", "glob"],
  },
  "dep-repair": {
    name: "dep-repair",
    tier: "worker",
    description: "Propagate a signature change: fix every caller and import, build until green.",
    role: "You are a dep-repair specialist. After a signature or contract change, update every caller and import so the build/typecheck passes. Use graph references to enumerate call sites, then re-run typecheck until green.",
    tools: [...EDIT_TOOLS, "graph", "bash"],
  },
  repro: {
    name: "repro",
    tier: "worker",
    description: "Build a minimal reproduction of a bug and confirm it fails.",
    role: "You are a repro specialist. Build the smallest runnable reproduction of the described bug, run it, and report the exact failing output. Do NOT attempt to fix the bug.",
    tools: [...EDIT_TOOLS, "bash"],
  },

  // --- oracle tier (senior judgement) ---
  review: {
    name: "review",
    tier: "oracle",
    description: "Review a diff for correctness and risk; return findings (no edits).",
    role: "You are a review specialist. Review the diff/change described for correctness bugs, breaking changes, and blast radius using read-only tools. Do NOT edit any file. Return findings ranked by severity.",
    tools: READ_TOOLS,
  },
}

// ---------------------------------------------------------------------------
// Digest contract
// ---------------------------------------------------------------------------

/**
 * Appended to every dispatched specialist prompt. Forces each child session to
 * return a compact, structured digest instead of its raw transcript, so the
 * orchestrator integrates a summary — not a wall of tool output.
 */
export const DIGEST_CONTRACT = [
  "",
  "---",
  "Return ONLY a compact digest (not your raw transcript):",
  "- WHAT YOU DID: 1-3 lines.",
  "- FILES TOUCHED: absolute paths, or 'none'.",
  "- RESULT: the answer / findings / test outcome the orchestrator needs.",
  "- FOLLOW-UPS: anything the orchestrator must do next, or 'none'.",
].join("\n")

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * A compiled, runnable specialist call: hand these fields straight to OpenCode's
 * `task` tool to spawn the specialist in its own child session.
 *
 * @sem domain=routing role=model
 */
export interface SpecialistInvocation {
  /** OpenCode agent to spawn (the `task` tool's subagent_type). */
  subagent_type: string
  /** Short 3-5 word task description for the `task` tool. */
  description: string
  /** Full prompt: the specialist's role + the concrete task + the digest contract. */
  prompt: string
}

/** Look up a specialist by name. Returns undefined when unknown. */
export function getSpecialist(name: string): Specialist | undefined {
  return SPECIALISTS[name]
}

/** All specialists declared for the given tier. */
export function specialistsForTier(tier: SpecialistTier): Specialist[] {
  return Object.values(SPECIALISTS).filter((s) => s.tier === tier)
}

/** Every specialist name in the library. */
export function listSpecialists(): string[] {
  return Object.keys(SPECIALISTS)
}

/**
 * Compile a specialist + a concrete task into a `task`-tool invocation: resolves
 * the tier to an agent, composes role prompt + task + digest contract, and emits
 * a 3-5 word description. Pure — throws only when the specialist name is unknown.
 *
 * @sem domain=routing role=router
 */
export function dispatchSpecialist(name: string, task: string): SpecialistInvocation {
  const specialist = SPECIALISTS[name]
  if (!specialist) {
    throw new Error(
      `Unknown specialist "${name}". Known: ${listSpecialists().join(", ")}`,
    )
  }
  const subagent_type = TIER_AGENT[specialist.tier]
  const prompt = [specialist.role, "", `TASK: ${task}`, DIGEST_CONTRACT].join("\n")
  return {
    subagent_type,
    description: `${specialist.name} specialist`,
    prompt,
  }
}
