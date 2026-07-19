import { describe, test, expect } from "bun:test"
import {
  extractDeliverables,
  checkDeliverableCoverage,
  shouldDenyDeliverableFinish,
  hasDeniedDeliverableFinish,
  markDeliverableFinishDenied,
  type DeliverableItem,
} from "../../src/session/deliverable-checklist"
import type { EvidenceItem } from "../../../code-intelligence/src/claim-evidence"

describe("extractDeliverables — file/artifact shapes", () => {
  test("extracts a backtick-quoted file path", () => {
    const items = extractDeliverables("Build the binary and make sure `/usr/local/bin/pmars` exists.")
    expect(items).toContainEqual({ id: "/usr/local/bin/pmars", kind: "file" })
  })

  test("extracts a bare (unquoted) path-shaped artifact", () => {
    const items = extractDeliverables("Install the artifact at dist/bin/app so it can run.")
    expect(items.some((i) => i.kind === "file" && i.id === "dist/bin/app")).toBe(true)
  })

  test("folds in turn-read goal quote/deliverable text", () => {
    const items = extractDeliverables("", [
      { quote: "build the pmars binary", deliverable: "binary at `/opt/app/server` installed" },
    ])
    expect(items).toContainEqual({ id: "/opt/app/server", kind: "file" })
  })

  test("excludes URL path segments from file extraction", () => {
    const items = extractDeliverables("See https://example.com/docs/reference for details.")
    expect(items.some((i) => i.kind === "file")).toBe(false)
  })

  test("returns empty when the instruction names no deliverables", () => {
    expect(extractDeliverables("This is a plain question with no artifacts or commands.")).toEqual([])
  })

  test("caps file deliverables at the extraction limit", () => {
    const instruction = Array.from({ length: 10 }, (_, i) => `\`build/output_${i}.bin\``).join(" and ")
    const items = extractDeliverables(instruction)
    expect(items.filter((i) => i.kind === "file").length).toBeLessThanOrEqual(6)
  })
})

describe("extractDeliverables — check-command shapes", () => {
  test("extracts a 'run X to verify' check command", () => {
    const items = extractDeliverables("Run `make test` to verify the build succeeded.")
    expect(items).toContainEqual({ id: "check:make test", kind: "command" })
  })

  test("extracts a 'verify with X' check command", () => {
    const items = extractDeliverables("Verify with `./scripts/check.sh` that the service is healthy.")
    expect(items).toContainEqual({ id: "check:./scripts/check.sh", kind: "command" })
  })

  test("a path named as a check command is a command, never also a duplicate file entry", () => {
    const items = extractDeliverables("Run `./scripts/build.sh` to verify the artifact.")
    expect(items).toContainEqual({ id: "check:./scripts/build.sh", kind: "command" })
    expect(items.some((i) => i.kind === "file" && i.id === "./scripts/build.sh")).toBe(false)
  })
})

describe("checkDeliverableCoverage", () => {
  const items: DeliverableItem[] = [
    { id: "dist/app", kind: "file" },
    { id: "check:make test", kind: "command" },
  ]

  test("covers when every deliverable's evidence passes", () => {
    const results = new Map<string, EvidenceItem["verdict"]>([
      ["dist/app", "pass"],
      ["check:make test", "pass"],
    ])
    const verdict = checkDeliverableCoverage(items, results)
    expect(verdict.covered).toBe(true)
    expect(verdict.missing).toEqual([])
  })

  test("does not cover when a file is missing", () => {
    const results = new Map<string, EvidenceItem["verdict"]>([
      ["dist/app", "fail"],
      ["check:make test", "pass"],
    ])
    const verdict = checkDeliverableCoverage(items, results)
    expect(verdict.covered).toBe(false)
    expect(verdict.failing).toContain("dist/app")
  })

  test("does not cover when a check command never got a result (unverified like absent, never a silent pass)", () => {
    const results = new Map<string, EvidenceItem["verdict"]>([["dist/app", "pass"]])
    const verdict = checkDeliverableCoverage(items, results)
    expect(verdict.covered).toBe(false)
    expect(verdict.missing).toContain("check:make test")
  })

  test("trivially covers when nothing was extracted (nothing claimed)", () => {
    expect(checkDeliverableCoverage([], new Map()).covered).toBe(true)
  })
})

describe("shouldDenyDeliverableFinish — deny-once-then-fail-open-loud", () => {
  const base = { isChildSession: false, opsShaped: true, covered: false, alreadyDenied: false }

  test("denies once: ops-shaped, uncovered, not yet denied", () => {
    expect(shouldDenyDeliverableFinish(base)).toBe(true)
  })

  test("never denies a second time once already denied (fail-open, not a wedge)", () => {
    expect(shouldDenyDeliverableFinish({ ...base, alreadyDenied: true })).toBe(false)
  })

  test("never denies a non-ops-shaped turn", () => {
    expect(shouldDenyDeliverableFinish({ ...base, opsShaped: false })).toBe(false)
  })

  test("never denies a child session", () => {
    expect(shouldDenyDeliverableFinish({ ...base, isChildSession: true })).toBe(false)
  })

  test("never denies when the checklist already covers", () => {
    expect(shouldDenyDeliverableFinish({ ...base, covered: true })).toBe(false)
  })
})

describe("deliverable-finish once-deny store", () => {
  test("tracks the one-deny flag per session id", () => {
    const sessionID = `test-session-${Date.now()}-${Math.random()}`
    expect(hasDeniedDeliverableFinish(sessionID)).toBe(false)
    markDeliverableFinishDenied(sessionID)
    expect(hasDeniedDeliverableFinish(sessionID)).toBe(true)
  })
})
