/**
 * Unit tests for conventions.ts: detectConventions shape and stub behaviour.
 */

import { describe, it, expect } from "bun:test"
import { detectConventions } from "./../src/conventions.js"
import type { ConventionRule, ConventionDetector } from "./../src/conventions.js"

// ---------------------------------------------------------------------------
// detectConventions
// ---------------------------------------------------------------------------

describe("detectConventions", () => {
  it("returns an array (stub returns empty array for any input)", () => {
    const result = detectConventions([])
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(0)
  })

  it("returns an array when given sample strings", () => {
    const result = detectConventions(["import { foo } from './bar.js'", "export function baz() {}"])
    expect(Array.isArray(result)).toBe(true)
    // Stub always returns [] — confirm no items until runtime impl lands.
    expect(result).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Type-shape compile checks (no runtime assertions needed — tsc covers these)
// ---------------------------------------------------------------------------

// ConventionRule shape is structurally complete
const _rule: ConventionRule = { id: "no-default-export", description: "Avoid default exports", confidence: 0.9 }
void _rule

// ConventionDetector is a valid interface — a simple inline impl satisfies it
const _detector: ConventionDetector = {
  detect(samples: string[]): ConventionRule[] {
    return detectConventions(samples)
  },
}
void _detector
