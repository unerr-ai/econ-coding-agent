import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ECON_MODELS, ECON_PERSONAS, tierModelRef, type EconPersona } from "../../../code-intelligence/src/model-registry"

/**
 * One-line `@ autocomplete` descriptions for the six executor-persona intern agents
 * (OL-9.1c — persona-deltas-design.md). Order matches ECON_PERSONAS.
 *
 * @sem domain=configuration role=config
 */
const PERSONA_DESCRIPTION: Record<EconPersona, string> = {
  explorer: "econ persona — read-only recon intern: investigates one question, returns a digest, never edits.",
  runner: "econ persona — command intern: runs the brief's exact commands in order and reports what happened.",
  applier: "econ persona — edit intern: applies exactly the specified change, verifies it, and reports.",
  author: "econ persona — scoped creation intern: writes new tests/docstrings/scaffolds, never touches existing behavior.",
  researcher: "econ persona — docs/web lookup intern: answers a lookup question from sources it actually fetched.",
  procedure: "econ persona — step-by-step intern: executes the brief's numbered procedure and reports per step.",
}

/**
 * Permission deltas for each persona, layered on top of econ's global `permission` defaults
 * below (which already sets read/list/glob/grep/lsp/edit/bash/webfetch/websearch to allow).
 * All six personas are equally capable now — no persona-specific override is listed here;
 * `task` and `question` are denied for every persona (OL-9.3d, injected by the wiring below)
 * and the childSlicePermission overlay (slice-orchestrator.ts) grants edit/bash at dispatch
 * and re-denies the danger bash patterns for every seat alike — web is NOT touched by that
 * overlay, so it follows this config floor (or a stricter user/arena override) instead.
 *
 * @sem domain=configuration role=config
 */
const PERSONA_PERMISSION: Record<EconPersona, Record<string, "allow" | "ask" | "deny">> = {
  explorer: {},
  runner: {},
  applier: {},
  author: {},
  researcher: {},
  procedure: {},
}

/**
 * Physical per-persona toolset trims (OL-9.4a) — `false` here drops the tool from the agent's
 * advertised set entirely, unlike `PERSONA_PERMISSION` above which only gates execution while
 * still listing the tool in the prompt. All six personas are equally capable now, so no
 * persona-specific trim remains here: `task`, `question`, and `todowrite` are dropped for every
 * persona by the wiring below (OL-9.5e — observed: a procedure child wrote its own
 * typed slices and became a recursive orchestrator, parenting 43 grandchildren, because typing a
 * `todowrite` item is the explicit opt-in to decomposition and personas still had the tool); no
 * persona drops the edit-family or bash tools any longer — every persona shares the full
 * executor toolset, differing only by prompt delta and step budget.
 *
 * @sem domain=configuration role=config
 */
const PERSONA_TOOLS: Record<EconPersona, Record<string, boolean>> = {
  explorer: {},
  runner: {},
  applier: {},
  author: {},
  researcher: {},
  procedure: {},
}

/**
 * Build one provider model entry, deriving the capability fields (context window, max output,
 * reasoning flag, BYOK cost rate card) from the code-intelligence registry — the single source of
 * truth — while the display name and per-model reasoning-effort options are carried faithfully
 * from opencode.json. Throws if the model is absent from ECON_MODELS so a missing pin fails loud
 * rather than shipping a phantom default.
 *
 * @sem domain=configuration role=config
 */
function econModel(key: string, name: string, options: Record<string, unknown>) {
  const m = ECON_MODELS[key]
  if (!m) throw new Error(`econ-defaults: model "${key}" is not in ECON_MODELS`)
  return {
    name,
    ...(m.reasoning ? { reasoning: true } : {}),
    // OL-9.6h (shape fixed 2026-07-06): this entry rides the CONFIG layer, so it must use
    // ConfigV1's FLAT cost keys (core/v1/config/provider.ts: input/output/cache_read/
    // cache_write) — provider.ts maps them to the nested Model.cost.cache at load. The
    // original nested `cache:{read,write}` shape was silently stripped by the loadConfig
    // schema pass, so every cached token was DB-priced at $0 (measured: 2.3x receipt-vs-DB
    // drift on the conductor, the only tier with cache hits). Rates are sourced from
    // ECON_MODELS[key].cost (ECON_COST_MATRIX, the single home for rates). cache_write is
    // hardcoded 0, NOT the matrix's cacheWrite field: the authoritative Fireworks serverless
    // rate card bills no separate cache-write price (the matrix stands cacheWrite in at the
    // input rate for its own BYOK-path accounting).
    cost: {
      input: m.cost.input,
      output: m.cost.output,
      cache_read: m.cost.cachedInput,
      cache_write: 0,
    },
    limit: { context: m.contextWindow, output: m.maxOutput },
    // Omit an empty options object so the entry stays byte-identical to opencode.json,
    // which drops the key when a model carries no per-model options.
    ...(Object.keys(options).length ? { options } : {}),
  }
}

/**
 * econ's built-in tier configuration as an in-code config object, so the agent ships its
 * cost-routing model surface — the conductor/oracle/reasoner/executor pins, the six
 * executor-persona intern agents (OL-9.1c), the top-level and small_model fallbacks, the
 * disabled native build/plan agents, and the LiteLLM provider model options — even when
 * launched from a working directory that has no opencode.json. Wired as the
 * base config layer (below every user/global/project source), it is what stops OpenCode's terminal
 * models.dev catalog fallback from selecting a non-tool model on a foreign repo. Model ids and
 * capabilities are derived from the code-intelligence registry (ECON_TIER_BINDING/ECON_MODELS) so a
 * tier swap there flows here without editing a literal; the checked-in econ opencode.json fully
 * re-specifies these keys, so inside the econ repo the effective config is byte-identical.
 *
 * @sem domain=configuration role=config
 */
export function econDefaultConfig(): ConfigV1.Info {
  return {
    default_agent: "conductor",
    small_model: tierModelRef("executor"),
    model: tierModelRef("conductor"),
    // econ permission floor — mirrors opencode.json's `permission` block (drift-guarded in
    // econ-defaults.test.ts) so a headless `opencode run` in ANY cwd (arena, a user's repo) is
    // fully capable, not just runs inside the econ repo. Without it, bash/edit/web match no rule →
    // evaluate() default `ask` → the headless backstop denies them. Read + edit + bash + web are
    // ALLOW so every tier (root conductor included) can act headless; delegate is slice-seat-only;
    // the bash danger floor (deletes/disk-wipe/privilege/system-power) and out-of-project are DENY.
    permission: {
      read: "allow",
      list: "allow",
      glob: "allow",
      grep: "allow",
      lsp: "allow",
      todowrite: "allow",
      question: "allow",
      task: "allow",
      delegate: "deny",
      edit: "allow",
      webfetch: "allow",
      websearch: "allow",
      doom_loop: "ask",
      skill: "ask",
      // 09-ops-hands D1/D3: job actions (status/output/wait/kill) only ever touch jobs this
      // process itself spawned via bash's background:true — same trust boundary as bash, safe
      // to allow headless.
      job: "allow",
      external_directory: "deny",
      bash: {
        "*": "allow",
        "git push*": "ask",
        "curl *": "ask",
        "wget *": "ask",
        "sudo *": "deny",
        "su *": "deny",
        "doas *": "deny",
        "rm -rf *": "deny",
        "rm -fr *": "deny",
        "rm -r *": "deny",
        "dd *": "deny",
        "mkfs*": "deny",
        "shutdown*": "deny",
        "reboot*": "deny",
        "halt*": "deny",
        "poweroff*": "deny",
        "init 0*": "deny",
        "init 6*": "deny",
        "git clean -f*": "deny",
      },
    },
    agent: {
      // Disable OpenCode's native model-less primary agents so nothing resolves through the catalog fallback.
      build: { disable: true },
      plan: { disable: true },
      conductor: {
        model: tierModelRef("conductor"),
        description: "econ default conductor — the 'Engineer': cheap+fast agentic OSS workhorse that plans, decides, and holds context for everyday turns.",
        mode: "primary",
      },
      oracle: {
        model: tierModelRef("oracle"),
        description: "econ oracle tier — the 'Expert': top open-weight coding model, called rarely for high-risk turns.",
        mode: "primary",
      },
      reasoner: {
        model: tierModelRef("reasoner"),
        description: "econ reasoner tier (OL-8.B4+): DeepSeek V4 Pro, a distinct model family from both the conductor and the oracle — deliberate verifier de-correlation — for hard steps that don't warrant the full Expert escalation.",
        mode: "primary",
        hidden: true,
      },
      executor: {
        model: tierModelRef("executor"),
        description: "econ executor tier — the 'Assistant': fast small model for delegable chores (recon/lint/docstrings), spawned per-task and returning a digest.",
        mode: "subagent",
        // OL-9.3d: only the conductor plans and delegates — the executor (like every persona
        // below) does not carry task/question, so a delegated chore can't itself fan out.
        permission: { task: "deny", question: "deny" },
        // OL-9.5e: a slice child can in principle run as a tier agent on escalation, so the
        // executor loses todowrite too — only the conductor may type a decomposition slice.
        tools: { todowrite: false },
      },
      // OL-9.1c — six stateless executor-persona intern agents, all backed by the executor
      // tier's model with their own prompt delta (session/prompts/personas.ts PERSONA_DELTA) but
      // the same full executor toolset — every persona is equally capable, differing only by
      // prompt delta and step budget. task/question/todowrite stay dropped for every persona
      // (a slice child still can't itself fan out or decompose); the childSlicePermission
      // overlay (slice-orchestrator.ts) grants edit/bash/web at dispatch and re-denies the
      // danger bash patterns for every seat alike.
      ...Object.fromEntries(
        ECON_PERSONAS.map((persona) => [
          persona,
          {
            model: tierModelRef("executor"),
            description: PERSONA_DESCRIPTION[persona],
            mode: "subagent" as const,
            hidden: true,
            permission: {
              task: "deny",
              question: "deny",
              ...PERSONA_PERMISSION[persona],
            },
            tools: {
              task: false,
              question: false,
              todowrite: false,
              ...PERSONA_TOOLS[persona],
            },
          },
        ]),
      ),
    },
    provider: {
      litellm: {
        name: "econ LiteLLM gateway",
        npm: "@ai-sdk/openai-compatible",
        env: ["LITELLM_API_KEY"],
        options: {
          baseURL: "https://econ-litellm.fly.dev/v1",
          // Stall watchdogs (2026-07-10): a fly.dev gateway stall wedged a live
          // run forever — request accepted, zero bytes, nothing to abort it
          // (a full-stack probe; the same stall class nulled turn-read on a
          // second full-stack probe). Both timeouts map to retryable APIErrors
          // upstream (HeaderTimeoutError / ResponseStreamError), so the session
          // loop's existing backoff absorbs the blip instead of hanging the run.
          headerTimeout: 45_000,
          chunkTimeout: 120_000,
          // Total request cap: chunkTimeout only wraps SSE bodies — a stalled
          // NON-streaming response (judge/triage generateText) has no byte-level
          // watchdog and sat 6+ min before a silent exit.
          // 300s bounds any single request; legitimate calls average ~15s.
          timeout: 300_000,
        },
        models: {
          "deepseek/deepseek-v4-flash": econModel("deepseek/deepseek-v4-flash", "DeepSeek V4 Flash (econ conductor)", {
            reasoningEffort: "none",
            parallel_tool_calls: true,
          }),
          "z-ai/glm-5.2": econModel("z-ai/glm-5.2", "GLM 5.2 (econ oracle)", {
            reasoningEffort: "high",
            parallel_tool_calls: true,
          }),
          "deepseek/deepseek-v4-pro": econModel("deepseek/deepseek-v4-pro", "DeepSeek V4 Pro (econ reasoner)", {
            reasoningEffort: "high",
            parallel_tool_calls: true,
          }),
          "openai/gpt-oss-120b": econModel("openai/gpt-oss-120b", "gpt-oss-120b (econ executor/assistant)", {
            reasoningEffort: "low",
            parallel_tool_calls: true,
          }),
          // 2026-07-08 catalog add; 2026-07-09 conductor swap: minimax-m3 is now bound to the
          // conductor tier (see ECON_TIER_BINDING in model-registry.ts). 2026-07-12 E0: bounded
          // explicit "high" — "none" suppressed the judgment tier, and DELETING the param meant
          // unbounded server-side thinking (one 2,453s step observed). Pin it; never omit it.
          // kimi remains catalog-only, not bound to a tier.
          "minimax/minimax-m3": econModel("minimax/minimax-m3", "MiniMax M3 (econ conductor — experiment)", {
            reasoningEffort: "high",
            parallel_tool_calls: true,
          }),
          "moonshotai/kimi-k2p7-code": econModel("moonshotai/kimi-k2p7-code", "Kimi K2.7 Code (catalog)", {
            parallel_tool_calls: true,
          }),
        },
      },
    },
  }
}
