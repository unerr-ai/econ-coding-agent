import { describe, expect, it } from "bun:test";
import {
  computeBoundaryViolations,
  resolveImportPath,
} from "../src/boundary.ts";

// Source file inside the code-intelligence package.
// resolveImportPath("../../opencode/bar.js", "packages/code-intelligence/src/foo.ts")
// → pops "foo.ts" → ["packages","code-intelligence","src"]
//   ".." → ["packages","code-intelligence"]
//   ".." → ["packages"]
//   "opencode" → ["packages","opencode"]
//   "bar.js" → ["packages","opencode","bar.js"]
//   .js stripped, .ts appended → "packages/opencode/bar.ts"   ✓ starts with packages/opencode/
const CI_FILE = "packages/code-intelligence/src/foo.ts";
const SPECIFIER = "../../opencode/bar.js";

describe("resolveImportPath", () => {
  it("resolves the specifier to packages/opencode/bar.ts", () => {
    expect(resolveImportPath(SPECIFIER, CI_FILE)).toBe(
      "packages/opencode/bar.ts"
    );
  });
});

describe("computeBoundaryViolations", () => {
  it("(1) value import crossing into packages/opencode/ yields one violation", () => {
    const content = `import { x } from "${SPECIFIER}"`;
    const violations = computeBoundaryViolations(CI_FILE, content);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.target_layer).toBe("packages/opencode/");
    expect(violations[0]!.source_layer).toBe("packages/code-intelligence/");
    expect(violations[0]!.specifier).toBe(SPECIFIER);
  });

  it("(2) type-only import crossing into packages/opencode/ is allowed (allowTypeImports)", () => {
    const content = `import type { X } from "${SPECIFIER}"`;
    const violations = computeBoundaryViolations(CI_FILE, content);
    expect(violations).toHaveLength(0);
  });

  it("(3) import preceded by @econ-allow cross-layer is suppressed", () => {
    const content = [
      "// @econ-allow cross-layer: intentional",
      `import { x } from "${SPECIFIER}"`,
    ].join("\n");
    const violations = computeBoundaryViolations(CI_FILE, content);
    expect(violations).toHaveLength(0);
  });

  it("(4) a file outside any declared rule (packages/server/) yields no violations", () => {
    const content = `import { x } from "${SPECIFIER}"`;
    const violations = computeBoundaryViolations(
      "packages/server/src/x.ts",
      content
    );
    expect(violations).toHaveLength(0);
  });
});
