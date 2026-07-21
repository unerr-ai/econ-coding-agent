# econ — Competitive Landscape: India & Europe (and how we beat them)

**Status:** Drafted 2026-07-01; **§5 (Grok 4.5 price shock) added 2026-07-20.** The verified
competitor map for econ's two near-term markets, with an explicit call on **which players are
actually competitors** and **how econ beats each** — plus a dedicated teardown of **Mistral**, the one
genuine wall in Europe, a global **orchestration-layer** entry (**Sakana Fugu**, §4) that is an
*adjacent validator*, and the **frontier price war** (**Grok 4.5**, §5) that is a *supplier and
price-setter* rather than a rival. Companion to
[POSITIONING.md](./POSITIONING.md), [MARKET_ECONOMICS.md](./MARKET_ECONOMICS.md) (India) and
[MARKET_ECONOMICS_EUROPE.md](./MARKET_ECONOMICS_EUROPE.md). All figures June–July 2026; sources §6.

> **One-line verdict.** The "sovereign coding agent" category is **real and de-risked** (Tabnine
> proves enterprises buy air-gapped coding agents) but **uncontested on econ's actual wedge —
> cost-routing + India-native GTM + best-of-breed model-agnosticism.** In **India the lane is open**
> (no one combines sovereignty + cost + coding agent). In **Europe there is exactly one real wall,
> Mistral**, and it is crossed by going around it — on the use cases Mistral doesn't serve, not
> head-on on sovereignty.

---

## 0. How to read this — threat tiers

| Tier | Meaning |
|---|---|
| 🔴 **Real competitor** | overlaps econ's product *and* a target buyer; must have a beat-plan |
| 🟡 **Watch** | adjacent or could pivot in; monitor, don't react |
| 🟢 **Non-competitor** | a *supplier*, a different segment, or structurally not overlapping |
| ⚫ **Dead/absorbed** | no longer independent |

**Three cross-cutting facts that frame everything below:**

1. **Tabnine de-risks the category** — a US-origin vendor already ships SaaS→VPC→on-prem→**fully
   air-gapped** coding agents with SOC 2 / GDPR / ISO 27001 into finance/defense/healthcare. The
   market exists. econ is *not first*; it differentiates on cost + GTM, not on "being sovereign."
2. **Tabnine has no cost moat** — its pricing passes **"actual LLM provider prices + 5% handling
   fee"** straight through. It is a *governance/deployment* layer that resells frontier-priced
   tokens. **That pass-through is the empty lane econ fills.**
3. **Continue is dead as an independent** — **acquired by Cursor (Jun 18, 2026)**, repo read-only,
   users exported by Jul 15. Open-source self-hosted DIY consolidated under a US SaaS.

---

## 1. India — the lane is open

**In plain terms:** the players people name as "Indian AI competitors" are either not coding agents
(Sarvam, Krutrim), not cost-competitive (Emergent, Tabnine), or not enterprise-ready (Refact). No
one owns **sovereign + cost-routed + India-native coding agent** — econ's exact position.

### The field

| Player | What it is | Tier | Competitor? / How econ beats it |
|---|---|---|---|
| **Tabnine** | Air-gapped/on-prem coding agent, certified, has a "Context Engine"; sells globally incl. India | 🟡 Watch | **Beat on cost + locality:** Tabnine resells LLM tokens at **provider price + 5%** and has **no INR/PPP pricing, no India GTM, contact-sales only**. econ's multi-tier open-model routing cuts the model bill ~80–90% and prices in INR. Side-by-side: *"same air-gapped deployment, a fraction of the token bill, in-region."* |
| **Sarvam** | India's 130th unicorn ($1.5B, **HCL-Tech-led $150M**); Indian-language / voice / docs / OCR | 🟡 Watch | **Not a coding agent today** (and arguably never — focus is Bharat-language intelligence). Risk = it pivots into coding with govt+GSI backing. Beat by **head start + depth on the coding context engine** it would build from zero; partner-or-die if it moves. |
| **Krutrim** (Ola) | Models + **Krutrim Cloud** (H100 GPU cloud), Indian-language focus | 🟢 Non-competitor | A **supplier** — a potential India GPU host for econ, not a coding-agent rival. |
| **Emergent** (Bengaluru) | Vibe-coding platform + "Wingman" autonomous messaging agent | 🟢 Non-competitor | Consumer/vibe-coding, **still costly**; not enterprise-sovereign. Different buyer. econ wins enterprise on cost + governance + air-gap. |
| **Refact.ai** | Open-source coding agent, #1 OSS on SWE-bench Verified, self-host via Docker | 🟢 Non-competitor (for now) | **Not widely used / not enterprise-friendly.** Strong tech, weak GTM. econ wins on enterprise-readiness, India motion, and the cost engine. Watch the open-source pull. |
| **Cursor / Copilot / Claude Code** | US SaaS coding agents (Cursor now owns Continue) | 🟡 Watch | Used by Indian devs but **cost (15× pain), no in-region, no air-gap.** econ beats on cost + sovereignty + INR billing. |
| **TCS / Infosys in-house** | GSIs building internal AI delivery tooling | 🟡 Watch | Integrators, not product builders — they **buy/partner rather than build+maintain** a context engine. *Partner before they reflexively build.* |

### India verdict

> **No real 🔴 in India.** The category is validated (Tabnine) but the **sovereignty + cost +
> India-native** intersection is empty. econ's job is speed and depth before Sarvam or a GSI notices
> — sell on **cost first** (per [MARKET_ECONOMICS.md](./MARKET_ECONOMICS.md)), sovereignty as
> table-stakes.

---

## 2. Europe — one real wall (Mistral), the rest are suppliers or niche

**In plain terms:** Europe is more contested than India. A whole GDPR-on-prem cottage industry
exists, Tabnine sells here, and France has a €20B national champion in Mistral. But almost all of
them are *models and clouds* (econ's suppliers) — the only one that is a **sovereign coding-agent
product** at scale is **Mistral**, and it has specific, researched gaps.

### The field

| Player | What it is | Tier | Competitor? / How econ beats it |
|---|---|---|---|
| **Mistral** (Vibe 2.0 + Codestral) | €20B French champion; govt + SAP sovereign stack; real terminal coding agent | 🔴 **Real — the one wall** | See the full teardown + crossing plan in **§3**. |
| **Tabnine** | Air-gapped coding agent, sells into EU on compliance | 🟡 Watch | Same beat as India: **pass-through+5% pricing, no cost engine, US-origin.** econ undercuts on cost; matches on air-gap. |
| **Aleph Alpha / Scaleway / OVHcloud / IONOS / T-Systems** | German/French sovereign **models & clouds** | 🟢 Non-competitor | **Suppliers + deployment targets**, not coding agents. econ runs *on* them. |
| **GDPR-on-prem shops** (apichap, AI Tuning, advisori, innFactory) | Small EU "sovereign AI"/private-LLM integrators | 🟡 Watch | Services-flavored, own *local trust* but no product depth or cost engine. econ wins on product + cost; could partner for local credibility. |
| **Refact.ai** | Open-source self-host | 🟢 Non-competitor | Niche; same as India. |
| **Cursor / Copilot / Claude Code (US SaaS)** | US cloud coding agents | 🟡 Watch | **Legally excluded** from sensitive EU work in SaaS form (Schrems II + CLOUD Act). econ is eligible; beat on compliance + cost. *Caveat: a US vendor's air-gapped mode (Tabnine) can be compliant — exclusion applies to SaaS, not all US vendors.* |

### Europe verdict

> **One 🔴: Mistral.** econ does **not** out-sovereign the French national champion. It crosses the
> wall on the **needs Mistral doesn't serve** (§3) and the **segments it doesn't chase**
> (non-FR/DE, mid-market, nearshore). Sequence Europe **after** the India beachhead.

---

## 3. Beating Mistral — go around the wall, don't climb it

**In plain terms:** Mistral is excellent at inline autocomplete and junior-dev augmentation on
scoped tasks, and it owns the "French sovereign" narrative. But its *own coding models trail the
best open weights*, and it is explicitly **not** built for autonomous, multi-file, long-horizon
enterprise coding. Those gaps are econ's doors.

### 3.1 The reframe — different layer, weaker model

Mistral is a **model company**; econ is a **harness/orchestration** company that can run *any* model
— including Codestral as one tier. And on coding, Mistral's models **lose to the open weights econ
routes to:**

| Model | SWE-bench Verified |
|---|---|
| **GLM-5** (econ oracle candidate) | **77.8%** — best open |
| Qwen 3.6 27B | 77.2% |
| DeepSeek | ~75% |
| **Mistral Devstral 24B** | **~73% (trails)** |

> The wedge in one line: **"econ runs GLM-5/Qwen — the open models that *outscore* Codestral — and
> routes per task. Mistral can only ever give you Mistral."**

### 3.2 The needs & use cases Mistral does NOT serve (researched)

| Gap Mistral has today | Evidence | econ's counter |
|---|---|---|
| **Multi-file coordinated change / legacy refactor** | "struggles with multi-file coordinated changes — a dozen files, dependencies coherent" | code graph + recon bundle + **breaking-change guard** built for this |
| **Long-horizon / long-context** | "falters on deep debugging & long-context recall **beyond 32K**"; autonomy isn't its niche | **checkpointing + context pruning + state-outside-the-window** (100–200 steps) |
| **Best-of-breed model choice** | Codestral "wins inline completion but **loses SWE-bench by design**"; locked to Mistral | **model-agnostic** routing to the models that beat Codestral |
| **Agentic tool-call reliability** | "JSON mode silently drops fields on prompts **over 8K tokens**" | tool-tuned **executor tier + schema validation** |
| **Security-critical / complex logic** | reviewers say "reach for Claude/GPT, not Mistral" | **escalate the hard tail** to the strongest open model |
| **In-loop governance / blast-radius** | not offered | edit-time **governance gate** |
| **Cost at scale** | Le Chat Enterprise **~$20k+/mo entry**; Medium 3.5 at **$7.50/M output**; not a cost-router | **multi-tier open-model routing**, ~80–90% cost cut |
| **Guardrail robustness** | "more permissive on override attempts — enterprise security concern" | governance + abstention path |

**Research summary:** Mistral today = **autocomplete + junior augmentation on scoped tasks**, *not*
autonomous multi-file long-horizon enterprise coding. That second category is exactly econ's
architecture.

### 3.3 The four wedges to cross the wall

```
1. BEST MODEL, NOT THE NATIONAL ONE   → run GLM-5/Qwen (beat Codestral); Mistral can't route off itself
2. OWN THE LEGACY / MULTI-FILE WORK   → demo a 12-file coherent refactor; a head-to-head Mistral loses
3. SELL THE AUTONOMOUS / LONG-HORIZON → checkpointed 100–200-step jobs Mistral can't hold (>32K falters)
4. TAKE THE SEGMENTS MISTRAL IGNORES  → non-FR/DE (Nordics, Benelux, CEE, Iberia), mid-market, nearshore
```

### 3.4 The sovereignty jujitsu

Mistral's pitch is "sovereign *because French*." Flip it: **depending on one national champion is
itself a concentration risk.** econ's model-agnostic, run-any-open-weight-on-your-own-infra design
is *more* sovereign — **no single-vendor lock-in, even a sovereign one.** "Run GLM, Qwen, DeepSeek,
*or* Mistral, swap freely, on your EU hardware" beats "trust one Paris company" for a Nordic/German
buyer wary of any single dependency.

### 3.5 Ride, don't only fight

econ can run **Codestral as one tier** inside its team. Position as the **layer above** Mistral —
*"we make any model, including Mistral's, work better and cheaper on your real codebase"* — so econ
is complementary in deals where the customer is already Mistral-committed, and a replacement where
it isn't.

---

## 4. Sakana Fugu — the orchestration-layer validator (adjacent, not a competitor)

**In plain terms:** Fugu is the closest thing to econ *in shape* — "a multi-agent system presented
as a single model" — and the comparison an investor **will** raise ("isn't this just Sakana Fugu?").
The answer: econ and Fugu share the founding insight and then optimize **opposite objectives**. Fugu
spends *more* to maximize accuracy; econ spends *less* to hit near-frontier quality at a fraction of
cost. It is a **🟢 non-competitor / 🟡 watch** — global, not India/EU — and its existence **helps**
econ's pitch.

### 4.1 What Fugu is

Sakana AI (Tokyo; **Llion Jones**, co-author of "Attention Is All You Need," + **David Ha**, ex-Google
Brain) shipped Fugu as a **Mixture-of-Agents (MoA)** layer: one prompt is fanned out to **three
frontier models simultaneously — Claude, GPT-4, Gemini — then an aggregation/synthesis step** produces
a single answer that beats any one of them on reasoning/knowledge/coding benchmarks. It is grounded in
two ICLR 2026 papers on **learned** orchestration — **TRINITY** and **the Conductor** — and is
positioned for *accuracy-critical* single prompts. Per Sakana's own docs it is **complementary to
agent frameworks, not one**: "you could use Fugu as the reasoning backbone *within* a larger agentic
system." Its specific model picks + routing are proprietary/undisclosed.

### 4.2 Same premise, opposite machine

| Axis | Sakana Fugu | econ | Can Sakana follow onto econ's axis? |
|---|---|---|---|
| **Core bet** | orchestration > single model | orchestration > single model | — (shared insight) |
| **Objective** | **maximize accuracy** | **minimize cost** at ~frontier accuracy | no — it inverts their bet |
| **Method** | ensemble: same prompt → 3 models in parallel → synthesize | delegation: different slices → cheapest capable tier, escalate the hard tail | no |
| **Cost direction** | **multiplies** (3× frontier + synth on *every* prompt) | **divides** — `reduction ≈ 1 − large-tier token share` | no — following kills the accuracy bet |
| **Model substrate** | closed US frontier (Claude/GPT/Gemini) | open-weight, India/EU-hostable (Qwen/GLM/gpt-oss) | no — they orchestrate closed APIs |
| **Sovereignty** | none (three US APIs) | the whole point | no — 3 US APIs can't be sovereign |
| **Shape** | a *reasoning backbone* (drop into an agent) | a *full coding agent* (tools, edits, context engine, guardrails, long-horizon) | no — they're deliberately the backbone you wrap |
| **Data moat** | none (never touches the codebase) | per-customer accumulated context/codebase | no |

> **The wedge in one line:** *"Fugu runs three frontier models on every prompt to buy accuracy; econ
> routes each slice to the cheapest capable open model to cut cost — same insight, inverse economics,
> and only econ can be sovereign and India-priced."*

### 4.3 Why it is not a competitor (and why that's stable)

Each row above is a lane Sakana **cannot enter without abandoning what makes Fugu *Fugu***: to be
cost-optimal it would have to stop running three frontier models; to be sovereign it would have to
leave closed US APIs; to be a coding agent it would have to stop being a model-agnostic reasoning
backbone. The overlap is the *idea*, not the *market*. Fugu would also fail every DPDP/RBI/sovereignty
test econ is built to pass.

### 4.4 The one idea worth borrowing — MoA as a scalpel, not a blanket

Do **not** adopt Fugu's "3 frontier models on every prompt" — it detonates econ's cost identity. But
Fugu's own guidance ("multi-model verification when errors are costly — production code") maps exactly
onto econ's **in-loop governance gate**: on the ~1% of edits the risk router flags high-blast-radius,
run a Fugu-style ensemble check (2–3 models vote/synthesize before the edit commits), paying the
ensemble tax **only where a wrong edit is catastrophic** — MoA used as a scalpel inside a cost-routed
agent, arguably a better design than blanket application.

> **Full design:** the complete list of Sakana borrows *and* econ's accuracy-multiplication mode for
> complex problems (extended reasoning, self-consistency, MoA, debate, verifier reranking — gated by
> the router so they fire on <1% of tasks) is in
> [ADAPTIVE_COMPUTE.md](./ADAPTIVE_COMPUTE.md) — the "cost-division by default,
> accuracy-multiplication on demand" dial.

### 4.5 Strategic read

Fugu is **external validation of econ's direction**: a serious lab (Transformer co-author; ICLR 2026
papers) productized *harness-over-model* and it sells. The convergence even reaches vocabulary — Fugu's
foundations are literally **"TRINITY" and "Conductor,"** and econ independently runs a `trinity` prompt
and a Conductor topology. **Watch-line:** if Sakana pivoted Fugu into a **cost-routed, open-weight
coding agent**, it would be formidable — but that means abandoning its accuracy-maximizing frontier
bet. Monitor for any open-weight / cost / on-prem move; until then, cite Fugu as proof the category is
real, not as a threat.

---

## 5. Grok 4.5 — the price shock (a supplier, not a rival, but it moves our pitch)

**In plain terms:** on 8 July 2026 xAI launched Grok 4.5 at **$2 in / $6 out per million tokens** —
roughly a fifth of Claude Fable 5's price for a model that lands in the same broad quality tier. The
fair question is whether cheap frontier pricing erases econ's reason to exist. The short answer:
**it takes a bite out of one of our three lanes and leaves the other two untouched — and Grok is a
model we *route to*, not a product we compete with.** But it is the clearest signal yet that "we're
cheaper than Claude" is a melting-ice pitch, and the doc says so plainly rather than pretending
otherwise.

**Tier: 🟢 Non-competitor (supplier + price-setter), 🟡 watch on repricing.**

### 5.1 How big is the undercut, really

Headline prices understate it in one direction and overstate it in another, so the honest number is
**cost per finished task**, measured independently by Artificial Analysis on its Coding Agent Index:

| Model (in its own harness) | Input /M | Output /M | Tokens per task | **Cost per task** |
|---|---|---|---|---|
| **Grok 4.5** (Grok Build) | $2.00 ($0.50 cached) | $6.00 | **1.9M** | **$2.49** |
| GPT-5.5 (Codex) | $5.00 | $30.00 | 6.2M | $5.07 — 2.0× |
| Claude Fable 5 (Claude Code) | $10.00 | $50.00 | 7.2M | $11.80 — 4.7× |
| Claude Opus 4.8 | $5.00 | $25.00 | — | — |

So it is ~5× cheaper than Anthropic's top model per task, but only ~2× cheaper than OpenAI's — and
GPT-5.6's entry tier already matches Grok on price ($1/$6). This is a **general price war, not one
vendor's stunt.** Two things worth noting: the quality is real but not top of the board (4th on the
Intelligence Index, behind Fable 5, GPT-5.5 and Opus 4.8), and roughly **half the per-task advantage
comes from using fewer tokens, not from cheaper tokens** — which matters enormously for us (§5.3).

### 5.2 Why it's so cheap — and whether it lasts

Three technical levers, in order of how much they actually contribute:

1. **Token efficiency was trained in.** xAI co-trained with Cursor on *trillions of tokens of
   interaction data* — not code, but the sequence of work: which files a developer opens before a
   change, how they react to a failing test, how a patch gets revised. Then reinforcement learning
   over hundreds of thousands of multi-step tasks **inside its own coding harness**. A model that
   already knows the workflow wastes fewer exploratory turns: ~14k output tokens per task vs Opus
   4.8's, over 60% fewer (independently measured).
2. **Cache-first economics.** Automatic prefix caching with **90%+ hit rates** co-engineered with
   launch partners, a 75% cache discount, and no cache-write fee. At a realistic agentic token mix
   the effective price is **~$1.35/M, not $2**.
3. **Throughput over latency.** Sparse mixture-of-experts served with deep batching — the tell is an
   11.6-second time-to-first-token against a 2.75s peer median. They keep GPUs busy and let
   interactive responsiveness pay for it. Musk has said the hardware-specific inference stack isn't
   even deployed yet, so there is more headroom.

**Are they selling below cost?** Two different answers, and the distinction matters:

- **Per token, probably not.** Frontier inference gross margins run 70–80% industry-wide (DeepSeek
  claimed >80% while charging $2.19/M output). Sparse MoE + deep batching + 90% cache hits plausibly
  puts Grok's marginal cost well under $1.50/M output against a $6 price. The consensus read from
  independent analysts is **thinner margins, not an efficiency breakthrough — OpenAI and Anthropic
  could match this and choose not to.**
- **As a business, massively.** xAI booked ~$3.2B revenue against a **$6.4B loss** in FY2025 (−200%
  operating margin), with Q1 2026 annualizing near −300%, ~$1B/month burn and a ~$30B/year capex
  pace. Training and datacenters are simply never priced into the token. It is an equity-funded land
  grab with a real opportunity cost — Anthropic rents xAI's own Colossus 1 cluster for **$1.25B a
  month**, so every subsidized token is compute that could have been sold at market rate.

> **The practical read:** this price is a *strategic choice funded by investors*, not a new floor set
> by physics. It can be withdrawn. Building a business that depends on Grok staying at $6 is unwise;
> building one that can *switch* the moment it isn't is exactly the point of a router.

### 5.3 What it does to econ — honest damage assessment

**What it genuinely hurts: the raw cost-arbitrage headline.** Our savings model is
`reduction ≈ f × (1 − 1/r)` — the boring-work share times the price ratio. When the frontier baseline
itself gets cheap, `r` falls and the absolute dollars we save per task fall with it. A customer who
only wants cheap frontier tokens can now buy them directly from the vendor. We should stop leading
with a fixed multiple against Claude.

This should not be a surprise: our own cost-curve research put ~70% odds on Fable-quality arriving
3–4× cheaper within six months. **Grok 4.5 is that forecast landing on schedule, not a black swan.**

**What survives, strongest first:**

1. **Grok is an input to econ, not a substitute for it.** We are a model-agnostic harness; the
   cheapest strong model on the market is our raw material. Slot it in as a tier and *our* cost per
   task drops too — we hand xAI's subsidy to the customer, and when the subsidy ends we swap tiers
   with no customer disruption. In a price war the router is the safest seat in the room.
2. **Half of Grok's advantage is harness economy — which is our layer.** The 1.9M-vs-7.2M token gap
   is not model weights, it's how the loop spends context. That is our second pillar (hand the model
   the right slice) validated with someone else's published numbers, and it stacks *on top* of
   whatever model we route to.
3. **The lanes Grok structurally cannot enter.** Grok 4.5 is proprietary and US-hosted: no weights,
   therefore **no in-region hosting, no data residency, no air-gapped deployment**. For RBI-regulated
   banks, government buyers, and the defense/confidential-compute segment, the competitive set is
   completely unchanged by this launch. See [CONFIDENTIAL_COMPUTE_MARKET.md](./CONFIDENTIAL_COMPUTE_MARKET.md)
   and [DEFENSE_OPPORTUNITY.md](./DEFENSE_OPPORTUNITY.md).
4. **Their quality trade-off is our governance pitch.** They bought cheapness with a **54%
   hallucination rate** on AA-Omniscience and 53% on DeepSWE 1.1 against Fable 5's 70%. Cheap-but-
   unverified is precisely what our in-loop governance gate and risk-escalation router exist to fix.
   *"Grok-class economics with a gate that catches the tail"* is a sharper pitch after this launch,
   not a weaker one. (Interesting counterpoint worth respecting: Grok **beats** Fable 5 on SWE
   Marathon, 29% vs 24% — trained turn-discipline shows up on long-horizon work.)
5. **Procurement friction is real.** Regulated buyers weighing a Musk-owned, X-adjacent vendor with
   venture-subsidized pricing and single-region hosting face concentration, compliance and repricing
   risk. The frontier-mode wedge — cutting a customer's *existing* Claude/Copilot bill with no vendor
   switch — is untouched.
6. **The trace moat has to be built locally.** Grok's edge came from Cursor's interaction traces. Our
   equivalent — logged trajectories from Indian customers' real workloads, feeding finetuned worker
   and junior tiers — is an asset xAI doesn't have and can't easily buy.

### 5.4 What we actually do about it

| Action | Why |
|---|---|
| **Add Grok 4.5 as a routable tier** | Cheapest strong model available; capture the subsidy on the customer's behalf, exit when it reprices |
| **Lead with cost-per-finished-task, never $/M** | It's the metric the market's own referee now leads with, and it's what EconReceipt already measures |
| **Make cache-hit-rate a first-class engineered number** | 90% hits at a 75–90% discount beats most routing wins; route on *effective blended* price, not list price (see [design/cross-tier-context.md](../design/cross-tier-context.md)) |
| **Finetune our cheap tiers on our own logged trajectories** | The Cursor-traces playbook, applied to open weights — the one part of Grok's method a non-pretraining company can copy |
| **Shift pitch weight from "cheaper" to "cheaper *and* governed *and* in-region"** | The cost lane compresses every quarter; the other two don't |

> **Verdict in one line:** *Grok 4.5 lowers our input costs and proves our thesis in the same stroke.
> What it kills is any strategy that assumed frontier vendors would stay expensive — which was never
> our bet. We route to whoever is subsidizing tokens this quarter, and sell the governance and
> sovereignty that a US-hosted proprietary model cannot offer at any price.*

### 5.5 What to watch

- **Grok repricing upward** once the land grab ends or funding tightens — the −300% operating margin
  says this is not a stable price. Our exposure is a tier swap; a customer's is a bill shock.
- **An open-weight model matching Grok's trained token-efficiency.** This is the genuinely important
  one: if GLM/Qwen/DeepSeek ship harness-native RL trained for concise agentic trajectories, our
  sovereign lane gets Grok economics *and* keeps residency. Watch for it.
- **xAI open-weighting an older Grok** (they have precedent). That would put real pressure on the
  sovereign lane's model shortlist — as an opportunity as much as a threat.
- **Anthropic/OpenAI answering the price cut.** GPT-5.6 Luna at $1/$6 suggests it's already underway;
  each round compresses `r` further and moves more weight onto governance and residency.

---

## 6. econ's durable differentiation — what wins in both markets

Strip away what's commoditized or contested, and four things win in **both** India and Europe:

1. **Cost-routing on cheap open models** — `reduction ≈ 1 − large-tier token share`
   ([ECON_ARCHITECTURE §12](./ECON_ARCHITECTURE.md)). **No competitor is a cost engine** — Tabnine
   passes through +5%, Mistral is $20k/mo, Cursor/Copilot resell frontier.
2. **Best-of-breed, model-agnostic** — runs the highest-scoring open weight per task; Mistral is
   model-locked, Tabnine BYO-but-priced-through.
3. **The work the others fail at** — multi-file/legacy + long-horizon autonomous, via the context
   engine + checkpointing.
4. **Native sovereignty without single-vendor lock-in** — self-host any weight on the customer's
   own (India/EU) infra; antifragile vs both US SaaS and a single national champion.

Plus the market-specific GTM: **India = cost-led + INR/PPP + services/GCC**; **Europe = compliance-
led + EU-resident deployment + the non-FR/DE segments**.

---

## 7. Honest risks & what to watch

1. **Sarvam pivots into coding** (govt + HCL-Tech backing) — the biggest India risk. Watch its model
   roadmap; move fast on the coding context moat.
2. **Mistral closes its gaps** — it has €20B and could fix multi-file/long-horizon. econ's defense is
   cost + model-agnosticism (structural — Mistral won't route off itself) + the underserved segments.
3. **Tabnine adds INR/India pricing or a cost-router** — unlikely (US enterprise motion), but it's
   the one move that would contest the India lane. Watch its pricing page.
4. **A GSI (TCS/Infosys/Cognizant) buys or builds** — Cognizant×Cognition shows the pattern. Prefer
   **partnering** with a GSI over competing.
5. **Open-source pull (Refact/forked Continue)** — could commoditize the assistant tier; econ's
   answer is the enterprise/cost/governance layer on top.
6. **Sakana Fugu pivots to cost/open-weight** (§4) — today an accuracy-maximizing frontier-model
   backbone, not a rival; the only move that would contest econ is a cost-routed open-weight coding
   agent, which means abandoning its own bet. Watch for any on-prem / open-weight / cost signal.

---

## 8. Sources

June–July 2026 (full URLs captured in the conversation that produced this doc):

- **Self-hosted / sovereign coding agents** — tabnine.com & tabnine.com/pricing (air-gapped tiers;
  "LLM provider price + 5%" pass-through); iternal.ai (self-hosted list); refact.ai (OSS #1 SWE-bench)
- **Continue acquisition** — thenewstack.io (Cursor acquires Continue, Jun 18 2026; repo read-only)
- **India players** — localsamosa.com & restofworld.org (Sarvam unicorn, HCL-Tech $150M);
  techcrunch.com (Emergent/Wingman); explainx.ai (Krutrim cloud/models); sarvam.ai
- **Mistral product & weaknesses** — venturebeat.com (Vibe 2.0 vs Copilot); aibusiness.com &
  startupfortune.com (€20B, SAP + Fr/Ger govt sovereign stack); aizolo.com & tokenmix.ai
  (Codestral multi-file / long-context / style weaknesses); futureagi.com (agent tool-call / JSON
  instability); index.dev (Codestral benchmarks)
- **Mistral pricing** — teamazing.com (Le Chat Enterprise ~$20k+/mo); cloudzero.com (API rates,
  Medium 3.5 $1.50/$7.50); mistral.ai/pricing (Team $24.99/$19.99)
- **Coding model scores** — kilo.ai & promptquorum.com (GLM-5 77.8%, Qwen 77.2%, DeepSeek ~75%,
  Mistral Devstral ~73%)
- **Grok 4.5 / xAI (§5)** — artificialanalysis.ai/articles/grok-4-5-brings-spacexai-to-the-the-intelligence-frontier
  (independent: $2.49 vs $5.07 vs $11.80 per Coding Agent Index task; 1.9M vs 6.2M vs 7.2M tokens;
  ~14k output tokens/task) & artificialanalysis.ai/models/grok-4-5 (Intelligence Index 54 → 4th;
  11.6s TTFT; 76 t/s; $0.50 cache-hit price; $1.35 blended); we0.ai/articles-v2/grok-45-coding-benchmarks-token-efficiency
  (Cursor interaction-data co-training, RL in the Grok Build harness, MoE, GB300 stack not yet
  deployed); docs.x.ai/developers/advanced-api-usage/prompt-caching (75% cache discount, no write
  fee); infoq.com (grok-code-fast-1 >90% partner cache-hit rates); techtimes.com (54% hallucination
  rate; $2.49-vs-$11.80 framing); cryptobriefing.com (60%+ undercut, price war);
  benchlm.ai/blog/posts/grok-4-5-cheaper-closed-future ("thinner margins, not an efficiency
  breakthrough"); techcrunch.com 2026-05-20 + digitalapplied.com + sacra.com/c/xai (FY2025 $3.2B
  revenue / $6.4B loss, −200% op margin, ~$1B/mo burn, ~$30B/yr capex pace);
  actuia.com (Anthropic rents Colossus 1 at $1.25B/month); seangoedecke.com + intuitionlabs.ai
  (70–80% industry inference gross margins; DeepSeek >80% at $2.19/M output)
- **Sakana Fugu (§4)** — sakana.ai/fugu ("Multi-agent System as A Model"; TRINITY + Conductor ICLR
  2026 papers; routing proprietary/undisclosed); mindstudio.ai/blog/what-is-sakana-fugu-multi-agent-ai
  (MoA over Claude/GPT-4/Gemini in parallel + synthesis; complementary to LangChain/AutoGen — "reasoning
  backbone within a larger agentic system"; use when accuracy is critical); arxiv.org/abs/2606.21228
  (technical report)
