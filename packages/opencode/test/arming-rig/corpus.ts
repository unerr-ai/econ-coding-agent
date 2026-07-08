import type { ArmingScenario, TriageVerdict, TriageGoalShape, OrchestrationTodo } from "./types"

/**
 * Arming-rig corpus: ~12 diverse, realistic labeled scenarios that stress both
 * failure modes of the localization-arming decision (OVER-FIRE vs UNDER-FIRE).
 *
 * Each scenario encodes the CORRECT/desired outcome in expect.localizationArmed,
 * not current behavior. The rig runs the arming pipeline and scores against this
 * baseline; violations show where the decision logic needs tuning.
 */
export const CORPUS: ArmingScenario[] = [
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
      reason: "file path known (grounded diagnosis) — no localization pre-pass needed, already pointed",
    },
    note: "django-12039: trivial whitespace fix in a central file",
  },

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
      reason: "conductor-authored mechanical todos + grounded goal = file is known; Door-2 net stays disarmed",
    },
    note: "django-12039 Door-2: mechanical todos bind the location, suppress localization",
  },

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
      reason: "vague diagnosis (no file) + spec language (structural) = needs localization pre-pass to find the code",
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
      reason: "vague-diagnosis (no file) + low confidence = needs localization pre-pass to triage boot code",
    },
    note: "real crash: no file mentioned, requires structural search",
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
      reason: "file + line number specified (grounded) = no localization needed; skeleton seed already targets the file",
    },
    note: "typical bug report with known location",
  },

  {
    id: "grounded-cross-layer-file-named",
    prompt: "the API response formatting in server/api.ts is incorrect — we need to adjust the serialization on the HTTP level but also update the database layer query to fetch the right fields",
    mockVerdict: {
      goals: [
        {
          quote: "the API response formatting in server/api.ts is incorrect",
          shape: "diagnosis-grounded" as TriageGoalShape,
          deliverable: "API response formatting corrected with database layer alignment",
          dependsOn: [1],
        },
        {
          quote: "update the database layer query to fetch the right fields",
          shape: "diagnosis-grounded" as TriageGoalShape,
          deliverable: "database query fields aligned with API response",
        },
      ],
      constraints: [],
      confidence: "high",
    },
    expect: {
      localizationArmed: false,
      reason: "concrete file named (server/api.ts) counts as grounded; even though change spans layers, the entry point is known",
    },
    note: "multi-file change, but starting file is specified",
  },

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
      reason: "build-shape goal = feature request, not a diagnosis; no localization pre-pass needed",
    },
    note: "feature build shape; clear intent but not a bug fix",
  },

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
      reason: "audit-shape goal = verification task, not diagnosis; no localization pre-pass needed",
    },
    note: "code review / audit task",
  },

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
      reason: "run-only-shape goal = observability task, no code change expected; no localization pre-pass needed",
    },
    note: "pure execution / reporting task",
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
      reason: "Door-2 backstop: mechanical todos exist but NO file name in prompt or todos → vague at terminal, localization still required",
    },
    note: "todos alone don't ground vague diagnosis if no file is named",
  },

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
      reason: "mixed goals: grounded + vague in one verdict → the vague goal arms localization for both; sketch needed before coding",
    },
    note: "one grounded + one vague goal in the same turn",
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
      reason: "entity name (QuerySet.delete) mentioned but NO file path → naming an API is not knowing the file; needs localization pre-pass",
    },
    note: "Django ORM API mentioned by symbol, not by file location",
  },
]
