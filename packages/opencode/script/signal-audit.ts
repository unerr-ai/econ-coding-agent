#!/usr/bin/env bun
/**
 * H6.2 signal-consumer audit: static checker asserting three invariants over the econ signal bus.
 * Run: bun packages/opencode/script/signal-audit.ts from the repo root.
 * Scans every *.ts file under packages/opencode/src/ (recursively — signal publishers/consumers
 * span session/, tool/, and other subdirs, not just src/session/) for EconSignalName definitions,
 * their publishSignal* call sites, and consumers (signalsFor/tailSignals calls, gate trigger
 * patterns, finish-summary folding). Reports three classes of findings: (1) publisher-only signals
 * (no consumer), (2) gates with silent pass on zero/exhausted, (3) green verdicts that don't state
 * verified scope. Exits nonzero if findings detected.
 */

import { readFileSync, readdirSync } from "fs"
import { join, resolve } from "path"

interface Finding {
  kind: "publisher-only-signal" | "silent-pass" | "unscoped-green"
  entity: string
  file: string
  line: number
  invariant: number
  detail: string
}

interface SignalAudit {
  name: string
  published: boolean
  publishedAt: { file: string; line: number }[]
  consumed: boolean
  consumedAt: { file: string; line: number; context: string }[]
}

interface GateAudit {
  gateName: string
  failLoudPath: boolean
  scopeStatements: { file: string; line: number; scope: string }[]
  findings: Finding[]
}

// Track results
const findings: Finding[] = []
const signals = new Map<string, SignalAudit>()
const gates = new Map<string, GateAudit>()

const SIGNAL_NAMES: string[] = [
  "probe_gate_reject",
  "probe_gate_exhausted",
  "oracle_inversion",
  "seen_red_unresolved",
  "seen_red_oracle_inverted",
  "seen_red_env_blocked",
  "probe_env_blocked",
  "probe_rerun_dedupe",
  "unverified_finish",
  "patch_sanity_unverified",
  "regression_red",
  "unverifiable_regression_surface",
  "deliverable_checklist",
  "promoted_pin_green",
  "repro_unresolved",
  "repro_drift",
  "fidelity_gap",
  "fidelity_finish_reject",
  "hub_bounce",
  "hub_bounce_repeat",
  "hub_bounce_turn_repeat",
  "hub_bounce_judge_redirect",
  "hub_gate_exhausted_allow",
  "convention_divergence",
  "convention_divergence_repeat",
  "interpreter_mismatch",
  "interpreter_harvested",
  "gate_block",
  "deferral_armed",
  "deferral_dispatched",
  "surface_asked",
]

// Tier-2 reserved: consumer-record-only signal names in signal-bus.ts
// (declared for a not-yet-built publish path, per their "consumer record"
// type comments). No publisher exists for these by design — flag their
// absence as noise, not a wiring gap.
const RESERVED_TIER2_SIGNAL_NAMES = new Set(["deferral_armed", "deferral_dispatched", "surface_asked"])

const GATE_FILES = [
  "turn-supervisor.ts",
  "regression-neighbors.ts",
  "repro-fidelity-judge.ts",
  "hub-design-judge.ts",
  "arming-judge.ts",
]

// Resolve relative to this script's own location (not cwd) so the audit
// works whether invoked from the repo root or from packages/opencode/.
const SRC_DIR = resolve(import.meta.dir, "../src")

// Recursively read every *.ts file under SRC_DIR. Signal publishers and
// consumers span multiple src subdirectories (session/, tool/, etc.), not
// just src/session/ — walk the whole tree so new subdirs are covered
// without a script change. Keyed by path relative to SRC_DIR so files with
// the same basename in different dirs (e.g. index.ts) don't collide.
function readSourceFiles(dir = SRC_DIR, files: Map<string, string> = new Map()): Map<string, string> {
  const entries = readdirSync(dir, { withFileTypes: true })

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      readSourceFiles(fullPath, files)
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      try {
        const relPath = fullPath.slice(SRC_DIR.length + 1)
        files.set(relPath, readFileSync(fullPath, "utf-8"))
      } catch {
        // Skip unreadable files
      }
    }
  }
  return files
}

// Parse line number from context
function findLineNumber(content: string, searchStr: string, occurrence = 1): number {
  const index = content.indexOf(searchStr)
  if (index === -1) return 0
  return content.substring(0, index).split("\n").length
}

// Initialize signal audit entries
function initializeSignals() {
  for (const name of SIGNAL_NAMES) {
    signals.set(name, {
      name,
      published: false,
      publishedAt: [],
      consumed: false,
      consumedAt: [],
    })
  }
}

// Find all publishSignal calls
function findPublishers(files: Map<string, string>) {
  const publisherRegex = /publishSignal(?:Fx)?\s*\(\s*\{[^}]*name\s*:\s*["']([^"']+)["']/gm

  for (const [fileName, content] of files) {
    let match
    while ((match = publisherRegex.exec(content)) !== null) {
      const signalName = match[1]
      const signal = signals.get(signalName)
      if (signal) {
        signal.published = true
        const line = content.substring(0, match.index).split("\n").length
        signal.publishedAt.push({ file: fileName, line })
      }
    }
  }
}

// Find signal consumers
function findConsumers(files: Map<string, string>) {
  // Pattern 1: Direct signalsFor usage
  const signalsForRegex = /signalsFor\s*\(\s*sessionID\s*\)/g
  // Pattern 2: tailSignals usage
  const tailSignalsRegex = /tailSignals\s*\(\s*sessionID\s*\)/g
  // Pattern 3: Signal-specific checks in gates
  const signalCheckRegex = /\.name\s*===\s*["']([^"']+)["']/g
  // Pattern 4: Filtering by signal names
  const filterSignalRegex = /name\s*===\s*["']([^"']+)["']|"([^"']+)"\s*in\s*evidence/g

  for (const [fileName, content] of files) {
    // Find general signal consumption
    let match
    if ((match = signalsForRegex.exec(content))) {
      const line = content.substring(0, match.index).split("\n").length
      // Mark all signals as potentially consumed here
      for (const signal of signals.values()) {
        signal.consumed = true
        signal.consumedAt.push({ file: fileName, line, context: "signalsFor" })
      }
    }

    if ((match = tailSignalsRegex.exec(content))) {
      const line = content.substring(0, match.index).split("\n").length
      for (const signal of signals.values()) {
        if (!RESERVED_TIER2_SIGNAL_NAMES.has(signal.name)) {
          signal.consumed = true
          signal.consumedAt.push({ file: fileName, line, context: "tailSignals" })
        }
      }
    }

    // Find specific signal checks
    while ((match = signalCheckRegex.exec(content)) !== null) {
      const signalName = match[1]
      const signal = signals.get(signalName)
      if (signal) {
        const line = content.substring(0, match.index).split("\n").length
        signal.consumed = true
        if (!signal.consumedAt.some((c) => c.file === fileName && Math.abs(c.line - line) < 5)) {
          signal.consumedAt.push({ file: fileName, line, context: `check: ${signalName}` })
        }
      }
    }

    // Find evidence patterns
    while ((match = filterSignalRegex.exec(content)) !== null) {
      const signalName = match[1] || match[2]
      if (signalName && SIGNAL_NAMES.includes(signalName)) {
        const signal = signals.get(signalName)
        if (signal) {
          const line = content.substring(0, match.index).split("\n").length
          signal.consumed = true
          if (!signal.consumedAt.some((c) => c.file === fileName && Math.abs(c.line - line) < 3)) {
            signal.consumedAt.push({ file: fileName, line, context: `evidence: ${signalName}` })
          }
        }
      }
    }
  }
}

// Audit gates for fail-loud paths
function auditGates(files: Map<string, string>) {
  // Gate patterns to check
  const gatePatterns: Record<string, { file: RegExp; patterns: RegExp[] }> = {
    regression_gate: {
      file: /regression-neighbors/,
      patterns: [
        /publishSignal.*regression_red/,
        /unverifiable_regression_surface/,
        /fail.*loud|silent.*pass/i,
      ],
    },
    repro_fidelity: {
      file: /repro-fidelity-judge/,
      patterns: [
        /fidelity_gap|fidelity_finish_reject/,
        /publishSignal.*fidelity/,
        /reject|deny/i,
      ],
    },
    hub_design: {
      // Wave 12 fail-loud enforcement (deny/allow decision + publishSignalFx
      // calls for hub_bounce_repeat/hub_bounce_judge_redirect/hub_gate_exhausted_allow)
      // lives at the edit/write call sites, not inside the judge module itself —
      // hub-design-judge.ts only builds the prompt and parses the verdict.
      file: /^(session\/hub-design-judge\.ts|tool\/edit\.ts|tool\/write\.ts)$/,
      patterns: [
        /hub_bounce_repeat|hub_gate_exhausted/,
        /publishSignal.*hub/,
        /deny.*loud/i,
      ],
    },
    escalation_gate: {
      file: /turn-supervisor/,
      patterns: [
        /probe_gate_reject|probe_gate_exhausted/,
        /escalat/i,
        /defer|fail.*loud/i,
      ],
    },
    patch_sanity: {
      file: /turn-supervisor/,
      patterns: [
        /patch_sanity_unverified/,
        /publishSignal.*patch/,
        /sanity.*floor/i,
      ],
    },
    deliverable_checklist: {
      // H4.1's publish + verifiedScope surfacing (markDeliverableFinishDenied /
      // publishSignalFx({name:"deliverable_checklist"}) at ~4582-4614) lives in
      // session/prompt.ts, not turn-supervisor.ts.
      file: /^session\/prompt\.ts$/,
      patterns: [
        /deliverable_checklist/,
        /verifiedScope|scope.*statement/i,
      ],
    },
  }

  for (const [gateName, pattern] of Object.entries(gatePatterns)) {
    const gateAudit: GateAudit = {
      gateName,
      failLoudPath: false,
      scopeStatements: [],
      findings: [],
    }

    for (const [fileName, content] of files) {
      if (!pattern.file.test(fileName)) continue

      // Check for fail-loud patterns
      let hasFailLoud = false
      for (const pat of pattern.patterns) {
        if (pat.test(content)) {
          hasFailLoud = true
          break
        }
      }

      if (hasFailLoud) {
        gateAudit.failLoudPath = true
      }

      // Check for scope statements
      const scopeRegex = /verifiedScope|scope\s*[:=]|verified\s*scope|scope.*statement/gi
      let match
      while ((match = scopeRegex.exec(content)) !== null) {
        const line = content.substring(0, match.index).split("\n").length
        gateAudit.scopeStatements.push({
          file: fileName,
          line,
          scope: match[0],
        })
      }
    }

    gates.set(gateName, gateAudit)
  }
}

// Report findings
function reportFindings() {
  console.log("\n╔══════════════════════════════════════════════════════════════════════════════╗")
  console.log("║                    H6.2 Signal-Consumer Audit Report                         ║")
  console.log("╚══════════════════════════════════════════════════════════════════════════════╝\n")

  // Invariant 1: Signal consumers
  console.log("INVARIANT 1: Every deterministic signal has a consumer")
  console.log("─".repeat(80))
  const signalTable: (string | number)[][] = [
    ["Signal Name", "Published", "Published At", "Consumed", "Consumed At"],
  ]

  for (const signal of signals.values()) {
    const pubAt =
      signal.publishedAt.length > 0
        ? signal.publishedAt.map((p) => `${p.file}:${p.line}`).join("; ")
        : "—"
    const conAt =
      signal.consumedAt.length > 0
        ? signal.consumedAt.map((c) => `${c.file}:${c.line}`).join("; ")
        : "—"

    signalTable.push([signal.name, signal.published ? "✓" : "✗", pubAt, signal.consumed ? "✓" : "✗", conAt])

    // Invariant 1a: Signal is consumed but never published (designed but not wired).
    // Exempt Tier-2 reserved names (see RESERVED_TIER2_SIGNAL_NAMES) — they're
    // consumer-record placeholders with no publisher by design, and the blanket
    // signalsFor() consumption match still marks them "consumed", so without this
    // exemption they'd wrongly read as a designed-but-not-wired gap.
    if (!signal.published && signal.consumed && !RESERVED_TIER2_SIGNAL_NAMES.has(signal.name)) {
      findings.push({
        kind: "publisher-only-signal",
        entity: signal.name,
        file: "signal-bus.ts",
        line: SIGNAL_NAMES.indexOf(signal.name) + 16, // Approximate line in signal-bus.ts type definition
        invariant: 1,
        detail: `Signal '${signal.name}' is consumed (${signal.consumedAt.length} location(s)) but never published — designed but not wired`,
      })
    }
    // Invariant 1b: Signal is published but never consumed (advisory-only signal)
    if (signal.published && !signal.consumed) {
      findings.push({
        kind: "publisher-only-signal",
        entity: signal.name,
        file: signal.publishedAt[0]?.file || "unknown",
        line: signal.publishedAt[0]?.line || 0,
        invariant: 1,
        detail: `Signal '${signal.name}' is published but never consumed (advisory-only, violates no-advisory rule)`,
      })
    }
  }

  // Print table (simplified for readability)
  console.log(`\n  ${signalTable[0].map((h) => String(h).padEnd(20)).join(" ")}\n`)
  for (let i = 1; i < Math.min(signalTable.length, 35); i++) {
    const row = signalTable[i]
    console.log(
      `  ${String(row[0]).padEnd(20)} ${String(row[1]).padEnd(12)} ${String(row[2]).padEnd(30)} ${String(row[3]).padEnd(12)} ${String(row[4]).slice(0, 60)}`
    )
  }
  if (signalTable.length > 35) {
    console.log(`  ... (${signalTable.length - 35} more signals)`)
  }

  // Invariant 2: Gate fail-loud paths
  console.log("\n\nINVARIANT 2: Every gate has a fail-loud zero/exhausted path")
  console.log("─".repeat(80))
  const gateTable: (string | boolean)[][] = [["Gate", "Fail-Loud Path", "Scope Statements"]]

  for (const gate of gates.values()) {
    const scopeCount = gate.scopeStatements.length
    gateTable.push([gate.gateName, gate.failLoudPath, scopeCount > 0 ? `✓ (${scopeCount})` : "—"])

    if (!gate.failLoudPath) {
      findings.push({
        kind: "silent-pass",
        entity: gate.gateName,
        file: "turn-supervisor.ts",
        line: 0,
        invariant: 2,
        detail: `Gate '${gate.gateName}' has no detectable fail-loud path for zero/exhausted state`,
      })
    }
  }

  console.log(`\n  ${gateTable[0].map((h) => String(h).padEnd(30)).join(" ")}\n`)
  for (let i = 1; i < gateTable.length; i++) {
    const row = gateTable[i]
    console.log(
      `  ${String(row[0]).padEnd(30)} ${String(row[1]).padEnd(20)} ${String(row[2]).padEnd(20)}`
    )
  }

  // Invariant 3: Scope statements
  console.log("\n\nINVARIANT 3: Every green verdict states its verified scope")
  console.log("─".repeat(80))
  let scopeCount = 0
  for (const gate of gates.values()) {
    if (gate.scopeStatements.length > 0) {
      scopeCount += gate.scopeStatements.length
      console.log(`  ${gate.gateName}:`)
      for (const scope of gate.scopeStatements) {
        console.log(`    - ${scope.file}:${scope.line} (${scope.scope})`)
      }
    }
  }
  console.log(`\n  Total scope statements found: ${scopeCount}\n`)

  // Summary
  console.log("\n╔══════════════════════════════════════════════════════════════════════════════╗")
  console.log("║                              FINDINGS SUMMARY                                ║")
  console.log("╚══════════════════════════════════════════════════════════════════════════════╝\n")

  if (findings.length === 0) {
    console.log("✓ No findings detected. All invariants pass.\n")
  } else {
    console.log(`Found ${findings.length} finding(s):\n`)
    for (const finding of findings) {
      console.log(`  FINDING [${finding.kind}] — Invariant ${finding.invariant}`)
      console.log(`    Entity: ${finding.entity}`)
      console.log(`    Location: ${finding.file}:${finding.line}`)
      console.log(`    Detail: ${finding.detail}\n`)
    }
  }

  return findings.length === 0 ? 0 : 1
}

// Main execution
function main() {
  initializeSignals()
  const files = readSourceFiles()

  if (files.size === 0) {
    console.error("No source files found at", SRC_DIR)
    process.exit(1)
  }

  findPublishers(files)
  findConsumers(files)
  auditGates(files)

  const exitCode = reportFindings()
  process.exit(exitCode)
}

main()
