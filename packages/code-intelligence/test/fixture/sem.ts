/**
 * Computes a risk score for an entity based on its import fan-in count.
 * Used to gate expensive escalation decisions.
 *
 * @sem domain=risk role=analysis
 */
export function computeRisk(fanIn: number): number {
  return Math.min(1, fanIn / 20)
}

/**
 * Selects the cheapest capable model tier for a given task string.
 * Core routing primitive for the cost-reduction engine.
 *
 * @sem domain=routing role=decision
 */
export class ModelRouter {
  select(task: string): string {
    return task.length > 100 ? "expensive" : "cheap"
  }
}

/** No @sem annotation — domain/role should be undefined in the graph. */
export function unannotated(): void {}
