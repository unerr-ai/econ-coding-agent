# econ for defense — the sovereign agentic platform for militaries

**Status:** the one direction from the 2026-07 whitespace exploration chosen to proceed
(decision 2026-07-04). Everything else explored in
[WHITESPACE_EXPLORATION.md](./WHITESPACE_EXPLORATION.md) was deemed not fit to proceed.
This doc is the single home for the defense research, the business case, and the argument —
written as a narrative first, with the numbers behind it.

---

## 1. Start with one engineer

Picture a radar-software engineer at a DRDO lab in Bengaluru. She works on the signal-processing
code inside an air-defense system. Her lab has **no internet** — not slow internet, none — because
the Security Manual for Licensed Defence Industries requires it: biometric access at the door, no
phones, no cloud, nothing in or out. Her counterpart at a private startup uses Claude Code or
Cursor and ships in hours what takes her days. She cannot use any of it. Not because her lab is
cheap — because every one of those tools phones home to a US cloud, and her code is classified.

Now multiply her. There are roughly **1,300–2,100 people like her writing code inside India's
defense establishment every day** — at DRDO's software labs (CAIR, CASDIC), at BEL's software
division (which writes the combat-management system on every Indian warship and the IAF's air
command network), at HAL (Tejas mission computers), at the Navy's WESEE. Worldwide, the same
picture: **~100–150K military and cleared-contractor developers work air-gapped**, from the US
Air Force's Kessel Run to Israel's Unit 8200 to Turkey's HAVELSAN.

For every one of them, the AI coding revolution stopped at the door of the building.
**No product exists for them. Anywhere. That is the opportunity.**

## 2. Why can't they just use Copilot? (the blocking rule, in plain terms)

Defense software lives on classified networks that are physically separated from the internet
("air-gapped"). Every mainstream AI tool — Copilot, Cursor, Claude Code, ChatGPT — is a cloud
service: your code goes to a US data center and the answer comes back. On a classified network
that is not "against policy," it is *impossible by construction*, and it would be a crime if it
weren't.

The US has spent three years and enormous money working around this for itself, and the result
proves how hard it is: even inside the Pentagon's own authorized environments, AI coding help is
**autocomplete and chat only**. GitHub Copilot passed US government certification in April 2026 —
with **agent features explicitly disabled** at the secret-adjacent level (IL5). Windsurf, the
first AI coding tool certified at FedRAMP High (March 2025): autocomplete. Claude on government
cloud: chat and suggestions. Getting a tool authorized costs **$0.5–3M and 18–24 months** per
attempt, and only ~57 organizations worldwide hold the relevant clearance level for platforms.

So the state of the world, verified as of July 2026: **no military anywhere — including the
US — has an authorized *agentic* coding platform** (one that plans a change, edits across files,
runs the tests, and shows its work). The most advanced militaries have chatbots. Everyone else
has nothing.

## 3. What militaries have today, and what they're asking for

**Ten countries + NATO have deployed or piloted defense LLMs** — all chat/analysis-first:

- **US**: CamoGPT (~75K Army users), GenAI.mil (1.5M users by June 2026, running OpenAI/
  Anthropic/Google/xAI models), SIPRGPT on secret networks, Palantir Maven as a program of record.
- **NATO**: bought Palantir's Maven in 2025; it compressed software release cycles from months
  to days — the alliance's own proof that faster software is a weapon.
- **France**: Mistral deployed across the armed forces under the ~€300M/yr AMIAD agency —
  the template for "national champion model + sovereign deployment."
- **Israel, China, UK, South Korea, Japan, Ukraine**: in-house or national systems, all
  analysis/decision-support-first.
- **India: not yet.** BharatGen and Sarvam are in *discussions* with MoD. Nothing is deployed.

Beyond the ten, **sixteen more countries + the EU have funded programs and explicit sovereign-AI
requirements** — Saudi (HUMAIN), Singapore (which picked Mistral *specifically because it isn't
American* — the single most important procurement signal for us), Poland, Turkey, Taiwan, Brazil,
Qatar, and more.

And of those aspirants, **ten realistically buy from an Indian vendor**, because they already buy
Indian defense exports (BrahMos, Akash) and run non-aligned procurement: **Vietnam, Singapore,
Bangladesh, Philippines, Indonesia, Brazil, Egypt, UAE, Saudi Arabia, Qatar.**

## 4. Who would actually use it every day? (the honest headcount)

We pressure-tested the obvious skeptic question: *do militaries even write much code?*

**Yes — a small, dense core codes daily; a much larger halo codes frequently.**

| Population | Size | What they do all day |
|---|---|---|
| US software factories (Kessel Run etc., ~36 of them) | ~8–15K daily coders | Real cadence: Kessel Run alone ships ~4,000 deployments/yr |
| US cleared contractors (Lockheed, Leidos, SAIC…) | ~50–100K frequent coders | Sustain 24M-line systems like the F-35; work in the same air-gapped rooms |
| India in-house (DRDO, BEL, HAL, WESEE, service C2 teams) | ~1,300–2,100 daily | Combat-management systems, avionics, radar/EW — written in-house, **not** by TCS/Infosys |
| World ex-US in-house (Unit 8200, HAVELSAN, DGA, CIR…) | ~30–40K | Israel's conscript units are the most intense; Turkey's HAVELSAN is 1,200 staff, 70% software engineers |

The work splits roughly 30% new code / 40% integration-and-glue / 30% bug-backlog — and all
three are what coding agents are best at.

**But the bigger discovery is the multiplier.** For every soldier or scientist who writes code,
**5–10 do knowledge work that is shaped exactly like an agent task**: an intelligence analyst who
pulls ten reports, reconciles them, and drafts an assessment (50K+ people in the US alone); an
operations planner who turns a mission into courses of action under constraints (~20K); a cyber
operator triaging alerts (~61K); a contracting officer assembling RFPs and compliance paperwork
(8–15K). This isn't speculative: when the Pentagon's GenAI.mil added agent creation, **users
built 100,000 agents in two weeks**. Ask Sage — used by ~15K government teams — reclassified
300K personnel records in one week and cuts security-authorization paperwork by ~95%.

**Product conclusion: coding-first, workload-wide.** The coding agent is the beachhead — its
output is verifiable (tests pass or they don't), its users are concentrated, its risk is low.
The same orchestrator, governance gate, and audit trail then extend to intelligence drafting,
planning, and procurement — populations 5–10× larger — by swapping the tool layer, not the core.

## 5. What they pay (contract ground truth, not analyst projections)

- **US**: OpenAI $200M/yr from DoD; Palantir Maven **$10B over 10 years** with the Army
  (plus $795M and $480M tranches). Anthropic's $200M deal was **cancelled within a year** on a
  "supply-chain risk" designation — proof these buyers churn vendors on geopolitics, which is
  precisely why a model-agnostic platform is the safer thing to sell.
- **France**: ~€300M/yr for defense AI overall (AMIAD), Mistral's framework inside it.
- **India today**: only ~$12–25M/yr effective LLM spend — early, which is the point. Entry money
  exists on the customer's side: **iDEX (₹498.78 cr, FY21-26) and ADITI (₹750 cr, grants up to
  ₹25 cr per startup)** fund exactly this class of deep-tech (both verified on ddpmod.gov.in).
- **The honest market number**: gen-AI-in-defense is ~$0.9–1.1B (2025-26) growing ~24%/yr.
  Ignore the $10–20B headlines (they bundle cyber and analytics).

**Yearly willingness-to-pay bands** (from contract comparables): superpower $500M–2B · large
militaries (India, France) €10–100M · mid-size (Poland, Korea, Gulf) €5–30M · smaller states
€1–10M. Pricing shapes seen in the wild: program-of-record ceilings with annual call-offs,
framework agreements, enterprise license + services, +20–50% sovereign-hosting premium.

**econ's serviceable near-term wedge**: India (grant-funded entry, DRDO's 100+ labs as anchor) +
the ten Indian-arms-trade countries at €1–30M/yr each ≈ **€30–150M/yr serviceable market** —
before any attempt at US/EU authorization.

## 6. The history lesson — which lane are we in? (the user's electronics/radar/drones question)

Militaries have absorbed outside technology waves in two ways:

- **They BUILD** when defense needs outrun the commercial world (radar in WWII: government labs
  → prime contractors, decades-long programs).
- **They BUY** when the commercial world outruns them. In 1994 the Perry memo ordered the US
  military to buy commercial electronics because MIL-SPEC chips had fallen behind; the primes who
  resisted lost the business. Cloud followed the same path ($9B spread across four commercial
  vendors). Satellites became a *subscription* (Ukraine ran its war on Starlink and commercial
  imagery).

AI is following the BUY pattern, demonstrably: the Pentagon buys OpenAI, NATO buys Palantir,
France buys Mistral. Nobody radar-style builds an LLM platform in-house — the EU tried the
build-it-yourself route with Galileo (GPS alternative): 25 years, €10B+, still a backup.

**The wave that matters most to us is drones — the one time a non-superpower commercial vendor
beat the primes.** Turkey's Bayraktar TB2 wasn't the best drone; it was good enough, cheap,
iterated fast, and *free of US export controls* — so 30+ countries that couldn't or wouldn't buy
American bought Turkish. When Canada banned exporting the TB2's camera, Turkey swapped in its own
Aselsan sensor within months and kept shipping.

**Our version of the swappable Turkish engine is open-weight models.** A buyer who says "no US
model" gets Qwen or GLM; one who says "no Chinese model" gets Llama or Mistral — swapped per
deployment, no one's permission required. The durable vendor value is everything around the
model: the orchestrator, the governance gate, the context engine, the audit trail. That's what
we sell; the engine is the buyer's geopolitical choice.

So the axis answer: **COTS-buy procurement mechanics, drone-style export conditions.** And 2026-27
is the window: the Anthropic–Pentagon standoff taught every allied military that even US frontier
vendors can be switched off (in either direction), and procurement doors (JWCC Next, national
programs) are explicitly widening to non-traditional vendors.

## 7. Why econ specifically — the pitch in the user's language

To a DRDO lab director or a defense CIO, the product sounds like this:

- **"It runs entirely inside your building."** No internet, no phoning home, no foreign cloud.
  Open-weight models on your GPUs, on your classified network. (Our whole architecture — cheap
  local tiers doing 90-95% of the work — was built for exactly this shape.)
- **"The agent never acts without a gate, and every action is logged for your auditor."** Our
  in-loop governance gate — built as a code-safety feature — is, in defense, the license to
  operate. Militaries don't want autonomy; they want *governed* semi-autonomy with a paper trail.
  That's not a compromise of our product; it *is* our product.
- **"You choose whose model runs inside it."** Model-agnostic by design. Your geopolitics, your
  engine. No kill-switch risk from Washington or Beijing.
- **"It costs what a mid-size military can pay."** Palantir-class deals start near $100M. Our
  cost-routed stack lands in the €1–30M/yr band where the other ninety militaries live.
- **"Start with code, grow into the rest."** First it helps your 200 engineers ship the combat-
  management system faster. Then the same platform drafts the intelligence summary, the operations
  plan annex, the procurement paperwork — with the same gate and the same audit trail.

And the strategic framing for us: **the "Palantir alternative for the non-aligned world" slot is
empty.** The US/NATO slot is taken (Palantir, Ask Sage). China builds its own. Everyone else —
India, SE Asia, the Gulf, LATAM — can't buy American (kill-switch risk, cost), won't buy Chinese,
and has nothing. Manus proved a small team can build a general agent product; Manus is Chinese-
origin and therefore disqualified from this entire market. The geopolitical filter removes almost
every capable competitor before the game starts.

## 8. What could kill it (the honest list)

1. **Clock-speed mismatch.** Defense sales run 12–24 months with security reviews. econ ships in
   weeks. If defense revenue is expected to pay the bills, we die waiting. It must be a second
   track funded by the commercial product.
2. **Sarvam.** Government-backed, already in MoD discussions, and its ICAI deal shows its
   playbook: institution-distributed sovereign AI. If anyone takes the India slot while we're
   heads-down, it's them. Counter: they're a model company; this is a platform/harness game —
   but distribution beats architecture if we're not in the room.
3. **The integration burden.** Palantir's real moat is twenty years of data-plumbing into
   military systems plus thousands of forward-deployed engineers. We must not build that muscle —
   **BEL/HAL/GSIs are the forward-deployed layer; we are the product.** That is also how Indian
   defense procurement already works.
4. **Early deal sizes.** Year 1–2 realistic revenue is one ₹5–15 cr pilot-to-program, not
   venture-scale. The prize is the credential, which compounds; the cash comes later.
5. **Vendor-churn geopolitics cuts both ways.** The same forces that evict US vendors from
   non-aligned markets could complicate an Indian vendor in others. Model-agnosticism and
   on-soil deployment are the hedge.
6. **The Gulf is not direct-sale territory** (verified 2026-07-04). UAE (Tawazun), Saudi (GAMI),
   and Qatar (Barzan) mandate localization: JVs, technology transfer, local work packages
   (Thales's 2025 UAE deal routed $163M to 20+ local suppliers), 18–36 month cycles. Discount
   the three Gulf names in our ten-country list to *partner-led, later-stage*: enter as a
   JV/sub-supplier through a local entity or don't enter. The nearer seven (Vietnam, Singapore,
   Bangladesh, Philippines, Indonesia, Brazil, Egypt) remain direct-sale candidates.

## 9. The plan — a track, not a pivot (~10–15% of effort, zero product divergence)

1. **File an iDEX/ADITI application** (next quarter). Non-dilutive money (up to ₹25 cr) that
   funds the offline-first hardening we want anyway.
2. **One anchor pilot** — CAIR/CASDIC (DRDO) or BEL's software SBU — to a working on-prem
   deployment within 12 months. One lab with 50–200 engineers, not a broad campaign.
3. **One defense-BD hire/contract** with clearances and relationships. Our biggest real gap is
   this person, not technology.
4. **Keep commercial econ as the fast engine.** The defense build is ~90% the same artifact;
   every commercial improvement ships into the classified deployment.
5. **Kill criteria:** no grant and no converting pilot within ~18 months → the market said no;
   we'll have spent little and keep the hardened offline mode as a commercial feature
   (banks want it too).

**The compounding asset:** the first vendor with a *cleared, deployed, audited* agentic platform
inside a defense network owns a credential nobody can rent or copy — and it travels to all ten
exportable countries, where the same authorization playbook repeats.

**The category is wider than defense (third sweep, 2026-07-04).** Defense is the sharpest wedge
into a single buyer category: **the sovereign public sector** — every government or
government-adjacent establishment whose network is isolated by law and who cannot buy US cloud
AI at any price. The same product travels outward in concentric rings by clearance friction:
defense core (DRDO/BEL) → **space** (ISRO: VSSC+URSC+ISTRAC ≈7,400 staff, ~4,400–5,200 coding,
air-gapped, zero certified vendors; IN-SPACe's ₹500 cr Technology Adoption Fund — up to ₹25 cr
per project — is a second grant channel alongside iDEX/ADITI) → **nuclear/grid PSUs** (CEA's
2025 regulations make OT/IT isolation law) → **civilian government software factories** (NIC's
developers across 741 districts, C-DAC, CRIS — no on-prem AI coding vendor sells to Indian
government today; IndiaAI's ₹2,000 cr FY25-26 budget is the funding backdrop). One credential,
one BD motion, ring after ring — and Sarvam is the common competitor on a 6–12 month clock in
every ring. Full verdicts: rows 20–22 in
[WHITESPACE_EXPLORATION.md](./WHITESPACE_EXPLORATION.md).

## 10. Verdict

A real shot, sized correctly: the buyer is hard-blocked from every alternative, the gap is
verified globally (even the US has only chatbots behind the wire), our architecture is
accidentally pre-adapted, the customer's side funds the entry, and the competition is filtered
out by geopolitics rather than capability. The risks are organizational — patience, BD, and
Sarvam — not technical. Play it as the patient second track; let the credential compound.

---

## Appendix: where the evidence lives

The full exploration record — verdict table across all 19 directions, the verification ledger
(every load-bearing statistic checked against primary sources, several corrected), and the
research-sweep outputs — is in [WHITESPACE_EXPLORATION.md](./WHITESPACE_EXPLORATION.md).
Load-bearing primary sources for this doc: ddpmod.gov.in (iDEX ₹498.78 cr, ADITI ₹750 cr /
₹25 cr ceiling), DefenseScoop (GenAI.mil rollout + 100K agents; NATO Maven), Bloomberg/CNBC
(Palantir $10B Army; OpenAI $200M), Anthropic/press (DoD deal cancellation, Feb–Mar 2026),
Businesswire (Windsurf FedRAMP High, Mar 2025), GitHub docs (Copilot FedRAMP, agents unavailable
at IL5), armyrecognition/gend.co (Mistral×AMIAD), DSO Singapore (Mistral partnership), Kyiv
Independent/CSIS (Ukraine Brave1), Microsoft (GSI Copilot deployments), The Print (WESEE),
BEL/HAL official product pages (CMS, IACCS, avionics).
