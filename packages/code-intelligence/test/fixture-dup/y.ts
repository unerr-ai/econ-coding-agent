/** Isolated fixture: a second, unrelated "greet" function — same bare name
 * as x.ts's greet but in a different file, with a different caller. */
export function greet(name: string): string {
  return `Hello there, ${name}`
}
