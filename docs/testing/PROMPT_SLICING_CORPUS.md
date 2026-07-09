# Prompt-Slicing Corpus — the golden spec for arming decisions

The evidence-grounded reference for how econ's slicer/orchestration should read a
prompt and decide **what pre-pass to arm** before executing. Re-read this on every
change to the arming judge or the doors; it is encoded 1:1 in
[`packages/opencode/test/arming-rig/corpus.ts`](../../packages/opencode/test/arming-rig/corpus.ts)
and run as a regression suite (see [Running](#running) at the bottom).

> **Why this doc exists.** The arming decision used to be brittle regex "doors". It is
> now an evidence-grounded LLM judge ([`arming-judge.ts`](../../packages/opencode/src/session/arming-judge.ts)).
> To perfect the judge's prompt and the doors, we need a fixed, labeled set of prompts
> whose *correct* behavior is grounded in external research — not our own guesses — so we
> can run it over and over and measure over-fire / under-fire after every change.

## The model (recap)

- **Shape** (from triage — six in code, `turn-triage.ts`): `diagnosis-grounded` (bug,
  fix-site known), `diagnosis-vague` (bug, fix-site unknown), `build` (new feature/code),
  `audit` (review/analyze, no edit), `qa` (question/navigation — answered inline; **no
  corpus rows yet**, see [Coverage gaps](#coverage-gaps-2026-07-10)), `run-only` (execute
  & report, no edit).
- **Pre-pass we may ARM:** `LOCALIZATION` (a find-the-fix-site pass first), `PLANNER`
  (plan-first), or `NONE` (execute directly). **Code reality (verified 2026-07-10):**
  there is ONE frame seed — `diagnosisPrepassSeed()` always returns the localization
  writer todo; "PLANNER" exists only as the `needsPlan`/hardness flag that (a) plants that
  same seed for non-diagnosis goals and (b) floors its allocation to the reasoner. A hard
  BUILD therefore receives a diagnosis-worded brief ("own this bug… run the failing
  test") — a misframed seed; fix proposed as **P12** in
  [ORCHESTRATION_IMPROVEMENTS.md](../architecture/ORCHESTRATION_IMPROVEMENTS.md). The
  single-seed rule (never planner AND localization on one turn) is correct and stays.
- **Doors** (where arming happens): **Door-1** = the triage skeleton at turn-open
  (`buildTriageTodoSkeleton`); **Door-2** = the todowrite net (`autoTypeTodos`) when the
  conductor writes its to-do list.
- **Tiers (four, two-axis allocation):** generator tier ← difficulty (`conductor` default
  inline; mechanical+testable slices → `executor`; hardness floors the pre-pass at the
  `reasoner`); verifier rung ← consequence (R5 — routes the *verifier*, never the
  generator). **Over-arming wastes money** — that is the failure mode we are tuning against.

## Decision rules (the authority)

These are derived from the research, not from intuition. Each cites its evidence.

**R1 — Localization is diagnosis-only.** Only `diagnosis-*` shapes may arm `LOCALIZATION`.
`build` / `audit` / `run-only` arm neither localization nor (by default) planner.
Localization is the *fix-site-finding* pass for a bug; a feature build with no file named
is normal, not a reason to hunt. *(SWE-bench taxonomy; SWE-agent user-query analysis —
localization is "the hard separator" between diagnosis and everything else.)*

**R2 — For a diagnosis, grounding *strength* decides localization:**
| Grounding in the prompt | Arm? |
|---|---|
| **STRONG** — file path, file+line, stack trace *with* file+line, or symbol **+** file | `NONE` (site is known; file-level grounding is a 15–17× localization win) |
| **SPECIFIED-FIX** — the exact change is stated (not just the symptom) *and* a greppable code symbol is named, e.g. "change `request.args.get()` to `request.form.get()`" | `NONE` (diagnosis is already done — the executor greps the named symbol and applies the handed change; no file path needed) |
| **WEAK** — symbol/function name *without* a file *and only a symptom*, module/component/layer ("the auth layer"), error-message-only | `LOCALIZATION` (a bare symbol is a *deferred start*, not a shortcut — must resolve file first) |
| **NONE** — pure symptom ("crashes", "slow", "wrong output"), repro-steps only | `LOCALIZATION` |
| **ASYMMETRIC** — one side file-grounded, the other a vague layer | `LOCALIZATION` on the vague side |
*(Agentless hierarchical file→function→line; "On the Role of Fault Localization Context";
Bug-Report-Driven FL. A symbol like `QuerySet.delete()` with no file is WEAK: it can be
defined/overridden in many files. But that same bare symbol paired with the **specified
fix** — not just a symptom — is SPECIFIED-FIX, not WEAK: no diagnosis remains, only a
grep-and-apply, so it does **not** arm.)*

**R3 — Planner is for *hardness*, orthogonal to grounding.** Arm `PLANNER` (→ stronger
tier) when the task is cross-layer / multi-file (empirical breakeven ≈ **5 files or 3+
layers**), architectural, ambiguous/underspecified, a novel algorithm, or high-consequence.
Do **not** plan single-file mechanical changes — "overthinking" a trivial task *degrades*
output. A hard *vague* bug (e.g. a race condition) arms `PLANNER`, not just localization;
a simple vague bug arms `LOCALIZATION`. *(Plan-and-execute vs ReAct; test-time-compute /
reasoning-budget routing; CODA/BEST-Route difficulty-aware routing.)*

**R4 — Door-2 sees the to-dos the turn-open judge didn't.** The judge runs once at
turn-open on the *prompt*. By the time the conductor writes its to-do list, those to-dos
may already name a file — new **syntactic** grounding the judge never saw. So at Door-2,
if the active to-dos already name a file target, **suppress** localization even if the
turn-open judge armed it. This is not regex second-guessing the LLM; it is additive
information the LLM could not have had. *(R2 STRONG: a named file means the site is known.)*

**R5 — Consequence ⟂ difficulty.** A small change can be high-consequence (a security
validation, a financial calc). Consequence may pull a stronger tier even when the diff is
tiny. Route by *both* size and impact, not size alone. *(Consequence-aware compute
allocation, "Not All Errors Are Equal".)*

**The syntactic/semantic split (the governing principle).** The judge makes the *semantic*
call on the prompt ("is the site known? is this hard?"). String-matchers only supply
*syntactic* facts the judge cannot see (does a to-do name a file? what shape did triage
assign?). A matcher may **inform or refine** the decision (R4) but never **override** the
judge's semantic read of the same text.

## The corpus

Grouped by shape. `id` matches the scenario id in `corpus.ts`. `ARM` is the *expected*
outcome under the rules above. Rows marked ⚑ are the calibration/regression cases that
have bitten us — keep them.

### diagnosis-grounded → NONE (site is known; execute directly)
| id | example prompt | ARM | why (rule) |
|---|---|---|---|
| `grounded-trivial-central` ⚑ | django-12039: whitespace fix, file+lines named | NONE | R2 STRONG (file+line) — do not localize a known trivial site |
| `grounded-simple` | "in `src/parser.ts` around line 40 the loop should start at 1" | NONE | R2 STRONG (file+line) |
| `grounded-stacktrace` | "TypeError at `auth.py:42` 'NoneType' not subscriptable; full trace: …" | NONE | R2 STRONG (stack trace w/ file+line) |
| `grounded-test-output` | pytest: "expected `DID NOT RAISE` but got `AttributeError` [code shown]" | NONE | R2 STRONG (test output + visible code) |
| `grounded-diagnosis-and-fix` | "uses `request.args.get()` for a POST; should be `request.form.get()`" | NONE | R2 SPECIFIED-FIX — exact change + greppable symbol stated, no file needed (grep-and-apply, not diagnosis); live judge over-fired here until the SPECIFIED-FIX signal was added |
| `grounded-symbol-plus-file` | "`QuerySet.delete()` in `django/db/models/deletion.py` crashes on…" | NONE | R2 STRONG (symbol **+** file) |

### diagnosis-vague → LOCALIZATION (site unknown; find it first) — unless hard (R3)
| id | example prompt | ARM | why (rule) |
|---|---|---|---|
| `spec-language-no-file` ⚑ | django-11885: "n+1 when iterating the collection logic" (no file) | LOCALIZATION | R2 NONE-grounding (symptom only) |
| `vague-crash` ⚑ | "app crashes on startup, first 2–3s of boot" (no file) | LOCALIZATION | R2 NONE-grounding |
| `entity-name-only` ⚑ | "`QuerySet.delete()` drops related rows" (symbol, **no file**) | LOCALIZATION | R2 WEAK (bare symbol = deferred start) |
| `vague-component-leak` | "fix the memory leak in the session handler" | LOCALIZATION | R2 WEAK (component, no file) |
| `vague-why-question` | "why does login fail with special chars but not alphanumeric?" | LOCALIZATION | R2 NONE-grounding, phrased as a question |
| `vague-import-reject` | "the importer rejects vCard 4.0 files" (no file) | LOCALIZATION | R2 NONE-grounding |
| `vague-hard-race` ⚑ | "fix the race condition in cache invalidation; concurrent writes corrupt it" | PLANNER | R3 hard vague bug (concurrency, cross-cutting) → plan, not just localize |

### diagnosis, asymmetric grounding → LOCALIZATION on the vague side (the row-5 flip)
| id | example prompt | ARM | why (rule) |
|---|---|---|---|
| `grounded-cross-layer-file-named` ⚑ | "fix HTTP serialization in `server/api.ts` **and** a query in the database layer" | LOCALIZATION | R2 ASYMMETRIC — the vague DB side still needs localization. **Judge was right to arm; old label was wrong.** (Planner would be over-escalation at 2 layers per R3.) |

### build → NONE, unless multi-file/cross-cutting/ambiguous → PLANNER (R1, R3)
| id | example prompt | ARM | why (rule) |
|---|---|---|---|
| `feature-build` ⚑ | "add a `--json` output flag to the CLI" | NONE | R1 — build never arms localization; single-ish, well-specified |
| `build-hello-endpoint` | "make a flask app with a `/hello` endpoint returning hello world" | NONE | R1; simple, scoped |
| `build-write-tests` | "write tests for the `BankAccount` class covering edge cases" | NONE | R1; scoped test-writing |
| `build-migration` | "add a migration for a `user_roles` column defaulting to 'user'" | NONE | R1; mechanical DDL |
| `build-doc-sync` | "update the docs to match the new API schema [provided inline]" | NONE | R1; mechanical, spec inline |
| `build-refactor-jwt` | "refactor the auth module to use JWT tokens instead of sessions" | PLANNER | R3 cross-cutting (many call sites) |
| `build-dark-mode` | "add dark mode: navbar toggle + persist in localStorage + all panels" | PLANNER | R3 multi-component |
| `build-multifile-complex` | "make a coordinated change across several files; fix bugs from the error output" | PLANNER | R3 multi-file coordination + debug |
| `build-linear-ticket` | "implement: add CSV export to the reports page (button → download)" | PLANNER | R3 multi-step UI→backend→test |

### audit → NONE (no edit, no fix-site)
| id | example prompt | ARM | why (rule) |
|---|---|---|---|
| `audit` ⚑ | code review / audit task | NONE | R1 |
| `audit-where-is` | "where is the user authentication logic?" | NONE | R1; navigation/QA, no edit |
| `audit-explain` | "explain how the DI container resolves services" | NONE | R1; comprehension |
| `audit-review-pr` | "review this PR for security vulnerabilities" | NONE | R1; diff provided |

### run-only → NONE (execute & report)
| id | example prompt | ARM | why (rule) |
|---|---|---|---|
| `run-only` ⚑ | "run the full test suite on latest main and report failures with traces" | NONE | R1; execute-only |
| `run-tests-report` | "run the tests and report failures" | NONE | R1 |

### multi-goal → arm if any goal warrants it
| id | example prompt | ARM | why (rule) |
|---|---|---|---|
| `multi-goal-mixed` ⚑ | one grounded goal + one vague goal in the same turn | LOCALIZATION | the vague goal is unlocated → arm for it |

### Door-2 (todowrite net) — R4
| id | example prompt + to-dos | ARM | why (rule) |
|---|---|---|---|
| `door2-grounded-mechanical-todos` ⚑ | prompt: "fix the trailing commas in the schema import"; to-dos name `database.ts` | NONE | R4 — to-dos name a file → suppress even if turn-open judge armed |
| `door2-vague-mechanical-todos` ⚑ | prompt: vague perf; to-dos name **no** file | LOCALIZATION | R4 — no file in to-dos → arming stands |

### Genuinely ambiguous (documented, low-weight — flag, don't over-fit)
| id | example prompt | note |
|---|---|---|
| `ambiguous-log-a-bug` | "log a bug for a 500 error on login" | Report-vs-diagnose ambiguity: is the ask to *file an issue* (build/run-only) or to *fix* it (diagnosis-vague)? We treat "log a bug" as **build** (create an issue), NONE. Revisit if real usage disagrees. |

## Fixes this corpus drove

Tracked against the live-judge run of 2026-07-09 (9 ok / 3 over-fire on minimax-m3).
**All three landed 2026-07-09** (suppressor at `slice-orchestrator.ts` `fileTargetsOf`,
diagnosis-gating in `arming-judge.ts`, relabel in `corpus.ts`); offline rig green since
(0 over-fire / 0 under-fire):

1. **`autoTypeTodos` file-target suppressor (R4).** Door-2 must not inject localization when
   the active to-dos already name a file target — fixes `door2-grounded-mechanical-todos`.
2. **Non-diagnosis shapes never arm localization (R1).** Short-circuit `build`/`audit`/
   `run-only` to no-localization before/at the judge — fixes `feature-build`. (Cheaper too:
   don't even ask the judge for a non-diagnosis shape.)
3. **Asymmetric grounding arms (R2).** `grounded-cross-layer-file-named` is **relabeled to
   arm** — the judge was correct; the prior hand-label was wrong. Open tuning question:
   prefer LOCALIZATION (vague side) over PLANNER for a 2-layer case (R3 breakeven ≈ 5 files).

## Coverage gaps (2026-07-10)

Audited against the current code + the proposal round in
[ORCHESTRATION_IMPROVEMENTS.md](../architecture/ORCHESTRATION_IMPROVEMENTS.md); the rules
(R1–R5) and expected labels above all held — these are missing *rows*, not wrong ones:

1. **No `qa` rows.** The shape exists in code; `audit-where-is` / `audit-explain` are
   question-shaped and may live-classify as `qa`, not `audit` (the rig mocks triage, so it
   never checks). Add qa rows + verify those two labels with a live run before trusting them.
2. **No follow-up-turn rows.** A third of real messages continue a prior task (P4's
   subject); the corpus is 100% first-turn. Add continuation cases (no re-arm expected).
3. **P3 will relabel/add:** `build-refactor-jwt` becomes shape `refactor` when it lands;
   `research` needs new rows. Expectations for existing rows are otherwise unchanged.
4. **The rig is seed-kind-blind.** `run.ts` scores "any pre-pass armed" and only detects
   the localization content — so the PLANNER rows (`vague-hard-race`, the four hard
   builds) pass green while actually planting the diagnosis-worded seed (the P12 gap this
   audit found). When P12 lands, add a seed-kind column assertion so planner-vs-localizer
   is tested, not assumed.

## Running

Deterministic (free, mocked triage verdicts — validates the arming *logic*):
```
cd packages/opencode && bun run test/arming-rig/run.ts
```
Live (spends a few cents — validates the *real* judge on the conductor tier):
```
set -a; source infra/litellm/.env.local; set +a
export LITELLM_API_KEY="$LITELLM_MASTER_KEY"
cd packages/opencode && RIG_LIVE=1 bun run test/arming-rig/run.ts
```
The scorecard prints, per case: expected vs actual arm, the seed (localization/planner/—),
and `ok` / `over-fire` / `under-fire`. Live mode also prints the judge's `evidence` string
per row so the grounding can be eyeballed. **Target: 0 over-fire, 0 under-fire.** The live
run pins to the **conductor tier** (`ECON_TIER_BINDING.conductor`) — never a model name.
