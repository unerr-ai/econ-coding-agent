/**
 * Benchmark fixture set for the econ eval harness.
 * Four tasks covering each tier: conductor (planning), executor (coding ×2),
 * oracle (judgement). Extend by adding entries to the exported array.
 * @sem domain=eval role=fixtures
 */

import type { Fixture } from "./types.js"

/**
 * All fixtures run by the harness. Each fixture targets one tier and carries
 * a `mockResponse` so the harness works without any API key (--dry-run).
 */
export const FIXTURES: Fixture[] = [
  // ── conductor: planning ──────────────────────────────────────────────────
  {
    id: "plan-rest-to-graphql",
    tier: "conductor",
    system: "You are a senior software architect. Be concise.",
    prompt:
      "List exactly 3 numbered steps to migrate a Node.js REST API to GraphQL. " +
      "Output only the numbered list, no preamble.",
    check: (out) => /1\.\s/.test(out) && /2\.\s/.test(out) && /3\.\s/.test(out),
    checkDescription: "Output contains a 3-item numbered list",
    mockResponse: `1. Define a GraphQL schema that mirrors your existing REST resources and relationships.
2. Replace Express route handlers with GraphQL resolvers, reusing existing service/data-access logic.
3. Swap clients to the GraphQL endpoint and remove deprecated REST routes incrementally.`,
  },

  // ── executor: fix a bug ───────────────────────────────────────────────────
  {
    id: "fix-sum-bug",
    tier: "executor",
    system: "You are a precise TypeScript developer. Return only the fixed function, no explanation.",
    prompt: `Fix the bug in this TypeScript function — it always returns 0:

function sumArray(nums: number[]): number {
  let total = 0
  for (const n of nums) {
    total = n   // BUG: should accumulate
  }
  return total
}

Return only the corrected function.`,
    check: (out) => /total\s*[+]=\s*n/.test(out) || /total\s*=\s*total\s*\+\s*n/.test(out),
    checkDescription: "Fixed function uses += or total = total + n",
    mockResponse: `function sumArray(nums: number[]): number {
  let total = 0
  for (const n of nums) {
    total += n
  }
  return total
}`,
  },

  // ── executor: implement a function ────────────────────────────────────────
  {
    id: "implement-palindrome",
    tier: "executor",
    system: "You are a precise TypeScript developer. Return only the function, no explanation.",
    prompt:
      "Implement a TypeScript function `isPalindrome(s: string): boolean` that returns true " +
      "when the string reads the same forwards and backwards (case-insensitive, ignore spaces). " +
      "Return only the function.",
    check: (out) =>
      /isPalindrome/.test(out) &&
      /return/.test(out) &&
      (/reverse/.test(out) || /split/.test(out) || /\[\s*i\s*\]/.test(out)),
    checkDescription:
      'Contains "isPalindrome", a return statement, and a reversal/comparison strategy',
    mockResponse: `function isPalindrome(s: string): boolean {
  const clean = s.toLowerCase().replace(/\\s+/g, "")
  return clean === clean.split("").reverse().join("")
}`,
  },

  // ── oracle: judge two code snippets ───────────────────────────────────────
  {
    id: "judge-null-safety",
    tier: "oracle",
    system: "You are a code reviewer. Answer in one word: A or B.",
    prompt: `Which snippet handles null more safely?

A:
function getName(user: { name?: string }): string {
  return user.name ?? "Anonymous"
}

B:
function getName(user: { name?: string }): string {
  return user.name!
}

Answer with only the letter A or B.`,
    check: (out) => /^\s*A\b/.test(out.trim()),
    checkDescription: 'Output starts with "A" (correct: nullish-coalescing is safer)',
    mockResponse: "A",
  },
]
