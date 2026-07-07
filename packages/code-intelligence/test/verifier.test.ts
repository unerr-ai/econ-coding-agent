/**
 * Unit tests for verifier.ts: runSoundCheck (injected command runner, no
 * shell-out, skip-count suspicion), extractCaseCount/compareCaseCounts
 * (dropped-case integrity), monitorTrajectory (F15 behavior-monitor pattern
 * detection), and runVerifierLadder (sound -> behavior gate -> extension/QE
 * composition).
 */

import { describe, it, expect } from "bun:test"
import {
  runSoundCheck,
  extractCaseCount,
  compareCaseCounts,
  monitorTrajectory,
  runVerifierLadder,
  type VerifyCommand,
  type CommandRunner,
  type CommandResult,
  type SliceTrajectory,
} from "../src/verifier.js"

// ---------------------------------------------------------------------------
// runSoundCheck
// ---------------------------------------------------------------------------

describe("runSoundCheck", () => {
  it("is vacuously applicable:false, pass:true on an empty spec (untestable slice)", async () => {
    const runner: CommandRunner = async () => {
      throw new Error("should never be called")
    }
    const verdict = await runSoundCheck({ commands: [] }, runner)
    expect(verdict.rung).toBe("sound")
    expect(verdict.applicable).toBe(false)
    expect(verdict.pass).toBe(true)
    expect(verdict.failures).toEqual([])
  })

  it("passes when every injected command exits 0", async () => {
    const commands: VerifyCommand[] = [
      { kind: "typecheck", command: "bun run typecheck" },
      { kind: "test", command: "bun test foo.test.ts" },
    ]
    const runner: CommandRunner = async (): Promise<CommandResult> => ({ exitCode: 0, stdout: "ok", stderr: "" })
    const verdict = await runSoundCheck({ commands }, runner)
    expect(verdict.applicable).toBe(true)
    expect(verdict.pass).toBe(true)
    expect(verdict.failures).toEqual([])
  })

  it("collects every failing command, not just the first", async () => {
    const commands: VerifyCommand[] = [
      { kind: "typecheck", command: "bun run typecheck" },
      { kind: "test", command: "bun test foo.test.ts" },
      { kind: "lint", command: "bun run lint" },
    ]
    const runner: CommandRunner = async (command): Promise<CommandResult> =>
      command.kind === "lint"
        ? { exitCode: 0, stdout: "", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: `${command.kind} failed` }
    const verdict = await runSoundCheck({ commands }, runner)
    expect(verdict.pass).toBe(false)
    expect(verdict.failures.length).toBe(2)
    expect(verdict.failures.map((f) => f.command.kind)).toEqual(["typecheck", "test"])
  })
})

// ---------------------------------------------------------------------------
// runSoundCheck — skip-count suspicion (a green run that skipped cases)
// ---------------------------------------------------------------------------

describe("runSoundCheck — skip-count suspicion", () => {
  const commands: VerifyCommand[] = [{ kind: "test", command: "python -m pytest" }]

  it('flags a green run reporting "OK (skipped=10)" without failing it', async () => {
    const runner: CommandRunner = async (): Promise<CommandResult> => ({
      exitCode: 0,
      stdout: "Ran 42 tests in 0.5s\n\nOK (skipped=10)",
      stderr: "",
    })
    const verdict = await runSoundCheck({ commands }, runner)
    expect(verdict.pass).toBe(true)
    expect(verdict.flags?.map((f) => f.kind)).toContain("pass-with-skips")
    expect(verdict.flags?.[0]?.detail).toContain("skipped=10")
  })

  it('flags an "N skipped" summary and a "--- SKIP:" line', async () => {
    const jestRunner: CommandRunner = async (): Promise<CommandResult> => ({
      exitCode: 0,
      stdout: "Tests:       3 skipped, 9 passed, 12 total",
      stderr: "",
    })
    expect((await runSoundCheck({ commands }, jestRunner)).flags?.length).toBe(1)

    const goRunner: CommandRunner = async (): Promise<CommandResult> => ({
      exitCode: 0,
      stdout: "--- SKIP: TestBoundary (0.00s)\nPASS\nok  pkg  0.2s",
      stderr: "",
    })
    expect((await runSoundCheck({ commands }, goRunner)).flags?.length).toBe(1)
  })

  it('does not flag "skipped=0", "0 skipped", or a clean pass', async () => {
    for (const stdout of ["OK (skipped=0)", "Tests: 0 skipped, 12 passed, 12 total", "all ok"]) {
      const runner: CommandRunner = async (): Promise<CommandResult> => ({ exitCode: 0, stdout, stderr: "" })
      expect((await runSoundCheck({ commands }, runner)).flags).toEqual([])
    }
  })

  it("does not add a skip flag to a failing command — the failure already dominates", async () => {
    const runner: CommandRunner = async (): Promise<CommandResult> => ({
      exitCode: 1,
      stdout: "FAILED (failures=1, skipped=10)",
      stderr: "",
    })
    const verdict = await runSoundCheck({ commands }, runner)
    expect(verdict.pass).toBe(false)
    expect(verdict.flags).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// extractCaseCount / compareCaseCounts — dropped-case integrity
// ---------------------------------------------------------------------------

describe("extractCaseCount", () => {
  it("reads unittest/bun 'Ran N tests' summaries", () => {
    expect(extractCaseCount("Ran 12 tests in 0.005s\n\nOK")).toBe(12)
    expect(extractCaseCount(" 5 pass\n 0 fail\nRan 5 tests across 1 files. [10.00ms]")).toBe(5)
  })

  it("reads the jest/vitest 'Tests: ... N total' summary", () => {
    expect(extractCaseCount("Tests:       2 failed, 10 passed, 12 total\nTime: 3s")).toBe(12)
  })

  it("sums the statuses on the pytest summary line, skipping the session header", () => {
    const output = [
      "==================== test session starts ====================",
      "collected 5 items",
      "",
      "==================== 4 passed, 1 skipped in 0.12s ====================",
    ].join("\n")
    expect(extractCaseCount(output)).toBe(5)
  })

  it("counts verbose go-test result lines", () => {
    const output = "=== RUN TestA\n--- PASS: TestA (0.00s)\n=== RUN TestB\n--- SKIP: TestB (0.00s)\nPASS"
    expect(extractCaseCount(output)).toBe(2)
  })

  it("returns undefined when no summary shape matches — never guesses", () => {
    expect(extractCaseCount("$ tsc --noEmit\n(no output)")).toBeUndefined()
  })
})

describe("compareCaseCounts", () => {
  it("reports shrank when the re-run covers fewer cases than the previous attempt", () => {
    const result = compareCaseCounts("Ran 12 tests in 0.5s\nOK", "Ran 9 tests in 0.4s\nOK")
    expect(result.verdict).toBe("shrank")
    expect(result.previous).toBe(12)
    expect(result.current).toBe(9)
  })

  it("is ok on an equal or grown count, and accepts pre-extracted numbers", () => {
    expect(compareCaseCounts("Tests: 12 total", "Tests: 12 total").verdict).toBe("ok")
    expect(compareCaseCounts(9, 12).verdict).toBe("ok")
  })

  it("is unknown (no false alarm) when either side yields no count", () => {
    expect(compareCaseCounts("no summary here", "Ran 9 tests").verdict).toBe("unknown")
    expect(compareCaseCounts("Ran 9 tests", undefined).verdict).toBe("unknown")
  })
})

// ---------------------------------------------------------------------------
// monitorTrajectory
// ---------------------------------------------------------------------------

describe("monitorTrajectory", () => {
  it("is clean on a trajectory with no edits", () => {
    const result = monitorTrajectory({ events: [] })
    expect(result.suspicious).toBe(false)
    expect(result.flags).toEqual([])
  })

  it("flags a test-file edit when the slice was not a test task", () => {
    const trajectory: SliceTrajectory = {
      isTestSlice: false,
      events: [{ kind: "file-edit", filePath: "src/foo.test.ts", diff: "+ // tweak" }],
    }
    const result = monitorTrajectory(trajectory)
    expect(result.suspicious).toBe(true)
    expect(result.flags.map((f) => f.kind)).toContain("test-file-edit-outside-test-slice")
  })

  it("does not flag a test-file edit when the slice IS a test task", () => {
    const trajectory: SliceTrajectory = {
      isTestSlice: true,
      events: [{ kind: "file-edit", filePath: "src/foo.test.ts", diff: "+ it('works', () => {})" }],
    }
    const result = monitorTrajectory(trajectory)
    expect(result.suspicious).toBe(false)
  })

  it("flags an added .skip marker", () => {
    const trajectory: SliceTrajectory = {
      isTestSlice: true,
      events: [
        {
          kind: "file-edit",
          filePath: "src/foo.test.ts",
          diff: "-it('works', () => { expect(1).toBe(1) })\n+it.skip('works', () => { expect(1).toBe(1) })",
        },
      ],
    }
    const result = monitorTrajectory(trajectory)
    expect(result.suspicious).toBe(true)
    expect(result.flags.map((f) => f.kind)).toContain("test-skip-marker-added")
  })

  it("flags an xdescribe marker", () => {
    const trajectory: SliceTrajectory = {
      isTestSlice: true,
      events: [{ kind: "file-edit", filePath: "src/foo.test.ts", diff: "+xdescribe('suite', () => {})" }],
    }
    const result = monitorTrajectory(trajectory)
    expect(result.flags.map((f) => f.kind)).toContain("test-skip-marker-added")
  })

  it("flags weakened assertions (more removed than added)", () => {
    const trajectory: SliceTrajectory = {
      isTestSlice: true,
      events: [
        {
          kind: "file-edit",
          filePath: "src/foo.test.ts",
          diff: [
            "-expect(result.a).toBe(1)",
            "-expect(result.b).toBe(2)",
            "-expect(result.c).toBe(3)",
            "+expect(result.a).toBe(1)",
          ].join("\n"),
        },
      ],
    }
    const result = monitorTrajectory(trajectory)
    expect(result.suspicious).toBe(true)
    expect(result.flags.map((f) => f.kind)).toContain("assertion-weakened")
  })

  it("does not flag assertions that are replaced 1-for-1", () => {
    const trajectory: SliceTrajectory = {
      isTestSlice: true,
      events: [
        {
          kind: "file-edit",
          filePath: "src/foo.test.ts",
          diff: "-expect(result).toBe(1)\n+expect(result).toBe(2)",
        },
      ],
    }
    const result = monitorTrajectory(trajectory)
    expect(result.suspicious).toBe(false)
  })

  it("flags a config change that disables a type/lint check", () => {
    const trajectory: SliceTrajectory = {
      events: [
        {
          kind: "file-edit",
          filePath: "tsconfig.json",
          diff: '+  "skipLibCheck": true,',
        },
      ],
    }
    const result = monitorTrajectory(trajectory)
    expect(result.suspicious).toBe(true)
    expect(result.flags.map((f) => f.kind)).toContain("check-disabling-config-change")
  })

  it("ignores command events (only file-edit events are scanned)", () => {
    const trajectory: SliceTrajectory = {
      events: [{ kind: "command", command: "bun test" }],
    }
    const result = monitorTrajectory(trajectory)
    expect(result.suspicious).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// monitorTrajectory — OL-9.3b bash-write guard (read-only recon/verify lane)
// ---------------------------------------------------------------------------

describe("monitorTrajectory — OL-9.3b bash-write guard", () => {
  it("flags a write-shaped bash command in a read-only (recon) slice, citing the command", () => {
    const trajectory: SliceTrajectory = {
      isReadOnlySlice: true,
      events: [{ kind: "command", command: "cat > src/x.js" }],
    }
    const result = monitorTrajectory(trajectory)
    expect(result.suspicious).toBe(true)
    const flag = result.flags.find((f) => f.kind === "write-shaped-command-in-read-only-slice")
    expect(flag).toBeDefined()
    expect(flag?.detail).toContain("cat > src/x.js")
  })

  it("flags the same write-shaped command in a verify slice", () => {
    const trajectory: SliceTrajectory = {
      isReadOnlySlice: true,
      events: [{ kind: "command", command: "sed -i 's/foo/bar/' src/x.js" }],
    }
    const result = monitorTrajectory(trajectory)
    expect(result.suspicious).toBe(true)
    expect(result.flags.map((f) => f.kind)).toContain("write-shaped-command-in-read-only-slice")
  })

  it("does not flag a read-only slice whose commands are pure reads", () => {
    const trajectory: SliceTrajectory = {
      isReadOnlySlice: true,
      events: [
        { kind: "command", command: "grep -rn refreshToken src" },
        { kind: "command", command: "cat src/auth/refresh.ts" },
        { kind: "command", command: "bun test" },
      ],
    }
    const result = monitorTrajectory(trajectory)
    expect(result.suspicious).toBe(false)
  })

  it("does not flag a write-shaped command in a NON-read-only (mechanical) slice", () => {
    const trajectory: SliceTrajectory = {
      isReadOnlySlice: false,
      events: [{ kind: "command", command: "cat > src/x.js" }],
    }
    const result = monitorTrajectory(trajectory)
    expect(result.suspicious).toBe(false)
  })

  it("does NOT trip on a redirect into /tmp from a read-only slice", () => {
    const trajectory: SliceTrajectory = {
      isReadOnlySlice: true,
      events: [{ kind: "command", command: 'node -e "console.log(1)" > /tmp/out.txt' }],
    }
    const result = monitorTrajectory(trajectory)
    expect(result.suspicious).toBe(false)
  })

  it("flags tee, patch, and mv/cp to a repo path in a read-only slice", () => {
    const teeResult = monitorTrajectory({
      isReadOnlySlice: true,
      events: [{ kind: "command", command: "echo hi | tee src/notes.txt" }],
    })
    expect(teeResult.suspicious).toBe(true)

    const patchResult = monitorTrajectory({
      isReadOnlySlice: true,
      events: [{ kind: "command", command: "git apply fix.diff" }],
    })
    expect(patchResult.suspicious).toBe(true)

    const mvResult = monitorTrajectory({
      isReadOnlySlice: true,
      events: [{ kind: "command", command: "cp /tmp/scratch.ts src/scratch.ts" }],
    })
    expect(mvResult.suspicious).toBe(true)
  })

  it("does not flag mv/cp that stays entirely within /tmp", () => {
    const result = monitorTrajectory({
      isReadOnlySlice: true,
      events: [{ kind: "command", command: "cp /tmp/a.txt /tmp/b.txt" }],
    })
    expect(result.suspicious).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// runVerifierLadder
// ---------------------------------------------------------------------------

describe("runVerifierLadder", () => {
  const passRunner: CommandRunner = async (): Promise<CommandResult> => ({ exitCode: 0, stdout: "", stderr: "" })
  const failRunner: CommandRunner = async (): Promise<CommandResult> => ({ exitCode: 1, stdout: "", stderr: "boom" })
  const cleanTrajectory: SliceTrajectory = { events: [] }

  it("accepts on rung 'sound' when the sound check passes and the trajectory is clean", async () => {
    const verdict = await runVerifierLadder({
      spec: { commands: [{ kind: "typecheck", command: "tsc" }] },
      runner: passRunner,
      trajectory: cleanTrajectory,
    })
    expect(verdict.accepted).toBe(true)
    expect(verdict.rung).toBe("sound")
  })

  it("rejects on rung 'sound' when the sound check fails", async () => {
    const verdict = await runVerifierLadder({
      spec: { commands: [{ kind: "test", command: "bun test" }] },
      runner: failRunner,
      trajectory: cleanTrajectory,
    })
    expect(verdict.accepted).toBe(false)
    expect(verdict.rung).toBe("sound")
    expect(verdict.sound.failures.length).toBe(1)
  })

  it("rejects on rung 'behavior' when the trajectory is suspicious, even though sound passed", async () => {
    const suspiciousTrajectory: SliceTrajectory = {
      isTestSlice: false,
      events: [{ kind: "file-edit", filePath: "src/foo.test.ts", diff: "+it.skip('x', () => {})" }],
    }
    const verdict = await runVerifierLadder({
      spec: { commands: [{ kind: "test", command: "bun test" }] },
      runner: passRunner,
      trajectory: suspiciousTrajectory,
    })
    expect(verdict.accepted).toBe(false)
    expect(verdict.rung).toBe("behavior")
    expect(verdict.behavior.suspicious).toBe(true)
  })

  it("falls through to the extraRung when the slice is untestable (no sound check applies)", async () => {
    const verdict = await runVerifierLadder({
      spec: { commands: [] },
      runner: passRunner,
      trajectory: cleanTrajectory,
      extraRung: () => ({ rung: "rm", pass: true, detail: "scored 0.9" }),
    })
    expect(verdict.accepted).toBe(true)
    expect(verdict.rung).toBe("rm")
    expect(verdict.extra?.detail).toBe("scored 0.9")
  })

  it("falls through to QE when untestable, clean trajectory, and no extraRung", async () => {
    const text = "function add(a, b) { return a + b }"
    const verdict = await runVerifierLadder({
      spec: { commands: [] },
      runner: passRunner,
      trajectory: cleanTrajectory,
      qe: { conductorResult: { text }, generate: async () => text },
    })
    expect(verdict.accepted).toBe(true)
    expect(verdict.rung).toBe("qe")
    expect(verdict.qe).toBeDefined()
  })

  it("accepts unverified when untestable, clean trajectory, and neither extraRung nor QE configured (OL-9.5d: absence of a check is not evidence of failure)", async () => {
    const verdict = await runVerifierLadder({
      spec: { commands: [] },
      runner: passRunner,
      trajectory: cleanTrajectory,
    })
    expect(verdict.accepted).toBe(true)
    expect(verdict.unverified).toBe(true)
    expect(verdict.reason).toContain("untestable slice")
    expect(verdict.missing).toBeUndefined()
  })

  it("skips the extraRung when it declines (returns undefined) and falls to QE", async () => {
    const text = "function add(a, b) { return a + b }"
    const verdict = await runVerifierLadder({
      spec: { commands: [] },
      runner: passRunner,
      trajectory: cleanTrajectory,
      extraRung: () => undefined,
      qe: { conductorResult: { text }, generate: async () => text },
    })
    expect(verdict.accepted).toBe(true)
    expect(verdict.rung).toBe("qe")
  })
})

// ---------------------------------------------------------------------------
// runVerifierLadder — skip suspicion + dropped-case integrity on the sound rung
// ---------------------------------------------------------------------------

describe("runVerifierLadder — skip suspicion and dropped-case integrity", () => {
  const cleanTrajectory: SliceTrajectory = { events: [] }
  const spec = { commands: [{ kind: "test", command: "python -m pytest" } satisfies VerifyCommand] }

  it("accepts a pass with skips but carries the suspicion into the reason and sound.flags", async () => {
    const runner: CommandRunner = async (): Promise<CommandResult> => ({
      exitCode: 0,
      stdout: "OK (skipped=10)",
      stderr: "",
    })
    const verdict = await runVerifierLadder({ spec, runner, trajectory: cleanTrajectory })
    expect(verdict.accepted).toBe(true)
    expect(verdict.rung).toBe("sound")
    expect(verdict.reason).toContain("skipped=10")
    expect(verdict.sound.flags?.map((f) => f.kind)).toContain("pass-with-skips")
  })

  it("rejects a green run whose case count shrank versus the previous attempt", async () => {
    const runner: CommandRunner = async (): Promise<CommandResult> => ({
      exitCode: 0,
      stdout: "Ran 9 tests in 0.4s\n\nOK",
      stderr: "",
    })
    const verdict = await runVerifierLadder({ spec, runner, trajectory: cleanTrajectory, previousCaseCount: 12 })
    expect(verdict.accepted).toBe(false)
    expect(verdict.rung).toBe("sound")
    expect(verdict.reason).toContain("shrank")
    expect(verdict.missing).toContain("MISSING:")
    expect(verdict.missing).toContain("12")
  })

  it("does not reject when no previous count is supplied, and exposes this attempt's count for threading", async () => {
    const runner: CommandRunner = async (): Promise<CommandResult> => ({
      exitCode: 0,
      stdout: "Ran 9 tests in 0.4s\n\nOK",
      stderr: "",
    })
    const verdict = await runVerifierLadder({ spec, runner, trajectory: cleanTrajectory })
    expect(verdict.accepted).toBe(true)
    expect(verdict.sound.caseCount).toBe(9)
  })

  it("does not reject (unknown, no false alarm) when this attempt's output yields no count", async () => {
    const runner: CommandRunner = async (): Promise<CommandResult> => ({ exitCode: 0, stdout: "ok", stderr: "" })
    const verdict = await runVerifierLadder({ spec, runner, trajectory: cleanTrajectory, previousCaseCount: 12 })
    expect(verdict.accepted).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// runVerifierLadder — OL-9.4c every reject path names its MISSING evidence
// ---------------------------------------------------------------------------

describe("runVerifierLadder — OL-9.4c synthesized MISSING evidence on reject", () => {
  const passRunner: CommandRunner = async (): Promise<CommandResult> => ({ exitCode: 0, stdout: "", stderr: "" })
  const failRunner: CommandRunner = async (): Promise<CommandResult> => ({ exitCode: 1, stdout: "", stderr: "boom" })
  const cleanTrajectory: SliceTrajectory = { events: [] }

  it("names the failing command(s) on a sound-rung reject", async () => {
    const verdict = await runVerifierLadder({
      spec: { commands: [{ kind: "test", command: "bun test" }] },
      runner: failRunner,
      trajectory: cleanTrajectory,
    })
    expect(verdict.accepted).toBe(false)
    expect(verdict.missing).toBeDefined()
    expect(verdict.missing).toContain("MISSING:")
    expect(verdict.missing).toContain("bun test")
  })

  it("does not set missing on an accepted sound-rung verdict", async () => {
    const verdict = await runVerifierLadder({
      spec: { commands: [{ kind: "test", command: "bun test" }] },
      runner: passRunner,
      trajectory: cleanTrajectory,
    })
    expect(verdict.accepted).toBe(true)
    expect(verdict.missing).toBeUndefined()
  })

  it("names the flagged pattern on a behavior-rung reject", async () => {
    const suspiciousTrajectory: SliceTrajectory = {
      isTestSlice: false,
      events: [{ kind: "file-edit", filePath: "src/foo.test.ts", diff: "+it.skip('x', () => {})" }],
    }
    const verdict = await runVerifierLadder({
      spec: { commands: [{ kind: "test", command: "bun test" }] },
      runner: passRunner,
      trajectory: suspiciousTrajectory,
    })
    expect(verdict.accepted).toBe(false)
    expect(verdict.missing).toContain("MISSING:")
    expect(verdict.missing).toContain("test-skip-marker-added")
  })

  it("propagates the extraRung's own missing line on reject", async () => {
    const verdict = await runVerifierLadder({
      spec: { commands: [] },
      runner: passRunner,
      trajectory: cleanTrajectory,
      extraRung: () => ({ rung: "rm", pass: false, detail: "scored 0.2", missing: "MISSING: a scored diff above 0.5" }),
    })
    expect(verdict.accepted).toBe(false)
    expect(verdict.missing).toBe("MISSING: a scored diff above 0.5")
  })

  it("synthesizes a generic missing line when the extraRung rejects without one", async () => {
    const verdict = await runVerifierLadder({
      spec: { commands: [] },
      runner: passRunner,
      trajectory: cleanTrajectory,
      extraRung: () => ({ rung: "rm", pass: false, detail: "scored 0.2" }),
    })
    expect(verdict.accepted).toBe(false)
    expect(verdict.missing).toContain("MISSING:")
  })

  it("names the self-consistency gap on a QE veto reject", async () => {
    const verdict = await runVerifierLadder({
      spec: { commands: [] },
      runner: passRunner,
      trajectory: cleanTrajectory,
      qe: { conductorResult: { text: "a" }, generate: async () => "completely different answer entirely" },
    })
    expect(verdict.accepted).toBe(false)
    expect(verdict.rung).toBe("qe")
    expect(verdict.missing).toContain("MISSING:")
  })

  it("does NOT set a missing line on the untestable no-rung fallback — it's accepted-unverified, not a reject (OL-9.5d)", async () => {
    const verdict = await runVerifierLadder({
      spec: { commands: [] },
      runner: passRunner,
      trajectory: cleanTrajectory,
    })
    expect(verdict.accepted).toBe(true)
    expect(verdict.unverified).toBe(true)
    expect(verdict.missing).toBeUndefined()
  })
})
