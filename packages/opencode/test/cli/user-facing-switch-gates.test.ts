import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import path from "path"

/**
 * Guardrail: no USER-FACING model/agent switch entry point may reappear.
 *
 * The tier-router is the only thing allowed to pick a model/agent, and it is
 * internal (not exposed as a CLI flag, TUI command/keybind, or composer
 * control). If any of these assertions fail, a regression re-introduced a
 * user-facing switch surface — fix the regression, do not weaken this test.
 *
 * `variant.*` / `variant_*` (model-variant, i.e. thinking/effort) is
 * INTENTIONALLY KEPT and must never be asserted against here.
 */

function readSource(relPath: string): string {
  const fullPath = path.join(import.meta.dir, relPath)
  // Let readFileSync throw if the file moved — a loud failure beats a
  // silently-passing guardrail.
  return readFileSync(fullPath, "utf8")
}

describe("user-facing model/agent switch gates", () => {
  test("run.ts declares no --model / --agent CLI option", () => {
    const src = readSource("../../src/cli/cmd/run.ts")
    expect(src).not.toMatch(/\.option\(\s*["']model["']/)
    expect(src).not.toMatch(/\.option\(\s*["']agent["']/)
  })

  test("tui.ts declares no --model / --agent CLI option", () => {
    const src = readSource("../../src/cli/cmd/tui.ts")
    expect(src).not.toMatch(/\.option\(\s*["']model["']/)
    expect(src).not.toMatch(/\.option\(\s*["']agent["']/)
  })

  test("agent.ts declares no --model / --agent CLI option", () => {
    const src = readSource("../../src/cli/cmd/agent.ts")
    expect(src).not.toMatch(/\.option\(\s*["']model["']/)
    expect(src).not.toMatch(/\.option\(\s*["']agent["']/)
  })

  test("tui app.tsx has no model.list / model.cycle / agent.list / agent.cycle command strings", () => {
    const src = readSource("../../../tui/src/app.tsx")
    expect(src).not.toContain(
      "\"model.list\"",
    )
    expect(src, "app.tsx must not contain a \"model.cycle*\" command string").not.toMatch(/"model\.cycle/)
    expect(src, "app.tsx must not contain an \"agent.list\" command string").not.toContain("\"agent.list\"")
    expect(src, "app.tsx must not contain an \"agent.cycle*\" command string").not.toMatch(/"agent\.cycle/)
  })

  test("keybind.ts has no model_list / model_cycle / agent_list / agent_cycle identifiers", () => {
    const src = readSource("../../../tui/src/config/keybind.ts")
    expect(src, "keybind.ts must not contain a model_list identifier").not.toMatch(/\bmodel_list\b/)
    expect(src, "keybind.ts must not contain a model_cycle* identifier").not.toMatch(/\bmodel_cycle/)
    expect(src, "keybind.ts must not contain an agent_list identifier").not.toMatch(/\bagent_list\b/)
    expect(src, "keybind.ts must not contain an agent_cycle* identifier").not.toMatch(/\bagent_cycle/)
  })

  test("prompt-input.tsx renders no model/agent picker controls", () => {
    const src = readSource("../../../app/src/components/prompt-input.tsx")
    expect(src, "prompt-input.tsx must not render ModelSelectorPopover").not.toContain("ModelSelectorPopover")
    expect(src, "prompt-input.tsx must not render ComposerModelControl").not.toContain("ComposerModelControl")
    expect(src, "prompt-input.tsx must not render ComposerAgentControl").not.toContain("ComposerAgentControl")
  })
})
