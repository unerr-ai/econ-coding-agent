/** Isolated fixture: imports and calls y.ts's greet — a distinct caller file
 * from callerX.ts, used to verify x.ts's and y.ts's greet don't leak
 * each other's callers despite sharing a bare name. */
import { greet } from "./y"

export function useY(): string {
  return greet("world")
}
