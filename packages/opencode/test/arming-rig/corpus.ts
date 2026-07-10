import { LOCALIZATION_SLICE_CONTENT } from "../../src/session/prompts/seeds"
import type { ArmingScenario, TriageVerdict, TriageGoalShape, OrchestrationTodo } from "./types"

/**
 * Arming-rig corpus: the golden spec (docs/testing/PROMPT_SLICING_CORPUS.md)
 * encoded 1:1 — one ArmingScenario per corpus-table row, same `id`, stressing
 * both failure modes of the localization-arming decision (OVER-FIRE vs
 * UNDER-FIRE) plus the PLANNER escalation (R3) and the Door-2 net (R4).
 *
 * P1-alt: each diagnosis goal's mock verdict carries the per-goal EVIDENCE
 * the merged turn-read extracts — locationNamed/fixSpecified (with quotes
 * faithful to the prompt) plus the judged hardness/ambiguity — and the rig
 * drives the PURE decision table (`decideArming`) over it. Each scenario
 * encodes the CORRECT/desired outcome in expect.localizationArmed plus (P12)
 * the expected seed KIND in expect.seedKind — diagnosis rows arm the
 * localization writer, hard-build (needsPlan) rows arm the plan seed.
 * `expect.reason` cites the corpus rule (R1-R6) that decides the case — see
 * the doc for the full rule text.
 */
export const CORPUS: ArmingScenario[] = [
  // -------------------------------------------------------------------------
  // diagnosis-grounded -> NONE (site is known; execute directly)
  // -------------------------------------------------------------------------
  {
    id: "grounded-trivial-central",
    prompt: "fix the indentation issue in django/db/backends/ddl_references.py lines 42-44 — needs 4 spaces instead of 2",
    mockVerdict: {
      goals: [
        {
          quote: "fix the indentation issue in django/db/backends/ddl_references.py",
          shape: "diagnosis-grounded" as TriageGoalShape,
          deliverable: "indentation corrected to 4 spaces",
          evidence: {
            locationNamed: true,
            locationQuote: "django/db/backends/ddl_references.py lines 42-44",
            fixSpecified: true,
            fixQuote: "needs 4 spaces instead of 2",
            hardness: "trivial",
            ambiguity: "clear",
          },
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: false,
      reason: "R2 STRONG — file+line named; site is known, no localization pre-pass needed",
    },
    note: "django-12039: trivial whitespace fix in a central file",
  },

  {
    id: "grounded-simple",
    prompt: "fix the off-by-one error in src/parser.ts around line 40 — the loop should start at 1, not 0",
    mockVerdict: {
      goals: [
        {
          quote: "fix the off-by-one error in src/parser.ts around line 40",
          shape: "diagnosis-grounded" as TriageGoalShape,
          deliverable: "loop index corrected to start at 1",
          evidence: {
            locationNamed: true,
            locationQuote: "src/parser.ts around line 40",
            fixSpecified: true,
            fixQuote: "the loop should start at 1, not 0",
            hardness: "trivial",
            ambiguity: "clear",
          },
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: false,
      reason: "R2 STRONG — file + line number specified; no localization needed",
    },
    note: "typical bug report with known location",
  },

  {
    id: "grounded-stacktrace",
    prompt:
      "TypeError at auth.py:42: 'NoneType' object is not subscriptable — full traceback points to the token check in that function",
    mockVerdict: {
      goals: [
        {
          quote: "TypeError at auth.py:42: 'NoneType' object is not subscriptable",
          shape: "diagnosis-grounded" as TriageGoalShape,
          deliverable: "null check added at auth.py:42 to prevent the TypeError",
          evidence: {
            locationNamed: true,
            locationQuote: "auth.py:42",
            fixSpecified: false,
            hardness: "trivial",
            ambiguity: "clear",
          },
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: false,
      reason: "R2 STRONG — stack trace names file+line (auth.py:42); site is known",
    },
    note: "stack trace with file+line",
  },

  {
    id: "grounded-test-output",
    prompt:
      "pytest shows: expected 'DID NOT RAISE' but got AttributeError at line 88 of validators.py where the code checks user.email is None",
    mockVerdict: {
      goals: [
        {
          quote: "expected 'DID NOT RAISE' but got AttributeError at line 88 of validators.py",
          shape: "diagnosis-grounded" as TriageGoalShape,
          deliverable: "AttributeError at validators.py:88 fixed so the expected exception raises",
          evidence: {
            locationNamed: true,
            locationQuote: "line 88 of validators.py",
            fixSpecified: false,
            hardness: "moderate",
            ambiguity: "clear",
          },
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: false,
      reason: "R2 STRONG — test output names the file+line and shows the code; site is known",
    },
    note: "pytest failure output with file+line and visible code",
  },

  {
    id: "grounded-diagnosis-and-fix",
    prompt: "the endpoint uses request.args.get() for a POST body when it should use request.form.get() instead",
    mockVerdict: {
      goals: [
        {
          quote: "the endpoint uses request.args.get() for a POST body when it should use request.form.get() instead",
          shape: "diagnosis-grounded" as TriageGoalShape,
          deliverable: "endpoint reads the POST body via request.form.get() instead of request.args.get()",
          evidence: {
            locationNamed: false,
            fixSpecified: true,
            fixQuote: "should use request.form.get() instead",
            hardness: "trivial",
            ambiguity: "clear",
          },
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: false,
      reason: "R2 STRONG — both the diagnosis and the fix are stated; nothing left to localize",
    },
    note: "fix and site both stated in the prompt",
  },

  {
    id: "grounded-symbol-plus-file",
    prompt: "QuerySet.delete() in django/db/models/deletion.py crashes when cascading through a null foreign key",
    mockVerdict: {
      goals: [
        {
          quote: "QuerySet.delete() in django/db/models/deletion.py crashes when cascading through a null foreign key",
          shape: "diagnosis-grounded" as TriageGoalShape,
          deliverable: "QuerySet.delete() in deletion.py handles a null foreign key during cascade without crashing",
          evidence: {
            locationNamed: true,
            locationQuote: "django/db/models/deletion.py",
            fixSpecified: false,
            hardness: "moderate",
            ambiguity: "clear",
          },
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: false,
      reason: "R2 STRONG — symbol PLUS file (QuerySet.delete() in deletion.py); the file makes it grounded",
    },
    note: "symbol + file together — contrast with entity-name-only, symbol alone",
  },

  // -------------------------------------------------------------------------
  // diagnosis-vague -> LOCALIZATION (site unknown; find it first) — unless hard (R3)
  // -------------------------------------------------------------------------
  {
    id: "spec-language-no-file",
    prompt: "the collection logic should combine these database queries instead of iterating in application code — currently doing n+1",
    mockVerdict: {
      goals: [
        {
          quote: "the collection logic should combine these database queries",
          shape: "diagnosis-vague" as TriageGoalShape,
          deliverable: "n+1 query pattern eliminated via combined query logic",
          // L4.1/R6 — combining queries crosses grouping semantics: hardness
          // reads at least "hard" (the fix is an algorithmic decision), which
          // floors the localization writer at the reasoner. Arming outcome is
          // unchanged from the pre-calibration label (armed, localization).
          evidence: { locationNamed: false, fixSpecified: false, hardness: "hard", ambiguity: "clear" },
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: true,
      seedKind: "localization",
      reason:
        "R2 NONE-grounding + R6 — optimization phrasing with no file named: localization armed, hardness-floored at the reasoner",
    },
    note: "django-11885 flavor: performance bug described without file path (R6 hardness calibration)",
  },

  {
    id: "optimization-combine-queries",
    prompt:
      "the deletion collector emits one fast-delete query per object relationship — combine the fast delete queries so related rows go in one query per table (e.g. a single DELETE with the conditions OR'd together) and avoid the unnecessary round trips",
    mockVerdict: {
      goals: [
        {
          quote: "combine the fast delete queries",
          // L4.1/R6 — the django-11885 archetype VERBATIM: optimization-phrased,
          // zero defect keywords, no file named. The live turn-read used to
          // read this hardness=trivial/shape=build ("no diagnosis-shaped goal")
          // → no arming, no decomposition → a 179-step, $0.8447 inline grind
          // (tracker tuning log 2026-07-10). Under R6 the waste IS the symptom:
          // diagnosis-vague, and combining queries crosses grouping/ordering
          // semantics so hardness reads "hard" — the localization writer arms
          // with its generator floored at the reasoner (the design-shaped read).
          shape: "diagnosis-vague" as TriageGoalShape,
          deliverable: "fast deletes combined into one query per table with delete semantics preserved",
          evidence: { locationNamed: false, fixSpecified: false, hardness: "hard", ambiguity: "clear" },
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      shape: "diagnosis-vague" as TriageGoalShape,
      localizationArmed: true,
      seedKind: "localization",
      reason:
        "R6 — optimization-phrased goal with no location is design-shaped work: diagnosis-vague, armed, hardness 'hard' floors the fix slice at the reasoner (never 'build'/trivial — the 11885 under-call)",
    },
    note: "django-11885 (the real archetype): 'combine fast delete queries' — optimization-phrased, no location, no defect keyword",
  },

  {
    id: "vague-crash",
    prompt: "the app sometimes crashes on startup, usually within the first 2-3 seconds of the boot sequence",
    mockVerdict: {
      goals: [
        {
          quote: "the app sometimes crashes on startup",
          shape: "diagnosis-vague" as TriageGoalShape,
          deliverable: "crash on startup root-caused and fixed",
          evidence: { locationNamed: false, fixSpecified: false, hardness: "moderate", ambiguity: "ambiguous" },
        },
      ],
      constraints: [],
      confidence: "low",
    },
    expect: {
      localizationArmed: true,
      seedKind: "localization",
      reason: "R2 NONE-grounding — pure symptom (crash), no file or symbol named; needs localization",
    },
    note: "real crash: no file mentioned, requires structural search",
  },

  {
    id: "entity-name-only",
    prompt: "the QuerySet.delete() method incorrectly drops related rows that should be preserved — it's deleting rows from parent tables when it shouldn't",
    mockVerdict: {
      goals: [
        {
          quote: "the QuerySet.delete() method incorrectly drops related rows",
          shape: "diagnosis-vague" as TriageGoalShape,
          deliverable: "QuerySet.delete() preserves related rows that should not be deleted",
          // A bare symbol name is NOT a location (contrast grounded-symbol-plus-file).
          evidence: { locationNamed: false, fixSpecified: false, hardness: "moderate", ambiguity: "clear" },
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: true,
      seedKind: "localization",
      reason: "R2 WEAK — bare symbol (QuerySet.delete) with no file is a deferred start, not a shortcut; needs localization",
    },
    note: "Django ORM API mentioned by symbol, not by file location",
  },

  {
    id: "vague-component-leak",
    prompt: "fix the memory leak in the session handler",
    mockVerdict: {
      goals: [
        {
          quote: "fix the memory leak in the session handler",
          shape: "diagnosis-vague" as TriageGoalShape,
          deliverable: "memory leak in the session handler eliminated",
          // A component/layer name is NOT a location.
          evidence: { locationNamed: false, fixSpecified: false, hardness: "moderate", ambiguity: "clear" },
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: true,
      seedKind: "localization",
      reason: "R2 WEAK — names a component (session handler), not a file; needs localization",
    },
    note: "component/layer named, no file",
  },

  {
    id: "vague-why-question",
    prompt: "why does login fail with special characters in the password but not with alphanumeric ones?",
    mockVerdict: {
      goals: [
        {
          quote: "why does login fail with special characters in the password but not with alphanumeric ones?",
          shape: "diagnosis-vague" as TriageGoalShape,
          deliverable: "login failure with special-character passwords root-caused and fixed",
          evidence: { locationNamed: false, fixSpecified: false, hardness: "moderate", ambiguity: "clear" },
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: true,
      seedKind: "localization",
      reason: "R2 NONE-grounding — phrased as a question, no file or symbol named; needs localization",
    },
    note: "question-phrased symptom report",
  },

  {
    id: "vague-import-reject",
    prompt: "the importer rejects vCard 4.0 files even though they look well-formed",
    mockVerdict: {
      goals: [
        {
          quote: "the importer rejects vCard 4.0 files even though they look well-formed",
          shape: "diagnosis-vague" as TriageGoalShape,
          deliverable: "importer accepts well-formed vCard 4.0 files",
          evidence: { locationNamed: false, fixSpecified: false, hardness: "moderate", ambiguity: "clear" },
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: true,
      seedKind: "localization",
      reason: "R2 NONE-grounding — symptom only, no file named; needs localization",
    },
    note: "no file named",
  },

  {
    id: "vague-hard-race",
    prompt: "fix the race condition in cache invalidation — concurrent writes are corrupting the cache",
    mockVerdict: {
      goals: [
        {
          quote: "fix the race condition in cache invalidation — concurrent writes are corrupting the cache",
          shape: "diagnosis-vague" as TriageGoalShape,
          deliverable: "race condition in cache invalidation fixed so concurrent writes no longer corrupt the cache",
          needsPlan: true,
          evidence: { locationNamed: false, fixSpecified: false, hardness: "hard", ambiguity: "clear" },
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: true,
      seedKind: "localization",
      reason:
        "R2/R3 — a hard vague bug arms the LOCALIZATION writer (hardness floors its tier); on a DIAGNOSIS goal needsPlan never plants the plan seed — the single-seed collapse (12050)",
    },
    note: "hard vague diagnosis — localization writer, hardness-floored; the P12 plan seed is build-only",
  },

  // -------------------------------------------------------------------------
  // diagnosis, asymmetric grounding -> LOCALIZATION on the vague side (row-5 flip)
  // -------------------------------------------------------------------------
  {
    id: "grounded-cross-layer-file-named",
    prompt:
      "fix HTTP serialization in server/api.ts and a query in the database layer that isn't fetching the right fields",
    mockVerdict: {
      goals: [
        {
          quote: "fix HTTP serialization in server/api.ts",
          shape: "diagnosis-grounded" as TriageGoalShape,
          deliverable: "HTTP serialization corrected in server/api.ts",
          evidence: {
            locationNamed: true,
            locationQuote: "server/api.ts",
            fixSpecified: false,
            hardness: "moderate",
            ambiguity: "clear",
          },
        },
        {
          quote: "a query in the database layer that isn't fetching the right fields",
          shape: "diagnosis-vague" as TriageGoalShape,
          deliverable: "database layer query updated to fetch the right fields",
          evidence: { locationNamed: false, fixSpecified: false, hardness: "moderate", ambiguity: "clear" },
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: true,
      seedKind: "localization",
      reason:
        "R2 ASYMMETRIC — the API side is file-grounded but the DB side is a vague layer; the vague side still needs localization (a planner would over-escalate at only 2 layers per R3)",
    },
    note: "row-5 flip: asymmetric grounding arms LOCALIZATION on the vague side — judge was right, old label was wrong",
  },

  // -------------------------------------------------------------------------
  // build -> NONE, unless multi-file/cross-cutting/ambiguous -> PLANNER (R1, R3)
  // -------------------------------------------------------------------------
  {
    id: "feature-build",
    prompt: "add a --json output flag to the CLI so that results can be piped to other tools",
    mockVerdict: {
      goals: [
        {
          quote: "add a --json output flag to the CLI",
          shape: "build" as TriageGoalShape,
          deliverable: "CLI supports --json flag that outputs results in JSON format",
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: false,
      reason: "R1 — build shape never arms localization; single-ish, well-specified feature",
    },
    note: "feature build shape; clear intent but not a bug fix",
  },

  {
    id: "build-hello-endpoint",
    prompt: "make a flask app with a /hello endpoint that returns hello world",
    mockVerdict: {
      goals: [
        {
          quote: "make a flask app with a /hello endpoint that returns hello world",
          shape: "build" as TriageGoalShape,
          deliverable: "flask app exposes a /hello endpoint returning hello world",
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: false,
      reason: "R1 — build shape, simple and scoped; no localization needed",
    },
    note: "simple scoped build",
  },

  {
    id: "build-write-tests",
    prompt: "write tests for the BankAccount class covering edge cases like overdrafts and zero balances",
    mockVerdict: {
      goals: [
        {
          quote: "write tests for the BankAccount class covering edge cases like overdrafts and zero balances",
          shape: "build" as TriageGoalShape,
          deliverable: "BankAccount test suite covers overdraft and zero-balance edge cases",
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: false,
      reason: "R1 — scoped test-writing is a build task, not a diagnosis",
    },
    note: "scoped test-writing",
  },

  {
    id: "build-migration",
    prompt: "add a migration for a user_roles column defaulting to 'user'",
    mockVerdict: {
      goals: [
        {
          quote: "add a migration for a user_roles column defaulting to 'user'",
          shape: "build" as TriageGoalShape,
          deliverable: "migration adds a user_roles column defaulting to 'user'",
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: false,
      reason: "R1 — mechanical DDL change, build shape, no localization needed",
    },
    note: "mechanical DDL",
  },

  {
    id: "build-doc-sync",
    prompt: "update the docs to match the new API schema — the schema is provided inline below",
    mockVerdict: {
      goals: [
        {
          quote: "update the docs to match the new API schema",
          shape: "build" as TriageGoalShape,
          deliverable: "docs updated to match the provided API schema",
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: false,
      reason: "R1 — mechanical doc update with the spec given inline; build shape, no localization",
    },
    note: "mechanical, spec inline",
  },

  {
    id: "build-refactor-jwt",
    prompt: "refactor the auth module to use JWT tokens instead of sessions",
    mockVerdict: {
      goals: [
        {
          quote: "refactor the auth module to use JWT tokens instead of sessions",
          shape: "build" as TriageGoalShape,
          deliverable: "auth module refactored from sessions to JWT tokens across all call sites",
          needsPlan: true,
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: true,
      seedKind: "plan",
      reason: "R3 — cross-cutting refactor touching many call sites arms PLANNER over plain execution",
    },
    note: "cross-cutting refactor",
  },

  {
    id: "build-dark-mode",
    prompt: "add dark mode: a navbar toggle, persisted in localStorage, applied across all panels",
    mockVerdict: {
      goals: [
        {
          quote: "add dark mode: a navbar toggle, persisted in localStorage, applied across all panels",
          shape: "build" as TriageGoalShape,
          deliverable: "dark mode toggle in the navbar persists via localStorage and applies to all panels",
          needsPlan: true,
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: true,
      seedKind: "plan",
      reason: "R3 — multi-component feature (toggle + persistence + every panel) arms PLANNER",
    },
    note: "multi-component build",
  },

  {
    id: "build-multifile-complex",
    prompt: "make a coordinated change across several files, fixing the bugs shown in this error output",
    mockVerdict: {
      goals: [
        {
          quote: "make a coordinated change across several files, fixing the bugs shown in this error output",
          shape: "build" as TriageGoalShape,
          deliverable: "coordinated multi-file change lands with the reported errors resolved",
          needsPlan: true,
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: true,
      seedKind: "plan",
      reason: "R3 — multi-file coordination plus debugging clears the breakeven for PLANNER",
    },
    note: "multi-file coordination + debug",
  },

  {
    id: "build-linear-ticket",
    prompt: "implement: add CSV export to the reports page — a button that triggers a download",
    mockVerdict: {
      goals: [
        {
          quote: "add CSV export to the reports page",
          shape: "build" as TriageGoalShape,
          deliverable: "reports page has a working CSV export button that triggers a download",
          needsPlan: true,
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: true,
      seedKind: "plan",
      reason: "R3 — multi-step UI-to-backend-to-test build arms PLANNER",
    },
    note: "multi-step UI→backend→test",
  },

  // -------------------------------------------------------------------------
  // audit -> NONE (no edit, no fix-site)
  // -------------------------------------------------------------------------
  {
    id: "audit",
    prompt: "is this fix correct and regression-free? the logic looks suspicious around the equality check",
    mockVerdict: {
      goals: [
        {
          quote: "is this fix correct and regression-free?",
          shape: "audit" as TriageGoalShape,
          deliverable: "fix audited and verified as correct with no regressions",
        },
      ],
      constraints: [
        {
          quote: "the logic looks suspicious",
          kind: "scope-limit",
        },
      ],
      confidence: "high",
    },
    expect: {
      localizationArmed: false,
      reason: "R1 — audit shape is verification, not diagnosis; no localization",
    },
    note: "code review / audit task",
  },

  {
    id: "audit-where-is",
    prompt: "where is the user authentication logic in this codebase?",
    mockVerdict: {
      goals: [
        {
          quote: "where is the user authentication logic in this codebase?",
          shape: "audit" as TriageGoalShape,
          deliverable: "user authentication logic located and pointed out",
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: false,
      reason: "R1 — navigation/QA question, no edit; audit shape never arms localization",
    },
    note: "navigation/QA, no edit",
  },

  {
    id: "audit-explain",
    prompt: "explain how the DI container resolves services",
    mockVerdict: {
      goals: [
        {
          quote: "explain how the DI container resolves services",
          shape: "audit" as TriageGoalShape,
          deliverable: "explanation of how the DI container resolves services",
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: false,
      reason: "R1 — comprehension request, audit shape, no localization",
    },
    note: "comprehension",
  },

  {
    id: "audit-review-pr",
    prompt: "review this PR for security vulnerabilities",
    mockVerdict: {
      goals: [
        {
          quote: "review this PR for security vulnerabilities",
          shape: "audit" as TriageGoalShape,
          deliverable: "PR reviewed and security vulnerabilities reported",
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: false,
      reason: "R1 — diff provided for review, audit shape, no localization",
    },
    note: "diff provided",
  },

  // -------------------------------------------------------------------------
  // run-only -> NONE (execute & report)
  // -------------------------------------------------------------------------
  {
    id: "run-only",
    prompt: "run the full test suite on the latest main branch and report any failures with their stack traces",
    mockVerdict: {
      goals: [
        {
          quote: "run the full test suite",
          shape: "run-only" as TriageGoalShape,
          deliverable: "test suite run complete with failure report",
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: false,
      reason: "R1 — run-only shape is execute-and-report, no edit, no localization",
    },
    note: "pure execution / reporting task",
  },

  {
    id: "run-tests-report",
    prompt: "run the tests and report any failures",
    mockVerdict: {
      goals: [
        {
          quote: "run the tests and report any failures",
          shape: "run-only" as TriageGoalShape,
          deliverable: "test run complete with failures reported",
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: false,
      reason: "R1 — execute-only shape, no localization",
    },
    note: "execute-only",
  },

  // -------------------------------------------------------------------------
  // multi-goal -> arm if any goal warrants it
  // -------------------------------------------------------------------------
  {
    id: "multi-goal-mixed",
    prompt: "the auth flow is broken and users can't log in. also the error messages are unclear — they should give more context",
    mockVerdict: {
      goals: [
        {
          quote: "the auth flow is broken and users can't log in",
          shape: "diagnosis-grounded" as TriageGoalShape,
          deliverable: "auth flow fixed so users can log in successfully",
          // No file/module named in the prompt — the evidence, not the shape
          // label, is what the decision table reads.
          evidence: { locationNamed: false, fixSpecified: false, hardness: "moderate", ambiguity: "clear" },
        },
        {
          quote: "the error messages are unclear",
          shape: "diagnosis-vague" as TriageGoalShape,
          deliverable: "error messages enhanced with more context",
          evidence: { locationNamed: false, fixSpecified: false, hardness: "moderate", ambiguity: "clear" },
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: true,
      seedKind: "localization",
      reason: "R2/R3 — the vague goal in a mixed turn is unlocated and arms localization for the whole turn",
    },
    note: "one grounded + one vague goal in the same turn",
  },

  // -------------------------------------------------------------------------
  // Door-2 (todowrite net) — R4
  // -------------------------------------------------------------------------
  {
    id: "door2-grounded-mechanical-todos",
    prompt: "there are trailing commas in the schema import list",
    todos: [
      {
        content: "Remove trailing commas from schema import in database.ts",
        status: "pending",
      },
      {
        content: "Update formatting across the schema import list for consistency",
        status: "pending",
      },
    ],
    mockVerdict: {
      goals: [
        {
          quote: "there are trailing commas in the schema import list",
          shape: "diagnosis-grounded" as TriageGoalShape,
          deliverable: "trailing commas removed and formatter passed",
          // The PROMPT names no file — the location lives in the todos, which
          // only the Door-2 net sees (R4 refinement suppresses the injection).
          evidence: { locationNamed: false, fixSpecified: false, hardness: "trivial", ambiguity: "clear" },
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: false,
      reason: "R4 — to-dos name a file (database.ts); Door-2 net stays disarmed even though the goal is already grounded",
    },
    note: "django-12039 Door-2: mechanical todos bind the location, suppress localization",
  },

  {
    id: "door2-vague-mechanical-todos",
    prompt: "there's a performance issue when loading large datasets",
    todos: [
      {
        content: "Add pagination to the dataset loader",
        status: "pending",
      },
      {
        content: "Add query batching to reduce per-row overhead",
        status: "pending",
      },
    ],
    mockVerdict: {
      goals: [
        {
          quote: "there's a performance issue when loading large datasets",
          shape: "diagnosis-vague" as TriageGoalShape,
          deliverable: "dataset loading performance optimized for large datasets",
          evidence: { locationNamed: false, fixSpecified: false, hardness: "moderate", ambiguity: "ambiguous" },
        },
      ],
      constraints: [],
      confidence: "low",
    },
    expect: {
      localizationArmed: true,
      seedKind: "localization",
      reason: "R4 — mechanical todos exist but name no file; arming still stands (Door-2 backstop)",
    },
    note: "todos alone don't ground vague diagnosis if no file is named",
  },

  // -------------------------------------------------------------------------
  // P3 research -> NONE (external-knowledge deliverable; arming N/A)
  // -------------------------------------------------------------------------
  {
    id: "research-pure-lookup",
    prompt: "what breaking changes did zod v4 ship, and do any of them affect how we validate configs?",
    mockVerdict: {
      goals: [
        {
          quote: "what breaking changes did zod v4 ship",
          shape: "research" as TriageGoalShape,
          deliverable: "a cited digest of zod v4 breaking changes and their impact on our validators",
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      shape: "research" as TriageGoalShape,
      localizationArmed: false,
      reason: "R1/P3 — research shape is an external lookup, not a diagnosis; arming N/A",
    },
    note: "pure external lookup — the qa/research boundary is 'needs external sources'",
  },

  {
    id: "research-build-compound",
    prompt: "find out how the new stripe billing API paginates events, then update our webhook client to use it",
    mockVerdict: {
      goals: [
        {
          quote: "find out how the new stripe billing API paginates events",
          shape: "research" as TriageGoalShape,
          deliverable: "cited digest of the new pagination contract",
        },
        {
          quote: "update our webhook client to use it",
          shape: "build" as TriageGoalShape,
          deliverable: "webhook client paginates via the new API",
          dependsOn: [0],
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: false,
      reason: "P3 — research + scoped build compound: neither goal is a diagnosis, nothing arms",
    },
    note: "research feeding a build — two goals, ordered, no pre-pass",
  },

  // -------------------------------------------------------------------------
  // P3 refactor -> NONE (behavior-preserving restructure; arming N/A)
  // -------------------------------------------------------------------------
  {
    id: "refactor-pure",
    prompt: "restructure the session module: extract the retry logic into a shared helper, no behavior change",
    mockVerdict: {
      goals: [
        {
          quote: "extract the retry logic into a shared helper",
          shape: "refactor" as TriageGoalShape,
          deliverable: "retry logic shared; suite green; no public-signature breaks",
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      shape: "refactor" as TriageGoalShape,
      localizationArmed: false,
      reason: "P3 — refactor restructures without changing behavior; the suite is the safety net, no pre-pass",
    },
    note: "pure behavior-preserving restructure",
  },

  {
    id: "refactor-boundary-adds-behavior",
    prompt: "refactor the export pipeline so it also emits JSON alongside CSV",
    mockVerdict: {
      goals: [
        {
          quote: "refactor the export pipeline so it also emits JSON alongside CSV",
          // "refactor" in the user's words, but it ADDS behavior — THE
          // discriminator says build. The mock encodes the correct answer;
          // live mode (RIG_LIVE=1) scores the real extractor on it.
          shape: "build" as TriageGoalShape,
          deliverable: "export pipeline emits JSON in addition to CSV",
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      shape: "build" as TriageGoalShape,
      localizationArmed: false,
      reason: "P3 boundary — adds behavior ⇒ build, never refactor, despite the user's verb",
    },
    note: "adds-behavior 'refactor' must classify build (the crisp discriminator)",
  },

  // -------------------------------------------------------------------------
  // P3 no-edits constraint -> plan-only turn (build + no-edits + needsPlan)
  // -------------------------------------------------------------------------
  {
    id: "no-edits-plan-only",
    prompt: "plan the migration to the new billing provider — propose the steps, don't write code",
    mockVerdict: {
      goals: [
        {
          quote: "plan the migration to the new billing provider",
          shape: "build" as TriageGoalShape,
          deliverable: "a migration plan the team can execute",
          needsPlan: true,
        },
      ],
      constraints: [{ quote: "don't write code", kind: "no-edits" }],
      confidence: "high",
    },
    expect: {
      localizationArmed: true,
      seedKind: "plan",
      reason:
        "P3 — 'propose, don't code' composes: build + no-edits + needsPlan; the P12 plan seed still plants (edit-free by design) while the no-edits gate blocks the edit tools",
    },
    note: "plan-only turn: the constraint gates edits, the plan seed still plants",
  },

  // -------------------------------------------------------------------------
  // P4 continuation — §4b's three cases
  // -------------------------------------------------------------------------
  {
    id: "continuation-go-ahead",
    prompt: "go ahead",
    // The session's prior fresh turn: a planned build (its arming decision is
    // what the continuation inherits — no fresh stand-down overwrite).
    priorMockVerdict: {
      goals: [
        {
          quote: "add dark mode: a navbar toggle, persisted in localStorage, applied across all panels",
          shape: "build" as TriageGoalShape,
          deliverable: "dark mode everywhere",
          needsPlan: true,
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: false,
      shortCircuit: true,
      turnRole: "continuation",
      reason: "P4 — pure ack short-circuits pre-LLM: no turn-read call, no reseed, arming inherited",
    },
    note: "§4b case 1: 'go ahead' — the wasteful null-triage LLM call is skipped entirely",
  },

  {
    id: "continuation-still-broken-no-rearm",
    prompt: "still broken",
    // Prior fresh turn: a vague diagnosis that ARMED localization…
    priorMockVerdict: {
      goals: [
        {
          quote: "the app sometimes crashes on startup",
          shape: "diagnosis-vague" as TriageGoalShape,
          deliverable: "crash root-caused and fixed",
          evidence: { locationNamed: false, fixSpecified: false, hardness: "moderate", ambiguity: "clear" },
        },
      ],
      constraints: [],
      confidence: "high",
    },
    // …and the session already ran it: the localization pre-pass is SETTLED
    // on the todo list. The continuation must not plant a second one — it
    // routes to re-verify (the inherited M4 pin + existing verify rungs).
    todos: [
      { content: "Fix the crash on startup", status: "pending" },
      {
        content: LOCALIZATION_SLICE_CONTENT,
        status: "completed",
        sliceType: "mechanical",
        testStrength: "testable",
        persona: "applier",
      },
    ],
    expect: {
      localizationArmed: false,
      shortCircuit: true,
      turnRole: "continuation",
      reason:
        "P4 no-re-arm — continuation with re-fired diagnosis language + a SETTLED localization pre-pass plants nothing new; the one-shot content check holds with the inherited armLocalization=true",
    },
    note: "§4b case 2: 'still broken' after a settled localization — re-verify, never re-arm",
  },

  {
    id: "continuation-new-goal-fresh",
    prompt: "now also handle the empty case",
    priorMockVerdict: {
      goals: [
        {
          quote: "add a --json output flag to the CLI",
          shape: "build" as TriageGoalShape,
          deliverable: "CLI supports --json",
        },
      ],
      constraints: [],
      confidence: "high",
    },
    // Genuine NEW work in a follow-up message: the short-circuit must NOT
    // catch it, and the turn-read extracts it as a fresh goal.
    mockVerdict: {
      goals: [
        {
          quote: "now also handle the empty case",
          shape: "build" as TriageGoalShape,
          deliverable: "empty input handled",
        },
      ],
      constraints: [],
      confidence: "high",
      turnRole: "fresh",
    },
    expect: {
      localizationArmed: false,
      shortCircuit: false,
      turnRole: "fresh",
      reason: "P4 guard — a follow-up carrying a new deliverable is FRESH: goals extracted, normal turn open",
    },
    note: "§4b case 3: 'now also handle the empty case' — follow-up handling must not swallow new work",
  },

  // -------------------------------------------------------------------------
  // L4.1 ladder negative controls — the nine cheap SWE-mini-10 instances'
  // prompt shapes (SWE_BENCH_TRACKER.md ladder). HARD GATE: none of these may
  // change its read under the R6 optimization calibration — 0 over-fires, and
  // the armed ones stay at their pre-calibration hardness (moderate, never
  // "hard"). django-12039 is covered by grounded-trivial-central +
  // door2-grounded-mechanical-todos above; the other eight are encoded here.
  // -------------------------------------------------------------------------
  {
    id: "ladder-11790-form-attr",
    prompt:
      "AuthenticationForm's username field doesn't render the maxlength HTML attribute anymore — a regression from an earlier refactor",
    mockVerdict: {
      goals: [
        {
          quote: "AuthenticationForm's username field doesn't render the maxlength HTML attribute anymore",
          shape: "diagnosis-vague" as TriageGoalShape,
          deliverable: "username field renders maxlength again",
          // Class + field named, no file, no handed fix — R2 WEAK, exactly as
          // before R6 (a plain defect, not an optimization ask).
          evidence: { locationNamed: false, fixSpecified: false, hardness: "moderate", ambiguity: "clear" },
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: true,
      seedKind: "localization",
      reason: "R2 WEAK — symbol without a file; unchanged by R6 (defect phrasing, not optimization)",
    },
    note: "django-11790: missing maxlength attr — cheap-ladder negative control",
  },

  {
    id: "ladder-11815-enum-name",
    prompt:
      "generated migrations write the enum's value — Status('Good') — which breaks under translation; the serializer should write the name instead, Status['GOOD']",
    mockVerdict: {
      goals: [
        {
          quote: "the serializer should write the name instead, Status['GOOD']",
          shape: "diagnosis-grounded" as TriageGoalShape,
          deliverable: "migrations serialize enum members by name, not value",
          // The exact change is handed (value → name, with the target form
          // spelled out) — R2 SPECIFIED-FIX; the live judge correctly did NOT
          // arm here (tracker row 9, 2026-07-10).
          evidence: {
            locationNamed: false,
            fixSpecified: true,
            fixQuote: "should write the name instead, Status['GOOD']",
            hardness: "moderate",
            ambiguity: "clear",
          },
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: false,
      reason: "R2 SPECIFIED-FIX — the exact change is stated; no localization (live-validated non-arm, 11815)",
    },
    note: "django-11815: enum serialized by value not name — cheap-ladder negative control",
  },

  {
    id: "ladder-11848-http-date",
    prompt:
      "django.utils.http.parse_http_date's two-digit year handling is incorrect — RFC 7231 says a date more than 50 years in the future must be read as the most recent past year with those two digits, but the code hardcodes the century split",
    mockVerdict: {
      goals: [
        {
          quote: "django.utils.http.parse_http_date's two-digit year handling is incorrect",
          shape: "diagnosis-grounded" as TriageGoalShape,
          deliverable: "two-digit years parsed per RFC 7231's sliding-century rule",
          // Dotted module + function names the site — R2 STRONG (symbol+module).
          evidence: {
            locationNamed: true,
            locationQuote: "django.utils.http.parse_http_date",
            fixSpecified: false,
            hardness: "moderate",
            ambiguity: "clear",
          },
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: false,
      reason: "R2 STRONG — dotted module names the site; no localization pre-pass",
    },
    note: "django-11848: parse_http_date century bug — cheap-ladder negative control",
  },

  {
    id: "ladder-11880-deepcopy",
    prompt:
      "Form Field.__deepcopy__ doesn't deep-copy the error messages — every copy of a field shares one error_messages dict, so customizing one form's message leaks into all the others",
    mockVerdict: {
      goals: [
        {
          quote: "Form Field.__deepcopy__ doesn't deep-copy the error messages",
          shape: "diagnosis-vague" as TriageGoalShape,
          deliverable: "each copied field owns its own error_messages dict",
          // Bare dunder-method symbol, no file — R2 WEAK, unchanged by R6.
          evidence: { locationNamed: false, fixSpecified: false, hardness: "moderate", ambiguity: "clear" },
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: true,
      seedKind: "localization",
      reason: "R2 WEAK — method symbol without a file; unchanged by R6 (shared-state defect, not optimization)",
    },
    note: "django-11880: __deepcopy__ shares error_messages — cheap-ladder negative control",
  },

  {
    id: "ladder-11951-batch-size",
    prompt:
      "bulk_create's batch_size param overrides the compatible batch size calculation — it should take the minimum of batch_size and the max compatible batch size, the way bulk_update already does",
    mockVerdict: {
      goals: [
        {
          quote: "it should take the minimum of batch_size and the max compatible batch size",
          shape: "diagnosis-grounded" as TriageGoalShape,
          deliverable: "bulk_create clamps batch_size to the compatible maximum",
          // KEY R6 negative control: "batch size" language, but a handed fix
          // (min of the two, mirroring a named sibling) — R2 SPECIFIED-FIX, a
          // wrong-logic defect, NOT an optimization ask. Must not read "hard"
          // and must not arm.
          evidence: {
            locationNamed: false,
            fixSpecified: true,
            fixQuote: "take the minimum of batch_size and the max compatible batch size",
            hardness: "trivial",
            ambiguity: "clear",
          },
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: false,
      reason:
        "R2 SPECIFIED-FIX — exact change handed (clamp to min); 'batch' wording alone never triggers R6",
    },
    note: "django-11951: batch_size override — the R6 near-miss negative control",
  },

  {
    id: "ladder-11964-choices-type",
    prompt:
      "the value of a TextChoices/IntegerChoices field has a differing type — reading the field right after creating the object returns the enum member, so str() gives 'Status.GOOD' instead of 'GOOD'",
    mockVerdict: {
      goals: [
        {
          quote: "the value of a TextChoices/IntegerChoices field has a differing type",
          shape: "diagnosis-vague" as TriageGoalShape,
          deliverable: "field value has the declared str/int type in all read paths",
          // Class names + symptom, no file — R2 WEAK; live-validated armed
          // no-location case (tracker row 9's contrast set).
          evidence: { locationNamed: false, fixSpecified: false, hardness: "moderate", ambiguity: "clear" },
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: true,
      seedKind: "localization",
      reason: "R2 WEAK — API classes named, no file; unchanged by R6 (type defect, not optimization)",
    },
    note: "django-11964: Choices field type mismatch — cheap-ladder negative control",
  },

  {
    id: "ladder-11999-display-override",
    prompt:
      "cannot override get_FOO_display() anymore — defining get_status_display() on the model has no effect now, though the same override worked in the previous release",
    mockVerdict: {
      goals: [
        {
          quote: "cannot override get_FOO_display() anymore",
          shape: "diagnosis-vague" as TriageGoalShape,
          deliverable: "user-defined get_FOO_display overrides take effect again",
          // Method symbol + regression symptom, no file — R2 WEAK; the live
          // turn-read armed this at moderate/clear (tracker row 6).
          evidence: { locationNamed: false, fixSpecified: false, hardness: "moderate", ambiguity: "clear" },
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: true,
      seedKind: "localization",
      reason: "R2 WEAK — method symbol, no file (live-validated arm at moderate/clear, 11999); unchanged by R6",
    },
    note: "django-11999: get_FOO_display override regression — cheap-ladder negative control",
  },

  {
    id: "ladder-12050-list-coerce",
    prompt:
      "Query.resolve_lookup_value coerces a list value to a tuple, which breaks exact-match queries for field types whose matching depends on the input type",
    mockVerdict: {
      goals: [
        {
          quote: "Query.resolve_lookup_value coerces a list value to a tuple",
          shape: "diagnosis-vague" as TriageGoalShape,
          deliverable: "resolved lookup values keep the input's iterable type",
          // Bare symbol, no file, coercion defect (no exact change handed) —
          // R2 WEAK; live-validated armed no-location case. "Coerces" is
          // defect language, never R6 optimization phrasing.
          evidence: { locationNamed: false, fixSpecified: false, hardness: "moderate", ambiguity: "clear" },
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: true,
      seedKind: "localization",
      reason: "R2 WEAK — symbol without file; unchanged by R6 (wrong-type defect, not optimization)",
    },
    note: "django-12050: list→tuple coercion — cheap-ladder negative control",
  },

  // -------------------------------------------------------------------------
  // Genuinely ambiguous (documented, low-weight — flag, don't over-fit)
  // -------------------------------------------------------------------------
  {
    id: "ambiguous-log-a-bug",
    prompt: "log a bug for a 500 error on login",
    mockVerdict: {
      goals: [
        {
          quote: "log a bug for a 500 error on login",
          shape: "build" as TriageGoalShape,
          deliverable: "issue filed documenting the 500 error on login",
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: false,
      reason: "R1 — treated as build (file an issue), not diagnosis-vague; revisit if real usage disagrees",
    },
    note: "Report-vs-diagnose ambiguity: 'log a bug' read as build (create an issue), not a fix request — low-weight, flagged not over-fit",
  },
]
