# Prompt-Slicing Corpus — the golden spec for arming decisions

The evidence-grounded reference for how econ's slicer/orchestration should read a
prompt and decide **what pre-pass to arm** before executing. Re-read this on every
change to the turn-read prompt, the arming decision table, or the doors; it is encoded 1:1 in
[`packages/opencode/test/arming-rig/corpus.ts`](../../packages/opencode/test/arming-rig/corpus.ts)
and run as a regression suite (see [Running](#running) at the bottom).

> **Why this doc exists.** The arming decision used to be brittle regex "doors". It is
> now a single evidence-grounded **turn-read** extraction
> ([`turn-triage.ts`](../../packages/opencode/src/session/turn-triage.ts) — one temp-0
> conductor call that reports per-diagnosis-goal facts) plus a **pure decision table**
> ([`decideArming`, `arming-judge.ts`](../../packages/opencode/src/session/arming-judge.ts))
> that applies the policy in code. To perfect the extraction prompt and the table, we need
> a fixed, labeled set of prompts whose *correct* behavior is grounded in external research
> — not our own guesses — so we can run it over and over and measure over-fire /
> under-fire / wrong-seed after every change.

## The model (recap)

- **Shape** (from the turn-read — eight in code, `turn-triage.ts`): `diagnosis-grounded`
  (bug, fix-site known), `diagnosis-vague` (bug, fix-site unknown), `build` (new
  feature/code — adds or changes behavior), `refactor` (restructures **without changing
  behavior**; adds-behavior ⇒ `build` — the crisp P3 discriminator), `audit`
  (review/analyze, no edit), `qa` (question answerable from THIS repo's code; **no corpus
  rows yet**, see [Coverage gaps](#coverage-gaps-2026-07-10)), `research` (deliverable
  needs **external sources** — docs/changelogs/web; repo-answerable ⇒ `qa`), `run-only`
  (execute & report, no edit).
- **Constraint kinds** (arm hard gates, not shapes): `no-test-edit`, `no-edits`
  ("propose, don't code" — a hard deny at the edit/write tool boundary for the turn),
  `scope-limit`, `no-new-files`, `other`.
- **Turn role** (P4): `fresh` vs `continuation`. A short code-free ack ("go ahead",
  "still broken") on a session with prior turns short-circuits pre-LLM; a continuation
  inherits the stored verdict/arming/pin and **never re-arms** a settled pre-pass.
- **Pre-pass we may ARM:** `LOCALIZATION` (the localize-fix-verify writer seed,
  `LOCALIZATION_SLICE_CONTENT` — armed by `decideArming` on diagnosis goals only),
  `PLAN` (the edit-free decomposition seed, `PLAN_SLICE_CONTENT` — planted on
  `needsPlan` **non-diagnosis** goals; landed as **P12**, closing the old misframed-seed
  gap where a hard build received the bug-hunt brief), or `NONE` (execute directly). The
  single-seed rule per goal holds: a diagnosis goal never plants both — `needsPlan` is
  ignored on the diagnosis branch (the 12050 double-seed regression).
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
`build` / `refactor` / `audit` / `qa` / `research` / `run-only` arm neither localization
nor (by default) the plan seed.
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

**R3 — Planning is for *hardness*, orthogonal to grounding.** Arm the `PLAN` seed
(`needsPlan` → the reasoner-floored, edit-free design seed) when a **build** task is
cross-layer / multi-file (empirical breakeven ≈ **5 files or 3+ layers**), architectural,
ambiguous/underspecified, a novel algorithm, or high-consequence. Do **not** plan
single-file mechanical changes — "overthinking" a trivial task *degrades* output. On a
**diagnosis** goal, hardness moves the *tier*, not the seed: a hard vague bug (e.g. a race
condition) arms the `LOCALIZATION` writer with its generator floored at the reasoner
(`hardness:"hard"`); the plan seed is build-only — `needsPlan` is ignored on the diagnosis
branch (the 12050 single-seed rule). *(Plan-and-execute vs ReAct; test-time-compute /
reasoning-budget routing; CODA/BEST-Route difficulty-aware routing.)*

**R4 — Door-2 sees the to-dos the turn-open read didn't.** The turn-read runs once at
turn-open on the *prompt*. By the time the conductor writes its to-do list, those to-dos
may already name a file — new **syntactic** grounding the extraction never saw. So at
Door-2, if the active to-dos already name a file target, **suppress** localization even if
the turn-open decision armed it. This is not regex second-guessing the LLM; it is additive
information the LLM could not have had. *(R2 STRONG: a named file means the site is known.)*

**R5 — Consequence ⟂ difficulty.** A small change can be high-consequence (a security
validation, a financial calc). Consequence may pull a stronger tier even when the diff is
tiny. Route by *both* size and impact, not size alone. *(Consequence-aware compute
allocation, "Not All Errors Are Equal".)*

**R6 — Optimization/efficiency phrasing is design-shaped, never build-trivial.** Goals
phrased as optimization asks — "make X more efficient", "combine/reduce/batch/dedupe the Y
queries/calls", "avoid unnecessary Z" — are **diagnosis-shaped even when no bug is named**:
the current wasteful behavior is the symptom, and the deliverable is an *algorithmic
decision* (what may be combined or skipped, and which semantics survive), not a mechanical
edit. Shape reads `diagnosis-vague` unless a file/module is named; spec verbs ("should
combine", "could be reduced") do not make waste a feature, and a stated *target* ("into one
query per table") is a goal, not a handed fix — it never sets `fixSpecified`. **Hardness
reads at least `hard`** when the change crosses grouping, ordering, batching, or invariant
semantics — the R3 rule then floors the localization writer's generator at the reasoner.
Boundary: a wrong-logic defect that merely *mentions* batching/queries (11951's "batch_size
overrides the compatible calculation" — a handed clamp fix) is R2, not R6. *(Evidence:
django-11885 "combine fast delete queries" read hardness=trivial/shape=build → no arming,
no decomposition → a 179-step, $0.8447 inline grind — SWE_BENCH_TRACKER.md tuning log
2026-07-10; the design-shaped read prices at ~$0.23–0.4 via a reasoner design slice
(12039 run-1). Survey grounding: MinionS decompose-expensive/execute-cheap, aider
architect-mode, ADaPT decompose-on-failure — turn-cache-economics §3.4/§5-L4.)*

**The syntactic/semantic split (the governing principle).** The turn-read makes the
*semantic* call on the prompt ("is the site known? is this hard?" — reported as evidence
facts the `decideArming` table converts into the decision). String-matchers only supply
*syntactic* facts the extraction cannot see (does a to-do name a file?). A matcher may
**inform or refine** the decision (R4) but never **override** the semantic read of the
same text.

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
| `spec-language-no-file` ⚑ | django-11885 flavor: "n+1 when iterating the collection logic" (no file) | LOCALIZATION | R2 NONE-grounding + R6 — optimization phrasing: hardness reads `hard` (grouping semantics), flooring the writer at the reasoner |
| `optimization-combine-queries` ⚑ | django-11885 (the real archetype): "combine the fast delete queries … avoid the unnecessary round trips" (no file, zero defect keywords) | LOCALIZATION | R6 — optimization-phrased = design-shaped: `diagnosis-vague` + hardness `hard` (never build/trivial — the $0.84 under-call) |
| `vague-crash` ⚑ | "app crashes on startup, first 2–3s of boot" (no file) | LOCALIZATION | R2 NONE-grounding |
| `entity-name-only` ⚑ | "`QuerySet.delete()` drops related rows" (symbol, **no file**) | LOCALIZATION | R2 WEAK (bare symbol = deferred start) |
| `vague-component-leak` | "fix the memory leak in the session handler" | LOCALIZATION | R2 WEAK (component, no file) |
| `vague-why-question` | "why does login fail with special chars but not alphanumeric?" | LOCALIZATION | R2 NONE-grounding, phrased as a question |
| `vague-import-reject` | "the importer rejects vCard 4.0 files" (no file) | LOCALIZATION | R2 NONE-grounding |
| `vague-hard-race` ⚑ | "fix the race condition in cache invalidation; concurrent writes corrupt it" | LOCALIZATION | R2/R3 hard vague bug — the LOCALIZATION writer, hardness-floored to the reasoner; the plan seed is build-only (12050 single-seed rule) |

### diagnosis, asymmetric grounding → LOCALIZATION on the vague side (the row-5 flip)
| id | example prompt | ARM | why (rule) |
|---|---|---|---|
| `grounded-cross-layer-file-named` ⚑ | "fix HTTP serialization in `server/api.ts` **and** a query in the database layer" | LOCALIZATION | R2 ASYMMETRIC — the vague DB side still needs localization. **Judge was right to arm; old label was wrong.** (Planner would be over-escalation at 2 layers per R3.) |

### build → NONE, unless multi-file/cross-cutting/ambiguous → PLAN seed (R1, R3)
| id | example prompt | ARM | why (rule) |
|---|---|---|---|
| `feature-build` ⚑ | "add a `--json` output flag to the CLI" | NONE | R1 — build never arms localization; single-ish, well-specified |
| `build-hello-endpoint` | "make a flask app with a `/hello` endpoint returning hello world" | NONE | R1; simple, scoped |
| `build-write-tests` | "write tests for the `BankAccount` class covering edge cases" | NONE | R1; scoped test-writing |
| `build-migration` | "add a migration for a `user_roles` column defaulting to 'user'" | NONE | R1; mechanical DDL |
| `build-doc-sync` | "update the docs to match the new API schema [provided inline]" | NONE | R1; mechanical, spec inline |
| `build-refactor-jwt` | "refactor the auth module to use JWT tokens instead of sessions" | PLAN | R3 cross-cutting (many call sites); classifies `build` — swapping sessions for JWT changes behavior, not just structure |
| `build-dark-mode` | "add dark mode: navbar toggle + persist in localStorage + all panels" | PLAN | R3 multi-component |
| `build-multifile-complex` | "make a coordinated change across several files; fix bugs from the error output" | PLAN | R3 multi-file coordination + debug |
| `build-linear-ticket` | "implement: add CSV export to the reports page (button → download)" | PLAN | R3 multi-step UI→backend→test |

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

### research → NONE (external-knowledge deliverable; arming N/A) — P3
| id | example prompt | ARM | why (rule) |
|---|---|---|---|
| `research-pure-lookup` | "what breaking changes did zod v4 ship, and do any affect our config validation?" | NONE | R1/P3 — external lookup, not a diagnosis; the qa/research boundary is "needs external sources" |
| `research-build-compound` | "find out how the new stripe API paginates events, then update our webhook client" | NONE | P3 — research + scoped build, ordered goals; neither is a diagnosis |

### refactor → NONE (behavior-preserving restructure; arming N/A) — P3
| id | example prompt | ARM | why (rule) |
|---|---|---|---|
| `refactor-pure` | "extract the retry logic into a shared helper, no behavior change" | NONE | P3 — suite green + no signature breaks is the safety net; no pre-pass |
| `refactor-boundary-adds-behavior` | "refactor the export pipeline so it also emits JSON alongside CSV" | NONE | P3 boundary — ADDS behavior ⇒ classifies `build`, never `refactor`, despite the user's verb |

### no-edits constraint — plan-only turns compose, they don't reshape — P3
| id | example prompt | ARM | why (rule) |
|---|---|---|---|
| `no-edits-plan-only` | "plan the migration to the new billing provider — propose the steps, don't write code" | PLAN | P3 — `build` + `no-edits` + `needsPlan`: the P12 plan seed still plants (edit-free by design) while the no-edits gate hard-denies the edit tools |

### continuation turns (P4) — inherit, never re-arm
| id | example prompt | expected | why (rule) |
|---|---|---|---|
| `continuation-go-ahead` | "go ahead" (after a planned build) | short-circuit, continuation, no reseed | P4 case 1 — pure ack skips the turn-read call entirely; arming inherited |
| `continuation-still-broken-no-rearm` | "still broken" (localization pre-pass already SETTLED on the list) | short-circuit, continuation, nothing new planted | P4 case 2 — re-fired diagnosis language must re-verify (inherited M4 pin + rungs), never re-arm |
| `continuation-new-goal-fresh` | "now also handle the empty case" | FRESH — goals extracted normally | P4 case 3 — a follow-up carrying a new deliverable must not be swallowed by continuation handling |

### Ladder negative controls (L4.1) — the nine cheap instances must not move
The SWE-mini-10 ladder's nine cheap instances (SWE_BENCH_TRACKER.md) are the R6 regression
set: **0 over-fires is the hard gate**, and the armed rows stay at their pre-calibration
hardness (`moderate`, never `hard`). django-12039 is covered by `grounded-trivial-central`
+ `door2-grounded-mechanical-todos` above; the other eight:

| id | example prompt | ARM | why (rule) |
|---|---|---|---|
| `ladder-11790-form-attr` | "AuthenticationForm's username field doesn't render maxlength anymore" | LOCALIZATION | R2 WEAK (symbol, no file) — defect phrasing, not optimization |
| `ladder-11815-enum-name` | migrations write `Status('Good')`; "should write the name instead, `Status['GOOD']`" | NONE | R2 SPECIFIED-FIX — exact change handed (live-validated non-arm, tracker row 9) |
| `ladder-11848-http-date` | "`django.utils.http.parse_http_date`'s two-digit year handling is incorrect …" | NONE | R2 STRONG — dotted module names the site |
| `ladder-11880-deepcopy` | "Form `Field.__deepcopy__` doesn't deep-copy the error messages …" | LOCALIZATION | R2 WEAK (method symbol, no file) |
| `ladder-11951-batch-size` | "`bulk_create`'s batch_size overrides the compatible calculation — should take the minimum …" | NONE | R2 SPECIFIED-FIX — the R6 near-miss: "batch" wording alone never triggers R6 |
| `ladder-11964-choices-type` | "value of a TextChoices/IntegerChoices field has a differing type …" | LOCALIZATION | R2 WEAK (classes named, no file); live-validated armed case |
| `ladder-11999-display-override` | "cannot override `get_FOO_display()` anymore …" | LOCALIZATION | R2 WEAK; live-validated arm at moderate/clear (tracker row 6) |
| `ladder-12050-list-coerce` | "`Query.resolve_lookup_value` coerces a list value to a tuple …" | LOCALIZATION | R2 WEAK; "coerces" is defect language, never R6 |

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
   arm** — the judge was correct; the prior hand-label was wrong. The then-open tuning
   question (localization vs planner for a 2-layer case) was settled by the P12/12050
   rule: a diagnosis goal always gets the LOCALIZATION writer — the plan seed is
   build-only, and hardness moves the tier, not the seed.
4. **Optimization phrasing is design-shaped (R6, landed 2026-07-10 — L4.1).** The 11885
   real-graded pass exposed the turn-read under-call (build/trivial on "combine fast
   delete queries" → $0.8447 inline grind); the rubric row in
   `prompts/judges.ts` (`TURN_READ_SYSTEM_PROMPT`) teaches the calibration, and the
   `optimization-combine-queries` row + the eight ladder negative controls above pin it.
   Rig green 0-over-fire deterministically; the live (RIG_LIVE=1) re-validation of the
   real extractor on these rows is still pending.

## Coverage gaps (2026-07-10)

Audited against the current code + the proposal round in
[ORCHESTRATION_IMPROVEMENTS.md](../architecture/ORCHESTRATION_IMPROVEMENTS.md); the rules
(now R1–R6) and expected labels above all held — these are missing *rows*, not wrong ones.
Items 2–4 were **closed by the W1–W3 landings (2026-07-10)**; item 1 stays open:

1. **No `qa` rows** (still open). The shape exists in code; `audit-where-is` /
   `audit-explain` are question-shaped and may live-classify as `qa`, not `audit` (the rig
   mocks the turn-read, so it never checks). Add qa rows + verify those two labels with a
   live run before trusting them.
2. ~~No follow-up-turn rows.~~ **Closed (P4, `e372a3c1d`):** three continuation rows landed
   (see the continuation table above), scored with a `wrong-role` verdict.
3. ~~P3 will relabel/add.~~ **Closed (P3, `e372a3c1d`):** `research` and `refactor` rows
   landed with a `wrong-shape` verdict. Note the audit's guess about `build-refactor-jwt`
   was corrected by the discriminator: swapping sessions for JWT *changes behavior*, so it
   stays `build` — the pure-restructure case got its own `refactor-pure` row instead.
4. ~~The rig is seed-kind-blind.~~ **Closed (P12, `229a9303a`):** `run.ts` asserts the
   seed KIND per row (`wrong-seed` verdict); plan-vs-localization is tested, not assumed —
   and the corpus relabeled `vague-hard-race` to the localization writer (hardness floors
   the tier; the plan seed is build-only).

## Running

Deterministic (free, mocked triage verdicts — validates the arming *logic*):
```
cd packages/opencode && bun run test/arming-rig/run.ts
```
Live (spends a few cents — validates the *real* judge on the conductor tier):
```
set -a; source ../unerr-benchmarks/infra/litellm/.env.local; set +a  # moved to sibling repo 2026-07-19
export LITELLM_API_KEY="$LITELLM_MASTER_KEY"
cd packages/opencode && RIG_LIVE=1 bun run test/arming-rig/run.ts
```
The scorecard prints, per case: expected vs actual arm, the seed (localization/plan/—),
the turn role, and `ok` / `over-fire` / `under-fire` / `wrong-seed` / `wrong-role` /
`wrong-shape`. Live mode (which exercises the real turn-read extractor) also prints the
decision's `evidence` string per row so the grounding can be eyeballed. **Target: 0 on
every failure column.** The live run pins to the **conductor tier**
(`ECON_TIER_BINDING.conductor`) — never a model name.
