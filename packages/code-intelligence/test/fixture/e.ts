/**
 * Toy fixture: exercises property-call edge resolution — `util.merge(...)`
 * through a namespace import (positive case) vs `obj.merge(...)` on a local
 * class instance (negative case — no import receiver, no edge expected).
 */
import * as util from "./d"

export class Merger {
  combine(x: number, y: number): number {
    return util.merge(x, y)
  }
}

class LocalHelper {
  merge(x: number, y: number): number {
    return x + y
  }
}

export function callLocal(x: number, y: number): number {
  const obj = new LocalHelper()
  return obj.merge(x, y)
}
