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
| 3 | django-11951 | 224s | ✓ pass | conductor-only | `312049091288` | 1/21 | ✅ **re-validated 2026-07-10 on the W1–W4 engine — PASS: $0.0989, 100% conductor, 0 escalations, real-grade 51 OK** (canonical `_batched_insert` clamp, inline path, agent self-verified bulk_create + 375 query tests). Prior baseline 2026-07-09: $0.046 |
| 4 | django-11848 | 357s | ✗ **fail** | oracle+conductor | `f0adf3b9b7a1` | 2/43 | 🎉 **re-validated 2026-07-10 on the W1–W4 engine — PASS: $0.0659, 100% conductor, 0 escalations, real-grade 45/45** (RFC 7231 sliding-century fix, inline path). Prior: 2026-07-09 $0.045 (first crack of an original ✗) |
| 5 | django-11964 | 481s | ✗ **fail** | conductor-only | `fc2b1cc926e3` | 2/15 | 🎉 **re-validated 2026-07-10 (honest re-run, refs-stripped arena) — PASS: $0.0985, 46 turns, 100% conductor, 0 escalations, real-grade model_enums OK + model_fields 310 OK** (same one-line `Choices.__str__` fix; single `git log --oneline -5` for orientation, no mining). First run VOID (future-leak): same fix but $0.5970 / 152 turns after `git log --all` + `git show` surfaced the upstream fix — the grind was the leak rabbit hole, not an engine defect. Arena refs stripped, recipe amended (§strip-the-future) |
| 6 | django-11999 | 492s | ✓ pass | — | `84633905273f` | 1/30 | ✅ **validated 2026-07-10 on the W1–W4 engine — PASS: $0.0403, 18 turns, 100% conductor, 0 escalations, real-grade model_fields 311/311 OK** (cheapest ladder run yet; guarded the `get_FOO_display` setattr in `contribute_to_class` mirroring the sibling attname guard — same shape as upstream. Turn-read armed localization at moderate/clear, localization seed, inline path, zero git usage) |
| 7 | django-12050 | 802s | ✓ pass | — | `b93a0e34d9b9` | 1/10 | ✅ **validated 2026-07-10 on the W1–W4 engine — PASS: $0.0742, 40 turns, 100% conductor, 0 escalations, real-grade queries.test_query 11/11 + queries 377 OK** (consolidated fix: recursive `resolve_lookup_value` + `type(value)(...)` reconstruction — supersets upstream's one-word fix; self-verified 5 suites. Notable: past-archaeology worked as designed post-strip — `git log --all` for ticket #30687 reached only ≤base, agent studied the coercion-introducing commit `8a281aa7fe` and scoped its regression check from it) |
| 8 | django-11790 | 826s | ✓ pass | — | `b1d6b35e146a` | 2/77 | ✅ **validated 2026-07-10 on the W1–W4 engine — PASS ×2: run 1 $0.1874/35 turns (correct fix, upstream-identical, but a 51.5k-char uncapped refs-mode search blob pushed ctx to 87.3k → M3), run 2 on the M3 binary $0.0738/25 turns, ctx 41.8k, biggest search return 3.1k tok, agent self-ran full auth_tests (530)**. Real-grade both runs: auth_tests.test_forms 79/79 OK. 100% conductor, 0 escalations both runs |
| 9 | django-11815 | 888s | ✗→✓ flips on redraw | — | `e02f67ef2d03` | 2/44 | ✅ **validated 2026-07-10 on the W1–W4 engine (M3 binary) — PASS: $0.0467, 21 turns, 100% conductor, 0 escalations, real-grade test_writer 46/46 + migrations 518/518 OK** (one-line `EnumSerializer` name-lookup fix, upstream shape; the baseline flip-flopper lands deterministically. Arming judge correctly did NOT arm localization — the issue names `EnumSerializer` — evidence-grounded discrimination vs the armed no-location cases 11964/11999/12050) |
| 10 | django-11885 | 1296s | ✗ **fail** | conductor-only thrash | `04ac9b45a344` | 1/43 | 🎉 **REAL PASS 2026-07-10 on the W1–W4+M3 engine (fresh refs-stripped arena): $0.8447, 179 turns, 100% conductor, 0 escalations — real-grade delete 45 (incl. F2P) + delete_regress 19 + signals/m2m/m2o/o2o 109 + queries 375, ALL OK on gold tests, zero test-file edits** (the instance that false-greened 2026-07-09 by editing 2 P2P tests now lands honestly: fast-deletes grouped by `(model, batch)`, OR'd within groups — batching preserved). Cost is the honest-run outlier; root cause = turn-read under-call (hardness=trivial/shape=build on a design-hard optimization ticket → inline grind; see tuning log, observation only) |

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
# STRIP THE FUTURE (mandatory — found live 2026-07-10 on 11964): a local clone
# carries origin/* refs + tags pointing PAST base_commit, and an agent that runs
# `git log --all` can read the upstream gold fix for its own ticket out of the
# repo's future history. After this, `git log --all` reaches only ≤base commits.
git remote remove origin 2>/dev/null || true
git tag -l | xargs -n100 git tag -d >/dev/null 2>&1 || true
git branch --format='%(refname:short)' | xargs -n20 git branch -D >/dev/null 2>&1 || true
git reflog expire --expire=now --all
# STRIP THE WEB (mandatory — found live 2026-07-10 on the 11885 L2 probe): the
# public web is the same oracle over HTTP — the agent webfetched the Django
# ticket page, GitHub PR search, and upstream's CURRENT source of the buggy file.
# Deny web egress via an arena-local opencode.json (project config walks up from
# cwd and deep-merges over the baked econ defaults; the researcher persona's
# agent-level allow must be overridden separately or it wins over the top level):
cat > opencode.json <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "permission": { "webfetch": "deny", "websearch": "deny" },
  "agent": { "researcher": { "permission": { "webfetch": "deny", "websearch": "deny" } } }
}
JSON
# SWEEP THE DEBRIS (mandatory — found live 2026-07-10 on the 11885 full-stack
# probe): arenas are never `git clean`ed, so prior-run artifacts accumulate and
# become oracles — the probe read a root-level deletion.py (upstream's modern
# fix, webfetch debris from a voided run) AND grepped an old run-*.log for the
# previous attempt's test outcomes, both inside its first 16 tool calls. Before
# every fire, remove run logs and any stray file at the arena root that is not
# part of the checkout; NEVER touch .venv/, PROMPT.txt, fail_to_pass.txt,
# opencode.json:
rm -f run-*.log
git status --porcelain --ignored=no | awk '$1=="??" {print $2}' \
  | grep -vE '^(\.venv/|PROMPT\.txt|fail_to_pass\.txt|opencode\.json)' \
  | xargs -r rm -rf
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
# Log OUTSIDE the arena (../arena-run-logs/) — a log inside the arena becomes an
# oracle for the NEXT run on the same instance (see the 2026-07-10 debris row):
timeout 1800 "$BIN" run "$(cat PROMPT.txt)" --print-logs --log-level DEBUG 2>&1 | tee ../arena-run-logs/run-12039.log
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
| 2026-07-10 | 11885 (full-stack probe 3, fire 1 — **VOID: arena debris is an oracle; + silent-exit engine bug**) | Run VOID on two counts. (1) **Fourth honesty trap — run debris as oracle**: the arena root carried `deletion.py` (upstream's modern implementation, webfetch debris from the morning's voided L2 probe 3) and 4 old `run-11885-*.log` files; the agent read BOTH within its first 16 tool calls (read of root deletion.py; grep of run-11885-L2.log for test outcomes). Debris survives staging because arenas are never `git clean`ed — and the recipe itself wrote logs INTO the arena. (2) **Silent exit**: turn-read judged hard/diagnosis-vague (L4.1 rubric CORRECT on the real ticket — the old rubric's trivial/build misread is fixed), resolution gate fired decompose-now with a valid candidate plan, then ONE non-streaming LLM call sat 6+ min on an open fly.io connection (chunkTimeout only wraps SSE bodies) and the run exited 0 with no receipt, no error, and a snapshot-reverted edit. 22 msgs total | **Arena hygiene + request cap**: (a) all 27 run logs moved out of arenas → `arena-run-logs/`, leaked deletion.py quarantined+removed, recipe amended (logs OUTSIDE the arena; staging sweeps root debris: `*.log`, stray `*.py` at arena root — keep .venv/PROMPT.txt/fail_to_pass.txt/opencode.json); (b) `timeout: 300_000` total-request cap in litellm provider options (chunkTimeout can't see non-SSE bodies) | `econ-defaults.ts`, `opencode.json`, arena trees (untracked), recipe §strip-the-future area | Silent-exit-on-orchestration-throw still unlocated — if a re-fire exits 0 with no receipt again, root-cause the swallow point in the decompose path (slice-orchestrator hook) before trusting any receipt-less run; L4.1 rubric + resolution gate are now confirmed live on the real grinder ticket |
| 2026-07-10 | 11964 (full-stack probe 2, fire 3 on the watchdog binary — **verdict: PASS ×2, cost OPEN, provider-day variance**) | **REAL PASS: $0.1911/43t, inline, armed, no wedge** (fix = `__str__` + `__format__`, superset of gold; F2P 2 OK, P2P 327 OK). Turn count matches post-L2 (43 vs 41) but cost ~2×. Decomposition: +147k uncached input ≈ $0.044 (cache-prefix misses — the identical early-miss signature `cache.read=113/78` exists in the post-L2 run, so substantially provider-side eviction, worse today); +31k output ≈ $0.038 (M3 wrote ~800 visible tok/step vs ~100 post-L2 while think collapsed 3.0k→221 despite the reasoning gate un-muting 8× vs 7× — think-starved provider responses, model compensates in billed text); +260k cache reads ≈ $0.016. All lever mechanisms clean again (0 memo false-fires, valve correctly down, masking under 10k floor, 3 legit stale-read compactions whose timing does NOT line up with the miss window). n=2 fires, 3 distinct run shapes, same green fix | — (no lever-attributable defect; not tuning the engine off a provider-bad-weather day) | — | Re-run 11964 on a calm-infra day before treating the 2× as real; if think-starvation recurs with normal cache hits, investigate minimax reasoning-channel behavior at the gateway (litellm param pass-through) rather than the reasoning gate |
| 2026-07-10 | 11964 (full-stack probe 2, fires 1+2 — **gateway-stall wedge found & fixed**) | Fire 1: **REAL PASS but $0.2132/73t** vs post-L2 $0.0970/41t (2.2×, guardrail flag). Forensics cleared every lever mechanism: arming fired, green memo correctly stood down (all 12 runtests invocations distinct), grind valve correctly stood down (no 15-step stall), 6 legit read truncations, masking under the 10k floor. The +30t = M3 building a standalone `/tmp/django_test.py` repro and fighting `settings.configure`/`INSTALLED_APPS` (~15 turns) — post-L2 run had 0 /tmp calls. Fire 2 (variance check): run took a third path — orchestrated (explorer recon + **oracle design slice**, first 11964 escalation ever); oracle slice finished cleanly (`finish=stop`), then the root's continuation stream **hung forever**: message row created, zero bytes streamed, 12+ min idle before manual kill. Root cause: litellm provider options carried no `chunkTimeout`/`headerTimeout`, so the existing `wrapSSE`/`timeoutController` watchdogs (provider.ts) were dormant — a stalled fly.dev request had nothing to abort it. Same stall class nulled turn-read on the 11999 probe the same day | **Enable the dormant stall watchdogs on the litellm path**: `headerTimeout: 45_000` + `chunkTimeout: 120_000` in the litellm provider options — both map to retryable APIErrors (`HeaderTimeoutError`/`ResponseStreamError`, message-v2.ts) so the loop's existing backoff retries instead of wedging | `econ-defaults.ts`, `opencode.json` (mirror) | 11964 full-stack cost verdict still OPEN (n=2, one grind + one void) — needs a clean fire on the watchdog binary. Watch for spurious `ResponseStreamError` retries on legitimately slow oracle/reasoner thinking (chunk gap >120s would be a false positive); receipt double-pay should stay 0 on retries |
| 2026-07-10 | 11999 (full-stack probe 1, L1–L4 on M3) | **REAL PASS: $0.0307 / 13 turns / batch 1.15/msg / 100% conductor** vs post-L2 $0.0314/20t and baseline $0.0403/18t — guardrail holds, best 11999 result yet; F2P 5 OK + P2P 311 OK on gold, same minimal `setattr` guard fix. M3 batch rate rose above 1.0 for the first time (1.15–1.17 across both fires vs 0.97–1.03 pre-L3) — VERIFY_ONCE trims the redundant green re-runs that used to pad the tail. **First fire VOIDED (35t/$0.0731): turn-read double-null** — both the conductor call and the P5 reasoner re-ask died in the catch branch (12s cap) during one gateway stall; direct latency probe of the same judge call afterwards measured 2.7–5.7s with clean parseable JSON ×3, so the L4.1 rubric is NOT the cause. Degraded run still fixed the right file (arming down = +15 turns on a cheap instance) | — (validation run; transient infra, not engine) | — | Turn-open is a single point of cost-variance: one gateway stall at step 0 cost 2.3× on a cheap instance. If double-null recurs, consider one cheap same-tier retry before the cross-tier re-ask (deliberately NOT added now — n=1, and the code comment's no-retry-on-timeout budget rationale stands) |
| 2026-07-10 | 11885 (L2 probe 3b, web denied — **L2 VALIDATED on the grind case**) | **REAL PASS: $0.4969 / 142 turns / peak ctx 92.2k / 100% conductor, 0 escalations** vs baseline $0.8447 / 179 / 124.8k — **cost −41%** (design-doc sanity math predicted ~$0.38–0.50), cache reads 5.03M vs 12.1M (−58%), turns −21%. Fix confined to `deletion.py` (+35/−8, group-by-batch approach like baseline), zero test edits, F2P 64 + P2P 425 OK on gold, **zero webfetch attempts** (deny config held). Masking at scale: 95/141 results masked + 9 pruned, only 8 verbatim duplicate calls — the ceiling-arm masking + window-exact dedupe economize without thrash. **Full L2 probe set: $0.6253 vs $0.9835 baseline (−36%), 3/3 real-graded green, guardrail held on every ✓ case** | — (validation run; L2 stands as shipped in `d7bfe9a1d`+`91e749acb`) | — | Masking is now load-bearing on >40k runs — keep the tombstone/synthesis lines visible in transcripts; if a future grind shows verbatim-dup counts climbing above ~10% of calls, suspect a new mask-recall gap before touching cadence |
| 2026-07-10 | 11885 (L2 probe 3 — **VOID: web future-leak**) | 362 turns / $2.0040 vs baseline 179 / $0.8447, 13 reasoner + 70 executor turns (baseline was 100% conductor-inline). Run real-grades green (F2P 64 + P2P 459 incl. admin_utils, zero test edits) but is **void as a measurement**: the conductor `webfetch`ed `code.djangoproject.com/ticket/11885`, GitHub PR searches for the fix, and upstream's CURRENT `deletion.py` (the evolved gold fix) — strip-the-future closed the git channel, the model went around it via the web (18 fetches), then burned ~180 turns adapting modern upstream code to the 3.0 tree (incl. a leftover `django/__init__.py` auto-migrate debug hack in the submitted diff — watch-for: declared-done with non-test debug artifacts). NOT an L2-masking effect: root session had 221/293 results masked but only **9 verbatim duplicate calls** (the 11999-probe thrash pathology did not recur at scale) | **Arena no-web config**: every `arena-django-*/opencode.json` now denies `webfetch`/`websearch` at the top level AND for the researcher persona (agent-level allow would override top-level deny); project config walks up from cwd (`config.ts:426`) and deep-merges over the baked econ defaults | `arena-django-*/opencode.json` (×10, untracked arena files), recipe §strip-the-future amended | Re-fire 11885 with web denied for the true L2 grind measurement; masking-at-scale verdict still OPEN; a denied webfetch bounces back to the model — watch it pivot to git archaeology (legit) rather than stall |
| 2026-07-10 | 11999 (L2 probe 1, M3 back as conductor) | **REAL PASS but 79 turns / $0.1723 vs the directly-comparable M3 baseline 18 / $0.0403 — guardrail violation, two L2 defects found and fixed same run.** (1) `pruneStaleReads`' path-level read dedupe is **window-blind**: `base.py` was read 10× in *different* offset/limit pages and 9 were cleared — each new page clears the previous one, the model re-reads the cleared window next step (pure thrash). Promoted from never-fires (524k overflow) to every-10-steps, the latent bug became load-bearing. (2) %10-cadence `maskObservations` rewrote search results the model was still steering by into one-line syntheses → 3× identical `get_FIELD_display` re-searches. Also: batch 0.97/msg confirms the hard BATCH_RULE does NOT steer M3 (flash hit 1.29 — L1 batching is model-dependent); ctx peak 33.9k stayed under the 40k ceiling, so masking on the lean run was all cost, no benefit. Past-mining detour started before the first mask pass (model variance, not L2; arena verified refs-clean) | **Window rule**: a later READ supersedes an earlier one only with the IDENTICAL (offset,limit) window; a later WRITE/EDIT still stales every window of the path. **Mask arm split**: `maskObservations` moved off the %10 cadence to the economic-ceiling arm only (ctx>40k) — lean runs never mask, grinds (11885: 124.8k ctx) still do; stale-read drop + floor-guarded prune stay on %10 | `compaction.ts` (window rule), `prompt.ts` (trigger arms), `compaction.test.ts` (window-rule regression test) | Re-fire 11999 expecting ≈baseline turns; the identical-window dedupe still reclaims true byte-dup re-reads (~18% of reads per the CC research) — watch reclaim volume on 11885; masking now needs a >40k run to validate live (11885 is the probe) |
| 2026-07-10 | 11999 (L1 probe 1) | **REAL PASS — L1 batching verified live.** First run on the L1 engine (`f95f6a72c`) *and* the user's conductor swap (minimax-m3 → deepseek-v4-flash, so $ is not baseline-comparable; turns/batch are the metrics): **14 turns (M3 baseline 18, −22%) · 18 tool calls · batch 1.29/msg (baseline ~1.00)** · $0.0219 · ctx 33.8k. Batch quality textbook: four multi-call orientation messages (2+2+2+3, mixed read/search — exactly what the localization seed pre-marks), then correctly single-call through the dependent edit→test→verify chain. Real-grade 311/311 model_fields OK on gold, zero test edits. L1.3 step budget: 0 firings (nothing oversized) | — (validation run) | — | Batch >1.0 must come from *independent* calls only — audit multi-call messages for dependency violations on every probe |
| 2026-07-10 | 11964 (L1 probe 2) | **REAL FAIL — conductor-swap regression, NOT an L1 defect.** Same L1 engine, deepseek-flash conductor: 62 turns · batch 1.03/msg · $0.0914, fix landed in `query_utils.py` (`DeferredAttribute.__set__` — a no-op for non-deferred fields in 3.0) instead of `enums.py` `__str__`; real-grade 15 failures unchanged from RED. **The agent's own last test run printed `FAILED (failures=15)` and it declared success anyway** (declared-done-on-red; also used `git stash`/`pop` mid-run to A/B its fix). L1 mechanisms behaved: 0 budget truncations (failures were fully visible), batching modest-but-correct during the grind. Context: 11964 was a baseline ✗ in the flash era and passed *only* on the M3 conductor (46-turn ladder pass) — flash + W1–W4 + L1 still can't localize it. n=1 on the swapped conductor | **none** — conductor binding is the user's active experiment (fly.io full re-run in flight); not re-tuning prompts off one flash run | — | Fly.io flash re-run: expect 11964 (and watch 11848/11885, the other ex-baseline-fails) to regress vs the M3 ladder. If declared-done-on-red recurs, consider a mechanical done-gate: block the final answer when the most recent F2P-suite run in-session shows FAILED |
| 2026-07-10 | 11885 (real pass, observation only) | REAL PASS but $0.8447/179 turns — the honest-run outlier (family $0.04–$0.10). Turn-read judged **hardness=trivial, shape=build** ("no diagnosis-shaped goal") because the ticket is phrased as an optimization ask ("combine fast delete queries"), not a bug — so no arming, no decomposition, and the conductor ground 178 execute turns on genuinely design-hard collector-grouping semantics (it converged: grouped by `(model, batch)`, OR'd within groups, batching preserved, ~2500 self-run tests). No tool blobs (max 6.8k tok; M3 held); cost is pure turn count × accumulated context (ctx 124.8k, 12.1M cache reads). Hypothesis: design-shaped optimization prompts should read as hardness=design → reasoner-authored fix slice → likely fewer conductor turns | **none** — n=1; the run passed, 0 escalations, and re-tuning the difficulty judge risks over-firing reasoner slices on the nine cheap instances (guardrail: no ✓ case may get more expensive). Revisit if a second optimization-shaped instance grinds >100 turns | — | If turn-read hardness under-calls recur on optimization-phrased tickets, teach the judge that "make X more efficient / combine Y" is design-shaped, then re-fire 11885 expecting <$0.5 |
| 2026-07-10 | 11790 (runs 1–2, M3) | Run 1 PASS but $0.1874 vs $0.04–$0.10 family: `search(max_length, mode=refs, include_text_occurrences=true, path=django/forms)` returned a **51.5k-char uncapped blob** (est. 73.5k tok) — the rename-scan walks every source file with no occurrence cap, AND refs mode silently dropped the agent's `path` scope, so the walk covered the whole repo. Blob held ctx at 87.3k for ~30 turns ≈ half the spend via cache reads. Secondary: 5 byte-identical `widget_attrs` literal searches (~15k dup tokens; model thrash, left alone). Run 2 on M3 binary: $0.0738/25 turns, ctx 41.8k, biggest search 3.1k tok — **−61% cost, same fix, stronger self-verification** (full 530-test auth_tests) | **M3**: `TEXT_OCCURRENCE_CAP = 50` — occurrence walk early-stops with a self-describing `text_occurrences_truncated: "first 50 shown; narrow with a subdirectory path"` marker; refs mode resolves the walk root from `input.path` instead of always cwd | `code-intelligence/src/tools.ts` (cap + marker), `opencode/src/tool/graph-tools.ts` (refs-mode path scoping) | A genuine repo-wide RENAME with >50 real occurrences now needs path-scoped follow-up calls — watch a rename task stopping at 50 and missing call sites; the truncation marker must keep steering the model to narrow, not to trust the partial list |
| 2026-07-10 | 11964 (honest re-run, refs-stripped arena) | **$0.0985, 46 turns, 100% conductor, real-grade green — no modification needed.** Confirms the voided run's 152-turn/$0.5970 grind was the future-leak rabbit hole (mining `git log --all` for the upstream fix), NOT an engine defect: with the future stripped, the same engine found the same one-line fix in 46 turns with one HEAD-relative `git log -5` and a normal verify loop (model_enums + model_choices/admin_views neighbors). Turn-read armed localization at moderate hardness + planted a frame seed; inline conductor path held | — (validation run; arena recipe already amended with §strip-the-future) | — | Any future arena staged by local clone MUST run the strip block — `git log --all` on an unstripped clone is a gold-patch oracle |
| 2026-07-10 | 12039 (run 3, M2 binary) | **$0.1158, 100% conductor, 0 escalations, real-grade 43/43 OK — no modification needed.** M2 verified live: with turn-file fallback + python probes the fix work probes testable→executor, so no reasoner-tier slice exists, `shouldOrchestrate` stands down, and the single-goal fix-handed turn runs INLINE on the conductor (the designed cheap path; runs 1–2 orchestrated only because mis-probed slices allocated at reasoner). Residual delta vs the 2026-07-09 $0.063 baseline is verification thoroughness (this run also ran backends.test_ddl_references + a schema suite), not misallocation | — (validation run) | — | Same watch-fors as M1/M2 |
| 2026-07-10 | 12039 (run 2, M1 binary) | $0.3149 — M1's harness grounding reached the MODEL (slices ran the real runtests.py suites this time) but not the PROBES: the conductor's fix todo said "Patch IndexColumns.__str__ to drop empty col-suffixes" — no file token at all — so `extractSliceFiles` → [] and every M1 probe stood down; fix slice still authored at reasoner, still qe-venue, still unverified → oracle synthesis + dead re-plan round again. Slice-text extraction alone is a stochastic key | **M2**: `resolveDottedPyModules` (dotted chains resolved against the REAL tree — the prompt names `django.db.backends.ddl_references.Columns`; longest existing `.py` prefix wins, symbols stripped); turn-level file evidence stored at turn-open (`setTurnFiles`, inherit-on-continuation/clear-on-degrade like the verdict) and threaded as `fallbackFiles` into `todosToLoopSlices` — a slice naming NO file probes with the TURN's files; delegates fall back to the parent slice's scope | `slice-orchestrator.ts` (resolver + conversion fallback + deps.turnFiles), `turn-read-store.ts` (files store), `prompt.ts` (turn-open write + deps), `slice-delegation.ts` (parentScope fallback) | Fallback files can over-scope an UNRELATED slice on a multi-goal turn (every no-file slice inherits all turn files) — watch scope-overlap serialization forcing sequential waves on genuinely parallel goals |
| 2026-07-10 | 12039 (run 1 on W1–W4 engine) | Fix correct, real-grade PASS, but $0.3022 vs $0.063 baseline (27/43 turns above conductor, 0 escalations). Turn-open was perfect (diagnosis-grounded, fix handed, no arming, no seed). Three grounded gaps compounded: (1) `SLICE_FILE_RE` requires a `/`, so "Apply the fix to ddl_references.py" probed with ZERO files; (2) both OL-7.9 probes were JS-only (package.json/tsconfig/ts-globs) → every python slice lands untestable → the handed-fix mechanical slice authored at the REASONER (`mechanical-unbacked` cell) and the sound rung had no command; (3) the verify runner then GUESSED `pytest` (django doesn't use it; system 3.13 python, `cgi` gone) → all slices unverified → oracle synthesis ×2 + a reasoner re-plan round whose DAG never dispatched | **M1**: bare-filename arm in `SLICE_FILE_RE` (extension-whitelisted); python-aware `fileHasTests` + `probeSliceVerifyCommands` (stem-referenced test files only, stem-named-first under the 50-file scan cap; django-runtests label conversion; `.venv/bin/python` preferred; pytest only with real pytest config; never a whole-suite run); `detectPythonHarness` also feeds a "Test harness (detected)" line in the repo primer; cwd package.json fallback suppressed for purely-python slices | `slice-orchestrator.ts` (SLICE_FILE_RE, buildRepoPrimer), `graph-tools.ts` (python probes + harness detection) | JS repos: the cwd fallback now skips purely-python slices — watch a mixed-repo slice that names only .py files but expects npm-script verification; bare-filename matching widens P6b scope overlap (more serialization) — watch for spurious implicit deps from prose filenames |
