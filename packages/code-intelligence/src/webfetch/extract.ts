/**
 * Pure regex-based HTML-to-markdown extractor for web content compression.
 * No DOM dependencies — runs synchronously at any scale. Strips navigation
 * chrome (nav/header/footer/aside/script/style), converts structural HTML
 * tags to markdown syntax, and returns the extracted title + markdown body
 * alongside the original byte count for compression-ratio reporting.
 *
 * @sem domain=intelligence role=webfetch
 */

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
}

/**
 * Convert raw HTML to markdown. Removes navigation chrome, converts headings /
 * paragraphs / links to markdown syntax, and collapses whitespace — no DOM
 * required. Suitable as a fast first-pass before passage-splitting + BM25.
 *
 * @sem domain=intelligence role=webfetch
 */
export function htmlToMarkdown(html: string): ExtractResult {
  const originalLength = html.length

  // Extract page title
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

  return { title, markdown: body, originalLength }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
