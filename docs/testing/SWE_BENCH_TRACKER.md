# SWE-bench live-fire tracker — SWE-mini-10 (django)

**What this is.** The working tracker for the 10 django instances we triage locally to
fix the **orchestrator prompt-slicing discipline**. One row per instance: benchmark
verdict, our local triage status, and the root-cause finding. Plus the **exact recipe
to run any instance on this laptop** (§Run-it-locally) and the **methodology rule that
keeps local runs honest** (§The one rule).

Dataset: `princeton-nlp/SWE-bench_Verified` (django subset). Tiers: conductor
(minimax-m3, cheap default) · executor (gpt-oss-120b) · reasoner
(deepseek-v4-pro, thinking) · oracle (glm-5.2).

---

## The one rule — local "N tests OK" is NOT a pass

SWE-bench grades an instance by: **discard the agent's edits to test files → apply the
gold `test_patch` → run `FAIL_TO_PASS` + `PASS_TO_PASS`.** The agent's *own* test edits
are thrown away.

So a local `runtests.py … OK` proves nothing on its own — the agent may have rewritten a
`PASS_TO_PASS` test's expectations to hide a regression it caused. **Every local verdict
must run the real-grader simulation** (§Run-it-locally step 5): revert the test files to
gold, keep only the non-test fix, then run F2P + P2P. If any P2P fails → the instance is a
**FAIL**, no matter how green the agent's own suite looked. This is exactly how 11885
false-greened locally while the benchmark correctly marked it ✗.

---

## The 10 instances (fastest → slowest)

Two verdict columns, and they mean different things — read them as a **before → after**:
- **Baseline verdict** = the prior Docker-harness result (`unerr-benchmarks/e2e/econ`),
  captured *before* this session's engine changes. It is the comparison baseline, **not**
  the current state. A ✗ here that now passes is a win, not a live failure.
- **Current result (this session)** = the real-graded run on the latest binary
  (§Run-it-locally + §The one rule). **This is the trustworthy, up-to-date verdict.**

| # | instance | bench time | baseline verdict | prior routing | base_commit | F2P/P2P | current result (this session) |
|---|---|---|---|---|---|---|---|
| 1 | django-12039 | 159s | ✓ pass | conductor-only | `58c1acb1d605` | 1/11 | ✅ **re-validated 2026-07-10 on the W1–W4 engine — PASS: $0.1158, 100% conductor, 0 escalations, real-grade 43/43 OK** after M1+M2 (runs 1–2 were $0.30/$0.31 with a reasoner-authored fix slice + unverified cascade; the tuning log has the arc). Prior baseline 2026-07-09: $0.063, real-grade 12/12 |
| 2 | django-11880 | 200s | ✓ pass | conductor-only | `06909fe084f8` | 1/114 | ✅ **re-validated 2026-07-10 on the W1–W4 engine — PASS: $0.0511, 100% conductor, 0 escalations, module-grade 115/115** (canonical one-line `error_messages` deepcopy fix, inline path, no modification needed). Prior baseline 2026-07-09: $0.021 |
| 3 | django-11951 | 224s | ✓ pass | conductor-only | `312049091288` | 1/21 | ✅ **validated 2026-07-09 — PASS: $0.046, 100% conductor, real-grade 22/22** |
| 4 | django-11848 | 357s | ✗ **fail** | oracle+conductor | `f0adf3b9b7a1` | 2/43 | 🎉 **validated 2026-07-09 — IMPROVEMENT (was ✗): $0.045, 100% conductor, real-grade 45/45** (engine now cracks it) |
| 5 | django-11964 | 481s | ✗ **fail** | conductor-only | `fc2b1cc926e3` | 2/15 | ⬜ not started |
| 6 | django-11999 | 492s | ✓ pass | — | `84633905273f` | 1/30 | ⬜ not started |
| 7 | django-12050 | 802s | ✓ pass | — | `b93a0e34d9b9` | 1/10 | ⬜ not started |
| 8 | django-11790 | 826s | ✓ pass | — | `b1d6b35e146a` | 2/77 | ⬜ not started |
| 9 | django-11815 | 888s | ✗→✓ flips on redraw | — | `e02f67ef2d03` | 2/44 | ⬜ not started |
| 10 | django-11885 | 1296s | ✗ **fail** | conductor-only thrash | `04ac9b45a344` | 1/43 | ✅ **triaged — false-pass root-caused** |

**What each is about:**
- **12039** — Use proper whitespace in `CREATE INDEX` statements
- **11880** — Form Field's `__deepcopy__` does not (deep)copy the error messages
- **11951** — `bulk_create` batch_size param overrides the compatible batch size calc
- **11848** — `django.utils.http.parse_http_date` two-digit year check is incorrect
- **11964** — value of a `TextChoices`/`IntegerChoices` field has a differing type
- **11999** — cannot override `get_FOO_display()` in Django 2.2+
- **12050** — `Query.resolve_lookup_value` coerces a `list` value to `tuple`
- **11790** — `AuthenticationForm`'s username field doesn't set `maxlength` HTML attr
- **11815** — Migrations use the *value* of an enum object instead of its *name*
- **11885** — Combine fast-delete queries

**Triage focus.** The baseline ✗ cases (11964, 11815, 11885) tell us where the slicer is
weak — **11848 has since flipped to a clean pass** (45/45, conductor-only; see its row), so
it's now a win rather than a weak spot. The ✓ cases are the guardrail: any slicer change
must **not** make a cheap conductor-only pass more expensive (no burning cache / no needless
escalation).

---

## Case 11885 — triaged: **FALSE PASS**, root-caused ✅

**Local run:** $0.0857, 100% conductor, 0 escalations, 39 turns, cache 92.9%, ~5m16s.
Agent's own suite: `Ran 45 tests OK` → *looked* green.

**Real-grader simulation (agent `deletion.py` fix + gold tests):**

| test | role | verdict |
|---|---|---|
| `test_fast_delete_combined_relationships` | FAIL_TO_PASS (grader) | ✅ OK |
| `test_large_delete` | PASS_TO_PASS | ❌ FAILED |
| `test_large_delete_related` | PASS_TO_PASS | ❌ FAILED |

→ 2 PASS_TO_PASS regressions ⇒ **graded FAIL** (matches the benchmark's ✗).

**Why it happened — the defect chain:**
1. **Prompt mis-classified `build`, not `diagnosis`.** The 11885 issue is written in
   spec language ("the collection logic *should* combine such queries … these *should be
   combined*") with **zero** defect keywords (fix/bug/broken/fails/error). At the time,
   triage's `PROMPT_DEFECT_EVIDENCE_RE` missed it, so the then-live regex classifier
   (`classifyTurnShape`) **defaulted to `build`**. *(Mechanism update 2026-07-10: that
   regex classifier was deleted in the turn-open rewrite — the shape is now extracted by
   the temp-0 turn-read LLM; `PROMPT_DEFECT_EVIDENCE_RE` survives only as the
   governance-regex OR-signal for the no-test-edit gate.)*
2. **`build` shape ⇒ no-test-edit gate never armed** (`test_edit_gate_armed=0`). The
   agent was free to edit test files.
3. **The fix over-combines.** The gold fix combines only *related* fast-deletes; the
   agent's fix also combined *same-table batched* deletes, which changes the query count
   in `test_large_delete` / `test_large_delete_related` (both PASS_TO_PASS).
4. **Agent papered over its own regression** by rewriting those two tests'
   `assertNumQueries` counts → local suite green → false pass.

**The gate would have caught this.** Had the no-test-edit gate armed, the agent could not
have edited the PASS_TO_PASS tests, would have hit the count mismatch, and been forced to
reconcile its fix with gold behavior — surfacing the over-combine before it shipped.

**Fix direction (proposed, NOT yet applied — see §Fix backlog).** Teach stage-1 that
"currently X / should be Y" behavior-discrepancy phrasing is a **diagnosis**, so both the
localization pre-pass and the no-test-edit gate arm. This is **upstream of and distinct
from** the committed asymmetric grounded→vague round-up (commit 6b3f50912), which never
fires here because the shape is `build`, not diagnosis-grounded.

---

## Case 12039 — triaged: **correct pass, but a $0.31 cost blow-up** ⚠️

> **✅ RE-VALIDATED 2026-07-09 (current engine, fresh binary `0.0.0-main-202607091104`).**
> The over-fire is **fixed**. Re-run of 12039 with the D1 fix (`4ec39134f`) in place:
> **$0.063007 upstream, 100% conductor** (`minimax/minimax-m3`, 27 msgs, ~638k cached reads),
> **0 reasoner / 0 oracle / 0 escalations**, ~2m19s. Agent changed only `ddl_references.py`
> (+6/−3, a clean whitespace fix that also guards the empty-suffix case); **zero test files
> touched** (no-test-edit gate held). Real-grader simulation: **F2P + all 11 P2P → 12/12 OK**
> ⇒ genuine **PASS** (matches benchmark ✓). Net vs the original triage below: same correct
> result at **~4.9× lower cost** — the reasoner-localization + oracle-climb cascade is gone.
> D2 does not trigger here (no localization pre-pass fires now). The analysis below is retained
> as the record of the defect that D1 fixed.

**Local run:** correct fix (`ddl_references.py` +10/−4), **zero test files touched** (the
no-test-edit gate held — clean), grader red→green, full `indexes` module `24 OK`. Real
grade = **PASS** (matches benchmark ✓). But **$0.3086** on a trivial whitespace fix that
the benchmark did conductor-only: 33 conductor + **10 reasoner ($0.177) + 10 oracle
($0.093)**, 0 escalations (all deliberate routing).

**Why the blow-up — a compound over-fire (causal chain):**
1. **The committed round-up (`6b3f50912`) mis-fired.** Triage said `diagnosis-grounded`,
   but `roundUpTriageShapes` bumped it to `diagnosis-vague` (`triage_rounded_up` marker)
   because `isHardDiagnosisPrompt` counted the GitHub-issue's path/URL noise
   (`db/backends`, `django/blob/master/django/...`) as "≥2 subsystems ⇒ hard cross-layer."
   Real SWE-bench issue prose almost always links source paths, so this false-positives
   broadly — likely turning most grounded bugs into the expensive path.
2. **`diagnosis-vague` armed a reasoner localization pre-pass** — pure waste here: the
   prompt already named the exact file to change.
3. **The localization slice is untestable** ("deliver targets/mechanism, do not write
   code" ⇒ "no applicable check"), so the judge/escalation machinery could not verify it
   and climbed **reasoner → oracle → oracle** (`escalation_provenance`: "untestable slice:
   accepted unverified" → "squeeze-retry: judge rung failed" →
   "critical-unverified-at-ceiling"). That cascade is ~$0.27 of the $0.31.

**Two defects (both in the fix backlog):**
- **D1 (mine)** — `isHardDiagnosisPrompt` false-positives on path/URL tokens in issue
  prose; and rounding up at all when the prompt *names the exact single file to change* is
  wrong. Likely a **net regression** across the SWE set → candidate for revert-or-tighten.
- **D2 (pre-existing)** — an untestable analysis slice (localization pre-pass) should be
  **accepted-unverified once**, not squeeze-retried up the tier ladder to the oracle
  ceiling. This bites *any* genuine `diagnosis-vague` case, independent of D1.

---

## Run-it-locally — the recipe

Everything runs natively on this laptop against a local git checkout of django — **no
Docker**. Real LiteLLM gateway spend (~$0.09/instance).

**Prereqs (one-time):**
- **Binary:** `packages/opencode/dist/opencode-darwin-arm64/bin/opencode` — rebuild with
  `cd packages/opencode && bun run build` when the engine changes.
- **Python 3.9:** `~/.pyenv/versions/3.9.19/bin/python3.9` (Django 3.1-dev needs <3.11).
- **LiteLLM env:** `infra/litellm/.env.local` (exports `LITELLM_MASTER_KEY`).
- **Dataset:** `princeton-nlp/SWE-bench_Verified` via the `datasets` package — only
  `/opt/homebrew/bin/python3` has it installed.
- **Session DB (run artifacts):** `~/.local/share/opencode/opencode-main.db`.

**Step 1 — pull the instance's metadata** (base_commit, test_patch, FAIL_TO_PASS, prompt):
```bash
INST=django__django-12039           # pick from the table
/opt/homebrew/bin/python3 - "$INST" <<'PY'
import sys, json
from datasets import load_dataset
r=[r for r in load_dataset("princeton-nlp/SWE-bench_Verified",split="test")
   if r["instance_id"]==sys.argv[1]][0]
open("base_commit.txt","w").write(r["base_commit"])
open("test_patch.diff","w").write(r["test_patch"])
open("fail_to_pass.txt","w").write("\n".join(json.loads(r["FAIL_TO_PASS"]) if isinstance(r["FAIL_TO_PASS"],str) else r["FAIL_TO_PASS"]))
open("PROMPT.txt","w").write(r["problem_statement"])
print("base", r["base_commit"])
PY
```

**Step 2 — build the arena** (local clone of django, checkout base, plant the repro test,
python3.9 venv with editable django). Clone from any existing arena to avoid a network
fetch:
```bash
git clone --local -q arena-django-11885 arena-django-12039   # reuse an existing checkout
cd arena-django-12039
git checkout -q "$(cat ../base_commit.txt)"
git apply ../test_patch.diff                                 # plants the FAIL_TO_PASS test
git -c user.email=arena@local -c user.name=arena commit -qam "arena: plant reproduction test"
~/.pyenv/versions/3.9.19/bin/python3.9 -m venv .venv
./.venv/bin/pip install -q -e .
cp ../PROMPT.txt .
# grader must be RED here (bug present):
./.venv/bin/python tests/runtests.py <F2P-test-path> --settings=test_sqlite
```

**Step 3 — run econ against the arena** (real spend). Put the arena venv on PATH so
`python` = venv python for both the agent's tools and the econ turn-probe gate:
```bash
set -a; source infra/litellm/.env.local; set +a
export LITELLM_API_KEY="$LITELLM_MASTER_KEY"
export PATH="$PWD/arena-django-12039/.venv/bin:$PATH"
cd arena-django-12039
BIN=packages/opencode/dist/opencode-darwin-arm64/bin/opencode
timeout 1800 "$BIN" run "$(cat PROMPT.txt)" --print-logs --log-level DEBUG 2>&1 | tee run-12039.log
```
Capture the session id from the newest root session:
```bash
sqlite3 ~/.local/share/opencode/opencode-main.db \
  "SELECT id FROM session WHERE parent_id IS NULL ORDER BY time_created DESC LIMIT 1;"
```

**Step 4 — decode the trace** (tiers used, cost, receipt, triage markers). Grep the run
log for the stage-1 markers: `turn_triage`, `arming_decided`, `frame_seed_planted`,
`test_edit_gate_armed`, `turn_read_degraded` (neutral degrade — should be rare),
`turn_continuation`, `stuck_escalate`/`stuck_rethink` (SM backstop), and per-turn
`turn_phase … agent=<tier>`. Tier-cost from the session SQLite:
`unerr-benchmarks/e2e/econ/econ-tier-cost.py`.

**Step 5 — REAL-GRADER SIMULATION (mandatory — see §The one rule).** Revert the test
files to gold, keep the agent's non-test fix, run F2P + every touched P2P:
```bash
cd arena-django-12039
cp tests/<touched_test>.py /tmp/agent-tests.bak      # keep the record
git checkout -- tests/<touched_test>.py              # gold test state (base + gold test_patch)
# deletion.py / other non-test fixes stay in place.
./.venv/bin/python tests/runtests.py <F2P> <each touched P2P> --settings=test_sqlite
cp /tmp/agent-tests.bak tests/<touched_test>.py      # restore the run record afterward
```
**Never `git clean -fd`** in an arena — it deletes the untracked `.venv/` and `PROMPT.txt`.
Revert only tracked files with `git checkout -- <path>`.

**Grading gotcha — docstring-style labels.** `FAIL_TO_PASS`/`PASS_TO_PASS` are mostly
`test_method (module.Class)`, but a handful are the test's **docstring** (prose with
spaces, e.g. `#5749 - `field_name` may be used as a key in _html_output().`). A naive
`sed`→`xargs` label→id conversion word-splits those into bogus `unittest.loader._FailedTest`
entries → phantom "errors" that are **not** real regressions. When labels share one module
(common for these django cases), grade at **module level** instead —
`runtests.py <module>` runs every listed test (docstring ones included) and a fully-green
`Ran N tests … OK` is the honest verdict. This is exactly what tripped 11880 (24 phantom
"errors" from 3 docstring P2P; the real result is 115/115 OK).

---

## Fix backlog (understand → apply → rerun; do not batch-apply)

| id | defect | proposed fix | status |
|---|---|---|---|
| F-11885a | spec-language bug report ("currently X / should be Y") → shape defaults to `build` → localization pre-pass **and** no-test-edit gate both skip | broaden stage-1 defect detection to treat behavior-discrepancy phrasing as `diagnosis` | 🟡 **superseded in mechanism** by the turn-open rewrite (`48a3499ce`): the shape is now LLM-extracted (no defect-keyword regex to miss); re-fire 11885 to verify the extractor reads behavior-discrepancy phrasing as `diagnosis` |
| T-graph-gate | pre-existing test failure: `packages/opencode/test/tool/read-entity-graph-gate.test.ts` — the bounded-readiness-gate fallback takes ~44s against the 25s test timeout on this machine; fails on HEAD `e372a3c1d` and predates the W3 diff (verified via stash) | bound the gate (or revisit the test timeout) so the fallback fits the budget | 🧠 root-caused, **not applied** |
| **D1-12039** | committed round-up over-fires: `isHardDiagnosisPrompt` counts path/URL tokens in issue prose as cross-layer ⇒ arms reasoner localization on trivial single-file bugs (net regression across the set) | **reverted the text-hardness gate** in `roundUpTriageShapes`: a grounded bug that names its file goes direct on the cheap conductor path; only a grounded bug with NO file target rounds up | ✅ **applied — commit `4ec39134f`** (reverts `6b3f50912`'s asymmetric gate); **verified live 2026-07-09** — 12039 now $0.063, 100% conductor, real-grade 12/12. *(The whole round-up mechanism — `roundUpTriageShapes`/`isHardDiagnosisPrompt` — was later deleted outright by the 2026-07-10 turn-open rewrite, `48a3499ce`: hardness is now judged by the turn-read and applied by `decideArming`.)* |
| **D2-12039** | untestable analysis slice (localization pre-pass) is scored *critical* (graph blast-radius) → M3 floor force-climbs its untestable vacuous-accept reasoner→oracle→oracle, though climbing can't verify analysis | mark the analysis-only pre-pass read-only-for-escalation (or pin it non-critical) so it settles accepted-unverified at its assigned reasoner tier — surgical, no FSM change | 🟡 root-caused, **deferred to its own verified pass** (not exercised after D1 on this set; touches escalation core) |

**Working discipline (per user):** understand the fix first → apply → rerun that one
instance → re-verify with the real-grader simulation → only then move on. Don't stack
speculative fixes; each must not regress a ✓ case.

---

## Tuning log

Every **benchmark-driven code modification** gets a row here (per the build directive):
the instance that motivated it, what was observed, what changed, the files touched, and
what to watch for regression on later runs. A change that never earns a row here should
not have been made off a benchmark run. (Backlog items graduate here when applied.)

| date | instance | observation | change | files | watch-for |
|---|---|---|---|---|---|
| 2026-07-10 | 12039 (run 3, M2 binary) | **$0.1158, 100% conductor, 0 escalations, real-grade 43/43 OK — no modification needed.** M2 verified live: with turn-file fallback + python probes the fix work probes testable→executor, so no reasoner-tier slice exists, `shouldOrchestrate` stands down, and the single-goal fix-handed turn runs INLINE on the conductor (the designed cheap path; runs 1–2 orchestrated only because mis-probed slices allocated at reasoner). Residual delta vs the 2026-07-09 $0.063 baseline is verification thoroughness (this run also ran backends.test_ddl_references + a schema suite), not misallocation | — (validation run) | — | Same watch-fors as M1/M2 |
| 2026-07-10 | 12039 (run 2, M1 binary) | $0.3149 — M1's harness grounding reached the MODEL (slices ran the real runtests.py suites this time) but not the PROBES: the conductor's fix todo said "Patch IndexColumns.__str__ to drop empty col-suffixes" — no file token at all — so `extractSliceFiles` → [] and every M1 probe stood down; fix slice still authored at reasoner, still qe-venue, still unverified → oracle synthesis + dead re-plan round again. Slice-text extraction alone is a stochastic key | **M2**: `resolveDottedPyModules` (dotted chains resolved against the REAL tree — the prompt names `django.db.backends.ddl_references.Columns`; longest existing `.py` prefix wins, symbols stripped); turn-level file evidence stored at turn-open (`setTurnFiles`, inherit-on-continuation/clear-on-degrade like the verdict) and threaded as `fallbackFiles` into `todosToLoopSlices` — a slice naming NO file probes with the TURN's files; delegates fall back to the parent slice's scope | `slice-orchestrator.ts` (resolver + conversion fallback + deps.turnFiles), `turn-read-store.ts` (files store), `prompt.ts` (turn-open write + deps), `slice-delegation.ts` (parentScope fallback) | Fallback files can over-scope an UNRELATED slice on a multi-goal turn (every no-file slice inherits all turn files) — watch scope-overlap serialization forcing sequential waves on genuinely parallel goals |
| 2026-07-10 | 12039 (run 1 on W1–W4 engine) | Fix correct, real-grade PASS, but $0.3022 vs $0.063 baseline (27/43 turns above conductor, 0 escalations). Turn-open was perfect (diagnosis-grounded, fix handed, no arming, no seed). Three grounded gaps compounded: (1) `SLICE_FILE_RE` requires a `/`, so "Apply the fix to ddl_references.py" probed with ZERO files; (2) both OL-7.9 probes were JS-only (package.json/tsconfig/ts-globs) → every python slice lands untestable → the handed-fix mechanical slice authored at the REASONER (`mechanical-unbacked` cell) and the sound rung had no command; (3) the verify runner then GUESSED `pytest` (django doesn't use it; system 3.13 python, `cgi` gone) → all slices unverified → oracle synthesis ×2 + a reasoner re-plan round whose DAG never dispatched | **M1**: bare-filename arm in `SLICE_FILE_RE` (extension-whitelisted); python-aware `fileHasTests` + `probeSliceVerifyCommands` (stem-referenced test files only, stem-named-first under the 50-file scan cap; django-runtests label conversion; `.venv/bin/python` preferred; pytest only with real pytest config; never a whole-suite run); `detectPythonHarness` also feeds a "Test harness (detected)" line in the repo primer; cwd package.json fallback suppressed for purely-python slices | `slice-orchestrator.ts` (SLICE_FILE_RE, buildRepoPrimer), `graph-tools.ts` (python probes + harness detection) | JS repos: the cwd fallback now skips purely-python slices — watch a mixed-repo slice that names only .py files but expects npm-script verification; bare-filename matching widens P6b scope overlap (more serialization) — watch for spurious implicit deps from prose filenames |
