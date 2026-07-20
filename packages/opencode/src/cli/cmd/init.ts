import { EOL } from "os"
import path from "path"
import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { UI } from "../ui"

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
    const { root, dbPath, stats, reindexed } = yield* Effect.promise(() =>
      prepareGraphIndex(dir, { force: args.force }),
    )
    const elapsedMs = Date.now() - started

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
    w("")
    w(`${S.TEXT_DIM}[opencode] Graph persisted to ${dbPath} — the agent warm-starts off it next run.${S.TEXT_NORMAL}`)
  }),
})
