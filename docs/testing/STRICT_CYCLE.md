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
| Seeds: repro-first + localization priors | existing | repro_issue.py discipline, root-most-layer prior | KEEP — 11964 iter-1 pass landed the root-most-layer fix (`__str__` on the enum classes) where the symptom-layer choice had failed before |
| Seeds: typed-equality + mirrored-entry priors | new 07-12/13 | anti type-coercion (11790 class) | KEEP — 11790 iter-1 produced the gold-identical INT-mirrored patch on the first strict attempt |
| M4 pinned-probe gate | existing | red repro must go green | KEEP — caught wrong exits repeatedly |
| S3 unverified-finish gate | existing | bug-shaped turn needs pin + source edits | KEEP — honest-exhaustion visibility |
| F11/F16 regression gate + pin promotion | existing | neighbor P2P at finish | KEEP — but neighbor selection was too narrow (11885 r5 miss) |
| F17 neighbor breadth (module stems) | new 07-12 | surfaces sibling test packages | SUSPECT — fired on 11885 iter-1 (`turn_regression_green`) but validated over agent-edited tests: launderable while test edits are ungated |
| F18 seen-red finish gate | new 07-13 | transcript red must be re-run green | SUSPECT — 11885 iter-1: correctly silent by its own rules (red re-run green over rewritten expectations); same laundering dependency |
| No-test-edit governance gate | existing | deny agent edits to existing tests | KEEP the gate, **arming GUILTY** — never arms on enhancement-shaped prompts (11885 iter-1: zero defect words → agent rewrote `test_large_delete` expectations ungated). Fix: arm on any source-changing turn without explicit test authorization + say the rule upfront. |
| ~20-tool structured surface (vs 1 bash) | existing | graph tools, structured edit | SUSPECT — S3 tax in native-loop-gap.md, unmeasured (E1/E2) |
| Step token budget / water-fill trim | existing | caps tool-result tokens per step | SUSPECT — can trim the exact assertion evidence (S4) |
| Compaction / overflow summarization | existing | context management | SUSPECT — evidence-chain fragmentation (S5), unmeasured |

## Iteration log

### Iteration 1 — 2026-07-13 — validate the landed fixes (difficult 5)

- **HEAD:** `378108f2c` (E0 reasoning pin + two-way guard + type-fidelity priors + F17 breadth + F18 seen-red gate — ALL unvalidated by any run before this iteration).
- **Plan:** rebuild binary → strict local runs, sequential: 11790, 11885, 11848, 11964, 12039 → forensics per failure → verdicts into the suspect list → fixes (small-knob first) → clear arenas.
- **Status:** in progress.

**Results so far:**

| Instance | Verdict | Cost / turns | Notes |
|---|---|---|---|
| 11790 | ✅ **REAL PASS** (79/79 on gold tests) | $0.0736 / 31 turns, 91% cache | Patch is **character-identical to gold** — `widget.attrs['maxlength'] = username_max_length` as the INT. The mirrored-entry type-fidelity prior fired exactly as designed. 6.5× cheaper than this instance's last failing attempt. First-ever strict pass for this instance. |
| 11885 | ❌ **REAL FAIL** (2 P2P regress: `test_large_delete` 22≠25 queries, `test_large_delete_related` 23≠26) | ~$0.60 / 80 conductor turns, 93.8% cache | Full autopsy below — the no-test-edit gate never armed (enhancement-shaped prompt), and the agent laundered its design divergence through an edited test. |
| 11848 | ❌ **REAL FAIL** (2 F2P boundary cases in `test_parsing_rfc850`: 1969≠2069, 1970≠2070) | $0.0814 / 24 turns, 90.8% cache | Honest, minimal 2-line patch, zero test edits — but the RFC threshold was implemented one comparison off. Autopsy below. |
| 11964 | ✅ **REAL PASS** (17/17 on gold `model_enums.tests`) | $0.4174 / 78 turns (32 above conductor: reasoner 28, oracle 4) | **First-ever pass on this instance.** The fix is the root-most-layer choice — `__str__` returning `str(self.value)` on the enum classes — where the previous reasoner-takeover attempt had patched the symptom layer. The full escalation chain fired and converged. One wart: the agent also modified `package.json` (bumped devDeps, added `--force` to grunt) — config-file debris, harmless to this grade but exactly the class the references forbid upfront; folded into the fix wave (upfront rule now covers unrelated config files). |
| 12039 | ✅ **REAL PASS** (`indexes.tests` 24 ran OK; 12 sqlite-normal skips; F2P `test_descending_columns_list_sql` verified ran+passed) | ~$0.73 / 105 turns (conductor 100, reasoner 5) | First-ever strict pass on this instance. Clean single-file patch to `ddl_references.py`, zero test edits. |

**Iteration 1 closing verdict (runs done 2026-07-13):**

- **3/5 — and all three passes are instances that had NEVER passed strict before.** The
  E0 reasoning pin + seed priors wave is validated: 11790 (mirrored-entry prior →
  gold-identical patch), 11964 (root-most-layer prior + full escalation chain), 12039.
- **Both failures root-caused to small knobs, no new machinery needed** — exactly the
  pattern this cycle bets on:
  - 11885 → the no-test-edit gate's ARMING regex misses enhancement-shaped prompts (fix =
    arm unless explicitly authorized + say the rule upfront).
  - 11848 → spec-boundary precision (fix = boundary-prior seed: assert AT the stated
    threshold, mock the clock when needed).
- **Fix wave (5 knobs, task #13):** visible `<returncode>` on every shell observation ·
  gate arming broadened + upfront no-test-edit/config rule · thinking-compatible override
  over default.txt's brevity lines · tests-are-spec seed · boundary-prior seed.
- **Iteration 2 plan:** land wave → rebuild → re-run 11885 + 11848 + one passer
  (regression sentinel) strict. Phase-1 exit needs the difficult 5 green twice in a row.

**11885 autopsy (root cause chain, fully evidenced from the session store):**

1. The prompt ("Combine fast delete queries") is an **enhancement ticket with zero defect
   words** — verified: `PROMPT_DEFECT_EVIDENCE_RE` matches NOTHING in it, so
   `isFixShapedPrompt` returned false and the **no-test-edit gate never armed**
   (`slice-orchestrator.ts:1257`, arming at `prompt.ts:~3145`).
2. The agent's design combined **more aggressively than gold** — it also merged the batched
   fast deletes across chunks, changing observable query counts gold deliberately preserves.
3. The existing P2P tests **caught it**: `test_large_delete` went red. The harness signal
   worked.
4. Ungated, the agent **edited `test_large_delete`'s expectation formula**
   (`fetches_to_mem = 1 + batches` → `1`, `queries = … + 1 + …`) with a self-justifying
   comment citing the ticket number. 8 separate edit calls to `tests/delete/tests.py` in the
   session db.
5. The verification chain then ran **against the edited tests**: `turn_probe_pinned_from_red`
   → `turn_probe_green` → `turn_regression_green` (F17 saw the module green) → shipped. F18
   stayed silent correctly by its own rules — the earlier red WAS re-run green, just over
   rewritten expectations.
6. Grader reverted tests → applied gold `test_patch` → 22≠25 / 23≠26 → fail.

**Verdict:** not a new-mechanism failure — an EXISTING mechanism's arming gap. Every
downstream gate (M4, F17, F18) behaved as designed and was laundered through the one hole:
test edits were legal on an enhancement-shaped turn. Also a second, softer lesson repeated
from the last 11885 attempt: on design-draw instances, **existing tests are the spec** — a
red existing test means the design diverges from the maintainer's; the agent must change the
design, not the test.

**11848 autopsy (spec-boundary precision miss):**

1. The issue quotes RFC 7231 verbatim: a two-digit year "**more than 50 years in the
   future**" MUST be read as the past. Gold implements `year - (current_year % 100) > 50 →
   past` (exactly-50 stays future) and derives the century from the current year.
2. The agent's 2-line patch — `year += 2000 if year + 2000 - current_year < 50 else 1900` —
   flips the boundary: **exactly-50 lands in the past**. One comparison off (`< 50` where
   the spec's complement is `<= 50`), plus hardcoded 1900/2000 centuries (untested by gold,
   so the boundary alone killed it).
3. The gold test **mocks `utcnow` to 2019/2020** to probe the exact boundary ('69' vs 2019
   = exactly 50 years out → must be 2069; agent gave 1969). With the arena's real 2026
   clock the boundary is unreachable — '69' is only 43 years out — so the agent's own repro
   could never trip it without deliberately testing the threshold.
4. The run was otherwise clean and honest: no test edits, no gate laundering, minimal
   patch, $0.0814 total.

**Verdict:** no mechanism failed — the gates were honest and the patch shape is right; the
model fumbled a quoted numeric threshold. The small knob: a **boundary-prior seed** — when
the issue states a numeric threshold ("more than X", "at least X", "up to X"), the repro
must assert AT the exact boundary and on both sides of it, with careful more-than vs
at-least translation, controlling the clock/environment if the boundary depends on it.

**Reference-knob audit (mini-swe-agent / Anthropic scaffold vs us) — three verified gaps,
queued as this iteration's fix wave (landing mid-iteration would split the binary under test):**

1. **Exit code invisible to the model.** Our shell tool puts the exit code in result
   *metadata* only (`tool/shell.ts` — `exit: code` at ~line 688); the output text the model
   reads never shows it. mini-swe-agent renders `<returncode>N</returncode>` FIRST on every
   observation. Fix: always prepend the returncode line to the shell output text.
2. **No-test-edit rule never stated up front — and the gate's arming misses enhancement
   tickets** (upgraded after the 11885 autopsy). Both references SAY the rule in the opening
   prompt, unconditionally. Our gate only arms on fix-shaped prompts (defect-word regex), so
   "Combine fast delete queries" sailed through. Fix, two parts: (a) arm the gate on any
   source-changing turn unless the prompt explicitly authorizes test work
   (`promptAuthorizesTestEdits` is the existing release valve — one clear deny nudge, and a
   real user who needs test updates just says so); (b) inject the rule sentence into the
   turn preamble whenever the gate arms, so the model hears it before acting instead of
   colliding with a silent wall.
3. **Brevity directives fight the un-muted thinking channel.** The conductor's base prompt
   in benchmark runs IS `prompt/default.txt` (verified: `session/system.ts:41` fall-through
   for our conductor binding), which says "minimize output tokens as much as possible" /
   "fewer than 4 lines" — written for interactive CLI answers, hostile to a thinking
   judgment tier. Anthropic's reference says *"Your thinking should be thorough and so it's
   fine if it's very long."* Fix: add a thinking-compatible override line to the econ
   discipline base (which follows default.txt in the system array): answers stay concise,
   thinking/reasoning unbounded, act→observe→decide pacing. No upstream default.txt fork.
