# capability-registry-11: Expose Adepthood as an MCP server (external control surface)

**Labels:** `enhancement`, `architecture`, `backend`, `mcp`, `capability-registry`
**Epic:** [The Capability Registry](capability-registry-epic.md)
**Depends on:** 05, 08
**Estimated LoC:** ~350

## Role

You are a backend engineer building the *outward* half of the MCP story. 08/09
make Adepthood an MCP **client** (it calls the Creek Vault). This issue makes
Adepthood an MCP **server**: the capability registry, exposed as tools, so
external agents — Claude Desktop/Code, a crawdad-style bot, and eventually an
Apple Shortcuts bridge — can reference and drive the app from outside. This is
the concrete on-ramp for "talk to other apps."

## Context

The Creek Vault's `creek-tools-mcp` is the house precedent to mirror
(verified): FastMCP on the official `mcp` SDK, `stdio` + `streamable-http`
transports, bearer-token auth (`ConsumerTokenVerifier`), a per-call `consumer`
audit id, and a **tier-ceiling model where intimate content is unreachable
remotely**. Adepthood's server should feel like a sibling of that server —
same SDK (added in 08), same naming style (`adepthood.{capability}.{verb}`),
same audit/tier discipline. Tool schemas already exist: 08's
`tool_schema(cap, verb)` generates them from the registry.

## Goal

A FastMCP server exposing (a) **read tools** — wheel balance, habit/practice
summaries, suggestion inbox — and (b) **write tools** — one per registered
capability verb — under per-token scopes, with journal privacy tiers enforced
exactly as the Vault enforces its own. Consent is structural: a user *mints* a
scoped token; the scopes are the standing consent.

## Consent model (the design decision this ticket owns)

The in-app rule is "the model proposes, the user accepts." An external caller
is different: when the *user themselves* triggers a Shortcut ("log my
meditation"), the trigger **is** the confirmation — forcing a second in-app
accept would break the automation they explicitly built. So:

- **Scoped tokens:** the user mints a token in Settings, choosing per-verb
  scopes (e.g. `habit.complete`, `self_care.log`, `read:wheel`). Scope grants
  direct execution of exactly those verbs — nothing else.
- **Out-of-scope write calls** are refused (structured error), NOT silently
  queued. An agent that wants more must ask the user for a broader token.
- **Optional `propose` mode:** a token can be minted propose-only, where write
  calls land as pending `ActionSuggestion`s in the inbox instead of executing —
  the right default for autonomous agents vs user-triggered Shortcuts.
- **Privacy tiers:** journal read tools (if scoped at all) serve only
  `public`-classified content remotely; `personal` requires an explicit scope;
  `intimate` is **never served over MCP** (mirror the Vault's
  `_REMOTE_ADMITTED_CEILINGS` cap and Adepthood's #895 floor).

## Tasks

1. **Server module** (`backend/src/services/mcp_server.py`): FastMCP app named
   `adepthood-mcp`; register read tools + one tool per capability verb from the
   registry (08's schemas). Run as `streamable-http` mounted/co-deployed with
   the FastAPI app (or a separate entry point — decide in PR); `stdio` for
   local dev.
2. **Token model + auth:** `McpToken` (user FK, hashed secret, `scopes:
   list[str]`, `mode: execute|propose`, `created_at`, `revoked_at`) + a
   verifier in the FastMCP auth hook (mirror `ConsumerTokenVerifier`). Mint /
   list / revoke endpoints under the existing auth'd user routes; secrets shown
   once (house `detect-secrets` discipline).
3. **Dispatch:** scoped `execute`-mode call → the capability's `execute` (05)
   with full ownership validation, exactly as an accepted suggestion would;
   `propose`-mode call → pending `ActionSuggestion` (no journal anchor —
   `anchor_*` nullable or a distinct `origin: journal|external` column, small
   03 follow-up). Log every call with the token id + `consumer` string.
4. **Read tools:** `adepthood.wheel.read` (from `domain/wheel.py`),
   `adepthood.habits.summary`, `adepthood.suggestions.list` — read scopes,
   remote tier rules applied.
5. **Settings UI:** minimal token management screen (mint with scope picker,
   list, revoke) under the existing Settings hub.
6. **Docs:** `docs/mcp-server.md` — connecting from Claude Desktop/Code
   (`.mcp.json` example) and the Shortcuts path (Shortcuts → HTTPS call → the
   streamable-http endpoint; note a native Shortcuts bridge as future work).
7. **Tests:** scope enforcement (out-of-scope refused); propose vs execute
   modes; intimate never served; revoked token dead; ownership holds when the
   token's user differs from the target's owner.

## Acceptance Criteria

- [ ] Tools are generated from the registry — a new capability (e.g. 10's `self_care.log`) appears as an MCP tool with zero server-code edits.
- [ ] Scope model enforced: out-of-scope writes refused; propose-mode lands suggestions; execute-mode runs the standard `execute` path with ownership checks.
- [ ] Intimate-tier content is unreachable over MCP; personal requires explicit scope.
- [ ] Tokens are mintable/revocable in Settings; secrets stored hashed; every call audited.
- [ ] A Claude Desktop/Code client can connect and drive a scoped verb end to end (documented walkthrough).
- [ ] `pytest backend/` + frontend suite + `pre-commit run --all-files` green.

## Files

| File | Action |
|------|--------|
| `backend/src/services/mcp_server.py` | **Create** |
| `backend/src/models/mcp_token.py` | **Create** |
| `backend/src/routers/mcp_tokens.py` | **Create** |
| `backend/migrations/versions/<rev>_mcp_tokens.py` | **Create** |
| `frontend/src/features/Settings/` | Modify (token management) |
| `docs/mcp-server.md` | **Create** |
| `backend/tests/test_mcp_server.py` | **Create** |

## Constraints

- Mirror the Vault's discipline: per-call consumer/audit id, tier ceilings,
  refuse-don't-downgrade. The two servers should read as siblings.
- No ambient authority: every tool call is authenticated, scoped, and executed
  as the token's user — never as an admin context.
- Apple Shortcuts native bridge (an Intents app extension) is out of scope;
  this issue delivers the HTTPS endpoint Shortcuts can already call.
