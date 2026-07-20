/**
 * Per-session repro-vehicle store — the bridge from the turn-open profile
 * derivation (`prompt.ts`, `getRepoProfileSync(ctx.directory).ecosystems[0]?.repro`)
 * to the S2 mid-turn hand-off/abstention branches and the finish-gate repro
 * lookup, all of which compare a stored todo's `content` against
 * `reproSliceContent(vehicle)`. Same per-session module-state pattern as the
 * arming store: set once at turn open, read from other scopes mid-turn,
 * overwritten every turn so a later turn on the same session never reads a
 * stale vehicle. A repo's ecosystem never changes within a session, so this
 * is a cache, not a source of truth — `getReproVehicle` falls back to the
 * python default before turn-open has run this session.
 *
 * @sem domain=prompting role=repro-seed
 */
import { PYTHON_REPRO_VEHICLE, type ReproVehicle } from "./prompts/nudges"

const reproVehicleBySession = new Map<string, ReproVehicle>()

/** Record this turn's profile-compiled repro vehicle for the session — called once at turn open. */
export function setReproVehicle(sessionID: string, vehicle: ReproVehicle): void {
  reproVehicleBySession.set(sessionID, vehicle)
}

/** The session's repro vehicle, or the python default before turn-open has run this session. */
export function getReproVehicle(sessionID: string): ReproVehicle {
  return reproVehicleBySession.get(sessionID) ?? PYTHON_REPRO_VEHICLE
}
