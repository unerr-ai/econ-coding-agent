import { EOL } from "os"
import path from "path"
import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { UI } from "../ui"

/**
 * `opencode init` — build (or refresh) this repo's code-graph index up front so
 * the first agent turn warm-starts off a ready graph instead of cold-indexing
 * mid-request. Mirrors `unerr index`: a human summary on stderr, an optional
 * single JSON line on stdout for scripting, and a `--force` full rebuild. No
 * project InstanceContext needed (instance:false) — it only walks the tree and
 * writes the per-root db under the data dir (see graphDbPath).
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
    const dir = args.directory ? path.resolve(String(args.directory)) : process.cwd()

    const started = Date.now()
    const { root, dbPath, stats, reindexed } = yield* Effect.promise(() =>
      prepareGraphIndex(dir, { force: args.force }),
    )
    const elapsedMs = Date.now() - started

    if (args.json) {
      process.stdout.write(
        JSON.stringify({ status: "indexed", root, dbPath, ...stats, reindexed, elapsedMs }) + EOL,
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
    w("")
    w(`${S.TEXT_DIM}[opencode] Graph persisted to ${dbPath} — the agent warm-starts off it next run.${S.TEXT_NORMAL}`)
  }),
})
