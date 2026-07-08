import type { ArmingScenario, TriageVerdict, TriageGoalShape, OrchestrationTodo } from "./types"

/**
 * Arming-rig corpus: the golden spec (docs/testing/PROMPT_SLICING_CORPUS.md)
 * encoded 1:1 — one ArmingScenario per corpus-table row, same `id`, stressing
 * both failure modes of the localization-arming decision (OVER-FIRE vs
 * UNDER-FIRE) plus the PLANNER escalation (R3) and the Door-2 net (R4).
 *
 * Each scenario encodes the CORRECT/desired outcome in expect.localizationArmed,
 * not current behavior. The rig runs the arming pipeline and scores against this
 * baseline; violations show where the decision logic needs tuning. `expect.reason`
 * cites the corpus rule (R1-R4) that decides the case — see the doc for the
 * full rule text.
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
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: true,
      reason: "R2 NONE-grounding — symptom described structurally but no file named; needs localization to find the code",
    },
    note: "django-11885: performance bug described without file path",
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
        },
      ],
      constraints: [],
      confidence: "low",
    },
    expect: {
      localizationArmed: true,
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
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: true,
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
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: true,
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
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: true,
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
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: true,
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
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: true,
      reason: "R3 — a hard vague bug (concurrency, cross-cutting) arms PLANNER, not just localization",
    },
    note: "hard vague bug — R3 overrides plain localization with a plan-first pass",
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
        },
        {
          quote: "a query in the database layer that isn't fetching the right fields",
          shape: "diagnosis-vague" as TriageGoalShape,
          deliverable: "database layer query updated to fetch the right fields",
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: true,
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
        },
        {
          quote: "the error messages are unclear",
          shape: "diagnosis-vague" as TriageGoalShape,
          deliverable: "error messages enhanced with more context",
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: true,
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
        },
      ],
      constraints: [],
      confidence: "low",
    },
    expect: {
      localizationArmed: true,
      reason: "R4 — mechanical todos exist but name no file; arming still stands (Door-2 backstop)",
    },
    note: "todos alone don't ground vague diagnosis if no file is named",
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
