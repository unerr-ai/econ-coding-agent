/**
 * WASM tree-sitter loader — lazy initialization with grammar caching and
 * graceful fallback to the regex extractor when web-tree-sitter or grammars
 * are unavailable. No native addons; safe under `bun build --compile`.
 *
 * Ported from unerr-cli src/intelligence/tree-sitter-loader.ts with bun
 * compatibility adjustments (import.meta.resolve for WASM path resolution).
 *
 * TODO: when tree-sitter-wasms is installed, the WASM upgrade path becomes
 * active. Run `bun add web-tree-sitter tree-sitter-wasms` in this package.
 *
 * @sem domain=intelligence role=utilities
 */

// ---------------------------------------------------------------------------
// WASM Grammar name map (language → .wasm file in tree-sitter-wasms/out/)
// ---------------------------------------------------------------------------

const GRAMMAR_MAP: Record<string, string> = {
  typescript: "tree-sitter-typescript.wasm",
  javascript: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
  go: "tree-sitter-go.wasm",
  java: "tree-sitter-java.wasm",
  rust: "tree-sitter-rust.wasm",
  c: "tree-sitter-c.wasm",
  cpp: "tree-sitter-cpp.wasm",
  csharp: "tree-sitter-c_sharp.wasm",
  ruby: "tree-sitter-ruby.wasm",
  php: "tree-sitter-php.wasm",
  kotlin: "tree-sitter-kotlin.wasm",
  swift: "tree-sitter-swift.wasm",
}

// ---------------------------------------------------------------------------
// Module-level parser cache
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let TreeSitter: any | null = null
let initPromise: Promise<boolean> | null = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parserCache = new Map<string, any>()

/** Whether WASM tree-sitter was successfully initialized. */
export let wasmAvailable = false

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Attempt to initialize web-tree-sitter. Idempotent — only loads once.
 * Returns true if WASM is available, false if the package is not installed.
 *
 * @sem domain=intelligence role=utilities
 */
export async function initTreeSitter(): Promise<boolean> {
  if (wasmAvailable) return true
  if (initPromise) return initPromise

  initPromise = (async () => {
    try {
      // Dynamic import so the module stays optional; Bun resolves this at
      // runtime — no hard dep at bundle time.
      const mod = await import("web-tree-sitter")
      const TS = mod.default ?? mod
      await TS.init()
      TreeSitter = TS
      wasmAvailable = true
      return true
    } catch {
      // web-tree-sitter not installed or WASM init failed — use regex fallback.
      wasmAvailable = false
      return false
    }
  })()

  return initPromise
}

// ---------------------------------------------------------------------------
// Grammar resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the filesystem path to a tree-sitter WASM grammar file.
 * Tries import.meta.resolve first (Bun-native), then falls back to a
 * cwd-relative node_modules path.
 *
 * @sem domain=intelligence role=utilities
 */
function resolveGrammarPath(wasmName: string): string {
  try {
    // Bun supports import.meta.resolve for package paths
    return import.meta.resolve(`tree-sitter-wasms/out/${wasmName}`).replace(/^file:\/\//, "")
  } catch {
    // Fallback: assume CWD is the repo root
    return `${process.cwd()}/node_modules/tree-sitter-wasms/out/${wasmName}`
  }
}

// ---------------------------------------------------------------------------
// Parser access
// ---------------------------------------------------------------------------

/**
 * Get a cached Parser for a language. Initializes WASM on first call.
 * Returns null when WASM is unavailable so callers can fall back to regex.
 *
 * @sem domain=intelligence role=utilities
 */
export async function getParser(language: string): Promise<unknown | null> {
  if (!(await initTreeSitter())) return null

  const wasmName = GRAMMAR_MAP[language]
  if (!wasmName) return null

  const cached = parserCache.get(language)
  if (cached) return cached

  try {
    const grammarPath = resolveGrammarPath(wasmName)
    const lang = await TreeSitter.Language.load(grammarPath)
    const parser = new TreeSitter()
    parser.setLanguage(lang)
    parserCache.set(language, parser)
    return parser
  } catch {
    // Grammar .wasm not found — stay on regex path for this language.
    return null
  }
}

/**
 * Parse source code with tree-sitter if available. Returns the AST tree or
 * null to signal the caller should use the regex extractor.
 *
 * @sem domain=intelligence role=utilities
 */
export async function parseSource(source: string, language: string): Promise<unknown | null> {
  const parser = await getParser(language)
  if (!parser) return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (parser as any).parse(source)
}

/**
 * Clear parser cache — useful for testing or releasing WASM memory.
 *
 * @sem domain=intelligence role=utilities
 */
export function clearParserCache(): void {
  for (const p of parserCache.values()) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(p as any).delete?.()
  }
  parserCache.clear()
}
