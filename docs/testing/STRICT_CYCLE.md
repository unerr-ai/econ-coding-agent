# The strict cycle — build → run → forensic → fix → verify, repeated

**What this is.** The running log of our iteration loop toward resolving SWE-bench Verified
instances for real: first the Mini-10's difficult five, then medium+hard batches from the full
500. Written deliberately in plain language. Started 2026-07-13.

**The one idea behind it:** mini-swe-agent scores 75.8% on the full benchmark with ONE linear
attempt at temperature 0.0, one bash tool, and a one-page prompt. So every mechanism in our
harness — old or new — is a **suspect until proven useful**. When an instance fails, the first
question is never "what new machinery do we need," it's: *did one of OUR mechanisms cause this,
and what small thing does the reference harness do that we don't?* Small knobs (a temperature, a
truncation size, one prompt sentence) have repeatedly mattered more than big rewrites.

Companions: [SWE_BENCH_TRACKER.md](./SWE_BENCH_TRACKER.md) (the per-instance history + local run
recipe), [../design/native-loop-gap.md](../design/native-loop-gap.md) (why the reference harness
is the floor).

---

## The rules (every iteration, no exceptions)

1. **Strict mode.** The agent sees only the issue text. No gold test planted in the arena
   (the gold `test_patch` is applied at GRADING time only), future git refs stripped, web
   egress denied, arena debris swept. Grading = revert the agent's test-file edits → apply
   gold `test_patch` → run FAIL_TO_PASS + PASS_TO_PASS → resolved only if all F2P pass and
   no P2P regresses.
2. **Local machine only** (faster). Sequential instances — never parallel runs.
3. **Commit before firing.** Engine changes are committed the moment suites are green;
   never run live-fire over uncommitted wiring. Rebuild the binary before every run wave
   (local runs read the compiled-in config).
4. **Clear after forensics.** Once an iteration's failures are autopsied and logged here,
   the arenas/run artifacts from that iteration are deleted — no stale runs to leak into
   (or oracle) the next iteration.
5. **Root-cause between iterations.** No fix lands without a verdict on WHICH mechanism
   failed (see the suspect list). Tools: run-bundle autopsies, the mini-swe-agent v2.0.0
   source/prompts as the reference diff, targeted web searches.
6. **Small knobs before rewrites.** A one-line prompt prior or config value beats new
   machinery. New machinery needs the failure class to survive the small-knob attempt first.
7. **The orchestration stays — always.** Full econ (conductor + tiers + gates + routing) is
   the product under test; the bare-model reference is a *diagnostic yardstick*, never the
   target architecture. A GUILTY verdict on a mechanism means IMPROVE or re-tune it, not
   remove it. The goal is the full orchestrated system beating the bare model, not matching
   it by becoming it.

## The reference harness (what wins with zero machinery)

mini-swe-agent v2.0.0 + MiniMax M2.5 (high reasoning): 75.8% on all 500, ~$0.07/task —
one linear attempt, temp 0.0, one stateless-bash tool, 5-step *suggested* (not enforced)
workflow, 10k-char output truncation (5k head + 5k tail), step limit 250, cost limit $3,
submit = `git diff`. No judges, gates, decomposition, tiers, or compaction.

Verbatim details that matter (fetched from the v2.0.0 source, 2026-07-13):

- **Observation format** (every step): `<returncode>{{returncode}}</returncode>` +
  `<output>…</output>` — the exit code is ALWAYS shown to the model, plainly, first.
  stdout and stderr are merged into one stream. Non-zero exit never halts anything —
  the model decides.
- **Prompt boundaries** (uppercase in the original): "MODIFY: Regular source code files
  in /testbed" / "DO NOT MODIFY: Tests, configuration files (pyproject.toml, setup.cfg,
  etc.)" — the don't-touch-tests rule is stated UP FRONT in the prompt, not only enforced.
- **Workflow is suggested, not enforced**: analyze → repro script → edit → rerun repro →
  edge cases. Plus "<IMPORTANT>… think and issue AT LEAST ONE command, see the result,
  then think and issue your next command(s).</IMPORTANT>"
- **Mechanics**: 30s per-command timeout, `bash -lc` (login shell), one long-lived
  container with full state persistence, format errors get an in-turn retry message,
  multiple tool calls per message executed sequentially, submit = echo the sentinel +
  `git diff` with returncode 0.

Anthropic's published scaffold for Claude on SWE-bench (engineering blog): bash + a
str_replace edit tool, single attempt until the model decides it's done or 200k context.
Key verbatim lines: *"I've already taken care of all changes to any of the test files…
you DON'T have to modify the testing logic or any of the tests in any way!"*, *"make the
minimal changes to non-tests files"*, and *"Your thinking should be thorough and so it's
fine if it's very long."* The prompt "outlines a suggested approach… the model is free to
choose how it moves from step to step." Headline "high-compute" numbers only add parallel
attempts + rejection on visible regression tests + an internal scorer; base numbers are
single-attempt.

## The suspect list — every mechanism beyond the null harness

Verdicts: **KEEP** (evidence it earns its keep) · **SUSPECT** (unproven either way) ·
**GUILTY** (evidence it hurt; fixed or retired). Updated every iteration.

| Mechanism | Age | What it does | Verdict (evidence) |
|---|---|---|---|
| Conductor reasoning pin `"high"` (E0) | new 07-13 | un-muted the trained SWE policy, bounded | KEEP — 3/5 previously-failing cured locally; "none" era = flip-flops; unbounded = 41-min hang |
| Two-way effort guard (reasoning-gate) | new 07-13 | stale "none"→"high"; small calls muted | SUSPECT — protective, unvalidated live |
| Difficulty triage + arming judge | existing | turn-open shaping, localization arming | SUSPECT — 12039 cured historically, but mis-triage caused 11885's $0.84 grind once |
| Decomposition-first conductor loop | existing | typed slices, child one-shots | SUSPECT — decomposed route sealed 0/4 on 11885-class; armed-turns-never-decompose was a WIN (linear loop) |
| Seeds: repro-first + localization priors | existing | repro_issue.py discipline, root-most-layer prior | KEEP so far — honest gates depend on the pinned repro |
| Seeds: typed-equality + mirrored-entry priors | new 07-12/13 | anti type-coercion (11790 class) | SUSPECT — unvalidated by any run |
| M4 pinned-probe gate | existing | red repro must go green | KEEP — caught wrong exits repeatedly |
| S3 unverified-finish gate | existing | bug-shaped turn needs pin + source edits | KEEP — honest-exhaustion visibility |
| F11/F16 regression gate + pin promotion | existing | neighbor P2P at finish | KEEP — but neighbor selection was too narrow (11885 r5 miss) |
| F17 neighbor breadth (module stems) | new 07-12 | surfaces sibling test packages | SUSPECT — unvalidated by any run |
| F18 seen-red finish gate | new 07-13 | transcript red must be re-run green | SUSPECT — unvalidated by any run |
| No-test-edit governance gate | existing | deny agent edits to existing tests | KEEP — killed the false-green class |
| ~20-tool structured surface (vs 1 bash) | existing | graph tools, structured edit | SUSPECT — S3 tax in native-loop-gap.md, unmeasured (E1/E2) |
| Step token budget / water-fill trim | existing | caps tool-result tokens per step | SUSPECT — can trim the exact assertion evidence (S4) |
| Compaction / overflow summarization | existing | context management | SUSPECT — evidence-chain fragmentation (S5), unmeasured |

## Iteration log

### Iteration 1 — 2026-07-13 — validate the landed fixes (difficult 5)

- **HEAD:** `378108f2c` (E0 reasoning pin + two-way guard + type-fidelity priors + F17 breadth + F18 seen-red gate — ALL unvalidated by any run before this iteration).
- **Plan:** rebuild binary → strict local runs, sequential: 11790, 11885, 11848, 11964, 12039 → forensics per failure → verdicts into the suspect list → fixes (small-knob first) → clear arenas.
- **Status:** in progress.
