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
  hubEditSecondDenialMessage,
  hubEditBouncedFiles,
  hubEditDefiningFiles,
  evaluateHubEditGate,
  pathsRefer,
  setHubEditIssueText,
  hubEditIssueText,
  hubEditDefiningResolved,
  bandFilterDefiningSites,
  hubEditRetriedAgainstCandidates,
  memoizeHubEditDefiningSites,
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

  it("wave 6: warns against moving the same change to a DIFFERENT shared file", () => {
    const msg = hubEditDenialMessage("django/db/models/base.py", 42)
    expect(msg).toContain("DIFFERENT shared file")
  })

  it("wave 8d: lists the resolved root-most candidates as candidates, not a verdict (round-F post-mortem on django-11815)", () => {
    const msg = hubEditDenialMessage("django/db/models/fields/__init__.py", 26, [
      "django/db/models/enums.py",
      "django/db/models/base.py",
    ])
    expect(msg).toContain("Per the code graph, the symbols this issue names are DEFINED in:")
    expect(msg).toContain("django/db/models/enums.py")
    expect(msg).toContain("django/db/models/base.py")
    expect(msg).toContain("check those candidates first")
    // The graph resolves symbol names, not behavior — the message must not tell
    // the model the candidates ARE the root-most site, only that they're worth
    // checking; a re-issue naming this file as the true fix site is allowed.
    expect(msg).toContain("the graph resolves symbol NAMES, not behavior")
    expect(msg).toContain(
      "if the BEHAVIOR the issue describes is implemented in django/db/models/fields/__init__.py itself",
    )
    expect(msg).toContain("re-issue this exact edit and it will be allowed")
  })

  it("wave 8d: byte-identical to the legacy message when no candidates are given", () => {
    const msg = hubEditDenialMessage("django/db/models/base.py", 42)
    expect(msg).toBe(
      "42 other modules import django/db/models/base.py directly — it is shared infrastructure. " +
        "A behavior fix belongs at the root-most layer: the module that DEFINES the class or function the issue names, not a shared file every consumer flows through. " +
        "Re-check where that behavior is defined and prefer fixing there. " +
        "Moving the same change to a DIFFERENT shared file is not the fix — the defining module is. " +
        "If this hub file genuinely is the root-most layer, re-issue this exact edit and it will be allowed.",
    )
  })
})

describe("round-F §7 — hubEditSecondDenialMessage", () => {
  it("names the file and the resolved defining sites, and states the fail-open floor", () => {
    const msg = hubEditSecondDenialMessage("django/db/models/query_utils.py", ["django/db/models/enums.py"])
    expect(msg).toContain("django/db/models/query_utils.py")
    expect(msg).toContain("django/db/models/enums.py")
    expect(msg).toContain("second time")
    expect(msg).toContain("re-issue this exact edit once more")
  })

  it("frames the defining sites as symbol-definition candidates, not a behavior verdict (round-F post-mortem on django-11815)", () => {
    const msg = hubEditSecondDenialMessage("django/db/models/query_utils.py", ["django/db/models/enums.py"])
    expect(msg).toContain("django/db/models/query_utils.py")
    expect(msg).toContain("django/db/models/enums.py")
    expect(msg).toContain("SYMBOL-definition sites")
    expect(msg).toContain("the graph resolves symbol names, not behavior")
    expect(msg).toContain("If the behavior the issue describes is implemented in django/db/models/query_utils.py itself")
  })
})

describe("Wave 6 — hubEditBouncedFiles", () => {
  it("empty for an unknown/never-bounced session", () => {
    expect(hubEditBouncedFiles("ses_hub_bouncedfiles_unknown")).toEqual([])
  })

  it("lists files after bounces, empty before any", async () => {
    const overThresholdGraph: HubFanInGraph = { fileFanIn: () => 5 }
    setHubEditGate("ses_hub_bouncedfiles", true)
    expect(hubEditBouncedFiles("ses_hub_bouncedfiles")).toEqual([])

    await evaluateHubEditGate({ sessionID: "ses_hub_bouncedfiles", filePath: "hub_a.py", graph: overThresholdGraph })
    expect(hubEditBouncedFiles("ses_hub_bouncedfiles")).toEqual(["hub_a.py"])

    await evaluateHubEditGate({ sessionID: "ses_hub_bouncedfiles", filePath: "hub_b.py", graph: overThresholdGraph })
    expect(hubEditBouncedFiles("ses_hub_bouncedfiles")).toEqual(["hub_a.py", "hub_b.py"])
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
    expect(retry).toEqual({ action: "allow", retried: true })
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

// ---------------------------------------------------------------------------
// Wave 8 — definition-aware gate allowlist: a file the graph reports as the
// defining module for the issue's named symbols is allowed even over the
// fan-in threshold, child sessions inherit the parent's defining-file set,
// and pathsRefer tolerates an absolute-vs-repo-relative path shape mismatch
// without a false match on a partial path segment.
// ---------------------------------------------------------------------------

describe("Wave 8 — evaluateHubEditGate defining-site allowlist", () => {
  const overThresholdGraph: HubFanInGraph = { fileFanIn: () => 5 }

  it("a defining-file edit allows even over threshold", async () => {
    setHubEditGate("ses_hub_defining", true, ["django/contrib/auth/forms.py"])
    const result = await evaluateHubEditGate({
      sessionID: "ses_hub_defining",
      filePath: "/repo/django/contrib/auth/forms.py",
      graph: overThresholdGraph,
    })
    expect(result).toEqual({ action: "allow", definingSite: true })
  })

  it("a non-defining file over threshold still bounces", async () => {
    setHubEditGate("ses_hub_nondefining", true, ["django/contrib/auth/forms.py"])
    const result = await evaluateHubEditGate({
      sessionID: "ses_hub_nondefining",
      filePath: "/repo/django/db/models/base.py",
      graph: overThresholdGraph,
    })
    expect(result.action).toBe("deny")
  })

  it("a child session inherits the parent's defining files", async () => {
    setHubEditGate("ses_hub_parent", true, ["django/db/models/fields/__init__.py"])
    expect(hubEditDefiningFiles("ses_hub_parent")).toEqual(["django/db/models/fields/__init__.py"])

    setHubEditGate("ses_hub_child", hubEditGateArmed("ses_hub_parent"), hubEditDefiningFiles("ses_hub_parent"))
    const result = await evaluateHubEditGate({
      sessionID: "ses_hub_child",
      filePath: "/repo/django/db/models/fields/__init__.py",
      graph: overThresholdGraph,
    })
    expect(result).toEqual({ action: "allow", definingSite: true })
  })

  it("disarming clears the stored defining-file set", () => {
    setHubEditGate("ses_hub_clear", true, ["a.py"])
    expect(hubEditDefiningFiles("ses_hub_clear")).toEqual(["a.py"])
    setHubEditGate("ses_hub_clear", false)
    expect(hubEditDefiningFiles("ses_hub_clear")).toEqual([])
  })
})

describe("Wave 8 — pathsRefer", () => {
  it("equal paths match", () => {
    expect(pathsRefer("django/forms.py", "django/forms.py")).toBe(true)
  })

  it("an absolute path matches a repo-relative suffix on a '/' boundary", () => {
    expect(pathsRefer("/repo/django/contrib/auth/forms.py", "django/contrib/auth/forms.py")).toBe(true)
    expect(pathsRefer("django/contrib/auth/forms.py", "/repo/django/contrib/auth/forms.py")).toBe(true)
  })

  it("no false match on a partial path segment", () => {
    expect(pathsRefer("forms.py", "userforms.py")).toBe(false)
    expect(pathsRefer("userforms.py", "forms.py")).toBe(false)
  })

  it("unrelated paths do not match", () => {
    expect(pathsRefer("django/db/models/base.py", "django/forms/widgets.py")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Wave 8b — lazy defining-file resolution: the allowlist resolves at first
// gate evaluation (via the resolveDefiningSites test seam) rather than at
// turn-open, since the turn-open graph is cold on a fresh repo. A null
// result leaves the session unresolved so the next evaluation retries; a
// non-null result replaces the allowlist and memoizes so the resolver never
// runs again for that session.
// ---------------------------------------------------------------------------

describe("Wave 8b — evaluateHubEditGate lazy defining-site resolution", () => {
  const overThresholdGraph: HubFanInGraph = { fileFanIn: () => 5 }

  it("a resolver hit allows a first edit to the resolved defining file despite over-threshold fan-in", async () => {
    setHubEditGate("ses_hub_lazy_a", true)
    setHubEditIssueText("ses_hub_lazy_a", "fix the hub")
    const resolveDefiningSites = async () => [{ file: "django/x/hub.py" }]

    const result = await evaluateHubEditGate({
      sessionID: "ses_hub_lazy_a",
      filePath: "/repo/django/x/hub.py",
      graph: overThresholdGraph,
      resolveDefiningSites,
    })
    expect(result).toEqual({ action: "allow", definingSite: true })
    expect(hubEditDefiningResolved("ses_hub_lazy_a")).toBe(true)
  })

  it("a null resolver result leaves the session unresolved (bounces), then a later evaluation retries and resolves", async () => {
    setHubEditGate("ses_hub_lazy_b", true)
    setHubEditIssueText("ses_hub_lazy_b", "fix the hub")
    let calls = 0
    let ready = false
    const resolveDefiningSites = async () => {
      calls++
      return ready ? [{ file: "django/x/hub.py" }] : null
    }

    const first = await evaluateHubEditGate({
      sessionID: "ses_hub_lazy_b",
      filePath: "/repo/django/x/hub.py",
      graph: overThresholdGraph,
      resolveDefiningSites,
    })
    expect(first.action).toBe("deny")
    expect(hubEditDefiningResolved("ses_hub_lazy_b")).toBe(false)
    expect(calls).toBe(1)

    ready = true
    const second = await evaluateHubEditGate({
      sessionID: "ses_hub_lazy_b",
      filePath: "/repo/django/x/hub.py",
      graph: overThresholdGraph,
      resolveDefiningSites,
    })
    expect(second).toEqual({ action: "allow", definingSite: true })
    expect(hubEditDefiningResolved("ses_hub_lazy_b")).toBe(true)
    expect(calls).toBe(2)
  })

  it("a resolved session never calls the resolver again (memoized across further evaluations)", async () => {
    setHubEditGate("ses_hub_lazy_c", true)
    setHubEditIssueText("ses_hub_lazy_c", "fix the hub")
    let calls = 0
    const resolveDefiningSites = async () => {
      calls++
      return [{ file: "django/x/hub.py" }]
    }

    const first = await evaluateHubEditGate({
      sessionID: "ses_hub_lazy_c",
      filePath: "/repo/django/x/hub.py",
      graph: overThresholdGraph,
      resolveDefiningSites,
    })
    expect(first).toEqual({ action: "allow", definingSite: true })
    expect(calls).toBe(1)

    const second = await evaluateHubEditGate({
      sessionID: "ses_hub_lazy_c",
      filePath: "/repo/django/other_hub.py",
      graph: overThresholdGraph,
      resolveDefiningSites,
    })
    expect(second.action).toBe("deny")
    expect(calls).toBe(1)

    const third = await evaluateHubEditGate({
      sessionID: "ses_hub_lazy_c",
      filePath: "/repo/django/other_hub2.py",
      graph: overThresholdGraph,
      resolveDefiningSites,
    })
    expect(third.action).toBe("deny")
    expect(calls).toBe(1)
  })

  it("disarm clears the stored issue text and resolved state — a re-arm without files or issue text never calls the resolver", async () => {
    setHubEditGate("ses_hub_lazy_d", true)
    setHubEditIssueText("ses_hub_lazy_d", "fix the hub")
    let calls = 0
    const resolveDefiningSites = async () => {
      calls++
      return [{ file: "django/x/hub.py" }]
    }

    await evaluateHubEditGate({
      sessionID: "ses_hub_lazy_d",
      filePath: "/repo/django/x/hub.py",
      graph: overThresholdGraph,
      resolveDefiningSites,
    })
    expect(calls).toBe(1)
    expect(hubEditDefiningResolved("ses_hub_lazy_d")).toBe(true)

    setHubEditGate("ses_hub_lazy_d", false)
    expect(hubEditDefiningResolved("ses_hub_lazy_d")).toBe(false)
    expect(hubEditIssueText("ses_hub_lazy_d")).toBeUndefined()

    setHubEditGate("ses_hub_lazy_d", true)
    const result = await evaluateHubEditGate({
      sessionID: "ses_hub_lazy_d",
      filePath: "/repo/django/x/hub.py",
      graph: overThresholdGraph,
      resolveDefiningSites,
    })
    expect(calls).toBe(1) // no issue text stored after the re-arm — resolver never invoked
    expect(result.action).toBe("deny")
  })
})

// ---------------------------------------------------------------------------
// Wave 8c — root-most band filter: a resolved defining-site list is narrowed
// to the least-imported band before it becomes the allowlist, so a co-named
// module several times more central than the true fix layer (an incidental
// symbol the issue merely mentions in repro code) doesn't itself grant a hub
// bypass.
// ---------------------------------------------------------------------------

describe("Wave 8c — bandFilterDefiningSites", () => {
  it("keeps only the minimum-fan-in site when a co-named site is far more central", async () => {
    const fanIns: Record<string, number> = { "a.py": 1, "b.py": 26 }
    const kept = await bandFilterDefiningSites(
      [{ file: "a.py" }, { file: "b.py" }],
      (file) => fanIns[file],
    )
    expect(kept).toEqual(["a.py"])
  })

  it("keeps every site within the root-most band (<= 3x the minimum)", async () => {
    const fanIns: Record<string, number> = { "a.py": 1, "b.py": 3 }
    const kept = await bandFilterDefiningSites(
      [{ file: "a.py" }, { file: "b.py" }],
      (file) => fanIns[file],
    )
    expect(kept).toEqual(["a.py", "b.py"])
  })

  it("a single high-fan-in site is kept (it is trivially its own minimum)", async () => {
    const kept = await bandFilterDefiningSites([{ file: "a.py" }], () => 27)
    expect(kept).toEqual(["a.py"])
  })

  it("a kind:'file' site is always kept and excluded from the band computation", async () => {
    const fanIns: Record<string, number> = { "a.py": 1, "b.py": 26 }
    const kept = await bandFilterDefiningSites(
      [{ file: "named.py", kind: "file" }, { file: "a.py" }, { file: "b.py" }],
      (file) => fanIns[file],
    )
    expect(kept).toEqual(["named.py", "a.py"])
  })

  it("a throwing fanInOf keeps that file and excludes it from the min computation", async () => {
    const fanIns: Record<string, number> = { "a.py": 1, "c.py": 30 }
    const kept = await bandFilterDefiningSites(
      [{ file: "a.py" }, { file: "b.py" }, { file: "c.py" }],
      (file) => {
        if (file === "b.py") throw new Error("fan-in unavailable")
        return fanIns[file]
      },
    )
    expect(kept).toEqual(["a.py", "b.py"])
  })

  it("fanInOf throwing for every site keeps everything", async () => {
    const kept = await bandFilterDefiningSites([{ file: "a.py" }, { file: "b.py" }], () => {
      throw new Error("graph unavailable")
    })
    expect(kept).toEqual(["a.py", "b.py"])
  })
})

describe("Wave 8c — evaluateHubEditGate applies the band filter to resolved sites", () => {
  const fanInGraph: HubFanInGraph = {
    fileFanIn: (filePath: string) => {
      if (filePath.endsWith("django/db/models/enums.py")) return 1
      if (filePath.endsWith("django/db/models/fields/__init__.py")) return 26
      return 0
    },
  }

  it("the gold minimum-fan-in resolved site allows even over threshold", async () => {
    setHubEditGate("ses_hub_band_gold", true)
    setHubEditIssueText("ses_hub_band_gold", "fix the field")
    const resolveDefiningSites = async () => [
      { file: "django/db/models/enums.py" },
      { file: "django/db/models/fields/__init__.py" },
    ]

    const result = await evaluateHubEditGate({
      sessionID: "ses_hub_band_gold",
      filePath: "/repo/django/db/models/enums.py",
      graph: fanInGraph,
      resolveDefiningSites,
    })
    expect(result).toEqual({ action: "allow", definingSite: true })
  })

  it("the incidental high-fan-in resolved site is band-filtered out and bounces", async () => {
    setHubEditGate("ses_hub_band_pollutant", true)
    setHubEditIssueText("ses_hub_band_pollutant", "fix the field")
    const resolveDefiningSites = async () => [
      { file: "django/db/models/enums.py" },
      { file: "django/db/models/fields/__init__.py" },
    ]

    const result = await evaluateHubEditGate({
      sessionID: "ses_hub_band_pollutant",
      filePath: "/repo/django/db/models/fields/__init__.py",
      graph: fanInGraph,
      resolveDefiningSites,
    })
    expect(result.action).toBe("deny")
    if (result.action === "deny") {
      expect(result.importers).toBe(26)
      expect(result.message).toContain("django/db/models/enums.py")
    }
  })
})

// ---------------------------------------------------------------------------
// Wave 9 — a retry against a non-candidate is itself the hub-shopping tell.
// Round-A3 django-11964 forensics: a confident single-file wrong-layer draw
// bounces query_utils.py, the denial message names enums.py as the defining
// candidate, and the conductor re-issues the SAME bounced edit rather than
// moving to enums.py. That never produces the 2-distinct-bounced-files
// count the wave 7 trigger needs, so evaluateHubEditGate now flags the
// session (via hubEditRetriedAgainstCandidates) whenever a bounced-set
// retry lands on a file outside a non-empty resolved defining-file
// allowlist.
// ---------------------------------------------------------------------------

describe("Wave 9 — evaluateHubEditGate flags a retry against a non-candidate file", () => {
  const overThresholdGraph: HubFanInGraph = { fileFanIn: () => 25 }

  it("round F §7: a resolved allowlist + a retry on a non-candidate file denies a SECOND time, flag still set; a third identical attempt passes", async () => {
    setHubEditGate("ses_hub_retry_a", true, ["django/db/models/enums.py"])
    expect(hubEditRetriedAgainstCandidates("ses_hub_retry_a")).toBe(false)

    const first = await evaluateHubEditGate({
      sessionID: "ses_hub_retry_a",
      filePath: "/repo/django/db/models/query_utils.py",
      graph: overThresholdGraph,
    })
    expect(first.action).toBe("deny")
    expect(hubEditRetriedAgainstCandidates("ses_hub_retry_a")).toBe(false)

    const second = await evaluateHubEditGate({
      sessionID: "ses_hub_retry_a",
      filePath: "/repo/django/db/models/query_utils.py",
      graph: overThresholdGraph,
    })
    expect(second.action).toBe("deny")
    if (second.action === "deny") {
      expect(second.second).toBe(true)
      expect(second.definingSites).toEqual(["django/db/models/enums.py"])
      expect(second.message).toContain("django/db/models/enums.py")
    }
    // Wave 9's own flag must still fire on this same path (it dispatches the
    // synchronous hub-design judge — that behavior must survive round F).
    expect(hubEditRetriedAgainstCandidates("ses_hub_retry_a")).toBe(true)

    const third = await evaluateHubEditGate({
      sessionID: "ses_hub_retry_a",
      filePath: "/repo/django/db/models/query_utils.py",
      graph: overThresholdGraph,
    })
    expect(third).toEqual({ action: "allow", retried: true })
  })

  it("an empty allowlist retry never sets the flag (nothing was named to shop against)", async () => {
    setHubEditGate("ses_hub_retry_b", true)

    const first = await evaluateHubEditGate({
      sessionID: "ses_hub_retry_b",
      filePath: "/repo/hub.py",
      graph: overThresholdGraph,
    })
    expect(first.action).toBe("deny")

    const second = await evaluateHubEditGate({
      sessionID: "ses_hub_retry_b",
      filePath: "/repo/hub.py",
      graph: overThresholdGraph,
    })
    expect(second).toEqual({ action: "allow", retried: true })
    expect(hubEditRetriedAgainstCandidates("ses_hub_retry_b")).toBe(false)
  })

  it("a non-empty allowlist edit landing ON the candidate takes the definingSite path, never the flag", async () => {
    setHubEditGate("ses_hub_retry_c", true, ["django/db/models/enums.py"])

    const result = await evaluateHubEditGate({
      sessionID: "ses_hub_retry_c",
      filePath: "/repo/django/db/models/enums.py",
      graph: overThresholdGraph,
    })
    expect(result).toEqual({ action: "allow", definingSite: true })
    expect(hubEditRetriedAgainstCandidates("ses_hub_retry_c")).toBe(false)
  })

  it("disarming clears the flag", async () => {
    setHubEditGate("ses_hub_retry_d", true, ["django/db/models/enums.py"])
    await evaluateHubEditGate({
      sessionID: "ses_hub_retry_d",
      filePath: "/repo/django/db/models/query_utils.py",
      graph: overThresholdGraph,
    })
    await evaluateHubEditGate({
      sessionID: "ses_hub_retry_d",
      filePath: "/repo/django/db/models/query_utils.py",
      graph: overThresholdGraph,
    })
    expect(hubEditRetriedAgainstCandidates("ses_hub_retry_d")).toBe(true)

    setHubEditGate("ses_hub_retry_d", false)
    expect(hubEditRetriedAgainstCandidates("ses_hub_retry_d")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Wave 10 — dispatch-time defining-site memoization: memoizeHubEditDefiningSites
// applies the same band filter as evaluateHubEditGate's lazy path (Wave 8c)
// and stores the result through setHubEditGate, so prompt.ts's hub-design
// trigger can seed the session's allowlist from its own already-resolved
// sites instead of racing the lazy resolver at the next gate evaluation.
// ---------------------------------------------------------------------------

describe("Wave 10 — memoizeHubEditDefiningSites", () => {
  it("band-filters the given sites and memoizes them as the session's allowlist", async () => {
    const fanIns: Record<string, number> = { "a.py": 1, "b.py": 10 }
    const graph: HubFanInGraph = { fileFanIn: (file: string) => fanIns[file] }
    expect(hubEditDefiningResolved("ses_hub_memo_a")).toBe(false)

    await memoizeHubEditDefiningSites(
      "ses_hub_memo_a",
      [{ file: "a.py" }, { file: "b.py", kind: "class" }],
      graph,
    )

    expect(hubEditDefiningResolved("ses_hub_memo_a")).toBe(true)
    expect(hubEditDefiningFiles("ses_hub_memo_a")).toEqual(["a.py"])

    const result = await evaluateHubEditGate({
      sessionID: "ses_hub_memo_a",
      filePath: "a.py",
      graph,
    })
    expect(result).toEqual({ action: "allow", definingSite: true })
  })

  it("no-op when the session is already resolved — a different site set never overwrites the allowlist", async () => {
    setHubEditGate("ses_hub_memo_b", true, ["x.py"])
    expect(hubEditDefiningResolved("ses_hub_memo_b")).toBe(true)

    await memoizeHubEditDefiningSites("ses_hub_memo_b", [{ file: "y.py" }], { fileFanIn: () => 1 })

    expect(hubEditDefiningFiles("ses_hub_memo_b")).toEqual(["x.py"])
  })

  it("no-op on empty sites — the session stays unresolved", async () => {
    await memoizeHubEditDefiningSites("ses_hub_memo_c", [], { fileFanIn: () => 1 })
    expect(hubEditDefiningResolved("ses_hub_memo_c")).toBe(false)
  })

  it("a throwing fileFanIn never escapes — bandFilterDefiningSites' own fail-open keeps the unresolvable site rather than excluding it, so the session still resolves", async () => {
    const throwingGraph: HubFanInGraph = {
      fileFanIn: () => {
        throw new Error("graph unavailable")
      },
    }
    await expect(
      memoizeHubEditDefiningSites("ses_hub_memo_d", [{ file: "a.py" }], throwingGraph),
    ).resolves.toBeUndefined()
    expect(hubEditDefiningResolved("ses_hub_memo_d")).toBe(true)
    expect(hubEditDefiningFiles("ses_hub_memo_d")).toEqual(["a.py"])
  })
})
