// Wave-8 offline probe (temporary, deleted after run): replays the exact
// root-arming path — extractIssueSymbols(PROMPT.txt) → graph.search(sym, 2)
// → definingFiles allowlist — against real django checkouts at each
// instance's base commit, then reports what evaluateHubEditGate would do to
// each instance's known fix-site and trap files (allowlist match via
// pathsRefer, fan-in vs HUB_IMPORTER_THRESHOLD=3).
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { BunSqliteGraph } from "../code-intelligence/src/bun-sqlite-graph"
import { extractIssueSymbols, issueSymbolDefinitionSites } from "./src/tool/graph-tools"
import { pathsRefer, bandFilterDefiningSites } from "./src/tool/edit-governance"

const SCRATCH = "/private/tmp/claude-501/-Users-jaswanth-IdeaProjects-econ-coding-agent/16094f9e-8c0a-413d-81d3-e87c74c5fb03/scratchpad"
const META = `${process.env.HOME}/econ-swe-arena/meta`
const THRESHOLD = 3

// Per instance: the files whose gate verdict decides pass/fail.
// ok = the gold fix site; trap = round-A wrong-layer edit targets.
const INTEREST: Record<string, Array<{ file: string; label: string }>> = {
  "11790": [{ file: "django/contrib/auth/forms.py", label: "gold fix site (round-A bounced, 7 importers)" }],
  "11885": [{ file: "django/db/models/deletion.py", label: "gold fix site" }],
  "12039": [
    { file: "django/db/backends/ddl_references.py", label: "gold fix site (round-A bounced, 6 importers)" },
  ],
  "11848": [{ file: "django/utils/http.py", label: "gold fix site" }],
  "11964": [
    { file: "django/db/models/enums.py", label: "gold fix site" },
    { file: "django/db/models/fields/__init__.py", label: "WRONG-LAYER trap (round-A edited, 26 importers)" },
    { file: "django/db/models/base.py", label: "WRONG-LAYER trap (round-A edited, 4 importers)" },
  ],
}

for (const short of ["11790", "11885", "12039", "11848", "11964"]) {
  const repo = `${SCRATCH}/probe-${short}`
  const prompt = readFileSync(`${META}/${short}/PROMPT.txt`, "utf8")
  const symbols = extractIssueSymbols(prompt)

  const graph = new BunSqliteGraph(":memory:", repo)
  const t0 = performance.now()
  const stats = await graph.index(repo)
  const indexMs = Math.round(performance.now() - t0)

  // The real resolution path the gate uses at first edit (warm graph — index
  // just completed above, so the readiness race passes like a live session's).
  const sites = await issueSymbolDefinitionSites(prompt, graph)

  console.log(`\n===== ${short} (index ${indexMs}ms, ${stats.entities} entities, ${stats.edges} edges) =====`)
  console.log(`symbols(${symbols.length}): ${symbols.join(", ")}`)
  console.log(`allowlist(${sites.length} sites):`)
  for (const s of sites) {
    const fanIn = s.kind === "file" ? "n/a" : await graph.fileFanIn(join(repo, s.file))
    console.log(`  ${s.symbol} -> [${s.kind}] ${s.file} (fanIn=${fanIn})`)
  }

  // Wave 8c: the gate band-filters resolved sites by fan-in before they
  // become the allowlist — replicate that here (root-most band, file-kind
  // sites always kept), then judge each file of interest against it.
  const allowFiles = await bandFilterDefiningSites(sites, (f) => graph.fileFanIn(join(repo, f)))
  console.log(`band-filtered allowlist: ${allowFiles.join(", ") || "(empty)"}`)

  for (const { file, label } of INTEREST[short]) {
    const abs = join(repo, file)
    const fanIn = await graph.fileFanIn(abs)
    const allowMatch = allowFiles.find((f) => pathsRefer(abs, f) || pathsRefer(file, f))
    const verdict =
      allowMatch !== undefined
        ? `ALLOW (definingSite '${allowMatch}')`
        : fanIn >= THRESHOLD
          ? `BOUNCE (fanIn=${fanIn} >= ${THRESHOLD})`
          : `allow (fanIn=${fanIn} < ${THRESHOLD})`
    console.log(`  GATE ${verdict}  <- ${file}  [${label}]`)
  }
}
