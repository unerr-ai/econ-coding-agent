import PROMPT_DEFAULT from "../prompt/default.txt"
import { WEB_LOOKUP_DOCTRINE } from "./fragments"

const THINKING_OVERRIDE =
  "Brevity applies to your final messages, not your reasoning: think as long as the problem needs — thorough internal reasoning is expected and never counts against the response-length rules above. Work in a loop: act, observe the result, then decide your next action."

/**
 * default.txt verbatim, plus a paragraph that overrides its brevity
 * directives (lines 17/19/95's "fewer than 4 lines" / "minimize output
 * tokens") for the un-muted thinking channel on engineering runs — those
 * rules must bind the final response, never the internal reasoning trace —
 * plus the shared web-lookup doctrine (WEB_LOOKUP_DOCTRINE), so every econ
 * tier and persona built on this base inherits one static when-to-search rule.
 *
 * @sem domain=routing role=config
 */
export const BASE = [PROMPT_DEFAULT, THINKING_OVERRIDE, WEB_LOOKUP_DOCTRINE].join("\n\n")
