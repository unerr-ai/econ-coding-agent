# Fundraising — the story, the evidence, and the application plan

**Status:** working doc, started 2026-07-18. Time-sensitive material (leaderboard numbers,
accelerator deadlines) is stamped with its as-of date — re-verify before using in a live pitch.
This doc owns the *fundraising narrative*; the underlying facts live in their owning strategy
docs and are cross-referenced, not duplicated.

---

## 1. The one-sentence pitch

> "Every Indian company is being told to adopt AI coding tools priced for American salaries —
> we built the one priced for India, that runs in India, and we can prove it works."

---

## 2. Is "we make AI cheaper" a fundable story?

**On its own — no. Wrapped in a bigger story — yes, and it is being funded right now.**
Evidence from comparable raises (researched 2026-07-18):

| Company | Story they told | Raise | Year |
|---|---|---|---|
| Cursor (Anysphere) | Product traction — $2B ARR, 1M+ paying users | $2B at $50B | 2026 |
| Fireworks AI | Inference *infrastructure* (not "save on tokens") | $250M Series C at $4B | 2025 |
| Baseten | Inference platform at scale | $1.5B at $13B | 2026 |
| OpenRouter | Pure cost-routing — even with $50M ARR | only $40M total | 2025 |
| Sarvam AI | Sovereign AI for India + govt backing | $234M Series B at $1.5B | 2026 |
| Sakana AI | Research direction + famous founders | $30M seed → $2.65B | 2024-25 |
| Krutrim | Indian foundation model | $50M at $1B | 2024 |

The pattern: pure cost-arbitrage plays raise small and slow (OpenRouter). The same engine
framed as **infrastructure** (Fireworks, Baseten), **product traction** (Cursor), or
**sovereignty** (Sarvam, Sakana) raises 10–50× more. India took $1.5B of AI funding in
Q1 2026 — 38% of all deals. Investor skepticism about cost plays is real (margin compression,
model-price deflation, "thin wrapper" screening) but hasn't killed the category — it has
redirected it: investors back cost engines sold as *operations, governance, and residency*,
not as discounts.

**Conclusion: the cost engine is *how* we win, not *what* we sell.**

## 3. Should we position as a research startup?

**No.** The research-lab path (Sakana, Mistral) worked because the founders were already
famous researchers — investors bet on names before product. That door is not open to unknown
founders. We don't need it: we have what those labs lacked at seed — a working product with
measured results.

Keep research *inside* the story as one ingredient: the trained coordinator
(see [MODEL_TRAINING_STRATEGY.md](./MODEL_TRAINING_STRATEGY.md)) costs ~$5–20k of compute and
3–6 months — "the product gets smarter on a budget that rounds to zero," without calling
ourselves a lab.

---

## 4. The story — three parts, in this order

**Part 1 — The unfairness (why now, why India).**
AI coding tools clearly work: 95% of Indian developers already use them weekly, and India is
Claude's #2 market worldwide ([GTM_DEMAND_SIGNALS.md](./GTM_DEMAND_SIGNALS.md)). But pricing
is set for American salaries: a $300/month tool is ~2% of a US developer's cost and 20–50% of
an Indian developer's — **the same tool is ~15× more painful to buy in India**
([MARKET_ECONOMICS.md](./MARKET_ECONOMICS.md)). Indian companies are squeezed: clients demand
AI adoption while the tools are priced out of reach. The market is 5M+ developers across IT
services + 1,700+ GCCs.

**Part 2 — What we built (proof, not promises).**
A coding agent that gets close to the best tools at a fraction of the price. It works like a
well-run team: cheap models do the routine work; a stronger model is called only for the hard
parts — a firm using juniors and calling the partner when it matters. Measured (real-graded,
identical conditions; see
[../testing/ECON_VS_CLAUDE_MODELS.md](../testing/ECON_VS_CLAUDE_MODELS.md)): quality one notch
below the most expensive frontier model at roughly a quarter of the cost. Because it runs on
open models it can run entirely inside India — inside a bank, or on a disconnected defense
network where US tools are simply not allowed. No air-gapped coding agent exists anywhere
today ([WHITESPACE_EXPLORATION.md](./WHITESPACE_EXPLORATION.md)), and Indian government money
(iDEX, ADITI, IndiaAI) is set aside for exactly this.

**Part 3 — Why it's hard to copy.**
Not the routing — that can be copied. And not "memory" as a feature — every serious agent
has memory. Two things (§5 below has the full explanation): our memory is **wired into the
cost engine** — it decides when to use the cheap model and when to pay for the strong one, so
the agent gets measurably cheaper for each customer every month, and its accumulation doesn't
transfer when a customer leaves; and the **trained coordinator** is fed by the labeled
decision logs that loop produces — data nobody else's memory design generates. Falling model
prices are fuel, not threat — we ride the cheapest models down while frontier prices stay
premium.

---

## 5. The defensibility claim, precisely — two kinds of learning

Said loosely, "it learns from your code" will make a regulated buyer hear "you train on my
code" and walk away. The claim is two separate mechanisms; only one is model training.

### 5a. Per-customer: memory, NOT training — and why *our* memory is a strength

The boundary first: the model's weights never change. What grows is a knowledge store living
**with the customer**: the code graph (calls, dependencies, co-change patterns), anchored
notes the agent writes as it works ("this team never mocks the DB in tests", "40 things
depend on this file", "last billing fix had to land in the API layer"), and a record of
decisions and mistakes. Month 1 the agent is a new hire on day one; month 6 it knows the
house rules — because they're written down, not because the model changed. **Analogy: a new
team member whose notebook never gets lost.** The notebook sits in the customer's own
environment; their code never leaves and trains nothing. This exists in the product today
(the unerr layer — we use it ourselves).

**Concede the obvious: every serious agent has memory.** Claude Code has memory files, Cursor
has rules and memories, Windsurf, Copilot, and Devin all remember things about a repo. Never
pitch "we have memory" — a sharp investor knows it's table stakes. The strength is three
layers deep, in increasing order of importance:

1. **How it's stored and recalled (real, but copyable).** Everyone else's memory is a flat
   notepad loaded at session start, relevant or not. Its known failure modes: it bloats (200
   rules eating context on every task), it rots silently (rename the module and the rule
   points at nothing), and the model has to *happen to notice* the right rule. Ours is pinned
   to the code itself — a note lives on `src/db/*`, surfaces only when work touches that
   area, moves when the code moves, and gets flagged when it drifts. Better engineering; a
   determined competitor could build it. A feature, not a moat.

2. **What it's wired into (the actual strength).** Everyone else's memory has one job: make
   answers a bit better. Ours has a second job nobody else's can have: **it feeds the
   dispatcher.** "40 callers, and the last two cheap attempts here failed" is exactly what
   decides *escalate this edit, let the cheap model do the rest*. Co-change records decide
   what to read; convention notes cut failed retries. For a competitor, better memory =
   slightly better answers at the same premium price. For us, better memory = **the product
   gets cheaper to run for that customer every month** — fewer wrong turns, fewer
   escalations, leaner reads — and it shows on the receipt: cost per task, month 6 vs month
   1, per customer. No frontier-priced agent can make that claim, because their memory isn't
   connected to a cost engine. Copying it isn't adding a feature; it's rebuilding the product
   around routing — and it cuts against their pricing model.

3. **What holds even if everyone copies everything.** The switching cost never depended on
   the mechanism being unique. Every CRM has custom fields; leaving your CRM after three
   years still hurts, because *your accumulated data doesn't transfer*. Eighteen months of
   notes, failure records, and learned conventions about *your* codebase don't move to a
   competitor's agent — it arrives on day one, cold
   ([POSITIONING.md](./POSITIONING.md) — accumulated context is the one non-commoditized
   asset). The moat is the accumulation, not the invention.

One more thing our memory produces that nobody else's does: **labeled decisions.** Flat
memories record preferences ("prefer async handlers"). Our loop records decisions with
outcomes attached — *escalated / didn't, worked / didn't, paid off / paid twice*. That is the
training data for §5b's dispatcher. Other agents' memories can't feed a trained coordinator
because they never record results. So 5a and 5b are not two separate claims — the first is
the data source for the second.

### 5b. Across the product: training the dispatcher — small, cheap, not on customer code

The product's core decision, made hundreds of times a day: *"is this step easy or hard — cheap
model or strong one?"* Every call produces an outcome we log (the double-pay ledger records
exactly which escalations paid off). Thousands of real "made the call / here's what happened"
records are training data nobody else has. We use them to post-train a **small** open model to
make the dispatch call better — a referee, not a giant code-writer.

Feasibility is validated externally (details + citations in
[MODEL_TRAINING_STRATEGY.md](./MODEL_TRAINING_STRATEGY.md) and
[FRONTIER_PARITY_FEASIBILITY.md](./FRONTIER_PARITY_FEASIBILITY.md)):

- Mid-size open models post-trained on a few thousand task recordings reach ~59% SWE-Verified
  for **$2–6k** of compute (DeepSWE); SERA reproduced the outcome for ~$1.9k. Fewer than 500
  *good* trajectories already give +14%.
- Sakana Fugu proved the topology at the high end: a **trained coordinator** scored 73.7% on
  SWE-Bench Pro — above Claude Opus 4.8 (69.2%). Their weakness is our opening: Fugu
  coordinates *closed US models*, so it can never run inside an Indian bank or defense
  network. Ours can.
- Our realistic budget: **$5–20k compute, 3–6 months** — fundable from a seed round.

### The flywheel sentence

> "Every task our agent runs teaches the dispatcher whether its judgment was right. More
> customers → more decision records → a smarter dispatcher → better quality at lower cost →
> more customers. The training data is a by-product of the product working — and nobody else
> is collecting it."

### Say / never say

- **Say (the lead line):** "Every coding agent has memory. Ours is the only one where memory
  is wired into the money: it decides when to use the cheap model and when to pay for the
  strong one — so the agent gets measurably cheaper for each customer every month, and you
  can see it on your own bill. And after a year, that accumulated knowledge of your codebase
  is why you don't leave — the next agent starts from zero."
- **Say:** "Two kinds of learning. Per-customer: a memory of your codebase that lives in
  *your* infrastructure — your code trains nothing. Across the product: we train a small
  dispatcher model on our own decision logs and benchmark runs."
- **Say:** "Training costs thousands, not millions — we rent raw intelligence from open
  models and only train the judgment layer."
- **Never say** "we have memory and they don't" — Claude Code, Cursor, Windsurf, Copilot,
  and Devin all remember things about a repo. Claiming memory as our invention loses the
  room. The claim is what memory is *wired into*, not that it exists.
- **Never say** "it learns from your code" without the boundary. To regulated buyers, lead
  with it: *"Your code is never training data. The learning about your codebase is a set of
  files on your machines that you can read, audit, and delete."* For the sovereign story
  that's a feature, not a limitation.
- **If a sharp investor pushes "isn't the mechanism copyable?"** — concede it: yes, in
  principle. The defense: for incumbents it's a rebuild around routing, not a feature add; it
  cuts against their premium pricing; and every month of customer usage meanwhile deepens
  both the per-customer data and the dispatcher's training set.

### Honest limits (keep in the back pocket — investors respect them)

- The memory layer's value builds over months — weak proof at demo time. Demo it on our own
  repo, which has months of accumulated notes.
- The trained dispatcher is validated by published results + our data pipeline, but **our own
  trained version doesn't exist yet** — it's a seed-round milestone, not a shipped fact. Say
  exactly that.

---

## 6. Expected benchmark position (internal projection, 2026-07-18)

Basis: our real-graded mini-10 results calibrated against July-2026 public leaderboards.
These are projections, not measurements — the n=50 stratified run (below) converts them.

| Benchmark | Projected landing | Nearest public anchors (2026-07) |
|---|---|---|
| SWE-bench Verified | 74–82% (central ~78%) | Fable 5 ~95, Opus 4.8 88.6, DeepSeek V4 Pro Max 80.6 |
| SWE-bench Live | 60–70% (central ~65%) | frontier drops 5–12pp vs Verified, open-weight 8–15pp |
| SWE-Bench Pro | 55–65% (central ~60%) | Fable 5 80.0, Opus 4.8 69.2, **GPT-5.5 58.6**, GLM-5.2 62.1 |
| Terminal-Bench 2.1 | 55–68% (weakest fit) | needs a capability wave first — out-of-domain harness |

The claim these support: **GPT-5.5-class results on the hardest benchmark at roughly 4× less
than Opus** — top-open-weight class on Verified. Not frontier parity; best-in-class
cost-per-resolved.

---

## 7. Investor pushback → answers

| They'll ask | We answer |
|---|---|
| "Why not just pay $20 for Cursor?" | Serious all-day agent use costs $100–300/mo, not $20; a bank's code can't leave India; nobody can audit a black-box tool. Cheap, local, auditable is the product — not a discount. |
| "Model prices fall 10×/year — doesn't that erase you?" | Falling prices are our fuel: we sit on whatever is cheapest. What we sell — the team-of-models engine, the learned codebase memory, running where data must stay — doesn't get cheaper when tokens do. |
| "Product or feature?" | Working product + measured public-benchmark numbers + paying customers. The question dies on a demo. |
| "What stops a frontier lab / Sarvam?" | Head start + context-engine depth ([COMPETITORS.md](./COMPETITORS.md)); frontier labs won't ship air-gapped open-weight; Sarvam has no coding product and we'd have months of accumulated per-customer memory before anyone arrives. |
| "Every coding agent has memory — what's different?" | Concede it — memory is table stakes. Theirs makes answers slightly better at premium price; ours is wired into the dispatcher, so it makes the product *cheaper per customer every month* (receipt-visible), produces labeled decisions that train the coordinator, and its accumulation doesn't transfer when a customer switches (§5a). |

---

## 8. Application plan (deadlines as of 2026-07-18 — re-verify on official sites)

### This week (hard deadlines)

| Program | Deadline | Gets | Note |
|---|---|---|---|
| **Y Combinator Fall 2026** | **Jul 27, 8pm PT** | ~$500K | India founders accepted, no US flip upfront; decision Aug 28; next batch is Winter 2027 |
| **South Park Commons Fall 2026** | **Aug 2** | $1M ($400K + $600K committed) for 7% | Bangalore presence; apply alongside YC |

### Rolling — apply now, zero cost

- **Together Fund SwarmSpace** — up to $1M + ~$600K credits (incl. Anthropic); explicitly "AI companies with India in their DNA". Best India-fund fit right now.
- **IndiaAI Mission compute** — subsidized GPUs ~₹115–150/hr (~40% off); no equity; stamps the sovereignty story ([TOKEN_ECONOMICS.md](./TOKEN_ECONOMICS.md) — the subsidy is what makes self-hosting beat API pricing).
- **MeitY SAMRIDH** — up to ₹40 lakh matching grant via partner accelerators.
- **Credit stack** (all rolling, all free): Google for Startups AI (~$350K), AWS Activate AI (~$300K), Microsoft Founders Hub (~$150K), NVIDIA Inception. Stack all four.

### Opening soon — calendar reminders

- **Peak XV Surge** — next cohort likely opens ~mid-Aug 2026 (inferred from cadence, not announced). ~₹41 crore checks.
- **ADITI 5.0 / next iDEX cycle** — likely Sep–Oct 2026. Grant money (₹1.5 crore+), no equity; our air-gapped defense angle is a genuine fit ([DEFENSE_OPPORTUNITY.md](./DEFENSE_OPPORTUNITY.md)).
- **Accel Atoms AI / Lightspeed India Ascends / EF Bangalore** — closed for 2026 H1; reopen ~Dec 2026–Jan 2027.

### Skip

a16z Speedrun, PearX, Neo, Antler AI residency — windows closed; late rolling applications carry little weight.

---

## 9. Sequencing — what to do, in order

1. **Numbers no one can argue with:** the stratified n=50 SWE-bench Verified run, three
   repetitions (single-run claims are unsound — same-commit cost swings of +44% are on
   record). "GPT-5.5-class at a tenth of the cost, measured on public benchmarks" is the
   strongest slide.
2. **5–10 paying customers or pilots**, however small. One IT-services firm or GCC saying
   "we rolled this out" beats any projection.
3. **Non-dilutive money first:** IndiaAI compute, SAMRIDH, iDEX/ADITI, the credit stack —
   free capital that also validates the sovereignty story.
4. **Then the seed**, from India-focused funds (Peak XV, Accel India, Blume, Lightspeed
   India) on the three-part story in §4. Realistic ask at this stage: a few million dollars,
   not tens.
