# How econ runs

econ is a coding agent built on the [OpenCode](https://github.com/anomalyco/opencode)
base — a TypeScript monorepo running on **Bun**, with a decoupled **Go TUI**. The CLI
behaves like Claude Code: run it with no arguments and you get an interactive
terminal agent; run it with a subcommand and it acts as a normal CLI.

> The user-facing product is **econ**, but the binary, command name, `.opencode/`
> config dir, and `opencode.json` are still named `opencode` (the rebrand is
> display-strings only — the identifiers must stay verbatim or the build/runtime
> breaks). So the command you type is `opencode`.

---

## Prerequisites

| Tool | Version used here | Needed for |
|---|---|---|
| [Bun](https://bun.sh) | `1.3.14` | backend, tools, running the TS directly |
| Node | `25.x` | some native deps / sidecar |
| Go | `1.25.x` | compiling / running the TUI |

**Bun runs TypeScript directly — you do not need a build step to run the agent.**
A build is only needed to produce a standalone distributable binary.

---

## Install

```bash
bun install          # from the repo root — installs the whole workspace
```

---

## Run the interactive agent (the Claude Code equivalent)

Bare invocation launches the **TUI** in the current directory (this is the default
command — `command: "$0 [project]"` in `packages/opencode/src/cli/cmd/tui.ts`).

```bash
# dev — no build, Bun executes the TypeScript entrypoint
bun run dev                     # from repo root → launches the TUI in cwd

# or run the built binary (see "Build" below)
./packages/opencode/dist/opencode-darwin-arm64/bin/opencode
```

Scope the TUI to a specific project directory:

```bash
opencode ~/path/to/project
```

### Make `opencode` callable anywhere

The built binary is standalone (~124 MB, no runtime deps). Symlink it onto your PATH:

```bash
ln -sf "$(pwd)/packages/opencode/dist/opencode-darwin-arm64/bin/opencode" /usr/local/bin/opencode
opencode          # now works from any directory
```

---

## First-run setup — pick a model

The agent needs a model provider configured before it's useful (this is where
econ's cost-routing / OpenRouter setup plugs in):

```bash
opencode auth login     # configure provider credentials / API key
opencode models         # list available models
opencode providers      # list configured providers
```

---

## Commands

Defined in `packages/opencode/src/index.ts` (yargs, scriptName `opencode`).

| Command | What it does |
|---|---|
| `opencode` *(default)* | Start the interactive **TUI** |
| `opencode run [message]` | **Headless** — run a single prompt non-interactively (scripting / CI) |
| `opencode serve` | Run the backend server (HTTP API) headless |
| `opencode web` | Launch the web UI |
| `opencode auth` *(a.k.a. account/console)* | Login / manage provider credentials |
| `opencode providers` | List / manage configured providers |
| `opencode models` | List available models |
| `opencode agent` | Manage agents |
| `opencode mcp` | Manage MCP servers |
| `opencode session` | Manage sessions |
| `opencode export` | Export sessions |
| `opencode import` | Import sessions |
| `opencode github` | GitHub integration |
| `opencode pr` | Pull-request integration |
| `opencode stats` | Usage / cost stats |
| `opencode acp` | Agent Client Protocol server |
| `opencode attach` | Attach to a running session |
| `opencode tui` | Explicitly start the TUI |
| `opencode plugin` | Manage plugins |
| `opencode db` | Open an interactive sqlite shell / run a query |
| `opencode debug` | Debug utilities |
| `opencode generate` | Codegen |
| `opencode upgrade` | Self-update |
| `opencode uninstall` | Uninstall |
| `opencode completion` | Generate a shell-completion script |

### Global flags (work on any command)

| Flag | Effect |
|---|---|
| `--help`, `-h` | Show help |
| `--version`, `-v` | Show version |
| `--print-logs` | Print logs to stderr |
| `--log-level DEBUG\|INFO\|WARN\|ERROR` | Set log level |
| `--pure` | Run without external plugins |

---

## Build (produce a standalone binary)

Only needed for distribution — running via `bun run dev` needs no build.

```bash
cd packages/opencode

bun run build --single                    # native binary for the current platform
bun run build --single --skip-embed-web-ui  # faster; skips embedding the web UI
bun run build                             # cross-compile all platform targets
```

`--single` builds the web UI, compiles a standalone binary into
`dist/opencode-<os>-<arch>/bin/opencode`, and runs a `--version` smoke test.

> The build script runs `bun install --os="*" --cpu="*" …` to pull cross-platform
> native deps (`@opentui/core`, `@parcel/watcher`, `@ff-labs/fff-bun`), which
> re-saves `bun.lock`. That's expected.

---

## Other dev / verification commands (from the root `package.json`)

| Command | What it does |
|---|---|
| `bun run typecheck` | Typecheck the whole workspace (turbo, cached) — the "build check" for this TS repo |
| `bun run lint` | Lint with oxlint |
| `bun run dev` | Run the agent (TUI) from source |
| `bun run dev:web` | Web UI dev server (`packages/app`) |
| `bun run dev:desktop` | Desktop app dev |
| `bun test` | Run tests (from inside a package — **not** the repo root) |

---

## Repo layout (the packages you'll touch most)

- `packages/opencode` — the CLI/agent entrypoint (`src/index.ts`), tools, session loop
- `packages/tui` — the Go terminal UI (kept as-is from OpenCode)
- `packages/core` — engine / config / shared cores
- `packages/llm` — model selection → econ's router
- `packages/app` — web UI (embedded into the binary at build time)
- `packages/code-intelligence` — context-engineering / call-graph layer
