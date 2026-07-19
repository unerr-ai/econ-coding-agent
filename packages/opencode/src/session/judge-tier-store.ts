/**
 * Gap-closure §4.3 — per-session "already surfaced" flag for the
 * `ECON_JUDGE_TIER=off` master kill switch (`resolveJudgeTierSwitch`,
 * model-registry.ts): when the switch is off, prompt.ts's three judge
 * dispatch sites (hub-design, repro-fidelity, cross-model verifier) skip
 * their LLM call and fall through to deterministic gates only — but the
 * degrade must never be silent. This store bounds the loud notice to ONE
 * log + signal per session (not once per site, not once per dispatch), same
 * per-session module-state pattern as patch-sanity-store.ts: keyed by
 * sessionID, set the first time any of the three sites observes the switch
 * off, read before emitting so every later dispatch this session degrades
 * quietly (deterministic gates only, byte-identical either way).
 *
 * @sem domain=routing role=config
 */
const judgeTierOffNotedBySession = new Set<string>()

/** Whether this session already surfaced the ECON_JUDGE_TIER=off notice once. */
export function hasNotedJudgeTierOff(sessionID: string): boolean {
  return judgeTierOffNotedBySession.has(sessionID)
}

/** Record that this session surfaced the ECON_JUDGE_TIER=off notice. */
export function markJudgeTierOffNoted(sessionID: string): void {
  judgeTierOffNotedBySession.add(sessionID)
}
