# econ — GTM Demand Signals: Mid/Small IT Services & GCCs (India + SEA)

**Status:** Drafted 2026-07-10. Web research (July 2026) answering one question: *is coding-agent
demand in our reachable segment — mid/small IT services firms and mid-market GCCs in India & SEA —
real and observable, and how do we build a target list of specific companies?* Companion to
[POSITIONING.md](./POSITIONING.md) (the wedge), [ENTERPRISE_SEGMENTATION.md](./ENTERPRISE_SEGMENTATION.md)
(segments & three-lane GTM), [MARKET_ECONOMICS.md](./MARKET_ECONOMICS.md) (India sizing) and
[COMPETITORS.md](./COMPETITORS.md) (who else sells into this lane). Sources §7.

> **One-line verdict.** Demand is real and visible — but it is **bottom-up**. Developers in this
> segment have already adopted coding agents (~95% weekly use across India + SEA); their employers
> mostly haven't provisioned seats, set policies, or trained anyone — while their clients
> simultaneously demand ~20% price cuts. The reachable wedge is the **un-provisioned middle**:
> firms whose devs already use (and sometimes self-pay for) the tools while management stalls on
> frontier pricing.

---

## 1. The question

Our core proposition assumes mid/small IT services firms and GCCs feel coding-agent cost as a
significant fraction of employee CTC. Before outreach we needed to know: (a) has this segment
actually adopted or started evaluating coding agents, or is it pre-awareness? (b) what drives the
adopters? (c) have they concluded the tools are a must-have? (d) what observable signals reveal a
specific company's stage, so we can build a target list without starting at large GCCs / large
service firms we can't reach?

## 2. What the evidence shows — three layers

**Layer 1 — developers: adoption is basically done.** Agoda's 2025 survey of 600+ developers
across India, Vietnam, Indonesia, Singapore, Thailand, Malaysia and the Philippines: **95% use AI
tools weekly, >50% keep an assistant open all day, 94% use it for code generation, 80% cite speed
as the motivation, 37% save 4–6 hrs/week**. A hiring-platform dataset found **71% of job candidates
in Vietnam, the Philippines and Indonesia used Copilot or Cursor daily in Q1 2026**. India ranks at
the top globally — ~60% of Indian IT professionals say their company actively incorporates AI
(highest alongside China; secondhand synthesis of GitHub's 2024 survey — verify before quoting in a
deck), and India is now **Claude's #2 market worldwide** (6% of all conversations; nearly half of
Indian usage is coding work; Anthropic's run-rate revenue in India doubled since Oct 2025).

**Layer 2 — big firms: moved, loudly.** TCS/Infosys/Wipro scaled Copilot past **300,000 seats**
(Jun 2026); LTIMindtree signed a strategic GitHub alliance including Copilot training; Infosys and
Air India are named Anthropic partners (Air India uses Claude Code). The majors are also building
proprietary platforms (Infosys Topaz, Wipro ai360, Mphasis Tria, Coforge AgentSphere). Even MeitY
says it publicly: *"Indian IT firms must build their own coding agents to stay competitive."* The
tier below watches all of this and knows it can't ignore it.

**Layer 3 — mid/small companies: way behind their own developers.** Only **25% of teams have any
formal AI policy**; only **28% of developers get employer-led training** (71% self-taught). Broader
SME AI adoption in India sits around **15%**. And the affordability pain is on record: a viral
r/developersIndia story (Nov 2025, covered by BusinessToday) of an Indian product startup **forcing
developers to buy Cursor subscriptions from their own salaries and "beg for reimbursement"** —
management wanted the output (80% test-coverage targets) but wouldn't pay for seats. That story is
the thesis in miniature: companies want the productivity, choke on frontier pricing, and developers
value the tools enough to self-pay.

## 3. Drivers, in order of force

1. **Client price pressure, not enthusiasm.** Clients of Indian IT vendors are demanding price cuts
   of **up to 20%**; contracts are shifting from headcount-based to outcome-based pricing (HFS calls
   it "Services-as-Software"; fixed-price share fell to 52% of revenue in Q1 FY25 as models churn).
   A service firm that must deliver the same work ~20% cheaper *has* to make each developer more
   productive. This is a **survival-margin** driver — the strongest form of must-have.
2. **Hiring-market signaling.** Copilot/Cursor experience now appears in job requirements (537+
   Copilot-tagged jobs on foundit.in; e.g. CGI's Hyderabad Python Developer posting requiring
   Copilot), and Indian coding interviews increasingly *allow* Cursor/Copilot during tests with an
   AI-off debugging round after. When a skill enters JDs, the company has internalized the tool.
3. **Speed/efficiency.** The stated motivation for 80% of SEA/India devs; real but weaker than 1–2
   as a *purchase* trigger for management.

## 4. Realization stage — have they concluded it's a must-have?

Split answer, and the split **is** the opportunity:

- **Developers: yes, fully.** Self-paying is the proof — the strongest possible demand signal for
  an affordable product.
- **Mid/small management: middle stage.** Aware (their own devs use the tools), pressured (clients,
  big-firm example, hiring market), but not operationalized — no policies, no training, no seats.
  They haven't concluded "buy for everyone"; they've concluded "this is happening and we don't have
  a plan." That is the ideal entry moment — **before** Copilot/Cursor seat-lock them.

## 5. Signals playbook — how to build the target list

Ordered by cost-to-check and reliability. Signals 1–2 yield **company names**, not market averages.

| # | Signal | Where to look | What it tells you |
|---|---|---|---|
| 1 | **Job postings naming Copilot / Cursor / "AI-assisted development"** | Naukri, foundit, LinkedIn India, SEA boards; filter 50–500-employee firms | Firm has adopted or mandated the tools — already past evaluation |
| 2 | **Self-pay / reimbursement complaints** | r/developersIndia, Blind, X | Exact ICP, pre-qualified on price sensitivity: devs want it, management won't pay current prices |
| 3 | **Founder/CTO LinkedIn posts; "AI-first delivery" claims on services pages** | LinkedIn; company websites of 50–500-person firms | Actively investing / repositioning — evaluation or rollout underway |
| 4 | **Vendor case-study orbit** | GitHub / Cursor / Anthropic named-customer posts; who reshared/commented | Named firms are too big for us; the mid-size firms *imitating* them are the list |
| 5 | **Interview policy: Cursor/Copilot allowed in coding rounds** | Recruiters, hiring platforms, candidate reports | Tools normalized internally |
| 6 | **NASSCOM community, Zinnov-NASSCOM mid-market GCC report, conference speakers** | nasscom community, Zinnov mid-market GCC 2025 report, event agendas | Mid-market GCC tier self-identifying as evaluators |
| 7 | **Vietnam outsourcing firms repositioning as AI-dev shops** | TNGlobal/tech press, firm marketing | SEA track: near-universal usage + cost-sensitive by nature |

**First action this implies:** scrape signal #1 (Naukri/foundit/LinkedIn, postings mentioning
Copilot/Cursor/AI-assisted development, filtered to 50–500-employee IT services firms and GCC
units). Free, current, and returns company names directly. Validate signal #2 in the first ~20
outreach calls with one question: *"do you provide coding-agent licenses, or do your devs use their
own?"* — the answer instantly stages the account.

## 6. India vs SEA priority

- **India first.** Highest awareness, biggest price pain (the self-pay stories are Indian),
  strongest client-pressure driver, and the frontier vendors have already educated the market
  (Copilot/Cursor/Claude). We sell into primed demand.
- **Vietnam second.** Looks most like India: near-universal dev usage, outsourcing firms
  repositioning from body-shop to AI development, cost-sensitive by nature.
- **Indonesia/Philippines third.** High candidate-level tool usage; Philippines skews BPO with less
  AI-dev depth.
- **Singapore last.** Better-funded firms, ~2× the formal employer-led AI training of Vietnam —
  more likely already provisioned with frontier tools; weakest fit for the affordability wedge.

## 7. Where the evidence is thin (be honest in decks)

- **No published seat-count or spend data exists for mid/small Indian IT firms specifically.**
  Everything firm-level is about the giants; the SME picture is inferred from developer surveys and
  anecdotes.
- The "~60% of Indian companies incorporate AI" figure is a secondhand synthesis of GitHub's 2024
  survey — directionally right; verify at the original before external use.
- **No procurement/tender signal exists** — mid/small firms don't run public tenders for dev tools;
  that channel is a dead end.
- The **self-pay pattern is vivid but anecdotal** (one viral story + community chatter). Treat it as
  a hypothesis to test in the first 20 conversations, not a proven statistic.

### Sources

- [Agoda AI Developer Report 2025 coverage — ITBrief Asia](https://itbrief.asia/story/ai-tools-widely-adopted-by-southeast-asia-india-developers) (95% weekly, 25% policies, 28% training, 80% speed, 37% hours saved; 600+ devs, Aug–Sep 2025)
- [Second Talent — Asia outsourcing country guide](https://www.secondtalent.com/resources/outsource-software-development-to-asia-country-guide/) (71% daily Copilot/Cursor among VN/PH/ID candidates, Q1 2026)
- [Anthropic — Bengaluru office & India partnerships](https://www.anthropic.com/news/bengaluru-office-partnerships-across-india) (India #2 Claude market, 6% of conversations, Air India/Infosys, revenue 2× since Oct 2025)
- [Medium synthesis — AI adoption among developers by country, 2023–2025](https://medium.com/@josh_55705/i-adoption-among-software-developers-in-select-countries-2023-2025-88f7b46eecbb) (~60% India company-incorporation claim; GitHub 2024 survey + Stack Overflow 2023–25)
- [Microsoft — Infosys, TCS, Wipro scale Copilot past 300k seats (Jun 2026)](https://news.microsoft.com/source/asia/2026/06/03/infosys-tcs-and-wipro-scale-microsoft-365-copilot-to-over-300000-employees/)
- [LTIMindtree–GitHub strategic alliance — DEVOPSdigest](https://www.devopsdigest.com/ltimindtree-partners-with-github)
- [Outsource Accelerator — AI disruption forces Indian IT to rethink contracts](https://news.outsourceaccelerator.com/indian-it-giants-outsourcing-contracts/) (up to 20% client price-cut demands; HFS "Services-as-Software"; fixed-price share 52%)
- [BusinessToday — "Beg for reimbursement": startup makes staff pay for Cursor (Nov 2025)](https://www.businesstoday.in/latest/trends/story/beg-for-reimbursement-software-developer-flags-peak-extortion-as-startup-makes-staff-pay-for-companys-ai-tool-501384-2025-11-09)
- [BusinessToday — MeitY: Indian IT firms must build own coding agents (Feb 2026)](https://www.businesstoday.in/amp/technology/news/story/indian-it-firms-must-build-its-own-coding-agents-to-stay-competitive-in-ai-era-514735-2026-02-05)
- [NUS ISAS — AI adoption in India](https://www.isas.nus.edu.sg/papers/ai-adoption-in-india-moving-the-needle-forward/) (~15% SME AI adoption; cost + skills barriers)
- [foundit.in — GitHub Copilot jobs in India](https://www.foundit.in/search/github-copilot-jobs) · [Naukri — CGI Python Developer requiring Copilot](https://www.naukri.com/job-listings-python-developer-github-copilot-devops-with-3-6-years-of-exp-cgi-hyderabad-3-to-6-years-240626022551)
- [Zinnov-NASSCOM Mid-Market GCC Report 2025](https://zinnov.com/centers-of-excellence/zinnov-nasscom-mid-market-global-capability-centers-gccs-2025-report/) · [Zinnov-NASSCOM India GCC Landscape 2026](https://zinnov.com/centers-of-excellence/zinnov-nasscom-india-gcc-landscape-2026-report/)
- [TNGlobal — Vietnam's developers moving from outsourcing to AI building (Jun 2026)](https://technode.global/2026/06/18/vietnams-developers-are-moving-from-outsourcing-to-ai-building/)
- [Stack Overflow Developer Survey 2025 — AI section](https://survey.stackoverflow.co/2025/ai/) (84% use/plan to use, global baseline)
