/**
 * §6/§10 Step 4 issue-scope boundary (docs/design/escalation-economics.md):
 * derives the in-scope file set for this turn's issue from evidence already
 * computed elsewhere — the hub-edit gate's resolved defining sites (issue-
 * symbol resolution + literal filenames the issue text names) plus their
 * one-hop reverse-call graph neighborhood — and holds the per-session "this
 * failure pre-dates my change" proof store so a later out-of-scope check can
 * cite it instead of the agent re-deriving or discarding it. Pure derivation
 * only; edit-governance.ts owns the session-armed gate that consumes this.
 *
 * @sem domain=intelligence role=analysis
 */
import type { EditImpactGraph } from "@opencode-ai/code-intelligence"

/** Env var read by `issueScopeDenyEnabled` — default OFF (§10 Step 4: nudge until the boundary's false-positive rate is measured on a live run; the current binary's 10/10 must not regress on an unmeasured veto). */
const ISSUE_SCOPE_DENY_ENV = "ECON_ISSUE_SCOPE_DENY"

/** Whether an out-of-scope edit should be DENIED, not just nudged. Off by default — same read shape as `isBrowserRenderEnabled` (browser-render.ts). */
export function issueScopeDenyEnabled(): boolean {
  const v = process.env[ISSUE_SCOPE_DENY_ENV]
  return v === "1" || v === "true"
}

/** Entities walked per defining file, and total distinct neighbor files kept — same magnitude as F20's graph-neighbor walk (regression-neighbors.ts's GRAPH_NEIGHBOR_ENTITY_CAP/GRAPH_NEIGHBOR_HOP1_FILE_CAP), bounded so a hub-like defining site can never make this walk expensive. */
const SCOPE_NEIGHBOR_ENTITY_CAP = 12
const SCOPE_NEIGHBOR_FILE_CAP = 16

/**
 * One-hop reverse-call neighborhood of `definingFiles`: files holding an
 * entity that directly CALLS INTO a defining file's entity — never the
 * other direction. Deliberately one-way: the defining site's own
 * dependencies (what it calls out to) are not pulled into scope, only what
 * calls it. This is what keeps a defining site's incidental collaborator
 * (django-11880: `fields.py` — the resolved defining site — imports
 * `validators.py`, which is not itself in the issue's scope) OUT of the
 * derived boundary instead of quietly re-admitting exactly the collateral
 * file this feature exists to flag. Reuses the getEntitiesInFile/getCallers
 * primitives `computeEditImpact` (edit-impact.ts) already walks for the
 * callers-at-risk warning — no new graph query shape. Never throws: a
 * cold/unindexed file or an unresolved entity's callers is skipped,
 * degrading the neighborhood rather than failing the derivation.
 */
async function graphNeighborhood(definingFiles: readonly string[], graph: EditImpactGraph): Promise<Set<string>> {
  const neighbors = new Set<string>()
  for (const file of definingFiles) {
    if (neighbors.size >= SCOPE_NEIGHBOR_FILE_CAP) break
    try {
      const entities = (await graph.getEntitiesInFile(file)).slice(0, SCOPE_NEIGHBOR_ENTITY_CAP)
      for (const entity of entities) {
        if (neighbors.size >= SCOPE_NEIGHBOR_FILE_CAP) break
        try {
          for (const ref of await graph.getCallers(entity.key)) {
            if (neighbors.size >= SCOPE_NEIGHBOR_FILE_CAP) break
            neighbors.add(ref.fromFile)
          }
        } catch {
          // one entity's callers unresolved — skip it, the walk degrades not fails
        }
      }
    } catch {
      // file cold/unindexed — skip it, the walk degrades not fails
    }
  }
  return neighbors
}

/**
 * Derive this turn's in-scope file set: the issue's resolved defining sites
 * (already computed by the hub-edit gate's lazy resolution — see
 * edit-governance.ts's `hubEditDefiningFiles`, itself folding in both
 * graph-resolved symbol definitions and literal filenames the issue text
 * names) plus their one-hop reverse-call graph neighborhood. No new
 * analysis pass — this composes evidence the turn already computed with the
 * same primitives `computeEditImpact` already walks. An empty
 * `definingFiles` derives an empty scope; callers MUST read that as "scope
 * unknown, fail open" rather than "everything is out of scope" — nothing
 * was resolved to derive a boundary from.
 *
 * @sem domain=intelligence role=analysis
 */
export async function deriveIssueScope(
  definingFiles: readonly string[],
  graph: EditImpactGraph,
): Promise<Set<string>> {
  if (definingFiles.length === 0) return new Set()
  const neighborhood = await graphNeighborhood(definingFiles, graph)
  return new Set([...definingFiles, ...neighborhood])
}

// ---------------------------------------------------------------------------
// §6.1 — the missing second primitive: a place to record "this failure
// pre-dates my change." The agent already computes this proof itself
// (django-11880: `git stash push` its own edited file, re-run, see the same
// failure) — it previously had nowhere to put that proof, so the correct
// conclusion (leave it alone, it is not yours) was re-derived each time or
// ignored outright. Same per-session Map-of-Set lifecycle as
// edit-governance.ts's other per-turn governance state; cleared explicitly
// alongside the hub-edit gate's disarm, never on a timer.
// ---------------------------------------------------------------------------

const preExistingFailureStore = new Map<string, Set<string>>()

/**
 * Record that `signature` (a failing test id, module name, or file — the
 * agent's own words for what it stashed-and-reran) is PROVEN to pre-date
 * this session's edits this turn. Idempotent. This only gives the proof
 * somewhere to live; it does not itself decide anything.
 */
export function recordPreExistingFailure(sessionID: string, signature: string): void {
  if (!preExistingFailureStore.has(sessionID)) preExistingFailureStore.set(sessionID, new Set())
  preExistingFailureStore.get(sessionID)!.add(signature)
}

/** The session's recorded pre-existing-failure proofs this turn (insertion order) — empty for a session with none recorded. */
export function preExistingFailures(sessionID: string): string[] {
  return Array.from(preExistingFailureStore.get(sessionID) ?? [])
}

/** Clear a session's recorded pre-existing-failure proofs — call alongside the hub-edit gate's disarm so a fresh turn never inherits a stale proof. */
export function clearPreExistingFailures(sessionID: string): void {
  preExistingFailureStore.delete(sessionID)
}

/**
 * The reason string surfaced when `relPath` falls outside the derived issue
 * scope — used both as the non-blocking nudge (default) and, behind
 * `ECON_ISSUE_SCOPE_DENY`, the deny message. Names the resolved scope so the
 * model can see what WAS in-bounds, and — when this session already proved
 * (§6.1) a failure pre-dates its change — states that explicitly, so the
 * correct conclusion is available instead of re-derived or ignored (the
 * django-11880 chain this boundary exists to stop: the agent proved two
 * failures pre-existed via its own stash-and-rerun experiment, then shipped
 * 8 unrequested lines into the collateral module anyway).
 */
export function issueScopeReason(relPath: string, scope: readonly string[], sessionID: string): string {
  const scopeList = scope.length > 0 ? scope.join(", ") : "(none resolved)"
  const base =
    `${relPath} is outside the derived scope for this issue — it is not one of the resolved defining sites ` +
    `or their direct graph neighbors: ${scopeList}. A fix belongs at one of those sites; if ${relPath} genuinely ` +
    `implements the issue's behavior, state that evidence in the same turn.`
  const proofs = preExistingFailures(sessionID)
  if (proofs.length === 0) return base
  return (
    base +
    ` This turn already proved (stash-and-rerun) that a failure pre-dates your change: ${proofs.join(", ")} — ` +
    `that failure is not ${relPath}'s to fix; leave it alone.`
  )
}
