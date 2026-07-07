/**
 * Compose two verifier extension rungs (OL-7.3b) into the single `extraRung`
 * slot `runVerifierLadder` exposes. The ladder runs sound → behavior → extraRung
 * → QE; but two independent rungs — the execution-free reward model (OL-7.8a)
 * and the cross-model judge (OL-7.8) — both want that one slot on an untestable
 * slice. Per the plan's ladder order (§4.6: sound → RM → QE + cross-model
 * judge), the RM sits ahead of the judge, so the composed rung tries `rm` first
 * and only falls through to `judge` when the RM abstains. This is a combinator,
 * not new rung logic — it never inspects a verdict, only picks the first
 * non-undefined one, leaving verifier.ts's ladder untouched.
 *
 * @sem domain=routing role=verify-ladder
 */

import type { ExtraRungFn } from "./verifier.js"

/**
 * Combine an optional RM rung and an optional judge rung into one `ExtraRungFn`,
 * in ladder order (RM first, judge second). The first rung to return a verdict
 * wins; a rung that abstains (returns `undefined`) falls through to the next;
 * both abstaining ⇒ the composed rung abstains too. When only one rung is
 * present the composed result IS that rung (identity — no wrapper), so a
 * flag-off RM leaves the pre-existing judge-only behavior byte-identical. When
 * neither is present the result is `undefined` (no extension rung at all).
 *
 * @sem domain=routing role=verify-ladder
 */
export function composeExtraRungs(
  rm: ExtraRungFn | undefined,
  judge: ExtraRungFn | undefined,
): ExtraRungFn | undefined {
  if (!rm) return judge
  if (!judge) return rm
  return async (ctx) => {
    const rmVerdict = await rm(ctx)
    if (rmVerdict) return rmVerdict
    return judge(ctx)
  }
}
