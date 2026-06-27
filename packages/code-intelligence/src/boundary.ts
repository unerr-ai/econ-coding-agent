/**
 * Architecture-boundary engine for the econ monorepo.
 *
 * Given the post-edit content of a file, reports relative imports that cross a
 * declared architecture-layer boundary. Layers are derived from the file PATH
 * (directory namespace) and matched against a small set of forbidden
 * source→target rules — NOT from graph communities.
 *
 * Why path rules, not communities: graph communities are Louvain/Leiden
 * clustering artifacts. Two files in the same architectural layer routinely land
 * in different communities (and files in different layers land in the same one),
 * so a community delta is a meaningless boundary signal — it neither maps to the
 * invariants the team enforces nor reads sensibly to a developer. Declared path
 * rules map 1:1 to those invariants, the same model dependency-cruiser,
 * Nx `enforce-module-boundaries`, and ArchUnit use.
 *
 * The pre-edit hook calls this over the per-repo UDS (folded into the
 * blast-radius query) and renders an ADVISORY nudge — never a block. It is
 * additive to the repo's CI boundary guards: it surfaces a crossing at edit
 * time, before the commit, without ever stopping the edit. An
 * `@econ-allow cross-layer` override on the import line (or the line above)
 * suppresses the warning outright.
 *
 * Purely path-based, so it needs no graph and works on a cold or
 * partially-indexed graph: a forbidden import in the edited text is a real
 * crossing whether or not the target file has been indexed yet.
 */

const OVERRIDE_PATTERN = /\/\/\s*@econ-allow\s+cross-layer:\s*(.*)/;

/**
 * A relative import in the edited file that crosses a declared layer boundary.
 * Carries the import text, resolved paths, and a paste-ready suggestion.
 *
 * @sem domain=intelligence role=utilities
 */
export interface BoundaryViolation {
  /** The raw import line, verbatim. */
  import: string;
  /** The module specifier (e.g. `../../opencode/tool.js`). */
  specifier: string;
  /** Repo-relative path of the file being edited. */
  source_file: string;
  /** Source layer the edited file belongs to (the matched rule's `from`). */
  source_layer: string;
  /** Forbidden target layer the import reaches into (a matched `forbidden` prefix). */
  target_layer: string;
  /** Imperative, paste-ready guidance for resolving the crossing. */
  suggestion: string;
}

/**
 * One declared architecture rule: files matching `from` must not import the
 * implementation of any prefix in `forbidden`. A prefix ending in `/` matches
 * by directory; a prefix with no trailing `/` matches a single exact file path.
 *
 * @sem domain=intelligence role=utilities
 */
export interface LayerRule {
  /** Source matcher: a repo-relative directory prefix (`packages/foo/`) or exact file (`packages/foo/bar.ts`). */
  from: string;
  /** Target layer prefixes whose implementation this source must not import. */
  forbidden: string[];
  /** Imperative reason, surfaced in the suggestion. */
  reason: string;
}

/**
 * Default rules enforce the econ monorepo's primary isolation invariant:
 * the code-intelligence package must remain host-agnostic so it can be
 * transplanted into any host shell without carrying OpenCode coupling.
 *
 * @sem domain=intelligence role=utilities
 */
export const DEFAULT_LAYER_RULES: LayerRule[] = [
  {
    from: "packages/code-intelligence/",
    forbidden: ["packages/opencode/"],
    reason:
      "the code-intelligence engine must stay host-agnostic — it is transplanted across host shells and cannot couple to the OpenCode app layer",
  },
];

/**
 * Configuration for a boundary check run, controlling which rules apply and
 * whether type-only imports are exempt from enforcement.
 *
 * @sem domain=intelligence role=utilities
 */
export interface BoundaryCheckConfig {
  /** When true, `import type { … }` crossings are allowed (no implementation coupling). */
  allowTypeImports: boolean;
  /** Declared layer rules to enforce. Defaults to {@link DEFAULT_LAYER_RULES}. */
  rules: LayerRule[];
}

/**
 * Permissive defaults: type imports allowed, rules from {@link DEFAULT_LAYER_RULES}.
 * Callers override individual fields to tighten enforcement per context.
 *
 * @sem domain=intelligence role=utilities
 */
export const DEFAULT_BOUNDARY_CHECK_CONFIG: BoundaryCheckConfig = {
  allowTypeImports: true,
  rules: DEFAULT_LAYER_RULES,
};

interface ParsedImport {
  raw: string;
  specifier: string;
  isTypeOnly: boolean;
  hasOverride: boolean;
}

/**
 * Extracts relative `import … from "…"` statements from source text, annotating
 * each with whether it is type-only and whether an `@econ-allow cross-layer`
 * override suppresses boundary enforcement. Only relative specifiers (starting
 * with `.`) are returned — bare-package imports never cross an internal layer.
 *
 * @sem domain=intelligence role=utilities
 */
export function parseImports(content: string): ParsedImport[] {
  const results: ParsedImport[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();

    const importMatch = line.match(
      /^import\s+(type\s+)?(?:\{[^}]*\}|[^'"]+)\s+from\s+['"]([^'"]+)['"]/
    );
    if (!importMatch) continue;

    const isTypeOnly = !!importMatch[1];
    const specifier = importMatch[2]!;
    if (!specifier.startsWith(".")) continue;

    const prevLine = i > 0 ? (lines[i - 1]?.trim() ?? "") : "";
    const hasOverride =
      OVERRIDE_PATTERN.test(prevLine) || OVERRIDE_PATTERN.test(line);

    results.push({ raw: line, specifier, isTypeOnly, hasOverride });
  }

  return results;
}

/**
 * Resolves a relative import specifier against the importing file's repo-relative
 * path, collapsing `.`/`..` segments and normalising `.js` extensions to `.ts`
 * so specifiers match the repo's source layout. Returns null for non-relative
 * specifiers.
 *
 * @sem domain=intelligence role=utilities
 */
export function resolveImportPath(
  specifier: string,
  sourceFile: string
): string | null {
  if (!specifier.startsWith(".")) return null;

  const sourceParts = sourceFile.split("/");
  sourceParts.pop();

  const resolved = [...sourceParts];
  for (const part of specifier.split("/")) {
    if (part === ".") continue;
    if (part === "..") resolved.pop();
    else resolved.push(part);
  }

  let result = resolved.join("/");
  // NodeNext specifiers carry `.js`; the repo's sources are `.ts`.
  result = result.replace(/\.jsx?$/, "");
  if (!/\.[jt]sx?$/.test(result)) result += ".ts";
  return result;
}

/** Match a repo-relative path against a rule prefix: trailing-`/` = directory
 *  prefix; otherwise an exact-file match. */
function matchesPrefix(path: string, pattern: string): boolean {
  return pattern.endsWith("/") ? path.startsWith(pattern) : path === pattern;
}

function buildSuggestion(
  _specifier: string,
  targetLayer: string,
  reason: string
): string {
  return `import type only, or route through a shared schemas/ module — importing the implementation of "${targetLayer}" couples the layers (${reason}). Add "// @econ-allow cross-layer: <reason>" above the import to keep it intentionally.`;
}

/**
 * Reports relative imports in `newContent` that cross a declared layer boundary
 * for the given file path. Returns `[]` when the file matches no rule, the
 * content is empty, or no import reaches a forbidden layer — the caller never
 * needs to special-case files outside the declared architecture.
 *
 * @sem domain=intelligence role=analysis
 */
export function computeBoundaryViolations(
  filePath: string,
  newContent: string | null,
  config: BoundaryCheckConfig = DEFAULT_BOUNDARY_CHECK_CONFIG
): BoundaryViolation[] {
  if (!newContent) return [];

  const imports = parseImports(newContent);
  if (imports.length === 0) return [];

  const rules = config.rules ?? DEFAULT_LAYER_RULES;
  const applicable = rules.filter((r) => matchesPrefix(filePath, r.from));
  if (applicable.length === 0) return [];

  const violations: BoundaryViolation[] = [];

  for (const imp of imports) {
    if (imp.isTypeOnly && config.allowTypeImports) continue;
    if (imp.hasOverride) continue;

    const targetPath = resolveImportPath(imp.specifier, filePath);
    if (!targetPath) continue;

    for (const rule of applicable) {
      const forbidden = rule.forbidden.find((f) =>
        matchesPrefix(targetPath, f)
      );
      if (!forbidden) continue;
      violations.push({
        import: imp.raw,
        specifier: imp.specifier,
        source_file: filePath,
        source_layer: rule.from,
        target_layer: forbidden,
        suggestion: buildSuggestion(imp.specifier, forbidden, rule.reason),
      });
      break; // first matching rule wins — one violation per import line
    }
  }

  return violations;
}
