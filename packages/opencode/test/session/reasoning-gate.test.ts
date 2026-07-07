import { describe, expect, test } from "bun:test"
import { applyAdaptiveReasoning } from "../../src/session/llm/reasoning-gate"

// OL-7.5-adjacent adaptive conductor reasoning gate: un-mutes thinking on exactly
// the turn's plan step and the step right after a failed bash command.
describe("reasoning-gate", () => {
  test("fresh turn (single user message) un-mutes as plan and deletes the marker", () => {
    const messages = [{ role: "user", content: "hello" }] as any
    const options: Record<string, any> = { reasoningEffort: "none" }
    const result = applyAdaptiveReasoning(messages, options)
    expect(result).toBe("plan")
    expect(options.reasoningEffort).toBeUndefined()
  })

  test("user follow-up mid-session (history ending in a user message) is a plan step", () => {
    const messages = [
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second" },
    ] as any
    const options: Record<string, any> = { reasoningEffort: "none" }
    const result = applyAdaptiveReasoning(messages, options)
    expect(result).toBe("plan")
    expect(options.reasoningEffort).toBeUndefined()
  })

  test("ordinary mid-session step (trailing bash result passes) leaves the marker untouched", () => {
    const messages = [
      { role: "user", content: "run tests" },
      { role: "assistant", content: "running" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "1",
            toolName: "bash",
            output: { type: "text", value: "Tests: 30 passed, 30 total" },
          },
        ],
      },
    ] as any
    const options: Record<string, any> = { reasoningEffort: "none" }
    const result = applyAdaptiveReasoning(messages, options)
    expect(result).toBeUndefined()
    expect(options.reasoningEffort).toBe("none")
  })

  test("trailing bash result with a failure count un-mutes as recovery", () => {
    const messages = [
      { role: "user", content: "run tests" },
      { role: "assistant", content: "running" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "1",
            toolName: "bash",
            output: { type: "text", value: "Tests: 1 failed, 29 passed" },
          },
        ],
      },
    ] as any
    const options: Record<string, any> = { reasoningEffort: "none" }
    const result = applyAdaptiveReasoning(messages, options)
    expect(result).toBe("recovery")
    expect(options.reasoningEffort).toBeUndefined()
  })

  test("trailing bash result containing the jest ✕ marker un-mutes as recovery", () => {
    const messages = [
      { role: "user", content: "run tests" },
      { role: "assistant", content: "running" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "1",
            toolName: "bash",
            output: { type: "text", value: "✕ should add two numbers" },
          },
        ],
      },
    ] as any
    const options: Record<string, any> = { reasoningEffort: "none" }
    const result = applyAdaptiveReasoning(messages, options)
    expect(result).toBe("recovery")
  })

  test("trailing bash result containing 'suite failed to run' un-mutes as recovery", () => {
    const messages = [
      { role: "user", content: "run tests" },
      { role: "assistant", content: "running" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "1",
            toolName: "bash",
            output: { type: "text", value: "suite failed to run" },
          },
        ],
      },
    ] as any
    const options: Record<string, any> = { reasoningEffort: "none" }
    const result = applyAdaptiveReasoning(messages, options)
    expect(result).toBe("recovery")
  })

  test("error-text output shape on bash is a failure outright", () => {
    const messages = [
      { role: "user", content: "run tests" },
      { role: "assistant", content: "running" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "1",
            toolName: "bash",
            output: { type: "error-text", value: "command not found" },
          },
        ],
      },
    ] as any
    const options: Record<string, any> = { reasoningEffort: "none" }
    const result = applyAdaptiveReasoning(messages, options)
    expect(result).toBe("recovery")
    expect(options.reasoningEffort).toBeUndefined()
  })

  test("failure-looking text in a non-bash tool result does not trip the gate", () => {
    const messages = [
      { role: "user", content: "read a file" },
      { role: "assistant", content: "reading" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "1",
            toolName: "read",
            output: { type: "text", value: "Error: something FAIL 1 failed" },
          },
        ],
      },
    ] as any
    const options: Record<string, any> = { reasoningEffort: "none" }
    const result = applyAdaptiveReasoning(messages, options)
    expect(result).toBeUndefined()
    expect(options.reasoningEffort).toBe("none")
  })

  test("an older bash failure outside the trailing tool block does not trip the gate", () => {
    const messages = [
      { role: "user", content: "run tests" },
      { role: "assistant", content: "running" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "1",
            toolName: "bash",
            output: { type: "text", value: "Tests: 1 failed, 29 passed" },
          },
        ],
      },
      { role: "assistant", content: "let me fix that and re-run" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "2",
            toolName: "bash",
            output: { type: "text", value: "Tests: 30 passed, 30 total" },
          },
        ],
      },
    ] as any
    const options: Record<string, any> = { reasoningEffort: "none" }
    const result = applyAdaptiveReasoning(messages, options)
    expect(result).toBeUndefined()
    expect(options.reasoningEffort).toBe("none")
  })

  test("reasoningEffort 'low' passes through untouched regardless of message shape", () => {
    const shapes = [
      [{ role: "user", content: "hi" }],
      [
        { role: "user", content: "run" },
        { role: "assistant", content: "ok" },
        {
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: "1", toolName: "bash", output: { type: "text", value: "FAIL" } },
          ],
        },
      ],
    ]
    for (const messages of shapes) {
      const options: Record<string, any> = { reasoningEffort: "low" }
      const result = applyAdaptiveReasoning(messages as any, options)
      expect(result).toBeUndefined()
      expect(options.reasoningEffort).toBe("low")
    }
  })

  test("reasoningEffort 'high' passes through untouched regardless of message shape", () => {
    const shapes = [
      [{ role: "user", content: "hi" }],
      [
        { role: "user", content: "run" },
        { role: "assistant", content: "ok" },
        {
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: "1", toolName: "bash", output: { type: "text", value: "FAIL" } },
          ],
        },
      ],
    ]
    for (const messages of shapes) {
      const options: Record<string, any> = { reasoningEffort: "high" }
      const result = applyAdaptiveReasoning(messages as any, options)
      expect(result).toBeUndefined()
      expect(options.reasoningEffort).toBe("high")
    }
  })

  test("reasoningEffort absent passes through untouched regardless of message shape", () => {
    const shapes = [
      [{ role: "user", content: "hi" }],
      [
        { role: "user", content: "run" },
        { role: "assistant", content: "ok" },
        {
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: "1", toolName: "bash", output: { type: "text", value: "FAIL" } },
          ],
        },
      ],
    ]
    for (const messages of shapes) {
      const options: Record<string, any> = {}
      const result = applyAdaptiveReasoning(messages as any, options)
      expect(result).toBeUndefined()
      expect(options.reasoningEffort).toBeUndefined()
    }
  })

  test("errored edit (oldString not in file) un-mutes as contradiction", () => {
    const messages = [
      { role: "user", content: "fix the bug" },
      { role: "assistant", content: "editing" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "1",
            toolName: "edit",
            output: {
              type: "error-text",
              value: "Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.",
            },
          },
        ],
      },
    ] as any
    const options: Record<string, any> = { reasoningEffort: "none" }
    const result = applyAdaptiveReasoning(messages, options)
    expect(result).toBe("contradiction")
    expect(options.reasoningEffort).toBeUndefined()
  })

  test("errored read (file not found) un-mutes as contradiction", () => {
    const messages = [
      { role: "user", content: "fix the bug" },
      { role: "assistant", content: "reading" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "1",
            toolName: "read",
            output: { type: "error-text", value: "File not found: /repo/src/missing.ts" },
          },
        ],
      },
    ] as any
    const options: Record<string, any> = { reasoningEffort: "none" }
    const result = applyAdaptiveReasoning(messages, options)
    expect(result).toBe("contradiction")
    expect(options.reasoningEffort).toBeUndefined()
  })

  test("empty search results ('[]' / 'No files found') un-mute as contradiction", () => {
    for (const [toolName, value] of [
      ["search", "[]"],
      ["search", ""],
      ["grep", "No files found"],
      ["glob", 'No files found for "**/settings.py" (also tried "**/*settings*")'],
    ] as const) {
      const messages = [
        { role: "user", content: "fix the bug" },
        { role: "assistant", content: "searching" },
        {
          role: "tool",
          content: [{ type: "tool-result", toolCallId: "1", toolName, output: { type: "text", value } }],
        },
      ] as any
      const options: Record<string, any> = { reasoningEffort: "none" }
      const result = applyAdaptiveReasoning(messages, options)
      expect(result).toBe("contradiction")
      expect(options.reasoningEffort).toBeUndefined()
    }
  })

  test("a search that found something leaves the marker untouched", () => {
    const messages = [
      { role: "user", content: "fix the bug" },
      { role: "assistant", content: "searching" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "1",
            toolName: "search",
            output: { type: "text", value: '[{"key":"timesince","file":"django/utils/timesince.py"}]' },
          },
        ],
      },
    ] as any
    const options: Record<string, any> = { reasoningEffort: "none" }
    const result = applyAdaptiveReasoning(messages, options)
    expect(result).toBeUndefined()
    expect(options.reasoningEffort).toBe("none")
  })

  test("bash failure outranks a contradiction in the same trailing block", () => {
    const messages = [
      { role: "user", content: "fix the bug" },
      { role: "assistant", content: "working" },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "1", toolName: "grep", output: { type: "text", value: "No files found" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "2",
            toolName: "bash",
            output: { type: "text", value: "Tests: 1 failed, 29 passed" },
          },
        ],
      },
    ] as any
    const options: Record<string, any> = { reasoningEffort: "none" }
    const result = applyAdaptiveReasoning(messages, options)
    expect(result).toBe("recovery")
  })

  test("an older contradiction outside the trailing tool block does not trip the gate", () => {
    const messages = [
      { role: "user", content: "fix the bug" },
      { role: "assistant", content: "searching" },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "1", toolName: "search", output: { type: "text", value: "[]" } },
        ],
      },
      { role: "assistant", content: "broadening the search" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "2",
            toolName: "search",
            output: { type: "text", value: '[{"key":"found_it"}]' },
          },
        ],
      },
    ] as any
    const options: Record<string, any> = { reasoningEffort: "none" }
    const result = applyAdaptiveReasoning(messages, options)
    expect(result).toBeUndefined()
    expect(options.reasoningEffort).toBe("none")
  })

  test("content-array output shape with a FAIL banner un-mutes as recovery", () => {
    const messages = [
      { role: "user", content: "run tests" },
      { role: "assistant", content: "running" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "1",
            toolName: "bash",
            output: { type: "content", value: [{ type: "text", text: "FAIL src/x.test.js" }] },
          },
        ],
      },
    ] as any
    const options: Record<string, any> = { reasoningEffort: "none" }
    const result = applyAdaptiveReasoning(messages, options)
    expect(result).toBe("recovery")
    expect(options.reasoningEffort).toBeUndefined()
  })
})
