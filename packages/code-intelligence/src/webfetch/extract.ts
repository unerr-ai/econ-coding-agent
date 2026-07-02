/**
 * Multi-stage HTML-to-markdown extractor for web content compression.
 *
 * Pipeline: universal chrome pre-strip → Defuddle (primary) →
 * @mozilla/readability (fallback) → regex raw-body strip. jsdom/defuddle/
 * readability are lazy-loaded to keep startup cost near zero. Pages >2MB
 * always use the sync regex path to avoid pinning the process on a runaway
 * jsdom parse. Deps (@mozilla/readability, defuddle, jsdom) must be present
 * in the consuming package (opencode); the async path degrades gracefully to
 * the sync path when they are absent.
 *
 * All DOM-typed code is local to extractAsync and uses `any` internally so
 * this module compiles cleanly under lib:["ESNext"] without @types/jsdom.
 *
 * Ported from unerr-cli src/tools/web/extract.ts; trimmed to the pipeline
 * core (no per-host rules, no anti-bot, no telemetry).
 *
 * @sem domain=intelligence role=webfetch
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Result of extracting a web page to markdown.
 *
 * @sem domain=intelligence role=webfetch
 */
export interface ExtractResult {
  /** Page &lt;title&gt; text. */
  title: string
  /** Extracted body as markdown-like text. */
  markdown: string
  /** Length of the original HTML input in characters. */
  originalLength: number
  /** Open Graph / article metadata parsed from &lt;meta&gt; tags. Always present; fields optional. */
  metadata: PageMetadata
}

/**
 * Open Graph and article-level metadata extracted from a web page's &lt;meta&gt; tags.
 * Carries provenance fields for search-result attribution and freshness signals.
 *
 * @sem domain=intelligence role=webfetch
 */
export interface PageMetadata {
  /** Author name from `name="author"` or `property="article:author"`. */
  author?: string
  /** ISO-8601 publish timestamp from `property="article:published_time"` or `itemprop="datePublished"`. */
  published_at?: string
  /** Site display name from `property="og:site_name"`. */
  site_name?: string
  /** Open Graph page type (e.g. "article", "website") from `property="og:type"`. */
  og_type?: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Above this raw HTML size, skip jsdom entirely and use the regex tag-strip. */
const LARGE_HTML_THRESHOLD = 2 * 1024 * 1024

/** Minimum plain-text characters for Defuddle/Readability output to be accepted. */
const MIN_USEFUL_CHARS = 200

/**
 * Generic semantic-chrome selectors removed before Defuddle/Readability.
 * Modeled on Firecrawl's excludeNonMainTags — handles ~96% of pages without
 * per-host config.
 */
const CHROME_SELECTORS: ReadonlyArray<string> = [
  "header",
  "footer",
  "nav",
  "aside",
  ".header",
  ".footer",
  ".sidebar",
  ".navbar",
  ".menu",
  ".navigation",
  ".breadcrumbs",
  ".cookie",
  ".modal",
  ".popup",
  ".overlay",
  ".ad",
  ".ads",
  ".advert",
  ".share",
  ".widget",
  ".lang-selector",
  ".language",
  ".social",
  ".social-media",
  "#header",
  "#footer",
  "#sidebar",
  "#nav",
  "#breadcrumbs",
  "#cookie",
]

/**
 * Selectors that protect a chrome-named element from removal when it wraps
 * actual content (rare but real — some sites nest &lt;main&gt; inside &lt;nav&gt;).
 */
const KEEP_SELECTORS: ReadonlyArray<string> = [
  "#content",
  "#main",
  "main",
  "article",
  ".markdown-body",
  ".prose",
  ".post-content",
]

// ---------------------------------------------------------------------------
// Metadata extraction (sync regex — runs on raw HTML before DOM processing)
// ---------------------------------------------------------------------------

/**
 * Extract Open Graph / article metadata from raw HTML using regex patterns.
 * Handles both attribute orderings: `<meta property="X" content="Y">` and
 * `<meta content="Y" property="X">`.
 */
function extractPageMetadataSync(html: string): PageMetadata {
  const meta: PageMetadata = {}

  const get = (attr: string, value: string): string | undefined => {
    // Match <meta attr="value" content="..."> or <meta content="..." attr="value">
    const a = new RegExp(`<meta\\s[^>]*${attr}=["']${value}["'][^>]*content=["']([^"']+)["'][^>]*>`, "i")
    const b = new RegExp(`<meta\\s[^>]*content=["']([^"']+)["'][^>]*${attr}=["']${value}["'][^>]*>`, "i")
    return html.match(a)?.[1]?.trim() || html.match(b)?.[1]?.trim() || undefined
  }

  meta.site_name = get("property", "og:site_name")
  meta.og_type   = get("property", "og:type")
  meta.author    = get("name", "author") ?? get("property", "article:author")
  meta.published_at =
    get("property", "article:published_time") ?? get("itemprop", "datePublished")

  // Drop empty keys so the object stays compact
  for (const k of ["site_name", "og_type", "author", "published_at"] as const) {
    if (!meta[k]) delete meta[k]
  }

  return meta
}

// ---------------------------------------------------------------------------
// Sync raw-body fallback (regex only — no jsdom)
// ---------------------------------------------------------------------------

/**
 * Sync regex-based HTML→markdown. Strips scripts/styles/chrome and converts
 * structural tags to markdown syntax without instantiating a DOM. Used for
 * large pages and as the fallback when jsdom deps are unavailable.
 *
 * @sem domain=intelligence role=webfetch
 */
export function rawBodyFromHtmlSync(html: string): ExtractResult {
  const originalLength = html.length

  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i)
  const title = titleMatch?.[1]?.trim() ?? ""

  // Remove entire chrome blocks before any tag conversion
  let body = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside\b[^>]*>[\s\S]*?<\/aside>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")

  body = convertHtmlToMarkdown(body)
  return { title, markdown: body, originalLength, metadata: extractPageMetadataSync(html) }
}

// ---------------------------------------------------------------------------
// HTML→markdown conversion (structural tags → markdown syntax)
// ---------------------------------------------------------------------------

function convertHtmlToMarkdown(html: string): string {
  let body = html

  // Headings → ATX markdown
  body = body
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, inner) => `\n# ${stripInlineTags(inner)}\n`)
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, inner) => `\n## ${stripInlineTags(inner)}\n`)
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, inner) => `\n### ${stripInlineTags(inner)}\n`)
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, (_, inner) => `\n#### ${stripInlineTags(inner)}\n`)
    .replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, (_, inner) => `\n##### ${stripInlineTags(inner)}\n`)
    .replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, (_, inner) => `\n###### ${stripInlineTags(inner)}\n`)

  // Code blocks: <pre><code>…</code></pre> then bare <pre>
  body = body
    .replace(
      /<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi,
      (_, inner) => `\n\`\`\`\n${decodeHtmlEntities(inner)}\n\`\`\`\n`,
    )
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner) => `\n\`\`\`\n${decodeHtmlEntities(inner)}\n\`\`\`\n`)

  // Inline code
  body = body.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, inner) => `\`${decodeHtmlEntities(inner)}\``)

  // Hyperlinks
  body = body.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
    const t = stripInlineTags(text).trim()
    return t ? `[${t}](${href})` : href
  })

  // Bold / italic
  body = body
    .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/(strong|b)>/gi, (_, _t, inner) => `**${stripInlineTags(inner)}**`)
    .replace(/<(em|i)[^>]*>([\s\S]*?)<\/(em|i)>/gi, (_, _t, inner) => `*${stripInlineTags(inner)}*`)

  // List items → dash bullets
  body = body.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => `\n- ${stripInlineTags(inner).trim()}`)

  // Block-level container tags → paragraph breaks
  const BLOCK = ["p", "div", "section", "article", "main", "tr", "blockquote"] as const
  for (const tag of BLOCK) {
    body = body
      .replace(new RegExp(`<${tag}[^>]*>`, "gi"), "\n")
      .replace(new RegExp(`<\\/${tag}>`, "gi"), "\n")
  }
  body = body.replace(/<br\s*\/?>/gi, "\n")
  body = body.replace(/<td[^>]*>/gi, " | ").replace(/<th[^>]*>/gi, " | ")

  // Strip remaining tags
  body = body.replace(/<[^>]+>/g, " ")

  // Decode HTML entities
  body = decodeHtmlEntities(body)

  // Normalise whitespace
  body = body
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

  return body
}

// ---------------------------------------------------------------------------
// Async extraction chain (Defuddle → Readability → raw-body)
// All DOM-typed code is local to this function to avoid @types/jsdom dep.
// ---------------------------------------------------------------------------

// Module path strings kept in variables to prevent TypeScript from statically
// resolving them (import("literal") triggers TS2307 when the dep is absent
// from devDeps; import(variable) returns Promise<any> without resolution).
const _jsdomId = "jsdom"
const _defuddleId = "defuddle"
const _readabilityId = "@mozilla/readability"

async function extractAsync(html: string, baseUrl: string, originalLength: number): Promise<ExtractResult> {
  // Extract metadata from raw HTML once — reused across all exit paths below.
  const metadata = extractPageMetadataSync(html)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { JSDOM, VirtualConsole } = (await import(_jsdomId)) as any
  const virtualConsole = new VirtualConsole()
  virtualConsole.on("jsdomError", () => { /* suppress jsdom CSS noise */ })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dom: any = new JSDOM(html, { url: baseUrl, virtualConsole })

  // ── Universal chrome strip ──────────────────────────────────────────────
  const doc = dom.window.document
  for (const sel of CHROME_SELECTORS) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let nodes: any
    try {
      nodes = doc.querySelectorAll(sel)
    } catch {
      continue
    }
    for (const node of nodes) {
      if (!node.isConnected) continue
      if (node.closest("main, article")) continue
      if (KEEP_SELECTORS.some((s: string) => node.querySelector(s))) continue
      node.remove()
    }
  }

  // ── Pre-validate CSS rules (suppress Tailwind/React Aria nwsapi noise) ──
  try {
    const probe = doc.createElement("div")
    const sheets = doc.styleSheets
    for (let s = 0; s < sheets.length; s++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let rules: any = null
      try { rules = sheets[s]?.cssRules ?? null } catch { continue }
      if (!rules) continue
      for (let i = rules.length - 1; i >= 0; i--) {
        const sel = rules[i]?.selectorText
        if (typeof sel !== "string" || sel.length === 0) continue
        try { probe.matches(sel) } catch {
          try { sheets[s].deleteRule(i) } catch { /* read-only sheet */ }
        }
      }
    }
  } catch { /* best effort */ }

  // ── Try Defuddle ────────────────────────────────────────────────────────
  const origError = console.error
  const origLog = console.log
  const isNoise = (parts: unknown[]): boolean => {
    const h = typeof parts[0] === "string" ? parts[0] : ""
    return h.startsWith("Defuddle") || h.startsWith("Error: Could not parse CSS stylesheet")
  }
  console.error = (...p: unknown[]) => { if (!isNoise(p)) origError.apply(console, p) }
  console.log = (...p: unknown[]) => { if (!isNoise(p)) origLog.apply(console, p) }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const defMod = (await import(_defuddleId)) as any
    const defuddleDoc = dom.window.document
    const defResult = new defMod.default(defuddleDoc, { markdown: false }).parse()
    if (defResult?.content && stripTags(defResult.content).length >= MIN_USEFUL_CHARS) {
      console.error = origError
      console.log = origLog
      return {
        title: defResult.title ?? "",
        markdown: convertHtmlToMarkdown(defResult.content as string),
        originalLength,
        metadata,
      }
    }
  } catch { /* fall through to readability */ } finally {
    console.error = origError
    console.log = origLog
  }

  // ── Try Readability ─────────────────────────────────────────────────────
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const readMod = (await import(_readabilityId)) as any
    const readDoc = dom.window.document
    if (!readMod.isProbablyReaderable || readMod.isProbablyReaderable(readDoc)) {
      const article = new readMod.Readability(readDoc).parse()
      if (article?.content && stripTags(article.content as string).length >= MIN_USEFUL_CHARS) {
        return {
          title: (article.title as string) ?? "",
          markdown: convertHtmlToMarkdown(article.content as string),
          originalLength,
          metadata,
        }
      }
    }
  } catch { /* fall through to raw-body DOM fallback */ }

  // ── Raw-body DOM fallback ───────────────────────────────────────────────
  const rawDoc = dom.window.document
  for (const sel of ["script", "style", "noscript", "iframe", "svg"]) {
    for (const node of rawDoc.querySelectorAll(sel)) (node as { remove(): void }).remove()
  }
  const main =
    rawDoc.querySelector("main") ?? rawDoc.querySelector("article") ?? rawDoc.body ?? rawDoc.documentElement
  return {
    title: rawDoc.title ?? "",
    markdown: convertHtmlToMarkdown((main?.innerHTML as string) ?? ""),
    originalLength,
    metadata,
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert raw HTML to markdown via Defuddle → Readability → regex raw-body
 * chain. Lazy-loads jsdom/defuddle/readability — falls back to the sync regex
 * path when they are unavailable. Async since DOM extraction uses dynamic
 * imports and Defuddle's parse is expensive on large pages.
 *
 * @sem domain=intelligence role=webfetch
 */
export async function htmlToMarkdown(html: string, baseUrl?: string): Promise<ExtractResult> {
  const originalLength = html.length
  if (html.length > LARGE_HTML_THRESHOLD) return rawBodyFromHtmlSync(html)
  try {
    return await extractAsync(html, baseUrl ?? "https://unknown", originalLength)
  } catch {
    return rawBodyFromHtmlSync(html)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").trim()
}

function stripInlineTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
}
