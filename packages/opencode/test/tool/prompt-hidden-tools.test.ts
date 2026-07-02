/**
 * Guard: no product system prompt (.txt) may name a hidden tool id as a tool reference.
 *
 * HIDDEN_FROM_MODEL tools are intentionally de-registered from the model's
 * advertised tool list.  Naming them in a prompt creates a tool↔prompt
 * coupling where the model is instructed to call a tool it cannot see.
 *
 * This test loads every .txt file under src/session/prompt/ and asserts that
 * none of them contains a tool id from HIDDEN_FROM_MODEL as a word-boundary token.
 */

import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import { HIDDEN_FROM_MODEL } from "@/tool/registry"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PROMPT_DIR = path.resolve(__dirname, "../../src/session/prompt")
const TOOL_DIR = path.resolve(__dirname, "../../src/tool")

describe("prompt hidden-tools guard", () => {
  // The model sees two sources of tool prose: the system prompts (session/prompt/*.txt) and the
  // per-tool descriptions sent in the API `tools` field (src/tool/<id>.txt). Both must avoid naming a
  // hidden tool. A hidden tool's OWN description file (e.g. grep.txt) is excluded — it is never sent
  // to the model (the tool isn't advertised) and legitimately contains its own id.
  test("no prompt or tool-description file references a hidden tool id as a word-boundary token", async () => {
    const hiddenIds = [...HIDDEN_FROM_MODEL]

    const promptEntries = await fs.readdir(PROMPT_DIR)
    const promptFiles = promptEntries
      .filter((f) => f.endsWith(".txt"))
      .map((f) => ({ dir: PROMPT_DIR, file: f }))

    const toolEntries = await fs.readdir(TOOL_DIR)
    const toolFiles = toolEntries
      .filter((f) => f.endsWith(".txt") && !hiddenIds.includes(f.replace(/\.txt$/, "")))
      .map((f) => ({ dir: TOOL_DIR, file: f }))

    expect(promptFiles.length).toBeGreaterThan(0) // sanity: prompt dir must have .txt files
    expect(toolFiles.length).toBeGreaterThan(0) // sanity: tool dir must have advertised .txt files

    const violations: string[] = []

    for (const { dir, file } of [...promptFiles, ...toolFiles]) {
      const content = await fs.readFile(path.join(dir, file), "utf-8")
      for (const id of hiddenIds) {
        // Word-boundary pattern: matches the tool id as a standalone token.
        // Handles both plain (webfetch) and backtick-wrapped (`webfetch`) forms.
        const pattern = new RegExp(`\\b${id}\\b`)
        if (pattern.test(content)) {
          violations.push(`${file} references hidden tool "${id}"`)
        }
      }
    }

    expect(violations, violations.join(", ")).toEqual([])
  })
})
