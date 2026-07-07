import { centralHub } from "./hub"

export function caller1(): number {
  return centralHub()
}
