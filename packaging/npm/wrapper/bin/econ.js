#!/usr/bin/env node
// @ts-check
"use strict";

// econ wrapper shim — resolves the platform-specific binary package and execs
// the native binary, forwarding all argv, stdio, and signals.
//
// Why spawnSync instead of execFileSync:
//   execFileSync captures stdout by default and throws on non-zero exit, which
//   makes correct stdio passthrough and exit-code propagation awkward.
//   spawnSync with { stdio: "inherit" } connects the child directly to the
//   parent's stdin/stdout/stderr file descriptors (no buffering) and returns
//   the exit status as a plain integer, so the exact code is easy to forward.

const { spawnSync } = require("child_process");

// ---------------------------------------------------------------------------
// Bundled OpenRouter key (build-time injection).
//
// The literal token below is replaced by packaging/npm/build-npm-packages.mjs
// at publish time with the value of the ECON_BUNDLED_OPENROUTER_KEY build env
// (empty string when unset). It is NEVER the maintainer's personal ~/.zshrc
// key and is NEVER committed — the committed source always carries the inert
// sentinel, which the guard below treats as "no bundled key".
//
// SECURITY: a non-empty bundled key ships inside a world-readable npm package.
// Only inject one when (a) the package is published PRIVATE, or (b) the key is
// a dedicated, spend-capped OpenRouter key you accept as publicly extractable.
const BUNDLED_OPENROUTER_KEY = "__ECON_BUNDLED_OPENROUTER_KEY__";

function bundledKey() {
  const k = BUNDLED_OPENROUTER_KEY;
  // Inert if still the unreplaced sentinel (running from the raw repo) or empty.
  if (!k || k.indexOf("__ECON_BUNDLED_") === 0) return "";
  return k;
}

const SUPPORTED = [
  "darwin-x64",
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
  "windows-x64",
];

function platformKey() {
  const { platform, arch } = process;

  let os;
  if (platform === "darwin") os = "darwin";
  else if (platform === "linux") os = "linux";
  else if (platform === "win32") os = "windows";
  else os = platform;

  // npm arch strings and Bun target arch strings both use x64/arm64 for the
  // two supported architectures, so no mapping is needed here.
  return `${os}-${arch}`;
}

function resolveBinary() {
  const key = platformKey();
  const pkgName = `@unerr-ai/econ-${key}`;
  const binName = process.platform === "win32" ? "econ.exe" : "econ";
  const subpath = `${pkgName}/bin/${binName}`;

  try {
    return require.resolve(subpath);
  } catch (_) {
    const supported = SUPPORTED.join(", ");
    process.stderr.write(
      `econ: could not find platform package for this system.\n` +
        `  Expected package : ${pkgName}\n` +
        `  Binary path      : ${subpath}\n` +
        `\n` +
        `  Supported platforms: ${supported}\n` +
        `\n` +
        `  musl Linux (Alpine) and Windows on ARM are not supported.\n` +
        `\n` +
        `  On a supported platform, the matching optional dependency may have\n` +
        `  failed to install. Reinstall: npm install -g @unerr-ai/econ\n`
    );
    process.exit(1);
  }
}

const bin = resolveBinary();

// Forward the environment unchanged, except: if a key was bundled at build
// time and the user has not already set OPENROUTER_API_KEY, inject it. An
// explicit user key always wins.
const env = { ...process.env };
const bundled = bundledKey();
if (bundled && !env.OPENROUTER_API_KEY) {
  env.OPENROUTER_API_KEY = bundled;
}

const result = spawnSync(bin, process.argv.slice(2), {
  stdio: "inherit",
  // Pass the current working directory through unchanged so econ can locate
  // the repo it was invoked inside.
  cwd: process.cwd(),
  env,
});

if (result.error) {
  process.stderr.write(`econ: failed to launch binary: ${result.error.message}\n`);
  process.exit(1);
}

process.exit(result.status ?? 1);
