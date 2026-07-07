import { centralHub } from "./hub"

export function caller2(): number {
  return centralHub()
}
