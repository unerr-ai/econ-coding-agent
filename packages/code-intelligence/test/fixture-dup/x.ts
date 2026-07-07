/** Isolated fixture: a "greet" function, called by y.ts via both an import
 * edge and a call edge (one caller file, one dependency). */
export function greet(name: string): string {
  return `Hi, ${name}`
}
