/**
 * OL-7.8 sound verifier rung + trajectory behavior monitoring: the
 * deterministic gate that makes default-cheap slice execution safe.
 * `runSoundCheck` runs a slice's typecheck/test/lint commands through an
 * injected runner (pure — no shell-out in unit tests), flags skip signatures
 * in otherwise-passing output ("OK (skipped=10)" is suspicion, not success),
 * and extracts a case count so the ladder can reject a green attempt whose
 * suite shrank since the previous one (dropped-case integrity); `runRegressionGate`
 * re-runs a set of previously-green neighbor tests through the same injected
 * runner and reports any that turned red, catching a fix that regresses an
 * untouched neighbor while the slice's own sound check still passes;
 * `monitorTrajectory`
 * flags reward-hacking patterns (test-file edits outside a test slice,
 * weakened assertions, skip markers added, check-disabling config changes)
 * that a green outcome alone would miss (F15), and — for a read-only
 * (recon/verify) slice — a bash command shaped like a write (OL-9.3b),
 * closing the gap where the host's edit-tool deny lane doesn't see a
 * write hidden inside a shell command. `runVerifierLadder` composes both —
 * sound first, then the behavior gate, then (once sound has passed or is
 * inapplicable) an optional pinned-reproduction probe (`VerifySpec.probeCommand`,
 * rung "probe" — task #7 localization/repro verification: the slice's
 * specific failing case must go red→green, checked independently of the
 * generic `commands` list, so a red probe rejects even when the sound check
 * itself passed) — and only when no sound check applies (untestable slice)
 * does the ladder fall further through to the optional OL-7.8a extension
 * rung (execution-free RM, a later task; this only reserves the typed
 * extension point) and the existing QE veto (qe.ts). Every reject verdict carries a `missing`
 * field naming the evidence that would have passed it (OL-9.4c); the
 * trajectory also tracks `file-read` events so a rescue's escalation brief
 * can point at what was already read instead of re-deriving it.
 *
 * @sem domain=routing role=verify-ladder
 */

import type { ConductorResult } from "./abstention.js"
import { shouldVetoCheapOutput, type RunQeVetoOptions, type ShouldVetoCheapOutputResult } from "./qe.js"

// ---------------------------------------------------------------------------
// Sound check — types
// ---------------------------------------------------------------------------

/** Which class of deterministic check a command belongs to. `guard` is an integrity precondition (e.g. the unmodified-test-tree check) — it validates that the other commands' results can be trusted, not the work itself. */
export type VerifyCommandKind = "typecheck" | "test" | "lint" | "guard"

/** One deterministic command a slice's verify spec asks to run. */
export interface VerifyCommand {
  kind: VerifyCommandKind
  /** Shell command to execute, e.g. "bun run typecheck" or "bun test path/to.test.ts". */
  command: string
}

/** Which typecheck/test/lint commands apply to a slice — assembled by the caller (OL-7.3 slice loop). `probeCommand` is a distinct, optional pinned reproduction that gates separately as rung "probe" (task #7 localization/repro verification). */
export interface VerifySpec {
  commands: VerifyCommand[]
  /** A pinned reproduction that MUST transition red→green — e.g. the exact repro of the bug being fixed. Distinct from `commands`: when unset, no probe rung fires and the ladder behaves exactly as before. */
  probeCommand?: VerifyCommand
}

/** Outcome of running one VerifyCommand — supplied by the injected runner. */
export interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
  /**
   * Report-native case count + skip count when the caller has already
   * parsed a structured test report (JUnit XML / go test -json / jest
   * `--json` / TAP — docs/design/agnostic-hands-eyes.md §2.2) for this
   * command. When present, `runSoundCheck` prefers these over the
   * summary-line regexes below. Optional: every existing runner double
   * that omits it keeps today's regex-only behavior byte-identical.
   */
  report?: { caseCount: number; skipped: number }
}

/** Injected command executor — tests pass a double, the live wiring shells out. */
export type CommandRunner = (command: VerifyCommand) => Promise<CommandResult>

/** A failed sound-check command, carrying its result for the escalation context. */
export interface SoundFailure extends CommandResult {
  command: VerifyCommand
}

/** Verdict of the sound rung: trustworthy when pass is true and applicable is true. */
export interface SoundVerdict {
  rung: "sound"
  pass: boolean
  failures: SoundFailure[]
  /** false when the slice's spec had no commands (untestable) — pass is then vacuous, not a real check. */
  applicable: boolean
  /** "pass-with-skips" suspicions found in otherwise-passing command output — surfaced to the ladder/judge, never a hard fail. Always set by runSoundCheck; optional only for hand-built verdicts. */
  flags?: BehaviorFlag[]
  /** Total case count extracted from the commands' summary lines (extractCaseCount) — undefined when no output yields one. */
  caseCount?: number
}

// ---------------------------------------------------------------------------
// Sound check — the pure-ish command-runner rung
// ---------------------------------------------------------------------------

/**
 * Skip signatures in a green run: unittest "OK (skipped=10)", jest/vitest/
 * pytest "..., 3 skipped", go test "--- SKIP: TestX". Conservative on purpose
 * — "skipped=0" / "0 skipped" never match, and a SKIP line must start its own
 * line — so a clean pass is never flagged.
 */
const SKIP_SIGNATURE_RES = [/\bskipped\s*=?\s*[1-9]\d*/i, /\b[1-9]\d*\s+skipped\b/i, /^\s*(?:---\s+)?SKIP:/m]

function findSkipSignature(output: string): string | undefined {
  for (const re of SKIP_SIGNATURE_RES) {
    const match = output.match(re)
    if (match) return match[0].trim()
  }
  return undefined
}

/**
 * Runs every command in a slice's verify spec through the injected runner and
 * collects failures. An empty spec (untestable slice) is not a check — it
 * returns pass:true, applicable:false so the caller knows to degrade to the
 * next rung rather than treat this as a trustworthy green. A passing command
 * whose output carries a skip signature is flagged "pass-with-skips" rather
 * than failed, and a case count is extracted from every output so the ladder
 * can compare successive attempts (dropped-case integrity). When a result
 * carries a report-native `report` (§2.2's structured-observation layer),
 * its case/skip counts are preferred over the summary-line regexes below —
 * the regexes stay as the fallback for every runner double that doesn't set it.
 *
 * @sem domain=routing role=sound-verify
 */
export async function runSoundCheck(spec: VerifySpec, runner: CommandRunner): Promise<SoundVerdict> {
  if (spec.commands.length === 0) {
    return { rung: "sound", pass: true, failures: [], applicable: false, flags: [] }
  }

  const failures: SoundFailure[] = []
  const flags: BehaviorFlag[] = []
  let caseCount: number | undefined
  for (const command of spec.commands) {
    const result = await runner(command)
    const output = `${result.stdout}\n${result.stderr}`
    const count = result.report ? result.report.caseCount : extractCaseCount(output)
    if (count !== undefined) caseCount = (caseCount ?? 0) + count
    if (result.exitCode !== 0) {
      failures.push({ ...result, command })
      continue
    }
    const skip = result.report
      ? result.report.skipped > 0
        ? `${result.report.skipped} skipped (report-native)`
        : undefined
      : findSkipSignature(output)
    if (skip) {
      flags.push({
        kind: "pass-with-skips",
        detail: `\`${command.command}\` passed with "${skip}" — skipped cases are suspicion, not success`,
      })
    }
  }

  return {
    rung: "sound",
    pass: failures.length === 0,
    failures,
    applicable: true,
    flags,
    ...(caseCount !== undefined ? { caseCount } : {}),
  }
}

// ---------------------------------------------------------------------------
// Regression gate — previously-green neighbor tests, checked for regressions
// ---------------------------------------------------------------------------

/**
 * Runs a set of previously-green (PASS_TO_PASS) neighbor tests through the
 * injected runner and reports any that now fail. The sound rung alone only
 * checks the slice's own spec — a fix that turns the target test green while
 * regressing an untouched neighbor still passes it unnoticed; this hands the
 * caller a factual report to gate against instead. F13a — each failure
 * carries its full `CommandResult` (exit code + stdout/stderr), reusing the
 * sound rung's `SoundFailure` shape, so a live triage can tell an
 * environment-red (non-zero exit, no assertion output) from an actual
 * assertion-red instead of just a bare command name.
 *
 * @sem domain=routing role=regression-gate
 */
export async function runRegressionGate(opts: {
  neighbors: readonly VerifyCommand[]
  runner: CommandRunner
}): Promise<{ regressed: boolean; failures: SoundFailure[] }> {
  const failures: SoundFailure[] = []
  for (const neighbor of opts.neighbors) {
    const result = await opts.runner(neighbor)
    if (result.exitCode !== 0) failures.push({ ...result, command: neighbor })
  }
  return { regressed: failures.length > 0, failures }
}

// ---------------------------------------------------------------------------
// Dropped-case integrity — case counts across successive attempts
// ---------------------------------------------------------------------------

/** Summary-line count shapes, most specific first. Conservative on purpose: an output matching none reports no count, so the comparison says "unknown" instead of false-alarming. */
const RAN_N_TESTS_RE = /\bRan\s+(\d+)\s+tests?\b/i // unittest "Ran 12 tests in 0.5s", bun "Ran 5 tests across 1 files."
const TESTS_TOTAL_RE = /\bTests:[^\n]*?(\d+)\s+total\b/ // jest/vitest "Tests: 2 failed, 10 passed, 12 total"
const PYTEST_SUMMARY_RE = /^=+ (.+?) =+$/gm // pytest "==== 4 passed, 1 skipped in 0.12s ===="
const PYTEST_COUNT_RE = /(\d+)\s+(?:passed|failed|skipped|xfailed|xpassed|errors?)\b/g
const GO_TEST_LINE_RE = /^\s*--- (?:PASS|FAIL|SKIP):/gm // go test -v per-test result lines

/**
 * Extracts the total case count from one verification output's summary line
 * (jest/vitest, bun, pytest, python unittest, verbose go test). Pure. Returns
 * undefined when no known summary shape matches — never guesses.
 */
export function extractCaseCount(output: string): number | undefined {
  const ran = output.match(RAN_N_TESTS_RE)
  if (ran) return Number(ran[1])
  const total = output.match(TESTS_TOTAL_RE)
  if (total) return Number(total[1])
  for (const summary of output.matchAll(PYTEST_SUMMARY_RE)) {
    let sum = 0
    let found = false
    for (const m of summary[1].matchAll(PYTEST_COUNT_RE)) {
      sum += Number(m[1])
      found = true
    }
    if (found) return sum
  }
  const goLines = output.match(GO_TEST_LINE_RE)
  if (goLines) return goLines.length
  return undefined
}

/** Outcome of comparing case counts across two successive attempts of the same slice. */
export interface CaseCountComparison {
  verdict: "shrank" | "ok" | "unknown"
  previous?: number
  current?: number
  detail: string
}

/**
 * Compares two successive verification outputs (or pre-extracted counts) from
 * the same slice's re-run commands and reports when the total case count
 * shrank — a probe case silently dropped between attempts turns a red suite
 * into a fabricated green. Pure. When either side yields no count the verdict
 * is "unknown" (no false alarms); equal or grown counts are "ok".
 */
export function compareCaseCounts(
  previous: string | number | undefined,
  current: string | number | undefined,
): CaseCountComparison {
  const prev = typeof previous === "string" ? extractCaseCount(previous) : previous
  const curr = typeof current === "string" ? extractCaseCount(current) : current
  if (prev === undefined || curr === undefined) {
    return { verdict: "unknown", previous: prev, current: curr, detail: "no comparable case count on both attempts" }
  }
  if (curr < prev) {
    return {
      verdict: "shrank",
      previous: prev,
      current: curr,
      detail: `case count shrank ${prev} -> ${curr} between attempts — probe case(s) silently dropped`,
    }
  }
  return { verdict: "ok", previous: prev, current: curr, detail: `case count ${prev} -> ${curr}` }
}

// ---------------------------------------------------------------------------
// Trajectory behavior monitoring — types
// ---------------------------------------------------------------------------

/** A file edit the executor made during the slice. */
export interface FileEditEvent {
  kind: "file-edit"
  filePath: string
  /** Unified diff (or the edit's new content) when available — powers the assertion/skip-marker/config checks below. */
  diff?: string
}

/** A shell command the executor ran during the slice. */
export interface CommandEvent {
  kind: "command"
  command: string
}

/** A file the executor read during the slice (OL-9.4c) — not an edit; feeds the escalation brief's "already read" list so a rescue trusts it instead of re-reading. */
export interface FileReadEvent {
  kind: "file-read"
  filePath: string
}

export type TrajectoryEvent = FileEditEvent | CommandEvent | FileReadEvent

/** The slice's trajectory as produced by the executor — what it touched, not just what it returned. */
export interface SliceTrajectory {
  /** True when the slice's own task was to author/modify tests — test-file edits are then expected, not suspicious. */
  isTestSlice?: boolean
  /** True for a recon/verify slice (OL-9.3b) — turns on the bash-write guard over `command` events below. */
  isReadOnlySlice?: boolean
  events: TrajectoryEvent[]
}

/** The behavior-monitor pattern kinds named in the plan doc (§4.6, F15), plus the OL-9.3b bash-write guard. "pass-with-skips" is emitted by the sound rung (runSoundCheck) on a green run that skipped cases, not by the trajectory scan. */
export type BehaviorFlagKind =
  | "test-file-edit-outside-test-slice"
  | "assertion-weakened"
  | "test-skip-marker-added"
  | "check-disabling-config-change"
  | "write-shaped-command-in-read-only-slice"
  | "pass-with-skips"

export interface BehaviorFlag {
  kind: BehaviorFlagKind
  filePath?: string
  detail: string
}

/** Result of the trajectory scan: suspicious true means a sound PASS must not count as verified. */
export interface BehaviorResult {
  suspicious: boolean
  flags: BehaviorFlag[]
}

// ---------------------------------------------------------------------------
// Trajectory behavior monitoring — detection patterns
// ---------------------------------------------------------------------------

const TEST_FILE_RE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(^|\/)__tests__\//i
const SKIP_MARKER_RE = /\b(it|test|describe)\.(skip|only)\s*\(|(^|[^A-Za-z0-9_])(xit|xdescribe|xtest)\s*\(/
const ASSERTION_RE = /\b(expect|assert)\s*[.(]/
const CONFIG_FILE_RE = /(tsconfig[^/]*\.json|\.eslintrc[^/]*|eslint\.config\.[cm]?[jt]s|package\.json)$/i
const CHECK_DISABLE_RE =
  /"skipLibCheck"\s*:\s*true|"strict"\s*:\s*false|"noImplicitAny"\s*:\s*false|"noEmitOnError"\s*:\s*false|eslint-disable|"ignoreDuringBuilds"\s*:\s*true|"ignoreBuildErrors"\s*:\s*true/

function diffLines(diff: string, prefix: "+" | "-"): string[] {
  return diff.split("\n").filter((line) => line.startsWith(prefix) && !line.startsWith(prefix.repeat(3)))
}

// ---------------------------------------------------------------------------
// OL-9.3b — read-only-lane bash-write guard: conservative, documented shapes
// ---------------------------------------------------------------------------

/**
 * Scratch-area prefixes exempt from the guard (macOS/Linux temp dirs, incl.
 * this repo's own `/private/tmp/...` scratchpad). An allowlist, not a
 * denylist: any destination NOT under one of these is treated as a
 * repo-relative write.
 */
const TEMP_PATH_RE = /^(\$\{?TMPDIR\}?\/|\/tmp\/|\/private\/tmp\/|\/var\/folders\/|\/private\/var\/folders\/)/

function unquote(token: string): string {
  return token.replace(/^["']|["']$/g, "")
}

function isTempPath(path: string): boolean {
  return TEMP_PATH_RE.test(unquote(path))
}

/**
 * A bash command counts as write-shaped when it redirects output, tees, does
 * an in-place edit, applies a patch, or moves/copies to a destination outside
 * /tmp and the OS temp dir. This is a documented denylist of SHAPES, not a
 * shell parser — it trades rare false negatives (an obfuscated write) for no
 * false positives on ordinary reads (`grep`, `cat`, `ls`, a `> /tmp/...` scratch
 * redirect). Returns a short human-readable reason when matched, undefined
 * otherwise.
 */
function findWriteShapedCommand(command: string): string | undefined {
  // `>` / `>>` redirection — skip fd-duplication forms (`2>&1`, `>&2`).
  const redirect = command.match(/(?:^|\s)\d*(>{1,2})\s*(\S+)/)
  if (redirect && !redirect[2].startsWith("&")) {
    const target = unquote(redirect[2])
    if (!isTempPath(target)) return `redirects output to \`${target}\``
  }

  // `tee [-a] <path>` — first non-flag token after tee is the destination.
  const tee = command.match(/\btee\b(?:\s+-\S+)*\s+(\S+)/)
  if (tee) {
    const target = unquote(tee[1])
    if (!isTempPath(target)) return `pipes to \`tee ${target}\``
  }

  // In-place editors.
  if (/\bsed\b[^\n]*(-i\b|--in-place\b)/.test(command)) return "in-place edit via `sed -i`"
  if (/\bperl\b[^\n]*-\w*i\w*\b/.test(command)) return "in-place edit via `perl -pi`"

  // Patch application.
  if (/\b(apply_patch|git\s+apply)\b/.test(command)) return "applies a patch"
  if (/(^|\s)patch\b/.test(command)) return "applies a patch via `patch`"

  // `mv`/`cp` to a non-temp destination — best-effort: last whitespace token.
  const moveCopy = command.match(/\b(mv|cp)\b\s+(.+)$/)
  if (moveCopy) {
    const tokens = moveCopy[2].trim().split(/\s+/)
    const dest = unquote(tokens[tokens.length - 1] ?? "")
    if (dest && !isTempPath(dest)) return `\`${moveCopy[1]}\` writes to \`${dest}\``
  }

  return undefined
}

/**
 * Scans a slice's trajectory for the reward-hacking patterns the plan doc
 * names (F15): test-file edits outside a declared test slice, more removed
 * than added assertion lines (weakened), an added .skip/.only/xit/xdescribe
 * marker, or a config edit that disables a type/lint check — plus, for a
 * read-only (recon/verify) slice, a bash command shaped like a write
 * (redirection, tee, sed -i/perl -pi, patch, mv/cp) outside /tmp (OL-9.3b).
 * `file-read` events (OL-9.4c) are informational only and never scanned here.
 * Outcome-only "tests pass" is gameable — this is the layer that watches how.
 *
 * @sem domain=routing role=behavior-monitor
 */
export function monitorTrajectory(trajectory: SliceTrajectory): BehaviorResult {
  const flags: BehaviorFlag[] = []

  for (const event of trajectory.events) {
    if (event.kind === "command") {
      if (trajectory.isReadOnlySlice) {
        const violation = findWriteShapedCommand(event.command)
        if (violation) {
          flags.push({
            kind: "write-shaped-command-in-read-only-slice",
            detail: `\`${event.command}\` ${violation} — read-only slices (recon/verify) must not mutate the tree`,
          })
        }
      }
      continue
    }

    if (event.kind === "file-read") continue

    if (TEST_FILE_RE.test(event.filePath) && !trajectory.isTestSlice) {
      flags.push({
        kind: "test-file-edit-outside-test-slice",
        filePath: event.filePath,
        detail: `edited test file ${event.filePath} but the slice was not a test task`,
      })
    }

    if (!event.diff) continue

    const addedLines = diffLines(event.diff, "+")
    const removedLines = diffLines(event.diff, "-")

    if (addedLines.some((line) => SKIP_MARKER_RE.test(line))) {
      flags.push({
        kind: "test-skip-marker-added",
        filePath: event.filePath,
        detail: "added a test-skip marker (.skip/.only/xit/xdescribe)",
      })
    }

    const removedAssertions = removedLines.filter((line) => ASSERTION_RE.test(line)).length
    const addedAssertions = addedLines.filter((line) => ASSERTION_RE.test(line)).length
    if (removedAssertions > addedAssertions) {
      flags.push({
        kind: "assertion-weakened",
        filePath: event.filePath,
        detail: `removed ${removedAssertions} assertion line(s), added only ${addedAssertions}`,
      })
    }

    if (CONFIG_FILE_RE.test(event.filePath) && addedLines.some((line) => CHECK_DISABLE_RE.test(line))) {
      flags.push({
        kind: "check-disabling-config-change",
        filePath: event.filePath,
        detail: "config change disables a type/lint check",
      })
    }
  }

  return { suspicious: flags.length > 0, flags }
}

// ---------------------------------------------------------------------------
// The ladder — sound -> behavior gate -> optional extension rung -> QE
// ---------------------------------------------------------------------------

/** Verdict of a rung beyond sound/behavior — the typed extension point for OL-7.8a (execution-free RM). */
export interface ExtraRungVerdict {
  /** Name of the rung, e.g. "rm" — surfaced verbatim in VerifierVerdict.rung. */
  rung: string
  pass: boolean
  detail?: string
  /** On a reject: a "MISSING: ..." statement naming the evidence that would flip the verdict (OL-9.4c). The judge parses this from its own reply; other rungs may leave it unset and let the ladder synthesize a generic one. */
  missing?: string
}

/**
 * OL-7.8a extension point: implemented by `rm-verifier.ts` to add the
 * execution-free reward-model rung ahead of QE. `ctx.trajectory` is the raw
 * slice trajectory (file diffs + commands) the RM scores — `sound`/`behavior`
 * alone don't carry the patch content. Returning `undefined` means the rung
 * abstains (endpoint off, unreachable, or errored) and the ladder falls
 * through to QE rather than accepting or vetoing on its behalf.
 */
export type ExtraRungFn = (
  ctx: { sound: SoundVerdict; behavior: BehaviorResult; trajectory: SliceTrajectory },
) => ExtraRungVerdict | undefined | Promise<ExtraRungVerdict | undefined>

/** Wiring for the existing QE veto (qe.ts) — used as the ladder's last rung. */
export interface LadderQeInput {
  conductorResult: ConductorResult
  generate: () => Promise<string>
  options?: RunQeVetoOptions
}

export interface VerifierLadderInput {
  spec: VerifySpec
  runner: CommandRunner
  trajectory: SliceTrajectory
  /** Case count from the previous attempt's verdict on the same slice (`sound.caseCount`) — when supplied and this attempt's count shrank, a sound pass is rejected (dropped-case integrity). The slice loop threads it between attempts. */
  previousCaseCount?: number
  /** OL-7.8a extension point (execution-free RM) — omitted today; skipped entirely when absent. */
  extraRung?: ExtraRungFn
  /** QE veto (OL-3.5a) wiring, used only when no sound check applies and no extraRung accepts. */
  qe?: LadderQeInput
}

/** Combined verdict of the ladder — the single field the slice loop (OL-7.3) reads to accept or escalate. */
export interface VerifierVerdict {
  accepted: boolean
  rung: string
  reason: string
  sound: SoundVerdict
  behavior: BehaviorResult
  extra?: ExtraRungVerdict
  qe?: ShouldVetoCheapOutputResult
  /** Set on every reject: a "MISSING: ..." statement naming the evidence that would have passed it (OL-9.4c) — lands in the escalation brief as the rescue's objective. */
  missing?: string
  /** True when accepted with no applicable check (no sound rung, no extension rung, no QE sampler) — OL-9.5d: absence of a check is not evidence of failure, so this path accepts rather than rejects. The slice loop surfaces this as outcome state "unverified" instead of "accepted". */
  unverified?: boolean
}

/** Deterministic "MISSING: ..." line for a failed sound check — names the exact command(s) that need a green re-run, not a description of the fix. */
function missingEvidenceForSound(sound: SoundVerdict): string {
  const commands = sound.failures.map((f) => `\`${f.command.command}\` (exit ${f.exitCode})`).join(", ")
  return `MISSING: a green re-run of ${commands || "the failing command(s)"} showing exit 0 — not a description of the intended fix.`
}

/** Deterministic "MISSING: ..." line for a suspicious trajectory — names the flagged pattern(s) to redo without. */
function missingEvidenceForBehavior(behavior: BehaviorResult): string {
  const kinds = [...new Set(behavior.flags.map((f) => f.kind))].join(", ")
  return `MISSING: a trajectory clear of ${kinds || "the flagged pattern"} — redo the change without it, then a fresh sound-check run.`
}

/** Deterministic "MISSING: ..." line for a red pinned reproduction — names the exact repro command and its current exit code, not a description of the fix. */
function missingEvidenceForProbe(cmd: VerifyCommand, exitCode: number): string {
  return `MISSING: a green run of the pinned reproduction \`${cmd.command}\` (currently exit ${exitCode}) — fix the CAUSE so the failing case passes; do not weaken or swap the check.`
}

/**
 * Runs the pinned reproduction (`VerifySpec.probeCommand`, task #7
 * localization/repro verification) and returns a reject verdict when it's
 * still red — `null` when there's no probeCommand, or it exits 0 (green is
 * necessary but not sufficient, so the caller still falls through to
 * whatever rung follows). Shared by both call sites in `runVerifierLadder` —
 * the sound-accept path (`commands` non-empty and passing) and the
 * untestable-slice path (`commands` empty) — so a red probe rejects the
 * same way regardless of which rung reached it.
 */
async function checkProbeRung(
  spec: VerifySpec,
  runner: CommandRunner,
  sound: SoundVerdict,
  behavior: BehaviorResult,
): Promise<VerifierVerdict | null> {
  if (!spec.probeCommand) return null
  const cmd = spec.probeCommand
  const result = await runner(cmd)
  if (result.exitCode === 0) return null
  return {
    accepted: false,
    rung: "probe",
    reason: `pinned reproduction \`${cmd.command}\` is still red (exit ${result.exitCode})`,
    sound,
    behavior,
    missing: missingEvidenceForProbe(cmd, result.exitCode),
  }
}

/**
 * The OL-7.8 ladder entry point: runs the sound check, then gates on
 * trajectory behavior flags — a sound PASS with a suspicious trajectory is
 * never accepted, it escalates instead of falling through to QE. A sound pass
 * whose case count shrank versus `previousCaseCount` is also rejected (a
 * dropped probe case reads as a fabricated green), while a pass that skipped
 * cases is accepted but carries its pass-with-skips flag into the verdict
 * reason so the caller sees the suspicion. Once sound has passed (whether
 * an applicable command list passed, or the slice is untestable and sound
 * is vacuously true) does the ladder gate on an optional pinned-reproduction
 * probe (`VerifySpec.probeCommand`, rung "probe" — task #7 localization/repro
 * verification: the slice's specific failing case must go red→green, run
 * independently of the generic `commands` list via the shared
 * `checkProbeRung` helper — a red probe rejects even when the sound check
 * itself passed; green is necessary but not sufficient, so the ladder still
 * falls through). Only when no sound check applies (untestable slice) and
 * the probe (if any) is clean does the ladder degrade further to the
 * optional extension rung and then the existing QE veto, wired through
 * qe.ts rather than reimplemented here. When NONE of probe/extension/QE
 * apply, the slice is accepted with `unverified: true`
 * (OL-9.5d) rather than rejected: absence of any applicable check is not
 * evidence of failure, and laddering an unverifiable slice only re-runs
 * identical work with no new signal (run-8 post-mortem: 8 briefs escalated
 * into 62 runner sessions, one "Apply the fix" dispatched 5x, against work
 * that was already correct). Every OTHER reject path still carries a
 * `missing` field (OL-9.4c) — synthesized from the failing check itself for
 * sound/behavior/probe/QE, or propagated from the extension rung (e.g. the
 * judge's parsed "MISSING: ..." line) — so the escalation brief always
 * states what evidence would have passed; the no-rung fallback carries none,
 * since it is no longer a reject.
 *
 * @sem domain=routing role=verify-ladder
 */
export async function runVerifierLadder(input: VerifierLadderInput): Promise<VerifierVerdict> {
  const sound = await runSoundCheck(input.spec, input.runner)
  const behavior = monitorTrajectory(input.trajectory)

  if (behavior.suspicious) {
    return {
      accepted: false,
      rung: "behavior",
      reason:
        "trajectory flagged suspicious (test-dodging edit or a write-shaped bash command in a read-only slice) — a sound pass does not count as verified; escalate to conductor review",
      sound,
      behavior,
      missing: missingEvidenceForBehavior(behavior),
    }
  }

  if (sound.applicable) {
    const shrink = compareCaseCounts(input.previousCaseCount, sound.caseCount)
    if (sound.pass && shrink.verdict === "shrank") {
      return {
        accepted: false,
        rung: "sound",
        reason: `sound check passed but ${shrink.detail}`,
        sound,
        behavior,
        missing: `MISSING: a green run covering all ${shrink.previous} case(s) the previous attempt ran — restore the dropped case(s); a smaller suite is not a pass.`,
      }
    }
    // A broken build rejects before the probe runs (order preserved) — the
    // probe only gates the accept path, once sound itself passed.
    if (sound.pass) {
      const probe = await checkProbeRung(input.spec, input.runner, sound, behavior)
      if (probe) return probe
    }
    const skips = sound.flags ?? []
    const suspect = sound.pass && skips.length > 0 ? ` — suspect: ${skips.map((f) => f.detail).join("; ")}` : ""
    return {
      accepted: sound.pass,
      rung: "sound",
      reason: sound.pass ? `sound check passed${suspect}` : "sound check failed",
      sound,
      behavior,
      ...(sound.pass ? {} : { missing: missingEvidenceForSound(sound) }),
    }
  }

  // Untestable slice — no sound check applies (a vacuous pass). Gate on the
  // pinned reproduction here too, via the same helper used above, then
  // degrade one rung at a time.
  const untestableProbe = await checkProbeRung(input.spec, input.runner, sound, behavior)
  if (untestableProbe) return untestableProbe

  if (input.extraRung) {
    const extra = await input.extraRung({ sound, behavior, trajectory: input.trajectory })
    if (extra) {
      return {
        accepted: extra.pass,
        rung: extra.rung,
        reason: extra.pass ? `${extra.rung} rung passed` : `${extra.rung} rung failed`,
        sound,
        behavior,
        extra,
        ...(extra.pass
          ? {}
          : { missing: extra.missing ?? `MISSING: a ${extra.rung} verdict that names the specific gap — none was supplied by this rung.` }),
      }
    }
  }

  if (input.qe) {
    const qe = await shouldVetoCheapOutput(input.qe.conductorResult, input.qe.generate, input.qe.options)
    return {
      accepted: !qe.veto,
      rung: "qe",
      reason: qe.reason,
      sound,
      behavior,
      qe,
      ...(qe.veto ? { missing: `MISSING: a second independent sample that agrees with the first (self-consistency) — ${qe.reason}` } : {}),
    }
  }

  // No applicable check at all — absence of a check is not evidence of
  // failure (OL-9.5d). Accept, but flag unverified so the caller (the slice
  // loop) surfaces it as such rather than laddering an unverifiable slice for
  // no new signal.
  return {
    accepted: true,
    rung: "sound",
    reason: "untestable slice: no applicable check — accepted unverified",
    sound,
    behavior,
    unverified: true,
  }
}
