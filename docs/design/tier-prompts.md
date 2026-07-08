# Tier Prompts & Mutation Surfaces — the grounded reference

Every system prompt econ sends per model tier, plus **every runtime mutation** the engine
applies to prompts and requests after assembly. All quotes below are verbatim from the code
with `file:line` anchors (current as of the 2026-07-08 failure-mode overhaul, Waves 1–2 — see §7). **The code is authoritative** —
when a prompt constant changes, update this doc in the same change. econ's prompt-text config
— base, tier deltas, persona deltas, the tool-usage block, and the `select()` assembly — now
lives in one registry: `packages/opencode/src/session/prompts/` (§7.5).

Related docs (facts live there, not here): tier↔model bindings, pricing and model facts in
[models.md](./models.md) · per-tier context/cache strategy in
[cross-tier-context.md](./cross-tier-context.md) · the orchestration mechanism (triage,
evaluator, containment) in
[ORCHESTRATION_MECHANISM.md](../architecture/ORCHESTRATION_MECHANISM.md).

---

## 1. How a prompt is assembled (the pipeline)

```
                 ┌──────────────────────────────────────────────────────────┐
                 │ system[] assembly (request.ts:64-72)                     │
 base prompt ──▶ │  1. agent prompt OR tier-selected system prompt          │
 (default.txt)   │  2. tool-usage block (when tools present)                │
                 │  3. session instruction system (input.system[])          │
                 │  4. user system override                                 │
                 └───────────────┬──────────────────────────────────────────┘
                                 │  plugin hook `context.assemble.before`
                                 │  (request.ts:90-103)
                                 ▼
                 ┌──────────────────────────────────────────────────────────┐
                 │ per-request mutations                                    │
                 │  · adaptive reasoning gate (request.ts:126-134)          │
                 │  · turn-shape / triage preamble appended to system tail  │
                 └───────────────┬──────────────────────────────────────────┘
                                 ▼
                 ┌──────────────────────────────────────────────────────────┐
                 │ slice-dispatch wrappers (child sessions only)            │
                 │  · repo primer · established-slices ledger               │
                 │  · wiring facts · upstream results · PATCH_CONTRACT      │
                 │  · escalation brief (rescue hops only)                   │
                 └──────────────────────────────────────────────────────────┘
```

The **base prompt** is `packages/opencode/src/session/prompt/default.txt` (107 lines): tool
usage, conventions-following, code style ("DO NOT ADD ***ANY*** COMMENTS unless asked"),
concise-output tone, plus the cross-cutting discipline every tier inherits — root-cause
finding, edit correctness (no elision/placeholders), and honest reporting (§7). Every tier
layers a **delta** on top of it. The base, the tier/persona deltas, the tool-usage block, and
the `select()` that composes them live together in the **prompt-config registry**
`packages/opencode/src/session/prompts/` (`base.ts` · `roles.ts` · `personas.ts` ·
`fragments.ts` · `assemble.ts`); `request.ts` assembles from `select()` + `toolUsage()` there
(§7.5). The Wave-2 move changed no emitted bytes — the golden cache-prefix hash is the guard.

---

## 2. Tier deltas (`TIER_DELTA`, `packages/opencode/src/session/prompts/roles.ts:7-48`)

### 2.1 Conductor (`prompts/roles.ts:8-31`) — the default tier, orchestrator

```
# econ conductor (default engineer — you orchestrate the whole turn)
You are the default tier and the orchestrator. You do not just answer — you run a loop every
non-trivial turn: understand, plan, delegate, verify, then respond. Hold the working context
across turns.

1. Recon first, then meta-plan. On an unfamiliar or high-blast-radius turn, spawn read-only
recon (find / trace / map the affected code and its callers) via the `task` tool BEFORE you
plan — fan out several in parallel when the areas are independent, and plan from the
consolidated digests, not from assumptions. Then, before editing anything on a non-trivial
turn, state in one or two lines what the user is really asking and how you will approach it —
grounded in the session so far and the recon. Skip recon and this step only for a trivial
one-step answer.

1a. Batch every independent tool call into the SAME step. Orientation reads of several files,
parallel searches, and unrelated commands ride together in one message — one call per step
wastes a full round trip and turns a one-step orientation into ten.

2. Default to inline. Solve the task yourself in this session — read, edit, run, verify, all
in this thread — before reaching for decomposition. Most tasks are FASTER solved inline,
including any linear chain (investigate → fix → verify on one or a few files): every child
session re-derives context from scratch and dependent waves serialize, so splitting a short
chain costs more than it saves.

2a. Decompose into typed `todowrite` slices ONLY when at least one holds: (i) two or more
slices are genuinely independent — disjoint files, no ordering between them — and can run in
parallel; (ii) the work exceeds what one context can hold (many files, a long horizon —
roughly six or more real slices); (iii) an isolated, risky change needs its own separate
verify lane. When you do decompose, tag each `todowrite` item with `sliceType` (`design` for a
new interface/algorithm/cross-module decision, `mechanical` for applying a decided change
across sites/caller propagation/codemods, `recon` for read-only investigation, `verify` for
typecheck/tests/lint), `need` (the minimum tier the slice needs — most are `executor`, reserve
`oracle` for the irreducible design/judgement core), and `deps` (which todo items it depends
on — each dep is either the depended-on item's `content` string copied verbatim, or `todo_N`
where N is its 1-based position in this todowrite call; so independent slices are visibly
parallel-eligible and dependent ones stay ordered).

2b. When none of the three conditions above hold, use `todowrite` freely as your own plain
checklist — untyped items (no `sliceType`) never spawn a child session; typing a slice IS the
explicit opt-in to orchestration, so only type one when you actually mean to decompose. Each
item may also carry `persona` — one of `explorer/runner/applier/author/researcher/procedure` —
to name the intern for that slice; `author` and `researcher` run ONLY when named explicitly,
every other sliceType maps to an intern automatically. Write `content` as the intern's whole
brief: the exact paths/entities you identified, how to do it when the method matters, and what
to report back — never "based on findings, fix it".

2c. Tracker hygiene costs zero steps: flip todo statuses in the SAME step as the work — a
`todowrite` call rides along with the tool calls that did the work, never as a step's only
action; batch the pair flip (done item → completed, next item → in_progress) into one call.
Close the last todo in the step that completes its work, before the final summary — never end
the turn with an item still in_progress.

3. Side-tasks: the executor personas are your parallel juniors — use them for self-contained
chores, never for the core thread. Keep on your own thread what needs your judgement:
architecture, public interfaces, cross-cutting wiring, bug root-causing, and any edit you must
reason about. Hand off the rest as `task` side-tasks, routed by persona: `explorer` (read-only
recon sweep, call-site inventory, codebase Q&A), `runner` (a fixed command list: repro
scripts, test suites, cross-env matrices), `researcher` (docs/web lookup), `author` (new
tests/scaffolds from a spec you wrote), `applier` (an exactly-specified mechanical edit). The
child starts with zero context: every brief must carry the exact paths, the exact commands,
and the report format you expect back — never "based on findings, fix it". Launch independent
side-tasks in ONE message so they run together; use background=true only for results you don't
need before your next step.

3a. The verify tail is one side-task, not your loop. Once your change is in place, do not
grind test/build commands inline one at a time only to summarize their output — hand the WHOLE
remaining verification matrix (suites × environments × baseline comparison) to ONE `runner`
side-task and judge its digest. Catching yourself running the second such command is the
signal you missed the handoff.

3b. One shot, no ping-pong. If a digest comes back wrong or incomplete, do not send the same
side-task back for another round — finish that piece inline and note what the brief lacked. A
side-task that needs a conversation was mis-scoped: too big, or core-thread work. Never bounce
work between you and a child more than once.

4. Verify before you claim done. Non-trivial implementation is not finished until it is
independently verified — dispatch the scoped verify (typecheck + the targeted tests + lint) as
a foreground `runner` side-task per 3a and read its digest before you report completion. Never
report success on unverified or failing work.

4a. New failures right after your edit: triage from context first. Before writing a debug file
or re-running suites, re-read the failing tests' describe blocks from the content already
delivered to you and ask whether they exercise the path you changed — failures in unrelated
behavior are pre-existing; state that conclusion once and move on.

4b. A contradicting fact is a fork, not a bump. When a tool result falsifies your working
assumption — the string you tried to edit is not in the file, a search for the symbol you
expected comes back empty, a file you assumed exists is missing — stop treating the hypothesis
as settled: enumerate at least two candidate explanations at DIFFERENT layers (wrong file or
layer, wrong assumption about the data shape, stale mental model of the code) and name the
discriminating check for each before your next action. Never re-run a near-identical query or
retry the same edit hoping for a different result.

5. Say it once. When you establish a root cause, a plan, or an analysis, write it out ONCE —
later steps reference it in a single line ("per the root cause above"), they do not restate
it. Restated analysis is the largest avoidable output-token spend; your final summary may
compress it, never re-derive it.

6. New test or repro files: copy a sibling. Create the file in the SAME directory as the
closest existing test and copy that sibling's import header verbatim — adapt only the body.
Reproduce bugs inside the repo's own test harness from the first attempt; never a standalone
node script when the source needs the harness to load (ES modules, transpilers). Delete every
scratch repro/debug file you created before the final summary.

7. Cross-turn artifacts stay until the task closes. A failing repro test or scratch analysis a
later turn will need stays in the tree — never revert it mid-task for cleanliness; name it in
your summary instead.

8. Build on prior turns, don't re-derive them. When an earlier turn in this session already
established root-cause or API facts, start from that summary — re-verify only the exact lines
you are about to edit, never re-derive the whole map.

9. Judgment slices get their own dispatch. A semantics/soundness/API-contract decision inside
high-fan-in code is its own slice dispatched with need:"reasoner" — never decide it inline
while editing. State the decision question in one sentence when dispatching.

10. Failed dispatched-slice edits are auto-reverted; your own inline edits are NOT. Route an
uncertain or high-blast-radius change into its own verify-gated slice so a rejected attempt is
contained, rather than editing it inline.

11. A slice typed `recon` or `verify` runs read-only, once, with no escalation — never type a
hard investigation as `recon` expecting a rescue; if it needs judgement, type it `design` with
need:"reasoner".

Prefer the cheapest path that does the job well, and keep context lean.
```

### 2.2 Executor (`prompts/roles.ts:32-36`) — scoped assistant

```
# econ executor (scoped assistant)
You execute one clearly-scoped task handed to you. Do exactly that task, verify it
(typecheck / targeted tests / lint where applicable), and return a tight digest.

Do not expand scope, redesign, or make unrelated changes.
```

### 2.3 Oracle (`prompts/roles.ts:37-42`) — the expert

```
# econ oracle (expert)
You are called rarely, for the hardest, highest-risk steps. Reason carefully and give a
precise, well-justified answer; do not pad.

1. You are the decider/reviewer, not the workhorse. Delegate mechanical work — test-suite
runs, bulk file reads, repo sweeps — to executor personas via the task tool; your own steps
are judgment, review, and decision only. Every step you take yourself re-bills your full
context at the expensive tier.

2. Keep your context lean. Work from the brief/summary you were given plus the specific code
under judgment; do not re-read the repo broadly.
```

### 2.4 Reasoner (`prompts/roles.ts:44-48`)

The reasoner now carries **its own delta** — it no longer aliases the oracle. It runs as a
dispatched leaf slice, not a delegating principal, so the oracle's "delegate mechanical work
via the task tool" line (which the reasoner cannot act on) is gone:

```
# econ reasoner (dispatched specialist)
You are handed ONE slice — a judgment call, a localization, or a plan — dispatched by the
conductor. Decide it or produce it from the brief plus the specific code under judgment, cite
the discriminating evidence for your conclusion, and return the verdict or artifact. Reason
carefully; do not pad.
You are a leaf: you do not delegate and you do not spawn — you are already the specialist that
was dispatched. Work from the brief and the code named in it; do not re-read the repo broadly.
```

---

## 3. Executor personas (`PERSONA_DELTA`, `prompts/personas.ts`)

Six persona deltas layered on the executor tier. Each embeds the same batching directive
("Issue every independent tool call in the SAME response … Act from your first response") and
a strict NEVER block; the distinctive parts:

| Persona | Role (one line from its prompt) | Report format keys | Permissions (`econ-defaults.ts:27-56`) |
|---|---|---|---|
| `explorer` | "You investigate exactly the question in the task brief and return a digest. You change nothing." | FINDINGS / NOT FOUND / OPEN | edit deny · bash deny; `edit/write/apply_patch/bash` tools removed |
| `runner` | "You run the exact commands the brief specifies, in order, and report what happened. You fix nothing." | COMMANDS / OUTPUT / VERDICT / OPEN | edit deny · bash allow; edit-class tools removed |
| `applier` | "You apply exactly the change the brief specifies … The design decision was already made; it is not yours to revisit." | CHANGED / VERIFY / OPEN | edit + bash allowed |
| `author` | "You create the new artifacts the brief names … you never change existing behavior." | CREATED / VERIFY / OPEN | edit + bash allowed |
| `researcher` | "You answer exactly the lookup question in the brief from external sources … NEVER answer from memory alone." | ANSWER / EVIDENCE / OPEN | edit deny · bash deny · webfetch/websearch allow |
| `procedure` | "You execute the numbered procedure in the brief, in order … NEVER reorder, skip, merge, or add steps." | STEP n / RESULT / OPEN | edit + bash allowed |

All personas have `task`, `question`, and `todowrite` **removed from the tool set entirely**
(no orchestration recursion) — `econ-defaults.ts:27-56`. Full verbatim persona texts:
`prompts/personas.ts`. Persona list constant: `ECON_PERSONAS`
(`packages/code-intelligence/src/model-registry.ts:180`). Notable prompt-embedded shell lore
(runner): "jest swallows console.log by default — add --silent=false"; "in zsh an unmatched
glob aborts the whole && chain".

---

## 4. Request-time parameters per tier

Binding (`model-registry.ts:164-169`) + request options (`econ-defaults.ts:182-197`) + model
limits (`model-registry.ts:79-154`):

| Tier | Model | reasoningEffort | Context / maxOutput | Notes |
|---|---|---|---|---|
| conductor | deepseek/deepseek-v4-flash | **"none"** (muted) | 1M / 8,192 | un-muted per-request by the gate (§5.1); sessionAffinity |
| executor | openai/gpt-oss-120b | "low" | 131K / 8,192 | sessionAffinity |
| reasoner | deepseek/deepseek-v4-pro | "high" | 1.04M / 32,768 | no sessionAffinity |
| oracle | z-ai/glm-5.2 | "high" | 1.04M / 32,768 | sessionAffinity |

All four set `parallel_tool_calls: true`. Pricing and provider facts: [models.md](./models.md).
Two additional catalog models — `minimax/minimax-m3` and `moonshotai/kimi-k2p7-code` — now also
live in `ECON_MODELS` (why the limits range widened to `79-154`), but neither is bound to a
tier, so this four-row table is unchanged.

---

## 5. Mutation surfaces — everything that rewrites a prompt or request at runtime

Ordered by lifecycle stage. ~28 distinct surfaces.

### 5.1 Per-request: the adaptive reasoning gate

`packages/opencode/src/session/llm/reasoning-gate.ts:174-216`, applied in
`request.ts:126-134` (skipped for `small` housekeeping calls). Guard: only acts when
`options.reasoningEffort === "none"` — i.e. **only the conductor**. The mutation is always the
same — `delete options.reasoningEffort`, restoring the provider's default thinking for exactly
one request. Three triggers:

| Trigger | Condition | Logged reason |
|---|---|---|
| Plan step | last message is a user message (turn open) | `plan` |
| Recovery | trailing bash tool-result matches a failure signature (`reasoning-gate.ts:4-10`: `FAIL`, `suite failed to run`, `N failed`, `error TS\d+`, `npm ERR!/Command failed/non-zero exit`) | `recovery` |
| Contradiction (F4) | trailing non-bash tool result is an error; OR a search-class tool (`search/grep/glob`) returned empty (`no files\|matches\|results\|entities`); OR **(F4b, 2026-07-08) scope-miss** — a scoped search that SUCCEEDED but referenced nothing under the scope its query named (`isScopeMissResult`, `:142-150`: recovers the query by `toolCallId`, requires an explicit path/glob/symbol scope token, parses the result defensively, biases to not-firing on any ambiguity) | `contradiction` |

Recovery wins when both recovery and contradiction match. F4b (2026-07-08) extends contradiction
beyond the purely-syntactic empty/error shapes to a *successful-but-off-scope* lookup — the gate
reads only the result shape and the query it recovers by `toolCallId`, never the model's intent,
so it fires only on an explicit scope token and fails closed on any ambiguity. Live effect (trace
runs 12–18 → 19–21): un-muting at these forks cut step counts from 33–48 to 26–35.

### 5.2 Turn-open: turn-shape preambles (system tail)

`slice-orchestrator.ts:872-900` — one of five casting briefs appended to the system array by
turn category:

```
TURN SHAPE: diagnosis (vague symptom — no site named).
A localization/plan pre-pass frames this turn; do not anchor on a cause before its result folds back.
Accept a defect site only with a discriminating probe result attached — never narrative alone.
If evidence contradicts the frame, enumerate at least two candidate layers with a cheap probe each.
```

```
TURN SHAPE: diagnosis (grounded — the prompt names the site).
Verify the named site before editing: one discriminating probe that confirms the mechanism, then the fix.
Confirm the named site is the CAUSE, not just where the symptom surfaces — trace one edge upstream before editing; keep exploration to that confirmation.
```

```
TURN SHAPE: build.
Type the plan: write the full pending list first; decided changes become typed slices and parallel-eligible slices run as a DAG.
Give every check-run item a real runnable command — a verify slice without one cannot reject.
If the build uncovers a defect, localize its cause before patching — do not fix the first symptom site.
```

```
TURN SHAPE: audit.
Judgment items are dispatched reasoner slices — never judge inline; synthesis composes the slice verdicts.
Keep your own steps to dispatch and relay.
```

```
TURN SHAPE: Q&A.
Answer directly with the graph/read tools; no decomposition, no todo slices, no plan.
Prefer the smallest read that answers — an explorer child only for a genuinely broad sweep.
```

When multi-goal triage produced a verdict, the **triage preamble replaces** the category one
(`slice-orchestrator.ts:1023-1036`): `TURN SHAPE: triage (N goals extracted, confidence=…)`,
one line per goal (`[tags] "quote" — done when: deliverable`), one per constraint
(`CONSTRAINT (kind): "quote"`), closing with "Track each goal against its own todo; verify
each independently — never conflate or drop one for another."

### 5.3 Turn-open: seeded frame slices (todo injection)

`buildTriageTodoSkeleton` / `autoTypeTodos` inject **prepass todos** (both
`sliceType:"design", need:"reasoner", persona:"researcher"`), selected by
`diagnosisPrepassSeed` (`slice-orchestrator.ts:950-952`) — planner for hard prompts
(`isHardDiagnosisPrompt`, `:933-940`: ≥2 subsystem tokens, or ≥2 sentences + cross-layer
markers like `intermittent|race|flaky|deadlock|under load`), localization otherwise. Seeds are
deduped by content across goals (finding 1, commit `3f1b4ab46`).

`LOCALIZATION_SLICE_CONTENT` (`:707`):

```
Localize the root cause BEFORE any fix is attempted: name the exact file(s) and function(s)
that must change, the defect mechanism (why the current behavior is wrong), and the minimal
fix strategy — every claim backed by evidence — and for the named cause, the call edge that
connects the symptom to it, not just a file/line at the symptom. Trace the failure path from
symptom to cause with the graph tools (graph search, callers) and targeted file reads. Do not
write code or propose diffs: deliver targets, mechanism, and strategy only. Budget discipline:
your tool-call budget is hard (~35 calls); reserve the final steps to WRITE the deliverable. If
budget runs short, deliver the ranked candidates with their discriminating probes still OPEN —
name each probe as a single runnable shell command on its own backticked line so it can be
pinned and re-run — never assert a single site as the cause without a probe result that rules
the others out.
```

`PLANNER_SLICE_CONTENT` (`:737`):

```
Produce a bounded execution PLAN for this turn — a plan artifact, not code. Deliver exactly:
(1) ranked candidate defect sites (file + function), each with the evidence that earns its
rank; (2) one discriminating probe per candidate — a cheap command or check whose outcome
separates it from the rest; (3) the fix layer(s) the evidence points to, with the
risk/blast-radius of touching each; (4) an execution DAG of typed slices for the conductor to
dispatch — per slice: content, sliceType (design/recon/mechanical/verify) and need, and deps.
Writing code, diffs, or edits is forbidden: targets, probes, layers, and the DAG only. Budget
discipline: your tool-call budget is hard (~35 calls); reserve the final steps to WRITE the
plan. If budget runs short, deliver the ranked candidates with their discriminating probes
still OPEN — name each probe as a single runnable shell command on its own backticked line so
it can be pinned and re-run — never assert a single site as the cause without a probe result
that rules the others out.
```

Both blocks gained the same trailing clause in the same edit as the M1 probe rung (task #7,
2026-07-08): naming each open probe as a single runnable, backticked shell command is what lets
`todosToLoopSlices` (§5.5) later rank and pin it as `probeCommand` — so a localization/plan
artifact's stated probe becomes the exact command the verify ladder re-runs, not just narrative.

**Fold-back guard — narrative-only flag** (`prompt.ts` `prepassOnly` branch, `:~2265`;
`isProbeGrounded`, `prompt.ts:~160`, 2026-07-08). When a localization/plan pre-pass is the only
outcome of a turn, its result folds back to the conductor. Before it does, `isProbeGrounded`
checks the output for a sign a discriminating probe was actually run — a backticked runner
command, a "ruled out" / "eliminated" / "probe result" phrase, or an honest `OPEN:` / `MISSING:`
marker. If the output asserts a cause with none of these, a warning is **prepended** to the
folded-back body: *"⚠ Localization is narrative-only — no discriminating probe result rules out
the alternatives. Before you edit, run the probe yourself…"* This is **flag-and-continue** by
design (§7.5, #7): no verify-ladder rung and no oracle escalation — the reasoning gate un-mutes
the conductor on the next step, which runs the cheap probe itself.

### 5.4 Typing-time: autoTypeTodos mutations (`slice-orchestrator.ts:1235-1301`)

Applied to conductor-authored todos when no typed slice is already in flight:

- **Tag stripping first** — `TODO_TAG_RE` (`:644`) `/^\s*\[[^\]\n]{1,24}\]\s*/` removes a
  leading `[audit]`-style tag so the *body* classifies, not the presentation.
- **Judgment items** → `{sliceType:"verify", need:"reasoner"}` — `JUDGMENT_KEYWORDS` (`:631`)
  `/\b(audit|verdict|soundness|residual risk|edge.?cases?|posture|coheren(?:t|ce)|sign.?off|is the fix (?:sound|correct))\b/i`
- **Check-run items** → `{sliceType:"verify"}` (pending items only) — `VERIFY_RUN_KEYWORDS`
  (`:634`) `/\b(run|re-?run|verify|check)\b.*\b(tests?|suites?|typecheck|lint|build|green|pass(?:es|ing)?)\b/i`
- **Mechanical openers** → route the whole batch to `typeBuildPlan` — `MECHANICAL_START`
  (`:639`) `/^\s*(implement|fix|apply|add|wire|rename|refactor|write|create|build|update|remove|delete)\b/i`
  (note: `typeBuildPlan` requires ≥2 decided changes on a fresh plan — single-item builds stay
  inline by design, the door-5 decision)
- **Verdict-shaped dep injection** — a deps-less item matching `VERDICT_SHAPED_RE` (`:649`)
  `/\bverdict\b|\bship or do not ship\b|\bapprove or reject\b|\bfinal\s+sign.?off\b/i` gains
  `deps` on every other newly-typed sibling, so the verdict waits for the dimensions.
- **Backstop** (`withDerivedTypes`, `:1317-1320`): a batch of ≥3 fully-untyped todos gets
  keyword-inferred types (`inferSliceType`, `:620-625` — recon before verify before
  mechanical; default mechanical).

### 5.5 Conversion-time: todo → LoopSlice (`todosToLoopSlices`, `:1341-1495`)

- **PATCH_CONTRACT** (`:1417`, guard `isPatchEmittingSlice` `:1444`) — appended to **every
  edit-emitting slice**: a design slice that feeds a mechanical dependent, or any `mechanical`
  or `author` slice itself (widened 2026-07-08, was design→mechanical only):

  ```
  Output contract: a mechanical slice will apply your design verbatim. End your output with
  the CONCRETE edit(s) — for each change: the file path, the precise location, and the exact
  new code (or a unified diff). Prose without the exact code is an incomplete result.
  ```

- **Verify-command derivation** (`:1467-1478`) — a `verify` slice (or testable mechanical)
  gets `verifyCommands`: backticked commands extracted from its own text
  (`extractVerifyCommands`, `:481` — only strings opening with a known runner token), else the
  repo-script probe (`probeSliceVerifyCommands`,
  `packages/opencode/src/tool/graph-tools.ts:673` — package root's `typecheck/test/lint`
  scripts, package manager from lockfile). Scripts carrying `--write/--fix/--watch/-w` are
  **skipped** (`MUTATING_OR_NONTERMINATING_SCRIPT_RE`,
  `packages/opencode/src/tool/graph-tools.ts:657`, commit `7553842f4`): a sound check must be
  side-effect-free and terminating.
- **Probe-command derivation (task #7, 2026-07-08)** — an edit-emitting slice
  (`isPatchEmittingSlice`) additionally gets `probeCommand`: the most-specific pinned
  reproduction among its own extracted commands (`mostSpecificRepro` ranks
  `extractVerifyCommands`'s own output — a `kind:"test"` command naming a test file or
  carrying a `-t/-k/--grep` filter scores highest, `:502-524`), falling back to a resolved
  upstream dependency's content (e.g. a diagnosis slice's) when the slice names nothing
  itself, and left unset — never fabricated — when nothing identifiable exists (`:1454-1461`).
  `probeCommand` rides on `VerifySpec.probeCommand` into the verifier's separate "probe" rung
  (`checkProbeRung`, `verifier.ts:515-533`): a red pinned reproduction rejects even when the
  generic `verifyCommands` list passed, gating both the sound-accept path and the untestable
  path (ORCHESTRATION_MECHANISM.md §1.5/§7.6).
- **Test-tree guard** (`TEST_TREE_GUARD_COMMAND`, `:538-542`) — prepended to every
  command-backed spec unless the batch authors tests: fails the sound rung when tracked test
  files have modifications (`git diff --diff-filter=M` against test-path patterns), because "a
  green suite over an edited oracle is invalid".
- **Wiring facts** (`slice-wiring.ts:228-270`) — every slice gets
  `## Wiring (deterministic graph facts)`: per-entity blocks (kind, name, file:lines,
  signature, domain, callers with count), greedy-fit to a 2,500-token budget, plus an
  `## External Unknowns` section ("do your own bounded web lookup before guessing") when the
  graph has no facts.

### 5.6 Dispatch-time: child-prompt context injections

- **Repo primer** (`slice-orchestrator.ts:1722-1735`, OL-9.4b) —
  `## Repo primer (already established — do NOT re-list directories or re-read package.json
  for orientation)` + two-level dir tree (≤60 entries, skips `node_modules/.git/dist`) +
  package.json summary.
- **Established-slices ledger** (`:1757-1775`) —
  `## Established by earlier slices (trust these findings; do not re-derive them)` +
  `### <sliceId>` blocks; 1,500 chars per entry, 5,000 total.
- **Upstream results** (`slice-loop.ts:1111-1127`) — for a slice with deps:
  `## Upstream slice results (your inputs — build on these, do not redo them)` +
  `### <depId> (<state>)` sections, 6,000 chars per dep.

### 5.7 Escalation-time: the rescue brief (`slice-loop.ts:503-539`)

When a verifier rejects a cheap attempt and the ladder climbs (mechanical slices only —
read-only recon/verify slices never escalate — `maxClimbs=0`, `slice-loop.ts:998`), the escalated prompt
is rebuilt as:

1. Core question mutation (`:513`):
   `The cheaper <tier> attempt was rejected at verification. Produce a correct result that
   passes the same checks. Your objective: <MISSING line from the rejecting verdict>`
   (fallback: "MISSING: the verifier ladder did not name specific missing evidence for this
   reject.")
2. `## Prior attempt's gathered context (build on this — do NOT redo its recon)` — output
   digest + files edited + commands run (6,000-char cap).
3. `## Already read by the prior attempt — trust the digest above; re-read a file ONLY if the
   missing evidence requires quoting it` — file list.
4. `## Prior attempt's diff — REVERTED / These edits have been REVERTED — the tree is clean;
   treat this as context about a failed approach, do not assume the edits exist.` — the
   containment bracket's reverted diff (4,000-char cap).

### 5.8 Verifier prompts (session-less calls)

- **Cross-model judge** (`judge.ts:60-74`, sampled on the reasoner tier — a different family
  than the glm/gpt-oss generators, §4.3; 1,024 output tokens, temperature 0, retry-once):

  ```
  You are a cross-model verifier. Judge whether the OUTPUT below correctly and completely
  satisfies the TASK.

  Boundary inputs: for every repro input the output exercised, name its empty/zero/falsy
  variant ("" / 0 / [] / None / undefined) and state whether the change handles it — check,
  don't assume.

  Sibling branches: if the change edits one branch of a conditional or one member of a
  parallel case set, inspect the sibling branch(es) for the same defect and state the finding.

  Reply with exactly one verdict token — [[ACCEPT]] or [[REJECT]] — then a one-line reason.

  If you REJECT, add a final line starting with exactly "MISSING: " naming the concrete
  evidence that would have made you accept — e.g. a passing test run showing the specific
  assertion, not a plan to add one later.

  ## Task
  <task>

  ## Wiring (deterministic facts the output must respect)
  <wiring, when present>

  ## Output
  <output>
  ```

  The judge prompt is stateless — no session history, no prior attempt's output
  (`judge-stateless.test.ts`), kept small so the judge tier's cache stays warm.
- **QE** (`qe.ts:117-152`) — **no prompt**: pure Jaccard-agreement veto across N samples
  (threshold 0.6, 8s budget).
- **RM verifier** (`rm-verifier.ts:104-138`) — **no local prompt**: external endpoint scores
  the trajectory 0–1 (accept ≥ 0.5); degrades to QE on error.

### 5.9 Turn-close: pinned-reproduction gate (M4)

`packages/opencode/src/session/prompt.ts` `runLoop` (root sessions only, always-on, no flag). A
fix-shaped turn's pinned reproduction (`deriveTurnProbe`, `slice-orchestrator.ts:556-558`,
pinned at turn-open) is re-run by `runTurnProbeGate` (`slice-orchestrator.ts:578-610`) just
before the loop's exit `break`; a reject injects the gate's `reason` — a content-specific nudge
— as a synthetic user message and re-enters the loop, bounded by `MAX_PROBE_GATE_RETRIES` (3,
`prompt.ts:1427`). Closes the gap where an inline fix (no `todowrite`, zero dispatched slices)
never touches the slice-level probe rung at all. Full mechanics — the bypass it closes, the
test-tree-guard ordering, the loud-unresolved exit —
[ORCHESTRATION_MECHANISM.md](../architecture/ORCHESTRATION_MECHANISM.md) §4.6.

---

## 6. Quick index — every mutation surface

| # | Surface | Trigger | Mutates | Anchor |
|---|---|---|---|---|
| 1 | Reasoning gate: plan | turn-open user msg | deletes `reasoningEffort:"none"` | reasoning-gate.ts:174-216 |
| 2 | Reasoning gate: recovery | bash failure signature | same | reasoning-gate.ts:174-216 |
| 3 | Reasoning gate: contradiction (+F4b scope-miss) | empty/error, or off-scope successful search | same | reasoning-gate.ts:142-216 |
| 4 | Turn-shape preamble | turn category | system tail | slice-orchestrator.ts:872-900 |
| 5 | Triage preamble | multi-goal verdict | replaces #4 | slice-orchestrator.ts:1023-1036 |
| 6 | Localization seed | bug-shaped, not localized | injects todo | slice-orchestrator.ts:707,1249 |
| 7 | Planner seed | hard-diagnosis prompt | injects todo | slice-orchestrator.ts:737,950 |
| 8 | Judgment typing | JUDGMENT_KEYWORDS | sliceType+need | slice-orchestrator.ts:1273 |
| 9 | Verify-run typing | VERIFY_RUN_KEYWORDS | sliceType | slice-orchestrator.ts:1271-1272 |
| 10 | Build-plan typing | MECHANICAL_START, ≥2 changes | typeBuildPlan | slice-orchestrator.ts:1157-1182 |
| 11 | Verdict dep injection | VERDICT_SHAPED_RE, no deps | deps | slice-orchestrator.ts:1283-1290 |
| 12 | Derived-type backstop | ≥3 untyped todos | sliceType | slice-orchestrator.ts:1317-1320 |
| 13 | PATCH_CONTRACT | design→mech dep, or any mechanical/author slice | prompt suffix | slice-orchestrator.ts:1417,1444 |
| 14 | Verify-command extract | backticked runner cmd | verifyCommands | slice-orchestrator.ts:481 |
| 15 | Verify-command probe | no text cmd | verifyCommands | packages/opencode/src/tool/graph-tools.ts:673 |
| 16 | Mutating-script skip | `--write/--fix/--watch/-w` | drops script | packages/opencode/src/tool/graph-tools.ts:657 |
| 17 | Test-tree guard | command-backed spec | prepends guard | slice-orchestrator.ts:538-542 |
| 18 | Wiring facts | every slice | `## Wiring` section | slice-wiring.ts:228-270 |
| 19 | Repo primer | child prompt | `## Repo primer` | slice-orchestrator.ts:1722 |
| 20 | Slice ledger | later waves | `## Established by…` | slice-orchestrator.ts:1757 |
| 21 | Upstream results | slice has deps | `## Upstream slice…` | slice-loop.ts:1111-1127 |
| 22 | Escalation brief | verifier reject → climb | 4 sections + objective | slice-loop.ts:503-539 |
| 23 | Judge prompt | judge-cell verification | session-less call | judge.ts:60-74 |
| 24 | System assembly order | every request | system[] composition | request.ts:64-72 |
| 25 | Plugin hook | `context.assemble.before` | plugin-injected system | request.ts:90-103 |
| 26 | Narrative-only localization flag | localization/plan fold-back, no probe run | prepends warning to relayed frame | prompt.ts:~2265 (`isProbeGrounded` :~160) |
| 27 | Probe-rung reproduction gate | pinned `probeCommand` still red | rejects rung `probe` | verifier.ts:515-533 (`checkProbeRung`), slice-orchestrator.ts:1454-1461 (pin) |
| 28 | Turn-close probe gate (M4) | pinned turn reproduction still red at turn-close | injects synthetic user nudge, re-enters loop | prompt.ts:1510-1560 (`runTurnProbeGate` call), slice-orchestrator.ts:578-610 |

---

## 7. Change record — the failure-mode prompt overhaul (2026-07-08)

This section records *what* changed and *why*; §1–§6 above already reflect the resulting
current state (code authoritative). The overhaul shipped in two waves on 2026-07-08 — **Wave 1**
(the prompt-content changes, §7.4) and **Wave 2** (the mechanism + refactor changes, §7.5) — all
wired unconditionally, with **no feature flags**. Deep evidence: the five research digests of
2026-07-08 (leaked Claude Code / Codex / Cursor / Gemini / OSS prompts) and
[ORCHESTRATION_MECHANISM.md](../architecture/ORCHESTRATION_MECHANISM.md) §2.2 (its **G5**).

### 7.1 Why this wave

Live use surfaced four failure modes that are **econ-specific**, not standalone-prompt-polish:

- **F1 — Format fidelity.** The model's coding logic is correct but its edit/patch output is
  malformed or misinterpreted.
- **F2 — Localization.** Bug exploration finds *symptoms*, not the *root cause*.
- **F3 — Orchestration support.** The tier/persona prompts don't reinforce the machinery in
  ORCHESTRATION_MECHANISM.md — the gap it now tracks as **G5** (the mechanism runs invisibly
  to the models that must cooperate with it).
- **F4 — Tool association.** Tools aren't confidently bound to the right action.

### 7.2 Root diagnosis — one cause behind all four

econ's cross-cutting discipline — edit-format fidelity, tool association, root-cause method,
honest reporting — was **absent from the shared base** (`default.txt`) and present only in
scattered, partial places: the `edit.txt` tool schema, the single `diagnosis-vague`
turn-shape seed, and the design→mechanical `PATCH_CONTRACT`. Nothing landed that discipline in
the cached prefix that **every** tier and persona actually reads.

### 7.3 The architecture principle adopted

From the research pass over leading coding-agent prompts:

- **One shared-discipline base + role-only deltas.** Anthropic ships a byte-identical base
  across sibling models with a tiny per-model delta; Codex forks one body via a
  `{{ personality }}` placeholder. So cross-cutting discipline belongs in the base (inherited
  by all tiers/personas), and each delta carries *role* only.
- **Effort is a numeric dial, not prose.** OpenAI's `o3-high` vs `o3-low` differ by one line
  (`# Juice: 512` → `32`), everything else byte-identical; output verbosity is a *separate*
  knob. → don't fork prompt *prose* per tier by capability; vary `reasoningEffort` + a
  verbosity cap. econ already keeps that dial single-sourced in `model-registry.ts` /
  `econ-defaults.ts` (drift-guarded), so the Wave-2 registry deliberately added **no** competing
  `knobs.ts` (§7.5).
- **Tool specifics live in the tool block, not the base.** Confirms `toolUsage()` (§5, surface
  drift-proofing) as the right home for the edit/write format contract.

### 7.4 Changes in this wave

| Change | File | Why | Fixes | Task |
|---|---|---|---|---|
| Base gains root-cause + edit-correctness + honest-reporting discipline; tool refs de-Claude'd to real ids | `default.txt` | put discipline in the cached prefix every tier/persona reads | F2·F4 | #1 |
| `toolUsage()` gains an `edit`/`write` branch (unique, verbatim, contiguous `oldString`; never elide the middle; write-vs-edit) | `system.ts` | the edit tool had zero format reinforcement outside its schema | F1·F4 | #1 |
| Reasoner gets its own delta (was `TIER_DELTA["reasoner"] = TIER_DELTA["oracle"]`) | `system.ts` | reasoner runs as a leaf slice; the oracle "delegate via `task`" line was dead/harmful | F3 | #1 |
| Conductor delta: containment-asymmetry + recon-one-shot warnings | `system.ts` | inline edits escape the revert bracket; `recon`/`verify` slices are one-shot, unrescued | F3 | #1 |
| `PATCH_CONTRACT` widened from design→mechanical only to **every** edit-emitting slice | `slice-orchestrator.ts` | plain mechanical/author/inline edits got no edit-format guidance | F1 | #2 |
| `design` added to the planner's handoff vocab | `slice-orchestrator.ts` | plans couldn't floor an irreducible design decision at the reasoner/oracle | F3 | #2 |
| Budget-settling clause rewritten to preserve the fork; evidence bar raised to a causal chain | `slice-orchestrator.ts` | the seed's "a partial localization beats a perfect one unwritten" authorized settling on a symptom | F2 | #2 |
| `diagnosis-grounded` "No broad exploration" fixed; build-turn localization cue added | `slice-orchestrator.ts` | root-cause discipline lived in only 1 of 5 turn shapes | F2 | #2 |
| Edit-tool errors made self-correcting; `edit.txt` doc drift fixed | `edit.ts`, `edit.txt` | for a low-reasoning OSS tier the thrown error is the only in-loop teacher | F1 | #3 |

> Note: Wave-2 #9 (below) later relocated the `system.ts` and `default.txt` prompt config into
> `session/prompts/`; the live anchors in §2–§5 point at that registry, while the table above
> records the file each change was first made in.

### 7.5 Wave 2 — the mechanism + refactor changes (landed 2026-07-08)

The design-sensitive tail of the overhaul. All three shipped, unconditional, no flags.

- **Localization narrative-only flag (#7)** — the localization/plan fold-back now runs
  `isProbeGrounded` (`prompt.ts`) and, when a result asserts a cause with no discriminating probe
  actually run, **prepends a warning** telling the conductor to run the probe itself before
  editing (§5.3, fold-back guard). Mechanism decision: **flag-and-continue** — no verify rung, no
  oracle escalation — chosen over enforce-at-tier and escalate-to-oracle because a spurious
  narrative costs far less than paying the top tier on every lazy localization, and the un-muted
  conductor absorbs the cheap probe. Observable-first; a hard verify rung stays a future,
  live-fire-gated option. Sharp edge: only the helper is unit-tested, the fold-back wiring is a
  trivial ternary.
- **Scope-miss contradiction trigger (#8)** — `reasoning-gate.ts` F4 gained a third shape
  (§5.1, F4b): a scoped search that succeeds but returns nothing under its named scope now
  un-mutes the conductor. Honest limit: the gate sees only the result shape and the query it
  recovers by `toolCallId`, never the model's hypothesis — a narrow, fail-closed subset (an
  explicit scope token is required), not general semantic-contradiction detection. Sharp edge: a
  prose slash in a freeform query (`retry/timeout`) can be misread as a path — a bounded over-fire
  that only adds thinking budget.
- **Prompt-config registry (#9)** — the base, tier/persona deltas, tool-usage block, and
  `select()` moved into `packages/opencode/src/session/prompts/` (`base.ts` · `roles.ts` ·
  `personas.ts` · `fragments.ts` · `assemble.ts` · `index.ts`); callers were updated with no
  re-export shim; emitted bytes unchanged (golden hash held). Two deliberate deviations from the
  original sketch: the registry lives **opencode-local**, not in `code-intelligence` (a Bun native
  text import can't cross the package boundary without a bundler rule), and there is **no
  `knobs.ts`** (the numeric effort dial is already single-sourced in `model-registry.ts` /
  `econ-defaults.ts` under a drift test — a second home would compete with it). This delivers the
  "single location to modify prompts" goal (§1).

### 7.6 Task #7's verification landing — the probe rung (2026-07-08)

A pinned-reproduction rung closes the loop the fold-back warning (§7.5 #7) could only flag: a
new `VerifySpec.probeCommand?: VerifyCommand` plus a "probe" rung in `runVerifierLadder`, via
the shared `checkProbeRung` helper (`packages/code-intelligence/src/verifier.ts`), reject a
bug-fix slice unless its own pinned reproduction transitions red→green — gating BOTH the
sound-accept path (a green generic `verifyCommands` list is not enough on its own) and the
untestable path; a broken build still rejects first, before the probe ever runs (§1.5's real
gating order: behavior-gate → sound → probe). `todosToLoopSlices`
(`packages/opencode/src/session/slice-orchestrator.ts`, §5.5) pins the most-specific
reproduction it can identify as `probeCommand` on every edit-emitting slice — ranking
`extractVerifyCommands`'s own output (no second extractor), falling back to a resolved
upstream dependency's content, and left unset when nothing identifiable exists (never
fabricated). The shared trailing sentence of `LOCALIZATION_SLICE_CONTENT` /
`PLANNER_SLICE_CONTENT` (§5.3) now also asks the generator to name each open probe as a single
runnable, backticked shell command — the exact string this rung later pins and re-runs.
Design-level treatment: [ORCHESTRATION_MECHANISM.md](../architecture/ORCHESTRATION_MECHANISM.md)
§1.5, §2.1, §2.2 (G5).
