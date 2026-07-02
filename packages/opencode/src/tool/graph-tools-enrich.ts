/**
 * Sprint 2B lean-index enrichment: reads entity source files to build body
 * previews, caches full bodies for cache_ref pagination, and derives ur|rsk
 * signals from caller counts. Separated from graph-tools.ts (which carries
 * Effect) so the logic can be unit-tested without the Effect runtime.
 *
 * @sem domain=intelligence role=tools
 */
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { hashInputs, put } from "./_shared"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Caller count at or above which a ur|rsk chokepoint signal is emitted. */
export const RSK_CALLER_THRESHOLD = 10

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal entity shape expected from code-intelligence lean output. */
export interface LeanEntity {
  key?: string
  name: string
  kind: string
  filePath: string
  lineStart: number
  lineEnd: number
  /** Already computed by tools.ts lean projection (caller count). */
  caller_count?: number
  /** Already computed by tools.ts lean projection (15-line preview). */
  preview?: string
  [k: string]: unknown
}

/** Result of a single enrichEntities call. */
export interface EnrichResult {
  /** Entity list with preview ensured; full body NOT included. */
  lean: LeanEntity[]
  /** Cache key for the _shared full-body store — expose as `_meta.cache_ref`. */
  cacheKey: string
  /** Count of entity bodies stored (= `lean.length` when all files readable). */
  total: number
  /** `ur|` signal lines to append after the JSON output. */
  signals: string[]
}

// ---------------------------------------------------------------------------
// enrichEntities
// ---------------------------------------------------------------------------

/**
 * Enrich a lean entity list for token-optimised output: ensures each entity
 * has a `preview` (first 15 source lines), stores full bodies in the _shared
 * cache keyed by `hashInputs(queryCacheKey, "full_bodies")` for cache_ref
 * pagination, and emits a `ur|rsk` line for every entity whose caller_count
 * meets or exceeds RSK_CALLER_THRESHOLD.
 *
 * @sem domain=intelligence role=tools
 */
export async function enrichEntities(
  entities: LeanEntity[],
  root: string,
  queryCacheKey: string,
): Promise<EnrichResult> {
  const fullBodies: Array<{ key: string; body: string }> = []
  const signals: string[] = []

  const lean = await Promise.all(
    entities.map(async (e) => {
      const abs = (e.filePath ?? "").startsWith("/")
        ? e.filePath
        : join(root, e.filePath ?? "")

      const content = await readFile(abs, "utf8").catch(() => "")
      const lines = content.split("\n")
      const entityLines = lines.slice(Math.max(0, (e.lineStart ?? 1) - 1), e.lineEnd ?? 0)
      const body = entityLines.join("\n")

      // tools.ts already computes preview; compute here as fallback.
      const preview = (typeof e.preview === "string" && e.preview.length > 0)
        ? e.preview
        : entityLines.slice(0, 15).join("\n")

      const entityKey = typeof e.key === "string" && e.key.length > 0
        ? e.key
        : `${e.filePath}:${e.name}:${e.kind}`
      fullBodies.push({ key: entityKey, body })

      const callerCount = typeof e.caller_count === "number" ? e.caller_count : 0
      if (callerCount >= RSK_CALLER_THRESHOLD) {
        signals.push(
          `ur|rsk [chokepoint] e:${e.name} has ${callerCount} callers — high blast radius; call get_references before editing`,
        )
      }

      // Return lean entity: preview present, full body excluded.
      const { body: _dropBody, ...rest } = { ...e, body: undefined } as Record<string, unknown>
      void _dropBody
      return { ...rest, preview } as LeanEntity
    }),
  )

  const cacheKey = hashInputs(queryCacheKey, "full_bodies")
  put(cacheKey, fullBodies)

  return { lean, cacheKey, total: fullBodies.length, signals }
}
