# Contributing to econ

econ is an economical, multi-tier coding agent (an OpenCode fork) — see [README.md](./README.md) and [docs/architecture/ECON_ARCHITECTURE.md](./docs/architecture/ECON_ARCHITECTURE.md) for the full picture.

## Types of contributions welcome

- Bug fixes
- New model-provider or tier support
- Context-engine improvements (call-graph, semantic slicing, token reduction)
- Cost-routing improvements (escalation logic, hysteresis, triage)
- Documentation improvements

## Dev setup

This is a **Bun workspace** — do not use pnpm or npm.

```bash
# Install all dependencies
bun install

# Build the product binary
bun turbo build --filter=opencode

# Typecheck
bun turbo typecheck

# Lint (oxlint)
bun run lint

# Tests — run PER PACKAGE, not from the repo root
# (the root bunfig.toml blocks running tests from root — do NOT run `bun test` at the repo root)
cd packages/code-intelligence && bun test
```

### Dev server

```bash
bun dev              # Start econ TUI in packages/opencode
bun dev <directory>  # Start TUI in a specific directory
bun dev serve        # Start headless API server (port 4096)
bun dev serve --port 8080
```

### Building a standalone binary

```bash
./packages/opencode/script/build.ts --single
# Output: ./packages/opencode/dist/opencode-<platform>/bin/opencode
```

## Architecture & where things live

| Path | What's there |
|---|---|
| `packages/code-intelligence/` | Cost-routing engine + context-intelligence (call graph, semantic slicing) |
| `opencode.json` | Tier wiring — which model runs at which tier |
| `.opencode/plugins/` | Plugins and hooks |
| `packages/opencode/` | Core server business logic (Hono API, tools, session) |
| `docs/architecture/` | Design decisions and architecture docs |
| `docs/sprint*/` | Per-sprint build notes |

Point new contributors at `docs/architecture/ECON_ARCHITECTURE.md` first.

## Commit and PR conventions

**Conventional commits:** `type(scope): summary`

Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`

Scopes: `core`, `opencode`, `tui`, `code-intelligence`, `llm`, `plugin`

Examples:
- `feat(code-intelligence): add blast-radius escalation signal`
- `fix(opencode): resolve crash when session state is nil`
- `docs: update architecture decision record`

**Branch names:** short, hyphenated, no `feat/` prefix — e.g. `add-tier-routing`, `fix-session-crash`.

## PR expectations

- Keep PRs small and focused — one concern per PR.
- Reference an issue where one exists (`Fixes #123`).
- For logic changes, explain what you tested and how a reviewer can reproduce.
- For UI changes, include before/after screenshots or a short video.
- Write short, focused PR descriptions in your own words — AI-generated walls of text will be ignored.

## Upstream

econ is a fork of [OpenCode](https://github.com/anomalyco/opencode) (MIT). If your fix is not econ-specific, consider contributing it upstream as well.
