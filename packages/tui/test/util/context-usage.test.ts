import { describe, expect, test } from "bun:test"
import { getContextFullness, shouldNudgeCompaction } from "../../src/util/context-usage"

const model = { limit: { context: 100_000, output: 32_000 } }

describe("util.context-usage", () => {
  describe("shouldNudgeCompaction", () => {
    // AC-4.5: honored-toggle boundary test. The real auto-compaction trigger
    // lives server-side in packages/opencode/src/session/overflow.ts
    // (isOverflow), out of this worker's file ownership. Verified by reading
    // (not editing) that file + its tests:
    //   - `compaction.auto === false` IS honored (isOverflow short-circuits)
    //     and IS already test-covered: compaction.test.ts "returns false
    //     when compaction.auto is disabled".
    //   - `compaction.threshold_pct` is declared in the config schema
    //     (packages/core/src/v1/config/config.ts) but is NOT read anywhere
    //     in overflow.ts/compaction.ts and has no test — a real, currently
    //     unimplemented gap outside this worker's owned files (overflow.ts
    //     is off-limits) — flagging for the senior, not fixing here.
    // This file is the TUI-owned boundary: it verifies the client-side
    // config consumption (compaction.nudge_pct) that this worker owns.
    test("does not nudge below nudge_pct", () => {
      const fullness = getContextFullness({
        tokens: { input: 50_000, output: 0, reasoning: 0 },
        model,
        compaction: { nudge_pct: 0.8 },
      })
      expect(shouldNudgeCompaction(fullness, { nudge_pct: 0.8 })).toBe(false)
    })

    test("nudges once usable-window fill reaches nudge_pct", () => {
      const fullness = getContextFullness({
        tokens: { input: 65_000, output: 0, reasoning: 0 },
        model,
        compaction: { nudge_pct: 0.8 },
      })
      expect(fullness.percentOfUsable).toBeGreaterThanOrEqual(80)
      expect(shouldNudgeCompaction(fullness, { nudge_pct: 0.8 })).toBe(true)
    })

    test("honors a raised nudge_pct threshold (config respected, not hardcoded)", () => {
      const fullness = getContextFullness({
        tokens: { input: 65_000, output: 0, reasoning: 0 },
        model,
        compaction: { nudge_pct: 0.99 },
      })
      expect(fullness.percentOfUsable).toBeLessThan(99)
      expect(shouldNudgeCompaction(fullness, { nudge_pct: 0.99 })).toBe(false)
    })

    test("defaults to 0.80 when nudge_pct is unset", () => {
      const fullness = getContextFullness({
        tokens: { input: 65_000, output: 0, reasoning: 0 },
        model,
        compaction: {},
      })
      expect(shouldNudgeCompaction(fullness, {})).toBe(true)
    })

    test("never nudges when the model/limit is unknown", () => {
      const fullness = getContextFullness({
        tokens: { input: 65_000, output: 0, reasoning: 0 },
        model: undefined,
        compaction: { nudge_pct: 0.8 },
      })
      expect(shouldNudgeCompaction(fullness, { nudge_pct: 0.8 })).toBe(false)
    })
  })
})
