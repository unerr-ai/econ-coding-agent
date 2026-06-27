# S7.4 — unified login: the unerr credential seam

Goal: one token = econ + unerr. Reuse unerr's credential core + device-flow so a
single login authenticates both the agent and the unerr brain. This doc maps
OpenCode's auth path and names the exact integration point to scaffold against.

## Recon: OpenCode's auth/credential path

- **Credential storage** — `packages/core/src/credential.ts` (+
  `packages/core/src/credential/sql.ts`). SQLite via Drizzle. `Credential.Service`
  (Effect): `all()`, `list(integrationID)`, `get(id)`, `create()`, `update()`,
  `remove()`. Token shapes:
  - `Credential.OAuth` = `{ type: "oauth", methodID, refresh, access, expires, metadata? }`
  - `Credential.Key`   = `{ type: "key", key, metadata? }`
  - wrapped as `Credential.Info` = `{ id, integrationID, label, value }`.
- **Login / OAuth flow** — `packages/core/src/integration.ts`:
  `Integration.connection.oauth({ integrationID, methodID, inputs, label? })` →
  `Attempt`; `Integration.attempt.complete({ attemptID, code? })` stores the
  credential. **No device-flow yet** — only code-based OAuth.
- **Provider token resolution at request time** —
  `packages/llm/src/route/auth.ts`. `credentialFromSecret(secret, name)` (~L76),
  `Auth.config(name)` (~L92, reads env via `Config.redacted`), `Auth.bearer(...)`
  builds the `Authorization` header. The request runs in
  `packages/llm/src/route/executor.ts`.
- **`packages/identity`** — empty (only image assets). Not a code seam.

## The seam (where unerr credentials plug in)

**Primary — provider auth resolver:**
`packages/llm/src/route/auth.ts :: credentialFromSecret()`.

Wrap it with a resolver that, before falling back to `Config.redacted()`, checks
for a unerr-managed source (e.g. a `"unerr:"`-prefixed secret name or a
unerr-aware `Config` source) and, when matched, fetches the token from the unerr
sidecar over **UDS** (the `unerrd` Node sidecar the architecture already runs).
Both branches return `Redacted.Redacted`, so no caller changes — the LLM request
machinery is untouched. This is the single point where "one token" reaches every
model call.

**Secondary — unified login command / device-flow:**
`packages/core/src/integration.ts` (the OAuth attempt flow) is where a unerr
**device-flow** would be added as a new method: kick off the unerr device code,
poll, and on success persist via `Credential.Service.create()` as a
`Credential.OAuth`. A thin `login` command (in `packages/cli`) would drive it.
unerr's existing `credentials` core + device-flow (sibling `../unerr-cli`)
supplies the device-code implementation to reuse rather than rebuild.

## Recommended scaffold order (later sprint)

1. Add a `unerr` integration descriptor + a **device-flow** method alongside the
   OAuth method in `integration.ts`; persist the returned token as
   `Credential.OAuth` (refresh/access/expires) via `Credential.Service`.
2. Extend `credentialFromSecret()` in `llm/src/route/auth.ts` to resolve a
   unerr-managed credential from the sidecar (UDS) → `Redacted`.
3. Add a `login` command in `packages/cli` that runs the device-flow once and
   stores the unified token; the same token then satisfies both econ model calls
   and unerr brain auth.

All three are outside Sprint 7's ownership boundary (they edit
`packages/llm/src/route/auth.ts`, `packages/core/src/integration.ts`,
`packages/cli`); this doc is the scaffold/seam handoff, not an implementation.
