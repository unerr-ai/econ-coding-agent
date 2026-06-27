/** Toy fixture: entry point that imports from a and b. */
import { greet } from "./a"
import { Calculator } from "./b"

export function main(): void {
  const calc = new Calculator()
  const result = calc.add(1, 2)
  console.log(greet(`result is ${result}`))
}

export function runBatch(inputs: number[][]): number[] {
  const calc = new Calculator()
  return inputs.map(([a, b]) => calc.add(a ?? 0, b ?? 0))
}
