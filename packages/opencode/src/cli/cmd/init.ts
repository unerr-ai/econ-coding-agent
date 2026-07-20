import { EOL } from "os"
import path from "path"
import { Effect } from "effect"
import { couplingConfidence, type EdgeCoverage } from "@opencode-ai/code-intelligence"
import { effectCmd } from "../effect-cmd"
import { UI } from "../ui"

/**
 * Compact per-language coverage summary for the `opencode init` receipt —
 * e.g. "python 77% (3036f) · javascript 84% (12f) · go unknown (204f)".
 * A language shows its resolved-import percentage, or "unknown" when
 * couplingConfidence reads it below the P6 floor (§7.1), or "n/a" when it
 * has zero import statements to resolve. Sorted by file count, descending,
 * so the repo's dominant languages lead the line.
 */
function formatCoverageLine(coverage: EdgeCoverage): string {
  return Object.entries(coverage)
    .sort(([, a], [, b]) => b.files - a.files)
    .map(([lang, c]) => {
      const label =
        c.imports === 0 ? "n/a" : couplingConfidence(c) === "unknown" ? "unknown" : `${Math.round((c.resolvedImports / c.imports) * 100)}%`
      return `${lang} ${label} (${c.files}f)`
    })
    .join(" · ")
}

/**
 * `opencode init` — build (or refresh) this repo's code-graph index up front so
 * the first agent turn warm-starts off a ready graph instead of cold-indexing
 * mid-request, and derive+cache the repo's RepoProfile (ecosystems, runner,
 * derived test/build commands — docs/design/agnostic-hands-eyes.md §2.1) the
 * same way. Mirrors `unerr index`: a human summary on stderr, an optional
 * single JSON line on stdout for scripting, and a `--force` full rebuild. No
 * project InstanceContext needed (instance:false) — it only walks the tree and
 * writes the per-root db / profile under the data dir (see graphDbPath,
 * repoProfileCachePath).
 *
 * @sem domain=intelligence role=tools
 */
export const InitCommand = effectCmd({
  command: "init [directory]",
  describe: "index this repo's code graph so the agent warm-starts instead of cold-indexing",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("directory", {
        describe: "repo directory to index (defaults to the current directory)",
        type: "string",
      })
      .option("json", {
        describe: "emit the index result as a single JSON line on stdout (for scripting)",
        type: "boolean",
      })
      .option("force", {
        describe: "rebuild the graph from scratch, ignoring the content-hash cache",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.init")(function* (args) {
    const { prepareGraphIndex } = yield* Effect.promise(() => import("@/tool/graph-tools"))
    const { loadRepoProfile } = yield* Effect.promise(() => import("@/code-intelligence/repo-profile"))
    const dir = args.directory ? path.resolve(String(args.directory)) : process.cwd()

    const started = Date.now()
    const { root, dbPath, stats, reindexed, coverage } = yield* Effect.promise(() =>
      prepareGraphIndex(dir, { force: args.force }),
    )
    const elapsedMs = Date.now() - started
    const coverageSummary = formatCoverageLine(coverage)

    // Purely additive to the graph step above — a profile derivation failure
    // (unreadable manifest, permission error) never blocks graph indexing.
    let profile: ReturnType<typeof loadRepoProfile> | undefined
    try {
      profile = loadRepoProfile(dir, { force: args.force })
    } catch {
      profile = undefined
    }
    const profileSummary = profile
      ? profile.ecosystems
          .map((e) => ("unknown" in e.tests ? `${e.language} (tests unknown)` : `${e.language}:${e.tests.runner} [${e.tests.source}]`))
          .join(", ")
      : "derivation failed"

    if (args.json) {
      process.stdout.write(
        JSON.stringify({
          status: "indexed",
          root,
          dbPath,
          ...stats,
          reindexed,
          elapsedMs,
          repoProfile: profile,
          coverage,
        }) + EOL,
      )
      return
    }

    const S = UI.Style
    const fresh = reindexed === 0 && stats.files > 0
    const w = (line: string) => process.stderr.write(line + EOL)
    w("")
    w(`${S.TEXT_SUCCESS_BOLD}[opencode]${S.TEXT_NORMAL} Indexed ${root}`)
    w(`  Files:    ${stats.files}${fresh ? `${S.TEXT_DIM} (cache fresh — 0 re-extracted)${S.TEXT_NORMAL}` : ""}`)
    w(`  Entities: ${stats.entities}`)
    w(`  Edges:    ${stats.edges}`)
    w(`  Time:     ${elapsedMs}ms`)
    w(`  Profile:  ${profileSummary}`)
    if (coverageSummary) w(`  Coverage: ${coverageSummary}`)
    w("")
    w(`${S.TEXT_DIM}[opencode] Graph persisted to ${dbPath} — the agent warm-starts off it next run.${S.TEXT_NORMAL}`)
  }),
})
