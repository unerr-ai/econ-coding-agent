// Wave-11 stage-1 offline probe (temporary, deleted after run): runs
// detectReceiverMethodDivergence against beforeContent/addedText reconstructed
// from real arena checkouts + patches for the five A4-PASSING instances (must
// stay SILENT) plus a reconstructed A4-RED 11848 variant (must FIRE — this is
// the exact bug the detector targets: datetime.datetime.now() added beside
// the file's existing datetime.datetime(...) constructor calls, never .now()
// before).
import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { detectReceiverMethodDivergence } from "./src/tool/convention-divergence"

const HOME = process.env.HOME
const ARENA = `${HOME}/econ-swe-arena`

interface ProbeCase {
  short: string
  arena: string
  patch: string
  files: string[]
  expected: "SILENT" | "FIRES"
  note: string
}

function gitShow(arena: string, file: string): string {
  return execSync(`git -C ${arena} show HEAD:${file}`, { encoding: "utf8" })
}

// Extracts the '+' lines (minus context) for one file's hunk(s) out of a
// unified diff — good enough for these single/dual-file patches, not a
// general diff parser.
function addedTextForFile(patchText: string, file: string): string {
  const sections = patchText.split(/^diff --git /m).slice(1)
  for (const section of sections) {
    const header = section.match(/^a\/(\S+) b\/(\S+)/)
    if (!header || header[2] !== file) continue
    const added: string[] = []
    for (const line of section.split("\n")) {
      if (line.startsWith("+++")) continue
      if (line.startsWith("+")) added.push(line.slice(1))
    }
    return added.join("\n")
  }
  return ""
}

const CASES: ProbeCase[] = [
  {
    short: "11790",
    arena: `${ARENA}/arena-11790`,
    patch: `${ARENA}/patch-11790.diff`,
    files: ["django/contrib/auth/forms.py"],
    expected: "SILENT",
    note: "A4 passing — maxlength widget-attr fix",
  },
  {
    short: "11885",
    arena: `${ARENA}/arena-11885`,
    patch: `${ARENA}/patch-11885.diff`,
    files: ["django/contrib/admin/utils.py", "django/db/models/deletion.py"],
    expected: "SILENT",
    note: "A4 passing — multi-FK fast-delete refactor",
  },
  {
    short: "12039",
    arena: `${ARENA}/arena-12039`,
    patch: `${ARENA}/patch-12039.diff`,
    files: ["django/db/backends/ddl_references.py", "django/db/backends/sqlite3/schema.py"],
    expected: "SILENT",
    note: "A4 passing — col_suffixes IndexError fix + sqlite FK rename",
  },
  {
    short: "11848",
    arena: `${ARENA}/arena-11848`,
    patch: `${ARENA}/patch-11848.diff`,
    files: ["django/utils/http.py"],
    expected: "SILENT",
    note: "A4b passing — parse_http_date via datetime.datetime.utcnow()",
  },
  {
    short: "11964",
    arena: `${ARENA}/arena-11964`,
    patch: `${ARENA}/patch-11964.diff`,
    files: ["django/db/models/enums.py"],
    expected: "SILENT",
    note: "A4 passing — Choices.__str__ override",
  },
]

const results: Array<{ short: string; note: string; expected: string; actual: string; ok: boolean }> = []

for (const c of CASES) {
  const patchText = readFileSync(c.patch, "utf8")
  console.log(`\n===== ${c.short} (${c.note}) =====`)
  let caseFires = false
  for (const file of c.files) {
    const beforeContent = gitShow(c.arena, file)
    const addedText = addedTextForFile(patchText, file)
    const result = detectReceiverMethodDivergence({ beforeContent, addedText })
    const verdict = result ? "FIRES" : "SILENT"
    if (result) caseFires = true
    console.log(`  ${file}: ${verdict}`)
    if (result) {
      console.log(`    receiver=${result.receiver} method=${result.method} receiverSites=${JSON.stringify(result.receiverSites)}`)
    }
  }
  const actual = caseFires ? "FIRES" : "SILENT"
  results.push({ short: c.short, note: c.note, expected: c.expected, actual, ok: actual === c.expected })
}

// Reconstructed A4 RED 11848: same hunk as the passing 11848 patch above,
// but with datetime.datetime.now() in place of datetime.datetime.utcnow() —
// this is the actual round-A4 red diff (no longer on disk); reconstructed
// here per the A4 record.
{
  const short = "11848-RED-reconstructed"
  console.log(`\n===== ${short} (A4 red — datetime.datetime.now() instead of .utcnow()) =====`)
  const beforeContent = gitShow(`${ARENA}/arena-11848`, "django/utils/http.py")
  const addedText = [
    "            current_year = datetime.datetime.now().year",
    "            year += 2000 if year <= current_year % 100 + 50 else 1900",
  ].join("\n")
  const result = detectReceiverMethodDivergence({ beforeContent, addedText })
  const actual = result ? "FIRES" : "SILENT"
  console.log(`  django/utils/http.py: ${actual}`)
  if (result) {
    console.log(`    receiver=${result.receiver} method=${result.method} receiverSites=${JSON.stringify(result.receiverSites)}`)
  }
  results.push({ short, note: "reconstructed A4 red", expected: "FIRES", actual, ok: actual === "FIRES" })
}

console.log("\n===== VERDICT TABLE =====")
console.log("case                          expected  actual   result")
for (const r of results) {
  const caseCol = r.short.padEnd(30)
  const expCol = r.expected.padEnd(9)
  const actCol = r.actual.padEnd(8)
  console.log(`${caseCol}${expCol}${actCol}${r.ok ? "OK" : "MISMATCH"}`)
}

const allOk = results.every((r) => r.ok)
console.log(`\nACCEPTANCE: ${allOk ? "PASS — all five passing cases SILENT, reconstructed red case FIRES" : "FAIL"}`)
