# BotMason, Wallet & LLM Pricing Bug Report — 2026-04-18

**Scope:** `backend/src/services/botmason.py` (719 LOC), `backend/src/services/chat_stream.py` (248 LOC), `backend/src/services/wallet.py` (180 LOC), `backend/src/services/llm_pricing.py` (70 LOC), `backend/src/routers/botmason.py` (170 LOC). Covers chat orchestration, streaming protocol, wallet debits/credits, pricing estimation, and the chat/balance HTTP surface. This is the largest single feature surface and historically the highest-bug-density module in the repo.

**Total bugs: 15 — 2 Critical / 10 High / 3 Medium / 0 Low**

## Executive Summary

1. **Credit-minting + double billing (Critical).** BUG-BM-010: `/user/balance/add` is unauthenticated and unbounded — any caller can mint credits; pairs with BUG-SCHEMA-009. BUG-BM-002: no wallet pre-flight or atomic decrement wraps `generate_response` / `generate_response_stream`, so concurrent chats race the balance.
2. **Charge correctness drift (High).** BUG-BM-003: the 429/5xx retry loop does not record failed-attempt tokens; the wallet drifts from the provider invoice. BUG-BM-008: `estimate_cost_usd` uses `float` arithmetic and silently returns `0.0` for unknown models. BUG-BM-013: failed LLM calls never refund the pre-charged balance. BUG-BM-012: no idempotency on chat spend — double-tap = double bill.
3. **Prompt-injection + system-prompt exfiltration (High).** BUG-BM-004: `_build_messages` replays assistant turns verbatim and only scans the current user message, so a planted adversarial turn (potentially a soft-deleted row, pairs with BUG-JOURNAL-008) is resubmitted every call. BUG-JOURNAL-003 compounds the prompt-injection vector.
4. **Streaming pathology (High).** BUG-BM-006: a dropped client does not cancel the upstream LLM request — user is charged for a stream they will never see. BUG-BM-007: `CollectedStream` buffers the entire provider response before emitting a single SSE chunk (no true streaming, unbounded memory).
5. **Accounting + ops hygiene (High/Medium).** BUG-BM-011: no audit trail for wallet mutations. BUG-BM-015: `/user/usage` commits monthly rollover on a read. BUG-BM-014: rate-limit key hashes the Bearer token and lets tokenless clients bypass. BUG-BM-009: no SSE heartbeat + no trace-ID on stream log events.
6. **Model-selection + history hygiene (High/Medium).** BUG-BM-001: model is selected from an env var with no allowlist — groundwork for a client-controllable model hole. BUG-BM-005: `CONVERSATION_HISTORY_LIMIT = 50` is declared but not enforced; `_build_messages` uses `entry["message"]` (`KeyError` footgun) while `_dynamic_max_tokens` uses `.get()`.

## Table of Contents

| # | ID | Severity | Component | Title |
|---|----|----------|-----------|-------|
| 1 | BUG-BM-010 | Critical | `routers/botmason.py` | `/user/balance/add` unauthenticated credit minting |
| 2 | BUG-BM-002 | Critical | `services/botmason.py` | No wallet pre-flight / atomic decrement around provider call |
| 3 | BUG-BM-001 | High | `services/botmason.py` | Model from env fallback with no allowlist |
| 4 | BUG-BM-003 | High | `services/botmason.py` | Retry loop double-counts cost on partial completion |
| 5 | BUG-BM-004 | High | `services/botmason.py` | History replay enables system-prompt exfiltration |
| 6 | BUG-BM-006 | High | `services/chat_stream.py` | Dropped client does not cancel upstream LLM call |
| 7 | BUG-BM-007 | High | `services/chat_stream.py` | `CollectedStream` buffers whole response (no true stream) |
| 8 | BUG-BM-008 | High | `services/llm_pricing.py` | `estimate_cost_usd` uses `float`; `0.0` for unknown models |
| 9 | BUG-BM-011 | High | `services/wallet.py` | No audit trail for wallet mutations |
| 10 | BUG-BM-012 | High | `routers/botmason.py` | No idempotency on chat spend — double billing |
| 11 | BUG-BM-013 | High | `services/wallet.py` + `services/botmason.py` | No refund on failed LLM call |
| 12 | BUG-BM-005 | Medium | `services/botmason.py` | Unbounded history + `KeyError` risk in `_build_messages` |
| 13 | BUG-BM-009 | Medium | `services/chat_stream.py` | No SSE heartbeat; no trace-ID on stream log events |
| 14 | BUG-BM-014 | Medium | `routers/botmason.py` | Rate-limit key hashes bearer token; tokenless bypass |
| 15 | BUG-BM-015 | Medium | `routers/botmason.py` | `/user/usage` commits rollover on read |

---

## BotMason service orchestration — `services/botmason.py`

# Fragment 13a — BotMason Service Orchestration

Scope: `backend/src/services/botmason.py` (719 LOC). Covers prompt composition,
provider dispatch, conversation-history threading, streaming, retries, and
API-key handling. No wallet/credit logic exists in this file — that gap is
itself one of the findings below.

---

### BUG-BM-001 — Client-controllable model selection via `LLM_MODEL` env fallback exposes cross-tenant cost/behaviour drift (Severity: High)

**Component:** `backend/src/services/botmason.py:271-275` (`_get_model`) and
`backend/src/services/botmason.py:348-378` (`generate_response`)

**Symptom:** `generate_response` accepts a caller-supplied `system_prompt`
override and resolves the model purely from the ambient `LLM_MODEL` env var —
there is no server-side policy table mapping user tier / context to an allowed
model. A future router change that forwards a request-scoped model (a pattern
already foreshadowed by the BYOK `api_key` override) will bypass cost controls,
and today the code provides no defensive allowlist to stop it.

**Root cause:**
```python
def _get_model(provider: str) -> str:
    """Return the model ID from ``LLM_MODEL`` env or the provider's default."""
    if provider == "anthropic":
        return os.getenv("LLM_MODEL", DEFAULT_ANTHROPIC_MODEL)
    return os.getenv("LLM_MODEL", DEFAULT_OPENAI_MODEL)
```

The provider-side constants `DEFAULT_OPENAI_MODEL = "gpt-4o-mini"` and
`DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-20250514"` are sensible, but there
is no allowlist — any string in `LLM_MODEL` is forwarded verbatim, including
premium tiers whose per-token cost is 10-30× higher.

**Fix:** Introduce `_ALLOWED_MODELS: dict[str, frozenset[str]]` and validate
`_get_model`'s return value against it, raising `RuntimeError` on mismatch.
When the chat router later plumbs a per-request model, require it to be in the
allowlist and default to the tier's entry. This mirrors the `_PROVIDER_KEY_RULES`
pattern already in the file.

**Cross-references:** BUG-ADMIN-004 (cost stored as float — downstream metering
amplifies any model-selection drift), BUG-SCHEMA-010 (enum vs. free-form str).

---

### BUG-BM-002 — No credit/wallet pre-flight or atomic decrement before provider call (Severity: Critical)

**Component:** `backend/src/services/botmason.py:348-378`
(`generate_response`), entire module

**Symptom:** `generate_response` and `generate_response_stream` dispatch to
OpenAI / Anthropic with zero balance check. Two concurrent chat requests from
the same user will both succeed even when the wallet has credit for only one;
the usage log is appended *after* the provider call returns, so the deduction
is lossy and racy. A malicious or accidental client loop can drain API
credits faster than the ledger can record them.

**Root cause:**
```python
async def generate_response(
    user_message: str,
    conversation_history: list[dict[str, str]],
    system_prompt: str | None = None,
    api_key: str | None = None,
) -> LLMResponse:
    resolved_prompt = system_prompt or get_system_prompt()
    provider = get_provider()
    if provider == "openai":
        return await _call_openai(user_message, conversation_history, resolved_prompt, api_key)
    if provider == "anthropic":
        return await _call_anthropic(user_message, conversation_history, resolved_prompt, api_key)
    return _stub_response(user_message)
```

The module imports `payment_required` (line 20) but only uses it for the
BYOK key-missing case (line 171); there is no `reserve_credit(user_id, est)`
/ `commit_credit(user_id, actual)` pair guarding the provider call.

**Fix:** Add a `WalletReservation` context manager in `domain/wallet.py` that
(a) estimates tokens via `_dynamic_max_tokens`, (b) holds a `SELECT ... FOR
UPDATE` row lock against `wallet.balance_cents`, (c) raises
`payment_required("insufficient_balance")` when the reservation exceeds the
balance, and (d) on context exit updates with the provider-reported
`LLMResponse.total_tokens`. Wrap both `generate_response` and
`generate_response_stream` in that manager.

**Cross-references:** BUG-SCHEMA-009 (BalanceAddRequest unbounded — compounds
this by making top-ups unchecked), BUG-ADMIN-004 (cost float drift).

---

### BUG-BM-003 — Retry loop double-counts cost when transient error fires after partial stream / partial completion (Severity: High)

**Component:** `backend/src/services/botmason.py:319-345` (`_retry_on_transient`),
used at `backend/src/services/botmason.py:479` and `backend/src/services/botmason.py:513`

**Symptom:** `_retry_on_transient` catches any `Exception` whose `status_code`
is in `{429, 500, 502, 503, 504}` or which is a network error, and re-invokes
`coro_factory` up to `_MAX_RETRIES + 1 = 3` times. OpenAI and Anthropic charge
for prompt tokens even on 5xx responses that failed mid-stream, and on 429
rate-limit responses some providers still record the request. Each retry
re-submits the full prompt — the caller's usage log records only the final
attempt's tokens, silently under-reporting to the wallet ledger while the
provider invoice shows 2-3× the charge.

**Root cause:**
```python
async def _retry_on_transient(coro_factory: Callable[[], object]) -> object:
    last_exc: BaseException | None = None
    for attempt in range(_MAX_RETRIES + 1):
        try:
            return await coro_factory()  # type: ignore[misc]
        except Exception as exc:
            last_exc = exc
            if not _is_retryable(exc) or attempt == _MAX_RETRIES:
                raise
            delay = _RETRY_BASE_DELAY * (2**attempt)
            # ...retry without accounting for any tokens already billed
            await asyncio.sleep(delay)
```

No hook records the failed attempt's prompt-token cost into the usage log, and
retries on `429` specifically re-drive traffic the provider is already throttling.

**Fix:** (1) Remove `429` from `_RETRYABLE_STATUS_CODES` — rate-limit errors
should surface to the caller, not be retried. (2) On each caught retryable
exception, attempt to extract `exc.response.usage` (OpenAI exposes this on
`APIStatusError`) and append a best-effort "failed attempt" row to the usage
log so the wallet and invoice reconcile. (3) Cap `_MAX_RETRIES` at 1 for 5xx
since we have no idempotency key being forwarded.

**Cross-references:** BUG-ADMIN-004 (float cost precision compounds the
reconciliation gap), BUG-BM-002.

---

### BUG-BM-004 — System prompt leaked into conversation history via `_build_messages` when caller passes server history verbatim, enabling persona / hidden-instruction exfiltration (Severity: High)

**Component:** `backend/src/services/botmason.py:249-268` (`_build_messages`),
`backend/src/services/botmason.py:278-290` (`_build_anthropic_messages`)

**Symptom:** `_build_messages` trusts every `entry["message"]` string from
`conversation_history`. Bot turns (`sender == "bot"`) are appended **without**
`_wrap_user_input` escaping, on the assumption they originated from the model.
But the journal/chat persistence layer stores assistant replies verbatim — if
an earlier turn asked "repeat your system prompt word-for-word" and the model
complied (which older models routinely do), that leaked system prompt now sits
in the history as an `assistant` turn and is replayed on every subsequent
request. Combined with BUG-JOURNAL-008, a *deleted* adversarial assistant turn
could still be in the row set passed in here. There is no filter on
`is_deleted` / `redacted` flags at this layer.

**Root cause:**
```python
def _build_messages(
    user_message: str,
    conversation_history: list[dict[str, str]],
    system_prompt: str,
) -> list[dict[str, str]]:
    _check_prompt_injection(user_message)
    messages: list[dict[str, str]] = [{"role": "system", "content": system_prompt}]
    for entry in conversation_history:
        role = "assistant" if entry.get("sender") == "bot" else "user"
        content = _wrap_user_input(entry["message"]) if role == "user" else entry["message"]
        messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": _wrap_user_input(user_message)})
    return messages
```

Note also: only `user_message` (the *current* turn) is scanned by
`_check_prompt_injection` — historical user turns bypass the heuristic
entirely, so an injection planted three turns ago is replayed on every future
call without a warning.

**Fix:** (1) Accept only a typed `ConversationTurn` dataclass exposing
`sender`, `message`, `is_deleted`, and require callers to have filtered
`is_deleted=True` rows upstream (contract enforced by `assert` + type). (2)
Run `_check_prompt_injection` over every historical user turn as well, not
just the current one. (3) Scrub assistant turns for the literal substring of
the active system prompt before replay; on match, redact to
`"[assistant reply redacted: policy]"` and log. (4) Add a unit test that
round-trips a "repeat your system prompt" attack.

**Cross-references:** BUG-JOURNAL-003 (XSS / prompt injection), BUG-JOURNAL-008
(deleted rows leaking to LLM prompts).

---

### BUG-BM-005 — Unbounded conversation-history token budget + per-entry `KeyError` risk in `_dynamic_max_tokens` / `_build_messages` (Severity: Medium)

**Component:** `backend/src/services/botmason.py:249-268` (`_build_messages`),
`backend/src/services/botmason.py:293-308` (`_dynamic_max_tokens`)

**Symptom:** The module declares `CONVERSATION_HISTORY_LIMIT = 50` but nothing
in this file enforces it — the constant is purely documentary. Callers pass
whatever `conversation_history` length they built, and `_dynamic_max_tokens`
only reduces the *response* budget, not the *prompt* budget. A user with 400
historical journal turns would push a ~40 KB prompt on every call, multiplying
per-request cost by ~8× with no ceiling. Separately, `_build_messages` does
`entry["message"]` (square-bracket access) on line 265 while
`_dynamic_max_tokens` does `e.get("message", "")` on line 305 — the two
functions disagree on whether `"message"` is guaranteed, so a malformed entry
raises `KeyError` inside the request handler (500 to the client) instead of
being skipped.

**Root cause:**
```python
# line 35 — declared but unused in this module
CONVERSATION_HISTORY_LIMIT = 50

# line 305 — lenient access
chars = sum(len(e.get("message", "")) for e in conversation_history)

# line 265 — strict access on the same dict shape
content = _wrap_user_input(entry["message"]) if role == "user" else entry["message"]
```

**Fix:** (1) Enforce the limit inside `_build_messages` by slicing
`conversation_history[-CONVERSATION_HISTORY_LIMIT:]` before iterating — fail
closed even if the router forgets. (2) Normalise missing-key handling: use
`entry.get("message", "")` in `_build_messages` too, and skip entries whose
message is empty after strip. (3) Add `_estimate_prompt_tokens` and refuse the
call with `bad_request("conversation_too_long")` when the prompt budget alone
exceeds `model_max - safety_margin - 1024`, rather than silently clamping only
the response.

**Cross-references:** BUG-JOURNAL-008 (deleted rows inflate the window),
BUG-BM-002 (unbounded prompt tokens amplify the wallet race).


---

## Chat streaming protocol & LLM pricing — `services/chat_stream.py`, `services/llm_pricing.py`

## Fragment 13b — BotMason chat streaming + LLM pricing

Scope: `backend/src/services/chat_stream.py` (SSE orchestration, wallet /
journal interleaving) and `backend/src/services/llm_pricing.py` (cost
estimation table and `estimate_cost_usd`).  Four bugs, `BUG-BM-006`
through `BUG-BM-009`.

---

### BUG-BM-006 — Dropped client does not cancel upstream LLM call; the user is charged for a stream they will never see (Severity: High)

**Component:** `backend/src/services/chat_stream.py:68-92` (and
`stream_bot_response:157-212`)

**Symptom:** When the HTTP client disconnects mid-stream (mobile app
backgrounded, network blip, user navigates away), `collect_provider_stream`
keeps draining `_botmason.generate_response_stream` until the provider
flushes its final chunk.  The wallet has already been debited by the
router's synchronous `preflight_deduction`, so the user pays for a
completion they never receive and we pay the provider for a completion
that will never be rendered.  No `request.is_disconnected()` check and
no `CancelledError` plumbing.

**Root cause:**
```python
async def collect_provider_stream(
    user_message: str,
    conversation_history: list[dict[str, str]],
    api_key: str | None,
) -> CollectedStream:
    final_response: LLMResponse | None = None
    framed_chunks: list[bytes] = []
    async for chunk_text, final in _botmason.generate_response_stream(
        user_message, conversation_history, api_key=api_key
    ):
        if chunk_text:
            framed_chunks.append(sse_event("chunk", {"text": chunk_text}))
        if final is not None:
            final_response = final
    ...
    return CollectedStream(chunks=framed_chunks, response=final_response)
```
The loop has no cancellation hook and buffers every chunk before yielding
(see BUG-BM-007).  Starlette cancels the generator task on disconnect,
but the provider iterator is never closed, so the SDK call proceeds to
completion and the pre-flight deduction is never refunded.

**Fix:** Wrap the provider iterator in a task scoped to the request and
cancel it when `request.is_disconnected()` returns `True` or when a
`CancelledError` propagates.  On cancellation, issue a compensating
wallet credit (the inverse of `preflight_deduction`) inside the
`finally` branch so the user is made whole.  Log a single
`stream_client_disconnect` event with the correlation ID for ops.

**Cross-references:** BUG-ADMIN-004 (double-billed calls inflate the
`estimated_cost_usd` sum); BUG-OBS-005 (correlation ID must survive the
cancellation task).

---

### BUG-BM-007 — `CollectedStream` buffers the entire provider response before emitting a single SSE chunk, defeating the purpose of streaming and risking unbounded memory growth (Severity: High)

**Component:** `backend/src/services/chat_stream.py:39-92`

**Symptom:** Clients connect, see no `chunk` events, then get the whole
response in one burst at the end.  Worst case — a runaway provider
response (buggy tool loop, malicious prompt, 10k-token completion) —
the backend holds every chunk in a Python `list[bytes]` in RAM for the
lifetime of the stream.  No back-pressure, no chunk-count cap, no
byte-budget.  The docstring explicitly acknowledges the "buffer then
yield" design as a trade-off, but the cure is worse than the disease.

**Root cause:**
```python
@dataclass(frozen=True)
class CollectedStream:
    chunks: list[bytes]
    response: LLMResponse


# ... inside collect_provider_stream ...
    async for chunk_text, final in _botmason.generate_response_stream(...):
        if chunk_text:
            framed_chunks.append(sse_event("chunk", {"text": chunk_text}))
        if final is not None:
            final_response = final
    ...
    return CollectedStream(chunks=framed_chunks, response=final_response)

# stream_bot_response then yields the whole buffer at once:
    for chunk in collected.chunks:
        yield chunk
    yield await finalise_stream_commit(...)
```
Because `collect_provider_stream` is `await`-ed to completion before any
`yield`, the "streaming" endpoint is functionally a long-polled
request/response.  First-token latency becomes last-token latency.

**Fix:** Convert `collect_provider_stream` into an `AsyncIterator[bytes]`
that yields each framed chunk as it arrives and surfaces the final
`LLMResponse` via a sentinel or an out-parameter (e.g. a mutable
container the caller inspects after the iterator exhausts).  Keep the
outer `try/except` in `stream_bot_response` so provider failures still
map to a single `error` event — a mid-stream failure after chunks have
been flushed must additionally emit a terminal `error` event and roll
back both journal writes (user + bot).  Add a per-request byte / chunk
cap that aborts the stream if the provider misbehaves.

**Cross-references:** BUG-BM-006 (cancellation also depends on
incremental yields); BUG-BM-009 (heartbeat framing requires a live
async generator, not a post-hoc buffer).

---

### BUG-BM-008 — `estimate_cost_usd` uses binary `float` arithmetic and returns silent `0.0` for unknown models, making the usage ledger both imprecise and blind to pricing drift (Severity: High)

**Component:** `backend/src/services/llm_pricing.py:33-70`

**Symptom:** Every BotMason call records an `estimated_cost_usd` computed
in IEEE-754 `float` (see lines 55-70), which is the same value then
summed with `func.sum` by the admin endpoint (BUG-ADMIN-004).  A new
model slug — a harmless change on the provider side, or a typo in an
env override — silently returns `0.0` with no log event, so cost
dashboards report "free" until someone notices the invoice.  No
rounding policy (providers bill in tenths of a cent), no fallback
pricing, no alert on missing-model lookup.

**Root cause:**
```python
MODEL_PRICING: dict[str, ModelPricing] = {
    "gpt-4o-mini": ModelPricing(input_usd_per_million=0.15, output_usd_per_million=0.60),
    "gpt-4o": ModelPricing(input_usd_per_million=2.50, output_usd_per_million=10.00),
    "claude-sonnet-4-20250514": ModelPricing(
        input_usd_per_million=3.00, output_usd_per_million=15.00
    ),
    ...
}

def estimate_cost_usd(model: str, prompt_tokens: int, completion_tokens: int) -> float:
    pricing = MODEL_PRICING.get(model)
    if pricing is None:
        return 0.0
    safe_prompt = max(prompt_tokens, 0)
    safe_completion = max(completion_tokens, 0)
    input_cost = safe_prompt / _TOKENS_PER_MILLION * pricing.input_usd_per_million
    output_cost = safe_completion / _TOKENS_PER_MILLION * pricing.output_usd_per_million
    return input_cost + output_cost
```
`0.15 / 1_000_000 * 250` is not representable exactly in `float64`;
accumulated over N calls the drift is measurable against the provider
invoice.  The `if pricing is None: return 0.0` branch hides the
real defect — that the model slug escaped the pricing table.

**Fix:** Represent prices as `Decimal` (or integer microcents) in
`ModelPricing`; compute cost in `Decimal` and quantize to six decimal
places before returning (or return `Decimal` and let the caller
quantize).  Replace the silent `0.0` fallback with a structured log
warning (`logger.warning("unknown_model_pricing", extra={"model": ...})`)
and a metrics counter so ops see pricing-table drift immediately;
optionally fall back to the most expensive known model in the same
family rather than zero, so under-reporting never beats over-reporting.
Document the rounding policy in the module docstring.

**Cross-references:** BUG-ADMIN-004 (monetary drift in the admin
aggregate — requires both this fix and a `Numeric(12, 6)` migration);
BUG-SCHEMA-009 (credit minting compounds the reconciliation gap when
the ledger itself is lossy).

---

### BUG-BM-009 — No SSE heartbeat and no correlation ID on stream log events; clients time out on slow first-token and ops cannot reconstruct a failed session (Severity: Medium)

**Component:** `backend/src/services/chat_stream.py:55-65, 157-212`
(and the `PreflightedRequest` DTO at lines 139-155)

**Symptom:** The stream emits exactly three event types — `chunk`,
`complete`, `error` — and nothing else.  Mobile clients and corporate
proxies commonly drop idle SSE connections at 15-60s; if the provider's
first-token latency breaches that window (cold model, rate-limit
queueing) the client disconnects before any bytes arrive and retries,
doubling the wallet debit (compounding BUG-BM-006).  Separately, the
stream's log lines (`logger.exception(...)` at lines 189, 193) never
include the request's `trace_id`, so ops cannot stitch a "failed chat"
report back to the provider call — the `PreflightedRequest` DTO even
acknowledges "future fields (e.g. a correlation ID)" but does not
carry one.

**Root cause:**
```python
def sse_event(event: str, data: dict[str, Any]) -> bytes:
    payload = json.dumps(data, separators=(",", ":"))
    return f"event: {event}\ndata: {payload}\n\n".encode()


@dataclass(frozen=True)
class PreflightedRequest:
    message: str
    api_key: str | None
    spent: SpendResult
    remaining_messages: int
    # no correlation_id / trace_id field


async def stream_bot_response(...):
    try:
        collected = await collect_provider_stream(...)
    except Exception:
        aborted = True
        logger.exception("Stream provider error for user_id=%s", user_id)
        ...
        yield sse_event("error", {"status": 502, "detail": "llm_provider_error"})
        return
```
No periodic keep-alive comment (`": keepalive\n\n"`), no `ping` event,
no `trace_id` threaded into `PreflightedRequest` or into the exception
log record.

**Fix:** Emit an SSE comment keep-alive (`b": keepalive\n\n"`) every
~10-15 seconds while waiting for the first provider chunk — an
`asyncio.wait` race between the provider iterator and a ticker task
works and fits the refactor required for BUG-BM-007.  Add
`trace_id: str` to `PreflightedRequest`, bind it to the `ContextVar`
installed by `CorrelationIdMiddleware` for the duration of the
generator, and include it in every `logger.exception` via `extra=`.
Echo the `trace_id` in the terminal `complete` and `error` payloads
so the mobile client can surface it in bug reports.

**Cross-references:** BUG-OBS-005 (`ContextVar` does not survive across
`asyncio.create_task`; the heartbeat task spawned here must use the
`propagate_trace_id` helper once it lands); BUG-BM-006 (client
disconnect detection is the complementary half of this story —
heartbeats keep healthy clients alive, disconnect checks shed dead
ones).


---

## Wallet service & BotMason router — `services/wallet.py`, `routers/botmason.py`

# Fragment 13c — Wallet Service & BotMason Router

Scope: `backend/src/services/wallet.py` and `backend/src/routers/botmason.py`.
Bug IDs BUG-BM-010 through BUG-BM-015.

---

### BUG-BM-010 — Unauthenticated credit minting via `/user/balance/add` (Severity: Critical)

**Component:** `backend/src/routers/botmason.py:149-170`

**Symptom:** Any authenticated user can POST to `/user/balance/add` with an
arbitrary positive integer and have it credited to their own `offering_balance`.
There is no admin gate, no payment verification, and no server-side cap — the
endpoint is effectively a "mint me credits" button for every account.

**Root cause:**
```python
@router.post("/user/balance/add", response_model=BalanceAddResponse)
@limiter.limit("5/minute")
async def add_balance(
    request: Request,
    payload: BalanceAddRequest,
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> BalanceAddResponse:
    if payload.amount <= 0:
        raise bad_request("amount_must_be_positive")
    new_balance = await wallet_service.add_balance(session, current_user, payload.amount)
```

**Fix:** Gate the route behind an admin dependency (blocked until
BUG-ADMIN-001 introduces `is_admin`) and move all credit-granting behind a
verified payment / fulfillment workflow. In the interim, remove the route from
the public router or require a service-to-service token. The body schema must
also be bounded (see BUG-SCHEMA-009) so a logic bug cannot produce an
`int`-sized credit.

**Cross-references:** BUG-SCHEMA-009, BUG-ADMIN-001.

---

### BUG-BM-011 — No audit trail for wallet mutations (Severity: High)

**Component:** `backend/src/services/wallet.py:163-180`, `backend/src/routers/botmason.py:166-169`

**Symptom:** `add_balance`, `spend_one_message`, and the rollover path all
mutate `User.offering_balance` / `monthly_messages_used` in-place with no
append-only ledger. The only trace of a credit addition is a single
`logger.info("balance_added", ...)` call in the router — debits have no log
at all, and nothing is persisted to the database. Reconciliation, dispute
handling, and forensic review after a compromise are impossible.

**Root cause:**
```python
result = await session.execute(
    update(User)
    .where(col(User.id) == user_id)
    .values(offering_balance=col(User.offering_balance) + amount)
    .returning(col(User.offering_balance))
)
new_balance = result.scalar()
if new_balance is None:
    return None
return int(new_balance)
```

**Fix:** Introduce a `WalletLedger` table (user_id, delta, reason,
actor_user_id, request_id, created_at, balance_after) and write a row in the
same transaction as every mutation. Every debit in `spend_one_message` and
every credit in `add_balance` must produce a ledger row; the `User` column
becomes a cached projection of the ledger.

**Cross-references:** BUG-JOURNAL-018, BUG-ADMIN-001.

---

### BUG-BM-012 — No idempotency key on chat spend enables double billing (Severity: High)

**Component:** `backend/src/services/wallet.py:90-126`, `backend/src/routers/botmason.py:73-115`

**Symptom:** `preflight_deduction` unconditionally decrements the wallet on
every POST to `/journal/chat` and `/journal/chat/stream`. A client retry
after a network blip, a duplicate tap in the mobile UI, or a proxy replay
each burn a message — and if the LLM call itself fails mid-flight there is
no refund path (see BUG-BM-013). Users are charged twice for one logical
turn.

**Root cause:**
```python
async def preflight_deduction(session: AsyncSession, user_id: int) -> SpendResult:
    await reset_monthly_usage_if_due(session, user_id, datetime.now(UTC))
    spent = await spend_one_message(session, user_id, get_monthly_cap())
    if spent is not None:
        return spent
    if await get_user_fresh(session, user_id) is None:
        raise bad_request("user_not_found")
    raise payment_required("insufficient_offerings")
```

**Fix:** Require an `Idempotency-Key` header on chat POSTs, persist
`(user_id, key)` with the resulting `SpendResult` / LLM response, and return
the cached result on replay without re-debiting. Reject duplicate keys
within a TTL window (e.g. 24h).

**Cross-references:** BUG-JOURNAL-010.

---

### BUG-BM-013 — No refund on failed LLM call (Severity: High)

**Component:** `backend/src/routers/botmason.py:85-115`, `backend/src/services/wallet.py:90-126`

**Symptom:** The streaming endpoint deducts one message in `preflight_deduction`
*before* opening the SSE stream. If the downstream LLM provider returns a
5xx, the API key is revoked, or the stream aborts mid-token, the user's
balance is still decremented. The docstring claims "any downstream failure
surfaces as an SSE `error` event followed by a clean rollback — no partial
state is committed," but the wallet mutation has already been committed by
the time `stream_bot_response` starts yielding.

**Root cause:**
```python
spent = await preflight_deduction(session, current_user)
context = PreflightedRequest(
    message=payload.message,
    api_key=api_key,
    spent=spent,
    remaining_messages=max(get_monthly_cap() - spent.monthly_used, 0),
)
headers: dict[str, Any] = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
stream = stream_bot_response(session, current_user, context)
return StreamingResponse(stream, media_type="text/event-stream", headers=headers)
```

**Fix:** Wrap the LLM call in a try/except that calls an explicit
`refund_one_message(session, user_id, spent)` on failure — reversing the
same bucket that was charged (monthly vs. offering). Write both the debit
and the refund to the wallet ledger (BUG-BM-011) so the pair is auditable.
Defer the commit until after the first successful token, or use a saga /
outbox pattern.

**Cross-references:** BUG-BM-011, BUG-JOURNAL-010.

---

### BUG-BM-014 — Rate-limit key hashes full Bearer token and lets tokenless clients bypass (Severity: Medium)

**Component:** `backend/src/routers/botmason.py:44-54`

**Symptom:** `_per_user_key` uses the raw `Authorization` header value as the
rate-limit key. Two issues: (1) if a request arrives without a Bearer header
(e.g. token stripped by a misconfigured proxy) the limiter falls back to IP,
so an attacker behind a NAT can multiply their quota by dropping the header
deliberately; (2) the full bearer token is passed to the slowapi storage
backend, where it may be logged or persisted — a token-leakage channel.

**Root cause:**
```python
def _per_user_key(request: StarletteRequest) -> str:
    auth_header = request.headers.get("authorization", "")
    if auth_header.startswith("Bearer "):
        # Use a hash-like prefix so the key space doesn't collide with IPs.
        return f"user:{auth_header}"
    return get_remote_address(request)
```

**Fix:** Resolve the authenticated user ID via the same dependency the route
uses (or decode the JWT `sub` claim) and key on `f"user:{user_id}"`. For
truly anonymous requests, reject them upstream rather than allowing the
IP-based fallback on an authenticated-only endpoint. Never pass the raw
token to the limiter.

**Cross-references:** BUG-JOURNAL-008.

---

### BUG-BM-015 — `/user/usage` commits rollover on a read, leaks via uncommitted chat path (Severity: Medium)

**Component:** `backend/src/routers/botmason.py:128-146`, `backend/src/services/wallet.py:62-88`

**Symptom:** `get_usage` calls `reset_monthly_usage_if_due` followed by
`session.commit()` — a GET endpoint performs a write and commits it. Meanwhile
`preflight_deduction` (used by both chat endpoints) calls
`reset_monthly_usage_if_due` but never commits the rollover itself; it relies
on the caller's later commit. A crash between the rollover UPDATE and the
spend UPDATE silently rolls the counter reset back, and the next request
will reset again — observable as occasional double-length free-tier windows.
The mismatch in commit responsibility between the two call sites is the root
cause.

**Root cause:**
```python
@router.get("/user/usage", response_model=UsageResponse)
async def get_usage(
    current_user: int = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> UsageResponse:
    await reset_monthly_usage_if_due(session, current_user, datetime.now(UTC))
    await session.commit()
    user = await require_user_fresh(session, current_user)
```

**Fix:** Make `reset_monthly_usage_if_due` own its own transaction (or push
the commit into `preflight_deduction` so both paths commit the rollover
before the spend UPDATE runs). GET `/user/usage` should not mutate — either
compute the "effective" post-rollover values for display without writing, or
move rollover to a scheduled job. Either path must not leave two endpoints
with inconsistent commit discipline over the same mutation.

**Cross-references:** BUG-BM-011.

---

## Suggested Remediation Order

1. **BUG-BM-010** (Critical — credit minting) — Gate `/user/balance/add` on `is_admin` (requires BUG-MODEL-001 + BUG-ADMIN-001 landed first); add a per-admin audit record and bound the amount (pair with BUG-SCHEMA-009 `Field(ge=1, le=10_000)`).
2. **BUG-BM-002** (Critical — wallet race) — Wrap the provider call in a `SELECT ... FOR UPDATE` on `User.offering_balance` + atomic `UPDATE ... RETURNING` (already exists in `spend_one_message` — extend it to the whole chat flow). Refuse the call when balance < expected cost.
3. **BUG-BM-013** (High — refund) — On any provider error after pre-flight deduction, call a new `wallet.refund(user_id, amount, reason)` helper inside the same transaction. Without this the docstring claim of "clean rollback" is false.
4. **BUG-BM-012** (High — idempotency) — Require `Idempotency-Key` header on `/chat`. Store `(user_id, key) -> response_hash` with a 24h TTL; second hit returns the cached reply without a new charge.
5. **BUG-BM-011** (High — audit) — New `WalletLedger(user_id, delta, reason, trace_id, created_at)` table. Every debit/credit writes one row in the same transaction as the balance mutation.
6. **BUG-BM-003** (High — retry double-count) — On retry, tag the previous attempt's tokens as sunk cost and invoice only the final successful attempt, or amortize per-attempt tokens into the usage ledger with a `retry_attempt` column. Pair with BUG-BM-008.
7. **BUG-BM-008** (High — float drift) — Migrate pricing to `Decimal` (or integer microcents). Raise a structured `unknown_model_pricing` warning instead of silent `0.0`. Version the pricing table.
8. **BUG-BM-007** (High — streaming buffer) — Convert `CollectedStream` into a true `AsyncIterator[bytes]` and cap total bytes to prevent memory DoS.
9. **BUG-BM-006** (High — client cancellation) — Plumb `asyncio.CancelledError` / `request.is_disconnected()` to the provider client. On cancel, refund any undelivered-token portion.
10. **BUG-BM-004** (High — prompt injection via history) — Scan every assistant and user turn in `_build_messages`, not only the current user turn. Tie to BUG-JOURNAL-003 (sanitize at write) + BUG-JOURNAL-008 (exclude deleted/cross-sender rows).
11. **BUG-BM-001** (High — model allowlist) — Replace the `LLM_MODEL` env fallback with a closed `Literal[...]` of vetted models. Reject any value outside the set.
12. **BUG-BM-005** (Medium) — Enforce `CONVERSATION_HISTORY_LIMIT` in `_build_messages`; use `.get("message", "")` consistently to eliminate the `KeyError` footgun.
13. **BUG-BM-015** (Medium) — Rollover commit should be symmetric: either always commit on read (accept the cost) or move the rollover to a scheduled job and never mutate inside GET.
14. **BUG-BM-014** (Medium) — Rate-limit key should derive from `user_id` (set in `request.state` after auth middleware). Fail closed for unauthenticated requests.
15. **BUG-BM-009** (Medium) — Add an SSE heartbeat ticker. Echo `trace_id` in every stream frame and on `logger.exception` via `extra`.

## Cross-References

- **BUG-SCHEMA-009** (`BalanceAddRequest.amount` unbounded) — schema-side mirror of BUG-BM-010.
- **BUG-ADMIN-001** (no `is_admin`) — structural precondition for BUG-BM-010 fix.
- **BUG-ADMIN-004** (cost stored as `float`) — BUG-BM-008 is the pricing-layer root cause.
- **BUG-MODEL-001** (User lacks `is_admin`) — same precondition.
- **BUG-JOURNAL-003** (no HTML / script sanitisation) — prompt-injection vector for BUG-BM-004.
- **BUG-JOURNAL-008** (deleted rows leak into LLM prompts) — amplifies BUG-BM-004.
- **BUG-JOURNAL-010** (no idempotency on journal POST) — paired billing hazard with BUG-BM-012.
- **BUG-OBS-005** (no `ContextVar` propagation helper) — BUG-BM-009 is the streaming-layer symptom.
- **BUG-OBS-003** (no global exception handler) — streaming errors lose correlation (BUG-BM-009).
- **BUG-APP-006** (rate-limit `X-Forwarded-For` trust) — pairs with BUG-BM-014 (bearer-token bypass).
