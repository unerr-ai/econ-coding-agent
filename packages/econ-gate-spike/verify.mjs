/**
 * verify.mjs — S0.4 spike verification (no bun install required)
 *
 * Directly simulates the OpenCode plugin trigger mechanism at
 * packages/opencode/src/plugin/index.ts line 290:
 *
 *   yield* Effect.promise(async () => fn(input, output))
 *
 * If fn throws (synchronously or returns a rejected Promise), Effect.promise
 * captures it as an Effect failure. That failure propagates up run.promise()
 * inside the tool execute function, which rejects the tool Promise, which the
 * AI SDK converts into a tool error result the model reads.
 *
 * Run with:  node packages/econ-gate-spike/verify.mjs
 */

import { pathToFileURL } from "url"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pluginPath = path.resolve(__dirname, "../../.opencode/plugins/econ-gate-spike.js")

// --------------------------------------------------------------------------
// Load the spike plugin (mirrors applyPlugin in plugin/index.ts)
// --------------------------------------------------------------------------
const mod = await import(pathToFileURL(pluginPath).href)
const pluginFn = Object.values(mod).find((v) => typeof v === "function")
if (!pluginFn) {
  console.error("FAIL: no exported function found in plugin")
  process.exit(1)
}

const hooks = await pluginFn({}) // ctx not needed for the gate logic

// --------------------------------------------------------------------------
// Simulate trigger (mirrors plugin/index.ts lines 287-292)
// --------------------------------------------------------------------------
async function trigger(name, input, output) {
  const fn = hooks[name]
  if (!fn) return output
  // This is exactly what plugin/index.ts does — a throw becomes a rejection:
  await fn(input, output)
  return output
}

let passed = 0
let failed = 0

async function test(label, fn) {
  process.stdout.write(`\n[test] ${label}\n`)
  try {
    await fn()
    passed++
  } catch (e) {
    console.error(`  UNEXPECTED FAILURE: ${e.message}`)
    failed++
  }
}

// --------------------------------------------------------------------------
// Test 1: non-edit tool — hook is a no-op
// --------------------------------------------------------------------------
await test("non-edit tool (read) is never blocked", async () => {
  await trigger(
    "tool.execute.before",
    { tool: "read", sessionID: "s1", callID: "c1" },
    { args: { filePath: "ECON_GATE_BLOCKED.txt" } },
  )
  console.log("  PASS: no block (read tool not in EDIT_TOOLS)")
})

// --------------------------------------------------------------------------
// Test 2: write to a normal path — allowed
// --------------------------------------------------------------------------
await test("write to a normal path is allowed", async () => {
  await trigger(
    "tool.execute.before",
    { tool: "write", sessionID: "s1", callID: "c2" },
    { args: { filePath: "packages/core/src/index.ts", content: "x" } },
  )
  console.log("  PASS: no block (path does not match marker)")
})

// --------------------------------------------------------------------------
// Test 3: write to a blocked path — gate must throw
// --------------------------------------------------------------------------
await test("write to ECON_GATE_BLOCKED path is refused", async () => {
  let threw = false
  try {
    await trigger(
      "tool.execute.before",
      { tool: "write", sessionID: "s1", callID: "c3" },
      { args: { filePath: "docs/sprint0/ECON_GATE_BLOCKED.txt", content: "bad" } },
    )
  } catch (e) {
    threw = true
    console.log("  PASS: gate threw — model would receive this tool error:")
    console.log(`  -> ${e.message}`)
  }
  if (!threw) {
    console.error("  FAIL: expected throw but none was raised")
    failed++
    passed-- // undo the outer pass
  }
})

// --------------------------------------------------------------------------
// Test 4: edit (patch) to a blocked path — gate must throw
// --------------------------------------------------------------------------
await test("edit to ECON_GATE_BLOCKED path is refused", async () => {
  let threw = false
  try {
    await trigger(
      "tool.execute.before",
      { tool: "edit", sessionID: "s1", callID: "c4" },
      { args: { filePath: "src/ECON_GATE_BLOCKED_target.ts", oldString: "a", newString: "b" } },
    )
  } catch (e) {
    threw = true
    console.log("  PASS: gate threw — model would receive this tool error:")
    console.log(`  -> ${e.message}`)
  }
  if (!threw) {
    console.error("  FAIL: expected throw but none was raised")
    failed++
    passed--
  }
})

// --------------------------------------------------------------------------
// Test 5: apply_patch to a blocked path — gate must throw
// --------------------------------------------------------------------------
await test("apply_patch to ECON_GATE_BLOCKED path is refused", async () => {
  let threw = false
  try {
    await trigger(
      "tool.execute.before",
      { tool: "apply_patch", sessionID: "s1", callID: "c5" },
      { args: { filePath: "ECON_GATE_BLOCKED/important.ts", patch: "..." } },
    )
  } catch (e) {
    threw = true
    console.log("  PASS: gate threw — model would receive this tool error:")
    console.log(`  -> ${e.message}`)
  }
  if (!threw) {
    console.error("  FAIL: expected throw but none was raised")
    failed++
    passed--
  }
})

// --------------------------------------------------------------------------
// Summary
// --------------------------------------------------------------------------
console.log(`\n${"─".repeat(60)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  process.exit(1)
}
