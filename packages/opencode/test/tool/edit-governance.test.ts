/**
 * S6.3 in-loop governance gate — callersAtRiskWarning unit tests.
 *
 * Reuses the ol79-coupling fixture (centralHub: a 12-caller hub, well above
 * RSK_CALLER_THRESHOLD = 10) already indexed for probeTurnRisk/probeSliceCoupling,
 * so a signature change to centralHub is guaranteed to clear the chokepoint
 * threshold and surface a callers-at-risk warning.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { join } from "node:path"
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { execSync } from "node:child_process"
import { BunSqliteGraph } from "@opencode-ai/code-intelligence"
import type { EditImpactGraph } from "@opencode-ai/code-intelligence"
import { callersAtRiskWarning } from "../../src/tool/edit-governance"
import { RSK_CALLER_THRESHOLD } from "../../src/tool/graph-tools-enrich"

const COUPLING_FIXTURE = join(import.meta.dir, "fixtures/ol79-coupling")
const HUB_FILE = join(COUPLING_FIXTURE, "hub.ts")

describe("S6.3 — callersAtRiskWarning", () => {
  let graph: BunSqliteGraph
  let hubSource: string

  beforeAll(async () => {
    graph = new BunSqliteGraph(":memory:", COUPLING_FIXTURE)
    await graph.index(COUPLING_FIXTURE)
    hubSource = readFileSync(HUB_FILE, "utf8")
  })

  afterAll(() => {
    graph.close()
  })

  it("a signature change to the 12-caller hub yields a warning listing callers", async () => {
    const changedSource = hubSource.replace(
      "export function centralHub(): number {",
      "export function centralHub(x: number): number {",
    )
    const warning = await callersAtRiskWarning("hub.ts", hubSource, changedSource, graph)
    expect(warning).not.toBeNull()
    expect(warning).toContain("centralHub")
    // At least the 12 direct callers clear RSK_CALLER_THRESHOLD (import + call
    // edges may inflate the raw graph count further, so assert the floor).
    const match = warning!.match(/(\d+) caller\(s\) to update/)
    expect(match).not.toBeNull()
    expect(Number(match![1])).toBeGreaterThanOrEqual(RSK_CALLER_THRESHOLD)
    // At least one caller site is listed as file:entity.
    expect(warning).toMatch(/caller\d+\.ts/)
  })

  it("a body-only edit (signature unchanged) yields no warning", async () => {
    const changedSource = hubSource.replace("return 1", "return 42")
    const warning = await callersAtRiskWarning("hub.ts", hubSource, changedSource, graph)
    expect(warning).toBeNull()
  })

  it("the isolated leaf's signature change stays silent (fan-in below threshold)", async () => {
    const leafSource = readFileSync(join(COUPLING_FIXTURE, "leaf.ts"), "utf8")
    const changedSource = leafSource.replace(
      "export function isolatedLeaf(): number {",
      "export function isolatedLeaf(x: number): number {",
    )
    const warning = await callersAtRiskWarning("leaf.ts", leafSource, changedSource, graph)
    expect(warning).toBeNull()
  })

  it("defensive: a throwing graph applies the edit cleanly (returns null, never throws)", async () => {
    const throwingGraph: EditImpactGraph = {
      getEntitiesInFile: async () => {
        throw new Error("graph unavailable")
      },
      getCallers: async () => {
        throw new Error("graph unavailable")
      },
    }
    const changedSource = hubSource.replace(
      "export function centralHub(): number {",
      "export function centralHub(x: number): number {",
    )
    await expect(
      callersAtRiskWarning("hub.ts", hubSource, changedSource, throwingGraph),
    ).resolves.toBeNull()
  })

  it("defensive: a cold/hanging graph is bounded by the graph budget and resolves null", async () => {
    const hangingGraph: EditImpactGraph = {
      getEntitiesInFile: () => new Promise(() => {}), // never resolves
      getCallers: async () => [],
    }
    const changedSource = hubSource.replace(
      "export function centralHub(): number {",
      "export function centralHub(x: number): number {",
    )
    const warning = await callersAtRiskWarning("hub.ts", hubSource, changedSource, hangingGraph)
    expect(warning).toBeNull()
  })

  it("RSK_CALLER_THRESHOLD stays the single source of truth for the chokepoint cutoff", () => {
    expect(RSK_CALLER_THRESHOLD).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// B3 — no-test-edit gate: path classifier, per-session arm/disarm, denial text
// ---------------------------------------------------------------------------

import {
  isTestFilePath,
  setTestEditGate,
  testEditGateArmed,
  testEditDenialMessage,
  setNoEditsGate,
  noEditsGateArmed,
  noEditsDenialMessage,
} from "../../src/tool/edit-governance"

describe("B3 — isTestFilePath", () => {
  it("matches test trees, suffixes, and python conventions", () => {
    for (const p of [
      "tests/test_utils.py",
      "django/contrib/tests/models.py",
      "src/__tests__/router.tsx",
      "spec/parser_spec_helper/deep.rb",
      "src/session/prompt.test.ts",
      "lib/response.spec.js",
      "pkg/server_test.go",
      "test_settings.py",
      "app/tests.py",
    ]) {
      expect(isTestFilePath(p)).toBe(true)
    }
  })

  it("does not match source files that merely mention test-ish words", () => {
    for (const p of [
      "src/session/prompt.ts",
      "src/testing-utils.ts", // no tests/ dir, no .test. suffix
      "django/test/client.py", // framework's own test MODULE is source, but tests?/ dir matches — see below
      "docs/latest/spec.md",
      "src/contest.py",
      "attestation/verify.ts",
    ]) {
      if (p === "django/test/client.py") continue // covered in the tradeoff test below
      expect(isTestFilePath(p)).toBe(false)
    }
  })

  it("accepts the known tradeoff: a framework's own test/ source dir classifies as test tree", () => {
    // django/test/client.py is framework SOURCE. The gate denies its edit only
    // on fix-shaped turns, and the denial message tells the model to surface
    // the disagreement — an acceptable false-positive rate for the protection.
    expect(isTestFilePath("django/test/client.py")).toBe(true)
  })

  it("normalizes windows separators", () => {
    expect(isTestFilePath("src\\__tests__\\router.tsx")).toBe(true)
  })
})

describe("B3 — test-edit gate store", () => {
  it("arms, consults, and disarms per session", () => {
    setTestEditGate("ses_b3_a", true)
    setTestEditGate("ses_b3_b", false)
    expect(testEditGateArmed("ses_b3_a")).toBe(true)
    expect(testEditGateArmed("ses_b3_b")).toBe(false)
    expect(testEditGateArmed("ses_b3_never_set")).toBe(false)
    setTestEditGate("ses_b3_a", false) // re-arm cycle: next non-fix turn disarms
    expect(testEditGateArmed("ses_b3_a")).toBe(false)
  })
})

describe("B3 — testEditDenialMessage", () => {
  it("names the file, the rule, and both legitimate outs", () => {
    const msg = testEditDenialMessage("tests/test_utils.py")
    expect(msg).toContain("tests/test_utils.py")
    expect(msg).toContain("no-test-edit gate")
    expect(msg).toContain("NEW test file")
    expect(msg).toContain("do not edit it")
    expect(msg).toContain("repro_issue.py")
  })
})

describe("P3 — no-edits gate store + denial message", () => {
  it("arms, consults, and disarms per session — same lifecycle as the test-edit gate", () => {
    setNoEditsGate("ses_ne_a", true)
    setNoEditsGate("ses_ne_b", false)
    expect(noEditsGateArmed("ses_ne_a")).toBe(true)
    expect(noEditsGateArmed("ses_ne_b")).toBe(false)
    expect(noEditsGateArmed("ses_ne_never_set")).toBe(false)
    setNoEditsGate("ses_ne_a", false) // continuation/next fresh turn disarms
    expect(noEditsGateArmed("ses_ne_a")).toBe(false)
  })

  it("the denial message names the file, the plan-only rule, and the text-deliverable out", () => {
    const msg = noEditsDenialMessage("src/billing/api.ts")
    expect(msg).toContain("src/billing/api.ts")
    expect(msg).toContain("no-edits gate")
    expect(msg).toContain("plan")
    expect(msg).toContain("as text")
  })
})

// ---------------------------------------------------------------------------
// P11c — raw-task-child gate: a per-child-session CATEGORY (armed once at
// spawn in tool/task.ts, never per-turn), plus its denial message.
// ---------------------------------------------------------------------------

import {
  setRawTaskChildGate,
  rawTaskChildGateArmed,
  clearRawTaskChildGate,
  rawTaskChildDenialMessage,
} from "../../src/tool/edit-governance"

describe("P11c — raw-task-child gate store + denial message", () => {
  it("arms per child session at spawn and stays armed (a category, not a per-turn toggle)", () => {
    setRawTaskChildGate("ses_rtc_a")
    expect(rawTaskChildGateArmed("ses_rtc_a")).toBe(true)
    expect(rawTaskChildGateArmed("ses_rtc_parent")).toBe(false)
    expect(rawTaskChildGateArmed("ses_rtc_never_set")).toBe(false)
    // Test seam only — production never clears a child out of the category.
    clearRawTaskChildGate("ses_rtc_a")
    expect(rawTaskChildGateArmed("ses_rtc_a")).toBe(false)
  })

  it("the denial message names the file, the read-only lane, and the report-it-instead out", () => {
    const msg = rawTaskChildDenialMessage("src/session/prompt.ts")
    expect(msg).toContain("src/session/prompt.ts")
    expect(msg).toContain("raw task-tool child")
    expect(msg).toContain("read-only")
    expect(msg).toContain("digest")
  })
})

// ---------------------------------------------------------------------------
// OL-7.9 — the always-on structural test-edit gate: snapshotTestTree,
// detectTestEdit, and the single evaluateTestEditGate decision point.
// ---------------------------------------------------------------------------

import {
  snapshotTestTree,
  detectTestEdit,
  evaluateTestEditGate,
  type TestTreeSnapshot,
} from "../../src/tool/edit-governance"

function withTmpGitRepo(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "eg-structural-"))
  try {
    execSync("git init -q", { cwd: dir })
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("OL-7.9 — snapshotTestTree", () => {
  it("resolves to an empty snapshot outside a git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "eg-nogit-"))
    try {
      expect(snapshotTestTree(dir).hashes).toEqual({})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("hashes tracked test files and ignores tracked source files", () => {
    withTmpGitRepo((dir) => {
      writeFileSync(join(dir, "app.ts"), "export const a = 1\n")
      writeFileSync(join(dir, "app.test.ts"), "test('a', () => {})\n")
      execSync("git add -A", { cwd: dir })
      const snap = snapshotTestTree(dir)
      expect(Object.keys(snap.hashes)).toEqual(["app.test.ts"])
    })
  })
})

describe("OL-7.9 — detectTestEdit", () => {
  it("reports a MODIFIED tracked test file, not a brand-new one (matches --diff-filter=M)", () => {
    withTmpGitRepo((dir) => {
      writeFileSync(join(dir, "app.test.ts"), "test('a', () => {})\n")
      execSync("git add -A", { cwd: dir })
      const before = snapshotTestTree(dir)

      writeFileSync(join(dir, "app.test.ts"), "test('a', () => { /* changed */ })\n")
      writeFileSync(join(dir, "repro.test.ts"), "test('new', () => {})\n")
      execSync("git add -A", { cwd: dir })
      const after = snapshotTestTree(dir)

      expect(detectTestEdit(before, after)).toEqual(["app.test.ts"])
    })
  })

  it("reports nothing when no tracked test file's content changed", () => {
    const before: TestTreeSnapshot = { hashes: { "a.test.ts": "h1" } }
    const after: TestTreeSnapshot = { hashes: { "a.test.ts": "h1" } }
    expect(detectTestEdit(before, after)).toEqual([])
  })

  it("ignores a file only present in `before` (a deletion, not a modification)", () => {
    const before: TestTreeSnapshot = { hashes: { "a.test.ts": "h1" } }
    const after: TestTreeSnapshot = { hashes: {} }
    expect(detectTestEdit(before, after)).toEqual([])
  })
})

describe("OL-7.9 — evaluateTestEditGate (the single gate: structural + policy)", () => {
  const unchanged: TestTreeSnapshot = { hashes: { "a.test.ts": "h1" } }
  const changed: TestTreeSnapshot = { hashes: { "a.test.ts": "h2" } }

  it("no structural test edit → allow, regardless of armed or redToGreen", () => {
    setTestEditGate("ses_gate_a", true)
    const result = evaluateTestEditGate({
      sessionID: "ses_gate_a",
      before: unchanged,
      after: unchanged,
      redToGreen: true,
    })
    expect(result).toEqual({ action: "allow" })
  })

  it("structural test edit on an armed (fix-shaped) session → hard deny", () => {
    setTestEditGate("ses_gate_b", true)
    const result = evaluateTestEditGate({
      sessionID: "ses_gate_b",
      before: unchanged,
      after: changed,
      redToGreen: false,
    })
    expect(result.action).toBe("deny")
    if (result.action === "deny") {
      expect(result.file).toBe("a.test.ts")
      expect(result.message).toContain("a.test.ts")
    }
  })

  it("structural test edit + red→green on an unarmed session → StuckSignal, not a block", () => {
    setTestEditGate("ses_gate_c", false)
    const result = evaluateTestEditGate({
      sessionID: "ses_gate_c",
      before: unchanged,
      after: changed,
      redToGreen: true,
    })
    expect(result).toEqual({
      action: "stuck",
      signal: { reason: "test-edit", signature: "a.test.ts", count: 1 },
    })
  })

  it("structural test edit without red→green on an unarmed session → allow (not a blanket ban)", () => {
    setTestEditGate("ses_gate_d", false)
    const result = evaluateTestEditGate({
      sessionID: "ses_gate_d",
      before: unchanged,
      after: changed,
      redToGreen: false,
    })
    expect(result).toEqual({ action: "allow" })
  })
})

// ---------------------------------------------------------------------------
// Wave 5 — hub-edit bounce gate: arm/disarm store, denial message, and the
// evaluateHubEditGate decision point (armed + over-threshold denies once — an
// identical retry on that same file passes; a test file, an under-threshold
// file, an unarmed session, and a cold/hanging or throwing graph all allow).
// ---------------------------------------------------------------------------

import {
  setHubEditGate,
  hubEditGateArmed,
  hubEditDenialMessage,
  evaluateHubEditGate,
  type HubFanInGraph,
} from "../../src/tool/edit-governance"

describe("Wave 5 — hub-edit gate store", () => {
  it("arms, consults, and disarms per session", () => {
    setHubEditGate("ses_hub_a", true)
    setHubEditGate("ses_hub_b", false)
    expect(hubEditGateArmed("ses_hub_a")).toBe(true)
    expect(hubEditGateArmed("ses_hub_b")).toBe(false)
    expect(hubEditGateArmed("ses_hub_never_set")).toBe(false)
  })
})

describe("Wave 5 — hubEditDenialMessage", () => {
  it("names the file, the importer count, and the root-most-layer redirect", () => {
    const msg = hubEditDenialMessage("django/db/models/base.py", 42)
    expect(msg).toContain("django/db/models/base.py")
    expect(msg).toContain("42")
    expect(msg).toContain("root-most layer")
    expect(msg).toContain("re-issue this exact edit")
  })
})

describe("Wave 5 — evaluateHubEditGate", () => {
  const overThresholdGraph: HubFanInGraph = { fileFanIn: () => 5 }
  const underThresholdGraph: HubFanInGraph = { fileFanIn: () => 1 }
  const hangingGraph: HubFanInGraph = { fileFanIn: () => new Promise(() => {}) }

  it("unarmed session → allow, even over threshold", async () => {
    setHubEditGate("ses_hub_unarmed", false)
    const result = await evaluateHubEditGate({
      sessionID: "ses_hub_unarmed",
      filePath: "hub.py",
      graph: overThresholdGraph,
    })
    expect(result).toEqual({ action: "allow" })
  })

  it("a test file allows even over threshold", async () => {
    setHubEditGate("ses_hub_test", true)
    const result = await evaluateHubEditGate({
      sessionID: "ses_hub_test",
      filePath: "tests/test_hub.py",
      graph: overThresholdGraph,
    })
    expect(result).toEqual({ action: "allow" })
  })

  it("an under-threshold file allows", async () => {
    setHubEditGate("ses_hub_under", true)
    const result = await evaluateHubEditGate({
      sessionID: "ses_hub_under",
      filePath: "leaf.py",
      graph: underThresholdGraph,
    })
    expect(result).toEqual({ action: "allow" })
  })

  it("first edit to an over-threshold file denies with the message; an identical retry passes", async () => {
    setHubEditGate("ses_hub_bounce", true)
    const first = await evaluateHubEditGate({
      sessionID: "ses_hub_bounce",
      filePath: "hub.py",
      graph: overThresholdGraph,
    })
    expect(first.action).toBe("deny")
    if (first.action === "deny") {
      expect(first.importers).toBe(5)
      expect(first.message).toContain("hub.py")
    }

    const retry = await evaluateHubEditGate({
      sessionID: "ses_hub_bounce",
      filePath: "hub.py",
      graph: overThresholdGraph,
    })
    expect(retry).toEqual({ action: "allow" })
  })

  it("a different over-threshold file on the same session still bounces once", async () => {
    setHubEditGate("ses_hub_bounce2", true)
    const first = await evaluateHubEditGate({
      sessionID: "ses_hub_bounce2",
      filePath: "hub_a.py",
      graph: overThresholdGraph,
    })
    expect(first.action).toBe("deny")
    const second = await evaluateHubEditGate({
      sessionID: "ses_hub_bounce2",
      filePath: "hub_b.py",
      graph: overThresholdGraph,
    })
    expect(second.action).toBe("deny")
  })

  it("defensive: a cold/hanging graph is bounded by the budget and resolves allow", async () => {
    setHubEditGate("ses_hub_hang", true)
    const result = await evaluateHubEditGate({
      sessionID: "ses_hub_hang",
      filePath: "hub.py",
      graph: hangingGraph,
    })
    expect(result).toEqual({ action: "allow" })
  })

  it("defensive: a throwing graph allows (fail-open, never throws)", async () => {
    setHubEditGate("ses_hub_throw", true)
    const throwingGraph: HubFanInGraph = {
      fileFanIn: () => {
        throw new Error("graph unavailable")
      },
    }
    await expect(
      evaluateHubEditGate({ sessionID: "ses_hub_throw", filePath: "hub.py", graph: throwingGraph }),
    ).resolves.toEqual({ action: "allow" })
  })
})
