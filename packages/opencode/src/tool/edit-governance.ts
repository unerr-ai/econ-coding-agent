/**
 * S6.3 in-loop governance gate for the edit/write tools: runs the
 * code-intelligence signature-change detector against the live graph and,
 * when a changed entity's fan-in clears the same chokepoint threshold
 * unerr's own `ur|rsk` signal uses, appends a callers-at-risk warning to the
 * tool's returned output. Non-blocking and fail-open by construction — a
 * cold, slow, or erroring graph simply yields no warning; the edit always
 * lands. Also owns the hub-edit bounce gate: a blocking (but one-time-
 * bounceable) deny for edits that land on a file-level import hub, steering
 * a fix toward the root-most layer instead of the hub every value flows
 * through. Also surfaces coupling=unknown (P6): a non-blocking, once-per-
 * (session, file) warning when the edited file's language has no import
 * resolver, so a zero fan-in/hub score there is never read as evidence of
 * low risk. Also owns the issue-scope boundary (§10 Step 4): a non-blocking
 * nudge, or — behind `ECON_ISSUE_SCOPE_DENY` — a deny, for an edit landing
 * outside the issue's derived scope (issue-scope.ts), the question the
 * hub-edit gate's allow-only allowlist never asks.
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
  detectBreakingChanges,
  renderBreakingChangeWarning,
  extractEntities,
  detectLanguage,
  coverageLanguage,
  couplingConfidence,
  type EditImpactGraph,
  type BreakingChange,
  type EdgeCoverage,
} from "@opencode-ai/code-intelligence"
import type { StuckSignal } from "../../../code-intelligence/src/orchestration-fsm"
import { getGraph, issueSymbolDefinitionSitesIfReady } from "./graph-tools"
import { RSK_CALLER_THRESHOLD } from "./graph-tools-enrich"
import { deriveIssueScope, issueScopeReason, issueScopeDenyEnabled, clearPreExistingFailures } from "./issue-scope"

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
// before (a self-verification failure — editing the test to fit a wrong
// patch; external graders enforce the same rule post-hoc — we enforce it at
// the chokepoint we own). On any other turn this is NOT a blanket ban: a
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

// P3 no-edits gate — the "propose/plan, don't code" constraint (turn-read
// kind "no-edits"), same per-session pattern as the test-edit gate but
// broader: it denies EVERY edit/write for the turn, not just test files.
// Strictly turn-scoped: a fresh turn re-arms from its own constraints and a
// continuation turn disarms it — a follow-up "go ahead" after a plan-only
// turn IS the user lifting the prohibition.
const noEditsGate = new Set<string>()

/** Arm or disarm the no-edits gate for a session — set every turn at turn open (root: from the turn-read's `no-edits` constraint; child: inherited from the parent). */
export function setNoEditsGate(sessionID: string, deny: boolean): void {
  if (deny) noEditsGate.add(sessionID)
  else noEditsGate.delete(sessionID)
}

/** Is the no-edits gate armed for this session? */
export function noEditsGateArmed(sessionID: string): boolean {
  return noEditsGate.has(sessionID)
}

/** The reason string thrown at the edit/write boundary when a plan-only turn tries to mutate a file. */
export function noEditsDenialMessage(relPath: string): string {
  return (
    `Edit denied by the no-edits gate: this turn asked for a proposal/plan only ("don't code" was an explicit constraint), so "${relPath}" must not be modified. ` +
    `Deliver the plan or analysis as text; the user will ask for the implementation when they accept it.`
  )
}

// P11c raw-task hygiene (Q-P) — the raw `task` tool spawns children OUTSIDE
// the slice safety stack (no verifier, no snapshot bracket, no double-pay
// ledger), so it stays a read-only recon lane: every raw task child session
// gets its edit/write surface denied at the tool boundary. Same per-session
// Set pattern as the gates above, but membership is a per-child-session
// CATEGORY (armed once at spawn in tool/task.ts, for the session's lifetime),
// not a per-turn arming — a raw task child never becomes edit-capable on a
// later turn. Edit-capable delegation routes through slice dispatch instead:
// the conductor types todowrite slices; a reasoner/oracle seat uses the
// `delegate` tool. Slice-dispatched children never pass through task.ts, so
// they are never gated here.
const rawTaskChildGate = new Set<string>()

/** Arm the raw-task-child edit gate for a child session — called at spawn (and resume) in tool/task.ts. */
export function setRawTaskChildGate(sessionID: string): void {
  rawTaskChildGate.add(sessionID)
}

/** Is this session a raw task-tool child (read-only recon lane)? */
export function rawTaskChildGateArmed(sessionID: string): boolean {
  return rawTaskChildGate.has(sessionID)
}

/** Test seam: clear a session's raw-task-child membership. */
export function clearRawTaskChildGate(sessionID: string): void {
  rawTaskChildGate.delete(sessionID)
}

/** The reason string thrown at the edit/write boundary when a raw task child tries to mutate a file. */
export function rawTaskChildDenialMessage(relPath: string): string {
  return (
    `Edit denied: this session is a raw task-tool child, a read-only recon lane — "${relPath}" must not be modified. ` +
    `Raw task children run outside the verified slice pipeline (no verification ladder, no snapshot containment, no cost ledger), so their edits cannot be trusted or contained. ` +
    `Report the exact change needed (file, location, new code) in your digest instead; the parent routes edit work through verified slice dispatch.`
  )
}

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
    `Writing a NEW test file that reproduces the reported defect is allowed. ` +
    `Author a NEW scratch repro file instead (e.g. \`repro_issue.py\` at the repo root) and run it — new files are allowed; editing the committed suite is not.`
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

// ---------------------------------------------------------------------------
// G3 — post-edit breaking-change scan. callersAtRiskWarning above catches a
// signature change while the edit is IN FLIGHT via a regex diff of raw old/
// new content; it can't see a full removal (there's no "changed" fragment
// left to diff against). breakingChangeWarning runs AFTER the edit lands,
// diffing the graph's pre-edit entity list against a fresh single-file
// re-parse of the new content, and adds a bounded git-grep word-boundary
// pass for a removed/renamed name's residue outside the call graph (a
// string, a config key, a dynamic-dispatch site). Same shape as
// callersAtRiskWarning: convert-only (never blocks), fail-closed on any
// graph/parse/git failure, bounded by the same governance graph budget.
// ---------------------------------------------------------------------------

/** Max repo-wide text-occurrence sites listed per removed/renamed entity. */
const MAX_BREAKING_TEXT_OCCURRENCES = 5

/**
 * Bounded word-boundary literal search for `name` across git-tracked files
 * via `git grep -w -F`, scoped to `worktree` with a `.`-relative pathspec so
 * the same call scans "the whole repo" in production (worktree = repo root)
 * and "just this fixture" in a test (worktree = a fixture subdir) — the same
 * git-scoped-not-full-fs-walk approach snapshotTestTree uses above, so
 * node_modules/dist/.git never get walked. Never throws: a missing git
 * binary, a non-repo cwd, a timeout, or zero matches all resolve to [].
 */
function textOccurrencesOutsideGraph(
  worktree: string,
  name: string,
  skipFile: string,
): Array<{ file: string; line: number }> {
  try {
    const raw = execSync(`git grep -n -w -I -F -e ${JSON.stringify(name)} -- .`, {
      cwd: worktree,
      encoding: "utf8",
      timeout: 500,
    })
    const hits: Array<{ file: string; line: number }> = []
    for (const row of raw.split("\n")) {
      if (!row) continue
      const m = /^(.+?):(\d+):/.exec(row)
      if (!m) continue
      const file = m[1]!
      if (file === skipFile) continue
      hits.push({ file, line: Number(m[2]) })
      if (hits.length >= MAX_BREAKING_TEXT_OCCURRENCES) break
    }
    return hits
  } catch {
    return []
  }
}

/**
 * Evaluate a just-landed edit for a removed or signature-changed exported
 * entity that live callers outside the file still reference, and return an
 * inline `ur|brk`-style warning, or null when there's nothing to surface (no
 * breaking change, zero outside callers, a test file, a brand-new file, an
 * unsupported language, or the graph/git is cold/unavailable). Never throws
 * and never blocks past its graph budget — callers append the result
 * directly to a tool's output string, same as callersAtRiskWarning.
 *
 * @sem domain=intelligence role=analysis
 */
export async function breakingChangeWarning(
  filePath: string,
  oldContent: string | null,
  newContent: string | null,
  graph: EditImpactGraph = getGraph() as unknown as EditImpactGraph,
  worktree: string = process.cwd(),
): Promise<string | null> {
  if (!oldContent || !newContent) return null // new file, or nothing pre-existing to break
  if (isTestFilePath(filePath)) return null
  if (!detectLanguage(filePath)) return null

  try {
    const timedOut = Symbol("governance-breaking-change-budget-timeout")
    const budget = new Promise<typeof timedOut>((resolve) =>
      setTimeout(() => resolve(timedOut), GOVERNANCE_GRAPH_BUDGET_MS),
    )
    const result = await Promise.race([
      (async (): Promise<string | null> => {
        const preEntities = await graph.getEntitiesInFile(filePath)
        if (preEntities.length === 0) return null // cold/unindexed file — fail closed

        const postEntities = extractEntities(newContent, filePath)
        const changes: BreakingChange[] = await detectBreakingChanges(
          graph,
          oldContent,
          preEntities,
          postEntities,
        )
        if (changes.length === 0) return null

        for (const change of changes) {
          if (change.change_type !== "removed") continue
          const occurrences = textOccurrencesOutsideGraph(worktree, change.entity_name, change.entity_file)
          if (occurrences.length > 0) change.text_occurrences = occurrences
        }

        return renderBreakingChangeWarning(changes)
      })(),
      budget,
    ])
    if (result === timedOut) return null
    return result
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Hub-edit bounce gate — edits landing on a file the graph shows is one of
// the repo's most-imported modules get bounced ONCE, steering the model to
// re-check whether the behavior belongs at the root-most layer (the module
// that DEFINES the thing) instead of a hub every value flows through. The
// bounce is one-time per (session, file): recording the file in the bounced
// set BEFORE returning the deny means an identical retry — the model
// re-issuing the exact same edit after re-checking — passes. Same per-
// session Set arming pattern as testEditGate/noEditsGate above, armed at
// turn open in prompt.ts's root-arming block.
// ---------------------------------------------------------------------------

/** How many distinct importer files make a python/ts/js file a "hub" the bounce gate fires on — see docs/architecture measurement (django: base.py=3, fields/__init__.py=18, enums.py=1). */
const HUB_IMPORTER_THRESHOLD = 3

/**
 * Wave 8c — among the defining modules an issue names, the root-most
 * (least-imported) band is the plausible fix layer; a co-named module
 * several times more central is infrastructure the issue merely mentions
 * (e.g. a repro model's `CharField` resolves to
 * django/db/models/fields/__init__.py, fanIn 26, alongside `TextChoices` →
 * enums.py, fanIn 1 — only enums.py is the root-most fix layer). Measured
 * floor across the 5 probe instances: pollutant sites are always ≥3.7× the
 * minimum resolved fan-in, and the gold fix site is always the minimum
 * itself — see `bandFilterDefiningSites`.
 */
const DEFINING_SITE_ROOTMOST_BAND = 3

const hubEditGate = new Set<string>()

/** Per-session set of file paths already bounced once — an identical retry on the same file passes. */
const hubEditBounced = new Map<string, Set<string>>()

/** Round-F §7 sibling store to `hubEditBounced`: per-session set of file paths already bounced a SECOND time (the evidence-bearing rung — a retry landing outside a non-empty resolved defining-site allowlist) — a further identical retry on the same file passes (fail-open, bounded to at most 2 denies per file). Same lifecycle as `hubEditBounced` — not cleared on disarm. */
const hubEditSecondBounced = new Map<string, Set<string>>()

/** Per-session set of graph-reported defining-module paths for the symbols the issue names (from `issueSymbolDefinitionSites`/`issueSymbolDefinitionSitesIfReady`, resolved either at arming time — a child inheriting an already-resolved parent, or a test — or lazily at first gate evaluation, see `evaluateHubEditGate`) — an edit landing on one of these is the redirect doctrine's own answer, so `evaluateHubEditGate` allows it even over the fan-in threshold. Cleared whenever the gate disarms. */
const hubEditDefiningFilesStore = new Map<string, Set<string>>()

/** Per-session stored turn issue text — set alongside arming (root turn-open, or a child inheriting an unresolved parent's text) so `evaluateHubEditGate`'s lazy resolver has something to resolve once the graph has had a chance to warm. Cleared on disarm. */
const hubEditIssueTextStore = new Map<string, string>()

/** Session IDs whose defining-file allowlist resolution has completed — either supplied directly at arming time or resolved lazily by `evaluateHubEditGate`. Once a session is in this set the resolver is never called again for it (memoized). Cleared on disarm. Kept private — read through `hubEditDefiningResolved` so the accessor name doesn't collide with the Set itself. */
const hubEditDefiningResolvedSet = new Set<string>()

/** Wave 9 — session IDs whose retry of a bounced edit landed on a path outside the resolved defining-file allowlist: the denial message named the graph's candidates and the model re-issued the same edit against a different, non-candidate file anyway (a bounced query_utils.py case: denial named enums.py, conductor re-issued query_utils.py). Read through `hubEditRetriedAgainstCandidates`. Cleared on disarm. */
const hubEditRetryAgainstCandidatesSet = new Set<string>()

/**
 * Wave 12 — cross-session (per-turn) bounce counter: how many bounce
 * "rungs" file F has accumulated ACROSS THE WHOLE TURN, not just this
 * session — 0 unset, 1 after the turn's first-ever bounce (wherever it
 * happened), 2 after a later session's cheap repeat bounce. Seeded into a
 * child session at arming time from its parent's own count
 * (`inheritHubEditTurnBounceState`), so a hard-tail escalation spawning a
 * fresh session mid-turn doesn't reset a hub file's bounce history to zero
 * — on 2026-07-15, 2 sessions each independently
 * ran the full first-bounce/second-bounce cycle on the SAME file
 * (serializer.py), 4 bounce events total for one file in one turn, and the
 * escalation session's pair never reached the hub-design judge at all
 * (prompt.ts's wave-7 trigger only fires for a root session). Independent
 * of `hubEditBounced`/`hubEditSecondBounced`, which continue to govern
 * same-session repeats exactly as before. Same lifecycle as those two —
 * not cleared on disarm.
 */
const hubEditTurnBounceCount = new Map<string, Map<string, number>>()

/**
 * Wave 12 — per-session set of files whose turn-wide bounce budget is
 * exhausted: the hub-design judge has already given its final word on this
 * file this turn (an exhausted-allow or the one final redirect bounce) —
 * never re-litigated again by this session. Same lifecycle as
 * `hubEditTurnBounceCount` — not cleared on disarm.
 */
const hubEditTurnSettled = new Map<string, Set<string>>()

/**
 * Wave 12 — bumps file F's turn-wide bounce count for `sessionID` by one
 * and returns the new count. Internal bookkeeping only, called both by the
 * classic first-bounce path (bumps 0→1) and by the cross-session repeat
 * rung below (bumps 1→2) — never observable in a return value, so it never
 * changes what either of those paths returns.
 */
function bumpHubEditTurnBounceCount(sessionID: string, filePath: string): number {
  if (!hubEditTurnBounceCount.has(sessionID)) hubEditTurnBounceCount.set(sessionID, new Map())
  const perFile = hubEditTurnBounceCount.get(sessionID)!
  const next = (perFile.get(filePath) ?? 0) + 1
  perFile.set(filePath, next)
  return next
}

/**
 * Wave 12 — the session's per-file turn-wide bounce counts, snapshotted for
 * cross-session inheritance (read by prompt.ts's child-inherit arming call
 * alongside the existing defining-files inherit). Empty for a session with
 * no turn-wide bounce history recorded.
 */
export function hubEditTurnBounceSnapshot(sessionID: string): ReadonlyMap<string, number> {
  return new Map(hubEditTurnBounceCount.get(sessionID) ?? [])
}

/**
 * Wave 12 — seeds a child session's per-file turn-wide bounce memory (and
 * judge-settled set) from its parent's, at the same child-inherit point
 * `setHubEditGate`'s `definingFiles` argument already uses — so a hard-tail
 * escalation slice spawned mid-turn continues a hub file's bounce history
 * instead of resetting it to zero. A parent with no turn-wide history is a
 * no-op (the child starts fresh, exactly like today).
 */
export function inheritHubEditTurnBounceState(childSessionID: string, parentSessionID: string): void {
  const parentCounts = hubEditTurnBounceCount.get(parentSessionID)
  if (parentCounts && parentCounts.size > 0) {
    hubEditTurnBounceCount.set(childSessionID, new Map(parentCounts))
  }
  const parentSettled = hubEditTurnSettled.get(parentSessionID)
  if (parentSettled && parentSettled.size > 0) {
    hubEditTurnSettled.set(childSessionID, new Set(parentSettled))
  }
}

/** The session's bounced file set as an array (insertion order) — empty for an unknown or never-bounced session. Read by prompt.ts's hub-shopping trigger to detect a second DISTINCT bounced file in one turn (the tell that the model is moving the same fix to another hub instead of reconsidering where it belongs). */
export function hubEditBouncedFiles(sessionID: string): string[] {
  return Array.from(hubEditBounced.get(sessionID) ?? [])
}

/**
 * Arm or disarm the hub-edit bounce gate for a session — set once per turn
 * at turn open (root sessions decide unconditionally; child sessions
 * inherit). Arming WITH `definingFiles` (a child inheriting an
 * already-resolved parent, or a test) replaces the stored allowlist
 * wholesale and marks the session resolved immediately. Arming WITHOUT it
 * (the common root-turn-open case now that resolution is lazy — see
 * `evaluateHubEditGate`) starts the session with an empty allowlist and
 * leaves it UNRESOLVED, so the first gate evaluation attempts the real
 * resolution once the graph has had a chance to warm. Disarming clears the
 * allowlist, the stored issue text, and the resolved flag. Path shape is
 * whatever the caller passes as-is — matching against an edit's absolute
 * filePath happens later, in `evaluateHubEditGate`, via `pathsRefer`.
 */
export function setHubEditGate(sessionID: string, armed: boolean, definingFiles?: readonly string[]): void {
  if (armed) {
    hubEditGate.add(sessionID)
    if (definingFiles !== undefined) {
      hubEditDefiningFilesStore.set(sessionID, new Set(definingFiles))
      hubEditDefiningResolvedSet.add(sessionID)
    } else {
      hubEditDefiningFilesStore.set(sessionID, new Set())
      hubEditDefiningResolvedSet.delete(sessionID)
    }
  } else {
    hubEditGate.delete(sessionID)
    hubEditDefiningFilesStore.delete(sessionID)
    hubEditIssueTextStore.delete(sessionID)
    hubEditDefiningResolvedSet.delete(sessionID)
    hubEditRetryAgainstCandidatesSet.delete(sessionID)
    clearIssueScopeState(sessionID)
    clearPreExistingFailures(sessionID)
  }
}

/** Is the hub-edit bounce gate armed for this session? */
export function hubEditGateArmed(sessionID: string): boolean {
  return hubEditGate.has(sessionID)
}

/** The session's stored defining-file allowlist (insertion order) — empty for a session with none recorded. Read by prompt.ts's child-inherit arming call so a dispatched slice gets the same redirect-doctrine bypass the root turn computed (or resolved) already has. */
export function hubEditDefiningFiles(sessionID: string): string[] {
  return Array.from(hubEditDefiningFilesStore.get(sessionID) ?? [])
}

/** Store the session's turn issue text for the hub-edit gate's lazy defining-file resolution — set alongside `setHubEditGate` at arming time (root turn-open) or inherited by a child from its parent's stored text when the parent hasn't resolved yet. */
export function setHubEditIssueText(sessionID: string, issueText: string): void {
  hubEditIssueTextStore.set(sessionID, issueText)
}

/** The session's stored turn issue text, if any — read by `evaluateHubEditGate`'s lazy resolver and by prompt.ts's child-inherit arming call. */
export function hubEditIssueText(sessionID: string): string | undefined {
  return hubEditIssueTextStore.get(sessionID)
}

/** Has the session's defining-file allowlist resolution completed — either supplied at arming time or resolved lazily by `evaluateHubEditGate`? Memoization guard: once true, the resolver is never called again for this session this turn. */
export function hubEditDefiningResolved(sessionID: string): boolean {
  return hubEditDefiningResolvedSet.has(sessionID)
}

/** Wave 9 — has this session re-issued a bounced edit against a file that is NOT one of the graph's named defining candidates? A retry against a non-candidate is itself the hub-shopping tell (a conductor re-issuing its bounced edit rather than moving to the denial message's named candidate). Read by prompt.ts's hub-shopping trigger as an alternate fire condition alongside the 2-distinct-bounced-files check. */
export function hubEditRetriedAgainstCandidates(sessionID: string): boolean {
  return hubEditRetryAgainstCandidatesSet.has(sessionID)
}

/** The reason string thrown at the edit/write boundary when the hub-edit gate bounces a first edit to an over-threshold file. When `rootMostCandidates` is non-empty (Wave 8d) the message names the resolved defining-site candidates to check first — framed as candidates, not a verdict, since the graph resolves symbol NAMES and cannot see whether the issue's BEHAVIOR is actually implemented at this hub file (round-F: the gate had bounced the correct fix site and the old wording told the model the candidates WERE the root-most site, actively misdirecting it). */
export function hubEditDenialMessage(relPath: string, importers: number, rootMostCandidates: readonly string[] = []): string {
  const base =
    `${importers} other modules import ${relPath} directly — it is shared infrastructure. ` +
    `A behavior fix belongs at the root-most layer: the module that DEFINES the class or function the issue names, not a shared file every consumer flows through. ` +
    `Re-check where that behavior is defined and prefer fixing there. ` +
    `Moving the same change to a DIFFERENT shared file is not the fix — the defining module is. ` +
    `If this hub file genuinely is the root-most layer, re-issue this exact edit and it will be allowed.`
  if (rootMostCandidates.length === 0) return base
  return (
    base +
    ` Per the code graph, the symbols this issue names are DEFINED in: ${rootMostCandidates.join(", ")} — check those candidates first. But note the graph resolves symbol NAMES, not behavior: if the BEHAVIOR the issue describes is implemented in ${relPath} itself (not merely passing through it), then ${relPath} IS the root-most layer — re-issue this exact edit and it will be allowed.`
  )
}

/** Round-F §7 — the reason string thrown when the hub-edit gate denies a SECOND time: a bounced-retry landed on a file outside a non-empty resolved defining-site allowlist, so the model was shown the graph's named candidates and re-issued a non-candidate edit anyway. Names the defining-site candidates concretely and states the fail-open floor: a re-issue naming the concrete evidence that the behavior lives in `relPath` itself is allowed — the candidates are symbol-name hits, not a behavior verdict (round-F). */
export function hubEditSecondDenialMessage(relPath: string, definingSites: readonly string[]): string {
  return (
    `This is the second time this edit has landed on ${relPath}, which is not one of the SYMBOL-definition sites the code graph resolved for this issue: ${definingSites.join(", ")}. ` +
    `Prefer one of those candidates — but the graph resolves symbol names, not behavior. If the behavior the issue describes is implemented in ${relPath} itself, ${relPath} is the correct root-most site: re-issue this exact edit once more, stating that evidence, and it will be allowed.`
  )
}

/** Narrow graph surface the hub-edit gate needs — BunSqliteGraph satisfies it structurally; tests pass a synthetic fake (including one whose fileFanIn never resolves, to exercise the budget race). */
export interface HubFanInGraph {
  fileFanIn(filePath: string): number | Promise<number>
}

// ---------------------------------------------------------------------------
// P6 — coupling=unknown surface. computeRisk's fan-in/blast-radius factors
// (and this same gate's own fileFanIn check above) read exactly 0 for a
// language with no import resolver (Go/Java/Rust/C/C++, docs/design/
// agnostic-hands-eyes.md §7.1) — indistinguishable from a genuinely safe
// edit. Per the §2.7 no-advisory invariant this must surface, not just log:
// a non-blocking, once-per-(session,file) inline `ur|rsk` line stating that
// blast radius isn't measurable for this language, so breadth must be
// verified directly. Never denies — the same fail-open shape as
// callersAtRiskWarning/breakingChangeWarning above.
// ---------------------------------------------------------------------------

/** Narrow graph surface the coupling-unknown warning needs — BunSqliteGraph satisfies it structurally. */
export interface CouplingCoverageGraph {
  edgeCoverage(): EdgeCoverage
}

/** Per-session set of file paths already warned about unknown coupling this turn — fires at most once per file. */
const couplingUnknownWarned = new Map<string, Set<string>>()

/**
 * Evaluate an in-flight edit for coupling=unknown — no import resolver
 * exists for filePath's language, or (interim, P6 §7.1) the language has
 * files but zero import edges extracted at all — and return an inline
 * `ur|rsk`-style warning, or null when there's nothing to surface: this
 * (session, file) pair already warned this turn, the graph is cold/unindexed
 * (fail open — same as every other gate here), filePath maps to the `other`
 * bucket (unrecognized extension — markdown/config/etc. must never warn), or
 * couplingConfidence reads the language's coverage row as "measured". Never
 * throws.
 *
 * @sem domain=intelligence role=analysis
 */
export function couplingUnknownWarning(
  sessionID: string,
  filePath: string,
  graph: CouplingCoverageGraph = getGraph() as unknown as CouplingCoverageGraph,
): string | null {
  if (couplingUnknownWarned.get(sessionID)?.has(filePath)) return null

  try {
    const coverage = graph.edgeCoverage()
    // Every language bucket absent → the graph itself hasn't indexed
    // anything yet (cold), not evidence this specific language is
    // unresolved — fail open exactly like a cold fileFanIn/getEntitiesInFile.
    if (Object.keys(coverage).length === 0) return null

    const language = coverageLanguage(filePath)
    // `other` covers unrecognized extensions (markdown, config, JSON, etc.)
    // — never code, so the zero-imports-extracted signal below is noise for
    // it, not a resolver gap. Skip here rather than teach the pure
    // couplingConfidence helper about bucket names.
    if (language === "other") return null
    if (couplingConfidence(coverage[language]) !== "unknown") return null

    if (!couplingUnknownWarned.has(sessionID)) couplingUnknownWarned.set(sessionID, new Set())
    couplingUnknownWarned.get(sessionID)!.add(filePath)

    return (
      `ur|rsk coupling unknown for ${language} — no import resolver exists for this language, so ` +
      `fan-in/blast-radius read 0 by construction and are NOT evidence this edit is low-risk; ` +
      `verify callers directly (grep or get_references) before treating a low hub-gate/risk score as safe.`
    )
  } catch {
    return null
  }
}

/**
 * Wave 12 — the narrow shape `evaluateHubEditGate` needs from the
 * hub-design judge's verdict (structurally compatible with
 * `session/hub-design-judge.ts`'s `HubDesignVerdict` — this module never
 * imports it, to keep the tool→session import direction one-way).
 */
export interface HubEditJudgeVerdict {
  readonly file: string
  readonly entity: string
  readonly change: string
}

/**
 * Wave 12 — the cheap, cached deny for a file's SECOND evidence-less bounce
 * THIS TURN, reached in a session that has never itself denied this file
 * (a later session continuing a turn a prior session already bounced this
 * file in). One line, never a re-litigation of the root-most-layer case —
 * that argument was already made once this turn.
 */
export function hubEditRepeatBounceMessage(relPath: string): string {
  return `${relPath} was already bounced once this turn as shared infrastructure — re-issuing the same edit without new evidence will not change that. If ${relPath} itself defines the behavior, state that evidence; otherwise fix the root-most layer instead.`
}

/**
 * Wave 12 — the final word after the hub-design judge settles a file's
 * THIRD evidence-less bounce this turn with a redirect verdict: names the
 * judge's chosen file/entity and change, and states this is the turn's
 * last bounce on `relPath` — bounded, never a wedge (a further retry
 * allows).
 */
export function hubEditJudgeRedirectMessage(relPath: string, verdict: HubEditJudgeVerdict): string {
  return `The hub-design judge reviewed ${relPath} against this turn's issue and named the root-most fix site as ${verdict.file} (${verdict.entity}): ${verdict.change}. This is the final word on ${relPath} this turn — edit ${verdict.file} instead.`
}

/**
 * True when `a` and `b` refer to the same file, tolerating an absolute vs.
 * repo-relative path shape mismatch (the graph's `issueSymbolDefinitionSites`
 * returns repo-relative paths — `BunSqliteGraph.search` normalizes via
 * `relative(root, ...)` — while `evaluateHubEditGate` receives an absolute
 * `filePath` from edit.ts/write.ts). Exact match, or one string is a
 * path-boundary suffix of the other (the character before the suffix start
 * must be `/`) — so `"forms.py"` never falsely matches `"userforms.py"`.
 */
export function pathsRefer(a: string, b: string): boolean {
  if (a === b) return true
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a]
  if (shorter.length === 0 || !longer.endsWith(shorter)) return false
  const boundaryIndex = longer.length - shorter.length
  return boundaryIndex === 0 || longer[boundaryIndex - 1] === "/"
}

/**
 * Wave 8c — narrows a resolver's defining-site list down to the root-most
 * band: the plausible fix layer among modules the issue text names, instead
 * of every incidental symbol it happens to mention. `kind: "file"` sites (an
 * explicit filename the issue text literally names) are the strongest
 * evidence available — always kept, and excluded from the band computation.
 * For the rest, deduped by file, `fanInOf` supplies each file's import
 * count; a file whose `fanInOf` throws is treated as kept and excluded from
 * the min computation (fail-open, consistent with the gate's philosophy:
 * graph trouble must never block). With no computable fan-ins, everything is
 * kept. Otherwise a file survives when its fan-in is at most
 * `DEFINING_SITE_ROOTMOST_BAND` times the minimum resolved fan-in. Returns
 * the kept files, file-kind sites first, insertion order preserved, deduped.
 *
 * @sem domain=intelligence role=analysis
 */
export async function bandFilterDefiningSites(
  sites: ReadonlyArray<{ file: string; kind?: string }>,
  fanInOf: (file: string) => number | Promise<number>,
): Promise<string[]> {
  const fileKindSites: string[] = []
  const seenFileKind = new Set<string>()
  const rest: string[] = []
  const seenRest = new Set<string>()

  for (const site of sites) {
    if (site.kind === "file") {
      if (!seenFileKind.has(site.file)) {
        seenFileKind.add(site.file)
        fileKindSites.push(site.file)
      }
    } else if (!seenFileKind.has(site.file) && !seenRest.has(site.file)) {
      seenRest.add(site.file)
      rest.push(site.file)
    }
  }

  const fanIns = new Map<string, number>()
  for (const file of rest) {
    try {
      fanIns.set(file, await fanInOf(file))
    } catch {
      // Fail open: an unresolvable fan-in never excludes a file, and never
      // participates in the min computation below.
    }
  }

  if (fanIns.size === 0) return [...fileKindSites, ...rest]

  const min = Math.min(...Array.from(fanIns.values()))
  const kept = rest.filter((file) => {
    const fanIn = fanIns.get(file)
    return fanIn === undefined || fanIn <= min * DEFINING_SITE_ROOTMOST_BAND
  })

  return [...fileKindSites, ...kept]
}

/**
 * The hub-edit bounce gate's ONE decision point. Not armed or a test file →
 * allow. Before consulting the defining-file allowlist: an unresolved
 * session with stored issue text gets one lazy resolution attempt here (via
 * `resolveDefiningSites`, default `issueSymbolDefinitionSitesIfReady`),
 * raced against `GOVERNANCE_GRAPH_BUDGET_MS` — turn-open used to compute the
 * allowlist eagerly against a cold graph (initial index ~12s on a fresh
 * checkout vs. the old 3s probe budget) and it always resolved empty, so
 * resolution now happens here instead, lazily, once the graph has had a
 * chance to warm across the turn; a null/timeout/throw leaves the session
 * unresolved so the NEXT evaluation retries, a non-null result passes
 * through `bandFilterDefiningSites` (Wave 8c) before it replaces the stored
 * allowlist and marks the session resolved (memoized — never re-resolved
 * after that), so an incidental high-centrality symbol the issue merely
 * mentions doesn't itself grant a hub bypass — only the root-most band does.
 * A file matching the allowlist → allow with `definingSite: true` — the
 * redirect doctrine's own answer, never bounced regardless of fan-in; a file
 * already bounced this session → allow with `retried: true` so the call
 * site can log the pass-through distinctly from a fresh allow. Otherwise
 * races the graph's fileFanIn against the same budget (same fail-open
 * pattern as callersAtRiskWarning: timeout/throw/cold graph → allow, never
 * block on a cold graph); a fan-in clearing HUB_IMPORTER_THRESHOLD records
 * the file as bounced (so an identical retry passes) and denies with the
 * root-most-layer redirect message, enumerating the session's resolved
 * defining-file allowlist in that message when one exists (Wave 8d) so the
 * model gets concrete candidates instead of having to re-derive them. Wave
 * 9: when that bounced-retry lands against a non-empty allowlist, the
 * filePath already failed the allowlist match above — so the model saw the
 * named candidates and re-issued a non-candidate edit anyway; that session
 * is flagged via `hubEditRetriedAgainstCandidates`, the same hub-shopping
 * tell prompt.ts's trigger otherwise needs a second distinct bounced file to
 * see. Round F §7 adds one more evidence-bearing rung on THAT SAME
 * bounced-retry: a non-empty resolved allowlist is graph evidence the model
 * was shown and ignored, so — once per (session, file) — this denies a
 * SECOND time (`second: true`, naming the defining sites) instead of
 * allowing; a further identical retry on that file then passes
 * (`hubEditSecondBounced`, fail-open, mirrors `hubEditBounced`'s own
 * lifecycle). An EMPTY allowlist still allows on retry exactly as before
 * round F — there is no graph evidence to hold the model to. Logging-free by
 * design — edit.ts/write.ts log at the call site, inside their own Effect.
 * Wave 12 — all of the above governs a SINGLE session's own repeats and is
 * unchanged; layered in front of it (after the defining-site allowlist
 * check, before the per-session `bounced` check) is per-file PER-TURN
 * memory: when this session has never itself bounced `filePath` but an
 * earlier session THIS TURN already has (inherited via
 * `inheritHubEditTurnBounceState`, seeded by prompt.ts's child-inherit
 * arming call), a fresh first-bounce cycle is skipped — the turn's 2nd
 * evidence-less attempt gets a cheap cached repeat deny (`repeat: true`,
 * `hubEditRepeatBounceMessage`) instead of re-litigating, and the turn's
 * 3rd evidence-less attempt auto-dispatches the injected
 * `dispatchHubDesignJudge` (the wave-7 machinery, routed here rather than
 * called fresh) to settle root-most vs not: an endorsing or
 * degraded/unavailable verdict allows loud (`exhausted: true`, the call
 * site logs `hub_gate_exhausted_allow`); a redirecting verdict is one final
 * bounce (`final: true`) naming it, after which the file is turn-settled
 * and every further attempt allows (bounded fail-open, never a wedge).
 *
 * @sem domain=intelligence role=analysis
 */
async function evaluateHubEditGateCore(opts: {
  sessionID: string
  filePath: string
  graph?: HubFanInGraph
  resolveDefiningSites?: (issueText: string) => Promise<Array<{ file: string; kind?: string }> | null>
  dispatchHubDesignJudge?: (opts: {
    sessionID: string
    filePath: string
  }) => Promise<HubEditJudgeVerdict | undefined>
}): Promise<
  | { action: "allow"; retried?: boolean; definingSite?: boolean; exhausted?: boolean }
  | {
      action: "deny"
      message: string
      importers?: number
      second?: boolean
      definingSites?: string[]
      repeat?: boolean
      final?: boolean
    }
> {
  if (!hubEditGateArmed(opts.sessionID)) return { action: "allow" }
  if (isTestFilePath(opts.filePath)) return { action: "allow" }

  // Hoisted once so both the lazy defining-site resolution below and the
  // fan-in check further down share the same graph handle. getGraph() can
  // throw (cold/unavailable graph) — caught here so it never escapes
  // uncaught; a throw leaves `graph` undefined and both downstream uses
  // fail open through their own try/catch when they dereference it.
  let graph: HubFanInGraph | undefined
  try {
    graph = opts.graph ?? (getGraph() as unknown as HubFanInGraph)
  } catch {
    // graph stays undefined — downstream sections fail open.
  }

  if (!hubEditDefiningResolved(opts.sessionID)) {
    const issueText = hubEditIssueTextStore.get(opts.sessionID)
    if (issueText !== undefined) {
      const resolveDefiningSites = opts.resolveDefiningSites ?? issueSymbolDefinitionSitesIfReady
      try {
        const timedOut = Symbol("hub-edit-defining-resolve-budget-timeout")
        const budget = new Promise<typeof timedOut>((resolveBudget) =>
          setTimeout(() => resolveBudget(timedOut), GOVERNANCE_GRAPH_BUDGET_MS),
        )
        const resolveAndFilter = async () => {
          const sites = await resolveDefiningSites(issueText)
          if (sites === null) return null
          return bandFilterDefiningSites(sites, (file) => graph!.fileFanIn(file))
        }
        const result = await Promise.race([resolveAndFilter(), budget])
        if (result !== timedOut && result !== null) {
          hubEditDefiningFilesStore.set(opts.sessionID, new Set(result))
          hubEditDefiningResolvedSet.add(opts.sessionID)
        }
      } catch {
        // Leave unresolved — the graph is likely still cold; the next
        // evaluation this turn retries once it's had more time to warm.
      }
    }
  }

  const definingFiles = hubEditDefiningFilesStore.get(opts.sessionID)
  if (definingFiles) {
    for (const f of definingFiles) {
      if (pathsRefer(opts.filePath, f)) return { action: "allow", definingSite: true }
    }
  }

  // Wave 12 — per-file per-turn bounce memory. Only relevant when THIS
  // session has never itself bounced filePath (a same-session repeat keeps
  // using the unchanged per-session state machine below) AND the turn
  // already carries bounce history for it (inherited from an ancestor
  // session — see inheritHubEditTurnBounceState). A turn-count of 0 means
  // this is genuinely the turn's first-ever look at filePath, so control
  // falls through to the existing first-bounce path unchanged.
  if (!hubEditBounced.get(opts.sessionID)?.has(opts.filePath)) {
    if (hubEditTurnSettled.get(opts.sessionID)?.has(opts.filePath)) {
      // The judge already gave this file its final word this turn — never
      // re-litigate; bounded fail-open.
      return { action: "allow", exhausted: true }
    }
    const turnCount = hubEditTurnBounceCount.get(opts.sessionID)?.get(opts.filePath) ?? 0
    if (turnCount === 1) {
      // 2nd evidence-less attempt at filePath this turn — a cheap cached
      // repeat, not a fresh re-litigation. Deliberately does NOT touch this
      // session's own `hubEditBounced` set — that would reroute a further
      // look at this file into the OLD per-session evidence-hatch instead
      // of this turn-level progression, so the 3rd evidence-less attempt
      // (below) would never be reached.
      bumpHubEditTurnBounceCount(opts.sessionID, opts.filePath)
      return { action: "deny", repeat: true, message: hubEditRepeatBounceMessage(opts.filePath) }
    }
    if (turnCount >= 2) {
      // 3rd evidence-less attempt at filePath this turn — settle it with
      // the hub-design judge instead of bouncing forever. No injected
      // judge (the common case today — no live wiring at the edit/write
      // call sites yet) degrades exactly like a thrown/empty judge call.
      let verdict: HubEditJudgeVerdict | undefined
      try {
        verdict = opts.dispatchHubDesignJudge
          ? await opts.dispatchHubDesignJudge({ sessionID: opts.sessionID, filePath: opts.filePath })
          : undefined
      } catch {
        verdict = undefined
      }
      if (!hubEditTurnSettled.has(opts.sessionID)) hubEditTurnSettled.set(opts.sessionID, new Set())
      hubEditTurnSettled.get(opts.sessionID)!.add(opts.filePath)
      if (!verdict || verdict.file === "" || pathsRefer(opts.filePath, verdict.file)) {
        // Degraded/unavailable, or the judge itself endorses filePath as
        // root-most — allow loud (the call site logs hub_gate_exhausted_allow).
        return { action: "allow", exhausted: true }
      }
      return { action: "deny", final: true, message: hubEditJudgeRedirectMessage(opts.filePath, verdict) }
    }
  }

  const bounced = hubEditBounced.get(opts.sessionID)
  if (bounced?.has(opts.filePath)) {
    // Wave 9: the loop above already ruled out a match against the resolved
    // defining-file allowlist (a match returns earlier with definingSite:
    // true), so reaching here with a non-empty allowlist means the model was
    // shown the graph's named candidates in the denial message and
    // re-issued this exact non-candidate edit anyway — flag it as the same
    // hub-shopping tell prompt.ts's 2-distinct-bounced-files trigger looks
    // for, one bounce earlier.
    if (definingFiles && definingFiles.size > 0) {
      hubEditRetryAgainstCandidatesSet.add(opts.sessionID)

      // Round F §7 — the non-empty allowlist above IS the evidence: deny a
      // SECOND time, once per (session, file); a further identical retry on
      // this same file then passes (fail-open).
      const secondBounced = hubEditSecondBounced.get(opts.sessionID)
      if (secondBounced?.has(opts.filePath)) {
        return { action: "allow", retried: true }
      }
      if (!hubEditSecondBounced.has(opts.sessionID)) hubEditSecondBounced.set(opts.sessionID, new Set())
      hubEditSecondBounced.get(opts.sessionID)!.add(opts.filePath)
      // Wave 12 — keeps the turn-wide counter in step with this
      // session-local second bounce, so a child inheriting this session's
      // state later sees turnCount 2 (routes straight to the judge rung)
      // rather than 1 (one more cached-repeat rung it already had).
      // Bookkeeping only — never changes what this branch returns.
      bumpHubEditTurnBounceCount(opts.sessionID, opts.filePath)
      const resolvedDefiningSites = hubEditDefiningFiles(opts.sessionID)
      return {
        action: "deny",
        second: true,
        definingSites: resolvedDefiningSites,
        message: hubEditSecondDenialMessage(opts.filePath, resolvedDefiningSites),
      }
    }
    return { action: "allow", retried: true }
  }

  try {
    const timedOut = Symbol("hub-edit-gate-budget-timeout")
    const budget = new Promise<typeof timedOut>((resolve) =>
      setTimeout(() => resolve(timedOut), GOVERNANCE_GRAPH_BUDGET_MS),
    )
    const result = await Promise.race([Promise.resolve(graph!.fileFanIn(opts.filePath)), budget])
    if (result === timedOut) return { action: "allow" }

    const importers = result
    if (importers < HUB_IMPORTER_THRESHOLD) return { action: "allow" }

    if (!hubEditBounced.has(opts.sessionID)) hubEditBounced.set(opts.sessionID, new Set())
    hubEditBounced.get(opts.sessionID)!.add(opts.filePath)
    // Wave 12 — records the turn's first bounce on filePath so a later
    // session inheriting this session's state (a hard-tail escalation
    // slice) sees turnCount 1 instead of starting from zero. Bookkeeping
    // only — never changes what this branch returns.
    bumpHubEditTurnBounceCount(opts.sessionID, opts.filePath)
    return {
      action: "deny",
      message: hubEditDenialMessage(opts.filePath, importers, hubEditDefiningFiles(opts.sessionID)),
      importers,
    }
  } catch {
    return { action: "allow" }
  }
}

/**
 * The production edit-path entry point (edit.ts, write.ts import this exact
 * name): `evaluateHubEditGateCore`'s hub-coupling verdict with the
 * issue-scope boundary (§10 Step 4, `evaluateIssueScopeGate` below) layered
 * on top as an opinion the hub gate itself never forms. Precedence is
 * one-directional and by construction, not by convention: a core `deny`
 * (any bounce/repeat/second/final rung) returns untouched, and a core
 * `allow` reached via the resolved defining-site allowlist (`definingSite:
 * true`) also returns untouched — issue-scope is never even consulted for
 * either, so it can neither override a bounce nor veto a site the hub gate
 * explicitly cleared as root-most. Only a core `allow` WITHOUT a
 * defining-site opinion (unarmed, under threshold, retried, exhausted) — a
 * file the hub gate has no scope opinion on — reaches issue-scope, which
 * (with `ECON_ISSUE_SCOPE_DENY` unset, the default) can only ever return
 * `allow` with an optional `nudge` merged in, never a `deny`: the default
 * path can add a nudge but can never turn an allowed edit into a denial.
 * The try/catch here is a second, redundant fail-open backstop on top of
 * `evaluateIssueScopeGate`'s own internal one — a throw here degrades to
 * the unmodified core result, never to a thrown exception.
 *
 * @sem domain=intelligence role=analysis
 */
export async function evaluateHubEditGate(opts: {
  sessionID: string
  filePath: string
  graph?: HubFanInGraph
  resolveDefiningSites?: (issueText: string) => Promise<Array<{ file: string; kind?: string }> | null>
  dispatchHubDesignJudge?: (opts: {
    sessionID: string
    filePath: string
  }) => Promise<HubEditJudgeVerdict | undefined>
}): Promise<
  | { action: "allow"; retried?: boolean; definingSite?: boolean; exhausted?: boolean; nudge?: string }
  | {
      action: "deny"
      message: string
      importers?: number
      second?: boolean
      definingSites?: string[]
      repeat?: boolean
      final?: boolean
    }
> {
  const hubResult = await evaluateHubEditGateCore(opts)
  if (hubResult.action === "deny") return hubResult
  if (hubResult.definingSite) return hubResult

  try {
    const scopeResult = await evaluateIssueScopeGate({
      sessionID: opts.sessionID,
      filePath: opts.filePath,
      graph: opts.graph as unknown as EditImpactGraph | undefined,
    })
    if (scopeResult.action === "deny") return scopeResult
    if (scopeResult.nudge) return { ...hubResult, nudge: scopeResult.nudge }
  } catch {
    // Fail open — evaluateIssueScopeGate already degrades every internal
    // failure to allow; this catch is only a backstop against a throw in
    // the merge itself, so the hub gate's own verdict always still lands.
  }
  return hubResult
}

// ---------------------------------------------------------------------------
// Wave 10 — dispatch-time defining-site memoization. A cold-graph race:
// the hub-design trigger (prompt.ts) fired its judge dispatch while this
// gate's own lazy resolution (above) was still unresolved — the graph was
// cold at bounce time — so the judge got definitionSites=[] and, with the
// site guard applying only when the list is non-empty, returned a junk
// verdict. A LATER gate evaluation resolved fine on its own, but by then the
// judge had already fired. prompt.ts's trigger already runs its own
// full-budget resolution (issueSymbolDefinitionSites, RISK_PROBE_INDEX_BUDGET_MS
// internally) to ground the judge's prompt; this memoizes that same result
// into THIS gate's store — band-filtered exactly like the lazy path above —
// so the very next gate evaluation (the model's retry after the judge's
// nudge) sees the resolved allowlist immediately instead of redoing the
// resolution itself.
// ---------------------------------------------------------------------------

/**
 * Dispatch-time counterpart to `evaluateHubEditGate`'s lazy resolution above:
 * called by prompt.ts's hub-design trigger right before it runs the judge,
 * with the `sites` it already resolved for the judge's grounding (no second
 * graph query here). No-op when the session's allowlist is already resolved
 * (`hubEditDefiningResolved` — same memoization guard the lazy path uses, so
 * a session is never re-resolved) or when `sites` is empty. On a non-empty
 * `sites`, applies `bandFilterDefiningSites` — the SAME narrowing
 * `evaluateHubEditGate`'s lazy path applies, never a second copy of that
 * logic — then stores the result through `setHubEditGate`'s
 * arm-with-definingFiles path, the same store a child session inherits from.
 * Fails open (leaves the session unresolved for a later
 * `evaluateHubEditGate` lazy pass to retry) on a thrown fan-in lookup or an
 * empty band-filtered result.
 *
 * @sem domain=intelligence role=analysis
 */
export async function memoizeHubEditDefiningSites(
  sessionID: string,
  sites: ReadonlyArray<{ file: string; kind?: string }>,
  graph?: HubFanInGraph,
): Promise<void> {
  if (hubEditDefiningResolved(sessionID)) return
  if (sites.length === 0) return
  let g: HubFanInGraph | undefined
  try {
    g = graph ?? (getGraph() as unknown as HubFanInGraph)
  } catch {
    return
  }
  try {
    const filtered = await bandFilterDefiningSites(sites, (file) => g!.fileFanIn(file))
    if (filtered.length === 0) return
    setHubEditGate(sessionID, true, filtered)
  } catch {
    // Fail open — leave unresolved; evaluateHubEditGate's own lazy path
    // retries at the next gate evaluation.
  }
}

// ---------------------------------------------------------------------------
// §10 Step 4 — issue-scope boundary (docs/design/escalation-economics.md
// §6/§6.1). The hub-edit gate above is a hub-COUPLING gate: its
// defining-site allowlist is only ever used to ALLOW; nothing anywhere
// denies an edit for being outside the issue's scope, so a file below the
// fan-in threshold is allowed unconditionally — the gate never asks that
// question. An escalation ran a broad multi-app sweep, hit two
// pre-existing failures, proved via its own `git stash` + rerun that they
// pre-dated its change, then shipped 8 unrequested lines into the
// collateral module anyway — the required fix was 1 line elsewhere. This
// gate asks the question the hub gate never does. Default posture is NUDGE
// only (a non-blocking `ur|rsk` the call site appends to the tool's
// output); the hard DENY sits behind `ECON_ISSUE_SCOPE_DENY` (default off)
// until the boundary's false-positive rate is measured on a live run — see
// issue-scope.ts.
// ---------------------------------------------------------------------------

/** Per-session derived issue scope — memoized once non-empty (same lifecycle rationale as `hubEditDefiningResolvedSet`: the defining sites it derives from don't change mid-turn, so re-deriving per edit would only repeat the same bounded graph walk). Cleared on hub-edit-gate disarm. */
const issueScopeStore = new Map<string, Set<string>>()

/** Per-session set of file paths already nudged once for falling outside the derived scope — a nudge fires once per (session, file), same throttle shape as `couplingUnknownWarned`. Cleared on hub-edit-gate disarm. */
const issueScopeNudgedStore = new Map<string, Set<string>>()

/**
 * Evaluate an in-flight edit against this turn's derived issue scope (see
 * `deriveIssueScope`, issue-scope.ts) and return a non-blocking nudge
 * (default) or a deny (behind `ECON_ISSUE_SCOPE_DENY`) when `filePath`
 * falls outside it. Fails open on every axis that isn't itself the question
 * being asked: the hub-edit gate's defining-site resolution not yet
 * complete, a resolved-but-empty defining-site set, a test file, or a
 * cold/throwing graph all allow silently — there is nothing to derive a
 * boundary FROM, so this must never manufacture one out of absence. Once a
 * non-empty scope IS derived for a session it is memoized, never
 * re-derived per edit. A nudge fires once per (session, file); a deny
 * (when armed) fires every time — it exists to stop the edit, not merely
 * note it once.
 *
 * @sem domain=intelligence role=analysis
 */
export async function evaluateIssueScopeGate(opts: {
  sessionID: string
  filePath: string
  graph?: EditImpactGraph
}): Promise<{ action: "allow"; nudge?: string } | { action: "deny"; message: string }> {
  if (isTestFilePath(opts.filePath)) return { action: "allow" }
  if (!hubEditDefiningResolved(opts.sessionID)) return { action: "allow" }

  let scope = issueScopeStore.get(opts.sessionID)
  if (!scope) {
    const definingFiles = hubEditDefiningFiles(opts.sessionID)
    if (definingFiles.length === 0) return { action: "allow" } // nothing resolved — no boundary to derive
    let graph: EditImpactGraph | undefined
    try {
      graph = opts.graph ?? (getGraph() as unknown as EditImpactGraph)
    } catch {
      return { action: "allow" }
    }
    try {
      const derived = await deriveIssueScope(definingFiles, graph)
      if (derived.size === 0) return { action: "allow" }
      scope = derived
      issueScopeStore.set(opts.sessionID, scope)
    } catch {
      return { action: "allow" }
    }
  }

  for (const f of scope) {
    if (pathsRefer(opts.filePath, f)) return { action: "allow" }
  }

  const reason = issueScopeReason(opts.filePath, Array.from(scope), opts.sessionID)
  if (issueScopeDenyEnabled()) {
    return { action: "deny", message: reason }
  }
  if (issueScopeNudgedStore.get(opts.sessionID)?.has(opts.filePath)) {
    return { action: "allow" }
  }
  if (!issueScopeNudgedStore.has(opts.sessionID)) issueScopeNudgedStore.set(opts.sessionID, new Set())
  issueScopeNudgedStore.get(opts.sessionID)!.add(opts.filePath)
  return { action: "allow", nudge: `ur|rsk ${reason}` }
}

/** Clear a session's derived issue-scope + nudge-throttle state — called from `setHubEditGate`'s disarm branch so a fresh turn re-derives instead of reusing a stale scope. */
export function clearIssueScopeState(sessionID: string): void {
  issueScopeStore.delete(sessionID)
  issueScopeNudgedStore.delete(sessionID)
}
