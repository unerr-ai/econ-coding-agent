/**
 * Strategy T8 — framework-aware test result compression.
 * Extracts summary + failure blocks; drops all passing test lines.
 * Ported from unerr-cli src/proxy/shell-strategies/test-results.ts — no external deps.
 */

import { isSalientLine } from "./salience"

type TestFramework =
  | "vitest"
  | "jest"
  | "pytest"
  | "cargo_test"
  | "go_test"
  | "rspec"
  | "phpunit"
  | "dotnet_test"
  | "elixir_test"
  | "playwright"
  | "bun_test"
  | "generic"

interface FailureBlock {
  header: string
  lines: string[]
}

interface ParsedTestOutput {
  framework: TestFramework
  passed: number
  failed: number
  skipped: number
  duration: string
  failures: FailureBlock[]
  summaryLines: string[]
}

function detectTestFramework(command: string | undefined, lines: string[]): TestFramework {
  if (command) {
    const cmd = command.toLowerCase()
    if (cmd.includes("vitest")) return "vitest"
    if (cmd.includes("jest")) return "jest"
    if (cmd.includes("pytest") || cmd.includes("python -m pytest")) return "pytest"
    if (cmd.includes("cargo test")) return "cargo_test"
    if (cmd.includes("go test")) return "go_test"
    if (cmd.includes("playwright")) return "playwright"
    if (/\bbun( run)? test\b/.test(cmd)) return "bun_test"
  }
  const sample = lines.slice(0, 50).join("\n")
  if (/\[(chromium|firefox|webkit)\]\s+›/.test(sample)) return "playwright"
  if (/✓ .+\d+ms/m.test(sample) || /Test Files\s+\d+/m.test(sample)) return "vitest"
  if (/^PASS\s+\S+\.(test|spec)\.(ts|js|tsx|jsx)/m.test(sample)) return "jest"
  if (/^={3,}\s*(test session starts|FAILURES)/m.test(sample)) return "pytest"
  if (/^test .+ \.\.\. ok$/m.test(sample)) return "cargo_test"
  if (/^--- (PASS|FAIL): /m.test(sample)) return "go_test"
  if (/^\d+ examples?, \d+ failures?/m.test(sample) || /^Finished in .+\n\d+ examples?/m.test(sample))
    return "rspec"
  if (/^PHPUnit|^Tests: \d+, Assertions: \d+/m.test(sample)) return "phpunit"
  if (/^(Passed|Failed)!\s+-\s+(Passed|Failed):/m.test(sample) || /^Total tests: \d+/m.test(sample))
    return "dotnet_test"
  if (/^\d+ tests?, \d+ failures?$/m.test(sample) && /^Finished in /m.test(sample)) return "elixir_test"
  if (
    /^bun test v\d/m.test(sample) ||
    (/^\s*\d+ pass$/m.test(sample) && /^\s*\d+ fail$/m.test(sample)) ||
    /^Ran \d+ tests? across \d+ files?\./m.test(sample)
  )
    return "bun_test"
  return "generic"
}

const NOISE_RE = /^\[(unerr|warn)\]|^fatal: /

function filterNoise(lines: string[]): string[] {
  return lines.filter((l) => !NOISE_RE.test(l))
}

function parseVitest(lines: string[]): ParsedTestOutput {
  const clean = filterNoise(lines)
  const failures: FailureBlock[] = []
  let passed = 0
  let failed = 0
  let skipped = 0
  let duration = ""
  const summaryLines: string[] = []
  let currentFail: FailureBlock | null = null

  for (const line of clean) {
    if (/^\s*(Test Files|Tests)\s+/.test(line)) {
      summaryLines.push(line.trim())
      const mp = line.match(/(\d+)\s+passed/)
      if (mp) passed = Number.parseInt(mp[1]!, 10)
      const mf = line.match(/(\d+)\s+failed/)
      if (mf) failed = Number.parseInt(mf[1]!, 10)
      const ms = line.match(/(\d+)\s+skipped/)
      if (ms) skipped = Number.parseInt(ms[1]!, 10)
      continue
    }
    if (/^\s+Duration\s+/.test(line)) {
      duration = line.trim()
      summaryLines.push(duration)
      continue
    }
    if (/^⎯{3,}/.test(line)) {
      if (currentFail) { failures.push(currentFail); currentFail = null }
      continue
    }
    if (/^\s*FAIL\s+/.test(line)) {
      if (currentFail) failures.push(currentFail)
      currentFail = { header: line.trim(), lines: [] }
      continue
    }
    if (currentFail) { currentFail.lines.push(line); continue }
    if (/^\s*✓\s/.test(line)) continue
    if (/^\s*RUN\s+v/.test(line)) continue
  }
  if (currentFail) failures.push(currentFail)
  return { framework: "vitest", passed, failed, skipped, duration, failures, summaryLines }
}

function parseJest(lines: string[]): ParsedTestOutput {
  const clean = filterNoise(lines)
  const failures: FailureBlock[] = []
  let passed = 0
  let failed = 0
  let skipped = 0
  let duration = ""
  const summaryLines: string[] = []
  let currentFail: FailureBlock | null = null

  for (const line of clean) {
    if (/^Tests?:\s+/.test(line.trim())) {
      summaryLines.push(line.trim())
      const mp = line.match(/(\d+)\s+passed/)
      if (mp) passed = Number.parseInt(mp[1]!, 10)
      const mf = line.match(/(\d+)\s+failed/)
      if (mf) failed = Number.parseInt(mf[1]!, 10)
      const ms = line.match(/(\d+)\s+skipped/)
      if (ms) skipped = Number.parseInt(ms[1]!, 10)
      continue
    }
    if (/^Time:\s+/.test(line.trim())) { duration = line.trim(); summaryLines.push(duration); continue }
    if (/^Test Suites?:\s+/.test(line.trim())) { summaryLines.push(line.trim()); continue }
    if (/^\s*●\s/.test(line) || /^\s*FAIL\s+/.test(line)) {
      if (currentFail) failures.push(currentFail)
      currentFail = { header: line.trim(), lines: [] }
      continue
    }
    if (currentFail) {
      if (line.trim() === "" && currentFail.lines.length > 3) {
        failures.push(currentFail); currentFail = null; continue
      }
      currentFail.lines.push(line); continue
    }
    if (/^\s*(PASS|✓|✓)\s/.test(line)) continue
  }
  if (currentFail) failures.push(currentFail)
  return { framework: "jest", passed, failed, skipped, duration, failures, summaryLines }
}

// Jest prints "Test suite failed to run" (e.g. a file with no it()/describe blocks, or a
// require/syntax error) with 0 parsed tests and no "N failed" count — that combination looks
// identical to an empty passing run to the counters above, so the one-liner emitter would
// otherwise render a bare `jest: 0 tests (...)` and silently drop the actual reason. A
// composite `| tail -N` pipe also masks the real exit code behind tail's own (0), so this
// textual signature must be checked regardless of exitCode. Returns the first non-blank line
// after the signature (the actual reason, e.g. "Your test suite must contain at least one
// test.") or undefined when the signature isn't present.
const JEST_SUITE_FAILED_RE = /Test suite failed to run/

function findJestSuiteFailureDetail(lines: string[]): string | undefined {
  const idx = lines.findIndex((l) => JEST_SUITE_FAILED_RE.test(l))
  if (idx === -1) return undefined
  for (let i = idx + 1; i < lines.length && i < idx + 8; i++) {
    const trimmed = lines[i]!.trim()
    if (trimmed) return trimmed
  }
  return "Test suite failed to run"
}

function parsePytest(lines: string[]): ParsedTestOutput {
  const failures: FailureBlock[] = []
  let passed = 0; let failed = 0; let skipped = 0; let duration = ""
  const summaryLines: string[] = []
  let currentFail: FailureBlock | null = null

  for (const line of lines) {
    const summaryMatch = line.match(
      /^=+\s*(\d+)\s+passed(?:,\s+(\d+)\s+failed)?(?:,\s+(\d+)\s+skipped)?\s+in\s+(.+?)\s*=+$/,
    )
    if (summaryMatch) {
      passed = Number.parseInt(summaryMatch[1]!, 10)
      if (summaryMatch[2]) failed = Number.parseInt(summaryMatch[2], 10)
      if (summaryMatch[3]) skipped = Number.parseInt(summaryMatch[3], 10)
      duration = summaryMatch[4]!
      summaryLines.push(line.trim()); continue
    }
    if (/^=+\s*short test summary info\s*=+$/i.test(line)) { summaryLines.push(line.trim()); continue }
    if (/^=+\s*FAILURES\s*=+$/.test(line)) continue
    if (/^_{3,}\s+(.+)\s+_{3,}$/.test(line)) {
      if (currentFail) failures.push(currentFail)
      const name = line.replace(/^_{3,}\s+/, "").replace(/\s+_{3,}$/, "")
      currentFail = { header: name, lines: [] }; continue
    }
    if (currentFail) { currentFail.lines.push(line); continue }
    if (/^FAILED\s/.test(line)) summaryLines.push(line.trim())
  }
  if (currentFail) failures.push(currentFail)
  return { framework: "pytest", passed, failed, skipped, duration, failures, summaryLines }
}

function parseCargoTest(lines: string[]): ParsedTestOutput {
  const failures: FailureBlock[] = []
  let passed = 0; let failed = 0; let skipped = 0; let duration = ""
  const summaryLines: string[] = []
  let currentFail: FailureBlock | null = null

  for (const line of lines) {
    const summaryMatch = line.match(
      /^test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored;.+?finished in (.+)$/,
    )
    if (summaryMatch) {
      passed = Number.parseInt(summaryMatch[1]!, 10)
      failed = Number.parseInt(summaryMatch[2]!, 10)
      skipped = Number.parseInt(summaryMatch[3]!, 10)
      duration = summaryMatch[4]!
      summaryLines.push(line.trim()); continue
    }
    if (/^failures:$/.test(line.trim())) continue
    if (/^---- (.+) stdout ----$/.test(line)) {
      if (currentFail) failures.push(currentFail)
      const name = line.replace(/^---- /, "").replace(/ stdout ----$/, "")
      currentFail = { header: name, lines: [] }; continue
    }
    if (currentFail) {
      if (/^---- .+ stdout ----$/.test(line) || /^failures:$/.test(line.trim())) {
        failures.push(currentFail); currentFail = null
      } else {
        currentFail.lines.push(line)
      }
      continue
    }
    if (/^test .+ \.\.\. ok$/.test(line)) continue
  }
  if (currentFail) failures.push(currentFail)
  return { framework: "cargo_test", passed, failed, skipped, duration, failures, summaryLines }
}

function parseGoTest(lines: string[]): ParsedTestOutput {
  const failures: FailureBlock[] = []
  let passed = 0; let failed = 0; let skipped = 0; let duration = ""
  const summaryLines: string[] = []
  let currentFail: FailureBlock | null = null

  for (const line of lines) {
    if (/^--- PASS: /.test(line)) { passed++; continue }
    const failMatch = /^--- FAIL: (.+?) \((.+?)\)$/.exec(line)
    if (failMatch) {
      if (currentFail) failures.push(currentFail)
      failed++
      currentFail = { header: `FAIL: ${failMatch[1]}`, lines: [] }; continue
    }
    if (/^--- SKIP: /.test(line)) { skipped++; continue }
    const pkgMatch = /^(ok|FAIL)\s+(\S+)\s+(.+)$/.exec(line)
    if (pkgMatch) {
      summaryLines.push(line.trim())
      if (!duration) duration = pkgMatch[3]!
      continue
    }
    if (currentFail && /^\s{4,}/.test(line)) { currentFail.lines.push(line); continue }
    if (currentFail && !/^\s{4,}/.test(line)) { failures.push(currentFail); currentFail = null }
  }
  if (currentFail) failures.push(currentFail)
  return { framework: "go_test", passed, failed, skipped, duration, failures, summaryLines }
}

function parseRspec(lines: string[]): ParsedTestOutput {
  const failures: FailureBlock[] = []
  let passed = 0; let failed = 0; let skipped = 0; let duration = ""
  const summaryLines: string[] = []
  let currentFail: FailureBlock | null = null

  for (const line of lines) {
    const summaryMatch = line.match(/^(\d+) examples?, (\d+) failures?(?:,\s+(\d+) pending)?/)
    if (summaryMatch) {
      const total = Number.parseInt(summaryMatch[1]!, 10)
      failed = Number.parseInt(summaryMatch[2]!, 10)
      if (summaryMatch[3]) skipped = Number.parseInt(summaryMatch[3], 10)
      passed = total - failed - skipped
      summaryLines.push(line.trim()); continue
    }
    const durMatch = line.match(/^Finished in (.+)$/)
    if (durMatch) { duration = durMatch[1]!; summaryLines.push(line.trim()); continue }
    const failMatch = /^\s+\d+\)\s+(.+)$/.exec(line)
    if (failMatch) {
      if (currentFail) failures.push(currentFail)
      currentFail = { header: failMatch[1]!, lines: [] }; continue
    }
    if (currentFail) {
      if (line.trim() === "" && currentFail.lines.length > 2) { failures.push(currentFail); currentFail = null }
      else currentFail.lines.push(line)
    }
  }
  if (currentFail) failures.push(currentFail)
  return { framework: "rspec", passed, failed, skipped, duration, failures, summaryLines }
}

function parsePhpunit(lines: string[]): ParsedTestOutput {
  const failures: FailureBlock[] = []
  let passed = 0; let failed = 0; let skipped = 0; let duration = ""
  const summaryLines: string[] = []
  let currentFail: FailureBlock | null = null

  for (const line of lines) {
    const summaryMatch = line.match(/^Tests: (\d+), Assertions: (\d+)/)
    if (summaryMatch) {
      const total = Number.parseInt(summaryMatch[1]!, 10)
      const failMatch = line.match(/Failures: (\d+)/)
      const errMatch = line.match(/Errors: (\d+)/)
      const skipMatch = line.match(/Skipped: (\d+)/)
      failed =
        (failMatch ? Number.parseInt(failMatch[1]!, 10) : 0) +
        (errMatch ? Number.parseInt(errMatch[1]!, 10) : 0)
      skipped = skipMatch ? Number.parseInt(skipMatch[1]!, 10) : 0
      passed = total - failed - skipped
      summaryLines.push(line.trim()); continue
    }
    const durMatch = line.match(/^Time: (.+)$/)
    if (durMatch) { duration = durMatch[1]!; summaryLines.push(line.trim()); continue }
    const failHeader = /^\d+\)\s+(\S+::\S+)/.exec(line)
    if (failHeader) {
      if (currentFail) failures.push(currentFail)
      currentFail = { header: failHeader[1]!, lines: [] }; continue
    }
    if (currentFail) {
      if (line.trim() === "" && currentFail.lines.length > 2) { failures.push(currentFail); currentFail = null }
      else currentFail.lines.push(line)
    }
  }
  if (currentFail) failures.push(currentFail)
  return { framework: "phpunit", passed, failed, skipped, duration, failures, summaryLines }
}

function parseDotnetTest(lines: string[]): ParsedTestOutput {
  const failures: FailureBlock[] = []
  let passed = 0; let failed = 0; let skipped = 0; let duration = ""
  const summaryLines: string[] = []
  let currentFail: FailureBlock | null = null

  for (const line of lines) {
    const totalMatch = line.match(/Total tests: (\d+)/)
    if (totalMatch) {
      summaryLines.push(line.trim())
      const pm = line.match(/Passed:\s*(\d+)/)
      const fm = line.match(/Failed:\s*(\d+)/)
      const sm = line.match(/Skipped:\s*(\d+)/)
      if (pm) passed = Number.parseInt(pm[1]!, 10)
      if (fm) failed = Number.parseInt(fm[1]!, 10)
      if (sm) skipped = Number.parseInt(sm[1]!, 10)
      continue
    }
    const durMatch = line.match(/Duration: (.+)$/)
    if (durMatch) { duration = durMatch[1]!; summaryLines.push(line.trim()); continue }
    if (/^\s*Failed\s+\S/.test(line)) {
      if (currentFail) failures.push(currentFail)
      currentFail = { header: line.trim(), lines: [] }; continue
    }
    if (currentFail) {
      if (/^\s*Failed\s+\S/.test(line) || (line.trim() === "" && currentFail.lines.length > 2)) {
        failures.push(currentFail); currentFail = null
      } else {
        currentFail.lines.push(line)
      }
    }
  }
  if (currentFail) failures.push(currentFail)
  return { framework: "dotnet_test", passed, failed, skipped, duration, failures, summaryLines }
}

function parseElixirTest(lines: string[]): ParsedTestOutput {
  const failures: FailureBlock[] = []
  let passed = 0; let failed = 0; const skipped = 0; let duration = ""
  const summaryLines: string[] = []
  let currentFail: FailureBlock | null = null

  for (const line of lines) {
    const summaryMatch = line.match(/^(\d+) tests?, (\d+) failures?/)
    if (summaryMatch) {
      const total = Number.parseInt(summaryMatch[1]!, 10)
      failed = Number.parseInt(summaryMatch[2]!, 10)
      passed = total - failed
      summaryLines.push(line.trim()); continue
    }
    const durMatch = line.match(/^Finished in (.+)$/)
    if (durMatch) { duration = durMatch[1]!; summaryLines.push(line.trim()); continue }
    const failMatch = /^\s+\d+\)\s+test (.+)/.exec(line)
    if (failMatch) {
      if (currentFail) failures.push(currentFail)
      currentFail = { header: failMatch[1]!, lines: [] }; continue
    }
    if (currentFail) {
      if (line.trim() === "" && currentFail.lines.length > 2) { failures.push(currentFail); currentFail = null }
      else currentFail.lines.push(line)
    }
  }
  if (currentFail) failures.push(currentFail)
  return { framework: "elixir_test", passed, failed, skipped, duration, failures, summaryLines }
}

function parsePlaywright(lines: string[]): ParsedTestOutput {
  const PASS_RE = /^\s*[✓✔]\s+\d+\s+\[.+\]\s+›/
  const FAIL_RE = /^\s*[✘✗×]\s+\d+\s+\[.+\]\s+›/
  const SUMMARY_RE = /^\s*(\d+)\s+(passed|failed|skipped|flaky)/

  const failures: FailureBlock[] = []
  let passed = 0; let failed = 0; let skipped = 0; let duration = ""
  const summaryLines: string[] = []
  let currentFail: FailureBlock | null = null
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!
    const sumMatch = SUMMARY_RE.exec(line)
    if (sumMatch) {
      const count = Number.parseInt(sumMatch[1]!, 10)
      const type = sumMatch[2]!
      if (type === "passed") passed = count
      else if (type === "failed") failed = count
      else if (type === "skipped") skipped = count
      summaryLines.push(line.trim())
      const durMatch = /\(([^)]+)\)/.exec(line)
      if (durMatch && type === "passed") duration = durMatch[1]!
      i++; continue
    }
    if (FAIL_RE.test(line)) {
      if (currentFail) failures.push(currentFail)
      currentFail = { header: line.trim(), lines: [] }
      i++
      while (i < lines.length) {
        const nextLine = lines[i]!
        if (PASS_RE.test(nextLine) || FAIL_RE.test(nextLine) || SUMMARY_RE.test(nextLine)) break
        currentFail.lines.push(nextLine)
        i++
      }
      continue
    }
    if (PASS_RE.test(line)) { passed = Math.max(passed, 1); i++; continue }
    i++
  }
  if (currentFail) failures.push(currentFail)
  return { framework: "playwright", passed, failed, skipped, duration, failures, summaryLines }
}

// Bun's non-TTY reporter prints failures inline (code-frame + error, no header)
// and only names the test in a trailing `(fail) describe > name [Nms]` line —
// the opposite order from every other parser here, so a block is closed (and
// its header assigned) when the trailer is seen, not when it's opened.
function parseBunTest(lines: string[]): ParsedTestOutput {
  const failures: FailureBlock[] = []
  let passed = 0
  let failed = 0
  let skipped = 0
  let duration = ""
  const summaryLines: string[] = []
  let buffer: string[] = []

  for (const line of lines) {
    const passMatch = /^\s*(\d+) pass$/.exec(line)
    if (passMatch) { passed = Number.parseInt(passMatch[1]!, 10); summaryLines.push(line.trim()); continue }
    const failCountMatch = /^\s*(\d+) fail$/.exec(line)
    if (failCountMatch) { failed = Number.parseInt(failCountMatch[1]!, 10); summaryLines.push(line.trim()); continue }
    const skipMatch = /^\s*(\d+) skip$/.exec(line)
    if (skipMatch) { skipped = Number.parseInt(skipMatch[1]!, 10); summaryLines.push(line.trim()); continue }
    if (/^\s*\d+ expect\(\) calls?$/.test(line)) { summaryLines.push(line.trim()); continue }
    const ranMatch = /^Ran \d+ tests? across \d+ files?\.(?:\s*\[(.+)\])?\s*$/.exec(line)
    if (ranMatch) {
      if (ranMatch[1]) duration = ranMatch[1]
      summaryLines.push(line.trim()); continue
    }
    if (/^\(fail\)\s.+\[.+\]$/.test(line.trim())) {
      failures.push({ header: line.trim(), lines: buffer })
      buffer = []
      continue
    }
    if (buffer.length === 0) {
      if (/^bun test v[\d.]+/.test(line)) continue
      if (/^\S+\.(test|spec)\.\w+:$/.test(line.trim())) continue
      if (line.trim() === "") continue
    }
    buffer.push(line)
  }
  return { framework: "bun_test", passed, failed, skipped, duration, failures, summaryLines }
}

// Truncates a failure block's lines to `limit`, but never at the cost of a
// salient line (assertion/exception/etc.) — those are kept in full even if
// that pushes the kept count past `limit`; only non-salient context lines are
// the ones actually cut.
function truncatePreferSalient(lines: string[], limit: number): { kept: string[]; omitted: number } {
  if (lines.length <= limit) return { kept: lines, omitted: 0 }
  const keepIdx = new Set<number>()
  lines.forEach((l, i) => {
    if (isSalientLine(l)) keepIdx.add(i)
  })
  for (let i = 0; i < lines.length && keepIdx.size < limit; i++) {
    keepIdx.add(i)
  }
  const kept = [...keepIdx].sort((a, b) => a - b).map((i) => lines[i]!)
  return { kept, omitted: lines.length - kept.length }
}

function emitCompressed(parsed: ParsedTestOutput): string {
  const parts: string[] = []
  const counts: string[] = []
  if (parsed.passed > 0) counts.push(`${parsed.passed} passed`)
  if (parsed.failed > 0) counts.push(`${parsed.failed} failed`)
  if (parsed.skipped > 0) counts.push(`${parsed.skipped} skipped`)
  const countStr = counts.length > 0 ? counts.join(", ") : "0 tests"
  const durStr = parsed.duration ? ` (${parsed.duration})` : ""
  parts.push(`${parsed.framework}: ${countStr}${durStr}`)

  for (const fail of parsed.failures.slice(0, 10)) {
    parts.push("")
    parts.push(fail.header)
    const { kept, omitted } = truncatePreferSalient(fail.lines, 20)
    parts.push(...kept)
    if (omitted > 0) parts.push(`  … ${omitted} more lines`)
  }
  if (parsed.failures.length > 10) parts.push(`\n… and ${parsed.failures.length - 10} more failures`)

  // Counts said failure but blocks are missing (evicted by a tail ring-buffer) — the summary
  // line carrying "N failed" must still survive, or the failure disappears silently.
  if (parsed.summaryLines.length > 0 && (parsed.failures.length > 0 || parsed.failed > 0)) {
    parts.push("")
    parts.push(...parsed.summaryLines)
  }
  return parts.join("\n")
}

function compressFallback(lines: string[]): string {
  const kept: string[] = []
  let passStreak = 0
  const isPassLine = (l: string) => /\b(passing|PASS|✓|ok\s+\d+)\b/i.test(l) && !/\bfail/i.test(l)

  for (const line of lines) {
    if (isSalientLine(line)) {
      if (passStreak > 3) kept.push(`… (${passStreak} passing lines collapsed) …`)
      passStreak = 0; kept.push(line); continue
    }
    if (isPassLine(line)) { passStreak++; continue }
    if (passStreak > 3) { kept.push(`… (${passStreak} passing lines collapsed) …`); passStreak = 0 }
    passStreak = 0; kept.push(line)
  }
  if (passStreak > 3) kept.push(`… (${passStreak} passing lines collapsed) …`)

  const summary = lines.find((l) => /\b(tests?\s+\d+|passed|failed|suites?)/i.test(l)) ?? ""
  const body = kept.join("\n").trim()
  return summary && !kept.includes(summary) ? `${summary}\n${body}` : body
}

// A composite command (`;` chains, or any `|`/`||` pipe) can mask a real failure's exit code
// behind an unrelated trailing command's success — don't trust exitCode === 0 in that shape.
// A plain `&&` chain is safe: it short-circuits on the first non-zero exit.
function isExitCodeTrusted(command: string | undefined): boolean {
  if (!command) return true
  return !/[;|]/.test(command)
}

export function compressTestResults(text: string, command?: string, exitCode?: number): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const framework = detectTestFramework(command, lines)
  if (framework === "generic") return compressFallback(lines)

  let parsed: ParsedTestOutput
  try {
    switch (framework) {
      case "vitest":
        parsed = parseVitest(lines); break
      case "jest":
        parsed = parseJest(lines); break
      case "pytest":
        parsed = parsePytest(lines); break
      case "cargo_test":
        parsed = parseCargoTest(lines); break
      case "go_test":
        parsed = parseGoTest(lines); break
      case "rspec":
        parsed = parseRspec(lines); break
      case "phpunit":
        parsed = parsePhpunit(lines); break
      case "dotnet_test":
        parsed = parseDotnetTest(lines); break
      case "elixir_test":
        parsed = parseElixirTest(lines); break
      case "playwright":
        parsed = parsePlaywright(lines); break
      case "bun_test":
        parsed = parseBunTest(lines); break
    }
  } catch {
    return compressFallback(lines)
  }

  // "Test suite failed to run" (e.g. no it()/describe blocks) parses to 0 passed/0 failed —
  // indistinguishable from an empty passing run to the counts below — so this check runs
  // first and independent of exitCode/isExitCodeTrusted: a masked exit code (piped through
  // `| tail -N`) must never suppress the one piece of information that explains the failure.
  if (framework === "jest") {
    const suiteFailureDetail = findJestSuiteFailureDetail(lines)
    if (suiteFailureDetail) {
      const counts: string[] = []
      if (parsed.passed > 0) counts.push(`${parsed.passed} passed`)
      if (parsed.failed > 0) counts.push(`${parsed.failed} failed`)
      if (parsed.skipped > 0) counts.push(`${parsed.skipped} skipped`)
      const countStr = counts.length > 0 ? counts.join(", ") : "0 tests"
      return `jest: suite failed to run — ${suiteFailureDetail} (${countStr})`
    }
  }

  if (parsed.passed === 0 && parsed.failed === 0 && parsed.summaryLines.length === 0) {
    return compressFallback(lines)
  }

  if (
    exitCode === 0 &&
    parsed.failures.length === 0 &&
    parsed.failed === 0 &&
    parsed.passed > 0 &&
    isExitCodeTrusted(command)
  ) {
    const durStr = parsed.duration ? ` (${parsed.duration})` : ""
    return `${parsed.framework}: ${parsed.passed} passed${parsed.skipped > 0 ? `, ${parsed.skipped} skipped` : ""}${durStr}`
  }

  return emitCompressed(parsed)
}
