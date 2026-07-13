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
 * F17 — module-package breadth: same-file proximity alone still missed the
 * live case above's OWN sibling (`delete_regress`) whenever the touched
 * file's basename topic doesn't stretch far enough, so this adds an
 * additive second pass keyed on each touched file's parent-package name
 * (dropped when it's a noise stem like `models`/`utils` that would explode
 * into unrelated matches) plus dumb, predictable morphological variants of
 * every stem, searched across every test tree the repo exposes — `tests/`
 * or `test/` at the repo root, and one level below it (covers a top-level
 * package's own `tests/` dir, e.g. `sklearn/tests/`) — never deeper. Same
 * cap, same dedup, proximity always tried first — now itself ranked behind
 * the exact-twin pass below (F19).
 *
 * F19 — Django exact-twin: pass 1's fuzzy `tests/<dir>` substring match
 * (`djangoDirMatchesTopic`) can pick a wrong or overly-broad directory —
 * editing `django/utils/http.py` selected `tests/httpwrappers` on substring
 * overlap alone and missed its real twin, `tests/utils_tests/test_http.py`
 * (pass 2 couldn't reach it either: `utils` is a noise parent stem, and
 * pytest tree roots are disabled for Django repos). For a Django repo this
 * now runs FIRST, ahead of pass 1: for each touched file's basename stem,
 * scans every `tests/<dir>/test_<stem>.py` for an exact filename hit and
 * adds its module-level test command. Ranked ahead of both fuzzy passes so
 * `MAX_NEIGHBOR_COMMANDS` trims fuzzy hits first, never an exact twin.
 *
 * @sem domain=routing role=neighbor-discovery
 */
import { existsSync, readdirSync, type Dirent } from "node:fs"
import { homedir } from "node:os"
import { dirname, extname, join, relative, basename as pathBasename } from "node:path"
import type { VerifyCommand, CommandRunner } from "@opencode-ai/code-intelligence"
import { MISSING_FILE_RE, MODULE_MISSING_RE } from "./slice-orchestrator"

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
 * F17 — parent-package names dropped from module-package breadth: too generic
 * across a Python repo shape (any framework's app layout carries an
 * `__init__`/`utils`/`base`/`core`, and an ORM-shaped one carries a `models`
 * package) to search on without exploding into unrelated matches — verified
 * for `models`: the loose stem-overlap check in `sharesWordStem` alone would
 * match every `model_*` django test dir (`model_forms`, `model_fields`, …)
 * off a 5-of-6-char shared prefix. A file's own basename is never dropped,
 * however generic.
 */
const NOISE_PARENT_STEMS = new Set(["__init__", "utils", "base", "core", "models"])

/**
 * F17 — the module-package breadth stems for one touched source file: its own
 * basename (always kept) plus its parent directory's name, unless that
 * parent is a noise stem or identical to the basename. No cwd relativizing
 * here — the caller only needs a name to search test-tree entries against.
 */
function deriveModuleStems(file: string): string[] {
  const base = pathBasename(file, extname(file))
  const parentDir = dirname(file)
  const parent = parentDir === "." || parentDir === "" ? "" : pathBasename(parentDir)
  const stems = [base]
  if (parent && parent !== base && !NOISE_PARENT_STEMS.has(parent)) stems.push(parent)
  return stems
}

/**
 * F17 — dumb, predictable morphological variants of a stem: the stem itself,
 * minus a trailing "ion", minus a trailing "s" — no stemming library, no
 * recursion between the two strips. Exists because the pytest-style filename
 * match (`pytestFileMatchesTopic`) is a strict prefix check, not the fuzzy
 * `sharesWordStem` django dirs get, so "deletion" alone would never reach a
 * `test_delete_*.py` file without the "ion"-stripped variant.
 */
function stemVariants(stem: string): string[] {
  const variants = new Set([stem])
  if (stem.endsWith("ion")) variants.add(stem.slice(0, -3))
  if (stem.endsWith("s")) variants.add(stem.slice(0, -1))
  return [...variants]
}

/** Safety bound on test-tree roots scanned by breadth discovery — a repo with an unusually wide top-level fan-out must never turn root discovery into a repo-wide walk. */
const MAX_TEST_TREE_ROOTS = 40

/**
 * F17 — every test tree this repo exposes for breadth discovery: `tests/` or
 * `test/` at the repo root, plus one level below root (covers a top-level
 * package's own test dir, e.g. `sklearn/tests/`, `astropy/tests/`) — never
 * deeper, so this stays a bounded directory-existence scan, never a walk.
 */
function discoverTestTreeRoots(cwd: string): string[] {
  const roots: string[] = []
  const testDirNames = ["tests", "test"]
  for (const name of testDirNames) {
    const candidate = join(cwd, name)
    if (existsSync(candidate)) roots.push(candidate)
  }
  let topLevel: Dirent[]
  try {
    topLevel = readdirSync(cwd, { withFileTypes: true })
  } catch {
    return roots
  }
  for (const entry of topLevel) {
    if (roots.length >= MAX_TEST_TREE_ROOTS) break
    if (!entry.isDirectory()) continue
    for (const name of testDirNames) {
      const candidate = join(cwd, entry.name, name)
      if (existsSync(candidate)) roots.push(candidate)
    }
  }
  return roots
}

/**
 * F19 — relativizes an absolute touched-file path against `cwd` before
 * deriving path segments from it. Edit tools report ABSOLUTE paths, so a
 * segment derived from the raw path would carry the cwd's own prefix instead
 * of the repo-local one (the `package=""` bug class `deriveTopLevelPackage`
 * already guards against below — this mirrors that same prefix-strip).
 */
function relativizeToCwd(file: string, cwd: string): string {
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`
  return file.startsWith(prefix) ? file.slice(prefix.length) : file
}

/**
 * F19 — a touched file's basename stem matched against every
 * `tests/<dir>/test_<stem>.py` for an exact filename hit, not the fuzzy
 * substring/word-stem check pass 1 and pass 2 use — the module-level command
 * a hit here returns is precise enough to outrank anything the fuzzy passes
 * find. A missing/unreadable `tests/` dir yields none, never a throw.
 */
function djangoExactTwinCommands(cwd: string, sourceFile: string): string[] {
  const relativized = relativizeToCwd(sourceFile, cwd)
  const stem = pathBasename(relativized, extname(relativized))
  if (!stem) return []
  let entries: Dirent[]
  try {
    entries = readdirSync(join(cwd, "tests"), { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    return []
  }
  const commands: string[] = []
  for (const entry of entries) {
    if (existsSync(join(cwd, "tests", entry.name, `test_${stem}.py`))) {
      commands.push(`python tests/runtests.py ${entry.name}.test_${stem} --parallel 1`)
    }
  }
  return commands
}

/**
 * F19 — every candidate command for ONE touched file, in rank order: Django
 * exact-twin (pass 0), same-file proximity (pass 1), then module-package
 * breadth (pass 2) — identical per-file logic and ordering to the old
 * file-major walk, just scoped to a single file and uncapped (the shared cap
 * is enforced by the caller's round-robin push, not here).
 */
function collectFileNeighborCandidates(
  sourceFile: string,
  cwd: string,
  isDjangoRepo: boolean,
  testTreeRoots: readonly string[],
): string[] {
  const candidates: string[] = []

  // Pass 0 — Django exact-twin (F19), highest rank.
  if (isDjangoRepo) {
    for (const command of djangoExactTwinCommands(cwd, sourceFile)) {
      candidates.push(command)
    }
  }

  // Pass 1 — same-file proximity (F11, unchanged).
  const topic = neighborTopic(sourceFile)
  if (topic) {
    if (isDjangoRepo) {
      for (const dirName of djangoNeighborDirs(cwd, topic)) {
        candidates.push(`python tests/runtests.py ${dirName} --parallel 1`)
      }
    } else {
      const matches = new Set<string>()
      collectPytestMatches(join(cwd, "tests"), topic, 0, PYTEST_TESTS_DIR_MAX_DEPTH, matches)
      collectPytestMatches(dirname(join(cwd, sourceFile)), topic, 0, 0, matches)
      for (const match of matches) {
        candidates.push(`python -m pytest ${relative(cwd, match)} -x -q`)
      }
    }
  }

  // Pass 2 — module-package breadth (F17, additive).
  for (const stem of deriveModuleStems(sourceFile)) {
    for (const variant of stemVariants(stem)) {
      if (isDjangoRepo) {
        for (const dirName of djangoNeighborDirs(cwd, variant)) {
          candidates.push(`python tests/runtests.py ${dirName} --parallel 1`)
        }
        continue
      }

      const matches = new Set<string>()
      for (const root of testTreeRoots) {
        collectPytestMatches(root, variant, 0, PYTEST_TESTS_DIR_MAX_DEPTH, matches)
      }
      for (const match of matches) {
        candidates.push(`python -m pytest ${relative(cwd, match)} -x -q`)
      }
    }
  }

  return candidates
}

/**
 * Discover a small set of pre-existing test commands whose scope plausibly
 * covers `opts.touchedSourceFiles`. Each touched file gets its own
 * rank-ordered candidate list (`collectFileNeighborCandidates`: Django
 * exact-twin, then same-file proximity, then module-package breadth — same
 * per-file ordering as before), and the lists are then filled into the
 * result ROUND-ROBIN across files — file1's 1st, file2's 1st, file1's 2nd,
 * ... — instead of file-major: a django-11885 round-C replay showed one
 * touched file's fuzzy matches (an unrelated scaffolded `models.py`) filling
 * every slot before a second touched file's real neighbors ever got a turn,
 * so no single file's candidates can crowd out another's. A single touched
 * file degenerates to that file's own list in original rank order —
 * unchanged from before this pass.
 *
 * Deduped, capped at `MAX_NEIGHBOR_COMMANDS` overall; a file's own exact
 * twins are still ranked ahead of its own fuzzy hits, so the cap trims fuzzy
 * hits first, never a twin. Returns `[]` when nothing matches so the
 * caller's gate never runs on a guess.
 *
 * @sem domain=routing role=neighbor-discovery
 */
export function discoverNeighborTests(opts: { touchedSourceFiles: readonly string[]; cwd: string }): VerifyCommand[] {
  const { touchedSourceFiles, cwd } = opts
  const commands: VerifyCommand[] = []
  const seen = new Set<string>()
  const pushCommand = (command: string) => {
    if (seen.has(command) || commands.length >= MAX_NEIGHBOR_COMMANDS) return
    seen.add(command)
    commands.push({ kind: "test", command })
  }

  const isDjangoRepo = existsSync(join(cwd, "tests", "runtests.py"))
  const testTreeRoots = isDjangoRepo ? [] : discoverTestTreeRoots(cwd)

  const perFileCandidates = touchedSourceFiles.map((sourceFile) =>
    collectFileNeighborCandidates(sourceFile, cwd, isDjangoRepo, testTreeRoots),
  )

  const maxCandidates = perFileCandidates.reduce((max, list) => Math.max(max, list.length), 0)
  for (let index = 0; index < maxCandidates && commands.length < MAX_NEIGHBOR_COMMANDS; index++) {
    for (const list of perFileCandidates) {
      if (index < list.length) pushCommand(list[index]!)
      if (commands.length >= MAX_NEIGHBOR_COMMANDS) break
    }
  }

  return commands
}

/**
 * F16 — the first regression-gate failure whose output is assertion-shaped:
 * a non-zero exit that does NOT match the environment-crash signatures
 * (`MISSING_FILE_RE`/`MODULE_MISSING_RE`) already used elsewhere to reject a
 * phantom red. An honest neighbor failure held behind a once-per-turn nudge
 * never trips the stuck-escalation backstop (it only counts repro reds) and
 * can ship anyway — the caller pins whatever this returns so the finish gate
 * refuses to close the turn until it's green too. `null` when every failure
 * is env-red or the list is empty.
 *
 * @sem domain=routing role=regression-pin-selection
 */
export function selectRegressionPinCandidate(
  failures: readonly { command: string; exitCode: number; outputTail: string }[],
): { command: string; exitCode: number; outputTail: string } | null {
  return (
    failures.find(
      (f) => f.exitCode !== 0 && !MISSING_FILE_RE.test(f.outputTail) && !MODULE_MISSING_RE.test(f.outputTail),
    ) ?? null
  )
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
