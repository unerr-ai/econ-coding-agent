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
 * F20 — graph-derived reach: every filename rung above sees only stem-shaped
 * proximity, so a fix whose blast radius flows through the CALL GRAPH stays
 * invisible (shapely-2226: editing geometry/collection.py regressed
 * test_split/test_clip_by_rect, which reach the edit through ops.py — zero
 * filename overlap; the gate ran collection-stem suites and passed green).
 * `collectGraphNeighborCandidates` walks reverse-call edges from the touched
 * files' entities (one hop to callers, one more hop through non-test caller
 * files, tests-only at the far hop) and hands back runnable commands for the
 * TEST files that call the touched code. Each file's novel ones — not
 * already findable by the filename rungs — slot in AFTER its exact twins and
 * BEFORE its fuzzy hits, capped at `GRAPH_NOVEL_NEIGHBOR_CAP` so proximity
 * is never crowded out. A cold/missing graph degrades to the filename rungs
 * alone — never a false red, never a throw.
 *
 * F21 — `harvestTurnInterpreter` reuses the interpreter from the turn's own
 * green test-shaped run BEFORE F14a's synthetic import probe runs: the probe
 * strips `sys.path[0]` by design, so a Django-project-style package that is
 * only importable from the repo root fails every candidate and the gate
 * skips — while the transcript already holds a command that provably ran the
 * suite (linkding-995: `python -m pytest …` green in-turn, probe missed 2/2,
 * gate skipped, one regression shipped). Observed-green evidence outranks a
 * synthetic probe.
 *
 * H2 (gap-closure-plan §2, round 3) — every rung above keys off entity/
 * filename proximity, which is blind to an import-time blast radius
 * (`isHighP2PBreadthEdit`/`detectsModuleLevelSideEffect`: a module-level
 * statement, a default-arg change, or a base-class edit reaches "every
 * importer", not a reverse-call edge — astropy-13236/8872) and to a
 * zero-selection turn (`findSiblingTestCommand` — the gate's last-resort
 * fallback before it surfaces "unverifiable regression surface" instead of
 * staying silent). H8 — `runDifferentialBaseline` runs the selected set once
 * against pre-edit (HEAD) content so the gate consumer can tell an
 * environment-red (astropy-8707) from a model-induced one; the subtraction
 * itself is the shared claim–evidence kernel's job (`checkClaimCoverage`,
 * `code-intelligence/claim-evidence.ts`), not this module's.
 *
 * P3 (docs/design/agnostic-hands-eyes.md §4.2) — twin/breadth discovery is
 * now table-driven: the Django/pytest passes above read their directory and
 * filename conventions from `ECOSYSTEM_CONVENTIONS`'s `python-django`/
 * `python-pytest` rows instead of inline literals (command strings stay
 * byte-identical — Django's row `suiteCommand`/`singleTestTemplate` values
 * round-trip exactly, pytest's neighbor command keeps its established
 * `python -m pytest … -x -q` shape, which the row's generic single-test
 * template doesn't carry). `selectNonPythonEcosystem` resolves the repo
 * profile's non-python ecosystem (js/go/rust/java) when neither Django nor a
 * bare python repo applies, and `collectNonPythonNeighborCandidates` forms
 * runner-appropriate twin commands from that ecosystem's row data — one
 * small adapter per runner shape (jest/vitest path substitution, go's
 * same-package `_test.go`, rust's `tests/<stem>.rs` integration crate,
 * java's `src/test/java` mirror path), never a hardcoded framework branch.
 *
 * P2 (docs/design/agnostic-hands-eyes.md §2.3) — `discoverProjectToolchain`
 * generalizes F14a's python-only venv/conda/PATH ladder
 * (`discoverProjectInterpreter`, unchanged, still the python rung) into a
 * per-ecosystem probe: `mise which <tool>` when a mise binary is on PATH and
 * a `.tool-versions`/`mise.toml` pin exists, else a minimal ecosystem ladder
 * (node: `.nvmrc`-aware then PATH; go/rust/java: PATH). F21's
 * `harvestTurnInterpreter` is unaffected and still tried first at the call
 * site. `runBuildCheckRung` adds the build-first discipline: when the
 * resolved ecosystem's row carries a `buildCheck` (compiled targets —
 * python's row carries none, so this never fires for a Python repo), it
 * runs once via the injected runner before any neighbor test command and
 * reports a `build_check_red` signal on failure — a deterministic compile
 * block, never conflated with a test red.
 *
 * @sem domain=routing role=neighbor-discovery
 */
import { existsSync, readFileSync, readdirSync, unlinkSync, type Dirent } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, extname, join, relative, basename as pathBasename } from "node:path"
import {
  runRegressionGate,
  type VerifyCommand,
  type CommandRunner,
  type CommandResult,
} from "@opencode-ai/code-intelligence"
import { MISSING_FILE_RE, MODULE_MISSING_RE } from "./slice-orchestrator"
import { TEST_SHAPED_COMMAND_RE, LAUNDERED_FAILURE_SIGNATURE_RE, INTERPRETER_TOKEN_RE } from "./seen-red"
import type { SeenRedExecution } from "./seen-red"
import { isTestLikePath } from "../tool/graph-tools"
import { ECOSYSTEM_CONVENTIONS, getRepoProfileSync, type EcosystemProfile } from "../code-intelligence/repo-profile"
import { detectAndParseTestReport } from "../code-intelligence/test-report"

const MAX_NEIGHBOR_COMMANDS = 3
/** Bound on the recursive descent under `<cwd>/tests/` for the pytest-style fallback. */
const PYTEST_TESTS_DIR_MAX_DEPTH = 3
// F20 bounds — entities walked per touched file, distinct non-test hop-1
// caller files walked onward, and graph candidates kept per touched file
// (before the novel-only merge cap below).
const GRAPH_NEIGHBOR_ENTITY_CAP = 12
const GRAPH_NEIGHBOR_HOP1_FILE_CAP = 8
const GRAPH_NEIGHBOR_CANDIDATES_PER_FILE = 4
/** Graph candidates admitted per touched file into the merged rank — leaves ≥1 of `MAX_NEIGHBOR_COMMANDS` slots for same-file proximity on a single-file turn. */
const GRAPH_NOVEL_NEIGHBOR_CAP = 2

// P3 — the python/Django conventions rows, looked up once so the legacy
// rungs below read their directory/filename literals from the table instead
// of re-declaring them (djangoExactTwinCommands/pytestFileMatchesTopic
// "become the row's behavior" per the design doc, without changing the
// byte-identical command strings those rungs already produce).
const PYTHON_DJANGO_ROW = ECOSYSTEM_CONVENTIONS.find((row) => row.id === "python-django")!
const PYTHON_PYTEST_ROW = ECOSYSTEM_CONVENTIONS.find((row) => row.id === "python-pytest")!
const DJANGO_TEST_DIR = PYTHON_DJANGO_ROW.testDirs[0]!
const [DJANGO_TEST_FILE_PREFIX] = PYTHON_DJANGO_ROW.testFilePatterns.find((p) => p.startsWith("test_"))!.split("*")
const [PYTEST_TEST_FILE_PREFIX] = PYTHON_PYTEST_ROW.testFilePatterns.find((p) => p.startsWith("test_"))!.split("*")
const [, PYTEST_TEST_FILE_SUFFIX] = PYTHON_PYTEST_ROW.testFilePatterns.find((p) => p.endsWith("_test.py"))!.split("*")

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
    entries = readdirSync(join(cwd, DJANGO_TEST_DIR), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
  return entries.filter((dirName) => djangoDirMatchesTopic(topic, dirName))
}

/** pytest naming (python-pytest row's `testFilePatterns`): `test_<topic>*.py` or `<topic>*_test.py`. */
function pytestFileMatchesTopic(fileName: string, topic: string): boolean {
  if (!topic || !fileName.endsWith(".py")) return false
  return (
    fileName.startsWith(`${PYTEST_TEST_FILE_PREFIX}${topic}`) ||
    (fileName.startsWith(topic) && fileName.endsWith(PYTEST_TEST_FILE_SUFFIX))
  )
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
  const testDirNames = PYTHON_PYTEST_ROW.testDirs
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
    entries = readdirSync(join(cwd, DJANGO_TEST_DIR), { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    return []
  }
  const commands: string[] = []
  for (const entry of entries) {
    if (existsSync(join(cwd, DJANGO_TEST_DIR, entry.name, `${DJANGO_TEST_FILE_PREFIX}${stem}.py`))) {
      commands.push(PYTHON_DJANGO_ROW.singleTestTemplate.replace("{testId}", `${entry.name}.${DJANGO_TEST_FILE_PREFIX}${stem} --parallel 1`))
    }
  }
  return commands
}

// ---------------------------------------------------------------------------
// P3 (agnostic-hands-eyes.md §4.2) — table-driven twin discovery for a
// non-python ecosystem resolved via the repo profile (js/go/rust/java): the
// row's own testDirs/testFilePatterns/single-test template ARE the
// behavior, one small per-runner command adapter each (the runner's own
// invocation syntax — a file path vs. a package path vs. a class name —
// isn't captured by one generic template, the same reason the pytest/Django
// rungs above keep their own command shape).
// ---------------------------------------------------------------------------

/** Touched file's stem checked against a row's declared testDirs (ecosystem-root-relative) plus its own directory (co-located tests) for a filename matching one of `filePatterns` (single "*" substituted with the stem) — matched test file paths relative to `cwd`, nearest (same-directory) first. */
function collectEcosystemFileMatches(
  cwd: string,
  ecoRoot: string,
  sourceFile: string,
  dirs: readonly string[],
  filePatterns: readonly string[],
): string[] {
  const relSource = relativizeToCwd(sourceFile, cwd)
  const stem = pathBasename(relSource, extname(relSource))
  if (!stem) return []
  const sourceDir = dirname(relSource)
  const roots = [join(cwd, sourceDir), ...dirs.map((dir) => join(cwd, ecoRoot, dir))]
  const seen = new Set<string>()
  const matches: string[] = []
  for (const root of roots) {
    let entries: Dirent[]
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (!filePatterns.some((pattern) => pattern.replace("*", stem) === entry.name)) continue
      const rel = relative(cwd, join(root, entry.name))
      if (seen.has(rel)) continue
      seen.add(rel)
      matches.push(rel)
    }
  }
  return matches
}

/** js/ts (jest/vitest row): the matched twin file's path substituted into the row's single-test template — e.g. `npx jest __tests__/foo.test.ts`, not a bare file-existence check. */
function jsTwinCommands(cwd: string, eco: EcosystemProfile, sourceFile: string): string[] {
  const tests = eco.tests
  if (!("runner" in tests)) return []
  return collectEcosystemFileMatches(cwd, eco.root, sourceFile, tests.conventions.dirs, tests.conventions.filePatterns).map((relTest) =>
    tests.single.replace("{testId}", relTest),
  )
}

/** go: same-package `<stem>_test.go` twin (`conventions.dirs` is empty — go tests live beside the source, never a separate tree) — a package-scoped `go test ./<pkgDir>`, since `-run` takes a test NAME, not a file path. */
function goTwinCommands(cwd: string, eco: EcosystemProfile, sourceFile: string): string[] {
  const tests = eco.tests
  if (!("runner" in tests)) return []
  const relSource = relativizeToCwd(sourceFile, cwd)
  if (extname(relSource) !== ".go") return []
  const stem = pathBasename(relSource, ".go")
  if (!stem) return []
  const pkgDir = dirname(relSource)
  if (!existsSync(join(cwd, pkgDir, `${stem}_test.go`))) return []
  return [`${tests.runner} ${pkgDir === "." ? "./..." : `./${pkgDir}`}`]
}

/** rust: `tests/<stem>.rs` integration-crate twin — `cargo test --test <stem>` via the row's single-test template. */
function rustTwinCommands(cwd: string, eco: EcosystemProfile, sourceFile: string): string[] {
  const tests = eco.tests
  if (!("runner" in tests)) return []
  const relSource = relativizeToCwd(sourceFile, cwd)
  if (extname(relSource) !== ".rs") return []
  const stem = pathBasename(relSource, ".rs")
  if (!stem) return []
  const commands: string[] = []
  for (const dir of tests.conventions.dirs) {
    if (existsSync(join(cwd, eco.root, dir, `${stem}.rs`))) {
      commands.push(tests.single.replace("{testId}", `--test ${stem}`))
    }
  }
  return commands
}

/** java: `src/test/java/<pkg>/<Stem>Test.java` mirror-path twin — the package subpath under `src/main/java` reproduced under the row's test dir, class name from `filePatterns`, command from the row's single-test template. */
function javaTwinCommands(cwd: string, eco: EcosystemProfile, sourceFile: string): string[] {
  const tests = eco.tests
  if (!("runner" in tests)) return []
  const relSource = relativizeToCwd(sourceFile, cwd)
  if (extname(relSource) !== ".java") return []
  const marker = "src/main/java/"
  const markerIdx = relSource.indexOf(marker)
  if (markerIdx === -1) return []
  const stem = pathBasename(relSource, ".java")
  const pkgPath = dirname(relSource.slice(markerIdx + marker.length))
  const commands: string[] = []
  const seen = new Set<string>()
  for (const dir of tests.conventions.dirs) {
    for (const pattern of tests.conventions.filePatterns) {
      const fileName = pattern.replace("*", stem)
      const className = fileName.replace(/\.java$/, "")
      const candidate = join(cwd, eco.root, dir, pkgPath === "." ? "" : pkgPath, fileName)
      if (!existsSync(candidate) || seen.has(className)) continue
      seen.add(className)
      commands.push(tests.single.replace("{testId}", className))
    }
  }
  return commands
}

/** One row-driven twin pass for a non-python ecosystem, dispatched by language — the row's own data (dirs/patterns/templates) is the behavior, this is just the per-runner invocation-syntax adapter (see the section header above). */
function collectNonPythonNeighborCandidates(cwd: string, eco: EcosystemProfile, sourceFile: string): string[] {
  switch (eco.language) {
    case "javascript":
    case "typescript":
      return jsTwinCommands(cwd, eco, sourceFile)
    case "go":
      return goTwinCommands(cwd, eco, sourceFile)
    case "rust":
      return rustTwinCommands(cwd, eco, sourceFile)
    case "java":
      return javaTwinCommands(cwd, eco, sourceFile)
    default:
      return []
  }
}

/**
 * P3 — the repo profile's ecosystem to drive table-driven twin discovery
 * when the repo is neither Django nor python-shaped (the caller only calls
 * this once `isDjangoRepo` is false): the resolved (non-`unknown`,
 * non-python) ecosystem whose root the touched files fall under, preferring
 * a root match over the profile's first entry when a monorepo resolves more
 * than one. `null` when the profile finds nothing but python/unknown — the
 * caller falls back to the legacy pytest-shaped rungs, today's default,
 * unchanged.
 */
function selectNonPythonEcosystem(cwd: string, touchedSourceFiles: readonly string[]): EcosystemProfile | null {
  const profile = getRepoProfileSync(cwd)
  const candidates = profile.ecosystems.filter((eco) => eco.language !== "unknown" && eco.language !== "python" && "runner" in eco.tests)
  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]!
  for (const file of touchedSourceFiles) {
    const rel = relativizeToCwd(file, cwd)
    const match = candidates.find((eco) => eco.root !== "." && rel.startsWith(`${eco.root}/`))
    if (match) return match
  }
  return candidates[0]!
}

/**
 * F19 — every candidate command for ONE touched file, in rank order: Django
 * exact-twin (pass 0), same-file proximity (pass 1), then module-package
 * breadth (pass 2) — identical per-file logic and ordering to the old
 * file-major walk, just scoped to a single file and uncapped (the shared cap
 * is enforced by the caller's round-robin push, not here). P3 — when the
 * caller resolves a non-python ecosystem (`nonPythonEco`), this instead
 * returns that ecosystem's row-driven twin pass plus the same F20
 * graph-novel merge; Django/python are unaffected.
 */
function collectFileNeighborCandidates(
  sourceFile: string,
  cwd: string,
  isDjangoRepo: boolean,
  testTreeRoots: readonly string[],
  graphCandidates: readonly string[] = [],
  nonPythonEco: EcosystemProfile | null = null,
): string[] {
  if (nonPythonEco) {
    const twins = collectNonPythonNeighborCandidates(cwd, nonPythonEco, sourceFile)
    const known = new Set(twins)
    const graphNovel = graphCandidates.filter((c) => !known.has(c)).slice(0, GRAPH_NOVEL_NEIGHBOR_CAP)
    return [...twins, ...graphNovel]
  }

  // Pass 0 — Django exact-twin (F19), highest rank.
  const twins: string[] = []
  if (isDjangoRepo) {
    for (const command of djangoExactTwinCommands(cwd, sourceFile)) {
      twins.push(command)
    }
  }

  const fuzzy: string[] = []

  // Pass 1 — same-file proximity (F11, unchanged).
  const topic = neighborTopic(sourceFile)
  if (topic) {
    if (isDjangoRepo) {
      for (const dirName of djangoNeighborDirs(cwd, topic)) {
        fuzzy.push(`python tests/runtests.py ${dirName} --parallel 1`)
      }
    } else {
      const matches = new Set<string>()
      collectPytestMatches(join(cwd, "tests"), topic, 0, PYTEST_TESTS_DIR_MAX_DEPTH, matches)
      collectPytestMatches(dirname(join(cwd, sourceFile)), topic, 0, 0, matches)
      for (const match of matches) {
        fuzzy.push(`python -m pytest ${relative(cwd, match)} -x -q`)
      }
    }
  }

  // Pass 2 — module-package breadth (F17, additive).
  for (const stem of deriveModuleStems(sourceFile)) {
    for (const variant of stemVariants(stem)) {
      if (isDjangoRepo) {
        for (const dirName of djangoNeighborDirs(cwd, variant)) {
          fuzzy.push(`python tests/runtests.py ${dirName} --parallel 1`)
        }
        continue
      }

      const matches = new Set<string>()
      for (const root of testTreeRoots) {
        collectPytestMatches(root, variant, 0, PYTEST_TESTS_DIR_MAX_DEPTH, matches)
      }
      for (const match of matches) {
        fuzzy.push(`python -m pytest ${relative(cwd, match)} -x -q`)
      }
    }
  }

  // Pass 0.5 — graph-derived reach (F20): only candidates the filename rungs
  // could NOT find (novelty = exact command-string dedup, both sides share
  // one formation), ranked after this file's exact twins and before its
  // fuzzy hits, capped so proximity keeps a slot under the overall cap.
  const known = new Set([...twins, ...fuzzy])
  const graphNovel = graphCandidates.filter((c) => !known.has(c)).slice(0, GRAPH_NOVEL_NEIGHBOR_CAP)

  return [...twins, ...graphNovel, ...fuzzy]
}

/**
 * Discover a small set of pre-existing test commands whose scope plausibly
 * covers `opts.touchedSourceFiles`. Each touched file gets its own
 * rank-ordered candidate list (`collectFileNeighborCandidates`: Django
 * exact-twin, then novel graph-derived reach (F20) when the caller supplies
 * it, then same-file proximity, then module-package breadth), and the lists
 * are then filled into the
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
 * P3 — for a repo whose profile resolves a non-python ecosystem (js/go/
 * rust/java — `selectNonPythonEcosystem`), each file's candidate list
 * instead comes from that ecosystem's row-driven twin pass
 * (`collectNonPythonNeighborCandidates`) plus the same F20 graph-novel
 * merge; Django and pytest repos are unaffected.
 *
 * @sem domain=routing role=neighbor-discovery
 */
export function discoverNeighborTests(opts: {
  touchedSourceFiles: readonly string[]
  cwd: string
  /** F20 — per-touched-file graph-derived commands from `collectGraphNeighborCandidates`; absent/empty = filename rungs only. */
  graphCandidates?: ReadonlyMap<string, readonly string[]>
}): VerifyCommand[] {
  const { touchedSourceFiles, cwd, graphCandidates } = opts
  const commands: VerifyCommand[] = []
  const seen = new Set<string>()
  const pushCommand = (command: string) => {
    if (seen.has(command) || commands.length >= MAX_NEIGHBOR_COMMANDS) return
    seen.add(command)
    commands.push({ kind: "test", command })
  }

  const isDjangoRepo = existsSync(join(cwd, "tests", "runtests.py"))
  // P3 — table-driven discovery for a non-python ecosystem; python/Django
  // stay on the legacy rungs below, unchanged (the byte-parity requirement).
  const nonPythonEco = isDjangoRepo ? null : selectNonPythonEcosystem(cwd, touchedSourceFiles)
  const testTreeRoots = isDjangoRepo || nonPythonEco ? [] : discoverTestTreeRoots(cwd)

  const perFileCandidates = touchedSourceFiles.map((sourceFile) =>
    collectFileNeighborCandidates(
      sourceFile,
      cwd,
      isDjangoRepo,
      testTreeRoots,
      graphCandidates?.get(sourceFile) ?? [],
      nonPythonEco,
    ),
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

// ---------------------------------------------------------------------------
// H2.1/H2.4 — import-time side-effect heuristic + high-P2P-breadth
// classification (gap-closure-plan.md §2 H2, round 3)
// ---------------------------------------------------------------------------

/** One new/changed source line in `newContent`, paired with the line right after it (undefined at EOF) — the lookahead a class-decorator check needs to confirm a decorator sits directly above a `class` line, not a `def`. A simple line-set diff against `oldContent` (not an LCS/patience diff) — good enough to flag added/changed statements without a full parser. */
function newSourceLines(oldContent: string, newContent: string): { line: string; next: string | undefined }[] {
  const oldSet = new Set(oldContent.split("\n"))
  const lines = newContent.split("\n")
  const changed: { line: string; next: string | undefined }[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!oldSet.has(line)) changed.push({ line, next: lines[i + 1] })
  }
  return changed
}

const MODULE_CLASS_DECORATOR_RE = /^@\w/
const MODULE_WARNING_RE = /\bwarnings?\.(?:warn|deprecat\w*)\(|(?:^|[^\w.])warn\(/
const MODULE_MUTATION_RE =
  /^[A-Za-z_][\w.]*(?:\[[^\]]*\])?\s*(?:\+=|-=|\*=|\/=|\|=|&=)|^[A-Za-z_][\w.]*\.(?:register|append|update|setdefault|add|extend)\(|^os\.environ\[/
const MODULE_DEFINITION_KEYWORD_RE =
  /^(?:def\b|class\b|import\b|from\b|if\b|elif\b|else\b|try\b|except\b|finally\b|with\b|for\b|while\b|return\b)/
const MODULE_BARE_CALL_RE = /^[A-Za-z_][\w.]*\([^()]*\)\s*$/

/** True when `entry.line` is an unindented (module-scope) statement carrying an import-time side effect: a decorator directly above a module-level `class`, warning emission, global/registry/env mutation, or a bare call statement (neither an assignment nor a def/class/import/control-flow line). Never matches an indented line (function/class body) or a comment/blank line. */
function isModuleLevelSideEffectLine(entry: { line: string; next: string | undefined }): boolean {
  const { line, next } = entry
  if (/^\s/.test(line)) return false
  const trimmed = line.trimEnd()
  if (trimmed === "" || trimmed.startsWith("#")) return false
  if (MODULE_CLASS_DECORATOR_RE.test(trimmed)) return next !== undefined && /^class\s+\w/.test(next)
  if (MODULE_WARNING_RE.test(trimmed)) return true
  if (MODULE_MUTATION_RE.test(trimmed)) return true
  if (MODULE_BARE_CALL_RE.test(trimmed) && !MODULE_DEFINITION_KEYWORD_RE.test(trimmed)) return true
  return false
}

/**
 * H2.1 — import-time side-effect heuristic (deterministic text check): true
 * when the edit adds or changes a module-level executable statement absent
 * from `oldContent` — a warning emission, global/registry/env mutation, a
 * bare module-level call, or a decorator applied directly to a module-level
 * class. This blast radius is "everyone who imports the module", invisible
 * to the F20 call-graph walk (astropy-13236: a bare module-level
 * `warnings.warn(DeprecationWarning)` broke 644 P2P tests behind zero graph
 * neighbors — the gate silently passed). `oldContent` empty/absent (a
 * brand-new file) never trips this — there is no prior silent behavior to
 * break.
 *
 * @sem domain=routing role=side-effect-detection
 */
export function detectsModuleLevelSideEffect(oldContent: string, newContent: string): boolean {
  if (!oldContent) return false
  return newSourceLines(oldContent, newContent).some(isModuleLevelSideEffectLine)
}

// H2.4 — the two other high-P2P-breadth shapes beyond a module-level side
// effect: a default-argument change (dtype/default-behavior — changes every
// caller relying on the default, not just ones the graph walks) and a
// class's base-list edit (astropy-8872: a base-class change broke 80 P2P
// tests behind a 3-file green neighbor subset).
const DEFAULT_ARG_DEF_RE = /^\s*(?:async\s+)?def\s+\w+\([^)]*=/
const BASE_CLASS_DEF_RE = /^class\s+\w+\([^)]+\)\s*:/

/**
 * H2.4 — high-P2P-breadth classification: true when the edit's shape is one
 * whose blast radius the graph/filename neighbor rungs systematically
 * under-reach — a module-level side effect (`detectsModuleLevelSideEffect`),
 * a function/method default-argument change, or a class base-list edit. The
 * gate consumer widens selection BEFORE running for this class rather than
 * promoting a narrow green subset to "no regressions" after the fact
 * (8872's 3-file green subset shipped 80 broken P2P tests) — every green
 * verdict still states its real verified scope regardless.
 *
 * @sem domain=routing role=side-effect-detection
 */
export function isHighP2PBreadthEdit(oldContent: string, newContent: string): boolean {
  if (!oldContent) return false
  return newSourceLines(oldContent, newContent).some(
    (entry) => isModuleLevelSideEffectLine(entry) || DEFAULT_ARG_DEF_RE.test(entry.line) || BASE_CLASS_DEF_RE.test(entry.line),
  )
}

/** Cap on H2.1/H2.4 widened neighbor commands — a high-P2P-breadth edit's blast radius is "the whole package", but the gate's wall-clock budget (H2.3) still bounds how much of it gets run. */
const SIDE_EFFECT_WIDEN_CAP = 5

/**
 * H2.1/H2.4 widening: when `isHighP2PBreadthEdit` fires for `sourceFile`,
 * the normal filename/graph neighbor rungs (which key off entity/filename
 * proximity) are not enough — this widens selection to the touched module's
 * own full test file (its usual filename-rung candidates) plus every other
 * test file under its top-level package's test directory, capped at
 * `SIDE_EFFECT_WIDEN_CAP`.
 *
 * @sem domain=routing role=neighbor-discovery
 */
export function widenForModuleSideEffect(sourceFile: string, cwd: string): VerifyCommand[] {
  const isDjangoRepo = existsSync(join(cwd, "tests", "runtests.py"))
  const commands: string[] = []
  const seen = new Set<string>()
  const push = (command: string) => {
    if (seen.has(command) || commands.length >= SIDE_EFFECT_WIDEN_CAP) return
    seen.add(command)
    commands.push(command)
  }

  for (const command of collectFileNeighborCandidates(sourceFile, cwd, isDjangoRepo, discoverTestTreeRoots(cwd))) {
    push(command)
  }

  const pkg = deriveTopLevelPackage(sourceFile, cwd)
  if (pkg) {
    if (isDjangoRepo) {
      push(`python tests/runtests.py ${pkg} --parallel 1`)
    } else {
      const pkgTestDir = join(cwd, pkg, "tests")
      let entries: Dirent[]
      try {
        entries = readdirSync(pkgTestDir, { withFileTypes: true })
      } catch {
        entries = []
      }
      for (const entry of entries) {
        if (commands.length >= SIDE_EFFECT_WIDEN_CAP) break
        if (entry.isFile() && /^test_.*\.py$/.test(entry.name)) {
          push(`python -m pytest ${relative(cwd, join(pkgTestDir, entry.name))} -x -q`)
        }
      }
    }
  }

  return commands.map((command) => ({ kind: "test" as const, command }))
}

/**
 * H2.2 — fail-loud fallback: the touched file's own sibling test file (same
 * directory, conventional naming — `test_<stem>.py`/`<stem>_test.py` for
 * Python, `<stem>.test.<ext>`/`<stem>.spec.<ext>` otherwise). Tried only
 * when every rung above (filename, graph, H2.1/H2.4 widened) selected
 * nothing — a non-trivial edit whose regression lane picks zero tests is a
 * converting signal, never silence; the caller surfaces "unverifiable
 * regression surface" when this also returns `null`.
 *
 * @sem domain=routing role=neighbor-discovery
 */
export function findSiblingTestCommand(file: string, cwd: string): VerifyCommand | null {
  const relFile = relativizeToCwd(file, cwd)
  const dir = dirname(relFile)
  const ext = extname(relFile)
  const stem = pathBasename(relFile, ext)
  if (!stem) return null
  const tryNames = (names: readonly string[], commandFor: (rel: string) => string): VerifyCommand | null => {
    for (const name of names) {
      const relCandidate = dir === "." ? name : join(dir, name)
      if (existsSync(join(cwd, relCandidate))) return { kind: "test", command: commandFor(relCandidate) }
    }
    return null
  }
  if (ext === ".py") {
    return tryNames([`test_${stem}.py`, `${stem}_test.py`], (rel) => `python -m pytest ${rel} -x -q`)
  }
  return tryNames([`${stem}.test${ext}`, `${stem}.spec${ext}`], (rel) => `bun test ${rel}`)
}

/** Minimal reverse-call query surface F20 needs — structurally satisfied by BunSqliteGraph; unit tests inject a fake. */
export interface NeighborGraphPort {
  getEntitiesInFile(filePath: string): Promise<{ name: string; filePath: string; kind: string }[]>
  getCallers(entityKey: string): Promise<{ from_file: string; from_entity: string }[]>
}

/** A graph file path relativized against `cwd` — BunSqliteGraph rows may carry absolute or root-relative paths depending on the query. */
function relativeToCwd(file: string, cwd: string): string {
  return file.startsWith("/") ? relative(cwd, file) : file
}

/**
 * The test files reachable from `sourceFile`'s entities over reverse-call
 * edges: hop 1 collects test-file callers directly and remembers non-test
 * caller files (with WHICH entities called in, so hop 2 walks only those,
 * never a whole file's unrelated exports); hop 2 collects test-file callers
 * of those entities and never widens further. Insertion order is depth
 * order, so nearer tests rank first; files the graph knows but the disk no
 * longer holds are dropped.
 */
async function graphReachableTestFiles(sourceFile: string, cwd: string, graph: NeighborGraphPort): Promise<string[]> {
  const testFiles = new Set<string>()
  const hop1CallerEntities = new Map<string, Set<string>>()

  const entities = (await graph.getEntitiesInFile(sourceFile)).slice(0, GRAPH_NEIGHBOR_ENTITY_CAP)
  for (const entity of entities) {
    for (const ref of await graph.getCallers(`${entity.filePath}:${entity.name}:${entity.kind}`)) {
      const rel = relativeToCwd(ref.from_file, cwd)
      if (rel === sourceFile || rel.startsWith("..")) continue
      if (isTestLikePath(rel)) {
        testFiles.add(rel)
      } else if (hop1CallerEntities.size < GRAPH_NEIGHBOR_HOP1_FILE_CAP || hop1CallerEntities.has(rel)) {
        const names = hop1CallerEntities.get(rel) ?? new Set<string>()
        names.add(ref.from_entity)
        hop1CallerEntities.set(rel, names)
      }
    }
  }

  for (const [callerFile, callerNames] of hop1CallerEntities) {
    const callerEntities = (await graph.getEntitiesInFile(callerFile))
      .filter((entity) => callerNames.has(entity.name))
      .slice(0, GRAPH_NEIGHBOR_ENTITY_CAP)
    for (const entity of callerEntities) {
      for (const ref of await graph.getCallers(`${entity.filePath}:${entity.name}:${entity.kind}`)) {
        const rel = relativeToCwd(ref.from_file, cwd)
        if (rel.startsWith("..")) continue
        if (isTestLikePath(rel)) testFiles.add(rel)
      }
    }
  }

  return [...testFiles].filter((rel) => existsSync(join(cwd, rel)))
}

/** Forms the runnable command for one graph-reached test file, matching the filename rungs' formation byte-for-byte so the novelty dedup in `collectFileNeighborCandidates` works on exact strings. Non-runnable shapes (a Django test file outside `tests/`, a non-Python file) return null. */
function graphTestFileCommand(relTestFile: string, isDjangoRepo: boolean): string | null {
  if (isDjangoRepo) {
    const segments = relTestFile.split("/")
    if (segments[0] === "tests" && segments.length >= 2 && segments[1]) {
      return `python tests/runtests.py ${segments[1]} --parallel 1`
    }
    return null
  }
  if (extname(relTestFile) !== ".py") return null
  return `python -m pytest ${relTestFile} -x -q`
}

/**
 * F20 — graph-derived neighbor reach: per touched file, the runnable test
 * commands for TEST files that call the touched code (reverse-call walk,
 * two bounded hops — see `graphReachableTestFiles`), the blast radius the
 * filename rungs cannot see (shapely-2226's gate passed green on
 * collection-stem suites while call-graph neighbors test_split /
 * test_clip_by_rect broke through ops.py). Any per-file graph error or an
 * unindexed file degrades to an empty entry so the F11 gate falls back to
 * pure filename discovery — never a false red, never a throw.
 *
 * @sem domain=routing role=neighbor-discovery
 */
export async function collectGraphNeighborCandidates(opts: {
  touchedSourceFiles: readonly string[]
  cwd: string
  graph: NeighborGraphPort
}): Promise<Map<string, string[]>> {
  const { touchedSourceFiles, cwd, graph } = opts
  const isDjangoRepo = existsSync(join(cwd, "tests", "runtests.py"))
  const result = new Map<string, string[]>()
  for (const sourceFile of touchedSourceFiles) {
    try {
      const commands: string[] = []
      for (const rel of await graphReachableTestFiles(sourceFile, cwd, graph)) {
        if (commands.length >= GRAPH_NEIGHBOR_CANDIDATES_PER_FILE) break
        const command = graphTestFileCommand(rel, isDjangoRepo)
        if (command && !commands.includes(command)) commands.push(command)
      }
      if (commands.length > 0) result.set(sourceFile, commands)
    } catch {
      // Graph unavailable or partial for this file — the filename rungs still run.
    }
  }
  return result
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

// ---------------------------------------------------------------------------
// P2 (agnostic-hands-eyes.md §2.3) — per-ecosystem toolchain probe ladder +
// build-first rung. `discoverProjectInterpreter` above stays byte-identical
// (it IS the python row's ladder); this section only adds the generalized
// path for the other ecosystems, additive alongside the python call sites
// above.
// ---------------------------------------------------------------------------

export type ToolchainEcosystem = "python" | "javascript" | "typescript" | "go" | "rust" | "java"

/** The toolchain binary `mise which <tool>` resolves per ecosystem — python has no entry here, `discoverProjectToolchain` routes it straight to `discoverProjectInterpreter` instead. */
const ECOSYSTEM_TOOL_BIN: Readonly<Record<Exclude<ToolchainEcosystem, "python">, string>> = {
  javascript: "node",
  typescript: "node",
  go: "go",
  rust: "cargo",
  java: "java",
}

/** `mise which <tool>` when a mise binary is on PATH and a `.tool-versions`/`mise.toml` pin exists at `cwd` — the pinned resolution a human running `mise` would get, tried before the ecosystem's own minimal ladder. `null` on any miss (no pin, no mise binary, or the probe fails), never a throw. */
async function tryMiseResolve(cwd: string, tool: string, runner: CommandRunner): Promise<string | null> {
  const hasPin = existsSync(join(cwd, ".tool-versions")) || existsSync(join(cwd, "mise.toml"))
  if (!hasPin) return null
  const miseCheck = await runner({ kind: "guard", command: "mise --version" })
  if (miseCheck.exitCode !== 0) return null
  const resolved = await runner({ kind: "guard", command: `mise which ${tool}` })
  if (resolved.exitCode !== 0) return null
  const path = resolved.stdout.trim().split(/\r?\n/)[0]
  return path || null
}

/** node's minimal ladder: an `.nvmrc`-pinned install under `~/.nvm/versions/node/<v>/bin/node` (tried first when the pin file names a version), then the bare PATH `node` — no venv/conda concept outside python, so this is the whole ladder. */
function nodeCandidates(cwd: string): string[] {
  const nvmrcPath = join(cwd, ".nvmrc")
  if (existsSync(nvmrcPath)) {
    const version = readFileSync(nvmrcPath, "utf8").split(/\r?\n/)[0]?.trim()
    if (version) {
      const tagged = version.startsWith("v") ? version : `v${version}`
      return [join(resolvedHomeDir(), ".nvm", "versions", "node", tagged, "bin", "node"), "node"]
    }
  }
  return ["node"]
}

/** go/rust/java's minimal ladder: PATH only — their pin files (`go.mod toolchain`, `rust-toolchain.toml`, none for java) are already read for `versions.language` by `repo-profile.ts`; this ladder is just which BINARY to probe, and none of these ecosystems install multiple side-by-side toolchains reachable without a version manager (mise covers that case above). */
function buildEcosystemCandidates(cwd: string, ecosystem: Exclude<ToolchainEcosystem, "python">): string[] {
  if (ecosystem === "javascript" || ecosystem === "typescript") return nodeCandidates(cwd)
  return [ECOSYSTEM_TOOL_BIN[ecosystem]]
}

/**
 * P3 — resolves the single `EcosystemProfile` governing `touchedSourceFiles`:
 * `selectNonPythonEcosystem`'s own resolution (F19/F20's non-python neighbor
 * discovery already keys off this) when the repo isn't Django/python-shaped,
 * else the profile's python row when one exists. `undefined` only when the
 * profile resolves neither — a python/unknown repo with no ecosystem
 * evidence at all, unchanged from today's behavior. The one lookup the
 * regression lane's toolchain probe (`resolveToolchainEcosystem` below) and
 * structured-report capture (`runStructuredTestCommand`) both key off, so
 * they always agree with `discoverNeighborTests`'s own resolution.
 *
 * @sem domain=routing role=toolchain-discovery
 */
export function resolveActiveEcosystem(
  cwd: string,
  touchedSourceFiles: readonly string[],
): EcosystemProfile | undefined {
  const nonPythonEco = selectNonPythonEcosystem(cwd, touchedSourceFiles)
  if (nonPythonEco) return nonPythonEco
  return getRepoProfileSync(cwd).ecosystems.find((eco) => eco.language === "python")
}

/**
 * P3 — the `resolveActiveEcosystem` above, narrowed to the toolchains
 * `discoverProjectToolchain` actually probes (`ECOSYSTEM_TOOL_BIN`'s keys).
 * Falls back to `"python"` — today's only probed ecosystem — both when
 * nothing resolves and when the resolved ecosystem has no toolchain row yet
 * (ruby/php: `ECOSYSTEM_CONVENTIONS` rows exist for twin discovery but
 * `discoverProjectToolchain` has no probe ladder for them), so a plain
 * python/unknown repo is byte-identical to before this function existed.
 *
 * @sem domain=routing role=toolchain-discovery
 */
export function resolveToolchainEcosystem(cwd: string, touchedSourceFiles: readonly string[]): ToolchainEcosystem {
  const eco = resolveActiveEcosystem(cwd, touchedSourceFiles)
  if (eco && Object.prototype.hasOwnProperty.call(ECOSYSTEM_TOOL_BIN, eco.language)) {
    return eco.language as ToolchainEcosystem
  }
  return "python"
}

/**
 * P2a — per-ecosystem toolchain probe ladder, generalizing F14a's
 * python-only `discoverProjectInterpreter`: `python` routes straight through
 * to it (byte-identical, `topLevelPackage` required); every other ecosystem
 * tries `mise which <tool>` first when mise + a pin file are present, then
 * its own minimal ladder (node: `.nvmrc`-aware then PATH; go/rust/java:
 * PATH), probing each candidate with `<candidate> --version` via the
 * injected runner and returning the first that exits 0. F21's turn-harvest
 * (`harvestTurnInterpreter`) is unrelated and still tried first by the
 * caller before this rung runs at all.
 *
 * @sem domain=routing role=toolchain-discovery
 */
export async function discoverProjectToolchain(opts: {
  cwd: string
  ecosystem: ToolchainEcosystem
  runner: CommandRunner
  /** python only — `discoverProjectInterpreter`'s import-probe target. */
  topLevelPackage?: string
}): Promise<string | null> {
  const { cwd, ecosystem, runner, topLevelPackage } = opts
  if (ecosystem === "python") {
    if (!topLevelPackage) return null
    return discoverProjectInterpreter({ cwd, topLevelPackage, runner })
  }

  const mise = await tryMiseResolve(cwd, ECOSYSTEM_TOOL_BIN[ecosystem], runner)
  if (mise) return mise

  for (const candidate of buildEcosystemCandidates(cwd, ecosystem)) {
    const result = await runner({ kind: "guard", command: `${candidate} --version` })
    if (result.exitCode === 0) return candidate
  }
  return null
}

/** `runBuildCheckRung`'s outcome — `ran:false` means no compiled-target `buildCheck` applied (python's row carries none, so this is always the python outcome). */
export interface BuildCheckResult {
  readonly ran: boolean
  readonly passed: boolean
  readonly command?: string
  /** Fires only on `ran && !passed` — the fail-loud signal name for the caller to publish on the same bus `turn_regression*` uses. */
  readonly signal?: "build_check_red"
  readonly outputTail?: string
}

/**
 * P2b — build-first rung: runs the resolved ecosystem's `buildCheck`
 * (`tsc --noEmit` / `cargo check` / `go build ./...` / `mvn -q compile` —
 * compiled targets only; the python row carries no `buildCheck`, so this is
 * always a no-op there) once via the injected runner, BEFORE any neighbor
 * test command. A non-zero exit is a deterministic compile-time block,
 * reported as `signal: "build_check_red"` distinct from a test red — the
 * caller's regression lane must never promote a build failure to a test
 * result (the ts-repair lesson, agnostic-hands-eyes.md §2.4).
 *
 * @sem domain=routing role=build-check
 */
export async function runBuildCheckRung(opts: { cwd: string; runner: CommandRunner }): Promise<BuildCheckResult> {
  const { cwd, runner } = opts
  const profile = getRepoProfileSync(cwd)
  const buildCheck = profile.ecosystems.find((eco) => eco.buildCheck)?.buildCheck
  if (!buildCheck) return { ran: false, passed: true }
  const result = await runner({ kind: "typecheck", command: buildCheck })
  if (result.exitCode !== 0) {
    return { ran: true, passed: false, command: buildCheck, signal: "build_check_red", outputTail: result.stderr || result.stdout }
  }
  return { ran: true, passed: true, command: buildCheck }
}

// A green run the F21 harvest may trust: a runner summary proving at least
// one test passed (pytest "N passed", unittest/django "OK" / "OK (skipped=…)").
// Exit 0 alone is NOT enough — `pytest --version` or a collection-only run
// exits 0 without proving the interpreter can run this suite.
const GREEN_RUN_SIGNATURE_RE = /\b[1-9]\d* passed\b|(?:^|\n)\s*OK\b/

/**
 * F21 — turn-harvested interpreter: scans the turn's own bash executions
 * (latest first) for a green, test-shaped, python-headed run and returns
 * that command's interpreter token. An observed green suite run outranks
 * F14a's synthetic import probe, which strips `sys.path[0]` by design and
 * therefore fails on every repo whose package resolves only from the repo
 * root (Django-project layouts — linkding-995's gate skip shipped a
 * regression this way). Null when the transcript holds no trustworthy
 * specimen; callers fall back to the probe. Piped/substituted commands are
 * skipped (the exit code may not belong to the test run), as are
 * env-prefixed heads (only a bare or pathed `python*` head is evidence of
 * WHICH interpreter ran).
 *
 * @sem domain=routing role=interpreter-discovery
 */
export function harvestTurnInterpreter(executions: readonly SeenRedExecution[]): string | null {
  for (let i = executions.length - 1; i >= 0; i--) {
    const { command, exitCode, output } = executions[i]!
    if (exitCode !== 0) continue
    if (/[|`]/.test(command) || command.includes("$(")) continue
    if (!TEST_SHAPED_COMMAND_RE.test(command)) continue
    if (!GREEN_RUN_SIGNATURE_RE.test(output)) continue
    if (LAUNDERED_FAILURE_SIGNATURE_RE.test(output)) continue
    const head = command.match(/^(?:cd .+? && )?(\S+)/)?.[1]
    if (!head || !INTERPRETER_TOKEN_RE.test(head)) continue
    return head
  }
  return null
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

/** Swaps a segment's leading whitespace + first token for `interpreter` when that token is exactly `python`/`python3`; any other head leaves the segment untouched. Private helper for `rewriteInterpreterCommand`. */
function rewriteSegmentHead(segment: string, interpreter: string): string {
  const match = segment.match(/^(\s*)(\S+)([\s\S]*)$/)
  if (!match) return segment
  const [, leading, head, rest] = match
  if (head !== "python" && head !== "python3") return segment
  return `${leading}${interpreter}${rest}`
}

/**
 * Swaps a bare `python`/`python3` command-position head token for the discovered interpreter in
 * every top-level `&&`/`;` segment of `command` — the single rewrite point RF-6 gives the M4
 * finish gate, the F13d engine probe, and pin re-runs to share instead of each re-deriving the
 * swap. A missing/empty `interpreter` passes the command through unchanged, as does any command
 * containing a pipe, backtick, or `$(` (shell shapes out of this helper's no-parsing scope); an
 * absolute/relative, non-python, or env-prefixed head is left alone since only the exact bare
 * token is matched.
 *
 * @sem domain=routing role=interpreter-rewrite
 */
export function rewriteInterpreterCommand(command: string, interpreter: string | undefined): string {
  if (!interpreter) return command
  if (/[|`]/.test(command) || command.includes("$(")) return command
  return command
    .split(/(&&|;)/)
    .map((part) => (part === "&&" || part === ";" ? part : rewriteSegmentHead(part, interpreter)))
    .join("")
}

// ---------------------------------------------------------------------------
// H8 — differential regression baseline (env-red ≠ model-red)
// ---------------------------------------------------------------------------

/**
 * H8 — differential regression baseline: runs `neighbors` against the
 * touched files' pre-edit (HEAD) content, then restores the current
 * (post-edit) content — so the gate consumer can tell "was already red
 * before your change" (an environment fact, astropy-8707's broken `np.int`
 * import) from "your change broke it". Returns the command strings that
 * failed pre-edit; the caller feeds this straight into `Evidence.baseline`
 * (`code-intelligence/claim-evidence.ts`) — the subtraction itself happens
 * in the kernel's `checkClaimCoverage`, not here. A touched file with no
 * HEAD blob (a brand-new file) or whose current content already equals HEAD
 * is left untouched — nothing to revert. Restoration runs in `finally` so a
 * runner throw never strands a touched file on its pre-edit content.
 *
 * @sem domain=routing role=differential-baseline
 */
export async function runDifferentialBaseline(opts: {
  touchedSourceFiles: readonly string[]
  neighbors: readonly VerifyCommand[]
  runner: CommandRunner
  readHeadContent: (filePath: string) => Promise<string | null>
  readCurrentContent: (filePath: string) => Promise<string>
  writeContent: (filePath: string, content: string) => Promise<void>
}): Promise<ReadonlySet<string>> {
  if (opts.neighbors.length === 0) return new Set()
  const restores: { filePath: string; content: string }[] = []
  try {
    for (const filePath of opts.touchedSourceFiles) {
      const head = await opts.readHeadContent(filePath)
      if (head === null) continue
      const current = await opts.readCurrentContent(filePath)
      if (current === head) continue
      restores.push({ filePath, content: current })
      await opts.writeContent(filePath, head)
    }
    const { failures } = await runRegressionGate({ neighbors: opts.neighbors, runner: opts.runner })
    return new Set(failures.map((f) => f.command.command))
  } finally {
    for (const { filePath, content } of restores) await opts.writeContent(filePath, content)
  }
}

// ---------------------------------------------------------------------------
// P1 — structured-report capture for HARNESS-controlled test commands
// (docs/design/agnostic-hands-eyes.md §2.2)
// ---------------------------------------------------------------------------

/**
 * Runs one HARNESS-controlled test command with the active ecosystem's
 * `tests.structured.flag` appended when available: a `<path>`-templated
 * flag (pytest/Django/php's `--junitxml=<path>`) writes its report to a temp
 * path OUTSIDE the repo (`node:os` `tmpdir()`, read then deleted); a bare
 * flag (jest/vitest/go/cargo/rspec) prints its report straight to stdout.
 * §3.1's version risk means the installed runner may not understand the
 * flag at all (Django's `runtests.py` never does — it shares pytest's row
 * but is argparse-based, not pytest) — when the artifact/stdout doesn't
 * parse as any supported format, this falls back to RE-RUNNING the
 * unflagged command and hands back THAT result untouched, never the
 * flagged attempt's (possibly flag-induced) exit code. Python/pytest stays
 * functionally identical either way: the flag never changes which tests run
 * or their exit code, only whether a report gets parsed. A non-"test"
 * command, or an ecosystem with no (or an empty) structured flag —
 * maven/gradle's JUnit XML lands in a fixed directory, not behind a flag,
 * a later phase's job — runs through unmodified.
 *
 * @sem domain=routing role=structured-report-capture
 */
export async function runStructuredTestCommand(
  command: VerifyCommand,
  ecosystem: EcosystemProfile | undefined,
  runner: CommandRunner,
): Promise<{ result: CommandResult; reportContent?: string }> {
  if (command.kind !== "test" || !ecosystem || "unknown" in ecosystem.tests) {
    return { result: await runner(command) }
  }
  const { flag } = ecosystem.tests.structured
  if (!flag) return { result: await runner(command) }

  const usesPath = flag.includes("<path>")
  const tempPath = usesPath
    ? join(tmpdir(), `unerr-report-${Date.now()}-${Math.random().toString(36).slice(2)}.out`)
    : undefined
  const flaggedCommand = `${command.command} ${usesPath ? flag.replace("<path>", tempPath!) : flag}`
  const flaggedResult = await runner({ ...command, command: flaggedCommand })

  let reportContent: string | undefined
  if (usesPath && tempPath) {
    try {
      if (existsSync(tempPath)) reportContent = readFileSync(tempPath, "utf8")
    } catch {
      reportContent = undefined
    } finally {
      try {
        if (existsSync(tempPath)) unlinkSync(tempPath)
      } catch {
        // best-effort cleanup only — a stray temp file is never fatal
      }
    }
  } else {
    reportContent = flaggedResult.stdout
  }

  const report = reportContent ? detectAndParseTestReport(reportContent) : undefined
  if (!report) {
    // The flag wasn't understood (or produced nothing parseable) — proceed
    // exactly as today: the unflagged command's own result, never the
    // flagged attempt's.
    return { result: await runner(command) }
  }
  return {
    result: { ...flaggedResult, report: { caseCount: report.totals.total, skipped: report.totals.skip } },
    reportContent,
  }
}

/**
 * Wraps a `CommandRunner` so every command it runs goes through
 * `runStructuredTestCommand` for `ecosystem` — the drop-in the regression
 * lane's neighbor/baseline runs pass to `runRegressionGate`/
 * `runDifferentialBaseline` instead of a bare `makeShellCommandRunner`
 * double. `reportContentByCommand`, when supplied, is populated as a side
 * channel (command string → raw report content) so the caller can build
 * report-native failure detail after the gate returns, without threading a
 * new field through `CommandResult`/`SoundFailure`.
 *
 * @sem domain=routing role=structured-report-capture
 */
export function makeStructuredNeighborRunner(
  runner: CommandRunner,
  ecosystem: EcosystemProfile | undefined,
  reportContentByCommand?: Map<string, string>,
): CommandRunner {
  return async (command: VerifyCommand): Promise<CommandResult> => {
    const { result, reportContent } = await runStructuredTestCommand(command, ecosystem, runner)
    if (reportContent !== undefined) reportContentByCommand?.set(command.command, reportContent)
    return result
  }
}
