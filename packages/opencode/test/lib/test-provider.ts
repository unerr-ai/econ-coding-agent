// Shared provider config for tests that need opencode to talk to a fake LLM
// over a real HTTP endpoint. Registers a single provider `test` with a single
// model `test-model`, pointed at the URL the caller supplies (typically a
// TestLLMServer instance). Also sets the top-level `model` field (the same
// "provider/modelID" string `--model` used to take) so the binary resolves a
// model with no CLI flag — see `Provider.defaultModel` (`cfg.model`).
//
// Used by:
//   - test/lib/cli-process.ts          (subprocess CLI tests)
//   - test/server/httpapi-sdk.test.ts  (in-process SDK tests)
export function testProviderConfig(llmUrl: string, modelID: string = "test/test-model") {
  return {
    formatter: false,
    lsp: false,
    model: modelID,
    provider: {
      test: {
        name: "Test",
        id: "test",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "test-model": {
            id: "test-model",
            name: "Test Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "test-key", baseURL: llmUrl },
      },
    },
  }
}
