# econ — System Architecture & Capability Narrative

**Status:** Design finalized 2026-06-24. econ is built on a forked, pinned open-source agent
shell (OpenCode) with our engine merged in and then diverged. This document describes the
architecture we have agreed to
build: a multi-tier model "team" with a mid-tier **conductor** that holds the working context,
a large-tier **oracle** consulted only with a compiled brief, and cheap **executors** that run
the high-frequency tool work — all sitting on top of a native context-intelligence layer (code
graph, anchored memory, edit-time guardrails, output compression, aggressive context pruning),
**long-horizon checkpointing** for 100–200-step tasks, and a library of specialist sub-agents
for the common flows of coding work.

It is written to be read two ways. The **plain-language framing** at the top of each section
is for product, business, and everyday users — what the capability is and why it matters. The
**Under the hood** subsections go technical for engineers building it.

> Companion docs: [README.md](../../README.md) (the vision) and the per-feature build docs in
> [../features/](../features/) (how each capability is built, with status). This doc is the
> *system design* those point at.

---

## 1. The one-paragraph version

Frontier coding agents are excellent and expensive, and most of that expense is waste: the
single most capable (and most costly) model is used for boring mechanical work, and the agent
reads far more code than it needs — studies put ~84% of an agent's tokens in tool output,
mostly file reads. **econ** removes both wastes natively. It runs a small *team* of
open-source models and routes each step to the cheapest one that can do it well, and it hands
each model only the slice of code that matters — found through a live map of the codebase
rather than by reading whole files. The result is a coding agent comparable to Claude Code /
Cursor at a fraction of the running cost, hosted in India, on open-source models.

---

## 2. The two beliefs everything is built on

1. **Use the cheapest capable model for each step — not one model for everything.** Paying the
   strongest model to fix a test or rename a symbol is paying a senior engineer to do data
   entry. econ's "team of models" makes the expensive brain a rarely-consulted specialist.
2. **Hand the model the right slice, not the whole repo.** Fewer, higher-signal tokens at every
   step is cheaper *and* more accurate — and it compounds with the cheaper models above.

These are not features bolted on later; they are the spine of the system. Everything in this
document serves one or both.

### The savings identity (state it honestly)

> **Cost = tokens × price, not calls × anything.**

This single line governs the whole economic case and corrects the most common mistake. "The
cheap model handles 80% of the *calls*" does **not** mean 80% savings. What sets the bill is
how many **tokens** — especially expensive output tokens and re-sent context — touch the
**expensive tier**. To first order:

> **cost reduction ≈ 1 − (the large model's share of total tokens)**

because the cheaper tiers are 100–200× cheaper per token and effectively round to zero beside
the large tier. So the entire engineering goal is: **keep tokens off the large model** — fewer
escalations, tighter briefs, and capped output. Section 12 works the numbers.

---

## 3. The model team — a conductor, an oracle, and executors

This is the finalized topology. Instead of "one model per session," or even a naïve
senior/worker/junior hand-off, econ uses **three roles**, and — critically — the *mid* tier
holds the working context while the *large* tier is consulted only when needed.

**In plain terms:**

- A **Conductor** runs the job from start to finish. It plans, decides the next step, reads
  results, and keeps track of where things are. It is a capable, fast, mid-sized model — good
  enough to drive almost everything.
- An **Oracle** is the expert you call only for the genuinely hard question. It never reads the
  whole conversation; it gets a tight, prepared *brief* and returns a decision, a plan, or a
  patch. This is the most expensive model, used the least.
- **Executors** do the high-volume manual work — fetch a file, run a command, apply an edit.
  They are small, cheap, fast, and stateless, and several can run at once.

```
┌───────────────────────────────────────────────────────────────────────┐
│  ORCHESTRATOR LOOP  —  deterministic code (the engine)                  │
│  owns the canonical state: task ledger · scratchpad · what's been tried │
│  ── persists to / queries the code-intelligence layer for slices ───────│
└───────────┬───────────────────────────────────┬──────────────────────-─┘
            │ default reasoning, every turn      │ escalate (compiled brief)
            ▼                                     ▼
   ┌──────────────────────┐            ┌────────────────────────────┐
   │  CONDUCTOR  (mid)    │            │  ORACLE  (large)           │
   │  ~30B, non-thinking  │            │  frontier / strongest OSS  │
   │  plans · decides ·   │            │  hard reasoning ONLY       │
   │  integrates results· │  ───────▶  │  in:  compiled brief       │
   │  WRITES the brief    │            │  out: decision/plan/patch  │
   └──────────┬───────────┘            └────────────────────────────┘
              │ dispatches tight, stateless instructions
              ▼
   ┌──────────────────────────────────────────┐
   │  EXECUTORS  (small) ×N — fan out in parallel│
   │  ~9B tool-callers: slice in → tool call →   │
   │  result out. No long context. Stateless.    │
   └──────────────────────────────────────────┘
```

**Why this shape and not the obvious one.** The naïve design makes the *cheapest* model hold
the context and drive the loop. That fails: a small model loses coherence over a long agentic
context, and — because the context (the re-sent transcript) is the bulk of the tokens — it
also puts the token mass on a model that derails, causing wasted work and escalations. Putting
the *mid* tier in the driver's seat fixes both: the small model is reduced to what it is
reliably good at (single, well-scoped tool calls), and the expensive model is reduced to a
consultant that never pays to carry context.

### Under the hood

**Roles and candidate models (pinned by eval, not assertion):**

| Role | Job | Holds context? | Candidate (2026) | Why |
|---|---|---|---|---|
| **Conductor** (mid) | Plan, decide next action, integrate results, build briefs | **Yes** (the canonical state lives in the engine; the conductor is the always-on reasoner over it) | a strong **non-thinking ~30B** (e.g. Qwen3-32B) | fast every-turn reasoning without per-turn chain-of-thought token tax |
| **Oracle** (large) | Hard design, deep debugging, ambiguous judgement | No — stateless, brief-fed | strongest available frontier / OSS reasoner | used rarely; output capped to a decision/patch |
| **Executor** (small) | Tool calls: read, search, run, edit | No — stateless | a tool-tuned **~9B** (e.g. Nemotron-class function-caller) | high tool-call reliability, cheap, parallelizable |
| **Reasoner mode** (occasional) | A genuinely hard *step* mid-job that doesn't need the full oracle | borrows conductor's state | a *thinking* distilled model (e.g. an R1-distilled 32B) **or** escalate straight to the oracle | reserve chain-of-thought for steps that need it; don't pay it every turn |

**State ownership — the rule that keeps it robust.** The model's context window must not *be*
the only memory. The **canonical state** (task ledger, scratchpad, history of attempts) lives
in the engine and the code-intelligence layer (Section 6); the conductor's window is a *cache*
of that state, refilled each step. This survives compaction, crashes, and tier hops, and lets
the conductor stay sticky for caching (Section 9).

**Surviving the long haul — checkpoints.** Because the canonical state lives outside the model
window, a long job (100–200 steps) need not fit in one context. As the conductor's window fills
(tracked at rising thresholds), the engine **checkpoints**: a sub-agent distils the run so far
into a compact, structured summary — task tree, decisions made, open threads — while the most
recent turns are kept verbatim; the window is then rebuilt from that checkpoint plus the live
slice, so the task continues coherently instead of degrading or blowing up. This is the
"state is a cache of the store" rule applied across *time*, and it is what lets econ run
ultra-long tasks a single-window agent cannot. (See
[../features/05-long-horizon.md](../features/05-long-horizon.md) for how it is built.)

**The compiled brief — the new load-bearing artifact.** The oracle never sees the raw
transcript. The conductor (helped by the code graph) distills:

```
BRIEF := problem statement
       + the minimal code slices that matter   (from the code graph — Section 5)
       + what has already been tried and failed
       + the precise decision / question needed
       + the requested OUTPUT SHAPE             (a patch? a plan? a yes/no + reason?)
```

Brief quality now determines whether an expensive call pays off. A lossy brief → the oracle
answers the wrong question → money spent for nothing. Two mitigations: (1) the *code graph*
selects the slices (call-graph-driven, not the model guessing), and (2) the oracle is allowed
to reply "insufficient context, send me X" instead of guessing.

---

## 4. The router — deciding when to spend more

**In plain terms:** the agent itself decides what's hard. It does the work cheaply by default
and only "phones the expert" when the change is genuinely risky or the cheap attempt isn't
confident. The user never has to pick a model.

**The key idea — escalate on *code risk*, not on the prompt.** Most cheap routers guess
difficulty from the text of the request ("this prompt is long, use the big model"). That is
commoditized and blind to the code. econ escalates based on what a change would actually *do to
the codebase*.

### Under the hood

This is econ's risk-escalation router (the moat — see also
[../features/03-risk-router.md](../features/03-risk-router.md)):

- **Signal = the graph, not the text.** Blast-radius / fan-in, call-graph centrality,
  cyclomatic complexity → one **0–100 risk score**. (A model-routing proxy cannot compute this;
  it can't see the code structure. That's why it's defensible.)
- **Escalate to the oracle when:** the score is over the upper band, **or** the conductor's
  verifier *abstains* (an explicit "I'm not sure" signal, not a confidence guess), **or**
  per-repo triage says cheap doesn't pay here.
- **Hysteresis (two bands, e.g. 70 / 40):** a score between the bands changes nothing, so one
  noisy reading can't flap the tier turn-to-turn.
- **Triage go/no-go (per repo):** only stay cheap if `cheapPassRate > 1 / interTierCostRatio`
  **and** the risk signal actually discriminates; else force the oracle. Don't pretend to save
  when the savings won't cover the rework.
- **Charge the double-pay:** every escalation = a cheap attempt **plus** an oracle attempt;
  subtract it from the savings math or the numbers lie.
- **Degrade open:** any missing signal / failed lookup → cheap tier. Routing is an
  optimization; it must never crash a turn.

```
            ┌─────────────────────────────────────────────┐
   turn ──▶ │ compute risk score from the code graph        │
            │ (blast-radius · fan-in · centrality · cx)     │
            └───────────────┬─────────────────────────────-─┘
                            ▼
        score < 40 ──────────────────────────▶ CONDUCTOR handles it (cheap)
        40 ≤ score ≤ 70 ──▶ hysteresis: keep current tier (no flap)
        score > 70 ──┐
        OR verifier abstains ──┐
        OR triage: cheap won't pay ──┐
                                     ▼
                          build brief ─▶ ORACLE ─▶ integrate ─▶ continue
                          (record the double-pay in the receipt)
```

---

## 5. The context engine — hand over the right slice

This is belief #2 made real, and it is **native** to econ, not a plugin the agent has to
remember to call. Before the agent reads anything, the engine already knows the shape of the
codebase and hands over the 50 lines that matter instead of 3,000.

**In plain terms:** econ keeps a live *map* of your code — every function, what it calls, and
everything that depends on it. So when the agent needs to understand or change something, one
lookup returns the exact piece plus its blast radius, instead of the agent grepping and reading
file after file (the thing that burns ~84% of a normal agent's tokens).

### Under the hood

A live, in-process **code graph** is the substrate the whole agent runs on:

- **Graph navigation.** tree-sitter parsing + verified call data across 18+ languages, with
  sub-5ms lookups. One query returns an entity, its body, its callers, and its callees —
  replacing 5–15 file reads.
- **Single-call recon.** For any task, one "recon" call returns a *bundle*: the relevant
  entities' bodies + their callers (blast radius) + applicable conventions + anchored memory —
  collapsing the search → read → search fan-out into one round-trip. The conductor edits from
  the bundle; it only does a raw file read for source the bundle didn't inline.
- **Optimal, function-targeted reads.** Read one symbol, not a whole file; exact string/regex
  search returns matches *with surrounding context* so there's no follow-up read; and the read
  size is set right the first time (no read-small-then-re-read doubling).
- **Semantic + syntactic edges.** Both how the code is structured (calls, imports, definitions)
  and what it *means* (a lightweight domain/role annotation on each exported entity), so the
  agent reasons over meaning, not just text.

**Aggressive context pruning & text compression** ride on top of the graph:

- **Output trimming.** Long command output and file reads are trimmed to the slice the agent
  needs (hundreds of command types are understood structurally, not by naïve truncation).
- **Web fetch compression.** Pages are fetched as DOM-extracted markdown, BM25-ranked to the
  query, at 5–10× less bulk than a raw fetch, with a content-hash cache.
- **Context pruning for the conductor.** Because the canonical state lives outside the model
  window (Section 3), the engine refills the conductor's window each step with only the
  *currently relevant* slice — pruning stale tool output, superseded reasoning, and
  already-integrated results so the window stays dense with signal rather than growing
  unboundedly.

> **Fidelity gate.** Every compression/pruning step is measured against a fidelity check that
> discards any "saving" that lost the answer. We count savings; we don't promise them.

---

## 6. Memory — the agent remembers your repo across sessions

**In plain terms:** econ remembers what it learned about your codebase — the conventions you
follow, the decisions you made, the thing that broke here last time — and brings the relevant
note up at the moment it's about to touch that code, even weeks later and even after the code
has moved. You don't maintain a rules file; the agent maintains its own.

### Under the hood

**Anchored memory** is memory tied to code, not a flat document:

- **Typed, anchored notes.** Each note has a *kind* (convention, rule, warning, decision,
  blocker, fact), an *anchor* (a file, an entity, a glob, or project-wide), and a *polarity*
  (do / don't / mixed). Because notes are pinned to real code, when that code moves the note is
  re-anchored automatically; when it drifts out of sync, the note flags itself instead of
  quietly going wrong.
- **Conventions detected automatically.** Once a pattern holds across the codebase (a strong
  majority of the time), it becomes an enforced convention without anyone writing it down.
- **Confidence that decays.** Facts lose confidence over time unless reinforced, so stale
  memory fades rather than misleading.
- **Four-moment lifecycle, zero extra round-trips.** Notes are injected when a prompt arrives,
  folded into the recon bundle when the agent identifies what it will touch, cited in the plan
  when load-bearing, and saved at task end — the save rides a sentinel line in the closing
  message that a hook scrapes, so persistence costs no tool call.
- **Cross-session continuity.** A timeline + ledger of every tool call powers a "resume strip"
  so a new session picks up where the last left off.

This memory is also what makes the **conductor** cheap to keep stateless-in-window: the durable
knowledge is in the store, not the context.

---

## 7. Guardrails — catch the break before it lands

**In plain terms:** before econ makes a change, it checks what *else* that change would affect.
If you're about to alter a function that 24 other places depend on, it surfaces all 24 — and
fixes them in the same change — instead of breaking them silently. This is the safety a careful
senior engineer provides, applied automatically on every edit.

### Under the hood

This is the **in-loop governance gate** — and "in-loop" is the whole point. It fires **at the
edit**, inside the agent's execution path, where it *cannot be skipped* — not as an optional
tool the model might call, and not as a review after the fact. (A proxy or MCP-only layer
structurally cannot do this; it only sees requests the model chooses to make.)

The gate fires a combination of checks at the moment of the edit:

- **Breaking-change guard** — surfaces every caller a signature change would break, *before* it
  lands, so they're all updated in the same turn.
- **Blast-radius / centrality check** — feeds the router (Section 4) and flags
  high-consequence edits.
- **Boundary / architecture guard** — flags edits that cross an architectural boundary they
  shouldn't.
- **Convention-slip guard** — flags new code drifting from an established pattern.
- **Drift re-anchor** — keeps anchored memory (Section 6) attached as code moves.
- **Retry-loop breaker** — sees the full history of what the agent already tried this session
  and halts a doom-loop instead of burning tokens on the same failing approach.

Each of these needs information no single point-tool has alone (the edit *and* its dependents,
the rule *and* the code it's about, the session's full attempt history) — which is exactly why
they are native to the engine, computed directly with **zero AI calls per check**.

---

## 8. Specialist sub-agents — a library for the known flows of coding

**In plain terms:** a lot of coding work follows well-known shapes — writing tests, fixing
lint, renaming something everywhere, "go find X," generating docs. econ ships a set of
purpose-built *specialist sub-agents* for these, each running on the cheapest tier that fits,
each in its own scratch context so the main job stays focused. The conductor hands a flow to a
specialist and reviews the result.

**Why sub-agents (not just "the cheap tier").** A sub-agent runs in its **own context window**,
so (a) the conductor's main thread isn't polluted with the specialist's intermediate work, and
(b) several specialists run **in parallel**. Broad, independent, or repetitive work is exactly
what should leave the main thread.

### Under the hood

A curated library, each entry pinned to a tier and given only a task + a one-line pointer (it
re-derives its own edit sites from the code graph — never paste it files):

| Flow / process | Specialist tier | What it does |
|---|---|---|
| **Recon / "go find X" / trace** | Executor (small) | read-only investigation; returns a digest, not file dumps |
| **Lint / format** | Executor (small) | run the formatter/linter; apply mechanical fixes |
| **Docstrings / domain annotations** | Executor (small) | write/refresh doc comments + domain/role tags |
| **Test authoring / repair** | Worker (mid) | add or fix tests; needs some judgement |
| **Multi-site mechanical refactor** | Worker (mid) | rename / extract / inline / move across all call sites |
| **Codemod / migration** | Worker (mid) | apply a transform across many files in one pass |
| **Dependency / import repair** | Worker (mid) | fix imports and broken references after a change |
| **Bug reproduction** | Worker (mid) | build a minimal repro before the conductor root-causes |
| **Code review** | Conductor/Oracle | adversarial review of a proposed diff before it lands |

**Orchestration rules (the cost-aware part):**

1. **Batch first, then fan out.** Group related work; spawn one specialist per independent
   group in a *single* dispatch so they run concurrently.
2. **Never loop the main thread file-by-file** over mechanical edits — that's what a specialist
   loop (or a single codemod command) is for. Prefer, in order: one command for the whole set →
   one script → a sub-agent loop.
3. **Review every result before building on it.** Specialists do the work; the conductor owns
   correctness.

These specialists are *delegation* — an axis that layers on top of the conductor/oracle spine.
The two-tier cheap/oracle loop ships first; the specialist library expands behind it (see
[../features/04-model-team.md](../features/04-model-team.md)).

---

## 9. Caching, at every layer

Caching is not one thing in econ; it's a discipline applied at every layer where a repeat
computation or a re-sent token can be avoided. The model-inference cache is the expensive one
and the topology is designed to protect it. (§11.1 maps where each cache physically lives.)

**In plain terms:** econ avoids paying twice. It re-uses the model's "warm" memory of the
conversation, re-uses code lookups, re-uses fetched pages, and re-uses what it learned in past
sessions — so repeated work is cheap or free.

### Under the hood

| Cache | What it holds | How econ exploits it |
|---|---|---|
| **Prompt / KV cache** (per-model, per-provider) | the model's processed prefix of the conversation | Cache **reads** bill at ~0.1× input; the **sticky conductor** (Section 3) keeps its prefix warm turn-over-turn so re-sent context bills at cache-read rates instead of full price |
| **Code-graph cache** | parsed entities, call edges | in-process DB, sub-5ms lookups, incrementally re-indexed by a file watcher — no re-parse per query |
| **Recon-bundle reuse** | bodies + callers + conventions already delivered | the agent edits from the inlined bundle and does **not** re-read source already handed to it |
| **Web-fetch cache** | DOM-extracted, ranked page content | content-hash keyed; a repeat fetch is served from cache |
| **Cross-session memory** | anchored facts & conventions (Section 6) | the durable "cache" of repo knowledge — no re-learning each session |

**The cache trap the topology avoids.** Every model has its *own* KV cache; **switching models
mid-conversation discards it.** A design that ping-pongs tiers turn-by-turn keeps re-paying full
input price. econ avoids this two ways: (1) the **conductor stays sticky** — it drives
consecutive turns, so its cache stays warm; (2) the **oracle gets a fresh small brief** each
time (no cache to lose, because the brief is small by construction); (3) **executors are
stateless** (no cache needed). So the expensive cache is preserved exactly where the token mass
is.

> **Day-0 verification gate (carried over from the build plan):** confirm `cache.read` /
> `cache.write` are actually reported on our provider path before trusting any savings number —
> the math is only as honest as those two counters.

---

## 10. How it all fits together

```
        ┌──────────────────────────────────────────────────────────────┐
        │                       USER (TUI / editor)                      │
        │     plan view · live tool/edit render · status line · receipt  │
        └───────────────────────────┬──────────────────────────────────┘
                                     │ HTTP API
        ┌───────────────────────────▼──────────────────────────────────┐
        │                    econ BACKEND (the engine)                   │
        │                                                                │
        │   ┌───────────────────────────────────────────────────────┐  │
        │   │  ORCHESTRATOR LOOP  (canonical state, deterministic)    │  │
        │   └───┬───────────────┬───────────────────┬───────────────-┘  │
        │       │ route          │ context           │ govern             │
        │   ┌───▼─────┐    ┌────▼──────────┐   ┌────▼──────────────┐    │
        │   │ RISK-   │    │ CONTEXT ENGINE │   │ GOVERNANCE GATE   │    │
        │   │ESCALATE │    │ code graph ·   │   │ breaking-change · │    │
        │   │ ROUTER  │    │ recon bundle · │   │ blast-radius ·    │    │
        │   │(§4)     │    │ compression ·  │   │ boundary · drift ·│    │
        │   └───┬─────┘    │ pruning  (§5)  │   │ loop-breaker (§7) │    │
        │       │          └───────┬────────┘   └───────────────────┘    │
        │       │                  │ in-process call (same engine)        │
        │       │          ┌───────▼─────────────────────────────────┐  │
        │       │          │ CODE-INTELLIGENCE  (in-process module)    │  │
        │       │          │ live code graph · anchored memory (§6) · │  │
        │       │          │ conventions · compression · telemetry    │  │
        │       │          └─────────────────────────────────────────┘  │
        │       ▼                                                         │
        │   MODEL TEAM (§3):  CONDUCTOR ──brief──▶ ORACLE                 │
        │                         └── dispatch ──▶ EXECUTORS ×N           │
        │                         └── delegate ──▶ SPECIALIST SUB-AGENTS (§8)
        └───────────────────────────┬──────────────────────────────────┘
                                     │
        ┌───────────────────────────▼──────────────────────────────────┐
        │     MODEL ENDPOINTS — OSS, India-hosted, OpenAI-compatible      │
        │     (self-hosted vLLM / in-region serving), per-tier swappable  │
        └────────────────────────────────────────────────────────────────┘
```

**A turn, end to end:**

1. **Prompt arrives.** Anchored memory for the touched code is injected; the conductor reads it.
2. **Recon.** One call to the context engine returns the relevant slices + callers +
   conventions (no fan-out of file reads).
3. **Route.** The router scores code-structural risk. Low → the conductor proceeds. High /
   abstain / triage → the conductor compiles a brief and consults the oracle.
4. **Act.** The conductor dispatches tool calls to executors (in parallel) and/or delegates a
   known flow to a specialist sub-agent; it integrates the results.
5. **Govern.** Before any edit lands, the governance gate fires — breaking callers, blast
   radius, boundary, drift, loop-breaker. Breaking changes are surfaced and fixed in the same
   turn.
6. **Account.** Per-message usage (tokens, cache read/write, tier, $ vs a frontier baseline)
   flows to telemetry; the turn closes with a savings receipt and any new memory is persisted.

> The message-by-message execution trace, the KV-cache lifecycle, and the hook fire-points
> behind these six steps are detailed in §11.

---

## 11. Execution internals — caches, state, hooks & round-trip reduction

This section is the machine room. It answers four concrete questions: **where does each
model's KV cache physically live, where do the graph / memory / guardrails sit relative to the
models, how do hooks drive the always-on behavior, and how does the design cut the number of
times we call an LLM at all** — ending with a full execution trace.

### 11.1 Where everything lives — the process & memory map

**In plain terms:** the three models each have their own *short-term memory* (a KV cache). The
*long-term brain* — the code map, the remembered facts, the guardrail checks — is a separate
component that sits **beside** the models, not inside them, and is fed into the model at the
right moment.

```
  ┌─────────────┐
  │  TUI / IDE  │
  └──────┬──────┘
         │ HTTP
┌────────▼──────────────────────────────────────────────────────────────────┐
│ econ ENGINE  (ONE process — orchestrator + code-intelligence together)      │
│  ┌───────────────────────────────────────────────────────────────────┐    │
│  │ ORCHESTRATOR LOOP                                                   │    │
│  │   • canonical state: ledger · scratchpad · attempt history          │    │
│  │     (in-process + persisted — NOT inside any model's window)         │    │
│  │   • lifecycle HOOKS fire here  (see §11.4)                           │    │
│  └───────┬───────────────────────────────────────────────────────────-┘    │
│          │ in-process call (0 AI calls, <5ms)                                │
│  ┌───────▼───────────────────────────────────────────────────────────┐    │
│  │ CODE-INTELLIGENCE MODULE  (in-process — the "long-term brain")      │    │
│  │ deterministic, zero AI calls                                        │    │
│  │   • live code graph     (in-process graph DB)                       │    │
│  │   • anchored memory     (facts/rules)                               │    │
│  │   • conventions         (auto-detected)                             │    │
│  │   • guardrail logic     (blast-radius…)                             │    │
│  │   • compression         (output/web)                               │    │
│  │  state lives HERE, beside the loop, injected INTO context by hooks  │    │
│  │  — never baked into weights or any model's window                  │    │
│  └────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────┬─────────────────────────────────────────┘
                                    │ model calls (network)
                  ┌─────────────────▼─────────────────────┐
                  │ MODEL ENDPOINTS  (OSS, in-region)      │
                  │ each endpoint owns its OWN KV cache     │
                  │  ┌────────────┐   KV: ███ WARM/sticky   │
                  │  │ CONDUCTOR  │   held turn-to-turn     │
                  │  └────────────┘                         │
                  │  ┌────────────┐   KV: ░░░ COLD          │
                  │  │ ORACLE     │   fresh brief each call  │
                  │  └────────────┘                         │
                  │  ┌────────────┐   KV: ·   EPHEMERAL     │
                  │  │ EXECUTOR×N │   stateless, discarded  │
                  │  └────────────┘                         │
                  └────────────────────────────────────────┘
```

The load-bearing point: **the graph, memory, conventions, and guardrails are not in the model.**
They live in an **in-process module beside the loop** (not a separate process), are computed
directly (no inference, sub-5ms), and are *injected into the prompt at the right moment* by
hooks (§11.4). The model stays small and cheap because it doesn't have to *hold* the repo —
it's *handed* the relevant slice each step.

### 11.2 The KV cache, tier by tier

**In plain terms:** the conductor's short-term memory stays *warm* because it drives turn after
turn, so re-sent context is cheap; the oracle starts *cold* every time but only ever gets a tiny
brief; the executors keep no memory at all.

```
 turn →      T1          T2          T3 (escalate)     T4
 CONDUCTOR   ███▶────────███▶────────███▶─────────────███     warm prefix reused → cache READ ≈0.1× input
 ORACLE      ·           ·           ░░░ (one call)    ·       cold each call; brief is tiny — nothing to reuse
 EXECUTOR    ·· ·· ··    ·· ··       ·· ··             ·· ·    spun up per call, KV discarded after
             ▲ stateless tool calls, run in parallel
 legend:  ███ warm/sticky KV    ░░░ cold KV    · none
```

| Tier | KV cache lifetime | Hit pattern | Billing effect |
|---|---|---|---|
| **Conductor** | sticky across the whole job | re-reads its warm prefix every turn | bulk of re-sent context bills at **cache-read (~0.1×)** |
| **Oracle** | cold per call | none — fresh brief each time | full price, but on a *tiny* input by construction |
| **Executor** | ephemeral | none — stateless | trivial; tiny prompts, cheapest tier |

Two engineering rules fall straight out of this:

1. **Cache-friendly prefix ordering.** Put the stable parts first — system prompt → tool
   definitions → conventions → durable context — and the volatile parts last. The provider caches
   the longest unchanged prefix, so a stable ordering maximizes the cache-read hit on every turn.
2. **Don't ping-pong tiers.** A model switch invalidates the KV cache (each model has its own).
   Keep the conductor driving consecutive turns; send the oracle a self-contained brief instead
   of handing it the conductor's conversation.

### 11.3 Where the graph, memory, and guardrails sit (and why outside the model)

Per §11.1, all three live in the **in-process code-intelligence module**, reached by a direct
in-process call (no socket, no separate process):

- **Graph** — the parsed call graph; answers "what is this and what depends on it" in <5ms.
- **Memory** — anchored, typed notes (§6) pinned to graph nodes; re-anchored as code moves.
- **Guardrails** — the governance checks (§7); each needs the graph *and* the pending edit *and*
  the session history at the same instant, which is why they can't be five separate plugins.

They are **deterministic and computed with zero AI calls**, then *pushed into* the model's
context by hooks. This is the difference between a *fact the agent is handed* and a *tool the
agent must remember to call* — and it's why these behaviors are reliable instead of optional.

### 11.4 Hooks — the always-on spine

**In plain terms:** hooks are small triggers that fire automatically at key moments of a turn,
so the smart thing happens on its own — the model never has to remember to ask for it.

```
        ┌────────────────── ENGINE TURN LIFECYCLE (hook fire-points) ──────────────────┐
USER ─▶ │ ① onPromptSubmit ──────▶ ② onContextAssemble ──────▶ [ model plans ]          │
PROMPT  │    inject anchored mem      fold in graph slices                               │
        │    capture "remember…"      + conventions                                      │
        │                                                                                │
        │   ┌── per tool call ───────────────────────────────────────────────┐          │
        │   │ ③ onPreToolUse ──▶ [ tool runs ] ──▶ ④ onPostToolUse            │          │
        │   │    validate args      read / run / edit    compress output,      │          │
        │   │    redirect a raw                          inject conventions    │          │
        │   │    read → graph read                       on first read         │          │
        │   └──────────────────────────────────────────────────────────────-─┘          │
        │                                                                                │
        │   ⑤ onPreEdit ── GOVERNANCE GATE (un-skippable) ──▶ block / fix-all-callers     │
        │      breaking-change · blast-radius · boundary · drift · retry-loop-breaker     │
        │                                                                                │
        │   ⑥ onTurnStop ──▶ persist memory markers · emit savings receipt · telemetry    │
        └────────────────────────────────────────────────────────────────────────────-─┘
```

| Hook | Fires when | What it does | Saves |
|---|---|---|---|
| ① `onPromptSubmit` | a user prompt arrives | inject relevant anchored memory; capture user rules ("remember…", "always…") | a recall round-trip |
| ② `onContextAssemble` | before the conductor plans | fold the recon bundle (graph slices + callers + conventions) into context | the search→read fan-out |
| ③ `onPreToolUse` | before any tool runs | validate the tool-call schema; redirect a raw whole-file read to a targeted graph read | a malformed-call retry + an oversized read |
| ④ `onPostToolUse` | after a tool returns | compress/trim the output; inject detected conventions on first touch | output-token bloat |
| ⑤ `onPreEdit` | before an edit lands | the governance gate — breaking-change, blast-radius, boundary, drift, loop-breaker | a whole broken-callers cleanup turn |
| ⑥ `onTurnStop` | the turn closes | persist memory; emit the savings receipt | a separate "save what we learned" turn |

**"…if not native utilities."** Hooks are leveraged two ways, and econ does not *depend* on a
host providing them:

- **On a host that has a hook system** (e.g. a Claude Code-style `UserPromptSubmit` /
  `PostToolUse` / `Stop`), econ registers handlers at those points.
- **In econ's own backend, we own the turn and tool execution path**, so these are implemented
  as **native engine lifecycle events** — no host dependency. This is strictly better: the
  governance gate (⑤) fires *inside our loop*, where the model structurally cannot skip it. A
  proxy or MCP-only layer can't do this, because it only sees the requests the model chooses to
  send.

The deep idea: hooks make the smart behaviors **push-based** (they fire on their own) rather
than **pull-based** (a tool the model must elect to call). Push-based means zero reliance on the
model remembering — and, because the context arrives *with* the turn, **zero extra LLM
round-trips** to fetch it.

### 11.5 How LLM round-trips collapse

**In plain terms:** the slow, costly part of an agent is going back to the model again and again,
re-sending the whole conversation each time. econ asks the model far fewer times.

```
TYPICAL AGENT  (pull-based, sequential)            econ  (push-based, batched, parallel)
──────────────────────────────────────            ─────────────────────────────────────
prompt                                             prompt
  └▶ LLM: "I'll grep…"        ⟲ round-trip 1         └▶ hook injects memory + conventions   (0 LLM)
  └▶ grep                                            └▶ engine recon bundle: slices+callers (0 LLM)
  └▶ LLM: "read file A"       ⟲ round-trip 2         └▶ LLM: plan + act on the bundle       ⟲ rt 1
  └▶ read A                                          └▶ executors ×N  (one parallel wave)   ⟲ rt 2
  └▶ LLM: "read file B"       ⟲ round-trip 3         └▶ [if risky] brief ▶ ORACLE once      ⟲ rt 3
  └▶ read B                                          └▶ govern + apply edit                 (0 LLM)
  └▶ LLM: "read file C"       ⟲ round-trip 4
  └▶ … 5–15 SEQUENTIAL LLM round-trips,             ≈3 round-trips; context PUSHED in,
     context re-sent at FULL price each time           conductor cache WARM (read ≈0.1×)
```

| Reducer | Mechanism | Round-trips: before → after |
|---|---|---|
| **Recon bundle** | one engine call returns bodies + callers + conventions | 5–15 sequential read-turns → **1** |
| **Push-based context** | hooks inject memory/conventions/compression | model calls a memory/search tool → **0** (injected) |
| **Parallel executors** | independent tool calls fan out at once | N sequential → **1 wave** |
| **Brief-fed oracle** | one self-contained consult, output capped | iterative back-and-forth → **1** |
| **Warm conductor cache** | sticky prefix across turns | the remaining round-trips bill at **~0.1×** instead of full |

The two effects compound: **fewer round-trips × cheaper tokens per round-trip.** That product is
the savings number in §12, not the call-count.

### 11.6 End-to-end execution trace

A single turn, message by message, with hook fires (①–⑥) and KV-cache state annotated:

```
User   Engine(Conductor)    Code-intel(graph/mem)   Executors    Oracle    Govern   Telem
 │ prompt │                         │                   │           │         │        │
 ├───────▶│ ① onPromptSubmit        │                   │           │         │        │
 │        ├── inject memory ───────▶│  (0 AI, <5ms)     │           │         │        │
 │        │◀─ notes + conventions ──┤                   │           │         │        │
 │        │ ② recon bundle ────────▶│                   │           │         │        │
 │        │◀─ slices + callers ─────┤                   │           │         │        │
 │        │════ LLM plan ════════▶ CONDUCTOR   (rt1 · KV READ, warm)          │        │
 │        │ ③ onPreToolUse → dispatch tool calls ──────▶│           │         │        │
 │        │   (one parallel wave, rt2) ◀── results ─────┤           │         │        │
 │        │ ④ onPostToolUse: compress/trim results      │           │         │        │
 │        │ risk score ────────────▶│  high → escalate  │           │         │        │
 │        │ build BRIEF ════════════════════════════════════════▶ ORACLE  (rt3 · KV cold)
 │        │◀═ decision / patch ═════════════════════════════════════ ┤        │        │
 │        │ ⑤ onPreEdit ───────────────────────────────────────────────────▶│        │
 │        │◀─ ok  /  "fix N callers first" ────────────────────────────────-─┤        │
 │        │ apply edit                                                        │        │
 │        │ ⑥ onTurnStop: usage + tier split + $saved ───────────────────────────────▶│
 │◀─ result + savings receipt ──┤                                                      │
```

Read it as the proof of the two prior subsections: most arrows into the **code-intel module**
are free (0 AI calls); the only paid LLM round-trips are the three marked `rt1–rt3`; `rt1`/`rt2` hit the
**warm** conductor cache; `rt3` is the single **cold** but tiny oracle consult; and the
governance gate (⑤) sits on the critical path where it cannot be bypassed.

### 11.7 Research-grade diagrams (LaTeX / TikZ)

Yes — compilable, standalone **TikZ** versions of the key figures live alongside this doc for
use in papers, posters, and slides:

| File | Figure |
|---|---|
| [`diagrams/econ-architecture.tex`](./diagrams/econ-architecture.tex) | the process & memory map of §11.1 (engine · in-process code-intel · per-tier KV caches) |
| [`diagrams/econ-roundtrip.tex`](./diagrams/econ-roundtrip.tex) | the round-trip-collapse comparison of §11.5 (typical agent vs econ) |

Each uses only `standalone` + `tikz` (no exotic packages). Build either with:

```bash
pdflatex docs/architecture/diagrams/econ-architecture.tex   # → econ-architecture.pdf
# or, for SVG/PNG embedding:
pdflatex econ-architecture.tex && pdf2svg econ-architecture.pdf econ-architecture.svg
```

A TikZ/`pgf-umlsd` version of the §11.6 sequence trace can be added on request.

---

## 12. The economics — what this actually saves

**In plain terms:** because the expensive model is consulted rarely and with a small brief,
while a cheap mid-sized model does the driving and tiny models do the manual work, the running
cost lands roughly **3–6× lower than using a top frontier model for everything — and up to
~8–10× lower when the cheap tiers are self-hosted in-region**, with quality held by routing the
genuinely hard parts to the strong model.

### Under the hood

Recall the identity from Section 2: **reduction ≈ 1 − (large-tier token share)**. The conductor
topology is built precisely to shrink that share, because the token *bulk* (re-sent context)
now lives on the cheap mid tier, and the oracle only ever sees small briefs.

Per 1M tokens of total throughput, a representative split for the conductor topology:

| Tier | Token share | Price ($/M, blended) | Cost |
|---|---|---|---|
| Conductor (mid, holds context) | ~65% | ~$0.40 (self-hosted) | $0.26 |
| Executors (stateless tool calls) | ~25% | ~$0.05 | $0.01 |
| Oracle (small briefs, output-heavy) | ~10% | ~$20* | $2.00 |
| **Total** | | | **~$2.27 / M** |

\* the oracle's brief is small *input* but its answer is *output*-heavy (output ≈ 5× input
price), which is why even a 10% token share is ~88% of the bill.

Against a top-tier frontier model used for everything (blended ≈ $10/M), that's **~77%
reduction (≈4.4×)**; self-hosting the conductor and executors drives their marginal cost toward
electricity, so the bill approaches the oracle alone and the reduction reaches **~85–90%
(≈7–10×)**.

**What moves you within the band — the levers, in priority order:**

1. **Escalation frequency.** Every oracle call is the dominant line item. Fewer, better-targeted
   escalations (good risk signal + hysteresis) is lever #1.
2. **Brief tightness + capped oracle output.** Ask the oracle for a decision/patch, not an
   essay. Output tokens are the expensive ones.
3. **Cache stickiness.** Keep the conductor driving consecutive turns; don't ping-pong tiers
   (Section 9).
4. **Escalation churn / double-pay.** A cheap attempt that fails then re-runs on the oracle pays
   twice; hysteresis, abstention, and triage bound it — and the receipt charges it honestly.
5. **Small-model reliability.** A derailed executor wastes tokens *and* triggers an escalation;
   tight slices (Section 5) and tool-call validation keep executors on rails.

**Two honesty notes.** (1) The fair baseline is the frontier model *with prompt caching*, which
is cheaper than naïve — so we quote the realistic 3–6× before self-hosting, not a headline. (2)
A budget *cloud* small model can be cheaper than self-hosting a small model on CPU; econ's
in-region / self-hosted choice is justified by **data residency and latency for the Indian
market**, not solely by raw token price. We say so plainly.

---

## 13. What the user sees (the product surface)

Cost visibility is the **proof behind the pitch**, so it's a first-class surface, not an
afterthought:

- **Live status line** — context fill, cache-hit ratio, the tier currently in use.
- **End-of-turn receipt** — named, countable catches ("changed a function 24 places depend on;
  updated all 24"), tier split (cheap vs oracle), cache-hit ratio, and **$ saved vs a frontier
  baseline** — measured from real usage data, with double-pay subtracted.
- **One continuous thread** — memory and the resume strip carry repo knowledge across sessions.

The principle: **count savings, don't promise them.** Every compression, route, and catch
reports what it actually did.

---

## 14. The market — why now, the moat, and the field

**In plain terms:** Almost every coding agent today rents the same handful of frontier
models, hosted in the US or China and billed per token at frontier prices. That single
arrangement is now fracturing on two faults at once: it can be **switched off** for
reasons that have nothing to do with you, and it is **expensive enough to drain a budget
in a quarter**. econ is built for the side of that fracture that wants to *own* its
agent — self-hosted, in-region, cheap by construction, and useful even when the frontier
API is unavailable.

```
   THE CENTRALIZED-API FAULT LINE
   ┌──────────────────────────────────────────────────────────┐
   │ one cloud frontier API  ── billed per token, frontier $   │
   │ hosted US / CN          ── one switch you don't control   │
   └───────────────┬──────────────────────────┬───────────────┘
                   │ cost fault               │ disruption fault
        $2k/dev/mo, budget gone in 4mo    global suspension overnight
                   │                          │
                   ▼                          ▼
   ┌──────────────────────────────────────────────────────────┐
   │ econ: self-hosted OSS team, in-region, cheap by design,   │
   │ degrades to your own infra — not someone else's directive │
   └──────────────────────────────────────────────────────────┘
```

### 14.1 The problem is real — and happening now

Two recent events make the case better than any projection:

- **Disruption / geopolitical risk.** In mid-June 2026 Anthropic abruptly suspended
  *global* access to its Mythos 5 and Fable 5 models — reportedly under a US government
  directive concerning foreign-national access, tied to a codebase-flaw "jailbreak"
  concern. Because foreign and domestic users couldn't be separated in real time, the
  shutdown was worldwide: millions of developers and enterprise workflows lost their agent
  overnight. Any pipeline that hard-depends on one cloud frontier API inherits that
  switch — and the switch can be thrown for reasons entirely outside the customer's
  control.
- **The cost crisis.** Uber reportedly exhausted its annual AI-tooling budget in **four
  months**, not twelve. By April 2026 individual engineers were spending up to
  ~$2,000/month on tokens through Cursor and Claude Code, forcing a per-developer cap near
  $1,500/month. Paying a frontier model to handle every lint error, file read, and rename
  is financially ruinous at organizational scale.

Both faults point at the same fix, and it is exactly econ's two beliefs (§2): **stop
paying a frontier model to do boring work**, and **stop depending on a single switch you
don't own.** A different cloud vendor fixes neither; a self-hosted, multi-tier team fixes
both. This is the demand-side proof of the cost identity in §12 — the bill CTOs are now
capping is precisely the large-tier token share econ is built to shrink.

### 14.2 Why the process-oriented architecture is the fix

econ's deeper bet is **process over memorization.** Don't pay an enormous model to act as
a frozen, all-knowing database of the world's code and docs — that is what forces constant,
energy-intensive retraining to stay current. Instead, fine-tune **small** open models on
*workflows* (tool use, search, parsing documentation, running commands) and let them
**fetch live data on demand.** The knowledge lives in the repo, the web, and memory; the
model supplies the *process* that drives over it.

This is the same architecture already specified in this document, viewed from the market
angle:

- **Process, not recall → the executor tier (§3).** Small tool-tuned models excel at
  high-frequency, well-scoped tool work; they don't need to *know* the answer, only to
  fetch and apply it.
- **Live data, not memorized data → the context engine (§5).** Pages arrive as
  DOM-extracted, query-ranked markdown so the agent always sees current documentation
  without raw-HTML bloat; the code graph hands over the live slice instead of a memorized
  one.
- **Consult the big model rarely → the oracle escalation path (§3/§4).** The expensive
  reasoner is swapped in only when needed, and only with a tight compiled brief — the
  manual driving stays on the cheap, self-hosted tiers.
- **Energy follows the same curve.** Pushing the world's knowledge out to RAG/web/graph
  while a 9B–32B model runs the reasoning loop drastically cuts the GPU-compute (and
  electricity) that a frontier-model-for-everything design burns — the cost identity of
  §12 has a near-identical energy twin.

### 14.3 The competitive field

econ enters a real and lucrative emerging market — decoupling the *agent* from the
*frontier API* — and it is not alone. The honest read of the field:

| Player | What it is | Where econ differs |
|---|---|---|
| **Coder (Coder Agents)** | self-hosted, model-agnostic agent infra; background execution inside secure Cloud Development Environments with centralized governance | aimed at large Western platform teams; econ adds the cost-routing engine + native context-intelligence, tuned for the Indian cost/latency landscape |
| **Cline** (formerly Claude Dev) | open-source local VS Code agent; MCP tools; runs fully local via Ollama / LM Studio | individual-developer tool; econ is a hosted, multi-tier *team* with a risk-escalation router and in-loop governance, not a single-model local loop |
| **Nango** | self-hosted API-integration platform; agents write integrations as code with credentials kept local | adjacent, not a coding agent — complementary to econ rather than competing |
| **Observer AI / AutoGPT / BabyAGI** | open-source local, event-driven automation frameworks | general task automation, not code-structural; econ is purpose-built for coding with a live call graph and edit-time guardrails |

The pattern: capable tools exist at the **individual-developer** end (Cline) and the
**Western enterprise-platform** end (Coder), but none combine *self-hosted multi-tier cost
routing* with a *native context-intelligence layer* aimed at India and emerging markets.

### 14.4 The moat — sovereign infra + the context-intelligence layer

Two things, held together, make econ defensible:

1. **Sovereign / decentralized agent infrastructure for India and emerging markets.**
   Hosted in-region, on OSS models, degrading to infrastructure the customer controls —
   not a foreign vendor's directive. This is a B2B narrative about *safeguarding national
   and institutional interests while slashing cost*, not just a cheaper SKU. It is a moat
   precisely because the incumbents are structurally centralized and cannot follow without
   abandoning their own model.
2. **The local context-intelligence layer is what makes the small models actually work.**
   A cheap model only matches a frontier model if it is handed the *right* code slice, not
   the whole repo. econ's answer to "how do you map the codebase so a 9B/32B model gets the
   right snippet without reading whole files" is the **live code graph** of §5 — sub-5ms
   call-graph lookups, single-call recon bundles (entity + callers + conventions), and
   function-targeted reads — backed by anchored memory (§6) and the in-loop governance gate
   (§7). Without that layer, multi-tier routing degrades into cheap-but-wrong; *with* it,
   the cheap tiers stay on rails. The router (§4) and the context engine (§5) are two halves
   of one moat: one decides *when* to spend, the other keeps the cheap path good enough that
   it rarely has to.

> **Positioning in one line:** every other player picks one of {self-hosted, cost-routed,
> context-intelligent, in-region}. econ's wedge is doing all four at once, for a market the
> incumbents don't serve.

---

## 15. Glossary

- **Conductor** — the mid-tier model that drives the job and holds the working context.
- **Oracle** — the large/frontier model, consulted rarely with a compiled brief.
- **Executor** — a small, stateless, cheap model that runs individual tool calls.
- **Compiled brief** — the distilled package (problem + slices + attempts + question + output
  shape) sent to the oracle in place of the raw transcript.
- **Risk-escalation router** — escalates based on code-structural risk (blast-radius, fan-in,
  centrality), with hysteresis, abstention, triage, and double-pay accounting.
- **Code graph / context engine** — the live map of the codebase that delivers the right slice.
- **Anchored memory** — typed, code-pinned notes (conventions, rules, warnings, decisions) that
  re-anchor as code moves and flag when they drift.
- **In-loop governance gate** — edit-time guardrails that fire where the model can't skip them.
- **Specialist sub-agent** — a purpose-built agent for a known coding flow, on the cheapest
  tier that fits, running in its own context.
- **Long-horizon checkpointing** — distilling a long run into a compact, structured summary
  (task tree, decisions, open threads) so a 100–200-step task survives the context window.
- **Savings identity** — `cost reduction ≈ 1 − (large-tier token share)`; cost is tokens × price.
