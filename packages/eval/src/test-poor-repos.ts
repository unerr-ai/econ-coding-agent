/**
 * Registry of test-poor fixture mini-repos (OL-7.12) — real directories
 * under fixtures/test-poor-repos/ with little/no test coverage, used by the
 * everyday-capability eval so the verifier ladder for their cases genuinely
 * exercises the QE/judge rungs (no sound-test rung to lean on). File counts
 * are scanned from disk, not asserted, so the "test-poor" claim is verified.
 * @sem domain=eval role=fixtures
 */

import { readdirSync, statSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import type { TestPoorRepo } from "./everyday-types.js"

/** Root of the packages/eval package (this file lives in src/). */
const EVAL_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const TEST_FILE_RE = /\.(test|spec)\.[jt]sx?$/
const SOURCE_FILE_RE = /\.[jt]sx?$/
const SKIP_DIRS = new Set(["node_modules", ".git"])

/** All test-poor repos the everyday-capability eval scores cases against. */
export const TEST_POOR_REPOS: TestPoorRepo[] = [
  {
    id: "tiny-cli-tool",
    relPath: "fixtures/test-poor-repos/tiny-cli-tool",
    description: "A tiny untested CLI utility (date/report formatting) — no test directory at all.",
  },
  {
    id: "legacy-report-scripts",
    relPath: "fixtures/test-poor-repos/legacy-report-scripts",
    description: "Loose untyped JS scripts (report generation, email send) — no tests, ambiguous naming.",
  },
]

/** Absolute path to a registered repo's fixture directory. */
export function repoDir(repo: TestPoorRepo): string {
  return join(EVAL_ROOT, repo.relPath)
}

/**
 * Walks a repo's fixture directory and counts source vs test files. Purely
 * local filesystem I/O — no network, safe to call from unit tests.
 */
export function scanRepoFileCounts(repo: TestPoorRepo): { sourceFileCount: number; testFileCount: number } {
  let sourceFileCount = 0
  let testFileCount = 0

  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue
      const full = join(dir, entry)
      const st = statSync(full)
      if (st.isDirectory()) {
        walk(full)
        continue
      }
      if (TEST_FILE_RE.test(entry)) {
        testFileCount++
      } else if (SOURCE_FILE_RE.test(entry)) {
        sourceFileCount++
      }
    }
  }

  walk(repoDir(repo))
  return { sourceFileCount, testFileCount }
}

/** True when a repo has strictly zero test files on disk — the strong form of "test-poor". */
export function isTestPoor(repo: TestPoorRepo): boolean {
  return scanRepoFileCounts(repo).testFileCount === 0
}
