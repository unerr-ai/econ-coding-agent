// Fixed protocol strings the turn driver (prompt.ts) injects: structured-output
// enforcement and the hidden title-generation turn's marker.

export const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

export const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.`

/** Stable prefix of the hidden title-generation turn's opening user message — lets an out-of-band test harness (e.g. a scripted LLM stub) recognize the turn-open title call without duplicating the full prompt text. */
export const TITLE_GENERATION_PROMPT_MARKER = "Generate a title for this conversation"
