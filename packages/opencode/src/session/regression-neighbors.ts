/**
 * F11 — v1 neighbor-test discovery: given a turn's touched (non-test) source
 * files, finds a small, capped set of already-existing test targets whose
 * scope plausibly covers them, so the turn-end regression gate
 * (`runRegressionGate`, code-intelligence/verifier.ts) has concrete
 * PASS_TO_PASS commands to re-run before a fix-shaped turn concludes — the
 * gap that let a django `deletion.py` rewrite pass its own repro while
 * regressing an untouched neighbor test (`delete.tests.DeletionTests.
 * test_large_delete`). Deliberately minimal and repo-agnostic:
 * filesystem-only (`existsSync`/`readdirSync`, no LLM call, no shell-out); a
 * repo shaped like neither Django's `tests/runtests.py` tree nor a pytest
 * layout returns `[]` and the caller's gate silently no-ops.
 *
 * @sem domain=routing role=neighbor-discovery
 */
import { existsSync, readdirSync, type Dirent } from "node:fs"
import { dirname, extname, join, relative, basename as pathBasename } from "node:path"
import type { VerifyCommand } from "@opencode-ai/code-intelligence"

const MAX_NEIGHBOR_COMMANDS = 3
/** Bound on the recursive descent under `<cwd>/tests/` for the pytest-style fallback. */
const PYTEST_TESTS_DIR_MAX_DEPTH = 3

/** Strip extension, surrounding underscores, and a leading "test_" — the topic name shared between a source file and the test that covers it. */
function neighborTopic(filePath: string): string {
  const raw = pathBasename(filePath, extname(filePath))
  return raw.replace(/^_+|_+$/g, "").replace(/^test_/, "")
}

/** Loose stem check: true when both strings share a long-enough common prefix to be the same word stem, tolerating the last couple characters diverging on an English suffix (e.g. "delete"/"deletion", "delete"/"deletes"). Conservative — unrelated short prefixes never share enough overlap to pass. */
function sharesWordStem(a: string, b: string): boolean {
  const minLen = Math.min(a.length, b.length)
  if (minLen === 0) return false
  if (minLen < 4) return a === b
  let shared = 0
  while (shared < minLen && a[shared] === b[shared]) shared++
  return shared >= 4 && shared >= minLen - 2
}

/** Django `tests/<dir>` naming: the directory names the topic directly, or its plural/"_regress" form shares a word stem with the topic (e.g. topic "deletion" ⇄ dirs "delete", "delete_regress", "deletes"). */
function djangoDirMatchesTopic(topic: string, dirName: string): boolean {
  if (!topic || !dirName) return false
  if (dirName.includes(topic) || topic.includes(dirName)) return true
  const stripped = dirName.replace(/_regress$/, "").replace(/s$/, "")
  return stripped.length > 0 && (topic.includes(stripped) || sharesWordStem(topic, stripped))
}

/** One-level scan of `<cwd>/tests/*` for directory names matching the topic; a missing tree yields none, never a throw. */
function djangoNeighborDirs(cwd: string, topic: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(join(cwd, "tests"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
  return entries.filter((dirName) => djangoDirMatchesTopic(topic, dirName))
}

/** pytest naming: `test_<topic>*.py` or `<topic>*_test.py`. */
function pytestFileMatchesTopic(fileName: string, topic: string): boolean {
  if (!topic || !fileName.endsWith(".py")) return false
  return fileName.startsWith(`test_${topic}`) || (fileName.startsWith(topic) && fileName.endsWith("_test.py"))
}

/** Bounded-depth directory walk collecting pytest-style matches; a missing/unreadable directory yields no matches, never a throw. */
function collectPytestMatches(dir: string, topic: string, depth: number, maxDepth: number, out: Set<string>): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (depth < maxDepth) collectPytestMatches(full, topic, depth + 1, maxDepth, out)
    } else if (entry.isFile() && pytestFileMatchesTopic(entry.name, topic)) {
      out.add(full)
    }
  }
}

/**
 * Discover a small set of pre-existing test commands whose scope plausibly
 * covers `opts.touchedSourceFiles` — Django-style (`tests/runtests.py`
 * present → matching `tests/<dir>` names) when the repo is shaped that way,
 * else a pytest-style filename glob under `<cwd>/tests/**` (bounded depth)
 * and the source file's own directory. Deduped, capped at
 * `MAX_NEIGHBOR_COMMANDS`; returns `[]` when nothing matches so the caller's
 * gate never runs on a guess.
 */
export function discoverNeighborTests(opts: { touchedSourceFiles: readonly string[]; cwd: string }): VerifyCommand[] {
  const { touchedSourceFiles, cwd } = opts
  const commands: VerifyCommand[] = []
  const seen = new Set<string>()
  const push = (command: string) => {
    if (seen.has(command) || commands.length >= MAX_NEIGHBOR_COMMANDS) return
    seen.add(command)
    commands.push({ kind: "test", command })
  }

  const isDjangoRepo = existsSync(join(cwd, "tests", "runtests.py"))

  for (const sourceFile of touchedSourceFiles) {
    if (commands.length >= MAX_NEIGHBOR_COMMANDS) break
    const topic = neighborTopic(sourceFile)
    if (!topic) continue

    if (isDjangoRepo) {
      for (const dirName of djangoNeighborDirs(cwd, topic)) {
        push(`python tests/runtests.py ${dirName} --parallel 1`)
      }
      continue
    }

    const matches = new Set<string>()
    collectPytestMatches(join(cwd, "tests"), topic, 0, PYTEST_TESTS_DIR_MAX_DEPTH, matches)
    collectPytestMatches(dirname(join(cwd, sourceFile)), topic, 0, 0, matches)
    for (const match of matches) {
      push(`python -m pytest ${relative(cwd, match)} -x -q`)
    }
  }

  return commands
}
