/**
 * RepoProfile — the "first ten minutes" of a repo, computed once and cached
 * (docs/design/agnostic-hands-eyes.md §2.1). Deterministic derivation only:
 * manifest fingerprints select an ecosystem, CI config / package scripts /
 * Makefile targets beat the conventions-table default for the test command,
 * and lockfiles give exact resolved versions — never guessed, never an LLM
 * call. Ambiguous derivations set `needsSynthesis` for the future bounded
 * rung to resolve; `validated: false` marks that no command has been
 * execution-checked yet (both later phases).
 *
 * @sem domain=intelligence role=discovery
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs"
import { execSync } from "node:child_process"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"

// ---------------------------------------------------------------------------
// Types (docs/design/agnostic-hands-eyes.md §2.1)
// ---------------------------------------------------------------------------

export type StructuredFormat = "junitxml" | "json" | "tap" | "trx"

/**
 * Where a derived test command came from — CI config beats package/Makefile
 * scripts beats the conventions-table default. The P0 typed seam for the
 * future bounded-LLM-synthesis rung: "convention" means the deterministic
 * ladder had nothing more specific and the row's default was used as-is.
 *
 * @sem domain=intelligence role=discovery
 */
export type DerivationSource = "ci" | "scripts" | "convention" | "unknown"

/** A resolved test command plus its provenance. @sem domain=intelligence role=discovery */
export interface DerivedTestCommand {
  readonly runner: string
  readonly suite: string
  readonly single: string
  readonly structured: { readonly flag: string; readonly format: StructuredFormat }
  readonly conventions: {
    readonly dirs: readonly string[]
    readonly filePatterns: readonly string[]
    readonly twinRule: string
  }
  readonly source: DerivationSource
  /** True when the ladder fell through to the table default — no CI/script evidence. */
  readonly needsSynthesis: boolean
  /** Execution-validation of the command is a later phase; P0 never runs anything. */
  readonly validated: false
}

/** Fail-loud: no test command was derivable for this ecosystem. @sem domain=intelligence role=discovery */
export interface UnknownTestProfile {
  readonly unknown: true
  readonly source: "unknown"
  readonly needsSynthesis: true
}

export type EcosystemTestProfile = DerivedTestCommand | UnknownTestProfile

/** Resolved versions — read from lockfiles/pin files, never assumed "latest" (doc §3.1). @sem domain=intelligence role=discovery */
export interface EcosystemVersions {
  readonly language?: string
  readonly runner?: string
  /** Lockfile-resolved: framework + key direct deps, capped ~50, runner/framework forced in when present. */
  readonly deps: Readonly<Record<string, string>>
}

/** One ecosystem root's profile (a monorepo has one per subtree). @sem domain=intelligence role=discovery */
export interface EcosystemProfile {
  readonly language: string
  /** Subtree this profile governs, relative to the repo root ("." for the root itself). */
  readonly root: string
  readonly toolchain: { readonly probeLadder: readonly string[] }
  readonly versions: EcosystemVersions
  readonly buildCheck?: string
  readonly tests: EcosystemTestProfile
  readonly repro: { readonly ext: string; readonly run: string }
  readonly verify?: { readonly smoke?: string; readonly ciCommands?: readonly string[] }
}

/** The cached, per-repo artifact every sense consumes. @sem domain=intelligence role=discovery */
export interface RepoProfile {
  readonly version: 1
  readonly derivedFrom: { readonly commitish: string; readonly manifests: readonly string[] }
  readonly ecosystems: readonly EcosystemProfile[]
}

// ---------------------------------------------------------------------------
// ECOSYSTEM_CONVENTIONS — the data table (doc §2.1: "a data table, not code")
// ---------------------------------------------------------------------------

/**
 * One ecosystem/framework's discovery conventions. A framework *variant*
 * (e.g. Django within python) is its own row, selected by `variantFingerprints`
 * over a sibling row with none — never a code branch.
 *
 * @sem domain=intelligence role=discovery
 */
export interface EcosystemConventionRow {
  readonly id: string
  readonly language: string
  /** Any of these files present at a candidate root selects this row's language family. */
  readonly manifestFingerprints: readonly string[]
  /** ALL of these must ALSO exist for this row to win over a same-language row without them. */
  readonly variantFingerprints?: readonly string[]
  /** ANY of these must be a declared dependency for this row to win over a same-language row without them. */
  readonly requiresAnyDependency?: readonly string[]
  readonly testDirs: readonly string[]
  readonly testFilePatterns: readonly string[]
  readonly twinRule: string
  readonly runner: string
  readonly suiteCommand: string
  /** `{testId}` is substituted by the caller. */
  readonly singleTestTemplate: string
  readonly structured: { readonly flag: string; readonly format: StructuredFormat }
  readonly buildCheck?: string
  readonly repro: { readonly ext: string; readonly run: string }
  /** Package/module name looked up in lockfile-resolved deps for `versions.runner`. */
  readonly runnerPackage?: string
  /** Row fields whose value is always the static default below — never overridden by
   * per-repo detection (contrast: `suite`/`single`/`versions.*` DO get superseded by the
   * CI/scripts/lockfile ladder in `deriveRepoProfile`). */
  readonly defaultedFields: readonly string[]
}

const ROW_DEFAULTED_FIELDS = [
  "testDirs",
  "testFilePatterns",
  "twinRule",
  "suiteCommand",
  "singleTestTemplate",
  "structured",
  "buildCheck",
  "repro",
] as const

export const ECOSYSTEM_CONVENTIONS: readonly EcosystemConventionRow[] = [
  {
    id: "python-pytest",
    language: "python",
    manifestFingerprints: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"],
    testDirs: ["tests", "test"],
    testFilePatterns: ["test_*.py", "*_test.py"],
    twinRule: "tests/test_<stem>.py mirrors <stem>.py",
    runner: "pytest",
    suiteCommand: "pytest",
    singleTestTemplate: "pytest {testId}",
    structured: { flag: "--junitxml=<path>", format: "junitxml" },
    repro: { ext: "py", run: "python repro_issue.py" },
    runnerPackage: "pytest",
    defaultedFields: ROW_DEFAULTED_FIELDS,
  },
  {
    id: "python-django",
    language: "python",
    manifestFingerprints: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"],
    variantFingerprints: ["tests/runtests.py"],
    testDirs: ["tests"],
    testFilePatterns: ["test_*.py", "tests.py"],
    twinRule: "tests/<app>/tests.py mirrors django's <app> module",
    runner: "django-test",
    suiteCommand: "python tests/runtests.py",
    singleTestTemplate: "python tests/runtests.py {testId}",
    structured: { flag: "--junitxml=<path>", format: "junitxml" },
    repro: { ext: "py", run: "python repro_issue.py" },
    runnerPackage: "django",
    defaultedFields: ROW_DEFAULTED_FIELDS,
  },
  {
    id: "javascript-jest",
    language: "javascript",
    manifestFingerprints: ["package.json"],
    testDirs: ["__tests__", "test", "tests"],
    testFilePatterns: ["*.test.js", "*.test.ts", "*.spec.js", "*.spec.ts"],
    twinRule: "__tests__/<stem>.test.ts mirrors <stem>.ts",
    runner: "jest",
    suiteCommand: "npx jest",
    singleTestTemplate: "npx jest {testId}",
    structured: { flag: "--json", format: "json" },
    buildCheck: "tsc --noEmit",
    repro: { ext: "js", run: "node repro_issue.js" },
    runnerPackage: "jest",
    defaultedFields: ROW_DEFAULTED_FIELDS,
  },
  {
    id: "javascript-vitest",
    language: "javascript",
    manifestFingerprints: ["package.json"],
    requiresAnyDependency: ["vitest"],
    testDirs: ["__tests__", "test", "tests"],
    testFilePatterns: ["*.test.js", "*.test.ts", "*.spec.js", "*.spec.ts"],
    twinRule: "__tests__/<stem>.test.ts mirrors <stem>.ts",
    runner: "vitest",
    suiteCommand: "npx vitest run",
    singleTestTemplate: "npx vitest run {testId}",
    structured: { flag: "--reporter=json", format: "json" },
    buildCheck: "tsc --noEmit",
    repro: { ext: "js", run: "node repro_issue.js" },
    runnerPackage: "vitest",
    defaultedFields: ROW_DEFAULTED_FIELDS,
  },
  {
    id: "go",
    language: "go",
    manifestFingerprints: ["go.mod"],
    testDirs: [],
    testFilePatterns: ["*_test.go"],
    twinRule: "<stem>_test.go mirrors <stem>.go",
    runner: "go test",
    suiteCommand: "go test ./...",
    singleTestTemplate: "go test -run {testId} ./...",
    structured: { flag: "-json", format: "json" },
    buildCheck: "go build ./...",
    repro: { ext: "go", run: "go run repro_issue.go" },
    defaultedFields: ROW_DEFAULTED_FIELDS,
  },
  {
    id: "rust",
    language: "rust",
    manifestFingerprints: ["Cargo.toml"],
    testDirs: ["tests"],
    testFilePatterns: ["*.rs"],
    twinRule: "tests/<stem>.rs integration crate mirrors src/<stem>.rs",
    runner: "cargo test",
    suiteCommand: "cargo test",
    singleTestTemplate: "cargo test {testId}",
    structured: { flag: "--message-format=json", format: "json" },
    buildCheck: "cargo check",
    repro: { ext: "rs", run: "rustc repro_issue.rs -o repro_issue && ./repro_issue" },
    defaultedFields: ROW_DEFAULTED_FIELDS,
  },
  {
    id: "java-maven",
    language: "java",
    manifestFingerprints: ["pom.xml"],
    testDirs: ["src/test/java"],
    testFilePatterns: ["*Test.java", "Test*.java"],
    twinRule: "src/test/java/<Pkg>/<Stem>Test.java mirrors src/main/java/<Pkg>/<Stem>.java",
    runner: "maven-surefire",
    suiteCommand: "mvn test",
    singleTestTemplate: "mvn test -Dtest={testId}",
    structured: { flag: "", format: "junitxml" },
    buildCheck: "mvn -q compile",
    repro: { ext: "java", run: "mvn -q compile exec:java -Dexec.mainClass=ReproIssue" },
    defaultedFields: ROW_DEFAULTED_FIELDS,
  },
  {
    id: "java-gradle",
    language: "java",
    manifestFingerprints: ["build.gradle", "build.gradle.kts"],
    testDirs: ["src/test/java"],
    testFilePatterns: ["*Test.java", "Test*.java"],
    twinRule: "src/test/java/<Pkg>/<Stem>Test.java mirrors src/main/java/<Pkg>/<Stem>.java",
    runner: "gradle-test",
    suiteCommand: "./gradlew test",
    singleTestTemplate: "./gradlew test --tests {testId}",
    structured: { flag: "", format: "junitxml" },
    buildCheck: "./gradlew compileJava",
    repro: { ext: "java", run: "./gradlew run" },
    defaultedFields: ROW_DEFAULTED_FIELDS,
  },
  {
    id: "ruby",
    language: "ruby",
    manifestFingerprints: ["Gemfile"],
    testDirs: ["spec", "test"],
    testFilePatterns: ["*_spec.rb", "*_test.rb"],
    twinRule: "spec/<stem>_spec.rb mirrors lib/<stem>.rb",
    runner: "rspec",
    suiteCommand: "bundle exec rspec",
    singleTestTemplate: "bundle exec rspec {testId}",
    structured: { flag: "--format json", format: "json" },
    repro: { ext: "rb", run: "ruby repro_issue.rb" },
    runnerPackage: "rspec",
    defaultedFields: ROW_DEFAULTED_FIELDS,
  },
  {
    id: "php",
    language: "php",
    manifestFingerprints: ["composer.json"],
    testDirs: ["tests"],
    testFilePatterns: ["*Test.php"],
    twinRule: "tests/<Stem>Test.php mirrors src/<Stem>.php",
    runner: "phpunit",
    suiteCommand: "vendor/bin/phpunit",
    singleTestTemplate: "vendor/bin/phpunit --filter {testId}",
    structured: { flag: "--log-junit=<path>", format: "junitxml" },
    repro: { ext: "php", run: "php repro_issue.php" },
    defaultedFields: ROW_DEFAULTED_FIELDS,
  },
]

// ---------------------------------------------------------------------------
// Small FS helpers
// ---------------------------------------------------------------------------

function readTextFile(p: string): string {
  return readFileSync(p, "utf8")
}

function firstLine(content: string): string | undefined {
  const line = content.split(/\r?\n/)[0]?.trim()
  return line || undefined
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

const SKIP_SUBDIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "target",
  "vendor",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".cache",
  "coverage",
])

/** Repo-root subdirectories one level down, for monorepo detection. Bounded — never recurses further. */
function oneLevelSubdirs(repoRoot: string): string[] {
  return safeReaddir(repoRoot)
    .filter((name) => !name.startsWith(".") && !SKIP_SUBDIRS.has(name))
    .map((name) => path.join(repoRoot, name))
    .filter(isDirectory)
}

// ---------------------------------------------------------------------------
// (a) manifest fingerprints -> ecosystems
// ---------------------------------------------------------------------------

function hasJsDependency(dir: string, name: string): boolean {
  const pkgJsonPath = path.join(dir, "package.json")
  if (!existsSync(pkgJsonPath)) return false
  try {
    const pkg = JSON.parse(readTextFile(pkgJsonPath))
    const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }
    if (name in deps) return true
    const scripts = pkg.scripts ?? {}
    return Object.values(scripts).some((s) => typeof s === "string" && s.includes(name))
  } catch {
    return false
  }
}

function matchesDependencyRequirement(dir: string, row: EcosystemConventionRow): boolean {
  if (!row.requiresAnyDependency) return true
  if (row.language === "javascript" || row.language === "typescript") {
    return row.requiresAnyDependency.some((dep) => hasJsDependency(dir, dep))
  }
  return false
}

/** Best single row per language present at `dir` — variant/dependency-specific rows win over the generic default. */
function candidateEcosystemsAt(dir: string, entries: readonly string[]): EcosystemConventionRow[] {
  const byLanguage = new Map<string, EcosystemConventionRow[]>()
  for (const row of ECOSYSTEM_CONVENTIONS) {
    if (!row.manifestFingerprints.some((f) => entries.includes(f))) continue
    if (row.variantFingerprints && !row.variantFingerprints.every((f) => existsSync(path.join(dir, f)))) continue
    if (!matchesDependencyRequirement(dir, row)) continue
    const list = byLanguage.get(row.language) ?? []
    list.push(row)
    byLanguage.set(row.language, list)
  }
  const picked: EcosystemConventionRow[] = []
  for (const rows of byLanguage.values()) {
    const specific = rows.find((r) => r.variantFingerprints || r.requiresAnyDependency)
    picked.push(specific ?? rows[0])
  }
  return picked
}

// ---------------------------------------------------------------------------
// (b) test-command derivation priority: CI > scripts/Makefile > convention
// ---------------------------------------------------------------------------

/** Light line-based parse of `.github/workflows/*.yml` `run:` lines — no YAML lib needed. */
function deriveFromCI(repoRoot: string, row: EcosystemConventionRow): { command: string } | undefined {
  const workflowsDir = path.join(repoRoot, ".github", "workflows")
  if (!existsSync(workflowsDir)) return undefined
  const files = safeReaddir(workflowsDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
  const tokens = row.runner.split(/\s+/).filter(Boolean)
  for (const file of files) {
    let content: string
    try {
      content = readTextFile(path.join(workflowsDir, file))
    } catch {
      continue
    }
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim()
      const m = line.match(/^-?\s*run:\s*(.+)$/)
      if (!m) continue
      const cmd = m[1].trim().replace(/^["']|["']$/g, "")
      if (tokens.every((t) => cmd.includes(t))) return { command: cmd }
    }
  }
  return undefined
}

function deriveFromScripts(dir: string, _row: EcosystemConventionRow): { command: string } | undefined {
  const pkgJsonPath = path.join(dir, "package.json")
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readTextFile(pkgJsonPath))
      const testScript: string | undefined = pkg.scripts?.test
      if (testScript && !/^echo\b.*no test specified/i.test(testScript.trim())) {
        return { command: testScript.trim() }
      }
    } catch {
      /* malformed package.json — fall through to Makefile/convention */
    }
  }
  const makefilePath = path.join(dir, "Makefile")
  if (existsSync(makefilePath)) {
    const lines = readTextFile(makefilePath).split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      if (!/^test:/.test(lines[i])) continue
      for (let j = i + 1; j < lines.length; j++) {
        const body = lines[j]
        if (!body.startsWith("\t")) break
        const cmd = body.slice(1).trim()
        if (cmd) return { command: cmd }
      }
    }
  }
  return undefined
}

function deriveTestProfile(repoRoot: string, dir: string, row: EcosystemConventionRow): EcosystemTestProfile {
  const conventions = { dirs: row.testDirs, filePatterns: row.testFilePatterns, twinRule: row.twinRule }
  const ci = deriveFromCI(repoRoot, row)
  if (ci) {
    return {
      runner: row.runner,
      suite: ci.command,
      single: row.singleTestTemplate,
      structured: row.structured,
      conventions,
      source: "ci",
      needsSynthesis: false,
      validated: false,
    }
  }
  const scripts = deriveFromScripts(dir, row)
  if (scripts) {
    return {
      runner: row.runner,
      suite: scripts.command,
      single: row.singleTestTemplate,
      structured: row.structured,
      conventions,
      source: "scripts",
      needsSynthesis: false,
      validated: false,
    }
  }
  return {
    runner: row.runner,
    suite: row.suiteCommand,
    single: row.singleTestTemplate,
    structured: row.structured,
    conventions,
    source: "convention",
    needsSynthesis: true,
    validated: false,
  }
}

// ---------------------------------------------------------------------------
// (d) toolchain pin files -> resolved language version
// ---------------------------------------------------------------------------

const TOOLCHAIN_PIN_FILES: Readonly<Record<string, readonly string[]>> = {
  python: [".python-version"],
  javascript: [".nvmrc"],
  typescript: [".nvmrc"],
  rust: ["rust-toolchain.toml", "rust-toolchain"],
  ruby: [".ruby-version"],
  go: [],
  java: [],
  php: [],
}

const PIN_FILE_EXTRACTORS: Readonly<Record<string, (content: string) => string | undefined>> = {
  ".python-version": firstLine,
  ".nvmrc": firstLine,
  ".ruby-version": firstLine,
  "rust-toolchain": firstLine,
  "rust-toolchain.toml": (c) => c.match(/channel\s*=\s*"([^"]+)"/)?.[1],
}

const TOOL_VERSIONS_TOKEN: Readonly<Record<string, string>> = {
  python: "python",
  javascript: "nodejs",
  typescript: "nodejs",
  go: "golang",
  rust: "rust",
  java: "java",
  ruby: "ruby",
  php: "php",
}

function deriveLanguageVersion(dir: string, language: string): { version?: string; probeLadder: string[] } {
  const probeLadder: string[] = []
  for (const pinFile of TOOLCHAIN_PIN_FILES[language] ?? []) {
    const p = path.join(dir, pinFile)
    if (!existsSync(p)) continue
    probeLadder.push(pinFile)
    const version = PIN_FILE_EXTRACTORS[pinFile]?.(readTextFile(p))
    if (version) return { version, probeLadder }
  }
  if (language === "go") {
    const goModPath = path.join(dir, "go.mod")
    if (existsSync(goModPath)) {
      probeLadder.push("go.mod")
      const m = readTextFile(goModPath).match(/^(?:go|toolchain)\s+(?:go)?(\d+\.\d+(?:\.\d+)?)/m)
      if (m) return { version: m[1], probeLadder }
    }
  }
  const token = TOOL_VERSIONS_TOKEN[language]
  const toolVersionsPath = path.join(dir, ".tool-versions")
  if (token && existsSync(toolVersionsPath)) {
    probeLadder.push(".tool-versions")
    const line = readTextFile(toolVersionsPath)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.startsWith(`${token} `))
    const version = line?.split(/\s+/)[1]
    if (version) return { version, probeLadder }
  }
  return { version: undefined, probeLadder }
}

// ---------------------------------------------------------------------------
// (e) lockfile version fingerprint — cheap line/JSON parses, capped
// ---------------------------------------------------------------------------

const DEPS_CAP = 50

/** Shared parser for TOML `[[package]] name = "x" version = "y"` blocks — uv.lock, poetry.lock, Cargo.lock. */
function parseTomlPackageBlocks(content: string): Record<string, string> {
  const deps: Record<string, string> = {}
  const blocks = content.split(/\n\[\[package\]\]/).slice(1)
  for (const block of blocks) {
    const name = block.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1]
    const version = block.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1]
    if (name && version) deps[name] = version
  }
  return deps
}

function parseNpmPackageLock(content: string): Record<string, string> {
  const deps: Record<string, string> = {}
  try {
    const json = JSON.parse(content)
    if (json.packages && typeof json.packages === "object") {
      for (const [key, value] of Object.entries(json.packages as Record<string, any>)) {
        const m = key.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)$/)
        if (m && value && typeof value.version === "string") deps[m[1]] = value.version
      }
    } else if (json.dependencies && typeof json.dependencies === "object") {
      for (const [name, value] of Object.entries(json.dependencies as Record<string, any>)) {
        if (value && typeof value.version === "string") deps[name] = value.version
      }
    }
  } catch {
    /* malformed lockfile — return whatever was parsed so far (nothing) */
  }
  return deps
}

/** Top-level `packages:` block resolved-version lines — light heuristic, no YAML lib. */
function parsePnpmLock(content: string): Record<string, string> {
  const deps: Record<string, string> = {}
  let inPackages = false
  for (const raw of content.split(/\r?\n/)) {
    if (/^packages:/.test(raw)) {
      inPackages = true
      continue
    }
    if (!inPackages) continue
    if (/^\S/.test(raw)) {
      inPackages = false
      continue
    }
    const m = raw.match(/^\s{2}'?\/?(@?[^@'\s]+(?:\/[^@'\s]+)?)@([\w.\-]+)/)
    if (m) deps[m[1]] = m[2]
  }
  return deps
}

function parseGoModRequires(content: string): Record<string, string> {
  const deps: Record<string, string> = {}
  let inBlock = false
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (/^require\s*\($/.test(line)) {
      inBlock = true
      continue
    }
    if (inBlock && line === ")") {
      inBlock = false
      continue
    }
    const m = inBlock
      ? line.match(/^([^\s]+)\s+(v[0-9][\w.\-+]*)/)
      : line.match(/^require\s+([^\s]+)\s+(v[0-9][\w.\-+]*)/)
    if (m) deps[m[1]] = m[2]
  }
  return deps
}

function parseGemfileLock(content: string): Record<string, string> {
  const deps: Record<string, string> = {}
  for (const raw of content.split(/\r?\n/)) {
    const m = raw.match(/^ {4}([a-zA-Z0-9_\-]+) \(([^)]+)\)$/)
    if (m) deps[m[1]] = m[2]
  }
  return deps
}

const LOCKFILE_PARSERS: Readonly<Record<string, readonly { file: string; parse: (c: string) => Record<string, string> }[]>> = {
  python: [
    { file: "uv.lock", parse: parseTomlPackageBlocks },
    { file: "poetry.lock", parse: parseTomlPackageBlocks },
  ],
  javascript: [
    { file: "pnpm-lock.yaml", parse: parsePnpmLock },
    { file: "package-lock.json", parse: parseNpmPackageLock },
  ],
  typescript: [
    { file: "pnpm-lock.yaml", parse: parsePnpmLock },
    { file: "package-lock.json", parse: parseNpmPackageLock },
  ],
  go: [{ file: "go.mod", parse: parseGoModRequires }],
  rust: [{ file: "Cargo.lock", parse: parseTomlPackageBlocks }],
  ruby: [{ file: "Gemfile.lock", parse: parseGemfileLock }],
  java: [],
  php: [],
}

function deriveDeps(dir: string, language: string, runnerPackage?: string): { deps: Record<string, string>; runner?: string } {
  for (const { file, parse } of LOCKFILE_PARSERS[language] ?? []) {
    const p = path.join(dir, file)
    if (!existsSync(p)) continue
    let full: Record<string, string>
    try {
      full = parse(readTextFile(p))
    } catch {
      continue
    }
    const names = Object.keys(full)
    const capped = names.slice(0, DEPS_CAP)
    if (runnerPackage && full[runnerPackage] !== undefined && !capped.includes(runnerPackage)) {
      capped[capped.length - 1] = runnerPackage
    }
    const deps: Record<string, string> = {}
    for (const n of capped) deps[n] = full[n]
    return { deps, runner: runnerPackage ? full[runnerPackage] : undefined }
  }
  return { deps: {} }
}

// ---------------------------------------------------------------------------
// Ecosystem assembly + the top-level derivation entry point
// ---------------------------------------------------------------------------

function readCommitish(repoRoot: string): string {
  try {
    return execSync("git rev-parse HEAD", { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"], timeout: 2000 })
      .toString()
      .trim()
  } catch {
    return ""
  }
}

function deriveEcosystemProfile(repoRoot: string, dir: string, row: EcosystemConventionRow): EcosystemProfile {
  const { version: language, probeLadder } = deriveLanguageVersion(dir, row.language)
  const { deps, runner } = deriveDeps(dir, row.language, row.runnerPackage)
  const tests = deriveTestProfile(repoRoot, dir, row)
  const relRoot = path.relative(repoRoot, dir)
  return {
    language: row.language,
    root: relRoot === "" ? "." : relRoot,
    toolchain: { probeLadder },
    versions: { language, runner, deps },
    buildCheck: row.buildCheck,
    tests,
    repro: row.repro,
  }
}

/** (f) fail-loud: no manifest fingerprint matched anywhere — never silently skip verification. */
function unknownEcosystemProfile(): EcosystemProfile {
  return {
    language: "unknown",
    root: ".",
    toolchain: { probeLadder: [] },
    versions: { deps: {} },
    tests: { unknown: true, source: "unknown", needsSynthesis: true },
    repro: { ext: "txt", run: "" },
  }
}

/**
 * Deterministic derivation ladder: manifest fingerprints (repo root + one
 * level down for monorepos) select ecosystems, then per ecosystem — CI config
 * beats package/Makefile scripts beats the conventions-table default for the
 * test command, toolchain pin files resolve the language version, and
 * lockfiles resolve dependency versions. No LLM calls, no unbounded FS walks.
 *
 * @sem domain=intelligence role=discovery
 */
export function deriveRepoProfile(cwd: string): RepoProfile {
  const repoRoot = path.resolve(cwd)
  const rootEntries = safeReaddir(repoRoot)

  const found: { dir: string; row: EcosystemConventionRow }[] = []
  for (const row of candidateEcosystemsAt(repoRoot, rootEntries)) found.push({ dir: repoRoot, row })
  for (const sub of oneLevelSubdirs(repoRoot)) {
    const subEntries = safeReaddir(sub)
    for (const row of candidateEcosystemsAt(sub, subEntries)) found.push({ dir: sub, row })
  }

  const manifests = new Set<string>()
  for (const { dir, row } of found) {
    for (const f of [...row.manifestFingerprints, ...(row.variantFingerprints ?? [])]) {
      const abs = path.join(dir, f)
      if (existsSync(abs)) manifests.add(path.relative(repoRoot, abs))
    }
  }

  const ecosystems = found.map(({ dir, row }) => deriveEcosystemProfile(repoRoot, dir, row))

  return {
    version: 1,
    derivedFrom: { commitish: readCommitish(repoRoot), manifests: [...manifests].sort() },
    ecosystems: ecosystems.length > 0 ? ecosystems : [unknownEcosystemProfile()],
  }
}

// ---------------------------------------------------------------------------
// Cache — mirrors graph-tools.ts's graphDbPath precedent: one entry per repo
// root under Global.Path.data, keyed by a hash of the root; a manifest
// (path+mtime) fingerprint gates re-derivation. Never written inside the repo.
// ---------------------------------------------------------------------------

interface CachedRepoProfile {
  readonly fingerprint: string
  readonly profile: RepoProfile
}

/** On-disk cache path for a repo root's profile, mirroring graphDbPath (see tool/graph-tools.ts). */
export function repoProfileCachePath(repoRoot: string): string {
  return path.join(Global.Path.data, "repo-profile", Hash.fast(repoRoot), "profile.json")
}

function knownManifestNames(): string[] {
  const names = new Set<string>()
  for (const row of ECOSYSTEM_CONVENTIONS) {
    for (const f of row.manifestFingerprints) names.add(f)
    for (const f of row.variantFingerprints ?? []) names.add(f)
  }
  for (const files of Object.values(TOOLCHAIN_PIN_FILES)) for (const f of files) names.add(f)
  for (const parsers of Object.values(LOCKFILE_PARSERS)) for (const p of parsers) names.add(p.file)
  names.add(".tool-versions")
  return [...names]
}

/** Bounded (repo root + one level down × a fixed name list, plus one CI-dir listing) — hash of path+mtime pairs. */
function computeCacheFingerprint(repoRoot: string): string {
  const names = knownManifestNames()
  const dirs = [repoRoot, ...oneLevelSubdirs(repoRoot)]
  const entries: string[] = []
  for (const dir of dirs) {
    for (const name of names) {
      const p = path.join(dir, name)
      try {
        const st = statSync(p)
        entries.push(`${path.relative(repoRoot, p)}:${st.mtimeMs}`)
      } catch {
        /* absent — no entry, so a later add/remove changes the fingerprint */
      }
    }
  }
  const workflowsDir = path.join(repoRoot, ".github", "workflows")
  for (const f of safeReaddir(workflowsDir)) {
    try {
      const st = statSync(path.join(workflowsDir, f))
      entries.push(`.github/workflows/${f}:${st.mtimeMs}`)
    } catch {
      /* raced deletion — skip */
    }
  }
  entries.sort()
  return Hash.fast(entries.join("|"))
}

function readCache(cachePath: string): CachedRepoProfile | undefined {
  if (!existsSync(cachePath)) return undefined
  try {
    return JSON.parse(readTextFile(cachePath)) as CachedRepoProfile
  } catch {
    return undefined
  }
}

function writeCache(cachePath: string, entry: CachedRepoProfile): void {
  try {
    mkdirSync(path.dirname(cachePath), { recursive: true })
    writeFileSync(cachePath, JSON.stringify(entry, null, 2))
  } catch {
    /* best-effort — a failed cache write never blocks profile derivation */
  }
}

/**
 * Cached entry point: returns the persisted profile when the manifest-file
 * fingerprint (path+mtime) still matches, else re-derives and persists.
 * Cache lives under `Global.Path.data`, never inside the repo being profiled.
 *
 * @sem domain=intelligence role=discovery
 */
export function loadRepoProfile(cwd: string, opts: { force?: boolean } = {}): RepoProfile {
  const repoRoot = path.resolve(cwd)
  const fingerprint = computeCacheFingerprint(repoRoot)
  const cachePath = repoProfileCachePath(repoRoot)

  if (!opts.force) {
    const cached = readCache(cachePath)
    if (cached && cached.fingerprint === fingerprint) return cached.profile
  }

  const profile = deriveRepoProfile(repoRoot)
  writeCache(cachePath, { fingerprint, profile })
  return profile
}

const PROFILE_MEMO = new Map<string, RepoProfile>()

const EMPTY_PROFILE: RepoProfile = { version: 1, derivedFrom: { commitish: "", manifests: [] }, ecosystems: [] }

/**
 * Process-lifetime memo over loadRepoProfile for hot-path consumers (seen-red
 * classification, verifier parsing, prompt compilation): one derivation per repo
 * root per process, and a derivation failure degrades to an empty profile so a
 * sense can fall back to its generic layer — it must never throw into a gate.
 *
 * @sem domain=intelligence role=discovery
 */
export function getRepoProfileSync(cwd: string): RepoProfile {
  const repoRoot = path.resolve(cwd)
  const memoized = PROFILE_MEMO.get(repoRoot)
  if (memoized) return memoized
  let profile: RepoProfile
  try {
    profile = loadRepoProfile(repoRoot)
  } catch {
    profile = EMPTY_PROFILE
  }
  PROFILE_MEMO.set(repoRoot, profile)
  return profile
}
