# econ npm packaging

econ ships to npm using the **wrapper + per-platform binary** pattern (the same
one esbuild uses). `npm i -g @unerr-ai/econ` installs a tiny Node shim plus the
single platform package matching the user's os/cpu — no Node-version match, no
native compile.

## Packages

| Package | Contents |
|---|---|
| `@unerr-ai/econ` | wrapper shim `bin/econ.js`; `optionalDependencies` pin the 5 platform packages |
| `@unerr-ai/econ-darwin-arm64` | one compiled native binary, gated by npm `os`/`cpu` |
| `@unerr-ai/econ-darwin-x64` | " |
| `@unerr-ai/econ-linux-x64` | " |
| `@unerr-ai/econ-linux-arm64` | " |
| `@unerr-ai/econ-windows-x64` | " |

At install time npm resolves only the platform package whose `os`/`cpu` match
the machine; the others are skipped (they're *optional* dependencies). The shim
`require.resolve`s `@unerr-ai/econ-<key>/bin/econ` and execs it, forwarding argv,
stdio, and exit code.

## Build

`build-npm-packages.mjs` stages all six packages into `packaging/npm/dist/` from
compiled binaries at `dist/bin/econ-<target>[.exe]`:

```sh
node packaging/npm/build-npm-packages.mjs <version>
```

The release workflow (`.github/workflows/release.yml`) produces those binaries
(via `packages/opencode/script/build.ts`), renames `opencode` → `econ-<target>`,
runs this script, then publishes platform packages first and the wrapper last.

## Publishing (CI)

Publishing is gated by two manual GitHub Environments:

1. **`npm-publish`** — publishes the tagged version under a temporary `pending`
   dist-tag (prereleases go under `beta` and are never promoted).
2. **`npm-promote`** — flips `pending` → `latest`, making it the default
   `npm i -g @unerr-ai/econ` target.

## Bundled OpenRouter key (optional, off by default)

The wrapper shim can inject a default `OPENROUTER_API_KEY` before exec, so users
don't need their own key. It is **disabled unless** the `ECON_BUNDLED_OPENROUTER_KEY`
build env is set at publish time; the committed shim carries only an inert
sentinel and never a real key. An explicit user `OPENROUTER_API_KEY` always wins.

> ⚠ **Security.** A bundled key ships inside the published package. On a **public**
> package it is world-readable and trivially extractable. Only bundle a key when
> the package is published **private**, or when the key is a **dedicated,
> spend-capped** OpenRouter key you accept as publicly exposed. Never set
> `ECON_BUNDLED_OPENROUTER_KEY` to a personal, uncapped key.
