/**
 * H4.1 (gap-closure-plan.md §2 H4, kernel §2.7) — the end-state finish gate's
 * deliverable checklist: deterministic extraction of file/artifact paths and
 * check commands an ops-shaped instruction (run-only/build goal, no
 * diagnosis goal) names as its deliverables, plus I/O evidence gathering
 * (existence probes + bounded check-command runs) and the pure gate
 * decision. Coverage itself is judged by the shared claim-evidence kernel
 * (`checkClaimCoverage`) with `Claim.kind = "done"` and
 * `ClaimScope.kind = "deliverables"` — this module only supplies the
 * deliverables scope and their evidence, never a bespoke pass/fail rule.
 * Extraction and coverage-checking are pure and unit-testable without a
 * filesystem; only `gatherDeliverableResults` touches I/O.
 *
 * @sem domain=routing role=gate
 */
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { execSync } from "node:child_process"
import { checkClaimCoverage, type Claim, type ClaimScope, type Evidence, type EvidenceItem, type CoverageVerdict } from "../../../code-intelligence/src/claim-evidence"
import type { TriageGoal } from "./turn-triage"

/** Cap on extracted file/artifact deliverables per turn — same shape as issue-expectations.ts's MAX_LITERALS bound. */
const MAX_DELIVERABLE_FILES = 6
/** Cap on extracted check commands per turn. */
const MAX_DELIVERABLE_COMMANDS = 4
/** Bounded runtime for a single deliverable check command (H4.1 — "exits 0, bounded runtime"). */
export const DELIVERABLE_COMMAND_TIMEOUT_MS = 30_000

// Backtick-quoted, whitespace-free content that looks path-shaped (a
// separator or a dot-extension) — excludes bare identifiers and multi-word
// backticked commands (those have internal spaces and never match here).
const BACKTICK_FILE_RE = /`([^`\s]*\/[^`\s]+|[^`\s]+\.[A-Za-z0-9]{1,8})`/g
// Bare (unquoted) path-shaped token: starts with a path prefix or carries at
// least one separator, made of path-safe characters. Run only against
// URL-stripped text (see URL_RE below) — a URL's own path segment never
// reads as a local-file deliverable.
const BARE_FILE_RE = /(?:\.{1,2}\/[\w.\-/]+|\/[\w][\w.\-/]*|\b[\w-]+(?:\/[\w.\-]+)+)/g
// "run `<cmd>` to verify/check/confirm" and "verify/check/confirm ... with/using/by running `<cmd>`".
const RUN_TO_CHECK_RE = /\brun\s+`([^`]+)`\s+to\s+(?:verify|check|confirm)\b/gi
const CHECK_WITH_RE = /\b(?:verify|check|confirm)\w*\s+(?:with|using|by running)\s+`([^`]+)`/gi
// Stripped before path scanning so a URL's path segment (`https://host/docs`)
// never reads as a local-file deliverable.
const URL_RE = /\bhttps?:\/\/\S+/gi

/** One deliverable obligation — `id` doubles as the claim-scope item id (a path, or `check:<command>`). */
export interface DeliverableItem {
  readonly id: string
  readonly kind: "file" | "command"
}

function collectFilePaths(text: string, out: Set<string>): void {
  const sanitized = text.replace(URL_RE, "")
  for (const m of sanitized.matchAll(BACKTICK_FILE_RE)) {
    const candidate = m[1].trim()
    if (candidate) out.add(candidate)
  }
  for (const m of sanitized.matchAll(BARE_FILE_RE)) {
    const candidate = m[0].trim()
    if (candidate) out.add(candidate)
  }
}

function collectCheckCommands(text: string, out: Set<string>): void {
  for (const m of text.matchAll(RUN_TO_CHECK_RE)) {
    const cmd = m[1].trim()
    if (cmd) out.add(cmd)
  }
  for (const m of text.matchAll(CHECK_WITH_RE)) {
    const cmd = m[1].trim()
    if (cmd) out.add(cmd)
  }
}

/**
 * Deterministic deliverable-checklist extraction: file/artifact paths and
 * check commands named in the raw instruction, folded together with the
 * turn-read goals' `quote`/`deliverable` text (the same source, scanned
 * again, so a deliverable phrased only in the extracted "done when" text
 * still counts). No LLM, no graph — a plain regex scan, capped and deduped.
 *
 * @sem domain=routing role=extractor
 */
export function extractDeliverables(
  instruction: string,
  goals: readonly Pick<TriageGoal, "quote" | "deliverable">[] = [],
): readonly DeliverableItem[] {
  const files = new Set<string>()
  const commands = new Set<string>()
  const sources = [instruction, ...goals.flatMap((g) => [g.quote, g.deliverable])].filter(Boolean)
  for (const text of sources) {
    collectFilePaths(text, files)
    collectCheckCommands(text, commands)
  }
  // A command string that also happens to look path-shaped (e.g. a script
  // path run directly) is a check, not a separate existence probe.
  for (const command of commands) files.delete(command)

  const fileItems: DeliverableItem[] = [...files]
    .slice(0, MAX_DELIVERABLE_FILES)
    .map((id) => ({ id, kind: "file" as const }))
  const commandItems: DeliverableItem[] = [...commands]
    .slice(0, MAX_DELIVERABLE_COMMANDS)
    .map((command) => ({ id: `check:${command}`, kind: "command" as const }))
  return [...fileItems, ...commandItems]
}

/**
 * I/O evidence gathering: a file/artifact deliverable is a plain existence
 * probe (`pass`/`fail`, never `unverified` — the check always runs); a
 * command deliverable runs bounded by `commandTimeoutMs`, `pass` on exit 0,
 * `fail` on a real nonzero exit, `unverified` when it could not even be
 * spawned/finished within budget (a timeout blocks coverage exactly like a
 * failure, never a silent pass).
 *
 * @sem domain=routing role=gate
 */
export async function gatherDeliverableResults(
  items: readonly DeliverableItem[],
  opts: { cwd: string; commandTimeoutMs?: number },
): Promise<ReadonlyMap<string, EvidenceItem["verdict"]>> {
  const results = new Map<string, EvidenceItem["verdict"]>()
  for (const item of items) {
    if (item.kind === "file") {
      results.set(item.id, existsSync(resolve(opts.cwd, item.id)) ? "pass" : "fail")
      continue
    }
    const command = item.id.slice("check:".length)
    try {
      execSync(command, { cwd: opts.cwd, timeout: opts.commandTimeoutMs ?? DELIVERABLE_COMMAND_TIMEOUT_MS, stdio: "pipe" })
      results.set(item.id, "pass")
    } catch (err) {
      const hasExitCode = typeof (err as { status?: unknown } | undefined)?.status === "number"
      results.set(item.id, hasExitCode ? "fail" : "unverified")
    }
  }
  return results
}

/**
 * The turn's deliverable `ClaimScope` (`kind:"done"`) judged against
 * pre-gathered results through the shared `checkClaimCoverage` kernel — same
 * shape as `repro-fidelity-judge.ts`'s `checkTestSetCoverage`, so a
 * deliverable this scan never found evidence for blocks coverage exactly
 * like a recorded failure (never a silent pass on the unchecked).
 *
 * @sem domain=routing role=gate
 */
export function checkDeliverableCoverage(
  items: readonly DeliverableItem[],
  results: ReadonlyMap<string, EvidenceItem["verdict"]>,
): CoverageVerdict {
  const scope: ClaimScope = { kind: "deliverables", items: items.map((i) => i.id) }
  const claim: Claim = { kind: "done", scope }
  const evidenceItems: EvidenceItem[] = items
    .filter((i) => results.has(i.id))
    .map((i) => ({ id: i.id, verdict: results.get(i.id)! }))
  const evidence: Evidence = { scope, items: evidenceItems }
  return checkClaimCoverage(claim, evidence)
}

/**
 * The end-state finish gate's one entry point: extract → gather → judge, in
 * one call so prompt.ts's finish-time hook stays a single line. An
 * instruction with nothing extractable trivially covers (nothing was
 * claimed) — the gate only fires when the instruction actually named
 * deliverables.
 *
 * @sem domain=routing role=gate
 */
export async function evaluateOpsDeliverableFinish(input: {
  instruction: string
  goals?: readonly Pick<TriageGoal, "quote" | "deliverable">[]
  cwd: string
  commandTimeoutMs?: number
}): Promise<CoverageVerdict> {
  const items = extractDeliverables(input.instruction, input.goals ?? [])
  const results = await gatherDeliverableResults(items, { cwd: input.cwd, commandTimeoutMs: input.commandTimeoutMs })
  return checkDeliverableCoverage(items, results)
}

/**
 * Pure gate decision, mirroring `turn-supervisor.ts`'s
 * `shouldDenyUnverifiedFinish`: deny at most ONCE per session, only for a
 * root-session, ops-shaped turn whose deliverable checklist doesn't cover —
 * a second finish attempt (or any non-ops/child-session turn) is always
 * allowed, never a wedge.
 *
 * @sem domain=routing role=gate
 */
export function shouldDenyDeliverableFinish(input: {
  isChildSession: boolean
  opsShaped: boolean
  covered: boolean
  alreadyDenied: boolean
}): boolean {
  if (input.isChildSession || !input.opsShaped || input.alreadyDenied) return false
  return !input.covered
}

/**
 * Wave 10 pattern reused: per-session "already denied" flag for the
 * deliverable-checklist finish gate — same module-state shape as
 * `unverified-finish-store.ts`, keyed by sessionID, set once the gate
 * denies, read before every later finish attempt.
 *
 * @sem domain=routing role=config
 */
const deliverableFinishDeniedBySession = new Set<string>()

/** Whether this session's deliverable-checklist finish gate already spent its one deny. */
export function hasDeniedDeliverableFinish(sessionID: string): boolean {
  return deliverableFinishDeniedBySession.has(sessionID)
}

/** Record that the deliverable-checklist finish gate denied this session's finish once. */
export function markDeliverableFinishDenied(sessionID: string): void {
  deliverableFinishDeniedBySession.add(sessionID)
}
