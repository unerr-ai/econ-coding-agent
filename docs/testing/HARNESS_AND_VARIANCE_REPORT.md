# The econ harness — mechanism walkthrough + the 2026-07-13 variance forensics

**What this is.** One report, three forensic layers on one code map. Part I is a
plain-language, code-grounded walkthrough of the harness as it exists today — every
mechanism, its trigger condition (if/else), and its exception/fallback path, each with
`file:line` anchors. Parts II–V are the forensic analysis of the 2026-07-13 benchmark
runs: five runs of the same build, one all-green, four with failures at *different*
failure points — the stochastic-variance signature. Part VII is a second forensic axis:
the 2026-07-15 **turn-economy** analysis — not *did it solve*, but *what did it burn
getting there*. Part VIII is the third, and the deepest cut of the three: the escalation
**decision itself** is the cost distribution — the same binary flips between a $0.07 and
a $0.66 route on identical input. Every claim below is grounded in either the codebase
or a run bundle; nothing is inferred from memory.

**Code state.** Part I describes HEAD `784d6849c` **plus the turn-economy wave's six
surviving mechanisms**, committed as `5dc9a21a1` (docs `95ba1a982` — see Part VII.4.2's
per-mechanism verdicts for which six). The escalation-gate rewrite (Part VIII.5) is
**committed `247cf53b3` and VALIDATED** (two mini-10 rounds + a failed-pair rerun,
2026-07-15/16 — verdict in VIII.6). The seen-red env-block marker fix is `19c9659b0`
(activates a never-fired mechanism; validation rides the next benchmark run).

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
cascade-latch consumed?                 → held INLINE, once-only (⧗ :2240-2246)
fresh turn + sessionID:                                                        (:2145-2207)
  flagged = ambiguous OR hard
  if flagged → resolutionDecision (resolution-phase.ts:84-150):
      1b. ARMED turn (armLocalization):
            attempts==0 → resolve-first (plant localization pre-pass; NO slices)
            attempts≥1 → continue-inline (armed turns NEVER decompose;
                          grind valve is the only escalation)
      2b. DIRECT-FIRST VALVE (⧗ resolution-phase.ts:139-150) — all four required:
            attempts==0 && diagnosisLocationOrFixKnown && hardness!="hard"
            && writerSliceCount<=2  → continue-inline (one direct-fix window
            before decomposition; the issue already names the site or the fix)
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

**What a dispatched above-conductor slice receives and how long it may run** (⧗ both
new; Part VII.2 is the evidence). A first-hop reasoner/oracle slice
(`aboveConductorCheapHop` = `(tier=="reasoner"||tier=="oracle") && !escalated`,
`prompt.ts:5255-5262`) is handed a **compiled brief** — goals as verbatim issue quotes,
must-honor constraints, the pinned probe with its red tail + repro content, candidate fix
sites, sibling-slice digests (`buildAboveConductorSliceBrief`,
`slice-orchestrator.ts:2658-2699`) — **instead of** the full context block (repo primer +
whole digest ledger + parent task). Escalated hops and executor slices keep the old path
byte-identical. And `sliceStepBudget` (`slice-orchestrator.ts:372-375`) clamps those two
tiers to `ABOVE_CONDUCTOR_STEP_CAP = 12` (`:348`) — the clamp is applied **after** the P8
×1.5 design/hard/escalated lift, so **the cap always wins**. Together these encode one
rule: *an above-conductor slice is an adviser, not a second agent* — it should not
re-explore the repo from a cold context, and it should not tool-loop.

**The cascade latch** (⧗ `cascadeLatchBySession`, `slice-orchestrator.ts:2176`) is the
anti-retry-loop. It sets when an engaged cascade produces **zero accepted outcomes and at
least one dead one** (`state=="blocked"`, or `state=="unverified" && verdict.accepted==false`
— `:2426-2430`). On the next orchestration it is **deleted before it is read** (`:2242`,
so it can never fire twice), returns `{engaged:false}`, and injects one untyped
`[cascade-inline]` corrective todo naming the dead slice (`:2184-2189`). A cascade that
died wholesale means the decomposition was wrong; re-running it is the one move guaranteed
not to help.

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
block) → **⧗ identical-run dedupe** → S4 gate-block ledger (scans `[econ-gate] BLOCKED`
errors) → S2 repro deadline (12 steps to settle a repro, then abstention/handoff; armed
turns then plant the localization pre-pass) → drift nudges + F13d engine-pin (the engine
itself runs `repro_issue.*` when reds stay unpinnable) → S9 pinned-repro deletion guard →
S8 converge-now (8 post-fix steps without a pin pre-arms the final finish denial) → **⧗
post-green convergence** → stuck ladder → hub-design nudge → batch-momentum nudge.

Two ⧗ additions, both aimed at re-running rather than re-thinking (Part VII.2):

- **Identical-run dedupe** (`createRerunDedupeTracker`, `turn-supervisor.ts:367-404`;
  wired root-only at `prompt.ts:2128`). The same command returning byte-identical
  (normalized) output for the **3rd** time (`IDENTICAL_RUN_THRESHOLD = 3`, `:406`) with
  **no edit landed in between** carries zero new information → `probe_rerun_dedupe`, once
  per command. Any file edit clears every tracked run (`:378-381`) — after a real change,
  re-running is evidence again, so the tracker never argues against verifying a fix.
- **Post-green convergence** (`prompt.ts:2841-2859`). Pinned probe green **and** zero
  other unresolved reds → one finish-now nudge (`converge_post_green`), suppressing the
  stuck-ladder and batch-momentum nudges that would otherwise keep a *finished* turn
  hunting. It converts, never blocks.

**Pin release on an environment-blocked probe** (⧗ `prompt.ts:3456-3489`): when the
pinned probe's own red repeats an environment-shaped signature ≥2× (`isEnvBlockedSignature`
— an env marker, missing file, or missing module), the pin stops binding, emits
`probe_env_blocked`, and passes through with a state-the-gap nudge. This is the M4 mirror
of the F18c partition in I.5, and it exists because a probe the *arena* cannot pass is not
a fact about the patch (11880 burned 42 turns on one — VII.2).

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
   **⧗ Turn-level bounce memory** (`edit-governance.ts:367,374` — `hubEditTurnBounceCount`
   / `hubEditTurnSettled`; ladder at `:768-800`). The gate's per-session memory made every
   child session re-learn the same bounce from scratch, so one turn could bounce the same
   file N× across N sub-sessions (11815 did it 4×). Turn-scoped counters inherit across
   sessions (`inheritHubEditTurnBounceState`) and add two rungs **above** the existing
   ones — 2nd evidence-less bounce this turn → deny `repeat:true`
   (`hub_bounce_turn_repeat`); 3rd → dispatch the hub-design judge
   (`dispatchHubDesignJudge` DI param on `evaluateHubEditGate`) → judge endorses or
   degrades ⇒ **bounded fail-open allow loud** (`hub_gate_exhausted_allow`), judge names a
   different site ⇒ one `final:true` bounce naming it (`hub_bounce_judge_redirect`), after
   which the file is turn-settled. Call sites log all three in `tool/edit.ts:164,181,228`
   and `tool/write.ts:129,146,188`. **The engagement guard is the inertness proof**: turn
   rungs apply only when the session itself never bounced this file (`:762`) — every
   pre-existing per-session path stays byte-identical.
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
   partitioned TWICE before it binds: F18b `partitionSeenRedByInversion` (the 11815
   oracle-inversion carve-out, V.2) and ⧗ F18c `partitionSeenRedByEnvBlock`
   (seen-red.ts:281-306) — a red whose tail matches an env-blocked signature
   (`isEnvBlockedSignature`, :253-257: env marker | missing file | missing module) AND
   repeats ≥2× is sanctioned with `seen_red_env_blocked` + a state-the-gap nudge instead
   of F18's confirm-GREEN demand. **A red first seen BEFORE any edit landed
   (`sawEditBefore`) is sanctionable only on an explicit env-marker match, never on
   timing** — the same discipline as the inversion partition: the arena's gaps are
   written off, the patch's own reds never are.
4. bug-shaped turns  [bugShaped = !verdictIsReadOnly(verdict) && (any diagnosis goal ||
   testEditGateArmed)]:  a READ-ONLY verdict (every goal qa/research/audit/run-only) is
   never bug-shaped, so this whole block stands down (P4b, 2026-07-15). Before that fix
   the `testEditGateArmed` disjunct made a pure Q&A bug-shaped — the no-test-edit gate
   arms on any turn that doesn't authorize test work, a question included — so S3 nudged
   an empty-finish question to "author a repro" ×3 and the conductor churned 31 inline
   steps / 17 reasoner escalations inventing verification for a fix never in scope.
   wave-10 ran-no-real-test deny (once per session, ever)                  (:3111-3167)
   S3 unverified-finish: no pin, or pin+zero source edits → nudge ≤3 → loud (:3176-3243)
5. F11/F16 regression gate: ≤3 neighbor suites (F19 Django exact-twin → F17/proximity
   module stems → F20 graph-derived reach, round-robin across files, scratch-dir
   filtered); regressed → the failing neighbor REPLACES the pinned probe (F16 pin
   promotion, :3345-3358) + nudge once → loud    (regression-neighbors.ts, prompt.ts)
   F19 Django exact-twin (2026-07-13): for a Django repo, scans every
   `tests/<dir>/test_<stem>.py` for an exact filename hit on each touched file's
   stem and ranks it FIRST, ahead of F17's fuzzy `tests/<dir>` substring match —
   `regression-neighbors.ts` `collectFileNeighborCandidates` pass 0.
   **F20 graph-derived neighbor reach (2026-07-18, IMPLEMENTED, live re-fire
   pending).** Every rung above is filename/stem-shaped, so a fix whose blast
   radius flows through the call graph with zero filename overlap stayed
   invisible (shapely-2226 below). `collectGraphNeighborCandidates` walks reverse-
   call edges from the touched files' entities via the in-process BunSqliteGraph
   (2 bounded hops, tests-only at the far hop, `existsSync`-filtered); each file's
   novel candidates — not already findable by the filename rungs — slot in AFTER
   that file's Django exact twins and BEFORE its fuzzy hits, capped 2/file
   (`GRAPH_NOVEL_NEIGHBOR_CAP`), overall cap still 3. Gated by
   `ensureGraphReadyBounded` (5s budget); a cold/missing graph degrades to the
   filename rungs alone — never a false red. (`regression-neighbors.ts:472` +
   `prompt.ts:4076-4113`.)
   **F21 turn-harvested interpreter (2026-07-18, IMPLEMENTED, live re-fire
   pending).** F14a's interpreter probe strips `sys.path[0]` by design, so a
   Django-project package importable only from the repo root fails every
   candidate and the gate skips (linkding-995 below). `harvestTurnInterpreter`
   scans the turn's own bash executions (latest first) for a green, test-shaped,
   python-headed run and reuses its interpreter token BEFORE F14a's synthetic
   probe runs — observed-green evidence outranks a synthetic probe. Wired at both
   the M4 pinned-probe gate (`prompt.ts:3252-3266`) and this F11 gate site
   (`prompt.ts:4125-4139`); publishes `interpreter_harvested` (info → convert,
   `signal-bus.ts:40`) on a hit, falls through to F14a's probe on a miss.
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
| ⧗ Above-conductor step cap (reasoner/oracle slices) | **12** | `slice-orchestrator.ts:348`, applied `:372-375` **after** the P8 ×1.5 lift — the cap wins |
| ⧗ Identical-run dedupe threshold | 3 | `turn-supervisor.ts:406` (any edit resets) |
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

**CLOSED 2026-07-15 (commit `1270cbccd`, live-validated 2/2 across both trajectories).**
The fix is the three-seam pack in Part V item 2. Both 11815 failure trajectories now
convert to a general fix, each caught by the seam built for it, on a strict fresh-arena
re-fire (binary built from `1270cbccd`):
- **r1** ($0.39 / 67t) — the T2 read-first shape: repro-seed point (11) + repro-fidelity
  rubric (d) INPUT-CLASS BREADTH made the pinned repro assert a plain sibling enum, so the
  narrowing conditional patch left the pin **red** → M4 gate reject → the pre-existing
  `oracle_inversion` detector (RF-2) fired 5× and converted. Shipped `serializer.py` 3/3,
  real-graded **OK on all 46 tests** (incl. the hidden non-translated-enum F2P a Promise
  conditional fails).
- **r2** ($0.48 / 66t) — the T1 write-first shape: the general fix reddened the committed
  suite as a **seen-red**, and the new F18 partition (`partitionSeenRedByInversion`)
  detected the inversion (`seen_red_oracle_inverted` + 2× `SANCTIONED`
  + `turn_seen_red_inversion`), sanctioned it, and the keep-general-fix nudge held the fix
  general. Shipped `serializer.py` 5/3, real-graded **OK on all 46 tests**.

The T2 counter (DIAGNOSIS_PLAYBOOK, an additive diagnosis-turn preamble stating the
issue-is-spec / cause-not-symptom rule + the oracle-priority carve-out) rides every
diagnosis turn so the rule is in context before any stale test is read — it no longer
reaches armed turns only via the localization seed. All seams are always-on converts; none
blocks. Empty issue-literals sanctions nothing, so non-inversion instances see
byte-identical old F18 behavior (verified inert on 11790/11848/12039 — 0 oracle-inversion
telemetry).

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

1. **Oracle inversion** (11815) — *converted 2026-07-15, see V.2*: the pin-from-visible-red
   + pin-green pressure + no-test-edit deny circuit *rejected the gold fix* whenever gold
   rewrites visible tests. The harness's strongest enforcement loop pointed backwards on this
   class; the three-seam pack (`1270cbccd`) now sanctions the inversion red and keeps the fix
   general (live-validated 2/2, both trajectories).
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
2. **Fix the oracle-inversion trap (11815 class) — three-seam pack (2026-07-15, IMPLEMENTED + live-validated 2/2).**
   When the pinned red's *expected* value contradicts the issue's stated desired output, the
   pin must not bind as green-required — the allowed resolution is keep-the-general-fix +
   state-the-conflict, never "make the buggy assertion pass." Shipped as commit `1270cbccd`,
   three always-on convert seams (none blocks), each covering one leg of the trap:
   - **Part 1 — F18 seen-red partition (the T1 write-first leg).** `partitionSeenRedByInversion`
     (seen-red.ts) routes each unresolved finish-time red through `detectOracleInversion`: a
     committed-suite red whose tail shows the code producing the issue's desired form while the
     assertion still expects the buggy form is *sanctioned* — it gets a `seen_red_oracle_inverted`
     convert signal + a keep-general-fix nudge instead of F18's confirm-GREEN demand.
     `isTrackedSuiteCommand` excludes the agent's own `repro_issue.py` (an honest red).
     **Empty issue-literals sanctions nothing → byte-identical old F18 behavior** (the greens
     are structurally protected). Rung-2 form-class detection gates on `fromTrackedSuite`
     provenance.
   - **Part 2 — DIAGNOSIS_PLAYBOOK (the T2 read-first leg).** An additive preamble on every
     diagnosis-shaped turn (issue-is-spec / cause-not-symptom + the oracle-priority carve-out),
     so the rule is in context before a stale test is read — previously the carve-out reached
     armed turns only via the localization seed. The *tests-are-spec* seed itself keeps its
     existing EXCEPTION sentence.
   - **Part 3 — witness breadth.** Repro-seed point (11) + repro-fidelity rubric (d)
     INPUT-CLASS BREADTH: an issue narrating a general defect through one special input class
     must also assert a plain sibling, so a conditional patch leaves the pin red and the
     existing M4 `oracle_inversion` escape (RF-2) converts it.

   **Live-validated 2026-07-15** (strict fresh-arena re-fire, binary `1270cbccd`): 11815 **2/2**,
   r1 via Part 3 → M4 `oracle_inversion`, r2 via Part 1's new F18 partition — both shipped a
   general `serializer.py` fix, real-graded OK on all 46 tests incl. the hidden F2P (see III.1).
   Green guards 11790 ✅ / 12039 ✅ held with 0 oracle-inversion telemetry (seams inert on
   non-inversion instances); 11848's one fail was its documented `.now()/utcnow()` convention
   variance (III.2) — **confirmed by a 2/2 strict re-fire** (rf1/rf2 both shipped the correct
   `utcnow()` idiom and passed real-grade), with oracle-inversion seams provably inert
   (0 telemetry) across all three 11848 runs; the only signal fired was the pre-existing
   `convention_divergence` gate that owns this class.
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

## Part VII — the turn-economy forensics (2026-07-15): what econ burns, and why

Parts II–VI ask *did it solve*. This part asks *what did it burn getting there* — a
separate axis with its own failure classes. It opens with a correction, because the
investigation was provoked by a number that turned out to be false.

### VII.1 The false premise (and why the work still paid)

**The alarm:** on the mini-10, econ spent $2.47 against Opus's $3.12 — near cost parity,
despite econ's tiers pricing ~8× cheaper per token and running an 88–93% cache-hit rate.
If true, something in the harness was eating an order-of-magnitude price advantage.

**It was not true.** That Opus figure came from
`claude-off-mini10-verified-2026-07-03`, which **never stripped the future** (its runner
resets with `git checkout` + `reset --hard` + `clean`; every git ref and the reflog
survive, leaving the gold fix reachable via `git log --all`) and was **self-reported**,
never real-graded. Against the honest strict sweep — Opus **$9.03 / 225 turns / 10-10**,
real-graded, refs deleted and reflog expired — econ at ~$2.35–2.47 is **~3.8× cheaper**.
The parity alarm was an artifact. Full retirement note, the 2.8× turn-inflation
signature, and all cross-model numbers:
[ECON_VS_CLAUDE_MODELS.md](./ECON_VS_CLAUDE_MODELS.md) (which owns those facts; they are
not restated here).

**The lesson worth keeping** is procedural, and it is the strict-cycle's own rule pointed
at ourselves: *a reference run is a benchmark run.* Strip-the-future and real-grading are
not econ-only hygiene — an unstripped, self-reported baseline is not a baseline, and it
silently reframed a winning position as an emergency. Any future cross-agent comparison
gets the same gate before it is quoted.

**The work still paid**, because the internal waste it went looking for was real and is
independently measurable on econ's own runs (VII.2) — it just wasn't costing us *parity*.
Correct framing: this is **tail-trimming on a position we were already winning**, not a
rescue. That distinction sets the risk appetite — see VII.5.

### VII.2 Where econ's turns actually go

Measured on econ's own 2026-07-15 mini-10 receipts; nothing here depends on any Claude
comparison.

1. **The above-conductor tail is 48% of spend.** $1.18 of $2.47, concentrated in the four
   instances that dispatched reasoner/oracle slices (11815/11848/11880/11999) — which are
   exactly the four costliest. The mechanism (I.2): a delegated slice inherited the **full
   exploration burden** — fresh context, cold cache, 33–43 tool calls at near-frontier
   input price. We were paying a premium tier to re-derive what the conductor already knew.
2. **Verification redundancy.** 42–53 of 59–89 turns went to probe/regression loops;
   roughly **half of 60–72 repro runs were byte-identical re-runs** with no edit between
   them. 11880 spent **42 turns on a probe the arena cannot pass** ("GIS backend
   required" — an environment gap, not a defect in the patch).
3. **Blocked-cascade retries.** 11999 (100t/$0.61): an explorer slice timed out → all five
   slices blocked → **three full-cascade retries** + two 16-turn reasoner delegations + a
   21-turn oracle synthesis. The conductor had already named the fix site at step 1.
4. **Gate-bounce loops.** 11815 bounced the hub gate **4× on the same file** — the gate's
   memory was per-session, so every child session re-learned the same denial from scratch.

**Caching was never the problem.** 88–93% hit rate, ~$0.06/M on reads, per-turn context
~25–30k — comparable to Claude Code's own per-turn footprint. Cost is
`turns × context-per-turn`, and context grows *with* turns, so the bill is quadratic in
turn count. A 90% cache hit rate on 100 turns loses to no cache at all on 10. **Turn count
was the whole story**, which is why every mechanism below targets turns, not tokens.

### VII.3 The turn-economy wave (seven mechanisms) — ⧗ uncommitted

Each is always-on, no flags, and **inert by signature** — built so that a run not
exhibiting the pathology takes a byte-identical path, protecting the passing baseline.
Anchors and trigger predicates are in Part I; this is the intent map.

| # | Mechanism | Waste it targets | Part I |
|---|---|---|---|
| 1 | Brief-not-transcript dispatch | VII.2.1 — delegated slice re-explores from cold | I.2 |
| 2 | `ABOVE_CONDUCTOR_STEP_CAP = 12` | VII.2.1 — premium tier tool-loops like a 2nd agent | I.2 / I.6 |
| 3 | Cascade-failed inline latch | VII.2.3 — 3× re-decompose of a dead cascade | I.2 |
| 4 | Direct-first valve | VII.2.1 — decomposing a task whose site is already named | I.2 |
| 5 | Identical-run dedupe | VII.2.2 — byte-identical re-runs with no edit between | I.3 |
| 6 | Env-blocked writeoff (F18c + pin release) | VII.2.2 — 42 turns on an unpassable probe | I.3 / I.5 |
| 7 | Hub-gate turn bounce memory + judge | VII.2.4 — same file bounced 4× across child sessions | I.4 |

The unifying rule, and the one the wave is really testing: **an above-conductor slice is
an adviser, not a second agent** (1, 2); **a signal that carries no new information should
not cost a turn** (5, 6); and **a mechanism that has already failed wholesale should not
be re-run unchanged** (3, 4, 7).

### VII.4 Live-fire validation — IN FLIGHT, results mixed

Strict fresh-arena re-fire, binary built from the working tree; pathology set
(11999/11880/11815) + inertness guards (11790/12050); baselines are the 2026-07-15
receipts. **This section is provisional and must not be cited as a result until complete.**

| Instance | Baseline | Wave | Above-conductor turns | Verdict |
|---|---|---|---|---|
| 11999 | 100t / $0.6149 / PASS | **29t / $0.1831 / PASS** | 55 → **6** | **3.4× cheaper** — the thesis working |
| 11880 | 59t / $0.2364 / PASS | 135t / $0.7406 / PASS | 17 → **62** | +213% — *not* wave-caused (VII.4.1) |
| 11815 | 89t / $0.5075 / **FAIL** | 104t / $0.5345 / **PASS** | 27 → 28 | FAIL→PASS at flat cost — pre-existing `1270cbccd` seams |
| 11790 | 20t / $0.0531 / PASS | 36t / $0.1879 / PASS | 0 → 6 | +254% — escalated draw, inside its documented band |
| 12050 | 19t / $0.0267 / PASS | 72t / $0.3079 / PASS | 0 → **37** | **+1053% — wave-caused (VII.4.3)** |
| **total** | **287t / $1.4386 / 4-of-5** | **376t / $1.954 / 5-of-5** | 99 → 139 | **+31% turns, +36% cost, +1 solve** |

**The wave as a block is a cost regression** — the opposite of its purpose — while being a
correctness improvement (5/5 vs 4/5). Four of five instances escalated *more* than
baseline. The per-mechanism verdicts below are what matter; the block verdict is that it
does not ship as one.

**11999 is the thesis working.** Above-conductor turns collapsed 55 → 6 ($0.13 reasoner)
with no named signal firing — consistent, because the two mechanisms that own this shape
(brief, step cap) are silent structural changes, and the cascade latch correctly never
engaged on a run whose cascade never died.

#### VII.4.1 The 11880 autopsy — the regression is *not* wave-caused, and the real findings are worse

Three hypotheses were tested against both run logs; the two obvious ones are **wrong**,
and killing them is what exposed the real defects.

**Rejected — "the wave introduced an early-deferral boundary."** Both `s3-exhausted` and
`deferral_armed` exist at HEAD (`prompt.ts:3810`, `:3126`) and the wave diff touches
neither. This is pre-existing round-F deferral machinery (Part V item 1).

**Rejected — "the latch/valve insert an inline window then decompose anyway."** The
direct-first valve never fired (no `direct_first_inline` in either log). Both
`cascade_inline_latch` firings and the single `converge_post_green` occur **after** the
cascade was already running (log lines >1133, vs the deferral at line 707). **No wave
mechanism touched the root conductor before the divergence point.**

**What actually happened — a route fork, model-driven.** Both runs defer exactly once;
they differ in *which signal* trips it and *when*:

| | Baseline | Wave |
|---|---|---|
| Deferral trigger | `probe_gate_exhausted` (line 1461, late) | `unverified_finish` rung=`s3-exhausted` (line 707, **step 26**) |
| Conductor steps inline first | 42 | 26 |
| Above-conductor turns | 17 | **62** (6 judge rungs: reasoner→reasoner→reasoner→oracle→oracle→oracle) |
| `unverified_finish` count | 2 (both `convert`) | 3 → exhausted |

The wave run declared an unverified finish a third time; the baseline only ever did twice,
so it never exhausted S3's bounded rejects. **That is root-conductor sampling variance in
finish-declaration timing** — not a mechanism change. Given III.4's documented ~19× cost
spread on a *fixed* binary (11790: $0.033–$0.632 over five runs), one draw cannot
distinguish this from noise, and the burden of proof is on anyone claiming otherwise.

**Real finding 1 — the deferral cascade is a cost cliff that bought nothing here.** Once
tripped, the escalation ran six judge rungs, every one logging `rungReason="judge rung
failed"`, climbing reasoner→oracle, ending in two `mixedOutcomes=true` syntheses: **62
above-conductor turns, +$0.50**. And both runs shipped the **byte-identical one-line
patch** (`result.error_messages = copy.deepcopy(self.error_messages, memo)` in
`django/forms/fields.py`), both real-graded OK. The cascade re-derived a fix the conductor
had already written. Round-F item 1 — "consume the hard-tail signal", called *the
strongest-evidenced item on the board* — is here observed **paying ~10× inline retry for
zero patch delta**. Worse, the escalation was chasing a verification that was
*environmentally impossible*: its own gate evidence reads "no reproduction was ever pinned
despite landed source edits", and every judge rung failed for want of a green pin the arena
could not produce. This is a **fifth** entry for Part IV.3's anti-pattern list, and the
first one found on the cost axis: **a deferral that cannot terminate, because it escalates
toward evidence the environment cannot supply.** Note the irony against IV.3's third
anti-pattern ("warnings without teeth, and without routing"): we gave the signal teeth and
routing, and the tooth closed on an environment gap.

**Real finding 2 — mechanism 6 has never fired on the instance it was built for, because
its regex does not match its own motivating case.** `ENV_BLOCKED_MARKER_RE`
(`seen-red.ts:250`) is `/backend required|ImproperlyConfigured|command not found/i`. The
actual arena text is:

```
Aborting: A GIS database backend is required to run gis_tests.
```

`backend required` ≠ `backend **is** required` — **no match** (verified directly). The
comment three lines above the regex names "The django-11880 shape" as its motivation, so
the pattern was written from the *paraphrase* ("GIS backend required") rather than from the
log line. The GIS red appears identically in both runs (baseline :1904, wave :4085) and was
sanctioned in neither. **Mechanism 6 is therefore unvalidated, not merely unfired** — and
the 42-turn unpassable-probe waste it was built to remove (VII.2.2) is still fully present.
Fix is a one-token widening (`backend (is )?required`), but it must be re-validated, not
assumed: widening a red-sanctioning predicate trades verification rigor for turns, which is
the wrong direction to guess in.

**Real finding 3 — the step cap appears to be working.** 31 reasoner + 31 oracle turns
across 6 rungs ≈ 10 turns/slice, under the cap of 12. Volume of slices, not slice length,
drove the cost. The cap contained a bad route; it cannot prevent one.

#### VII.4.3 django-12050 — mechanism 6 (post-green convergence) is actively harmful

The cleanest causal specimen in the wave, and it convicts one of our own mechanisms.
12050's baseline is the tightest run in the set: 19 turns, $0.0267, **conductor-only**,
and **zero** `probe_gate_reject` signals — it simply converged and finished. Under the
wave it cost **$0.3079 over 72 turns with 37 above conductor (11.5×)**. The log order:

```
 736  [signal] converge_post_green   ← our finish-now nudge (mechanism 6)
 748  [signal] probe_gate_reject ×3  ← 12 lines later: M4 re-runs the pin at finish → RED
1136  [signal] probe_gate_exhausted  → decision=defer
1137  [signal] deferral_armed        → the escalation cascade → 37 above-conductor turns
1725  [signal] probe_gate_exhausted  (none-loud)
```

**The defect:** `converge_post_green` (`prompt.ts:2841`) nudges *finish now* when it
observes the pinned probe green with no other unresolved reds. The **M4 finish gate then
re-runs that same pin and finds it red** (I.5 step 2). The two mechanisms hold different
notions of "verified", and every round trip between them burns one of M4's three bounded
rejects. Exhaust them and the turn falls off the **deferral cost cliff** documented in
VII.4.1 — which is exactly how a conductor-only 19-turn instance acquired 37
above-conductor turns.

The same chain reproduces on 11815 (`converge_post_green` :469 → `probe_gate_reject`
:483, 14 lines later), where it cost one reject but the run recovered. It is **2-for-2 in
the runs where the nudge fires before the finish**. On 11790 and 11880 the nudge fired
*after* the escalation had already been chosen (:764 vs `stuck_escalate` :730; :1602 vs
the deferral :707), so it is not implicated there.

**The correlation across the wave is the summary of the whole exercise:**

| `converge_post_green` | Runs | Cost outcome |
|---|---|---|
| fired | 11880, 11815, 11790, 12050 | **4 of 4 more expensive** |
| never fired | 11999 | **1 of 1 dramatically cheaper (−70%)** |

**Verdict: mechanism 6 does not ship.** A convergence nudge may only fire on a green the
finish gate itself would accept — i.e. downstream of M4, not upstream of it. Nudging the
model toward a finish that a gate is about to reject does not save turns; it *buys* the
turns back at the escalation ladder's price. This is the wave's own contribution to the
IV.3 anti-pattern list: **two mechanisms disagreeing about "done", with a bounded-retry
counter as the currency.**

#### VII.4.2 What this wave can and cannot establish

**A 5-instance, n=1 wave cannot validate a cost change on this distribution.** 11880 is the
proof: a 3.1× cost swing with *no wave mechanism implicated in the divergence*. Cost claims
on this harness need the §6-style variance band (≥3 runs/instance), not a before/after pair
— the same standard Part III already applies to correctness claims. The inertness guards
(11790/12050) remain the only cells where a deviation would be unambiguous, since their
floor is tight and well-characterized.

Standing rule, given VII.1: this wave trims a tail on a **3.8× winning position**, so the
burden of proof runs against it. A mechanism that cannot be shown to help does not ship on
the argument that it might.

**Per-mechanism verdicts on the evidence actually obtained:**

| # | Mechanism | Evidence | Verdict |
|---|---|---|---|
| 1 | Brief-not-transcript | 11999: above-conductor 55 → 6. 11790: took an escalated draw at **6** above-conductor turns / $0.19 where every historical escalated 11790 ran **31–42** turns / $0.53–0.63 (III.4) | **Ship candidate** — two specimens, no counter-evidence |
| 2 | `ABOVE_CONDUCTOR_STEP_CAP=12` | Same two specimens. 11880 confirms it binds per-slice (6 rungs × ~10 turns, all under cap) | **Ship candidate** — but see the gap below |
| 3 | Cascade latch | Fired 2× on 11880, both *after* the route was set; no measurable effect | No evidence either way |
| 4 | Direct-first valve | **Never fired** on any of the five | No evidence |
| 5 | Identical-run dedupe | **Never fired** on any of the five | No evidence |
| 6a | Post-green convergence | 12050 (+1053%) + 11815, 2-for-2 causal chain into `probe_gate_reject` | **DROP** (VII.4.3) |
| 6b | Env-blocked writeoff | Regex never matched its own motivating case | **Broken** — fix + revalidate (VII.4.1) |
| 7 | Hub-gate turn bounce memory | **Never fired** on any of the five | No evidence |

**The gap mechanisms 1–2 do not close.** They bound *per-slice* cost, not *slice count*.
11880's 62 above-conductor turns were six judge rungs of ~10 turns each — every slice
obeying the 12-step cap. A per-turn ceiling on escalation **rungs** (or on cumulative
above-conductor spend) is the mechanism the evidence actually asks for, and the wave does
not contain it. That, plus VII.4.1's non-terminating deferral, is where the next wave
should start — not with more inline-window mechanisms.

**Meta-lesson, recorded because it cost a day.** Four of the seven mechanisms never fired
on any instance where they could be judged — they were designed inert-by-signature against
pathologies observed in *one* prior run each, and those pathologies did not recur. Building
seven mechanisms against n=1 observations, then validating with n=1 runs, produced exactly
one defensible result (11999) and one self-inflicted regression (12050). The pathology has
to be shown to be *recurrent* before it is worth a mechanism.

---

## Part VIII — the escalation decision IS the cost distribution (2026-07-15 band forensics)

Part VII measured what the wave's mechanisms burn; this part measures the decision
upstream of all of them — *whether to orchestrate at all* — and finds it is not a function
of the input. Every cost number quoted so far in this report (Part III's spreads, Part
VII's mini-10 figures) is a draw from that decision's distribution, not a measurement of
a fixed quantity. The forensics below are a 2-round band re-fire (`main-202607151500`) plus
one full-suite comparison and two single-instance autopsies, all tonight, 2026-07-15.

### VIII.1 The discovery — the gate is nondeterministic on identical input

Band rounds r1/r2, SAME pinned binary (`main-202607151500`), same instance django-11790,
74 minutes apart, IDENTICAL triage verdict (`hardness=moderate ambiguity=clear`,
goalCount=1):

| Round | Gate | Turns | Cost | Above-conductor |
|---|---|---|---|---|
| r1 | `orchestration_engaged slices=5` | 146 | $0.6639 | 60 |
| r2 | never engaged | 25 | $0.0670 | 0 (conductor-only) |

Both PASS with the same correct patch (`widget.attrs['maxlength']` as int). **9.9× cost
for zero outcome change.**

**The nondeterminism source.** `shouldOrchestrate` (slice-orchestrator.ts) is itself
pure — the coin-flip is the conductor LLM's todo-writing verbosity feeding it (5 todos one
run, fewer the next).

### VIII.2 The aggregate does NOT wash out

Full-suite comparison, ~same binary class: pre-wave mini10 $2.4715 / 514t / 9-10 vs band
r1 $3.8519 / 756t / 9-10 — the ten-instance AGGREGATE swings **1.55×** between draws
because the escalation decision correlates across the suite (one verbose todo-write run
tends to escalate several instances, not one).

**Consequence.** A single mini-10 run is not a cost measurement even in aggregate; the
published $2.35–2.47 figure is a draw, not a mean.

Per-instance detail, baseline → band r1:

| Instance | Baseline | Band r1 | Note |
|---|---|---|---|
| 11790 | $0.0531 / 20t | $0.6639 / 146t | the band-source instance (VIII.1) |
| 11815 | $0.5075 / 89t **FAIL** | $0.3748 / 67t **PASS** | |
| 11848 | $0.3383 / 44t | $0.4792 / 47t | |
| 11880 | $0.2364 / 59t | $0.4845 / 81t | |
| 11885 | $0.2936 / 70t | $0.5369 / 98t | |
| 11951 | $0.0560 / 24t | $0.1082 / 42t | conductor-only BOTH runs, ZERO wave mechanisms fired — variance alone produced 1.93× |
| 11964 | $0.1715 / 41t **PASS** | $0.6253 / 157t **FAIL** | autopsy in VIII.4 |
| 11999 | $0.6149 / 100t | $0.2966 / 61t | the brief+cap win, 0.48× |
| 12039 | $0.1735 / 48t | $0.2368 / 36t | |
| 12050 | $0.0457 / 21t | — | not itemized separately; folded into the 756t / $3.8519 total above |

### VIII.3 Where the wall-clock goes (trace-measured, not inferred)

From the band-r1 logs' millisecond timestamps. 11951 is single-session (no concurrency)
so attribution is exact:

| Component | Time | Share |
|---|---|---|
| Inference | 168.3s | 70% (median call 4.54s, p90 7.95s, max 15.0s) |
| Tool exec | 22.1s | 9% (median 0.45s, max 2.2s — the slowest bash in the whole instance) |
| Startup/gaps | remainder | 21% |

LLM latency is HEALTHY; test runs are negligible; wall-clock ≈ steps × ~5.6s, so **step
count is the only latency lever**.

**Escalation multiplies both.** 11790 escalated ran 12 concurrent sessions, 134 steps,
1431s vs 11951's 1 session / 43 steps / 241s; reasoner tier median 6.79s/call vs conductor
4.29s (+58%); conductor parents sit in blocked-on-children windows up to 949s.

**Instrumentation gap found.** `evaluated permission` events carry NO `session.id` (0 of
315 in 11790's log), so under concurrency tool-time cannot be attributed to a session —
single-session runs are the only exactly-decomposable traces until that one field is
added.

### VIII.4 The 11964 autopsy — the failure is NOT the wave, and more compute made it worse

Band r1 11964: 157t / $0.6253 FAILED (15/17 model_enums tests) vs baseline 41t / $0.1715
PASS. Zero wave signals fired.

**The wrong layer.** The agent fixed the wrong layer: gold site is `Choices.__str__`
(`django/db/models/enums.py:61`, never touched); instead it added
`DeferredAttribute.__set__` (`query_utils.py`) — promoting a non-data descriptor to a
data descriptor, which inverts attribute-lookup precedence against instance `__dict__`
for every deferred field in the ORM. It also hand-wrote the hidden test into
`tests/model_enums/tests.py` (reverted by the grader).

**Declared-done-on-red.** It ran the suite it broke 7×, emitted `unverified_finish` ×5 +
`deferral_armed`, and shipped anyway — the signal fired and nothing consumed it (the §5
anti-pattern: advisory-only signal).

**Classification.** This is the documented tier-immune spec-gap class (11964 recurrence):
**3.6× spend bought a WORSE answer.**

### VIII.5 The fix — deterministic, conductor-biased gate (committed `247cf53b3`, VALIDATED)

**New contract.** New `shouldOrchestrate` contract (`slice-orchestrator.ts`): opens ONLY
on (1) a harness-seeded escape-hatch slice, (2) ≥6 slices, (3) goalCount≥2
(triage-derived), (4) probe-derived `coupling === "high"` or `risk > ALLOCATION_RISK_TIEBREAK`.

**Removed.** The allocated-tier trigger — allocation reads `sliceType`/`need`
(conductor-authored) and defaults absent test-strength to `untestable`, flooring unbacked
mechanical slices to reasoner, so the old gate escalated on a missing probe signal plus
the model's self-report (contradicting `allocation.ts`'s own "conservative default is not
a cost hit" comment); and the bare wave≥2 trigger. This knowingly REVERSES run-21.

**Escape hatches.** The grind-valve/replan/plan escape hatches survive via
`harnessSeeded`, DERIVED at slice-build time by matching the harness's own seed content
constants (`HARNESS_SEED_CONTENTS`) — deliberately never a persisted field, because
`SessionTodo.Info` is the todowrite input contract and a persisted flag would let the
conductor set it itself. Two silent production traps caught during implementation: the
store schema would have dropped the field while every test stayed green, and the masking
test — `fakeProbes()` defaulting coupling to "high" — hid the grind-valve break; both are
recorded here as method lessons. `deferralPrepassTodo()` is deliberately EXCLUDED from
the escape set — the deferral cascade is the measured cost cliff of VII.4 / VIII.4.

**Ship rule** (`path-to-85.md` §6.6, §0.5): mini-10 band with per-decision gate
logging, ships only if route becomes deterministic per instance AND correctness holds
≥9/10 (the current consistent level; escalation may be load-bearing on
11815/11848/11880/11885 — that is precisely what the run measures). Amended mid-run by
user decision: two full rounds + a rerun of only the failed pair, instead of three rounds.

### VIII.6 Validation verdict (2026-07-15/16, pinned binary `0.0.0-main-202607151736`) — SHIP

**Cost determinism achieved.** r1 = 9/10 · $2.4695 · 509t; r2 = 8/10 · $2.5286 · 584t.
The ten-instance aggregate band collapsed **1.55× → 1.02×**, landing ~35% below the old
gate's expensive draw ($3.8519). Per-instance: 11999 $0.61 → $0.027–0.04 (cascade never
seeds); 11880-r2 *declined* (coupling=low) and passed at $0.0565 — cheapest ever, proving
even its historical escalations unnecessary; 12050 declined DAGs of 1/3/3/5 slices both
rounds. The one residual LLM-fed trigger is **goal-width**: 11951-r1 engaged on a
triage read of 2 goals (8.3× cost swing vs its declined draw) — the next tightening
candidate, not a ship-blocker.

**Correctness: no gate-attributable failure.** Three fails across the two rounds
(11964 ×2, 11885 ×1), all in documented route-immune variance classes, and **both
instances passed a same-binary rerun**:
- **11885** (rerun PASS, $0.3638/105t): the gate made **zero decisions** on it in all
  three draws (no typed DAG is ever written — conductor-only on every binary), so its r2
  fail cannot be the gate's. The fail/pass flip is draw-level approach choice —
  naive combine-all (r2, red 2/45) vs conditional per-model combine (r1 + rerun, green).
  The rerun showed none of r2's failure signature (`deferral_armed` ×2 /
  `probe_gate_exhausted` ×4 / `regression_unresolved` all absent) and one
  `turn_regression_green` — a regression observed and driven back to green.
- **11964** (rerun PASS, $0.0973/35t): the diagnosis-preference class confirmed from the
  passing side. This draw's first diagnosis landed on `django/db/models/enums.py` — the
  root-most layer the hub-gate maintainer-prior had named 5×/round in both failing
  rounds — so the prior never needed to fire (0 fires), the `model_enums` suite ran 6×
  before finish, and the gate declined 5× (`trigger=none`, sliceCount 1–2). Fails happen
  exactly when the first diagnosis anchors on the symptom layer (`query_utils.py`) and the
  **evidence-free re-issue hatch** lets the agent override the prior — now three-for-three
  evidence for closing that hatch (VIII.4).

**Signals remain advisory-only at the ship boundary** (§5 anti-pattern, second
confirmation): the 11964 rerun *passed* while `unverified_finish` fired 7× and
`deferral_armed` 2×, all unconsumed — same as they fired unconsumed on 11885-r2's
shipped-red. Consuming them at finish is the companion follow-up to the hatch.

---

## Part IX — post-forensic addendum (2026-07-18): the regression-gate blind-spot class (shapely-2226, linkding-995)

**Trigger.** SWE-bench-Live `live_verified` forensics on two shipped regressions the
F11/F16 gate should have caught but didn't — both root back to the gate's neighbor
selection and interpreter discovery being FILENAME-shaped, and the failing case wasn't.

**shapely-2226 — the gate fired GREEN on the wrong neighbors.** The edit touched
`geometry/collection.py`; the 9 tests it actually broke (`test_split`,
`test_clip_by_rect`, …) reach the edit through `ops.py` — CALL-GRAPH neighbors with
zero filename/stem overlap with `collection.py`. Every filename rung (F17/F19)
selected collection-stem suites, ran them green, and the turn shipped the regression.

**linkding-995 — the gate was SKIPPED entirely on a false env-red.** F14a's
interpreter probe imports the touched top-level package via a `sys.path[0]`-stripped
run; a Django-project package importable only from the repo root fails every
candidate (`turn_regression_env probed=2`), so the gate skipped rather than ran —
while the SAME turn had already run `python -m pytest …` green with a working
interpreter the probe never consulted.

**Fixes: F20 graph-derived neighbor reach + F21 turn-harvested interpreter
(IMPLEMENTED 2026-07-18, live re-fire pending).** Mechanism detail lives at I.5
item 5. Both are strictly additive and fail closed: a cold/missing graph or an empty
transcript degrades to the prior filename-rung / synthetic-probe behavior — never a
new false red, never a new gate skip.

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
