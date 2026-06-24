# audit-destub-08: Map provider errors on the non-stream chat path

**Labels:** `audit-destub`, `backend`, `error-handling`, `priority-medium`
**Epic:** De-Stub: Make Aspirational Features Real
**Estimated LoC:** ~180  (hard cap 700)

## Problem
The non-streaming chat handler `chat_with_botmason` (`backend/src/routers/botmason.py:160-203`,
via `_handle_chat_with_idem_409` → `handle_chat_request`) only maps `IntegrityError` to 409. A
provider 401/429/503 (invalid BYOK key, rate-limited, upstream down) is **not** mapped to a
friendly response and surfaces as an opaque 500. The streaming path already does this:
`services/chat_stream.py:363-366` catches provider failures, rolls back the deduction, and emits a
`502 llm_provider_error`. The two paths are inconsistent — BYOK users get clear errors when
streaming but opaque 500s otherwise.
**Current state:** §5.1 class **stub** (`2026-06-24_ADEPTHOOD_FULL_AUDIT.md` §6, row 8). Error
mapping is **supposed to be real for ship** — BYOK users must be able to self-diagnose a bad key or
a busy provider. Supersedes the LLM-error item in `phase-7-05-complete-stubs.md`.

## Scope
**Covers:** mapping provider 401/429/503/timeout on the **non-stream** path to friendly HTTP
responses that mirror the stream path's semantics (502 for transient provider failure, distinct
401/402/429 where the stream path already pre-flights them), with the wallet deduction rolled back
on failure exactly as the stream path does. **Does NOT cover:** changing the stream path, narrowing
the broad `except Exception` in `chat_stream.py` (tracked under `audit-async`), or the user-facing
copy strings (defer wording to `user-facing-error-messages` if richer copy is wanted).

## Tasks
1. **Identify the provider-error type** — locate how `handle_chat_request` / the provider call
   surfaces upstream HTTP status (the retry constants `_RETRYABLE_STATUS_CODES = {429,500,502,503,504}`
   live in `botmason.py`). Map: 401 → 502 with `invalid_or_unauthorized_key` detail (or 401 if the
   stream path pre-flights key validity that way), 429 → 502/429 `provider_busy`, 503/timeout → 502
   `llm_provider_unavailable`.
2. **Wrap the non-stream call** — in `routers/botmason.py`, catch the provider error around
   `_handle_chat_with_idem_409` and translate to the mapped `HTTPException`, rolling back the
   wallet deduction the same way the stream path does (`_rollback_quietly` equivalent) so a failed
   call never charges the user. TDD: tests injecting a provider 401, 429, and 503 and asserting the
   mapped status/detail **and** that no charge persists.
3. **Mirror, do not diverge** — keep the detail codes aligned with the stream path's
   `llm_provider_error` family so clients handle both paths uniformly.

## Acceptance Criteria
- [ ] A provider 401/429/503/timeout on the non-stream path returns a mapped friendly error
      (502 family), never an opaque 500.
- [ ] The wallet deduction is rolled back on a failed provider call (no charge persists).
- [ ] Detail codes match the stream path's mapping for client uniformity.
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on --all-files.

## Files to Create/Modify
| File | Action |
|------|--------|
| `backend/src/routers/botmason.py` | Modify (map provider errors + rollback on non-stream path) |
| `backend/src/services/botmason.py` | Modify if needed (surface provider status to the router) |
| `backend/tests/routers/test_botmason.py` | Modify (401/429/503 mapping + no-charge tests) |
