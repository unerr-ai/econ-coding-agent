/**
 * OpenAI-compatible chat-completions provider — calls any endpoint that
 * speaks the OpenAI /chat/completions protocol (OpenRouter, local Ollama,
 * Together AI, etc.). Requires a valid API key in `endpoint.apiKey`.
 * @sem domain=eval role=provider
 */

import type { Fixture, ModelEndpoint, RunResult } from "../types.js"

interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

interface ChatCompletionResponse {
  choices: Array<{
    message: { role: string; content: string }
    finish_reason: string
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

/**
 * Calls the OpenAI-compatible chat completions endpoint for one fixture.
 * Throws if the HTTP request fails or returns a non-2xx status.
 */
export async function runOpenAICompat(fixture: Fixture, endpoint: ModelEndpoint): Promise<RunResult> {
  if (!endpoint.apiKey) {
    throw new Error(
      `openai-compat provider for model "${endpoint.name}" requires an API key. ` +
        `Set endpoint.apiKey or switch to provider:"mock" for dry-run.`,
    )
  }

  const messages: ChatMessage[] = []
  if (fixture.system) messages.push({ role: "system", content: fixture.system })
  messages.push({ role: "user", content: fixture.prompt })

  const url = `${endpoint.baseURL.replace(/\/$/, "")}/chat/completions`
  const start = Date.now()

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${endpoint.apiKey}`,
    },
    body: JSON.stringify({
      model: endpoint.model,
      messages,
      max_tokens: 512,
      temperature: 0,
    }),
  })

  const latencyMs = Date.now() - start

  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable body)")
    throw new Error(`HTTP ${res.status} from ${url}: ${body}`)
  }

  const data = (await res.json()) as ChatCompletionResponse
  const output = data.choices[0]?.message?.content ?? ""

  const inputTokens = data.usage?.prompt_tokens ?? 0
  const outputTokens = data.usage?.completion_tokens ?? 0

  const costUsd =
    (inputTokens / 1_000_000) * endpoint.pricing.inputPer1M +
    (outputTokens / 1_000_000) * endpoint.pricing.outputPer1M

  return {
    fixtureId: fixture.id,
    tier: fixture.tier,
    modelName: endpoint.name,
    pass: fixture.check(output),
    output,
    latencyMs,
    inputTokens,
    outputTokens,
    costUsd,
  }
}
