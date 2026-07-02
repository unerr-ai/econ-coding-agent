#!/usr/bin/env node
// ---------------------------------------------------------------------------
// build-npm-packages.mjs — stage the econ npm packages for publishing.
//
// Layout (esbuild optionalDependencies pattern):
//   @unerr-ai/econ              — wrapper shim (bin/econ.js), no binary; its
//                                 optionalDependencies pin the 5 platform pkgs
//   @unerr-ai/econ-<os>-<arch>  — one compiled native binary each, gated by the
//                                 npm `os`/`cpu` fields so only the matching one
//                                 installs on a given machine
//
// Inputs: compiled binaries staged at  dist/bin/econ-<target>[.exe]
//   (the release workflow renames packages/opencode/dist/opencode-<target>/
//    bin/opencode -> dist/bin/econ-<target> before calling this script.)
//
// Output: packaging/npm/dist/@unerr-ai/econ{,-<target>}/  — ready to publish.
//   Publish platform packages FIRST, then the wrapper, so the wrapper's
//   optionalDependencies resolve immediately.
//
// Optional key bundling: if ECON_BUNDLED_OPENROUTER_KEY is set in the build
// env, its value is injected into the wrapper shim in place of the inert
// sentinel. Absent it, the shim ships with no bundled key. SECURITY: only
// bundle a key into a PRIVATE package or a dedicated spend-capped key — a
// bundled key in a public package is world-readable.
// ---------------------------------------------------------------------------

import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

// The token in wrapper/bin/econ.js that carries the (optional) bundled key.
const KEY_SENTINEL = "__ECON_BUNDLED_OPENROUTER_KEY__";

// ---------------------------------------------------------------------------
// Target definitions — one entry per platform package.
//   key      — the <os>-<arch> suffix used in the package name and binary file
//   npmOs    — value for the npm `os` field  (npm's platform string)
//   npmCpu   — value for the npm `cpu` field
//   binSrc   — filename under dist/bin/       (source produced by the workflow)
//   binDest  — filename written inside the staged package's bin/ dir
// ---------------------------------------------------------------------------
const TARGETS = [
  { key: "darwin-x64", npmOs: "darwin", npmCpu: "x64", binSrc: "econ-darwin-x64", binDest: "econ" },
  { key: "darwin-arm64", npmOs: "darwin", npmCpu: "arm64", binSrc: "econ-darwin-arm64", binDest: "econ" },
  { key: "linux-x64", npmOs: "linux", npmCpu: "x64", binSrc: "econ-linux-x64", binDest: "econ" },
  { key: "linux-arm64", npmOs: "linux", npmCpu: "arm64", binSrc: "econ-linux-arm64", binDest: "econ" },
  { key: "windows-x64", npmOs: "win32", npmCpu: "x64", binSrc: "econ-windows-x64.exe", binDest: "econ.exe" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function copyFile(src, dest) {
  // Stream so large binaries don't get buffered in memory.
  await mkdir(path.dirname(dest), { recursive: true });
  await pipeline(createReadStream(src), createWriteStream(dest));
}

function fillTemplate(template, replacements) {
  let out = template;
  for (const [key, value] of Object.entries(replacements)) {
    out = out.replaceAll(key, value);
  }
  return out;
}

async function resolveVersion() {
  // 1. CLI arg
  const arg = process.argv[2];
  if (arg && /^\d+\.\d+\.\d+/.test(arg)) return arg;

  // 2. Env var
  if (process.env.ECON_VERSION) return process.env.ECON_VERSION;

  // 3. Root package.json
  const pkg = JSON.parse(await readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
  if (!pkg.version || pkg.version === "0.0.0") {
    throw new Error("Could not resolve version. Pass it as the first argument or set ECON_VERSION.");
  }
  return pkg.version;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const version = await resolveVersion();
  console.log(`Building econ npm packages for version: ${version}`);

  const outRoot = path.join(__dirname, "dist");
  // Clean previous staging output so stale binaries don't persist.
  await rm(outRoot, { recursive: true, force: true });

  // Load the platform package.json template (drop the human _comment field).
  const templateObj = JSON.parse(
    await readFile(path.join(__dirname, "platform-template", "package.json"), "utf8")
  );
  delete templateObj._comment;
  const templateStr = JSON.stringify(templateObj, null, 2);

  const publishCommands = [];

  // ---- Platform packages --------------------------------------------------
  for (const target of TARGETS) {
    const pkgName = `@unerr-ai/econ-${target.key}`;
    const pkgDir = path.join(outRoot, pkgName);
    const binDir = path.join(pkgDir, "bin");

    console.log(`  staging ${pkgName} ...`);
    await mkdir(binDir, { recursive: true });

    const binSrcPath = path.join(REPO_ROOT, "dist", "bin", target.binSrc);
    const binDestPath = path.join(binDir, target.binDest);
    await copyFile(binSrcPath, binDestPath);

    // Mark executable (no-op / harmless on Windows).
    if (!target.binDest.endsWith(".exe")) {
      await chmod(binDestPath, 0o755);
    }

    const filled = fillTemplate(templateStr, {
      __PKG_NAME__: pkgName,
      __VERSION__: version,
      __OS__: target.npmOs,
      __CPU__: target.npmCpu,
      __DESCRIPTION__: `The econ native binary for ${target.key}`,
    });
    await writeFile(path.join(pkgDir, "package.json"), filled + "\n", "utf8");

    publishCommands.push(`npm publish ${path.relative(process.cwd(), pkgDir)} --access public`);
  }

  // ---- Wrapper package ----------------------------------------------------
  const wrapperSrcDir = path.join(__dirname, "wrapper");
  const wrapperDestDir = path.join(outRoot, "@unerr-ai", "econ");
  const wrapperBinDir = path.join(wrapperDestDir, "bin");

  console.log(`  staging @unerr-ai/econ (wrapper) ...`);
  await mkdir(wrapperBinDir, { recursive: true });

  // Copy the shim, injecting the (optional) bundled OpenRouter key. The
  // committed source carries the inert sentinel; we always replace it so a
  // published package never ships the raw token.
  const bundledKey = process.env.ECON_BUNDLED_OPENROUTER_KEY ?? "";
  if (bundledKey) {
    console.log("  ⚠ bundling an OpenRouter key into the wrapper (value hidden).");
    console.log("    Ensure this package is published PRIVATE or the key is spend-capped.");
  } else {
    console.log("  no bundled key — users supply their own OPENROUTER_API_KEY.");
  }
  const shimSrc = await readFile(path.join(wrapperSrcDir, "bin", "econ.js"), "utf8");
  const shimOut = shimSrc.replaceAll(KEY_SENTINEL, bundledKey);
  await writeFile(path.join(wrapperBinDir, "econ.js"), shimOut, "utf8");
  await chmod(path.join(wrapperBinDir, "econ.js"), 0o755);

  // Build the wrapper package.json: fill version + optionalDependencies.
  const wrapperPkg = JSON.parse(await readFile(path.join(wrapperSrcDir, "package.json"), "utf8"));
  wrapperPkg.version = version;
  const optDeps = {};
  for (const target of TARGETS) {
    optDeps[`@unerr-ai/econ-${target.key}`] = version;
  }
  wrapperPkg.optionalDependencies = optDeps;
  await writeFile(
    path.join(wrapperDestDir, "package.json"),
    JSON.stringify(wrapperPkg, null, 2) + "\n",
    "utf8"
  );

  publishCommands.push(`npm publish ${path.relative(process.cwd(), wrapperDestDir)} --access public`);

  // ---- Summary ------------------------------------------------------------
  console.log(`\nStaging complete. Publish in this order:\n`);
  for (const cmd of publishCommands) console.log(`  ${cmd}`);
  console.log(
    `\nNote: publish platform packages first so the wrapper's optionalDependencies\n` +
      `resolve immediately after the wrapper is published.\n`
  );
}

main().catch((err) => {
  process.stderr.write(`build-npm-packages: ${err.message}\n`);
  process.exit(1);
});
