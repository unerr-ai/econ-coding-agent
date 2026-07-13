import { readFileSync } from "fs"
import { runHubDesignJudge, DEGRADED_HUB_DESIGN } from "./src/session/hub-design-judge"
import { HUB_DESIGN_SYSTEM_PROMPT } from "./src/session/prompts/judges"

// Read the issue text from django-11964 PROMPT.txt
const issueText = readFileSync(
  "/Users/jaswanth/econ-swe-arena/meta/11964/PROMPT.txt",
  "utf8",
)

// Real round-A3 inputs
const bouncedFiles = ["django/db/models/query_utils.py"]
const definitionSites = [
  { symbol: "TextChoices", kind: "class", file: "django/db/models/enums.py" },
  { symbol: "IntegerChoices", kind: "class", file: "django/db/models/enums.py" },
]

// Get the reasoner model ID from ECON_TIER_BINDING at runtime (tier-speak rule)
const { ECON_TIER_BINDING } = await import("../code-intelligence/src/model-registry")
const reasonerModel = ECON_TIER_BINDING.reasoner

// Gateway configuration
const GATEWAY_BASE_URL = process.env.ECON_BASE_URL ?? "https://econ-litellm.fly.dev/v1"
const GATEWAY_API_KEY = process.env.LITELLM_MASTER_KEY

if (!GATEWAY_API_KEY) {
  console.error("ERROR: LITELLM_MASTER_KEY not set in environment")
  process.exit(1)
}

console.log(`Using reasoner model: ${reasonerModel}`)
console.log(`Gateway URL: ${GATEWAY_BASE_URL}`)
console.log(`\n--- Running 3 trials ---\n`)

// Helper function to make HTTP request to litellm gateway (stores full response for debugging)
let fullResponse: string = ""

async function complete(req: { system: string; user: string }): Promise<string> {
  const response = await fetch(`${GATEWAY_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GATEWAY_API_KEY}`,
    },
    body: JSON.stringify({
      model: reasonerModel,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      max_tokens: 2500,
      temperature: 0,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Gateway error ${response.status}: ${errorText}`)
  }

  const data = (await response.json()) as {
    choices: Array<{ message?: { reasoning_content?: string; content?: string } }>
    usage?: { total_tokens?: number }
  }

  const choice = data.choices?.[0]
  if (!choice?.message) {
    throw new Error("No message in response")
  }

  // Mirror the wave-8 closure from prompt.ts
  const reasoning = choice.message.reasoning_content ?? ""
  const content = choice.message.content ?? ""
  const result = [reasoning, content].filter(Boolean).join("\n")

  fullResponse = result

  // Log usage if available
  if (data.usage?.total_tokens) {
    console.log(`  [usage: ${data.usage.total_tokens} tokens]`)
  }

  return result
}

// Run 3 trials
for (let trialNum = 1; trialNum <= 3; trialNum++) {
  console.log(`Trial ${trialNum}:`)

  try {
    const result = await runHubDesignJudge({
      issueText,
      bouncedFiles,
      definitionSites,
      complete,
    })

    const { verdict, rawHead } = result

    // Check if degraded
    const isDegraded =
      verdict.file === "" || (verdict === DEGRADED_HUB_DESIGN)

    if (isDegraded) {
      console.log(`  Verdict: DEGRADED`)
      if (rawHead) {
        console.log(`  Raw response head: ${rawHead}`)
      }
      console.log(`  Full response length: ${fullResponse.length} chars`)
      console.log(`  Full response (first 300 chars):\n${fullResponse.slice(0, 300)}`)
      console.log(`  Full response (last 500 chars):\n${fullResponse.slice(-500)}`)
    } else {
      // Check if file ends with "enums.py"
      const endsWithEnumsPy = verdict.file.endsWith("enums.py")
      console.log(`  Verdict: ${JSON.stringify(verdict)}`)
      console.log(`  ✓ File ends with enums.py: ${endsWithEnumsPy}`)
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    console.log(`  ERROR: ${errorMsg}`)
  }

  console.log()
}

console.log("--- Probe complete ---")
