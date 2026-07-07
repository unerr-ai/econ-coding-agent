/**
 * Registration test for the `note_save` graph tool (econ graph uplift,
 * task #14). Kept as its own file rather than appended to
 * graph-tools-registration.test.ts, which is under concurrent edit by another
 * task in this same uplift.
 */
import { describe, expect, test } from "bun:test"
import { GraphNoteSaveTool } from "../../src/tool/graph-tools"
import { HIDDEN_FROM_MODEL, CATALOG_TOOL_IDS } from "../../src/tool/registry"

describe("graph tools — note_save registration", () => {
  test("note_save carries the id the registry wires it under", () => {
    expect(GraphNoteSaveTool.id).toBe("note_save")
  })

  test("note_save is catalog-compacted (on-demand) rather than hidden — same treatment as file_outline", () => {
    expect(CATALOG_TOOL_IDS.has(GraphNoteSaveTool.id)).toBe(true)
    expect(HIDDEN_FROM_MODEL.has(GraphNoteSaveTool.id)).toBe(false)
  })
})
