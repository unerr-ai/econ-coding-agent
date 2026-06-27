# S8.2 — "One deployment" packaging

**Status: BUILT + VERIFIED. A single self-contained backend binary is producible today.**

## Goal

Ship the econ backend as **one process / one artifact** — no Node runtime, no per-file
source tree — using Bun's `bun build --compile`.

## What exists

`packages/opencode/script/build.ts` already compiles standalone binaries via
`Bun.build({ compile: {...} })` for every platform. Flags: `--single` (current platform
only), `--baseline`, `--skip-install`, `--sourcemaps`, `--skip-embed-web-ui`. It runs a
`--version` smoke test when building for the current platform. Output:
`packages/opencode/dist/<name>/bin/opencode`.

## New: `script/build-econ-binary.ts`

A thin econ wrapper (`script/build-econ-binary.ts`, NEW) that delegates to the existing
build with `--single --skip-install`, locates the produced binary, and prints a one-process
summary. `--skip-install` is mandatory in our workflow (we must not run `bun install`); it
relies on already-present platform deps. Passes through `--baseline` / `--sourcemaps`.

```
bun run script/build-econ-binary.ts            # current platform, one binary
bun run script/build-econ-binary.ts --baseline # add baseline (non-AVX2) variant
```

## Verified build result (this sprint, darwin-arm64)

| Item | Result |
|---|---|
| Command | `bun run script/build.ts --single --skip-install` |
| Outcome | **SUCCESS** (~12s) |
| Binary | `packages/opencode/dist/opencode-darwin-arm64/bin/opencode` |
| Size | 124 MB, self-contained, executable |
| Smoke test (`--version`) | **PASSED** (`0.0.0-main-202606271731`) |
| `packages/sdk` dirtied | No |

The backend runs as **one self-contained process — no Node runtime required**. Note the
architecture's **unerr-brain stays a separate Node sidecar** (`unerrd` + per-repo proxy,
native addons over UDS); "one deployment" here means the *backend* is one binary, not that
the brain is folded into it. Folding the brain in is out of scope (native addons can't
`--compile` cleanly).

## tree-sitter `.wasm` bundling verdict (the day-0 question)

**Verdict: the tree-sitter `.wasm` grammars do NOT bundle into a `--compile` binary today,
and that is currently fine because the code runs on the regex fallback.**

Evidence and reasoning:

- **No `.wasm` embeds in the produced binary.** `find dist -name '*.wasm'` after a successful
  build returned **nothing**.
- **Current real state = regex fallback.** `packages/code-intelligence/src/tree-sitter-loader.ts`
  does a *dynamic* `import("web-tree-sitter")` and resolves grammars at **runtime** via
  `import.meta.resolve("tree-sitter-wasms/out/<grammar>.wasm")`, with a graceful fallback to
  the regex extractor. The grammar package **`tree-sitter-wasms` is NOT installed**
  (`web-tree-sitter` core *is* installed locally). So AST extraction already runs on the
  regex path — the compiled binary inherits that and works.
- **Why wasm would not bundle even if installed.** `bun build --compile` embeds *statically
  imported* assets into the `bunfs`. The loader resolves grammar paths as **runtime strings**
  (`import.meta.resolve(...)` → a `node_modules` filesystem path) and calls
  `Language.load(path)`. Inside a standalone binary that `node_modules` path does not exist,
  so the load fails and the code falls back to regex. `web-tree-sitter`'s own runtime
  `tree-sitter.wasm` (loaded by `TS.init()`) has the same problem.

### To make WASM work inside a `--compile` binary (GATED, future)

1. `bun add web-tree-sitter tree-sitter-wasms` in `packages/code-intelligence`.
2. Change the loader from runtime `import.meta.resolve` path-strings to **static**
   `import grammarTs from "tree-sitter-wasms/out/tree-sitter-typescript.wasm"` style imports
   so Bun embeds each grammar into `bunfs` — then hand the embedded bytes to
   `Language.load`. Same treatment for `web-tree-sitter`'s runtime `tree-sitter.wasm`.
3. Re-build with `--single` and re-check `find dist -name '*.wasm'` (or, with embedding,
   confirm via a parse smoke test that `wasmAvailable === true`).

This is deferred: the regex extractor is sufficient for current routing/risk signals, and
the binary ships and runs without it. Tracked here as the upgrade path, not a blocker.
