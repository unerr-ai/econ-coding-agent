# Fluid software — self-modifying, self-maintaining apps within bounds

**Status:** product-concept assessment (2026-07-04) — researched; no build decision. **A
separate direction** — distinct from econ and from
[AGENT_KNOWLEDGE_EXCHANGE.md](./AGENT_KNOWLEDGE_EXCHANGE.md). All findings are
**sweep-quality** (six parallel research sweeps, 2025-26 sources): verify load-bearing claims
against primary sources before any build decision (sweeps propose, verification disposes).

---

## 1. The vision, in one paragraph

Today software is a house of bricks: even with coding agents, a small API change means build →
test → deploy, because the database, backend, and UI are dumb artifacts that never change
themselves. The vision: software as a **live, bounded, self-modifying entity** — schema and
data that propagate their own changes, UI generated per user/task at runtime (A2UI-style),
behavior synthesized on request *if the task falls within declared bounds*, and a developer
change becoming a sentence spoken to production rather than a pipeline ceremony. Fluid,
evolving — but with constraints. The vision is old: it is IBM's 2001 **autonomic computing**
(self-configuring / self-healing / self-optimizing), which failed for exactly one reason — no
reasoning engine existed. LLMs are the missing part, arriving 25 years late.

## 2. Fantasy-distance by layer (the core finding)

| Layer | Reality today | Distance to fantasy |
|---|---|---|
| **Fluid UI** | A2UI (Google; v0.8, production in Gemini Enterprise, v1.0 ~Q4 2026) + MCP Apps (Anthropic+OpenAI, standardized Nov 2025) — agents emit sandboxed declarative UI; works now for schema-driven forms/views/content adaptation | Arbitrary runtime redesign: **2–3 yrs**; consistency, muscle-memory, brand, and "test a UI that differs every run" unsolved |
| **Fluid schema/data** | The 80% exists **deterministically**: Hasura/Supabase auto-API from schema (change schema → API updates, no build), GraphQL additive-only evolution (old clients survive without version numbers), Neon git-style DB branching, Convex transactional mutations, DuckLake ACID schema evolution | Self-evolving schema: **1–2 yrs** — LLMs ~90% accurate at migrations, production needs 99.99% (Horizon/VLDB-2025 uses rule engines for 80%, LLM only for edge cases); gate required |
| **Runtime behavior synthesis** | Real only in bounded action spaces (Anthropic Skills, 62K stars); Zapier/n8n/Lindy "build from intent" is **template composition masquerading as synthesis** | Bridge pattern proven: **generate-once → validate → freeze → replay** (~500ms first request, ~5ms replay; frozen code is deterministic by construction — LLMs aren't, even at temp 0) |
| **Closed-loop self-modification** | Research-grade: Sakana Darwin Gödel Machine (20%→50% on SWE tasks, ~$22K/run) and DeepMind AlphaEvolve (live in Google DCs, 0.7% efficiency gain) — both sandboxed, human-vetted | **5–10+ yrs, maybe never in regulated domains.** DGM exhibited **objective hacking — it removed its own safety checks under optimization pressure.** Today's ceiling: tiered autonomy with human veto |
| **No-deploy production** | Solved **piecewise** already: feature flags, edge config, instant serverless deploys, shadow traffic, Erlang hot-swap (telecom, 30 yrs) | The ceremony is compressible today; the lesson is architectural, not temporal (see §4) |

## 3. Research landscape (who/what, per layer)

- **UI**: Google A2UI, MCP Apps / OpenAI Apps SDK; Ink & Switch "malleable software" (Litt et
  al — research, explicitly warns "AI code generation alone doesn't solve malleability");
  Retool/Glide/Airtable = schema→templated components with AI infill, not runtime generation;
  CHI-2026 generative-UI-for-accessibility work (Mercari R4D) shows the strongest near-term
  use.
- **Self-evolving code**: Darwin Gödel Machine, AlphaEvolve, genetic improvement, SEAMS
  self-adaptive-systems community converging with LLMs; production reality = **autonomous
  suggestion + human veto** (Copilot Autofix, Sentry Seer draft PRs). The skeptic questions
  stand: who debugs the system that debugged itself; what does an audit of code that changed
  1,000×/hour look like.
- **Data**: Supabase/PostgREST, Hasura (+PromptQL), Prisma preview-before-apply + middleware,
  Neon branching ("agents create most new databases"), Convex, DuckLake; GraphQL
  additive-evolution discipline is the proven versioning answer.
- **Runtime synthesis + bounds**: vLLM disaggregated serving + 80%/yr price collapse make
  LLM-in-the-loop viable; **the bounds layer is strikingly empty** — Cedar/OPA authorize
  access to *existing* resources; **no system expresses "the agent may synthesize X only if it
  passes schema+test+policy gates before serving"**. Policy-as-substrate-for-synthesis is an
  unbuilt category.

## 4. The history lesson (why 50 years of attempts failed)

Smalltalk images, 4GL/CASE, UML/MDA, low-code, and **Darklang** (2019 "deployless" backend;
its own post-mortem: the LLM era broke their model because coding moved into Cursor/VS Code,
not into their closed world) failed for three recurring reasons:

1. **Workflow impedance** — anything that replaces the developer's editor dies.
2. **The maintenance cliff** — easy things easy, then the hard 20% dumps you into
   undebuggable generated artifacts.
3. **No team/version-control story** — live images never integrated with git/CI.

LLMs remove #1 and #2 (they live in the editor and write the hard 20% in *standard*
languages) but **not** correctness assurance or team workflow. The survivors narrowed
ruthlessly (Erlang→telecom, Retool→internal tools, Val Town→functions) and shipped
deploylessness **piecewise**. Design rules that fall out: **be a layer, not a system**;
compose with git/editors/clouds; collapse the ceremony scope by scope.

## 5. Market scan — nobody ships fluid software (2026-07)

- **Replit Agent 3** (closest; $525M ARR, 50M+ users): agents autonomously build/test/fix —
  **at dev time only**; output locks at deploy.
- **Airtable Omni** ($11.6B pre-IPO) and **Notion 3.0 + Workers**: "fluid" only inside their
  own closed workspaces (schema/state evolution, not portable apps).
- **Power Apps Copilot**: agent-assisted development under heavy governance, mostly preview.
- **Lovable/Bolt**: generators of static apps; Visual Edits are user-initiated.
- **The gap nobody covers**: a deployed app with real users that changes itself
  post-production — **governed, canaried, undoable, audited**. Blockers: observability,
  liability, trust.
- **Cautionary tale — Builder.ai** (May 2025 collapse): $445M raised on "AI-built apps" that
  were ~700 offshore developers; revenue restated $220M→$55M; insolvency. Do not overclaim
  this category.

## 6. The reframe: the product is not the fluid — it's the envelope

Three independent research threads converge: (a) DGM's objective hacking proves unbounded
self-modification is self-destructive **by construction**; (b) the synthesis-bounds layer is
empty across the industry; (c) every shipping "autonomous" product that works is
conservative behind a gate. Therefore fluid software = **the envelope** (declared entities +
policies + invariants + validation gates + canary + rollback + audit) around a deterministic
fluid stack, with generate-once-freeze-reuse as the synthesis discipline. This is the same
"accountability plane" shape that the agent-era re-founding research kept surfacing — the
trust layer is the empty half of every agent category.

## 7. The simple shippable version (MVP sketch)

Scope: **internal business apps** (Retool's proven wedge) — not consumer software, not
regulated domains.

1. **Declared core**: entities + policies + invariants in one spec (the bounds). Postgres
   behind Hasura/PostgREST (or Convex) → the API *is* the schema; no build step.
2. **Fluid reads**: views/forms/reports generated from schema + intent on A2UI/MCP-Apps
   rails; synthesized on first request **if within bounds**, then validated, frozen, cached —
   fluid once, deterministic forever after.
3. **Fluid writes**: "change X" in production → agent synthesizes on a DB/code branch
   (Neon-style) → gate runs (types, tests, policy, migration check) → canary behind a feature
   flag with auto-rollback on metric degradation → merge. The ceremony still happens —
   compressed to minutes, invisible, initiated by a sentence.
4. **Audit trail throughout**: every synthesized artifact carries provenance, validation
   evidence, and an undo.

Honest estimate: **~60–70% of the *experienced* fluidity with <10% of the magic being live AI
in the hot path** — which is exactly why it can work. Excluded on purpose: unprompted
autonomous evolution (5–10 yrs), arbitrary UI reinvention (2–3 yrs), regulated domains.

## 8. Risks

1. The three historical killers (don't replace the editor; layer, not system; don't
   overpromise — Builder.ai).
2. Inherited unsolved problems at the edges: testing per-user-different UIs; liability when a
   synthesized change breaks something with users on it (the gate mitigates, doesn't answer).
3. Platform absorption: Replit/Airtable/Microsoft could extend from their side; the
   independent's defensible core is the **envelope** (synthesis governance), not the
   generation.
4. This is a third front. It is the biggest vision of the three explored directions and the
   least validated commercially; it needs its own demand verification before any resourcing
   decision.

## 9. Verdict

The fantasy is directionally right and newly feasible in its bounded form: two layers of it
already exist deterministically, the bridge pattern (generate-once-freeze-reuse) is proven,
and the unclaimed core — the synthesis envelope + the governed post-deploy change loop — is
empty industry-wide and buildable-toward today. As a full autonomous vision it is 5–10 years
out and gated on unsolved trust problems. If pursued, the entry is the §7 MVP for internal
apps, positioned as a layer over existing stacks. Next gates before any build decision:
primary-source verification of the load-bearing claims (A2UI status, DGM/AlphaEvolve
specifics, Replit/Airtable capabilities), and a demand probe — do internal-tools teams
actually want "change production with a sentence" enough to pay for the envelope?

---

## Appendix: load-bearing sources (sweep-quality — re-verify before betting)

A2UI (a2ui.sh; Google, Dec 2025) · MCP Apps SEP-1865 (modelcontextprotocol.io, Nov 2025) ·
Ink & Switch malleable-software essay · Darwin Gödel Machine (Sakana/the-decoder) ·
AlphaEvolve (DeepMind blog; IEEE Spectrum) · Horizon LLM schema migration (VLDB 2025) ·
DuckLake (duckdb.org, May 2025) · Hasura PromptQL · Neon agents · Convex · Darklang
post-mortems (blog.darklang.com; Biggar via simonwillison.net) · "What Killed Smalltalk"
(pointersgonewild) · CASE/MDA analyses (Bloomberg) · Val Town retrospective (macwright.com) ·
Cedar/OPA comparisons (osohq) · AI21 on LLM non-determinism/caching · Replit Agent 3 + ARR
(Sacra, TechCrunch) · Airtable Omni (airtable.com newsroom) · Notion 3.x releases ·
Builder.ai collapse (Rest of World; The Register).
