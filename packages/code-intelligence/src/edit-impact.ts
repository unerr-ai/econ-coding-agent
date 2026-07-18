/**
 * Signature-change cascade detector for econ's code-intelligence layer.
 * Given an in-flight edit, detects whether any entity's signature changed and
 * resolves depth-1 callers at risk — process-agnostic and testable without a
 * live graph. Also carries the post-edit counterpart (G3): once an edit has
 * landed, diffs the file's pre-edit entity list against a fresh re-parse of
 * the new content to catch a REMOVED export the in-flight content-diff can't
 * see (there's no "changed" fragment left to match against).
 *
 * Lifted from unerr-cli's edit-impact.ts and adapted to econ's Entity/Reference
 * graph types. Federation (cross-repo) features are out of scope for this layer.
 *
 * @sem domain=intelligence role=analysis
 */

import type { Entity, Reference } from "./index.js"
import type { ExtractedEntity } from "./ast-extractor.js"

/**
 * A single depth-1 caller that may need updating after a signature change.
 * Carries enough context to display a clickable location and flag test sites.
 *
 * @sem domain=intelligence role=analysis
 */
export interface CallerAtRisk {
  file: string
  entity: string
  line: number
  isTest: boolean
}

/**
 * One actionable cascade warning: an entity whose public signature changed with
 * enough callers to warrant surfacing before the edit lands.
 *
 * @sem domain=intelligence role=analysis
 */
export interface CascadeWarning {
  /** Bare entity name, for display (e.g. "computeEditImpact"). Never the
   *  multi-line signature blob — that breaks pasteable get_references actions. */
  changed_entity: string
  /** Stable entity key of the changed entity, for `get_references({key:…})`. */
  changed_entity_key: string
  change_type: SignatureChangeType
  blast_radius: {
    direct_callers: CallerAtRisk[]
    test_files: CallerAtRisk[]
    indirect_callers: number
    total_at_risk: number
  }
  suggestion: string
}

/**
 * Discriminated union of detectable signature-change categories, ordered from
 * most to least breaking. Drives the suggestion text and warning priority.
 *
 * @sem domain=intelligence role=analysis
 */
export type SignatureChangeType =
  | "parameter_added"
  | "parameter_removed"
  | "parameter_renamed"
  | "return_type_changed"
  | "type_changed"
  | "signature_modified"

/**
 * Narrow async graph surface this engine needs. BunSqliteGraph satisfies it
 * structurally, so callers pass the real store; tests pass a synthetic fake.
 * Keeping this interface small is what makes the engine process-agnostic.
 *
 * @sem domain=intelligence role=analysis
 */
export interface EditImpactGraph {
  getEntitiesInFile(filePath: string): Promise<Entity[]>
  getCallers(entityKey: string): Promise<Reference[]>
}

/**
 * Tunable thresholds controlling when the engine emits a warning. Raising
 * minCallersToWarn reduces noise on lightly-used internal helpers.
 *
 * @sem domain=intelligence role=analysis
 */
export interface EditImpactConfig {
  minCallersToWarn: number
  includeTests: boolean
}

/**
 * Conservative defaults: warn at 2+ callers and count test files in the
 * blast-radius total so editors see the full picture without extra queries.
 *
 * @sem domain=intelligence role=analysis
 */
export const DEFAULT_EDIT_IMPACT_CONFIG: EditImpactConfig = {
  minCallersToWarn: 2,
  includeTests: true,
}

const TEST_FILE_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /__tests__\//,
  /test\//,
  /tests\//,
]

/**
 * Returns true when the file path matches any known test-file convention.
 * Used to separate test callers from production callers in the blast radius.
 *
 * @sem domain=intelligence role=utilities
 */
export function isTestFilePath(filePath: string): boolean {
  return TEST_FILE_PATTERNS.some((p) => p.test(filePath))
}

/**
 * Lightweight regex-based signature-change detection that avoids a full AST
 * parse; fires before a graph query so it gates the more expensive callers
 * lookup.
 *
 * @sem domain=intelligence role=analysis
 */
export function detectSignatureChange(
  entity: Entity,
  oldContent: string | null,
  newContent: string | null,
): SignatureChangeType | null {
  if (!oldContent || !newContent) {
    if (newContent && entity.signature) {
      const fnPattern = new RegExp(
        `(?:function|async\\s+function|export\\s+(?:async\\s+)?function)\\s+${escapeRegex(entity.name)}\\s*\\(`,
      )
      if (fnPattern.test(newContent)) {
        return "signature_modified"
      }
    }
    return null
  }

  // Path A — precise full-signature diff. Fires only when BOTH fragments carry
  // a complete `name(...)` (balanced parens). Most reliable; classifies exactly.
  const oldSigs = extractSignatures(oldContent, entity.name)
  const newSigs = extractSignatures(newContent, entity.name)
  if (oldSigs.length > 0 && newSigs.length > 0) {
    return classifyChange(oldSigs[0]!, newSigs[0]!)
  }

  // Path B — signature-region diff (Bug C). Real Claude `old_string`/`new_string`
  // are partial hunks: a multi-line signature edit usually includes the
  // `function name(` opener but NOT the closing `)` (it sits below the hunk), so
  // Path A's balanced-paren extraction returns empty and the change is missed.
  // Anchor on the opener present in BOTH fragments and compare the param region
  // up to the closing `)` OR end-of-fragment. Identical regions (the opener line
  // rode along but the signature didn't change) → null, so body-only edits that
  // happen to include the opener line stay silent.
  const oldRegion = extractSignatureRegion(oldContent, entity.name)
  const newRegion = extractSignatureRegion(newContent, entity.name)
  if (oldRegion !== null && newRegion !== null) {
    return classifyChange(oldRegion, newRegion)
  }

  return null
}

/**
 * Classify a signature change between two signature strings (full or a partial
 * region from the opener onward). Shared by Path A (balanced) and Path B
 * (truncated): extractParams / extractReturnType tolerate a missing closing
 * paren. Returns null when the two are identical.
 */
function classifyChange(oldSig: string, newSig: string): SignatureChangeType | null {
  if (oldSig === newSig) return null

  const oldParams = extractParams(oldSig)
  const newParams = extractParams(newSig)

  if (newParams.length > oldParams.length) return "parameter_added"
  if (newParams.length < oldParams.length) return "parameter_removed"

  const oldParamNames = oldParams.map((p) => p.split(/[:\s=]/)[0]?.trim())
  const newParamNames = newParams.map((p) => p.split(/[:\s=]/)[0]?.trim())
  for (let i = 0; i < oldParamNames.length; i++) {
    if (oldParamNames[i] !== newParamNames[i]) return "parameter_renamed"
  }

  const oldReturn = extractReturnType(oldSig)
  const newReturn = extractReturnType(newSig)
  if (oldReturn !== newReturn && oldReturn && newReturn) return "return_type_changed"

  return "type_changed"
}

/**
 * Extract the parameter region of `entityName`'s signature from a (possibly
 * partial) edit fragment: the slice from the opening `(` up to the matching `)`
 * if present, else to end-of-fragment. Returns null when the opener isn't in the
 * fragment. Unlike extractSignatures it does NOT require balanced `(...)`.
 */
function extractSignatureRegion(content: string, entityName: string): string | null {
  const escaped = escapeRegex(entityName)
  const opener = new RegExp(
    `(?:(?:export\\s+)?(?:async\\s+)?function\\s+)?${escaped}\\s*\\(`,
  )
  const m = opener.exec(content)
  if (!m) return null
  const parenStart = content.indexOf("(", m.index)
  if (parenStart === -1) return null
  const rest = content.slice(parenStart) // from "(" onward
  const close = rest.indexOf(")")
  return close === -1 ? rest : rest.slice(0, close + 1)
}

function extractSignatures(content: string, entityName: string): string[] {
  const escapedName = escapeRegex(entityName)
  const patterns = [
    new RegExp(
      `(?:export\\s+)?(?:async\\s+)?function\\s+${escapedName}\\s*\\([^)]*\\)(?:\\s*:\\s*[^{]+)?`,
      "g",
    ),
    new RegExp(
      `(?:export\\s+)?(?:async\\s+)?${escapedName}\\s*\\([^)]*\\)(?:\\s*:\\s*[^{]+)?`,
      "g",
    ),
  ]

  const results: string[] = []
  for (const pattern of patterns) {
    let match: RegExpExecArray | null
    match = pattern.exec(content)
    while (match !== null) {
      results.push(match[0])
      match = pattern.exec(content)
    }
    if (results.length > 0) break
  }
  return results
}

function extractParams(signature: string): string[] {
  const open = signature.indexOf("(")
  if (open === -1) return []
  const rest = signature.slice(open + 1)
  // Tolerate a missing closing paren: a truncated region like `(a,\n  b,`
  // (multi-line signature whose `)` is below the edited hunk) still parses.
  const close = rest.indexOf(")")
  const inner = close === -1 ? rest : rest.slice(0, close)
  if (!inner.trim()) return []
  return inner
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
}

function extractReturnType(signature: string): string | null {
  const afterParen = signature.split(")").slice(1).join(")").trim()
  if (!afterParen.startsWith(":")) return null
  return afterParen.slice(1).trim()
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Maps a graph Reference edge to a CallerAtRisk record, extracting the bare
 * caller name from the entity key and flagging test files by path convention.
 *
 * @sem domain=intelligence role=analysis
 */
export function toCallerAtRisk(ref: Reference): CallerAtRisk {
  const entityName = ref.fromEntity.includes(":")
    ? ref.fromEntity.split(":")[1]!
    : ref.fromEntity
  return {
    file: ref.fromFile,
    entity: entityName,
    line: 0,
    isTest: isTestFilePath(ref.fromFile),
  }
}

/**
 * Builds a concise, actionable text suggestion summarising how many callers
 * need updating and where to start — surfaced inside each CascadeWarning.
 *
 * @sem domain=intelligence role=utilities
 */
export function buildSuggestion(
  entityName: string,
  direct: CallerAtRisk[],
  tests: CallerAtRisk[],
): string {
  const total = direct.length + tests.length
  const parts = [`Update all ${total} caller(s) of ${entityName}.`]
  if (direct.length > 0) {
    parts.push(
      `Start with ${direct.length} direct caller(s): ${direct
        .map((c) => `${c.file.split("/").pop()}:${c.entity}`)
        .slice(0, 3)
        .join(", ")}${direct.length > 3 ? ` (+${direct.length - 3} more)` : ""}.`,
    )
  }
  if (tests.length > 0) {
    parts.push(`Then update ${tests.length} test file(s).`)
  }
  return parts.join(" ")
}

/**
 * Dedupe caller edges before counting: one caller file can contribute BOTH a
 * file-level import edge (fromEntity="") and a named call edge for the same
 * target, which describe the same dependency, not two callers. Drops the
 * import-only edge when a named call edge from the same file is present;
 * distinct named callers within one file are preserved.
 */
function dedupeCallerRefs(refs: Reference[]): Reference[] {
  const byFile = new Map<string, Map<string, Reference>>()
  for (const ref of refs) {
    let group = byFile.get(ref.fromFile)
    if (!group) {
      group = new Map()
      byFile.set(ref.fromFile, group)
    }
    if (!group.has(ref.fromEntity)) group.set(ref.fromEntity, ref)
  }
  const out: Reference[] = []
  for (const group of byFile.values()) {
    const hasNamedCaller = [...group.keys()].some((k) => k !== "")
    for (const [fromEntity, ref] of group) {
      if (hasNamedCaller && fromEntity === "") continue
      out.push(ref)
    }
  }
  return out
}

/** Max caller sites listed inline before deferring the rest to get_references. */
const MAX_INLINE_CALLERS = 8

/**
 * Renders graph-confirmed signature-change warnings as inline `ur|rsk` lines
 * for the file_edit response, so every agent receives callers-at-risk in the
 * same response without a separate get_references round-trip.
 *
 * @sem domain=intelligence role=presenter
 */
export function renderInlineBlastRadius(warnings: CascadeWarning[]): string | null {
  if (warnings.length === 0) return null

  const lines = warnings.map((w) => {
    const ordered = [...w.blast_radius.direct_callers, ...w.blast_radius.test_files]
    const shown = ordered.slice(0, MAX_INLINE_CALLERS)
    const sites = shown
      .map((c) => (c.line > 0 ? `${c.entity} (${c.file}:${c.line})` : `${c.entity} (${c.file})`))
      .join(", ")

    const overflow = ordered.length - shown.length
    const more =
      overflow > 0
        ? `, +${overflow} more via get_references({key:'${w.changed_entity_key}', direction:'callers'})`
        : ""

    return `ur|rsk signature change to ${w.changed_entity} — ${w.blast_radius.total_at_risk} caller(s) to update: ${sites}${more}`
  })

  return lines.join("\n")
}

/**
 * Computes cascade warnings for an in-flight edit. Detects signature changes
 * for every entity in the edited file and resolves depth-1 callers at risk
 * (via each entity's full key, and deduped so a caller file's import+call
 * edge pair counts once), returning one CascadeWarning per entity that
 * clears the minCallersToWarn threshold — the single callable entry point
 * for hook, UDS, and behavior surfaces.
 *
 * @sem domain=intelligence role=analysis
 */
export async function computeEditImpact(
  graph: EditImpactGraph,
  filePath: string,
  oldContent: string | null,
  newContent: string | null,
  config: EditImpactConfig = DEFAULT_EDIT_IMPACT_CONFIG,
): Promise<CascadeWarning[]> {
  if (!oldContent && !newContent) return []

  const entities = await graph.getEntitiesInFile(filePath)
  if (entities.length === 0) return []

  const warnings: CascadeWarning[] = []

  for (const entity of entities) {
    const changeType = detectSignatureChange(entity, oldContent, newContent)
    if (!changeType) continue

    // Full entity key (not bare name) so same-named entities in other files
    // never leak callers; deduped so an import+call edge pair from one
    // caller file counts once, not twice.
    const callerRefs = dedupeCallerRefs(await graph.getCallers(entity.key))
    if (callerRefs.length < config.minCallersToWarn) continue

    const callersAtRisk = callerRefs.map((ref) => toCallerAtRisk(ref))
    const directCallers = callersAtRisk.filter((c) => !c.isTest)
    const testCallers = callersAtRisk.filter((c) => c.isTest)

    const totalAtRisk = config.includeTests ? callersAtRisk.length : directCallers.length

    if (totalAtRisk < config.minCallersToWarn) continue

    warnings.push({
      changed_entity: entity.name,
      changed_entity_key: entity.key,
      change_type: changeType,
      blast_radius: {
        direct_callers: directCallers,
        test_files: testCallers,
        indirect_callers: 0,
        total_at_risk: totalAtRisk,
      },
      suggestion: buildSuggestion(entity.name, directCallers, testCallers),
    })
  }

  return warnings
}

// ---------------------------------------------------------------------------
// G3 — post-edit breaking-change scan. computeEditImpact above runs while an
// edit is IN FLIGHT and regex-diffs raw old/new content; that diff has no
// representation for "this name is gone entirely" (there's no changed
// fragment to match against), so a removed export slips through silently.
// detectBreakingChanges runs AFTER the edit lands and diffs two authoritative
// entity lists instead — the graph's pre-edit list (still valid until the
// next re-index) against a fresh single-file re-parse of the new content —
// which sees a removal directly as "name present in preEntities, absent from
// postEntities."
// ---------------------------------------------------------------------------

/** Max caller sites resolved per breaking change before the rest defer to get_references. */
const MAX_BREAKING_CHANGE_CALLERS = 5

/**
 * One exported entity whose public surface changed enough, after an edit
 * landed, to break existing callers: either it no longer exists in the file
 * (REMOVED — a straight delete and a rename look identical from a name diff)
 * or its re-parsed signature no longer matches what callers were written
 * against (SIGNATURE_CHANGED). `text_occurrences` is populated by the
 * calling wiring layer for a REMOVED entity — residue the call graph itself
 * can't see (a stale string, a config key, a dynamic-dispatch site).
 *
 * @sem domain=intelligence role=analysis
 */
export interface BreakingChange {
  entity_name: string
  entity_key: string
  entity_file: string
  change_type: "removed" | "signature_changed"
  callers: CallerAtRisk[]
  callers_total: number
  text_occurrences?: Array<{ file: string; line: number }>
}

/**
 * Lightweight `export <kind> <name>` probe against raw source (TS/JS only,
 * mirrors the declaration shapes detectSignatureChange's fallback path
 * recognises). Scopes breaking-change detection to a file's public surface —
 * an unexported helper losing its last in-file caller is a refactor, not a
 * breaking change.
 */
function isExportedName(content: string, name: string): boolean {
  const escaped = escapeRegex(name)
  const re = new RegExp(
    `export\\s+(?:default\\s+)?(?:async\\s+)?(?:function|class|interface|type|const|let|var)\\s+${escaped}\\b`,
  )
  return re.test(content)
}

/**
 * Diffs a file's pre-edit entity list (from the graph — still reflects the
 * old content until the next re-index) against its post-edit entity list
 * (freshly re-parsed from the new content, e.g. via ast-extractor's
 * extractEntities — no re-index needed) and reports every exported entity
 * that was removed or whose signature changed. A post-parse yielding zero
 * entities for a file that had entities before is treated as a parser miss
 * rather than a mass deletion and returns [] rather than flooding "removed"
 * for the whole file. Callers are resolved via graph.getCallers on the
 * pre-edit entity's still-valid key, filtered to sites outside the edited
 * file and capped at MAX_BREAKING_CHANGE_CALLERS; an entity with zero
 * outside callers is silently dropped — nothing broke.
 *
 * @sem domain=intelligence role=analysis
 */
export async function detectBreakingChanges(
  graph: EditImpactGraph,
  oldContent: string,
  preEntities: Entity[],
  postEntities: ExtractedEntity[],
): Promise<BreakingChange[]> {
  if (postEntities.length === 0 && preEntities.length > 0) return []

  const postByKey = new Map<string, ExtractedEntity>()
  for (const e of postEntities) postByKey.set(`${e.name}::${e.kind}`, e)

  const changes: BreakingChange[] = []

  for (const pre of preEntities) {
    if (!isExportedName(oldContent, pre.name)) continue

    const post = postByKey.get(`${pre.name}::${pre.kind}`)
    const changeType: BreakingChange["change_type"] | null = !post
      ? "removed"
      : post.signature.trim() !== pre.signature.trim()
        ? "signature_changed"
        : null
    if (!changeType) continue

    const callerRefs = dedupeCallerRefs(await graph.getCallers(pre.key)).filter(
      (ref) => ref.fromFile !== pre.filePath,
    )
    if (callerRefs.length === 0) continue

    changes.push({
      entity_name: pre.name,
      entity_key: pre.key,
      entity_file: pre.filePath,
      change_type: changeType,
      callers: callerRefs.slice(0, MAX_BREAKING_CHANGE_CALLERS).map(toCallerAtRisk),
      callers_total: callerRefs.length,
    })
  }

  return changes
}

/**
 * Renders detectBreakingChanges output as inline `ur|brk` lines for the
 * edit/write tool response, mirroring renderInlineBlastRadius's shape so a
 * model already reading `ur|rsk` recognises the sibling signal. Each change
 * lists its top outside-file callers plus, for a REMOVED entity, any
 * text_occurrences the wiring layer found outside the call graph.
 *
 * @sem domain=intelligence role=presenter
 */
export function renderBreakingChangeWarning(changes: BreakingChange[]): string | null {
  if (changes.length === 0) return null

  const lines = changes.map((c) => {
    const shown = c.callers
      .map((caller) =>
        caller.line > 0 ? `${caller.entity} (${caller.file}:${caller.line})` : `${caller.entity} (${caller.file})`,
      )
      .join(", ")
    const overflow = c.callers_total - c.callers.length
    const more =
      overflow > 0
        ? `, +${overflow} more via get_references({key:'${c.entity_key}', direction:'callers'})`
        : ""

    const verb = c.change_type === "removed" ? "removed" : "signature-changed"
    let line = `ur|brk ${c.entity_name} was ${verb} in ${c.entity_file} — ${c.callers_total} live caller(s) still reference it: ${shown}${more}`

    if (c.text_occurrences && c.text_occurrences.length > 0) {
      const sites = c.text_occurrences.map((o) => `${o.file}:${o.line}`).join(", ")
      line += `; also found as text outside the call graph: ${sites}`
    }
    return line
  })

  return lines.join("\n")
}
