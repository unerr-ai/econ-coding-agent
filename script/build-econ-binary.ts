#!/usr/bin/env bun

import { $ } from "bun";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Resolve paths relative to this script (no hard-coded absolute paths)
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const opencodeDir = resolve(projectRoot, "packages/opencode");

console.log("Building single-platform econ backend binary...\n");

// Passthrough args (--baseline, --sourcemaps, etc.)
const passThroughArgs = process.argv.slice(2);
const buildArgs = ["--single", "--skip-install", ...passThroughArgs];

console.log(`Working directory: ${opencodeDir}`);

// Run the opencode build script with single-platform flags
try {
  await $`cd ${opencodeDir} && bun run script/build.ts ${buildArgs}`;
} catch (e) {
  console.error(`❌ Build failed`);
  process.exit(1);
}

// Locate the resulting binary
const distDir = resolve(opencodeDir, "dist");
let binaryPath: string | null = null;

try {
  // Search for opencode binary in dist tree
  const result = await $`find ${distDir} -name "opencode" -type f 2>/dev/null`.text();
  const paths = result.trim().split("\n").filter(Boolean);
  if (paths.length > 0) {
    binaryPath = paths[0];
  }
} catch (_e) {
  // find command failed, binary may not exist
}

if (!binaryPath) {
  console.error(`❌ Error: Binary not found after build in ${distDir}`);
  process.exit(1);
}

// Report success
console.log(`\n✓ Binary ready: ${binaryPath}\n`);
console.log("Summary:");
console.log(
  "  • Single self-contained backend process (no Node runtime required)"
);
console.log(
  "  • unerr-brain Node sidecar operates as a separate process per architecture"
);
