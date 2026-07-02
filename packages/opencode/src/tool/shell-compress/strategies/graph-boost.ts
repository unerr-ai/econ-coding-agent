/**
 * Graph-risk boost for shell output compression (GATED on unerrd presence).
 *
 * When the unerrd daemon socket is reachable, annotates git-status/diff files
 * with fan-in from the live call graph and preserves high-risk hunks.
 * No-ops silently when the daemon is absent (standard econ standalone run).
 *
 * Port of unerr-cli src/proxy/shell-graph-boost.ts — daemon coupling removed;
 * the annotation types and gate function are kept so the wiring is a one-liner
 * when the UDS proxy is available.
 *
 * TODO(econ-graph-boost): replace the stub `buildRiskHints` below with a call
 * to the unerrd UDS proxy (packages/opencode/src/intelligence or a sidecar
 * import) once the proxy is wired into the econ backend. The gate already
 * checks for the socket — only the graph query needs to be filled in.
 *
 * @sem domain=tool role=compressor
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import type { ShellDiffRiskHint } from "./diff"

export interface ShellFileRiskHint {
  file: string
  topEntity: string
  risk_level: string
  fan_in: number
}

// ---------------------------------------------------------------------------
// Gate — check if unerrd is reachable
// ---------------------------------------------------------------------------

/** Candidate socket paths for the unerrd daemon. */
const UDS_CANDIDATES = [
  join(process.env["HOME"] ?? "/tmp", ".unerr", "unerrd.sock"),
  join(process.env["UNERR_SOCKET"] ?? "", ""),
]

/**
 * Returns true when the unerrd daemon socket exists on disk.
 * This is a cheap fs-stat check; the actual connection is made by the caller.
 * Used as a gate so the graph-boost path is skipped in standalone econ runs.
 */
export function isDaemonAvailable(): boolean {
  return UDS_CANDIDATES.some((p) => p && existsSync(p))
}

// ---------------------------------------------------------------------------
// Stub implementations (no-op until UDS proxy is wired)
// ---------------------------------------------------------------------------

/**
 * Build a file_path → risk hint map by resolving paths in the output against
 * the graph. Returns an empty map in this stub.
 *
 * TODO(econ-graph-boost): call the unerrd UDS proxy here to resolve fan-in.
 */
export async function buildRiskHints(
  _stdout: string,
): Promise<Map<string, ShellDiffRiskHint>> {
  // Stub — no daemon connection yet.
  return new Map()
}

/**
 * Build a diff-specific risk map for annotating diff hunks with caller counts.
 * Returns an empty map in this stub.
 *
 * TODO(econ-graph-boost): call unerrd.findEntityByName for each candidate symbol.
 */
export async function buildDiffRiskMap(
  _stdout: string,
): Promise<Map<string, ShellDiffRiskHint>> {
  return new Map()
}

/**
 * Categories whose strategies benefit from a file-level risk overlay.
 * Mirrors unerr-cli categoryWantsFileRiskBoost.
 */
export function categoryWantsRiskBoost(category: string, command: string | undefined): boolean {
  if (!command) return false
  if (category === "diff") return false // handled by buildDiffRiskMap
  if (/^\s*git\s+(status|log)\b/.test(command)) return true
  if (
    /^\s*(eslint|biome|tsc|ruff|mypy|golangci|cargo clippy|shellcheck)\b/.test(command)
  )
    return true
  return false
}
