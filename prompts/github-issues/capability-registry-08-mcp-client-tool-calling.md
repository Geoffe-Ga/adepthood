# capability-registry-08: MCP client + tool-calling in the LLM layer

**Labels:** `enhancement`, `architecture`, `backend`, `mcp`, `capability-registry`
**Epic:** [The Capability Registry](capability-registry-epic.md)
**Depends on:** 05
**Estimated LoC:** ~300

## Role

You are a backend engineer adding the Model Context Protocol seam the north star
names but the code does not yet have (`NORTH-STAR.md:70`). The LLM today is
purely conversational — it returns JSON the server parses
(`services/botmason.py:99-123`, no tool-calling). You give it *tools*, sourced
from the capability registry, while keeping every action behind a human-confirmed
suggestion.

## Goal

Expose registered capabilities as **MCP tools** so a tool-capable provider can
propose capability invocations as structured tool calls instead of hand-parsed
JSON — and stand up an MCP **client** seam so those tools can be served either
in-process (local capabilities) or, later, by a remote server (Creek Vault, 09).
Tool calls do not execute anything; they resolve to `ActionSuggestion`s (03) the
user still accepts (05).

## Context

The provider layer (`PROVIDER_REGISTRY`) abstracts openai/anthropic/stub. Both
real SDKs support tool-calling; the stub does not. The capability registry (01)
already describes verbs + params schemas — exactly what an MCP/tool schema needs.

## Tasks

1. **Add an MCP client dependency** (Python `mcp` SDK) to
   `backend/requirements.txt`, pinned; document it in the deploy notes.
2. **`backend/src/services/mcp_client.py`:** a thin seam that (a) can register
   **local** capability verbs as MCP tools (name = `f"{key}.{verb}"`, input
   schema = the capability's params model JSON schema), and (b) can connect to a
   **remote** MCP server by config (URL/stdio + auth) — remote wiring is stubbed
   here and completed in 09. Config via env (`MCP_SERVERS=...`), off by default.
3. **Tool-calling path in botmason:** when the active provider supports tools,
   pass the local capability tool schemas; map any tool call the model makes to a
   `(capability_key, verb, params)` triple, **validate against the registry**,
   and hand it to the detection→suggestion path so it lands as a *pending*
   `ActionSuggestion`. When the provider can't tool-call (stub, or a text-only
   tier), fall back to the current conversational/JSON detection (04) — no
   regression.
4. **Guardrails:** tool calls are proposals, never executions; `MEDICATION_GUARDRAIL`
   and distress suppression still apply; privacy floor — the tool path sends no
   more of the entry than the conversational path already does, and never sends
   to a *remote* server in this issue.
5. **Tests:** local tool schemas generate from the registry; a simulated
   tool-calling provider produces a pending suggestion; stub provider still uses
   the JSON path; malformed/unknown tool calls are dropped (trust model).

## Acceptance Criteria

- [ ] Capabilities are exposed as local MCP tools generated from their params schemas — no hand-written tool defs.
- [ ] A tool-capable provider's tool call becomes a **pending** `ActionSuggestion`, never an auto-execution.
- [ ] Non-tool providers fall back to conversational detection with no behaviour change.
- [ ] Unknown/invalid tool calls are rejected (index+verb+params trust model preserved).
- [ ] Remote MCP is present but **off by default**; no journal text leaves the app in this issue.
- [ ] `pytest backend/` + `pre-commit run --all-files` green; coverage/complexity unchanged.

## Files

| File | Action |
|------|--------|
| `backend/requirements.txt` | Modify (add `mcp`) |
| `backend/src/services/mcp_client.py` | **Create** |
| `backend/src/services/botmason.py` | Modify (tool-calling path) |
| `backend/src/domain/capabilities.py` | Modify (params → JSON-schema helper) |
| `backend/tests/test_mcp_client.py` | **Create** |
| `backend/tests/test_botmason.py` | Modify (tool path + fallback) |

## Constraints

- **Confirm creek-vault manifest first if 09 is imminent** — see epic open
  questions; the remote transport/auth shape may inform the client seam. Local
  tools are the shippable target here and do not need creek-vault.
- Tool-calling degrades gracefully; the stub provider path must stay fully working.
- No new autonomy: the model proposes, the registry validates, the user accepts.
