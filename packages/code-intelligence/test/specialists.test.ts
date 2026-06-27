/**
 * Unit tests for the specialist library and dispatcher (specialists.ts).
 * Pure — no I/O; all functions are side-effect-free.
 */

import { describe, test, expect } from "bun:test"
import {
  SPECIALISTS,
  TIER_AGENT,
  DIGEST_CONTRACT,
  getSpecialist,
  specialistsForTier,
  listSpecialists,
  dispatchSpecialist,
} from "../src/specialists.ts"
import type { SpecialistTier } from "../src/specialists.ts"

// ---------------------------------------------------------------------------
// SPECIALISTS roster
// ---------------------------------------------------------------------------

const VALID_TIERS: SpecialistTier[] = ["executor", "worker", "conductor", "oracle"]

const EXPECTED_NAMES = [
  "recon",
  "lint",
  "docstrings",
  "test-author",
  "refactor",
  "codemod",
  "dep-repair",
  "repro",
  "review",
]

describe("SPECIALISTS roster", () => {
  test("has the expected set of specialist names", () => {
    const keys = Object.keys(SPECIALISTS).sort()
    expect(keys).toEqual([...EXPECTED_NAMES].sort())
  })

  test("every entry has a valid tier", () => {
    for (const [key, s] of Object.entries(SPECIALISTS)) {
      expect(VALID_TIERS).toContain(s.tier)
    }
  })

  test("every entry has non-empty name, description, role, and tools", () => {
    for (const [key, s] of Object.entries(SPECIALISTS)) {
      expect(s.name.length).toBeGreaterThan(0)
      expect(s.description.length).toBeGreaterThan(0)
      expect(s.role.length).toBeGreaterThan(0)
      expect(s.tools.length).toBeGreaterThan(0)
    }
  })

  test("name property matches its record key", () => {
    for (const [key, s] of Object.entries(SPECIALISTS)) {
      expect(s.name).toBe(key)
    }
  })
})

// ---------------------------------------------------------------------------
// Tier assignments
// ---------------------------------------------------------------------------

describe("Tier assignments", () => {
  test("recon, lint, docstrings are executor tier", () => {
    for (const name of ["recon", "lint", "docstrings"]) {
      expect(SPECIALISTS[name].tier).toBe("executor")
    }
  })

  test("test-author, refactor, codemod, dep-repair, repro are worker tier", () => {
    for (const name of ["test-author", "refactor", "codemod", "dep-repair", "repro"]) {
      expect(SPECIALISTS[name].tier).toBe("worker")
    }
  })

  test("review is oracle tier", () => {
    expect(SPECIALISTS["review"].tier).toBe("oracle")
  })
})

// ---------------------------------------------------------------------------
// TIER_AGENT mapping
// ---------------------------------------------------------------------------

describe("TIER_AGENT", () => {
  test("executor tier maps to 'executor' agent", () => {
    expect(TIER_AGENT["executor"]).toBe("executor")
  })

  test("worker tier maps to 'conductor' agent", () => {
    expect(TIER_AGENT["worker"]).toBe("conductor")
  })

  test("conductor tier maps to 'conductor' agent", () => {
    expect(TIER_AGENT["conductor"]).toBe("conductor")
  })

  test("oracle tier maps to 'oracle' agent", () => {
    expect(TIER_AGENT["oracle"]).toBe("oracle")
  })

  test("every tier maps to a non-empty string", () => {
    for (const tier of VALID_TIERS) {
      expect(typeof TIER_AGENT[tier]).toBe("string")
      expect(TIER_AGENT[tier].length).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

describe("getSpecialist", () => {
  test("returns the specialist for a known name", () => {
    const s = getSpecialist("recon")
    expect(s).toBeDefined()
    expect(s?.name).toBe("recon")
  })

  test("returns undefined for an unknown name", () => {
    expect(getSpecialist("does-not-exist")).toBeUndefined()
  })
})

describe("specialistsForTier", () => {
  test("'executor' returns exactly the three executor specialists", () => {
    const result = specialistsForTier("executor")
    expect(result.length).toBe(3)
    const names = result.map((s) => s.name).sort()
    expect(names).toEqual(["docstrings", "lint", "recon"])
  })

  test("every returned specialist has the requested tier", () => {
    for (const tier of VALID_TIERS) {
      const result = specialistsForTier(tier)
      for (const s of result) {
        expect(s.tier).toBe(tier)
      }
    }
  })
})

describe("listSpecialists", () => {
  test("returns all specialist keys", () => {
    const keys = listSpecialists().sort()
    expect(keys).toEqual([...EXPECTED_NAMES].sort())
  })
})

// ---------------------------------------------------------------------------
// dispatchSpecialist
// ---------------------------------------------------------------------------

describe("dispatchSpecialist", () => {
  test("recon dispatch: subagent_type is 'executor'", () => {
    const inv = dispatchSpecialist("recon", "find the router")
    expect(inv.subagent_type).toBe("executor")
  })

  test("recon dispatch: description is a non-empty string", () => {
    const inv = dispatchSpecialist("recon", "find the router")
    expect(typeof inv.description).toBe("string")
    expect(inv.description.length).toBeGreaterThan(0)
  })

  test("recon dispatch: prompt contains the recon role text", () => {
    const inv = dispatchSpecialist("recon", "find the router")
    expect(inv.prompt).toContain(SPECIALISTS["recon"].role)
  })

  test("recon dispatch: prompt contains the task string", () => {
    const inv = dispatchSpecialist("recon", "find the router")
    expect(inv.prompt).toContain("find the router")
  })

  test("recon dispatch: prompt contains the DIGEST_CONTRACT marker 'WHAT YOU DID'", () => {
    const inv = dispatchSpecialist("recon", "find the router")
    expect(inv.prompt).toContain("WHAT YOU DID")
  })

  test("review dispatch: subagent_type is 'oracle'", () => {
    const inv = dispatchSpecialist("review", "check the PR diff")
    expect(inv.subagent_type).toBe("oracle")
  })

  test("refactor dispatch (worker): subagent_type is 'conductor'", () => {
    const inv = dispatchSpecialist("refactor", "rename foo to bar")
    expect(inv.subagent_type).toBe("conductor")
  })

  test("throws for an unknown specialist name", () => {
    expect(() => dispatchSpecialist("ghost", "anything")).toThrow()
  })
})

// ---------------------------------------------------------------------------
// DIGEST_CONTRACT sanity
// ---------------------------------------------------------------------------

describe("DIGEST_CONTRACT", () => {
  test("contains the WHAT YOU DID marker", () => {
    expect(DIGEST_CONTRACT).toContain("WHAT YOU DID")
  })
})
