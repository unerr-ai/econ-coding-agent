# The econ harness — mechanism walkthrough + the 2026-07-13 variance forensics

**What this is.** One report, two halves. Part I is a plain-language, code-grounded
walkthrough of the harness as it exists at HEAD (`acb49dee5`) — every mechanism, its
trigger condition (if/else), and its exception/fallback path, each with `file:line`
anchors. Parts II–V are the forensic analysis of the 2026-07-13 benchmark runs: five
runs of the same build, one all-green, four with failures at *different* failure points —
the stochastic-variance signature. Every claim below is grounded in either the codebase
or a run bundle; nothing is inferred from memory.

**Sources.** Three fleet failed-run bundles
(`unerr-benchmarks/e2e/distributed/failed-runs/mini10ded-0713-{1859,2058}`,
`mini10ded-x10-0713-2107` — report.json, model_patch.diff, events.jsonl, engine.log,
opencode.db per instance), the round-E local record in
[STRICT_CYCLE.md](./STRICT_CYCLE.md), and a full code map of
`packages/opencode/src/session/` + `packages/code-intelligence/src/`. One autopsy
(11848) re-ran the official swebench docker grading image to verify its claims.

---

## Part I — How the harness works (the current mechanism map)

### I.0 The cast, in one paragraph

A turn is run by the **conductor** — the cheap lead model — inside one supervised loop
(`packages/opencode/src/session/prompt.ts`, the `while(true)` at `prompt.ts:2002`,
finish `break` at `prompt.ts:3401`). Around it sit four kinds of machinery:
**turn-open shaping** (a triage extraction + a pure-code arming decision + planted todo
"seeds" carrying maintainer priors), the **orchestration hook** (decides
inline-vs-decompose; typed slices dispatch to child sessions on the
executor/reasoner/oracle tiers), **edit-time gates** (deterministic denies that fire
inside the edit/write tools), and **finish gates** (checks that run when the model
declares done, each of which can reject the finish and inject a corrective nudge).
Tier↔model binding lives in one registry
(`packages/code-intelligence/src/model-registry.ts:164-169`, `ECON_TIER_BINDING`:
conductor / executor / reasoner / oracle). The graph brain is in-process
(`bun-sqlite-graph.ts` — no sidecar).

The design philosophy, stated in the code over and over: **models extract facts, code
makes decisions** — and every failure path degrades to the cheapest posture, escalating
only on observed evidence.

### I.1 Turn open (step 0) — what happens before the model's first word

All of it lives in one block: `prompt.ts:3429-3700` (`if (step === 0 && !prepassSeeded)`).

```
prompt arrives
  ├─ child session?  → inherit parent's gates (test-edit, no-edits, hub), NO triage    (:3437-3453)
  └─ root session:
       1. test-edit gate DEFAULTS TO DENY: regexDeny = !promptAuthorizesTestEdits(text) (:3456)
       2. TURN-READ (the merged triage call)                                            (:3489)
       3. ARMING decision (pure code, no LLM)                                           (:3566-3581)
       4. gates armed, seeds planted, preamble built                                    (:3586-3677)
```

**1. The turn-read** (`turn-triage.ts:348-363`, dispatched at `prompt.ts:661-706`) is one
temperature-0, forced-JSON call on the conductor's own model, 12s cap
(`TURN_READ_TIMEOUT_MS`, `turn-triage.ts:301` — the old 8s arming cap is gone; this
inherits its budget). It extracts, never decides: up to 7 goals, each with a verbatim
quote, a shape (`diagnosis-vague | diagnosis-grounded | build | refactor | audit | qa |
research | run-only`), evidence fields (`locationNamed`, `fixSpecified`, `hardness`,
`ambiguity`), plus constraints (`no-test-edit`, `no-edits`, …) and
`confidence`/`turnRole`.

Fallback ladder — every failure degrades, never blocks:

```
parse failure            → retry ONCE (turn-triage.ts:351-361)
timeout                  → null, never retried ("budget already spent", :340-343)
conductor returned null  → ONE reasoner re-ask (prompt.ts:3490-3494)
confidence == "low"      → reasoner re-ask; adopt if it found ≥ as many goals (:3495-3503)
still null               → P5 NEUTRAL DEGRADE (:3679-3698): no preamble, no skeleton,
                           no probe pin — only the regex test-edit deny survives
short ack prompt (<80ch) → continuation short-circuit, no LLM call (turn-triage.ts:289-294)
turnRole == continuation → inherit everything from the previous turn: verdict, arming,
                           pinned probe; resolve-attempts NOT reset (:3508-3547)
```

**2. The arming judge** (`arming-judge.ts:130-171`) is **a code table, not a model**:

```
if no verdict            → DEGRADED_ARMING (:94-102): everything stands down, hardness
                           floor "trivial", degraded:true → conductor held INLINE all turn
read-only turn           → degraded:true too (applied at the prompt.ts arming site, not
  (verdictIsReadOnly)      inside decideArming): EVERY goal qa/research/audit/run-only AND
                           confidence=="high" → answer inline, no decomposition, no repro
                           pre-pass. A COMPOUND turn with even one diagnosis/build/refactor
                           goal is NOT read-only → full harness. Gated on high confidence so
                           a shaky read pays the harness rather than no-op a misread ticket.
per diagnosis goal:  arm |= !fixSpecified && (!locationNamed || hardness=="hard")   (:149)
armReproduction = any diagnosis goal exists (repro-first even for located bugs)    (:165)
hardness = anyNeedsPlan ? "hard" : max(goal hardness)                              (:167)
ambiguity = anyGoalAmbiguous || confidence=="low" ? "ambiguous" : "clear"          (:168)
```

The read-only stand-down is the turn-shape lever that arms the fix machinery
*as-needed* rather than on every turn (the deterministic `nonFixQaShortCircuit`,
`turn-triage.ts`, is its cheap fast-path — it synthesizes exactly such a
high-confidence `qa` verdict and skips the LLM turn-read entirely). Its preamble
counterpart is the `READ_ONLY_PLAYBOOK` line (`prompts/preambles.ts`), emitted on
the same `verdictIsReadOnly` condition, steering the conductor to answer-and-stop
instead of authoring a repro or running the suite inline.

**3. Seeds** (`buildTriageTodoSkeleton`, `slice-orchestrator.ts:1442-1472`; contents in
`prompts/seeds.ts`) are planted only when the todo list is empty. Per diagnosis goal:
a **repro seed** (deliberately untyped → runs inline on the conductor, the only seat
that can watch its own red run) and, if armed, a **localization seed** (a writer slice,
difficulty-allocated). The seeds carry the maintainer priors verbatim — the ones the
strict cycle proved matter:

- *root-most layer*: "Fix at the root-most layer: change the definition of the entity
  whose behavior the issue calls wrong … never coerce or compensate at the sites where
  its values flow."
- *typed equality*: "Assert … using typed equality against the value's natural source
  (e.g. == field.max_length, not == '254') — never presence, substring, or
  printed-output checks."
- *mirrored entry*: "assert THAT mirrored entry with the same typed equality … never the
  rendered output: string rendering erases exactly the int-vs-'254' difference the
  grader checks."
- *tests are spec*: "If an EXISTING test goes red under your change, treat that test as
  the spec … change your design, never the test's expectations." *(see Part III.1 — this
  prior is exactly inverted on the 11815 class)*
- *idiom mirror*: "mirror the surrounding code's idioms and types exactly — never add
  coercions … the neighboring code does not use." *(conflicts with typed-mirror on the
  11790 class — see Part III.4)*

**4. Gates armed at turn open**: the no-test-edit gate arms on **every** turn unless the
prompt explicitly authorizes test work (`prompt.ts:3416-3428` — the 2026-07 fix; no
longer conditioned on bug-shaped wording), and its rule is stated upfront in the
preamble (`TEST_EDIT_GATE_RULE`, `prompts/preambles.ts:36-37`). A diagnosis-shaped goal
pins an **M4 probe** from the prompt if it names one (`prompt.ts:3634-3643`). M2 file
evidence (path tokens + dotted Python modules resolved against the tree,
`slice-orchestrator.ts:625-659`) is stored for later slice probes.

**5. Reasoning effort** (`llm/reasoning-gate.ts:13-24`, hooked at `llm/request.ts:144`):
small calls (title, summaries) are muted; ordinary calls pass through; a stale `"none"`
is rewritten to bounded `"high"` (E0 — the conductor thinks; the old adaptive gate is
deleted, and with it the F4b scope-miss check — `tier-prompts.md:321,594` are stale).

### I.2 The orchestration hook — inline vs decompose

`runConductorOrchestration` (`slice-orchestrator.ts:2104-2305`), called whenever todos
are (re)written. The decision tree:

```
todos unreadable                        → metered fallback, legacy path       (:2107-2113)
no PENDING TYPED slice                  → not engaged (untyped batches never engage) (:2114)
fresh turn + sessionID:                                                        (:2145-2207)
  flagged = ambiguous OR hard
  if flagged → resolutionDecision (resolution-phase.ts:84-140):
      1b. ARMED turn (armLocalization):
            attempts==0 → resolve-first (plant localization pre-pass; NO slices)
            attempts≥1 → continue-inline (armed turns NEVER decompose;
                          grind valve is the only escalation)
      2.  valid candidate plan → decompose-now
      3.  needs user + interactive → ask-user
      4.  attempts ≥ MAX_RESOLVE_ATTEMPTS(2) → decompose-now (termination)
      5.  else → resolve-first
degraded arming                         → conductor todos held INLINE; only the grind-
                                          valve design pre-pass may orchestrate (:2219-2229)
benefit gate shouldOrchestrate           → engage only if ≥6 slices, OR a reasoner-floor
  (slice-orchestrator.ts:1929-1934)       slice, OR ≥2 goals, OR a parallel wave ≥2;
                                          a linear chain stays inline
engaged → runConductorSliceLoop; blocked dependents settle "cancelled" (P6a);
          finally-write: any marked-but-unsettled todo → "failed" (OL-9.3c, :2299-2304)
any internal throw                      → caught at the boundary, metered fallback
```

**Slices** get: a persona (explorer/runner/applier/author/researcher/procedure) with a
per-persona tool budget (30/25/45/45/15/60 calls, `slice-orchestrator.ts:293-300`),
scoped permissions (decider seats lose shell+edit; researcher is fetch-only), a
two-axis allocation (`allocation.ts:204-303`): **difficulty routes the author**
(design → reasoner; hard/ambiguous floor → reasoner; else executor), **consequence
routes the verifier** (testable → sound rung; high coupling or risk>70 → judge rung).
Graph risk (fan-in/centrality, `bun-sqlite-graph.ts:590-605`) tightens *verification*,
never buys a bigger author.

**The escalation ladder** (`slice-loop.ts:1092-1337`) exists only inside slice dispatch:
squeeze (≤2 same-tier retries) → climb (at most ONE hop past the cheap tier) →
re-verify every hop → double-pay ledger (`double-pay.ts:89-106`). Turn-level routing
(`router.ts:154-226` — escalate >70 risk with hysteresis + abstention) survives only on
the demoted headless-runner path. **On an inline conductor turn, the only escalation
mechanisms are: the stuck ladder (test-edit conflict → one reasoner consult,
`prompt.ts:2823-2864`), the grind valve (~60-step stall → design pre-pass), and the
hub-design judge.** This is load-bearing for Part IV.

### I.3 Mid-loop supervision (fires between steps, each injects a nudge and continues)

In order (`prompt.ts:2039-2899`): probe-from-red pinning (a red test-shaped command
becomes the turn's binding contract; toothless `repro*` scripts refused, F15c
`:406-413`; a fidelity judge checks the pin against the issue once — gap → nudge, never
block) → S4 gate-block ledger (scans `[econ-gate] BLOCKED` errors) → S2 repro deadline
(12 steps to settle a repro, then abstention/handoff; armed turns then plant the
localization pre-pass) → drift nudges + F13d engine-pin (the engine itself runs
`repro_issue.*` when reds stay unpinnable) → S9 pinned-repro deletion guard → S8
converge-now (8 post-fix steps without a pin pre-arms the final finish denial) → stuck
ladder → hub-design nudge → batch-momentum nudge.

### I.4 Edit-time gate stack (inside edit/write, before the file mutates)

```
1. no-edits gate (turn constraint)
2. raw-task-child gate
3. NO-TEST-EDIT gate: armed && isTestFilePath && file exists → throw denial
   (edit.ts:121-127; write.ts:86). Bypass: NEW file (repro), explicit test-work ask.
   Denial text names the sanctioned out: "state the test is wrong in your answer".
4. HUB-EDIT bounce gate: first edit to a high-fan-in file bounces once with the
   root-most-layer message + named definition-site candidates; **an identical re-issue
   passes** ("If this hub file genuinely is the root-most layer, re-issue this exact
   edit and it will be allowed"). Defining sites are allowed outright
   (hub_edit_gate_defining_site_allow). 2nd distinct-file bounce → design pre-pass →
   synchronous hub-design judge verdict (wave-7).
5. CONVENTION-DIVERGENCE gate (wave-11): an edit calling an API variant the file has
   never used (e.g. datetime.now() in a file using utcnow()) pauses once, names the
   variant and the file's existing sites — **"an identical retry will be accepted"**
   (`prompts/nudges.ts` conventionDivergenceNudgeText).
6. callers-at-risk warning — appended AFTER the edit lands, non-blocking.
```

Both hatch sentences in 4 and 5 are deliberate anti-wedge design. Part III shows both
being used as the exit door on real failures.

### I.5 The finish path (agent declares done, no tool calls in its message)

```
1. finish=="length"      → continuation nudge ≤2, then loud error          (prompt.ts:2908-2940)
2. M4 pinned-probe gate  → run the pin; red → reject-nudge ("STILL FAILING … fix where
   behavior is DEFINED; do not edit the test") ×3 → then loud fail-open   (:2966-3020, :1043-1094)
   (armed turns also run TEST_TREE_GUARD: any modified test file → reject)
   [RF-8 sub-gate] green probe → re-read pinned repro on disk (not cache),
   detectTypeUnfaithfulRepro (numeric-string-conflict + stringified-mirror composite)
   → one bounded deny (:3345-3358) naming the conflict + loud pass-through
3. F18 seen-red          → any watched red in the transcript not re-run green (incl.
   exit-0 laundered pipes) → nudge once → loud pass                        (:3056-3110, seen-red.ts:149-171)
4. bug-shaped turns  [bugShaped = !verdictIsReadOnly(verdict) && (any diagnosis goal ||
   testEditGateArmed)]:  a READ-ONLY verdict (every goal qa/research/audit/run-only) is
   never bug-shaped, so this whole block stands down (P4b, 2026-07-15). Before that fix
   the `testEditGateArmed` disjunct made a pure Q&A bug-shaped — the no-test-edit gate
   arms on any turn that doesn't authorize test work, a question included — so S3 nudged
   an empty-finish question to "author a repro" ×3 and the conductor churned 31 inline
   steps / 17 reasoner escalations inventing verification for a fix never in scope.
   wave-10 ran-no-real-test deny (once per session, ever)                  (:3111-3167)
   S3 unverified-finish: no pin, or pin+zero source edits → nudge ≤3 → loud (:3176-3243)
5. F11/F16 regression gate: ≤3 neighbor suites (exact-twin → proximity → F17 module
   stems, round-robin across files, scratch-dir filtered); regressed → the failing
   neighbor REPLACES the pinned probe (F16 pin promotion, :3345-3358) + nudge once → loud
6. break — turn ends                                                        (:3401)
```

**The universal discipline**: every finish gate is *bounded-reject-then-fail-open-loud*
(a logged `*_unverified` / `*_unresolved` marker — never a wedge, never a silent pass);
env-red (missing file/module) never counts as a real red; child sessions bypass all
finish gates. Consequence: a gate can *pressure* but never *force* — and it also cannot
*route* (no gate outcome feeds the tier ladder). Both properties matter in Part IV.

### I.6 Budgets & caps (the ones that shape behavior)

| Cap | Value | Site |
|---|---|---|
| Aggregate per-step tool-result budget (water-fill trim) | 20,000 tok | `step-budget.ts:18` (sole owner — the tools.ts duplicate is **deleted**, comment `tools.ts:461-476`) |
| Per-result ceiling (edit/write/todo exempt) | 6,000 tok | `tools.ts:477-490` |
| Per-tool output truncation | 2,000 lines / 50 KB | `tool/truncate.ts:15-16` |
| Persona tool-call budgets | 30/25/45/45/15/60 | `slice-orchestrator.ts:293-300` (the "25-tool cap" = the runner persona; a folklore-free real constraint) |
| Slice attempts / climbs | 8 attempts, ≤1 climb, 2 same-tier retries | `slice-loop.ts:963-977, :1244` |
| Repro/finish step counters | pin deadline 12 · converge 8 · pin-green 3 · probe-gate retries 3 · unverified-finish 3 | `prompt.ts:270-288, :1801, :1812` |
| Shell timeouts | 120s default; regression gate 240s÷N; engine probe 120s | `slice-orchestrator.ts:343`, `prompt.ts:298-306` |
| Cost | **no hard $ cap** — cost governance is structural | — |

### I.7 Doc-vs-code corrections established while mapping

1. **Duplicate 20k step budget: resolved in code.** `tools.ts` aggregate guard deleted;
   `step-budget.ts` sole owner. (The memory/tracker item is stale.)
2. **P10 resolveAttempts: implemented.** `resetResolveAttempts` runs at fresh-turn open
   (`prompt.ts:3550-3564`); continuations deliberately don't reset. Tracker wording
   ("never resets") predates the fix.
3. **F4b scope-miss gate: no longer exists** — deleted with the E0 adaptive-gate
   removal; `tier-prompts.md:321,594` rows are stale.
4. **`[econ-gate] BLOCKED` provenance is unclear on the fleet.** The blocking
   `evaluateEdit` engine (`guardrail.ts:127-200`) has only test callers in the graph,
   yet 11815-A's fleet log shows 4 live BLOCKED denials (a false positive on a body-only
   edit). Consistent with the fleet-parity plugin trap (retired MVP `.opencode` plugins
   riding a stale toolbox image). **The pending `IMAGE=`-less fly re-run decides this.**

---

## Part II — The runs under analysis

Five runs of the same build, 2026-07-13. One green; four red, **no two red on the same
set**:

| Instance | 1859 (fleet) | 2058 (fleet) | x10-2107 (fleet) | round E (local) | green run |
|---|---|---|---|---|---|
| 11790 | ✅ | ✅ | ❌ | ✅ | ✅ |
| 11815 | ❌ | ✅ | ❌ | ❌ | ✅ |
| 11848 | ✅ | ❌ | ❌ | ✅ | ✅ |
| 11964 | ❌ | ❌ | ✅ | ✅ | ✅ |
| 12039 | ❌ | ✅ | ✅ | ❌ | ✅ |
| **score** | 7/10 | 8/10 | 7/10 | 8/10 | 10/10 |

(Round E is autopsied in [STRICT_CYCLE.md](./STRICT_CYCLE.md); this report autopsies the
three fleet bundles — 8 instance-failures — and folds round E into the synthesis.)

**The one stat that frames everything: all 8 fleet instance-failures ran 100%
conductor-inline — 0 slices dispatched, 0 tier escalations, in every single one.**
(11815: 74t/$0.37, 66t/$0.26 · 11848: 24t/$0.075, 16t/$0.036 · 11964: 73t/$0.27,
56t/$0.25 · 11790: 45t/$0.137 · 12039: 22t/$0.073.) Meanwhile the recorded passes of
the same instances include the full escalation chain (11964: $0.417, reasoner 28 +
oracle 4) and 4-slice decomposition (11815 round D). Cheap conductor-only passes exist
too — the point is not "escalation ⇒ pass"; it is that **when the cheap draw is wrong,
nothing in the current harness converts it** (I.2: on an inline turn the ladder is
unreachable except via stuck/grind/hub-judge, none of which fired).

---

## Part III — The eight autopsies

### III.1 django-11815 (enum serialized by value, not name) — failed 1859 + x10-2107

**The headline: both runs applied the gold-equivalent fix mid-run, and the harness's
own gate chain forced the retreat to the failing patch.** This is not the round-E
`%r`-quote face and not a convergence failure.

The trap circuit, identical in both runs:

1. The visible `tests/migrations/test_writer.py` assertions **encode the bug** — gold's
   test_patch rewrites them (`TextEnum('a-value')` → `TextEnum['A']`). Both hidden F2P
   tests use non-translated enums, so any patch gating name-serialization on
   "value is lazy" fails both.
2. The agent's repro drifted unpinnable (translation-only, green under both right and
   wrong patch) → **probe-from-red pinned the gold-inverted visible test** as the turn's
   binding oracle (`turn_probe_pinned_from_red`, redTail: actual = gold-correct
   `TextEnum['A']`, expected = the buggy `TextEnum('a-value')`).
3. Run A wrote the unconditional gold fix (E4) — the pinned probe went red →
   `MAX_PROBE_GATE_RETRIES` nudges: *"STILL FAILING … fix where the behavior is
   DEFINED; do not edit the test."*
4. A tried to correct the visible test to the gold expectation → **no-test-edit gate
   denied** (working exactly as designed).
5. Only reachable green: a `Promise`-conditional patch preserving buggy behavior for
   the visible cases. Both runs shipped exactly that (A: `repr(name)` hand-format;
   B: `serializer_factory(name)` — quoting differs, the Promise conditional kills both).

Run A **predicted the hidden gold test verbatim** before retreating: *"the grader's
test patch updates them to the new name-based form (`TextEnum['A']`,
`re.RegexFlag['DOTALL']`)"* — then pivoted: *"Gate blocked test edits. Pivoting to a
dual-mode fix…"*. Run B independently rationalized the same retreat as back-compat.

Mechanism variance that did occur was **outcome-inert**: the arming judge flipped on
identical input (A: "fix handed" → unarmed; B: "no location named" → armed); F18 fired
in A only; the `[econ-gate] BLOCKED: breaking signature change to Serializer` false
positive fired 4× in A, 0× in B (see I.7 item 4). Both runs also had the hub gate
bounce the *genuinely correct* file (`importers=4`) and `hub_design_degraded
reason=judge-degraded` (the judge chewed on the injected "ECONOMY CHECK" meta-prompt).

**Classification: (c) — a deterministic mechanism-design gap, not model variance.**
The oracle chain (pin-from-visible-red + pin-green pressure + no-test-edit deny) is
anti-correlated with resolution on any instance whose gold rewrites visible tests. The
*tests-are-spec* seed prior is exactly wrong for this class. Note the fail-open exists —
a maximally stubborn agent could eat 3 rejects and finish loud-red with the gold fix —
but the nudge text actively instructs the retreat, and a compliant conductor complies.

### III.2 django-11848 (parse_http_date two-digit year) — failed 2058 + x10-2107

**The known "boundary off-by-one" face is a misdiagnosis.** Both patches have
arithmetically correct RFC-7231 thresholds (verified in the official
`sweb.eval.x86_64.django_1776_django-11848` image; A's if/else and B's ternary are
exact logical negations — same condition). The sole killer, in both:
**`datetime.datetime.now()` instead of `utcnow()`.** Gold's hidden test mocks *only*
the `utcnow` seam; `.now()` returns a MagicMock → TypeError → swallowed by
`parse_http_date`'s `except Exception` → ValueError → every rfc850 subtest ERRORs.

The mechanism story is the sharpest gate-hatch evidence we have:

- The **wave-11 convention-divergence gate fired on the exact fatal token in both
  runs**: *"this edit calls `datetime.datetime.now(...)` — a method this file has never
  used — while the file already uses `datetime.datetime` at line(s) 188 … an identical
  retry will be accepted."*
- Run A answered import-existence instead of timezone semantics ("It's the same module
  already imported… The edit is correct — retry the same edit") — and had **explicitly
  deliberated `utcnow()` and rejected it 3×** in reasoning. Run B: *"The verification
  pause was a bit of a false alarm"*; zero occurrences of the string `utcnow` in its
  entire transcript.
- Nothing red was locally observable: pre-gold tests + both agents' own repros are
  green under this patch at real clock 2026 (A even did a proper pre-fix-red /
  post-fix-green repro cycle — arithmetically perfect, blind to the mock seam). B never
  got runtests running at all (`asgiref` missing in the env it chose), said so honestly,
  and the engine's advisory `turn_completed_unverified` changed nothing.

The same gate converted this exact class in rounds B, D, and E (deny→convert,
3-for-3 per STRICT_CYCLE) — so gate conversion is itself a coin flip: it works iff the
model's retry-draw happens to reconsider. The UTC evidence sits *inside the edited
function* (docstring "in UTC"; `calendar.timegm(result.utctimetuple())`).

**Classification: (c) systematic model prior (local-time default), surface-form
variance only.** Cross-run divergence point: step-1 tool choice (`pwd&&ls` vs
`find|head`) — pure sampling; both converge on the same file, same hunk, same wrong
token. Preventable without seeing the hidden test.

**Grader artifact (verified):** the second F2P, `test_parsing_year_less_than_70`,
actually **passes** at runtime — its verbose "ok" line gets glued into rfc850's
subTest-ERROR output line, and the log parser records absent ⇒ failing.

**Update (2026-07-14, strict full Mini-10 sweep):** this class re-surfaced red.
The agent wrote `datetime.datetime.now(tz=datetime.timezone.utc)` —
production-correct (same UTC year as `utcnow()`) — and the hidden test's
`utcnow`-only mock turned it into the same MagicMock→ValueError cascade. The
convention gate fired (`convention_divergence` + `_repeat`) but the agent
finished on the production-correct `now()` choice; it escalated hard (reasoner
×11, decomposition ×5, 68t) and still drew the wrong-for-the-mock token.
Confirms classification (c): a systematic prior on an *unobservable* test-mock
seam — the same meta-class as 11790 (the hidden test pins an internal detail
two equivalent choices differ on). **Not a regression** from the deferral/hub
wave (`82bd20d48`): 11848 has failed in sweeps predating it, and the wave only
*adds* arming (11848 escalated more, not less).

### III.3 django-11964 (Choices member leaks enum type) — failed 1859 + 2058

Same build previously passed this instance via the full escalation chain and (iter-6)
via a lucky right-layer draw. These two failures are the wrong-layer draws with the
safety net not firing:

- **A (1859)**: patched the **symptom layer** — `DeferredAttribute.__set__` coercion in
  `query_utils.py` — the exact face the root-most seed forbids. It *read* the prior and
  argued around it (*"the root-most behavior is actually about the FIELD attribute
  descriptor"*). Three engine own-goals compounded it:
  1. the hub gate bounced `query_utils.py` (`importers=25`) — then the **re-issue hatch
     let the same edit pass** (`hub_edit_gate_passed_on_retry`);
  2. the **hub-design judge hallucinated a wrong-instance verdict** — `Q.__invert__` /
     "apply De Morgan's laws", content from a different bug entirely — and named the
     bounced hub file itself as the root-most site, converting containment into
     endorsement;
  3. the agent's pinned repro ran the **wrong python** (base conda py3.11, not
     `envs/testbed` py3.6) → a phantom `ChoicesMeta boundary` TypeError → the probe
     gate's honest "fix where the behavior is DEFINED" nudge drove it to "fix" the
     environment artifact (`**kwds` forwarding) and label it root-most.
- **B (2058)**: chose the **right file** (`enums.py`, from parametric recall of the
  upstream fix) but implemented `__str__ = str.__str__(self)` on the two subclasses
  instead of gold's `str(self.value)` on the `Choices` base → TypeError on every
  IntegerChoices member. Its verification probe defined an IntegerChoices in the
  heredoc **but only ever called `str()` on the TextChoices member** — the int path was
  never exercised. One token from gold; agent-visible green throughout.

Both runs: triage/arming/seeds byte-identical to each other (and to the pass);
`repro_unresolved`, `unpinnable-red`, `stuck_rethink excessive-reread count=5` fired in
both; **escalation chain: 0 in both** (the only non-conductor call in either log is the
title agent, which errored).

**Classification: (a) input-identical stochastic fork** (hypothesis commitment: A locks
"assignment path must coerce"; B locks "recall the maintainer's fix") **compounded by
(b) mechanism own-goals** (judge hallucination, re-issue hatch, wrong-python pin) with
**(c) residue** in B (right site, under-verified one-token implementation).

**Grader artifact (verified against the gold parquet):** `test_textchoices` is a
line-gluing artifact — gold adds only `test_str`; one working `__str__` flips both F2P.

### III.4 django-11790 (AuthenticationForm maxlength) — failed x10-2107

The one-token loss: `widget.attrs['maxlength'] = str(field.max_length)` — gold assigns
the **int**. Location, mechanism, fallback all correct; hidden tests assert typed
equality (`'254' != 254`).

What makes this the cleanest variance specimen:

- **Every mechanism behaved identically to the passing round.** Armed, seeds planted
  verbatim (confirmed in `opencode.db`: the localization todo carries the full
  mirrored-entry prior — "254, not '254'"), hub gate allowed the defining site, repro
  pinned red→green, regression green, clean finish.
- **The seed itself contains a clause conflict for exactly this instance**: idiom-mirror
  ("never add coercions the neighboring code does not use") *licenses* `str()` — Django's
  own `CharField.widget_attrs` genuinely stringifies, and the model's reasoning anchored
  on that 9 times — while typed-mirror forbids it. The passing round drew clause B; this
  round drew clause A. A weighted coin, loaded by real in-repo evidence.
- **The one instrument that could have converted the fork was disarmed**: the repro
  asserted a rendered-output substring (`'maxlength="254"' in html`) — green under both
  int and str — in direct violation of the repro seed's point (2) ("assert API-LEVEL
  values … NOT rendered output"), and the fidelity judge passed it (`repro_fidelity_ok`).
  A typed API assert would have gone red on this patch and self-corrected the run.

**Classification: (a) input-identical stochastic fork**, aggravated by seed-internal
conflict and fidelity-judge under-enforcement.

**Update (2026-07-14, 5-attempt strict fresh-arena re-fire hunt, binary
`388cf3255`):** 11790 is **5/5** across this band — cost spread
$0.033–$0.632, splitting cleanly into cheap conductor-only draws ($0.033,
$0.059, $0.063 · 14–26 turns) and reasoner-escalated hard draws ($0.526,
$0.632 · 78–95 turns, 31–42 of them above conductor). The stochastic fork
this autopsy describes still recurs — cost, not correctness, is what varies
on the hard draws now — but on the conductor-only evasion draw (attempt 5),
the RF-8 finish-time re-check fired (`fidelity_finish_reject`, decision
`convert`) and converted a false-green finish into a real pass: the first
live conversion of this mechanism. Total band cost $1.3128, 0 double-pay.
Full per-attempt breakdown: [STRICT_CYCLE.md](./STRICT_CYCLE.md).

**Further update (2026-07-14, strict full Mini-10 sweep, binary `82bd20d48`):**
11790 drew the *conditional* pinned form — chain aliased to a bare local
(`widget_maxlength = widget.attrs.get(...)`), compared behind
`if widget_maxlength != str(expected):` gating `errors.append` — the one shape
`388cf3255`'s assert-only str-alias tooth cannot see, and it went red. Commit
`33245816e` extends `detectStringifiedMirrorAssert` to `if`/`elif` gates +
symmetric chain-side aliasing (unit 97/97), closing this last assert-dodge;
live re-validation on the rebuilt binary pending. This sharpens the autopsy's
core: 11790's *repro form* is what varies draw-to-draw, and each new
assert-dodge shape needs the deterministic tooth to follow it. The failing
draw was `armLocalization=true` and carried the explicit typed-mirror prior
(`254` not `'254'`; "never via a rendering helper that stringifies
internally") — and the model wrote the stringifying helper anyway. Direct
confirmation (see Part VI) that on this class the prompt is not the lever; the
check-time tooth is.

### III.5 django-12039 (CREATE INDEX whitespace) — failed 1859

Not the "no witness possible" face this time — **the red was produced and misread**:

- The agent **derived the complete two-class diagnosis in its own reasoning** ("there's
  a related issue in the `Columns` class — it concatenates suffixes without a space …
  `"name"DESC`") — then discarded half of it, unforced: *"Actually the user might have
  been wrong about the current state."* It patched only `IndexColumns.__str__`
  (the opclass trailing-space face) and never touched `Columns` — despite the issue's
  *lead example* being the DESC case and the issue's own permalink pointing at
  `ddl_references.py#L87`, inside `Columns`. The arming judge's evidence string even
  cites that L87 permalink.
- Its own repro then **printed the exact red the hidden test asserts**
  (`parent desc -> '"name"DESC'`) — and the agent scored it as *pass* because the frame
  was print-and-eyeball with a non-regression mindset ("the parent `Columns` class
  output is unchanged" — unchanged *was the bug*).
- The engine fired every right advisory signal — `turn_probe_pin_miss specificity:0`,
  `repro_unresolved`, `repro_drift kind=unpinnable-red`, `turn_converge_nudge`,
  terminal `turn_completed_unverified hadPin=false landedSourceEdits=true` — and
  nothing blocks or re-routes a completed-unverified finish with landed source edits.
- The regression gate is structurally green here: the failing F2P exists only post-gold.
  But unlike the opclass half (postgres-only), the DESC face **is witnessable in-arena**:
  `Index(fields=['-name']).create_sql()` on sqlite renders `"name"DESC` through the base
  editor. One assert lifted from the issue's "expected" block would have gone red.

**Classification: (a) one unforced reasoning fork with all facts in hand, shipping
through (b) warnings-without-teeth**, on top of the recurring (c) sibling-propagation
face (round E's red was the same class from a different angle: right-layer partial fix
+ a phantom sqlite PRAGMA layer).

---

## Part IV — Synthesis: where the variance actually lives

### IV.1 The failure classes, tabulated

| Instance | Fork point | Class | Deterministic signal that existed and was not used |
|---|---|---|---|
| 11815 ×2 | none — gate-forced, both runs | **(c) oracle inversion** (harness) | agent's own statement that gold rewrites the visible tests (A); issue's stated desired output contradicting the pinned red's expectation |
| 11848 ×2 | step-1 sampling; same wrong token both | **(c) systematic prior** (`now()` default) | in-function UTC evidence (docstring, `utctimetuple`); the convention gate's own finding |
| 11964 A | hypothesis commitment (~step 47) | (a) + (b) own-goals | root-most seed (read, argued around); hub bounce (hatched); 25-importer fan-in |
| 11964 B | hypothesis commitment (recall route) | (a) + (c) one-token impl | its own heredoc defined the int case and never called it |
| 11790 | seed clause conflict (str vs int) | (a) weighted coin | typed-mirror seed line; repro-seed point (2) requiring typed API asserts |
| 12039 | one reasoning step (~t+115s) | (a) unforced discard | issue lead example + L87 permalink + its own repro's printed red |

Round E's two reds slot in: 11815-E = (a) decomposition-arming flip (D: 4 slices/pass,
E: 0 slices/fail, same binary) + the `%r` quote face; 12039-E = (c) sibling-propagation
with no in-arena witness.

### IV.2 The six entry points of run-to-run variance

1. **Hypothesis commitment without a second draw.** The conductor locks its first causal
   story (11964 A vs B chose *different wrong layers*; 12039 discarded half its own
   correct diagnosis). No best-of-N, no devil's-advocate re-derive on the hard tail.
2. **Judge/extractor reads on identical input.** The arming judge flipped on 11815
   (inert), and the docs record turn-read goalCount flakes. Facts-extraction is
   temp-0 but MoE serving still jitters (ORCHESTRATION_IMPROVEMENTS principle 5).
3. **Seed-internal conflicts resolved stochastically.** 11790's idiom-mirror vs
   typed-mirror. A prior that argues both sides is a coin, not a constraint.
4. **Gate escape hatches taken or not.** The convention gate converted this exact class
   3-for-3 in rounds B/D/E and 0-for-2 here — conversion depends on the retry-draw,
   because "an identical retry will be accepted" invites re-assertion. Same for the hub
   gate's re-issue hatch (11964-A walked through it).
5. **Environment slips.** Wrong-python repro (11964-A) manufactured a phantom root
   cause; missing deps (11848-B) silently deleted the verification stage.
6. **Provider-day/MoE nondeterminism** (documented: cache-prefix eviction days,
   flip-flop set rotation) — the substrate under all of the above.

### IV.3 What the mechanisms did right — and the three anti-patterns

Right: zero false fires across all **finish** gates in all 8 reds; every advisory signal
that should have fired did fire (`repro_unresolved` 6/8, `unpinnable-red` 4/8,
`turn_completed_unverified` 3/8, hub bounces on every hub edit); the no-test-edit gate
held under direct pressure twice; arming/triage classified consistently.

The three anti-patterns:

1. **Oracle inversion** (11815): the pin-from-visible-red + pin-green pressure +
   no-test-edit deny circuit *rejects the gold fix* whenever gold rewrites visible
   tests. The harness's strongest enforcement loop points backwards on this class.
2. **Polite hatches on hard gates** (11848, 11964-A): a gate that names the exact bug
   and then accepts an identical retry is an advisory with extra steps. The strict-cycle
   record already proved advisory text never steers the cheap conductor (4
   confirmations); the hatch re-converts hard gates into advisories precisely on the
   turns where the model is confidently wrong.
3. **Warnings without teeth, and without routing** (12039, 11848-B): terminal
   `turn_completed_unverified` with landed source edits neither blocks once nor feeds
   the router. Meanwhile **0 of 8 reds ever reached any escalation mechanism** — the
   ladder exists only inside slice dispatch (I.2), and the exact signals that define the
   hard tail (denied finishes, unresolved repro, hub bounces, seen-red) are never
   consumed as routing evidence. This is the calibrated-deferral gap: the harness
   already *produces* the deferral signal and throws it away.

**A fourth anti-pattern, off the fix-turn axis — over-work on read-only turns
(2026-07-15, FIXED).** The eight reds are all fix tasks; a separate finding came from
the capability probes: the fix machinery armed *globally*, so a pure question ("where is
`resolve_redirects` and what does it do?") decomposed its own mid-turn todos into tiered
reasoner/oracle slices, authored an unrelated repro script, and edited a test file
before answering. Root cause: a `qa` verdict stood the repro/localization doors down
(via `decideArming`) but left `degraded` unset, so the orchestration hook still
decomposed. A live probe surfaced a second, subtler leak: the S3 finish gate is guarded
by `bugShaped`, whose `testEditGateArmed` disjunct (the no-test-edit gate arms on any
turn not authorizing test work — a question included) made the Q&A bug-shaped, so after
answering it was nudged ×3 to "author a repro" and churned 31 inline steps / 17 reasoner
escalations. Fix, three coordinated parts (I.1 §2, I.5): (1) a high-confidence
all-read-only verdict arms `degraded:true`, holding the conductor inline (no
decomposition); (2) `bugShaped` short-circuits to false on a read-only verdict, so no
finish gate fires; (3) the `READ_ONLY_PLAYBOOK` preamble steers the conductor to
answer-and-stop. Post-fix the same Q&A ran **3 conductor steps at $0.0056** (from 31
turns / $0.17 — ~30× cheaper), answered correctly, touched no file; a compound "explain
X and fix Y" probe kept the full harness (repro + localization seeds, orchestration
engaged). This is the "arm as-needed, not on every turn" correction the round-F review
called for, on a different axis than the deferral gap.

### IV.4 Mapping to the countermeasure literature

| Observed class | Countermeasure (evidence) | Fit |
|---|---|---|
| 12039 print-vs-assert; 11790 rendered-assert | **Check-time ground-truth enforcement** (ReVeal 11.76% vs 8.97%, arXiv:2506.11442; ts-repair, PLDI 2025) | The M4/F11 family is right in spirit; the ground truth must be *typed-assert-shaped*, judge-enforced — not printed output eyeballed by the model |
| 12039/11815-E sibling misses; 11964 layer draws | **Seeded location/co-change priors** (CloneRipples 83.1%P/81.2%R, arXiv:2504.18511; +21–30% localization, arXiv:2404.11595) | Enumerate-then-apply: list every sibling class rendering the construct *as a checklist*, don't ask the model to remember; the failure-taxonomy trigger for this has now fired |
| 0-escalations-in-8-reds | **Calibrated deferral** (UCCI 31% cost cut, arXiv:2605.18796) | The deferral signal already exists as gate outcomes — deterministic, better than logprobs, free. Consume it. |
| Hatch-defeated gates | **Negative constraints beat guidance** (+20pp, arXiv:2604.11088) | Confirmed in our own record 4×; the hatches are positive-guidance leaks inside negative gates |
| Hub-design judge hallucination (11964-A) | **Small-judge failure modes** (52pp self-preference, arXiv:2410.21819; 13–85pp position, ACL'24) | The standing rule ("no new in-loop cheap judges; enforcement must be ground-truth-grounded or enumerative") is re-confirmed by a live specimen |
| 11848 `now()` prior; 11790 str() | **Domain priors as negative constraints** | One-sentence seed lines with *stated precedence* — the wave-4 UTC arc already proved the mechanism (4 fails → ✅✅) |

**The mini-swe-agent contrast, updated.** Post-E0 the engine no longer suppresses
reasoning — the residual gap vs the thin pipe is *not* suppression. It is: (1) oracle
misalignment the thin pipe doesn't have (it never pins a visible test as a binding
contract), (2) single-draw hypothesis commitment (both harnesses share this; only
best-of-N addresses it), (3) hatch-weakened gates (the thin pipe has no gates to
weaken), (4) produced-but-unconsumed deferral signals (the thin pipe has none — we do,
which is the actual structural advantage available to us, per rule 7 of the strict
cycle: improve the orchestration, don't amputate it).

---

## Part V — What to fix, ranked (round-F input)

1. **Consume the hard-tail signal: deterministic escalation/decomposition arming on
   finish-gate bounce.** A denied finish (M4 reject, S3, wave-10, F11 regressed, F18)
   or a 2nd hub bounce IS the risk-router's hard-tail signal — currently discarded.
   Evidence: 8/8 reds at 0 escalations; 11815 D-vs-E (slices pass, no-slices fail).
   *This was round-F candidate #1 before these bundles; it is now the strongest-
   evidenced item on the board.*
2. **Fix the oracle-inversion trap (11815 class).** When the pinned red's *expected*
   value contradicts the issue's stated desired output (both runs had this string
   evidence in the redTail), the pin must not bind as green-required — allowed
   resolutions: loud-red finish with a stated visible-test-encodes-bug verdict, or
   escalation (item 1), never "make the buggy assertion pass." The *tests-are-spec*
   seed needs the same carve-out sentence.
3. **Close the hatches with evidence requirements, P5 degrade reach + mechanical extraction (2026-07-14, IMPLEMENTED).** Convention gate: for time/tz (and similar semantic families), an identical retry is accepted only with cited in-file evidence (existing `utcnow` sites, docstring domain) — otherwise require the variant switch. Hub gate: re-issue must name why the bounced file is the defining site (quote the definition), not merely repeat the edit. (11848 ×2, 11964-A.) **New in round F:** P5 turn-read-degrade branch (null LLM verdict) no longer stands down mechanical extractors — literals + thresholds still extracted from raw issue text, preamble lines still planted (verbatim quotes are facts not guesses). `extractScriptPath` (repro-drift.ts) replaces basename extraction, honoring absolute /var/folders/… paths round-F 11848 encountered. Thresholds stored via `setIssueThresholds`/`getIssueThresholds` (turn-read-store.ts), quotes threaded as statedRules. New ISSUE-STATED RULES (binding) preamble: assert BOTH sides of each stated boundary. All three are converts, never blocks.
4. **Give the repro-fidelity judge teeth on assert shape — RF-4 deterministic tooth (2026-07-14, IMPLEMENTED).** Enforce the seed's own point (2): typed API-level asserts, refuse print-only and rendered-output probes (11790, 12039). New `detectStringifiedMirrorAssert` fires when an assert's expected side stringifies the value under test (`== str(x)`), chained 4th in the verdict chain (after assertion-teeth, rendered-assert, required-literals). Does NOT fire on subject-stringify, membership asserts, non-assert lines. Turns 12039's printed red into a binding red. Also: `RunReproFidelityJudgeInput.statedRules?: readonly string[]` renders a "Stated boundary rules" rubric (byte-identical prompt when absent). Both are converts (gap/nudge), never blocks. **RF-8 finish-time re-check (2026-07-14, IMPLEMENTED):** RF-4's one-shot pin-time judgment alone could not convert 11790's fork because the agent rewrote the pinned repro between judgment and finish, from typed asserts into if/append form, dodging every assert-anchored detector. RF-8 adds a bounded content re-check at M4 green finish (lines 3345–3358 prompt.ts): read the on-disk repro current state, run `detectTypeUnfaithfulRepro` composite (numeric-string-conflict + stringified-mirror, the high-precision subset), and on hit, deny once with nudge naming the conflict line + demanding typed equality. High-precision audit (5 of 7 round-F runs logged fidelity gaps, none were numeric-string/mirror) ensures zero false-fire on rendered-tooth or LLM-judge gaps. **Live-validated 2026-07-14** (5-attempt strict fresh-arena re-fire hunt, binary `388cf3255`): 5/5 REAL PASS, RF-8 finish-re-check fired + converted on attempt 5 (honest attribution: via the pre-existing numeric-string-conflict half of the composite, not the same-day one-hop `str()`-alias extension in `388cf3255` — see [STRICT_CYCLE.md](./STRICT_CYCLE.md)).
5. **Seed precedence + the two cheap priors.** One sentence: *typed-mirror overrides
   idiom-mirror even when a neighboring helper stringifies* (11790). Plus the `%r`/repr
   line (round-E 11815 face; near-zero cost) and the sibling-propagation enumeration
   prior for same-construct renderers (12039 — its taxonomy trigger has fired).
   Note: the %r line would NOT have saved the 0713 11815 runs (the Promise conditional
   was the cause) — items 1–2 own that class.
6. **Interpreter discipline for agent-run repros.** The engine already discovers the
   right interpreter for the regression gate (F14a); the agent's pinned probe doesn't
   use it. Wrong-python manufactured 11964-A's phantom bug; missing deps silently
   gutted 11848-B's verification.
7. **Hub-design judge sanity floor** (existing tasks #23/#24) + a hallucination guard:
   a verdict must quote tokens present in the turn's issue text; 11964-A's
   `Q.__invert__`/De Morgan verdict would fail that check trivially.
8. **Run the fleet-parity validation** (pending): re-run without `IMAGE=` to confirm
   plugin retirement; the 11815-A `[econ-gate] BLOCKED` false positives are the live
   suspect (I.7 item 4).
9. **Record the grader artifacts** in SWE_BENCH_TRACKER: subTest line-gluing marks
   `test_parsing_year_less_than_70` (11848) and `test_textchoices` (11964) as failing
   when they pass — both instances are single-defect, and past "boundary off-by-one"
   readings of 11848 were this artifact.
10. **Best-of-N stays the general answer for pure hypothesis-commitment forks**
    (11964 layer draw, 12039 half-diagnosis discard) — E1-gated as agreed; items 1–4
    are the deterministic subset that doesn't wait for it.
11. **Shape-gate the fix machinery by the turn-read verdict — read-only turns stand
    down (2026-07-15, IMPLEMENTED + live-validated).** The harness armed globally; a
    read-only turn (every goal qa/research/audit/run-only, high confidence) now stands
    down on three seams: (a) `degraded:true` arming holds the conductor inline instead
    of decomposing a question into fix slices; (b) `bugShaped` short-circuits to false
    on a read-only verdict, so the S3/wave-10 finish gates never nudge an empty-finish
    question to "author a repro" (the `testEditGateArmed` disjunct had made a plain Q&A
    bug-shaped); (c) the `READ_ONLY_PLAYBOOK` preamble steers answer-and-stop.
    `verdictIsReadOnly` (arming-judge.ts) is the shared lever; the deterministic
    `nonFixQaShortCircuit` (turn-triage.ts) is its zero-LLM fast-path. A compound turn
    with any diagnosis/build/refactor goal is NOT read-only → full harness (verified: a
    compound probe planted repro + localization seeds and engaged orchestration).
    Live-validated: the same "where is resolve_redirects" Q&A went 31 turns / 17 reasoner
    / $0.17 → **3 conductor steps / $0.0056**, correct answer, zero files touched. It
    leaves every fix-turn gate that guards on landed edits untouched (F18 seen-red,
    F11/F16 regression fire only on real source edits, which a stood-down read-only turn
    never lands), so the 8-red analysis above is unaffected.

---

## Part VI — post-forensic addendum (2026-07-14): the web-format-default stringification class

**Trigger.** A round-G strict re-run of 11790 on binary `82bd20d48` failed again
(`failures=2`, 48 turns, $0.15) on a face the round-G deferral arming does not
cover. The autopsy sharpened the III.4 "weighted coin" into a *systematic* cause,
directed by the user: the conductor defaults to the **web / rendered / string
representation of a typed value**, because that is its prime training format. On
11790 it re-applied Django's `widget_attrs()` (which returns `{'maxlength':
str(max_length)}` — a **string**) so the widget attr became `'254'`; the hidden
test asserts the **int** `254`. Same root as 12039 (rendered SQL over the typed
construct) and as 11790's own repro (rendered-HTML asserts over typed values).

**The class, stated precisely.** It is NOT literal HTML/markdown in the emitted
code — `'254'` contains zero HTML characters, and `attrs['maxlength'] = '254'`
raises no `TypeError` and passes `mypy` (Python dicts accept either type). It is a
**semantic type-fidelity miss**: the model collapses a value to its rendered/string
form where the API keeps it typed until render. This is why neither an
HTML-character scanner nor a generic type-checker fires — only a *typed-equality*
oracle (the hidden test, or the agent's own repro if it asserts typed equality
against the value's natural source) distinguishes `254` from `'254'`.

**Literature (2026-07-14 research pass).**
- Typed↔stringified is a documented failure mode: "Conversion Error… incorrect
  handling of int→float, string→int" and "string-valued state failures are
  disproportionately present… syntactically well-formed but semantically
  incorrect" — arXiv:2512.00215 (53–343 conversion errors per benchmark on
  HumanEval+/LiveCodeBench). Confirms the class is systematic, not variance.
- Every "no markdown / return raw code" system-prompt line real agents ship
  (Cursor, Aider, SWE-agent parsers) targets **output wrapping** (fences/XML), a
  *different* problem from **value fidelity**. No surveyed agent (Cursor, Aider,
  SWE-agent, OpenHands, Cline, Continue, Claude Code) uses a system prompt for
  typed-value fidelity.
- **Negative constraints backfire** ("Pink Elephant": naming the forbidden token
  primes it; positive framing wins) — so "NEVER stringify / do not use HTML"
  is the wrong wording. eval.16x.engineer / arXiv:2603.16417.
- The **write tool is not the lever**: models hallucinate wrong-typed args inside
  structured write/edit tools regardless of schema (lucumr.pocoo.org
  "Better Models: Worse Tools"). A "code-only write" primitive does not address it.
- The strongest lever per the literature is a **check-time detector + corrective
  feedback** ("check-time > decode-time"), aligning with our existing repro-fidelity
  direction and the cheap-judgment finding (isotonic deferral / check-time type
  enforcement).

**Mechanism decision (ranked; primary is check-time, per the evidence).**
1. **PRIMARY — widen the check-time typed-fidelity detector to the conditional
   form.** RF-4/RF-8's `detectTypeUnfaithfulRepro` is **assert-anchored**
   (`assert`/`assertEqual` lines only). 11790's repro gates its error list with
   `if widget_maxlength != str(expected_maxlength): errors.append(...)` — a
   conditional-comparison with the value aliased to a plain local
   (`widget_maxlength = widget.attrs.get(...)`), which dodges every assert-anchored
   detector. Extend the stringified-mirror / numeric-string teeth to scan
   `if A (==|!=) B` comparisons AND to follow one hop of **value** aliasing
   (symmetric to the `str()`-alias hop added in `388cf3255`), preserving the
   asymmetric guard (one side `str(...)`/alias, other side an attr/subscript chain
   or its alias) so legit `__str__`/string-typed comparisons stay silent. This is
   the third surface of the stringified-mirror misconception, after inline-assert
   and one-hop str()-alias.
2. **SECONDARY — a positively-framed, syntax-aware discipline line in the base
   preamble** (applies to every code-writing turn, not just diagnosis): *emit each
   value in the target file's native type; a value whose source is typed carries
   that type through — don't collapse it to its rendered/string form.* Cheap,
   positive (avoids the Pink-Elephant trap), reinforces the existing typed-mirror
   seed prior. A reinforcement, not the primary lever.
3. **REJECTED** — negative "no HTML / never stringify" wording (backfires); a
   blanket HTML/markdown-character detector (finds nothing on this class and
   over-blocks legitimate HTML/JSX/template code); a code-only write primitive
   (not the lever).

**Status:** documented; implementation deferred to the post-sweep rebuild so the
binary rebuilds once, then re-validated against 11790's class.

---

## Appendix — bundle paths

```
unerr-benchmarks/e2e/distributed/failed-runs/
├── mini10ded-0713-1859/      django__django-{11815,11964,12039}
├── mini10ded-0713-2058/      django__django-{11848,11964}
└── mini10ded-x10-0713-2107/  django__django-{11790,11815,11848}
```

Each: `report.json`, `model_patch.diff`, `events.jsonl`, `engine.log` (≡ `err.txt`),
`opencode.db`, `INDEX.md`/`WHY_FAILED.txt`.
