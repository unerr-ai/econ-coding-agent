# Coding agents × language & framework coverage — where the tools work, where they fail, where the money is

**Status:** Drafted 2026-07-20 from a two-day verified research sweep (smart-query web research, July
2026 sources; all figures linked in §10). Companion to
[COMPETITORS.md](./COMPETITORS.md) (the player map, incl. §5 Grok 4.5),
[ENTERPRISE_SEGMENTATION.md](./ENTERPRISE_SEGMENTATION.md) (the buyer map), and
[WHITESPACE_EXPLORATION.md](./WHITESPACE_EXPLORATION.md).

> **One-line verdict.** Coding agents are excellent on a thin modern slice of the world's software,
> and the gap everywhere else is **not** "the model doesn't know the language" — it is four specific,
> different failure modes (version drift, no runnable environment, context locked inside platforms,
> certification-not-tests). Three of the four are **harness-layer problems** — the layer econ builds.
> And nobody on earth has an agentic benchmark for legacy code, which is itself an opportunity.

---

## 0. The five segments — don't treat "software" as one thing

Software in production today is not one market for coding agents; it is five, with different
coverage, different pain, and different competitors. In plain terms:

| Segment | What's in it | Agent coverage today | The real pain | Who's serving it |
|---|---|---|---|---|
| **T1 — Ancient** | COBOL, PL/I, JCL, mainframe assembler, RPG, MUMPS, TPF, Natural | Effectively zero in mainstream agents | Retiring workforce + can't-verify edits | IBM/BMC captive tools at the top; mid-market open |
| **T2 — Medieval** | Java 8/EE, .NET Framework 4.x, Struts/EJB-era frameworks, old PHP/Perl/C++ | Strong on *language*, weak on *era*; heavy hyperscaler investment | Version/framework migration | AWS & Microsoft (subsidized); long tail open |
| **T3 — Modern** | Python, TypeScript/JS, Go, Rust, Java 17+, .NET 8+ | Saturated — every benchmark and every agent lives here | Cost, hallucination, verification | Everyone; competition is on price & trust |
| **T4a — Proprietary business platforms** | ABAP, Apex, PL/SQL + Forms, ServiceNow script, PeopleCode, low-code (Mendix/OutSystems) | Vendor-captive AI on each platform | Platform metadata invisible to outside agents | Each platform vendor itself |
| **T4b — Industrial / engineering** | PLC ladder logic & Structured Text (IEC 61131-3), MATLAB/Simulink, LabVIEW | Deterministic code-gen + nascent LLM specialists | Safety certification, dialect fragmentation | Vendor tools + niche startups |

The rest of this doc walks each segment, then pulls out the cross-cutting failure modes (§6) and the
benchmark blind spot (§7).

---

## 1. T1 — Ancient: the systems that run the economy, invisible to agents

**Who runs it, verified:** COBOL still has ~220 billion lines in active production and sits behind
~95% of ATM transactions, 80%+ of in-person card payments, 45 of the top 50 banks, and 8 of the top
10 insurers. Epic — serving roughly 78% of US patients — runs on the MUMPS family. Airline and card
processing runs on TPF, where ~90% of application code is assembler. RPG on IBM i quietly runs
mid-market manufacturing and distribution. The workforce is the crisis: the average mainframe
engineer is 58.7 years old, and 2025 produced 147 new COBOL graduates.

**Coverage:** no mainstream coding agent is trained, benchmarked, or harness-equipped for any of
these. The important nuance — and where the popular "AI can't see COBOL" narrative is wrong — is
that frontier models *explain* COBOL rather well (GitHub publishes official COBOL-modernization
playbooks, and case-study developers report the AI answering legacy questions correctly "9 times out
of 10"). The wall is not reading the syntax. The wall is:

1. **No runnable environment.** Agents improve code by run-test-fix. There is no cheap local z/OS;
   compiling COBOL against CICS/DB2 happens on licensed big iron. An agent that can't execute
   can't verify.
2. **Cross-artifact dependencies.** The unit of behavior is a JCL job → COBOL program → copybooks →
   CICS/IMS/DB2 — invisible to file-scoped tools.
3. **No tests, no "why".** Decades of undocumented patches, so every edit is a governance problem.

**Who serves it:** IBM owns the top — watsonx Code Assistant for Z (now transforming COBOL *and*
PL/I to Java), the multi-model **IBM Bob** (GA March 2026; notably runs Granite + Claude + Llama +
Mistral under the hood), watsonx for i (RPG), plus BMC AMI DevX. 73% of IBM i shops say AI
integration is now a priority, which tells you the demand side is warm.

> **Verdict:** category validated, top of market owned by IBM, **mid-market open** (IBM i shops,
> Natural/Adabas estates, and the VB6/Delphi/PowerBuilder tier below them — for which, honestly, no
> reliable installed-base numbers exist anywhere).

## 2. T2 — Medieval: supported languages, abandoned eras

This segment is easy to underestimate because the *languages* are "supported" — Java and C# are
high-resource languages every model knows. The pain is the **era**: 23% of production Java is still
Java 8, and 19% of shops still run Java 6 or 7 somewhere; .NET Framework 4.x is the acknowledged
"zombie runtime" of enterprise Windows estates.

**Coverage — the hottest AI investment of any segment, and it's subsidized:**

- **Amazon Q Developer Transform**: agentic Java 8→17 upgrades (a documented case: 10,000 lines,
  "two weeks of expert work in minutes", 60% tech-debt reduction), .NET Framework → cross-platform
  .NET ("6–8 month project in days"), plus mainframe and VMware transforms.
- **GitHub Copilot app modernization**: Java upgrades across 8/11/17/21/25 and .NET migration —
  pointed firmly at Azure.

Both exist to sell cloud migration; AWS and Microsoft effectively subsidize the tooling the way
Grok 4.5's pricing is subsidized (see [COMPETITORS.md §5](./COMPETITORS.md)) — worth using, unwise
to compete with head-on.

**Where it fails — the long tail below the blessed paths.** The transform agents assume standard
**Maven/Gradle/MSBuild** projects moving between LTS versions. Below that line lives the real
legacy: Ant builds, custom build systems, Struts 1.x/EJB 2.x, app-server-coupled code. Sizing is
fuzzy (nobody publishes "non-Maven enterprise Java share"), but the directional numbers are telling:
by installed-company count, **Ant (6.09%) still has a larger footprint than Gradle (5.45%)** in
build automation, with Maven at ~40% — i.e., the pre-Maven tail is roughly the size of the entire
Gradle universe. General agents in this tail commit the classic failure: hallucinating modern
idioms and libraries into environments that can't run them.

> **Verdict:** top contested and hyperscaler-subsidized; **the below-the-blessed-path tail is open**
> and is exactly where GSI-maintained mid-market estates live.

## 3. T3 — Modern: saturated coverage, economic pain

Python/TS at the top, Java/Go/Rust close behind, C/C++/PHP measurably worse — but all *covered*.
Every benchmark (SWE-bench Verified, SWE-bench Multilingual, Multi-SWE-bench) and, more importantly,
all harness-native RL training (Cursor interaction traces, Grok Build environments) happens here.
The pain isn't coverage; it's **cost per completed task, hallucination, and verification** — the
competitive game econ already plays, so this doc doesn't relitigate it.

One dynamic worth naming: because agent *training* is now harness-native RL on modern stacks, every
training round widens the gap between T3 and everything else. The blind spots are compounding, not
closing.

## 4. T4a — Proprietary business platforms: every vendor built a captive copilot

The consistent pattern across this whole segment (verified platform by platform): **the platform
vendor builds its own AI, third-party agents are structurally locked out, and the lock is data
access, not model quality.** The context an agent needs — metadata catalogs, org configuration, the
runtime itself — lives inside the platform, not in files a filesystem agent can read.

| Platform | Captive AI (July 2026) | State | The crack in the wall |
|---|---|---|---|
| SAP / ABAP | Joule for Developers (trained on millions of lines of ABAP/CDS); mass Custom Code Migration agent Q2 2026 | Shipping | **Cloud-only — on-prem S/4HANA has no Joule**; Copilot-ABAP stopgap hallucinates BAPIs; ADT-for-VS-Code (Q2 2026) opens MCP access |
| Salesforce / Apex | Agentforce Vibes 2.0 — multi-model (Claude, GPT-5), org-metadata-aware | Shipping | Governance of AI code volume (75% test mandate, governor limits, DORA evidence) |
| Oracle DB / APEX | APEX AI Assistant in-editor (PL/SQL, SQL, JS); AI **Forms→APEX migration agent** (APEX 26.1) | Shipping | The Forms/PL-SQL estate *outside* Oracle's blessed migration path |
| ServiceNow | Now Assist text-to-code | Shipping | Platform-flavored JS; shallow vs. full agentic loops |
| PeopleSoft / PeopleCode | "Code Assist" in PeopleTools 8.63 — LLM chat in Application Designer, PeopleCode-only writeback | **Planned, not shipped** | The laggard of the segment; third parties (PeopleSoft AI Studio) filling in with Classic→Fluid migration |
| Siebel | — | **Nothing found** | Likely unserved entirely (unverified) |
| Low-code (Mendix / OutSystems) | Mendix **Maia**; OutSystems **Mentor** + Agent Workbench | Shipping, aggressive | Captive by construction — the "code" isn't portable |

> **Verdict:** don't fight captive AI on its own platform. The addressable cracks are **on-prem
> estates the vendor's cloud AI won't serve** (Joule), **laggard platforms** (PeopleSoft now,
> Siebel apparently forever), and **cross-platform work** — the integrations and custom code that
> span platform + surrounding modern services, where no single captive assistant has the full picture.

## 5. T4b — Industrial / engineering: certification beats generation

PLC programming (ladder logic / Structured Text across Rockwell, Siemens, Schneider, Omron,
Mitsubishi dialects), MATLAB/Simulink, LabVIEW. The incumbent "code generation" here is
**deterministic, not LLM** — Simulink PLC Coder generates IEC 61131-3 code from verified models,
which is exactly what a safety culture wants. LLM specialists are appearing (PLCAutoPilot for
Schneider lines; NI's **Nigel** bringing code completion to LabVIEW 2026 Q1), and the practitioner
consensus is blunt: "rarely fully automatic — AI drafts, the engineer verifies."

The binding constraint is **failure mode D**: correctness means certification (TÜV, functional
safety), not passing tests. An agent harness has nothing to grab onto — there is no
run-test-fix loop whose green light anyone will accept.

> **Verdict:** structurally hostile to general agents; per-vendor specialists will own it.
> **Not econ's fight.** Watch only for the boundary case: the *non-safety* software around the
> plant (HMIs, historians, integration glue) is ordinary T2/T3 work.

---

## 6. The four failure modes — why "support more languages" is the wrong frame

Modern solutions fail differently in each segment. Naming the mechanism matters, because each one
implies a different fix — and three of the four are harness-layer fixes, not model fixes:

| # | Failure mode | Segment | What actually breaks | What a fix requires |
|---|---|---|---|---|
| **A** | **Version/framework drift** | T2 | Model knows the language, hallucinates the wrong *era*; transform agents only cover blessed build paths | Version-pinned context, toolchain detection, verified upgrade recipes |
| **B** | **No executable environment** | T1 | No local mainframe → no run-test-fix → no verification | Environment sensing, emulation/shims (e.g. GnuCOBOL as proxy runtime), graph-based static verification, governance gates for test-poor code |
| **C** | **Context lives in the platform** | T4a | Truth is metadata/org-config/runtime, not files | Platform connectors (the MCP era helps), metadata-aware context engines |
| **D** | **Correctness = certification** | T4b | Tests aren't the acceptance bar | Not addressable by agent harnesses today — avoid |

And the market shape in one sentence: **pain is highest where coverage is lowest (T1), money
currently flows fastest where coverage is easiest (T2, hyperscaler-subsidized), and T4a pain is
being absorbed by captive vendor AI** — leaving three durable openings: the T2 long tail, the T1
mid-market, and T4a's on-prem/laggard/cross-platform cracks.

## 7. The benchmark blind spot — and the LegacySWE-bench opportunity

What exists today, checked (July 2026):

- **Mainstream agentic benchmarks contain zero legacy languages.** SWE-bench Verified is
  Python-only; SWE-bench Multilingual covers 8 modern languages (C, C++, Go, Java, JS/TS, PHP,
  Ruby, Rust); Multi-SWE-bench covers 7 — and its core finding is that resolve rates fall sharply
  even *within* the modern set once you leave Python.
- **Legacy-language evaluation exists only at snippet/knowledge level:** COBOLEval (146 HumanEval
  tasks hand-translated to COBOL, execution-based), COBOLCodeBench, MainframeBench (multiple-choice
  + QA + COBOL summarization — knowledge, not action), OpenCBS (COBOL defect suite), COBRAIN
  (business-rule extraction), and a proposed COBOL↔Java translation benchmark. Domain models exist
  too (XMainframe, COBOL-Coder) — trained on the languages, still evaluated on snippets.

**Nobody has a SWE-bench-shaped benchmark for legacy code** — real repository, real issue, runnable
environment, hidden tests, graded patch — for COBOL, RPG, Java-8-on-Ant, or any T1/T2 stack. The
reason is failure mode B itself: building one requires solving the environment problem (licensed
runtimes, cross-artifact builds), which is why it hasn't happened and why it's defensible for
whoever does it.

What one would look like, concretely:

1. **T2 track first (cheap):** real Java 8 + Ant/Struts-era open-source repos (they exist on GitHub
   in numbers), frozen dependency environments, real issues, hidden tests — the standard SWE-bench
   recipe applied one era back. Nothing blocks this but effort.
2. **T1 track (the moat):** COBOL batch programs on **GnuCOBOL** as a proxy runtime, JCL modeled as
   a job graph, tasks graded on behavior-preserving edits + generated-test quality rather than
   pre-existing suites. Imperfect fidelity to z/OS, but infinitely better than the current nothing.
3. **Grade what enterprises buy:** comprehension (rule extraction accuracy), safe modification
   (regression-free edits under no-test conditions), and translation fidelity — not just
   issue-resolution rate.

For econ specifically: we build SWE arenas and graded environments as daily infrastructure
(the benchmark-harness muscle in [`docs/testing/`](../testing/)); the T2 track is well within reach
and would (a) measure the exact lane the incumbents ignore, (b) generate the RL/finetune trace data
for it, and (c) hand marketing a number nobody else can quote.

## 8. What this means for econ

Kept short, because the competitive geometry lives in
[COMPETITORS.md](./COMPETITORS.md) and the buyer map in
[ENTERPRISE_SEGMENTATION.md](./ENTERPRISE_SEGMENTATION.md):

1. **Failure modes A, B, C are the harness thesis restated.** Environment/toolchain sensing,
   dependency graphs, version-pinned context, and edit-time governance for test-poor code are what
   we build anyway — the legacy lanes are additional *markets* for the same machinery, not a new
   product.
2. **The open lanes match our buyers.** T2 long tail + T1 mid-market + T4a on-prem estates are
   GSI-maintained, cost-sensitive, compliance-bound — the same profile as our India/enterprise
   wedge, and Indian GSIs hold the world's legacy-maintenance books.
3. **Don't fight captive AI or safety certification.** T4a head-on and T4b are structural no-gos.
4. **The benchmark gap is a cheap, loud flag to plant** (§7): a T2 legacy track is buildable with
   our existing arena infrastructure.

## 9. Open questions / next probes

- Siebel: no AI tooling found at all — confirm before calling it unserved.
- Hard installed-base numbers for VB6/Delphi/PowerBuilder/ColdFusion estates (none exist publicly;
  any number quoted anywhere is folklore).
- .NET Framework 4.x install-base share (directionally huge, no verified figure).
- The T2 long-tail sizing deserves a primary source better than build-tool market share
  (e.g., JetBrains/Azul raw survey crosstabs: version × build tool).
- Whether GnuCOBOL fidelity is sufficient for a credible T1 benchmark track.

## 10. Sources

July 2026 sweep; full URLs in the conversations that produced this doc.

- **T1 prevalence** — datafield.dev (COBOL 2026 stats: 220B lines, ATM/card shares, bank counts);
  dxc.com (banks on COBOL); metaintro.com (workforce: 58.7 avg age, 147 grads);
  michael-gokey-architect.medium.com + en.wikipedia.org/wiki/MUMPS (Epic/MUMPS ~78% patients; TPF
  ~90% assembler); mordorintelligence.com + fortunebusinessinsights.com (modernization market
  ~$29–30B 2026 → ~$92B 2034)
- **T1 tools** — ibm.com (watsonx Code Assistant for Z; agentic announcement); croz.net (v2.8.20
  COBOL+PL/I→Java; Project Bob); itjungle.com (IBM Bob 1.0 GA 2026-03-24, multi-model; 73% IBM i
  AI priority); prolifics.com (watsonx for i)
- **T1 "models can read COBOL"** — github.com/resources/whitepapers (COBOL modernization
  whitepaper); github.blog (legacy-systems case studies, "9 times out of 10")
- **T2 market** — azul.com 2025 State of Java (Java 8 = 23%, down from 40% in 2023); javapro.io
  (19% on Java 6/7); news.ycombinator.com/item?id=43643028 (".NET 4.x / JDK 8 zombie runtimes");
  6sense.com (build automation share: Maven 40.29%, Ant 6.09%, Gradle 5.45%); jetbrains survey via
  medium.com (52/48 Maven/Gradle among active devs)
- **T2 tools** — aws.amazon.com/q/developer/transform (Java/.NET/mainframe/VMware transforms;
  Novacomp + Signaturit cases); learn.microsoft.com (Copilot app modernization for Java + .NET)
- **T3 benchmarks** — arxiv.org/abs/2504.02605 (Multi-SWE-bench, 1,632 instances, 7 languages);
  SWE-bench Multilingual (300 tasks, 8 languages); arxiv.org/html/2410.03981v3 (LRPL/DSL survey;
  MultiPL-E gap: Python/JS/Java 50–75% vs ≤30% low-resource)
- **T4a** — community.sap.com (Joule roadmap, CCM agent Q2 2026, ADT-for-VS-Code);
  devblogs.microsoft.com (Copilot ABAP in Eclipse); developer.salesforce.com +
  qualityclouds.ai (Agentforce Vibes 2.0; governance); apex.oracle.com + blogs.oracle.com (APEX AI
  Assistant; Forms→APEX agent; APEX 26.1); servicenow.com (Now Assist text-to-code);
  1218global.com + peoplesoftinsider.substack.com (PeopleTools 8.63 Code Assist, planned;
  skepticism on customizations); peoplesoftaistudio.com (third-party Classic→Fluid);
  progressiverobot.com + outsystems.com + medium.com/mendix (Mentor, Maia)
- **T4b** — mathworks.com (Simulink PLC Coder → CODESYS/Rockwell/Siemens/Omron/Mitsubishi);
  plccopilot.com ("rarely fully automatic"); plcautopilot.com (Schneider lines); ni.com (Nigel:
  LabVIEW code completion 2026 Q1)
- **§7 legacy benchmarks** — COBOLEval (146 HumanEval→COBOL, execution-based); FSoft-AI4Code
  XMainframe + MainframeBench (arxiv.org/abs/2408.04660); OpenCBS (COBOL defects);
  dl.acm.org (COBRAIN business-rule extraction); arxiv COBOL-Coder + COBOLAssist
