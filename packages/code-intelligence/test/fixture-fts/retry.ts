/**
 * Retries a flaky operation with exponential backoff.
 *
 * @sem domain=resilience role=handler
 */
export function retryHandler(): void {
  console.log("retrying")
}

/** Unrelated helper — nothing in this fixture calls it. */
export function helperUtil(): void {
  console.log("helper")
}

/** Name has no "retry" token — retryCount in the signature is an incidental substring match only. */
export function processQueue(retryCount: number): void {
  console.log(retryCount)
}
