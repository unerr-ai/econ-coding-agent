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
import {
  computeEditImpact,
  renderInlineBlastRadius,
  type EditImpactGraph,
} from "@opencode-ai/code-intelligence"
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
// B3 no-test-edit gate — the blocking half of the governance gate. On a
// fix-shaped turn (defect evidence in the user prompt, no explicit test-work
// authorization) an edit that MODIFIES an existing test file is denied at the
// edit/write tool boundary with the reason surfaced to the model: aligning
// tests to a patch destroys the only oracle that can catch a wrong fix (the
// 11885 self-verification failure; SWE Atlas / SWE-bench validators enforce
// the same rule post-hoc — we enforce it at the chokepoint we own). Creating
// a NEW test file (a repro) stays allowed, as does everything on non-fix
// turns. Armed per session at turn open by prompt.ts; child slice sessions
// inherit the parent's gate unless their own task is test-authoring-shaped.
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
