# S7.2 — status-line surface decision

## What the status line shows

Three live numbers for econ's proof surface: **context fill**, **cache-hit
ratio**, and **tier in use** (plus cumulative spend / turn count).

## Recon: where status renders in this fork

This fork's TUI is **TypeScript/Solid, not Go**. Status-shaped surfaces found:

- **Event stream (the data spine).** Every turn publishes
  `session.next.step.ended` with `{ cost, tokens: { input, output, reasoning,
  cache: { read, write } } }`
  (`packages/core/src/session/event.ts`, published in
  `packages/core/src/session/runner/publish-llm-event.ts`). Streamed to clients
  via `GET /api/event` (`packages/server/src/groups/event.ts`).
  `session.next.step.started` carries the **model ref** (`{ id, providerID }`).
- **Existing context-fill render.**
  `packages/tui/src/feature-plugins/sidebar/context.tsx` already computes
  context-fill % = `(sum of latest message tokens) / model.limit.context`.
- **Plugin hooks** (`packages/plugin/src/index.ts`, `Hooks` interface): `event`,
  `chat.message`, `chat.params`, `tool.execute.before/after`, etc. **No
  dedicated `statusline` / `status` hook exists.**

## Decision

Surface econ status via a **new `event`-hook plugin**,
`.opencode/plugins/econ-status.js` — auto-discovered, **zero core/TUI changes**,
inside the Sprint 7 ownership boundary.

It tracks the model from `session.next.step.started`, rolls up tokens/cost from
`session.next.step.ended`, infers the tier (name heuristic mirroring
`telemetry.ts::inferTier`), and surfaces
`tier · context-tokens · cache-hit% · spend · turns`. Cache-hit is cumulative
`cacheRead / (cacheRead + input)`.

This is the same event stream the TUI sidebar already consumes, so econ's status
rides alongside the existing context-fill render without forking it.

## Deferred follow-up (needs files outside the S7 boundary)

A first-class, in-footer status field would be cleaner than plugin logging:

1. **A `message.usage` plugin hook** in `packages/plugin/src/index.ts` — fired
   per assistant turn with `{ usage, tier }`, returning a `statusLine` string.
   (Edits a forbidden core-adjacent file.)
2. **A server route** `GET /api/session/:id/status` in
   `packages/server/src/groups/session.ts` aggregating the latest Step.Ended
   usage + econ tier, which the TUI footer reads.
3. **Precise context-fill %** needs the active model's `limit.context` (from
   provider config). The plugin reports raw latest-token count; the TUI sidebar
   already converts tokens→% and is the right place to add econ's tier badge.

These are tracked for a later sprint; they require touching `packages/plugin`,
`packages/server`, and/or `packages/tui`, which are outside Sprint 7's ownership.
