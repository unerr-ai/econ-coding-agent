import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer } from "effect"

import { InstanceState } from "@/effect/instance-state"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"
import PROMPT_KIMI from "./prompt/kimi.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { Reference } from "@opencode-ai/core/reference"

export function provider(model: Provider.Model) {
  if (model.api.id.includes("gpt-4") || model.api.id.includes("o1") || model.api.id.includes("o3"))
    return [PROMPT_BEAST]
  // `gpt-oss-*` are open-weight models, not OpenAI's GPT line — they must not inherit the
  // OpenAI-flavored GPT prompt. econ tiers route via `select()` below; this guard protects any
  // other caller of provider() (e.g. a non-econ agent pinned to an OSS gpt-oss model).
  if (model.api.id.includes("gpt") && !model.api.id.includes("gpt-oss")) {
    if (model.api.id.includes("codex")) {
      return [PROMPT_CODEX]
    }
    return [PROMPT_GPT]
  }
  if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
  if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
  if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
  if (model.api.id.toLowerCase().includes("kimi")) return [PROMPT_KIMI]
  return [PROMPT_DEFAULT]
}

// econ tier names (the agents declared in opencode.json). Their models are OSS (qwen / glm /
// gpt-oss), whose quirks are not the OpenAI/Gemini/Claude ones the provider-quirk prompts target —
// so they get the generic econ base + a thin per-tier delta, bypassing provider() substring matching.
const ECON_TIERS = new Set(["conductor", "executor", "oracle", "reasoner"])

// Per-tier behavioral deltas (Sprint 5b §10.3). Short by design: the shared core carries the bulk;
// each delta states only what is distinct about that tier so the cached prefix stays lean. Tier
// selection is now live: the tier-router (tier-router.ts, OL-3.1/3.2) reassigns the turn's agent at
// the createUserMessage seam, so a hard turn is served by the reasoner/oracle rather than the pinned
// conductor. The oracle "compiled-brief" assembly (brief.ts) is built + unit-tested but not on the
// live path yet — it awaits a live unerrd recon client for its slices (same blocker as OL-3.3).
const TIER_DELTA: Record<string, string> = {
  conductor: [
    "# econ conductor (default engineer — you orchestrate the whole turn)",
    "You are the default tier and the orchestrator. You do not just answer — you run a loop every non-trivial turn: understand, plan, delegate, verify, then respond. Hold the working context across turns.",
    "1. Recon first, then meta-plan. On an unfamiliar or high-blast-radius turn, spawn read-only recon (find / trace / map the affected code and its callers) via the `task` tool BEFORE you plan — fan out several in parallel when the areas are independent, and plan from the consolidated digests, not from assumptions. Then, before editing anything on a non-trivial turn, state in one or two lines what the user is really asking and how you will approach it — grounded in the session so far and the recon. Skip recon and this step only for a trivial one-step answer.",
    "2. Externalise the plan. For any task of three or more steps, call `todowrite` to write the task list BEFORE you start executing. Mark a task `in_progress` before you begin it and `completed` the moment it is done; add follow-ups the instant you discover them. The list is your plan of record, not a log written after the fact.",
    "3. Delegate by default. Route read-only recon (find / trace / map, audits, codebase Q&A) and scoped, mechanical slices to the executor via the `task` tool — spawn them in parallel when the slices are independent. Keep only what needs your judgement on your own thread: architecture, public interfaces, cross-cutting wiring, and bug root-causing. Give each sub-agent the task plus a one-line pointer, never a pasted transcript; review and integrate each returned digest before building on it.",
    "4. Verify before you claim done. Non-trivial implementation is not finished until it is independently verified — delegate a scoped verify (typecheck + the targeted tests + lint) and read the result before you report completion. Never report success on unverified or failing work.",
    "Prefer the cheapest path that does the job well, and keep context lean.",
  ].join("\n"),
  executor: [
    "# econ executor (scoped assistant)",
    "You execute one clearly-scoped task handed to you. Do exactly that task, verify it (typecheck / targeted tests / lint where applicable), and return a tight digest.",
    "Do not expand scope, redesign, or make unrelated changes.",
  ].join("\n"),
  oracle: [
    "# econ oracle (expert)",
    "You are called rarely, for the hardest, highest-risk steps. Reason carefully and give a precise, well-justified answer; do not pad.",
  ].join("\n"),
}
TIER_DELTA["reasoner"] = TIER_DELTA["oracle"]

// Choose the base system prompt for a turn (Sprint 5b §10.2). econ tiers get the econ base +
// their tier delta; every other agent keeps the existing provider-quirk selection.
export function select(model: Provider.Model, agent: Agent.Info): string[] {
  if (ECON_TIERS.has(agent.name)) {
    const delta = TIER_DELTA[agent.name]
    return delta ? [PROMPT_DEFAULT, delta] : [PROMPT_DEFAULT]
  }
  return provider(model)
}

// Generate the authoritative tool-usage section from the live advertised tool set (Sprint 5b §10.1).
// This is the single source of truth: the prompt can never name a tool the model isn't given, which
// closes the prompt↔tool drift class (the grep/glob coupling) permanently. The full per-tool schema
// is already sent in the API `tools` field, so this block stays lean — it enumerates the canonical
// ids and adds only econ-specific usage the model must follow, each note gated on its tool's presence.
export function toolUsage(toolIds: readonly string[]): string {
  const ids = [...new Set(toolIds)].sort()
  if (ids.length === 0) return ""
  const has = (id: string) => ids.includes(id)
  const notes: string[] = []
  // Hard rule first: reading/searching/listing code is what the read tools are for; bash is only
  // for running things. An OSS model left to its own habits reaches for `bash find/grep/cat/ls` —
  // that path is denied for reads here, so state the boundary as NEVER, not a preference.
  if (has("read") || has("search") || has("file_outline"))
    notes.push(
      "- To read, search, or list code you use the read tools — never `bash`. `bash` is only for running things (build, test, git, scripts); it is not a way to read files, search text, or list directories. Reaching for `bash cat/ls/find/grep/wc` to inspect code is wrong even when it would work.",
    )
  if (has("search"))
    notes.push(
      "- `search` is how you find anything: a plain phrase describing what you need returns the relevant code in one shot (start any unfamiliar task here), or pass `mode` for exact text (`literal`/`regex`), filenames (`glob`), or a symbol's callers/callees (`refs`).",
    )
  if (has("read"))
    notes.push(
      "- `read` returns a file with line numbers; pass `entity` to get just one symbol (a function or class) instead of the whole file, and `offset`/`limit` to page a large file.",
    )
  if (has("file_outline"))
    notes.push(
      "- `file_outline` lists a file's entities (name, kind, line range) and imports — call it before reading a large file to jump straight to the part you need.",
    )
  if (has("webfetch"))
    notes.push(
      "- `webfetch` returns compressed, relevance-ranked passages — pass a `prompt` to focus the ranking and page with `cache_ref` at near-zero cost.",
    )
  return [
    "# Available tools",
    `You have exactly these tools, and no others — call each by its exact id: ${ids.join(", ")}.`,
    ...(notes.length
      ? [
          "The full description of each tool is supplied in the API tools field. econ-specific usage you must follow:",
          ...notes,
        ]
      : []),
    "Never call a tool whose id is not in the list above.",
  ].join("\n")
}

export interface Interface {
  readonly environment: (model: Provider.Model) => Effect.Effect<string[]>
  readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const locations = yield* LocationServiceMap

    return Service.of({
      environment: Effect.fn("SystemPrompt.environment")(function* (model: Provider.Model) {
        const ctx = yield* InstanceState.context
        const references = yield* Effect.gen(function* () {
          return (yield* (yield* Reference.Service).list()).filter((reference) => reference.description !== undefined)
        }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))))
        return [
          [
            `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
            `Here is some useful information about the environment you are running in:`,
            `<env>`,
            `  Working directory: ${ctx.directory}`,
            `  Workspace root folder: ${ctx.worktree}`,
            `  Is directory a git repo: ${ctx.project.vcs === "git" ? "yes" : "no"}`,
            `  Platform: ${process.platform}`,
            // AC-7.2/AC-8.3 — the one permitted per-day variance in the cached prefix:
            // stable within a session/cache-TTL, rotates daily. The golden-hash test
            // (test/session/cache-prefix.test.ts) strips this line before hashing and
            // asserts it separately against the `Today's date: <weekday> <mon> <dd> <yyyy>` shape.
            `  Today's date: ${new Date().toDateString()}`,
            `</env>`,
          ].join("\n"),
          references.length === 0
            ? undefined
            : [
                "Project references provide additional directories that can be accessed when relevant.",
                "<available_references>",
                ...references
                  .toSorted((a, b) => a.name.localeCompare(b.name))
                  .flatMap((reference) => [
                    "  <reference>",
                    `    <name>${reference.name}</name>`,
                    `    <path>${reference.path}</path>`,
                    ...(reference.description === undefined
                      ? []
                      : [`    <description>${reference.description}</description>`]),
                    "  </reference>",
                  ]),
                "</available_references>",
              ].join("\n"),
        ].filter((part): part is string => part !== undefined)
      }),

      skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info) {
        if (Permission.disabled(["skill"], agent.permission).has("skill")) return

        const list = yield* skill.available(agent)

        return [
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Use the skill tool to load a skill when a task matches its description.",
          // the agents seem to ingest the information about skills a bit better if we present a more verbose
          // version of them here and a less verbose version in tool description, rather than vice versa.
          Skill.fmt(list, { verbose: true }),
        ].join("\n")
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Skill.defaultLayer), Layer.provide(LocationServiceMap.layer))

const locationServiceMapNode = LayerNode.make(LocationServiceMap.layer, [])

export const node = LayerNode.make(layer, [Skill.node, locationServiceMapNode])

export * as SystemPrompt from "./system"
