/**
 * S6.3 in-loop governance gate for the edit/write tools: runs the
 * code-intelligence signature-change detector against the live graph and,
 * when a changed entity's fan-in clears the same chokepoint threshold
 * unerr's own `ur|rsk` signal uses, appends a callers-at-risk warning to the
 * tool's returned output. Non-blocking and fail-open by construction — a
 * cold, slow, or erroring graph simply yields no warning; the edit always
 * lands.
 *
 * @sem domain=intelligence role=tools
 */
import { execSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  computeEditImpact,
  renderInlineBlastRadius,
  type EditImpactGraph,
} from "@opencode-ai/code-intelligence"
import type { StuckSignal } from "../../../code-intelligence/src/orchestration-fsm"
import { getGraph } from "./graph-tools"
import { RSK_CALLER_THRESHOLD } from "./graph-tools-enrich"

/**
 * Bounds how long the gate will wait on the graph per call — a cold graph
 * still mid-index must not hostage the edit/write tool's response.
 */
const GOVERNANCE_GRAPH_BUDGET_MS = 750

/**
 * Evaluate an in-flight edit for a breaking signature change and return an
 * inline `ur|rsk`-style warning listing at-risk callers, or null when
 * there's nothing to surface (no signature change, fan-in below the
 * chokepoint threshold, or the graph is cold/unavailable). Never throws and
 * never blocks past its graph budget — callers can append the result
 * directly to a tool's output string.
 *
 * @sem domain=intelligence role=analysis
 */
// ---------------------------------------------------------------------------
// B3/OL-7.9 no-test-edit gate — ONE structural decision point, not two. A
// test file's content-hash diff (snapshotTestTree/detectTestEdit below,
// ALWAYS-ON and decoupled from the prompt) is the single source of truth
// that a test file was actually edited; the prompt-derived per-session flag
// (setTestEditGate/testEditGateArmed, armed at turn open by prompt.ts) is
// consumed only as a POLICY INPUT inside evaluateTestEditGate — never a
// second independent gate a caller checks on its own. On a fix-shaped turn
// (armed) the structural diff hard-denies via testEditDenialMessage, same as
// before (the 11885 self-verification failure; SWE Atlas / SWE-bench
// validators enforce the same rule post-hoc — we enforce it at the
// chokepoint we own). On any other turn this is NOT a blanket ban: a
// structural test edit coincident with a red→green transition raises a
// StuckSignal instead of blocking, so the reasoner can adjudicate
// code-wrong vs test-stale, since a legitimate fix sometimes touches a test.
// Creating a NEW test file (a repro) stays allowed either way. Child slice
// sessions inherit the parent's armed flag unless their own task is
// test-authoring-shaped.
// ---------------------------------------------------------------------------

// Same test-tree shape as slice-orchestrator's TEST_TREE_GUARD_COMMAND ERE:
// tests?/ __tests__/ specs?/ directories, .test./.spec. suffixes, _test.<ext>,
// and python's test_*.py / tests.py.
const TEST_PATH_RE =
  /(^|\/)(tests?|__tests__|specs?)\/|\.(test|spec)\.[a-zA-Z]+$|_test\.[a-z]+$|(^|\/)test_[^/]+\.py$|(^|\/)tests?\.py$/

/** Is this path inside the repo's test tree? @sem domain=intelligence role=analysis */
export function isTestFilePath(filePath: string): boolean {
  return TEST_PATH_RE.test(filePath.replaceAll("\\", "/"))
}

const testEditGate = new Set<string>()

/**
 * Arm or disarm the no-test-edit gate for a session. Called once per turn at
 * turn open (root sessions decide from the user prompt; child sessions
 * inherit). Re-arming every turn means a later non-fix turn on the same
 * session disarms a stale gate automatically.
 */
export function setTestEditGate(sessionID: string, deny: boolean): void {
  if (deny) testEditGate.add(sessionID)
  else testEditGate.delete(sessionID)
}

/** Is the no-test-edit gate armed for this session? */
export function testEditGateArmed(sessionID: string): boolean {
  return testEditGate.has(sessionID)
}

/**
 * The reason string thrown at the edit/write boundary when the gate denies a
 * test-file modification — written for the model that just tried the edit:
 * name the rule, reframe the disagreement as evidence about the patch, and
 * leave the legitimate outs explicit (new repro file; surface the claim that
 * the test itself is wrong instead of editing it).
 */
export function testEditDenialMessage(relPath: string): string {
  return (
    `Edit denied by the no-test-edit gate: "${relPath}" is an existing test file and this turn is fixing a defect. ` +
    `Changing tests to match a patch invalidates the only oracle that can catch a wrong fix. ` +
    `If a test contradicts your patch, treat that as evidence about the patch: re-check the localization and change source code instead. ` +
    `If you believe the test itself encodes the bug, state that in your final answer with the evidence — do not edit it. ` +
    `Writing a NEW test file that reproduces the reported defect is allowed.`
  )
}

/**
 * A content-addressed fingerprint of the repo's tracked test files: one
 * sha256 hash per relative path. Captured at turn open and diffed at turn
 * end by detectTestEdit — the always-on structural baseline that never
 * depends on a prompt-derived constraint firing correctly.
 *
 * @sem domain=intelligence role=analysis
 */
export interface TestTreeSnapshot {
  hashes: Record<string, string>
}

/**
 * Hash every git-tracked test file under `worktree` into a TestTreeSnapshot.
 * Uses `git ls-files` so untracked scratch files never pollute the
 * fingerprint, and resolves to an empty snapshot outside a git repo — the
 * same inert-outside-git fallback slice-orchestrator's TEST_TREE_GUARD_COMMAND
 * relies on. Call once at turn open; never throws.
 *
 * @sem domain=intelligence role=analysis
 */
export function snapshotTestTree(worktree: string): TestTreeSnapshot {
  const hashes: Record<string, string> = {}
  let tracked: string[]
  try {
    tracked = execSync("git ls-files", { cwd: worktree, encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
  } catch {
    return { hashes }
  }
  for (const relPath of tracked) {
    if (!isTestFilePath(relPath)) continue
    try {
      const content = readFileSync(join(worktree, relPath), "utf8")
      hashes[relPath] = createHash("sha256").update(content).digest("hex")
    } catch {
      // listed by git but unreadable (race, submodule, binary) — skip
    }
  }
  return { hashes }
}

/**
 * Diff two TestTreeSnapshots and return the test files that were MODIFIED —
 * present in both with a changed hash. A brand-new file (present only in
 * `after`) is a repro, not a test edit, matching the --diff-filter=M
 * carve-out TEST_TREE_GUARD_COMMAND already relies on.
 *
 * @sem domain=intelligence role=analysis
 */
export function detectTestEdit(before: TestTreeSnapshot, after: TestTreeSnapshot): string[] {
  const changed: string[] = []
  for (const [relPath, beforeHash] of Object.entries(before.hashes)) {
    const afterHash = after.hashes[relPath]
    if (afterHash !== undefined && afterHash !== beforeHash) changed.push(relPath)
  }
  return changed
}

/**
 * The single test-edit gate's verdict: nothing to do, a hard deny, or an
 * escalation for the stuck supervisor to adjudicate.
 *
 * @sem domain=intelligence role=analysis
 */
export type TestEditGateResult =
  | { action: "allow" }
  | { action: "deny"; file: string; message: string }
  | { action: "stuck"; signal: StuckSignal }

/**
 * The ONE test-edit gate decision point. Structural detection is always on
 * (detectTestEdit runs regardless of any prompt signal); the session's
 * prompt-derived armed flag (testEditGateArmed) is consumed here only as a
 * policy input, never as a second independent check a caller runs on its
 * own. A fix-shaped turn (armed) hard-denies the first modified test file;
 * any other turn whose probe went red→green while a test changed raises a
 * StuckSignal instead of blocking, so the reasoner can adjudicate
 * code-wrong vs test-stale; a test edit outside both conditions — or no
 * test edit at all — allows through.
 *
 * @sem domain=intelligence role=analysis
 */
export function evaluateTestEditGate(opts: {
  sessionID: string
  before: TestTreeSnapshot
  after: TestTreeSnapshot
  redToGreen: boolean
}): TestEditGateResult {
  const changed = detectTestEdit(opts.before, opts.after)
  if (changed.length === 0) return { action: "allow" }
  const file = changed[0]
  if (testEditGateArmed(opts.sessionID)) {
    return { action: "deny", file, message: testEditDenialMessage(file) }
  }
  if (opts.redToGreen) {
    return { action: "stuck", signal: { reason: "test-edit", signature: file, count: changed.length } }
  }
  return { action: "allow" }
}

export async function callersAtRiskWarning(
  filePath: string,
  oldContent: string | null,
  newContent: string | null,
  graph: EditImpactGraph = getGraph() as unknown as EditImpactGraph,
): Promise<string | null> {
  try {
    const timedOut = Symbol("governance-graph-budget-timeout")
    const budget = new Promise<typeof timedOut>((resolve) =>
      setTimeout(() => resolve(timedOut), GOVERNANCE_GRAPH_BUDGET_MS),
    )
    const result = await Promise.race([
      computeEditImpact(graph, filePath, oldContent, newContent, {
        minCallersToWarn: RSK_CALLER_THRESHOLD,
        includeTests: true,
      }),
      budget,
    ])
    if (result === timedOut) return null
    return renderInlineBlastRadius(result)
  } catch {
    return null
  }
}
