# 09 — Ops hands: long-running work, background jobs, monitor/wait, ops persona

**Status:** PLANNED 2026-07-18 (this doc is the implementation plan). Design frozen; slices
delegated. Validation target: one real Terminal-Bench 2.1 task (`build-pmars`) run locally.

**Why.** The 2026-07-18 Terminal-Bench research (memory: terminal-bench-pro-live-research)
found econ's *brain* is not fix-bound — turn-triage already models `run-only`/`build`/`audit`
goal shapes (`turn-triage.ts:25-33`) and `decideArming` arms repro/localization only on
diagnosis goals (`arming-judge.ts:151`) — but its *hands* are: no background jobs, no
wait/monitor primitive, no completion re-entry, and no guidance telling the model long
foreground runs are even possible. Real users run benchmarks, builds, migrations, and
training jobs with coding agents today; Terminal-Bench 2.1 (79% of failures = timeouts)
just measures that same gap.

**Corrected ground truth (recon 2026-07-18).** The LIVE command tool for `opencode run` is
`ShellTool` (`packages/opencode/src/tool/shell.ts:385`), not core's `bash.ts` (that file is
the dormant V2 core boundary; its 600s `MAX_TIMEOUT_MS` and background-job TODOs at
`bash.ts:77-88` do NOT govern the live path). ShellTool today:

- timeout: `params.timeout ?? defaultTimeoutMs` (`shell.ts:737`), default 2 min via
  `flags.bashDefaultTimeoutMs` (`shell.ts:394`) — **no maximum**; a 40-min foreground run
  already works if the model asks for it. The schema (`shell/prompt.ts:18`) never tells the
  model there's no cap — that's a prompt gap, not a code gap.
- live progress metadata (`ctx.metadata`, `shell.ts:585`), rolling in-memory tail
  (`keep = 2×maxBytes`, `shell.ts:486`), full-output file save (`trunc.write`,
  `shell.ts:653-666`), exit-code surfacing (`shell.ts:688`).
- shell-compress already wired: `compressShellOutput()` before truncation (`shell.ts:644`)
  with the quality-monitor feedback loop (`shell-compress/quality-monitor.ts`).

## Reference behavior (Claude Code, from its live tool contracts)

Analyzed from the actual tool schemas, not blog posts:

1. **Foreground bash is capped (10 min) — long work goes to `run_in_background`**: the
   command runs detached, keeps running across turns, and *re-invokes the agent when it
   exits* (a task-notification with the output-file path). Output is read incrementally
   from a file, not re-dumped.
2. **Monitor** = one harness-side watcher that converts a long wait into notifications:
   each matching output line is an event; the doctrine is *coverage* — the filter must
   match every terminal state (success AND crash signatures), because "silence looks
   identical to still running".
3. **Loop pacing doctrine**: never poll harness-tracked work (completion notifies you);
   match poll delay to how fast the watched state actually changes; long fallback
   heartbeats instead of tight polls.

econ adapts these to a headless, cost-counted world: waiting must cost **zero tokens**
(harness-side blocking, not model-side polling), and every observation of job output goes
through shell-compress.

## Design

### D1. Job registry — `packages/opencode/src/tool/shell-job/registry.ts` (new)

In-process singleton (per `opencode run`), patterned on `shellQualityMonitor()`.

- `start({command, cwd, shell, env, sessionID, callID}) → JobInfo` — spawn with the same
  `cmd()` semantics ShellTool uses (`shell.ts:340-357`, detached on POSIX); stdout+stderr
  → one append-only log file (reuse the `createWriteStream` sink pattern,
  `shell.ts:493-521`; log path via the same Truncate storage used by `trunc.write`).
- `JobInfo = {id: "job_N", command, cwd, pid, logPath, startedAt, status: "running"|"exited"|"killed", exitCode?, bytes}`
- `status(id)` · `read(id, fromByte?) → {chunk, nextByte, eof}` (incremental, cursor-based)
  · `wait(id, {timeoutMs, pattern?}) → resolves on EXIT (always — silence-is-not-success)
  or first new-output regex match or timeout` · `kill(id, {force?})`.
- Owner-bound (sessionID recorded) — the exact precondition core `bash.ts:84`'s TODO named.
- Lifecycle: process-exit finalizer kills surviving jobs (safe default for containers;
  keep-alive is a later opt-in). No cross-process restart recovery in v1 — jobs live and
  die with the `opencode run` process, which is the benchmark/CLI reality.

### D2. `background` param on ShellTool (additive)

`background: Schema.optional(Schema.Boolean)` in `shell/prompt.ts` parameterSchema. When
true: permission.assert exactly as today (same command string), then `registry.start(...)`
and return immediately — `{jobId, logPath}` plus a one-line note telling the model how to
wait. When absent: byte-identical foreground path. No change to permission surface.

### D3. One new model tool: `job`

Single tool (keeps the catalog lean), `action: "status"|"output"|"wait"|"kill"`, `id`,
`timeoutMs?` (wait), `pattern?` (wait). Registered additively in
`tool/registry.ts`. Output rules:

- `output`/`wait` return only **new bytes since the caller's cursor**, routed through
  `compressShellOutput()` (the `log_text`/`progress_streaming` strategies + quality
  monitor apply unchanged); raw log stays on disk and its path is always echoed.
- `wait` blocks **harness-side** (zero tokens, zero turns) and returns on: job exit
  (always, whatever the pattern), pattern match on fresh output, or timeout — with which
  of the three it was, so the model never confuses "still running" with "done".

### D4. Headless completion re-entry (the loop analog)

Seam: the headless finish path in `session/prompt.ts` (same neighborhood as the finish
gates), using the existing synthetic-nudge injection pattern (`synthetic: true` TextParts,
as `reproFidelityNudgeText` et al. do). Rule: when the assistant produces a final message
with no tool calls AND the session's registry has running jobs AND `!interactiveSession()`
(`signal-bus.ts:145`): do not finish — block harness-side on the first job event, then
inject `Background job job_2 (make) exited 0 after 9m41s. New output (compressed): …
Full log: <path>. Continue.` and resume the loop. Bounds (all fail-open to a normal
finish): session deadline (`ECON_TIMEOUT`-aware), re-entry counter cap, and if every job
already exited, finish normally after injecting the summary once. Interactive mode:
untouched in v1 (signal would SURFACE, per path-to-85 §5 — later).

### D5. Prompt + persona (the soft gap)

- `shell.txt` / `ShellPrompt.render`: a "long-running work" section — the default timeout,
  the fact there is **no cap**, when to raise `timeout` vs when to use `background:true` +
  `job wait` (rule of thumb: >10 min or when parallel work exists → background).
- `OPS_PLAYBOOK` fragment (`session/prompts/fragments.ts`), gated exactly where
  `READ_ONLY_PLAYBOOK` gates — active when the triage verdict has run-only/build/audit
  goals and zero diagnosis goals. Content: graded-on-end-state discipline, background+wait
  for long jobs, never restart a running job, one `job wait` instead of poll loops,
  clock awareness.
- Time budget: when `ECON_TASK_DEADLINE_MS` (or `ECON_TIMEOUT`) is set, a one-line
  remaining-time reminder rides the turn-open context.

### D6. Context-cost cohesion (why this stays cheap)

Waiting costs no tokens (D3/D4 block harness-side). Every job observation is compressed
(D3) with the existing quality-monitor guardrails; raw logs stay on disk as the source of
truth; `enforceStepBudget` (order-preserving, `step-budget.ts:63`) and the masking-first
compaction doctrine (path-to-85 §3 Tier 0) apply unchanged — this feature adds **no new
LLM-summarization path**.

## Non-breaking guarantees

All params optional; new tool is additive; D4 activates only when a job exists (no jobs ⇒
byte-identical behavior — inert by construction); foreground shell path untouched;
`NODE_ENV=test` behaviors preserved. Working-tree discipline: several target files carry
uncommitted edits from the in-flight signal-bus wave (`registry.ts`, `fragments.ts`,
`system-prompt.test.ts`) — edits are strictly additive, never revert, never stash/checkout.
Ship bar: typecheck + existing shell/system-prompt/registration tests green + new unit
tests for registry/wait/re-entry.

## Validation (Terminal-Bench 2.1, local)

Task: `build-pmars` (build the pMARS Core War simulator from Debian source without X11;
900s budget; debian:13-slim, arm64-native; fetched to scratchpad `tb-task/`). Rig: build
econ binary → docker build the task env → run econ headless inside with `instruction.md`
as the prompt (gateway key from `../unerr-benchmarks/e2e/econ/.env.local`) → run the
task's own `tests/test.sh`. Observables: task tests pass; a >2-min command survives
(explicit timeout or background+wait); zero model-side poll loops; compression events on
build logs; wall-clock and cost vs the 900s budget. Single-run result = smoke, not a
claim (variance rules, path-to-85 §6.6).

## Explicitly deferred

Interactive-terminal (pty/tmux) driving · TUI surfacing of job events · cross-process job
recovery · Harbor adapter packaging (rides the unerr-benchmarks toolbox pattern once this
lands) · keep-alive jobs beyond process exit.
