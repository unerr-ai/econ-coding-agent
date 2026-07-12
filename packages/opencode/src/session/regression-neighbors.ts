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
 * F14a — `discoverProjectInterpreter` finds an interpreter that can actually
 * import the touched package before those neighbor commands run: a
 * containerized project image's PATH `python` is frequently a bare
 * interpreter with no project install (observed `ModuleNotFoundError` on a
 * repo only importable from its own venv/conda env), so this probes
 * repo-local venvs, then conda envs, then PATH, each via the injected
 * runner; `rewriteInterpreter` then swaps the winning path into each
 * neighbor command's leading `python`/`python3` token.
 *
 * @sem domain=routing role=neighbor-discovery
 */
import { existsSync, readdirSync, type Dirent } from "node:fs"
import { homedir } from "node:os"
import { dirname, extname, join, relative, basename as pathBasename } from "node:path"
import type { VerifyCommand, CommandRunner } from "@opencode-ai/code-intelligence"

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

// ---------------------------------------------------------------------------
// F14a — project-interpreter discovery: an interpreter that can actually
// import the project, not just any `python` that happens to be on PATH
// ---------------------------------------------------------------------------

/**
 * F15a — the top-level package to probe an interpreter against, derived from a
 * touched source file's path. A model's edit tools report ABSOLUTE paths
 * (e.g. `/testbed/django/db/models/deletion.py`), so this relativizes against
 * `cwd` first when the file falls under it, then applies the existing
 * `src/<pkg>` second-segment rule. A path outside `cwd` (absolute and not a
 * cwd descendant) falls back to its own first non-empty segment — not a real
 * package, but the least-wrong guess, and documented as such. Empty input
 * returns `undefined` so the caller can skip discovery rather than probe
 * garbage.
 *
 * @sem domain=routing role=package-derivation
 */
export function deriveTopLevelPackage(file: string, cwd: string): string | undefined {
  if (!file) return undefined
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`
  const relativized = file.startsWith(prefix) ? file.slice(prefix.length) : file
  const segments = relativized.split("/").filter(Boolean)
  if (segments.length === 0) return undefined
  return segments[0] === "src" ? (segments[1] ?? segments[0]) : segments[0]
}

/** Cap on conda envs enumerated across all conda roots combined — a machine with many envs must never turn discovery into a probe storm. */
const MAX_CONDA_ENVS_PROBED = 8

const PATH_INTERPRETER_CANDIDATES = ["python3", "python"]

/** Repo-local Python environments, checked before any conda/PATH interpreter: `.venv`, `venv`, `env` at the repo root, then every `.tox/<envname>/bin/python` (tox creates one interpreter per test env); a missing `.tox` dir yields none, never a throw. */
function repoLocalVenvCandidates(cwd: string): string[] {
  const candidates = [join(cwd, ".venv", "bin", "python"), join(cwd, "venv", "bin", "python"), join(cwd, "env", "bin", "python")]
  try {
    for (const entry of readdirSync(join(cwd, ".tox"), { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(join(cwd, ".tox", entry.name, "bin", "python"))
    }
  } catch {
    // no .tox directory — tox isn't in use here, fine
  }
  return candidates
}

/** The user's home directory — `process.env.HOME` (the live, testable Unix convention) with `os.homedir()` as a fallback for an environment that doesn't set it. */
function resolvedHomeDir(): string {
  return process.env.HOME || homedir()
}

/** Conda envs across the common install roots (system-wide miniconda/conda, then per-user), enumerated in root order and capped at MAX_CONDA_ENVS_PROBED total; a missing root yields none, never a throw. */
function condaEnvCandidates(): string[] {
  const roots = ["/opt/miniconda3/envs", "/opt/conda/envs", join(resolvedHomeDir(), "miniconda3", "envs"), join(resolvedHomeDir(), "anaconda3", "envs")]
  const candidates: string[] = []
  for (const root of roots) {
    if (candidates.length >= MAX_CONDA_ENVS_PROBED) break
    let entries: Dirent[]
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (candidates.length >= MAX_CONDA_ENVS_PROBED) break
      if (entry.isDirectory()) candidates.push(join(root, entry.name, "bin", "python"))
    }
  }
  return candidates
}

/** The full candidate list in priority order — repo-local venvs, then conda envs, then bare PATH names — deduped and existence-checked (the two bare PATH names are always kept since they resolve via shell PATH lookup, not a filesystem path; any other candidate that doesn't exist is dropped rather than wasting a probe on it). */
function buildInterpreterCandidates(cwd: string): string[] {
  const raw = [...repoLocalVenvCandidates(cwd), ...condaEnvCandidates(), ...PATH_INTERPRETER_CANDIDATES]
  const seen = new Set<string>()
  const deduped = raw.filter((candidate) => (seen.has(candidate) ? false : (seen.add(candidate), true)))
  return deduped.filter((candidate) => PATH_INTERPRETER_CANDIDATES.includes(candidate) || existsSync(candidate))
}

/** The one-liner each candidate is probed with: `python -c` implicitly prepends the cwd (`''`) to `sys.path[0]`, so importing straight away would false-pass ANY interpreter run from the repo root off the filesystem rather than its own installed site-packages — this strips that entry (both shapes it can take) before the import. */
function importProbeCommand(topLevelPackage: string): string {
  return `-c "import sys; sys.path = [p for p in sys.path if p not in ('', '.', sys.path[0] if sys.path else '')]; import ${topLevelPackage}"`
}

/**
 * Finds an interpreter that can actually import `opts.topLevelPackage`, not merely exist on
 * PATH — a containerized project image's PATH `python` is often a base interpreter with no
 * project install, only importable from a repo venv/conda env (observed: `ModuleNotFoundError`
 * running the F11 regression gate's neighbor commands). Probes candidates in priority order
 * (repo-local venvs, then conda envs, then PATH) via the injected runner and returns the first
 * whose import succeeds, or `null` when none do.
 *
 * @sem domain=routing role=interpreter-discovery
 */
export async function discoverProjectInterpreter(opts: {
  cwd: string
  topLevelPackage: string
  runner: CommandRunner
}): Promise<string | null> {
  const { cwd, topLevelPackage, runner } = opts
  for (const candidate of buildInterpreterCandidates(cwd)) {
    const result = await runner({ kind: "guard", command: `${candidate} ${importProbeCommand(topLevelPackage)}` })
    if (result.exitCode === 0) return candidate
  }
  return null
}

/** How many candidates `discoverProjectInterpreter` would probe for `cwd` — used only to size the discovery-failure log's count without shelling out a second time. */
export function projectInterpreterCandidateCount(cwd: string): number {
  return buildInterpreterCandidates(cwd).length
}

/** Replaces the leading `python`/`python3` token of each command — including one following a `cd <dir> && ` prefix — with the discovered absolute interpreter path; a command not shaped like a bare python invocation passes through untouched. */
export function rewriteInterpreter(commands: string[], interpreter: string): string[] {
  const leadingPython = /^((?:cd .+? && )?)(python3?)\b/
  return commands.map((command) => {
    const match = command.match(leadingPython)
    if (!match) return command
    return command.slice(0, match[1].length) + interpreter + command.slice(match[0].length)
  })
}
