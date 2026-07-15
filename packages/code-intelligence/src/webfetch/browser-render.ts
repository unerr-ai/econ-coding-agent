/**
 * Optional lazy browser-render fallback for webfetch.
 *
 * Off unless `ECON_WEBFETCH_BROWSER` is set to a truthy value AND a browser
 * automation library (`playwright` or `patchright`) actually resolves via
 * dynamic import. Neither is a hard dependency of this package — bundling
 * one would force every install to pull down a full browser. When the flag
 * is set but no library resolves (or the render itself throws), this module
 * logs a single clear line and returns null so the caller keeps whatever
 * static extraction it already has. Enabling a real render later is a
 * one-line dependency add — no seam changes needed.
 *
 * Ported (trimmed) from unerr-cli src/tools/web/spa-render.ts.
 *
 * @sem domain=intelligence role=webfetch
 */

/** Below this many markdown characters, extraction is treated as near-empty. */
export const MIN_USEFUL_MARKDOWN_CHARS = 200

/** Module path strings kept in variables so TypeScript never statically
 * resolves them (import("literal") triggers TS2307 when the dep is absent
 * from devDeps; import(variable) returns Promise<any> without resolution). */
const _playwrightId = "playwright"
const _patchrightId = "patchright"

/**
 * Result of a successful headless-browser render: the fully-rendered HTML,
 * the URL after any client-side redirects, and the response status.
 *
 * @sem domain=intelligence role=webfetch
 */
export interface BrowserRenderResult {
  html: string
  finalUrl: string
  status: number
}

interface BrowserModule {
  chromium: {
    launch(opts: { headless: boolean }): Promise<BrowserInstance>
  }
}

interface BrowserInstance {
  newContext(opts: { userAgent?: string }): Promise<BrowserContext>
  close(): Promise<void>
}

interface BrowserContext {
  newPage(): Promise<BrowserPage>
}

interface BrowserPage {
  goto(url: string, opts: { waitUntil: string; timeout: number }): Promise<{ status(): number } | null>
  content(): Promise<string>
  url(): string
}

/** Whether the caller has opted in to a real browser-render attempt. */
export function isBrowserRenderEnabled(): boolean {
  const v = process.env.ECON_WEBFETCH_BROWSER
  return v === "1" || v === "true"
}

/**
 * Decide whether the current result justifies a browser-render retry: any
 * detected bot-challenge always qualifies; otherwise near-empty extracted
 * markdown does. Always false when the feature is not enabled.
 *
 * @sem domain=intelligence role=webfetch
 */
export function shouldAttemptBrowserRender(args: { challengeDetected: boolean; markdownLength: number }): boolean {
  if (!isBrowserRenderEnabled()) return false
  if (args.challengeDetected) return true
  return args.markdownLength < MIN_USEFUL_MARKDOWN_CHARS
}

async function loadBrowserModule(): Promise<BrowserModule | null> {
  for (const id of [_playwrightId, _patchrightId]) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (await import(id)) as any as BrowserModule
    } catch {
      continue
    }
  }
  return null
}

/**
 * Render `url` in a headless browser (playwright/patchright, whichever
 * resolves) and return the fully-rendered HTML. Non-fatal: never throws —
 * returns null and logs a one-line notice when no browser lib is installed
 * or the render itself fails, so callers can fall back to static extraction.
 *
 * @sem domain=intelligence role=webfetch
 */
export async function renderWithBrowser(url: string, timeoutMs = 15_000): Promise<BrowserRenderResult | null> {
  const mod = await loadBrowserModule()
  if (!mod) {
    console.log("[webfetch] browser render unavailable — returning static extraction")
    return null
  }
  try {
    const browser = await mod.chromium.launch({ headless: true })
    try {
      const ctx = await browser.newContext({ userAgent: "econ-agent/1.0" })
      const page = await ctx.newPage()
      const response = await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs })
      const html = await page.content()
      return { html, finalUrl: page.url(), status: response?.status() ?? 200 }
    } finally {
      await browser.close()
    }
  } catch {
    console.log("[webfetch] browser render failed — returning static extraction")
    return null
  }
}
