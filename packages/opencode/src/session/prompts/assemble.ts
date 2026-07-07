import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { ECON_PERSONAS, type EconPersona } from "../../../../code-intelligence/src/model-registry"
import { provider } from "../system"
import { BASE } from "./base"
import { TIER_DELTA } from "./roles"
import { PERSONA_DELTA } from "./personas"

// econ tier names (the agents declared in opencode.json). Their models are OSS (qwen / glm /
// gpt-oss), whose quirks are not the OpenAI/Gemini/Claude ones the provider-quirk prompts target —
// so they get the generic econ base + a thin per-tier delta, bypassing provider() substring matching.
const ECON_TIERS = new Set(["conductor", "executor", "oracle", "reasoner"])

const ECON_PERSONA_SET = new Set<string>(ECON_PERSONAS)

// Choose the base system prompt for a turn (Sprint 5b §10.2). econ tiers get the econ base +
// their tier delta; econ personas (OL-9.1a) get the econ base + their persona delta; every
// other agent keeps the existing provider-quirk selection.
export function select(model: Provider.Model, agent: Agent.Info): string[] {
  if (ECON_TIERS.has(agent.name)) {
    const delta = TIER_DELTA[agent.name]
    return delta ? [BASE, delta] : [BASE]
  }
  if (ECON_PERSONA_SET.has(agent.name)) {
    return [BASE, PERSONA_DELTA[agent.name as EconPersona]]
  }
  return provider(model)
}
