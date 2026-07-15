/**
 * Anti-bot / challenge-page detection for the webfetch tool.
 *
 * Some hosts return HTTP 200 (or 403) with a JavaScript-challenge interstitial
 * instead of the real page (Cloudflare "Just a moment...", hCaptcha,
 * PerimeterX, or a generic access-denied block page). The raw HTML is short
 * and extracts to near-nothing — indistinguishable from a genuine SPA shell
 * without these markers. Detecting the challenge lets the caller decide
 * whether a browser-render retry is worth attempting instead of returning a
 * misleading near-empty extraction.
 *
 * Detection is marker-based (no network, no DOM) and runs on the raw fetched
 * HTML before extraction. Markers are intentionally narrow to avoid false
 * positives on pages that merely *mention* Cloudflare.
 *
 * Ported from unerr-cli src/tools/web/anti-bot.ts; adds a generic 403
 * block-page category alongside the three host-specific ones.
 *
 * @sem domain=intelligence role=webfetch
 */

export type ChallengeKind = "cloudflare" | "hcaptcha" | "perimeterx" | "generic"

/**
 * Result of a positive challenge-page match: which vendor/pattern fired and a
 * one-line remediation hint for the caller to surface.
 *
 * @sem domain=intelligence role=webfetch
 */
export interface ChallengeDetection {
  kind: ChallengeKind
  suggestion: string
}

const CLOUDFLARE_MARKERS: RegExp[] = [
  /cf[-_]chl[-_]opt/i,
  /__cf_chl_/,
  /cf-browser-verification/i,
  /Just a moment\.\.\./i,
  /Enable JavaScript and cookies to continue/i,
  /Checking your browser before accessing/i,
  /challenges\.cloudflare\.com/i,
]

const HCAPTCHA_MARKERS: RegExp[] = [
  /hcaptcha\.com\/captcha/i,
  /h-captcha-response/i,
  /class=["'][^"']*\bh-captcha\b/i,
]

const PERIMETERX_MARKERS: RegExp[] = [
  /_pxhd/i,
  /window\._pxAppId/i,
  /Please verify you are a human/i,
  /captcha\.px-cloud\.net/i,
]

/** Generic block-page wording, only trusted when paired with an HTTP 403. */
const GENERIC_BLOCK_MARKERS: RegExp[] = [
  /access denied/i,
  /you have been blocked/i,
  /request blocked/i,
  /automated access to this website is not allowed/i,
]

function matchesAny(html: string, markers: RegExp[]): boolean {
  return markers.some((m) => m.test(html))
}

/**
 * Inspect fetched HTML (and optionally its HTTP status) for known bot-
 * challenge / block-page markers. Pure and network-free — callers use the
 * result to decide whether a browser-render retry is worth attempting.
 *
 * @sem domain=intelligence role=webfetch
 */
export function detectChallenge(html: string, status?: number): ChallengeDetection | null {
  if (!html) return null

  if (matchesAny(html, CLOUDFLARE_MARKERS)) {
    return {
      kind: "cloudflare",
      suggestion:
        "set ECON_WEBFETCH_BROWSER=1 (requires a browser-render dependency) and retry, or fetch via an authenticated session",
    }
  }
  if (matchesAny(html, HCAPTCHA_MARKERS)) {
    return {
      kind: "hcaptcha",
      suggestion: "host requires solving hCaptcha — fetch this URL manually or via an authenticated session",
    }
  }
  if (matchesAny(html, PERIMETERX_MARKERS)) {
    return {
      kind: "perimeterx",
      suggestion: "host is gated by PerimeterX bot mitigation — fetch via an authenticated session or skip this host",
    }
  }
  if (status === 403 && matchesAny(html, GENERIC_BLOCK_MARKERS)) {
    return {
      kind: "generic",
      suggestion: "host returned 403 with a block-page marker — fetch via an authenticated session or skip this host",
    }
  }
  return null
}
