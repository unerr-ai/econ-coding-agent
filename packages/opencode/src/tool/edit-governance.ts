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
 * through.
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
import { getGraph, issueSymbolDefinitionSitesIfReady } from "./graph-tools"
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

/** Per-session set of graph-reported defining-module paths for the symbols the issue names (from `issueSymbolDefinitionSites`/`issueSymbolDefinitionSitesIfReady`, resolved either at arming time — a child inheriting an already-resolved parent, or a test — or lazily at first gate evaluation, see `evaluateHubEditGate`) — an edit landing on one of these is the redirect doctrine's own answer, so `evaluateHubEditGate` allows it even over the fan-in threshold. Cleared whenever the gate disarms. */
const hubEditDefiningFilesStore = new Map<string, Set<string>>()

/** Per-session stored turn issue text — set alongside arming (root turn-open, or a child inheriting an unresolved parent's text) so `evaluateHubEditGate`'s lazy resolver has something to resolve once the graph has had a chance to warm. Cleared on disarm. */
const hubEditIssueTextStore = new Map<string, string>()

/** Session IDs whose defining-file allowlist resolution has completed — either supplied directly at arming time or resolved lazily by `evaluateHubEditGate`. Once a session is in this set the resolver is never called again for it (memoized). Cleared on disarm. Kept private — read through `hubEditDefiningResolved` so the accessor name doesn't collide with the Set itself. */
const hubEditDefiningResolvedSet = new Set<string>()

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

/** The reason string thrown at the edit/write boundary when the hub-edit gate bounces a first edit to an over-threshold file. */
export function hubEditDenialMessage(relPath: string, importers: number): string {
  return (
    `${importers} other modules import ${relPath} directly — it is shared infrastructure. ` +
    `A behavior fix belongs at the root-most layer: the module that DEFINES the class or function the issue names, not a shared file every consumer flows through. ` +
    `Re-check where that behavior is defined and prefer fixing there. ` +
    `Moving the same change to a DIFFERENT shared file is not the fix — the defining module is. ` +
    `If this hub file genuinely is the root-most layer, re-issue this exact edit and it will be allowed.`
  )
}

/** Narrow graph surface the hub-edit gate needs — BunSqliteGraph satisfies it structurally; tests pass a synthetic fake (including one whose fileFanIn never resolves, to exercise the budget race). */
export interface HubFanInGraph {
  fileFanIn(filePath: string): number | Promise<number>
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
 * root-most-layer redirect message. Logging-free by design — edit.ts/write.ts
 * log at the call site, inside their own Effect.
 *
 * @sem domain=intelligence role=analysis
 */
export async function evaluateHubEditGate(opts: {
  sessionID: string
  filePath: string
  graph?: HubFanInGraph
  resolveDefiningSites?: (issueText: string) => Promise<Array<{ file: string; kind?: string }> | null>
}): Promise<
  | { action: "allow"; retried?: boolean; definingSite?: boolean }
  | { action: "deny"; message: string; importers: number }
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

  const bounced = hubEditBounced.get(opts.sessionID)
  if (bounced?.has(opts.filePath)) {
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
    return { action: "deny", message: hubEditDenialMessage(opts.filePath, importers), importers }
  } catch {
    return { action: "allow" }
  }
}
