/** Isolated fixture: imports and calls x.ts's greet — one caller file that
 * contributes both an import edge and a call edge for the same relationship. */
import { greet } from "./x"

export function useX(): string {
  return greet("world")
}
