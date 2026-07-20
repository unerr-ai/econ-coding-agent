/**
 * P1 extension to verifier.ts's runSoundCheck (docs/design/agnostic-hands-eyes.md
 * §2.2): a `CommandResult.report` (report-native case count + skip count,
 * populated by a caller that already parsed a structured test report) is
 * preferred over the summary-line regexes. Kept in its own file so the
 * pre-existing verifier.test.ts suite stays byte-identical.
 */
import { describe, it, expect } from "bun:test"
import { runSoundCheck, type VerifyCommand, type CommandRunner, type CommandResult } from "../src/verifier.js"

describe("runSoundCheck — report-native case count / skip detection", () => {
  it("prefers the report-native case count over a summary-line regex when both are present", async () => {
    const commands: VerifyCommand[] = [{ kind: "test", command: "go test ./... -json" }]
    const runner: CommandRunner = async (): Promise<CommandResult> => ({
      exitCode: 0,
      // Deliberately carries a DIFFERENT count than the report — proves the
      // report wins, not just that it's used when the regex would miss.
      stdout: "Ran 999 tests in 0.5s",
      stderr: "",
      report: { caseCount: 7, skipped: 0 },
    })
    const verdict = await runSoundCheck({ commands }, runner)
    expect(verdict.caseCount).toBe(7)
  })

  it("falls back to extractCaseCount's summary-line regex when no report is attached — today's behavior, byte-identical", async () => {
    const commands: VerifyCommand[] = [{ kind: "test", command: "bun test foo.test.ts" }]
    const runner: CommandRunner = async (): Promise<CommandResult> => ({
      exitCode: 0,
      stdout: "Ran 5 tests across 1 files.",
      stderr: "",
    })
    const verdict = await runSoundCheck({ commands }, runner)
    expect(verdict.caseCount).toBe(5)
  })

  it("flags pass-with-skips from a report-native skip count, even when the plain output text carries no skip signature", async () => {
    const commands: VerifyCommand[] = [{ kind: "test", command: "npx jest --json" }]
    const runner: CommandRunner = async (): Promise<CommandResult> => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
      report: { caseCount: 3, skipped: 1 },
    })
    const verdict = await runSoundCheck({ commands }, runner)
    expect(verdict.pass).toBe(true)
    expect(verdict.flags?.some((f) => f.kind === "pass-with-skips")).toBe(true)
  })

  it("a report with skipped:0 does NOT flag pass-with-skips, even if the (unused) plain text would have matched a skip regex", async () => {
    const commands: VerifyCommand[] = [{ kind: "test", command: "npx jest --json" }]
    const runner: CommandRunner = async (): Promise<CommandResult> => ({
      exitCode: 0,
      stdout: "3 skipped", // would match findSkipSignature, but report takes precedence
      stderr: "",
      report: { caseCount: 3, skipped: 0 },
    })
    const verdict = await runSoundCheck({ commands }, runner)
    expect(verdict.flags).toEqual([])
  })

  it("a failing command's report-native case count still accumulates into the total", async () => {
    const commands: VerifyCommand[] = [{ kind: "test", command: "go test ./... -json" }]
    const runner: CommandRunner = async (): Promise<CommandResult> => ({
      exitCode: 1,
      stdout: "",
      stderr: "",
      report: { caseCount: 4, skipped: 0 },
    })
    const verdict = await runSoundCheck({ commands }, runner)
    expect(verdict.pass).toBe(false)
    expect(verdict.caseCount).toBe(4)
  })
})
