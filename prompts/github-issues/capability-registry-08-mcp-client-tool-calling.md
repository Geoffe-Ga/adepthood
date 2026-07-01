# capability-registry-08: Provider tool-calling + MCP client seam

**Labels:** `enhancement`, `architecture`, `backend`, `mcp`, `capability-registry`
**Epic:** [The Capability Registry](capability-registry-epic.md)
**Depends on:** 05
**Estimated LoC:** ~300

## Role

You are a backend engineer giving the LLM layer structured *tools* while keeping
every action behind a human-confirmed suggestion. Two distinct mechanisms, one
schema source:

- **In-process (this app's own LLM calls):** use the providers' **native
  tool-use APIs** (Anthropic/OpenAI `tools` parameter). MCP is unnecessary
  overhead for in-process capabilities.
- **Cross-process (remote servers, e.g. the Creek Vault):** an **MCP client**
  seam using the official `mcp` Python SDK — the same SDK the Vault's server is
  built on (`mcp.server.fastmcp`, verified in `geoffe-ga/creek-vault`
  `creek-tools/creek_mcp/server.py`).

Both take their schemas from the capability registry (01) — no hand-written
tool definitions anywhere.

## Context (verified)

The LLM layer is pure text-in/text-out today: `_call_openai` /
`_call_anthropic` pass no `tools` parameter, and the injected seam is

```python
class ResonanceLLM(Protocol):
    """Minimal injected LLM seam: prompt in, raw completion text out."""
    async def complete(self, prompt: str) -> str: ...
```

(`backend/src/domain/resonance.py:52-55`). Detection therefore parses JSON out
of prose (`domain/detection.py`), which works but is weaker than native
tool-use: no schema enforcement at the API layer, and no path to remote tools.

## Goal

(a) Generate tool schemas from capability `params_model`s (JSON Schema); (b)
add a tool-loop path to the provider layer so tool-capable models emit
capability invocations as structured tool calls; (c) map every tool call to a
`(capability_key, verb, params)` triple validated against the registry and
landed as a **pending** `ActionSuggestion` (03) — never an execution; (d) stand
up the MCP **client** seam for remote servers (consumed by 09), off by default.

## Tasks

1. **Schema generation** in `domain/capabilities.py`: `tool_schema(cap, verb)`
   → JSON Schema from the verb's Pydantic `params_model`
   (`model_json_schema()`), tool name `f"{cap.key}.{verb.name}"`. One source of
   truth for provider tools, MCP client expectations, and (later, ticket 11)
   the outbound MCP server.
2. **Widen the LLM seam:** add a tool-aware variant alongside `ResonanceLLM` —
   e.g. `ToolCallingLLM` with
   `complete_with_tools(prompt, tools) -> ToolLoopResult` (final text + zero or
   more validated tool calls). The existing `complete()` path stays untouched;
   the stub provider implements only `complete()`.
3. **Provider layer:** pass registry-generated `tools` to Anthropic/OpenAI when
   the provider supports it; run the standard tool-use loop; collect tool calls
   *as data* (do not execute inside the loop). When the provider/tier can't
   tool-call, fall back to the conversational JSON detection (04) — identical
   behaviour, no regression.
4. **Trust boundary:** each collected tool call is validated exactly like a
   detection hit — known capability, allowed verb, `extra="forbid"` params —
   then persisted as a pending `ActionSuggestion`. Unknown/malformed calls are
   dropped and logged. `MEDICATION_GUARDRAIL` and the care-only early return
   (04) apply unchanged.
5. **MCP client seam** (`backend/src/services/mcp_client.py`): connect to
   configured remote servers (env `MCP_SERVERS`; `streamable-http` + bearer
   token to match the Vault's `ConsumerTokenVerifier`, `stdio` for local dev),
   list their tools, and expose them behind the same validation boundary.
   **No servers configured by default; no journal text leaves the app in this
   issue** — 09 does the first real binding with its own consent gates.
6. **Tests:** schema generation from params models; simulated tool-calling
   provider → pending suggestion; stub provider unaffected; malformed/unknown
   tool calls dropped; MCP client against an in-test FastMCP fixture server.

## Acceptance Criteria

- [ ] Tool schemas are generated from the registry — zero hand-written tool defs.
- [ ] A tool call becomes a **pending** `ActionSuggestion`; nothing executes without an accept (05).
- [ ] Non-tool providers (incl. stub) keep today's behaviour byte-for-byte.
- [ ] Unknown tools/verbs/params are rejected and logged (trust model intact).
- [ ] MCP client connects to a test server; ships with no servers configured.
- [ ] `pytest backend/` + `pre-commit run --all-files` green; coverage/complexity unchanged.

## Files

| File | Action |
|------|--------|
| `backend/requirements.txt` | Modify (add `mcp`) |
| `backend/src/domain/capabilities.py` | Modify (tool_schema) |
| `backend/src/domain/resonance.py` | Modify (ToolCallingLLM protocol) |
| `backend/src/services/botmason.py` | Modify (tool loop per provider) |
| `backend/src/services/mcp_client.py` | **Create** |
| `backend/tests/test_tool_calling.py` | **Create** |
| `backend/tests/test_mcp_client.py` | **Create** |

## Constraints

- Native tool-use for in-process; MCP only across a process boundary. Do not
  wrap local capabilities in MCP for the app's own LLM calls.
- The tool loop must respect the existing wallet/usage accounting — a tool-use
  round trip is still one metered resonance interaction.
- No new autonomy: the model proposes, the registry validates, the user accepts.
