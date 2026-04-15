# Journal & BotMason (AI Companion) — Bug Remediation Report

**Component:** Journal entries, BotMason chat, weekly prompts, LLM integration
**Date:** 2026-04-14
**Auditor:** Claude Code (self-review)
**Branch:** `claude/code-review-bug-analysis-BvOHp`

## Executive Summary

The Journal + BotMason surface has **18 bugs** ranging from privacy/security leaks to LLM-integration reliability issues. Several are critical and reachable without privileged access:

- **Cross-user journal injection.** `POST /journal/bot-response` accepts a `user_id` from the request body without validating it against the authenticated user. Any logged-in attacker can write bot messages into someone else's journal.
- **`user_id` leaks in `JournalMessageResponse`.** Surrogate keys are exposed to the client, aiding enumeration.
- **TOCTOU race on weekly prompt responses** — duplicate submissions can slip through the SELECT-then-INSERT gap.
- **Hardcoded `max_tokens=1024`** with a 20-message history limit produces truncated responses in longer conversations.
- **No request timeout / retry / backoff** on provider calls — a single blip burns the user's monthly quota.
- **Orphaned user messages.** The user message is `flush()`ed before the LLM is invoked; on provider failure the rollback doesn't undo the flush in all configurations.

---

## Table of Contents

| # | Severity | Title |
|---|---|---|
| BUG-JOURNAL-001 | Critical | Hardcoded `max_tokens=1024` regardless of conversation depth |
| BUG-JOURNAL-002 | Critical | `/journal/bot-response` accepts arbitrary `user_id` (cross-user injection) |
| BUG-JOURNAL-003 | Critical | TOCTOU race on `PromptResponse` duplicate check |
| BUG-JOURNAL-004 | Critical | `user_id` leaks in `JournalMessageResponse` |
| BUG-JOURNAL-005 | High | No timeout on LLM provider calls |
| BUG-JOURNAL-006 | High | No retry / exponential backoff on transient provider failures |
| BUG-JOURNAL-007 | High | Conversation history limit of 20 too low for the app's use case |
| BUG-JOURNAL-008 | High | No per-user rate limit on chat (only global) |
| BUG-JOURNAL-009 | High | Stream error path swallows exception context |
| BUG-JOURNAL-010 | High | `X-LLM-API-Key` not in CORS allow-list |
| BUG-JOURNAL-011 | Medium | Default Anthropic model ID hardcoded and may drift from current catalog |
| BUG-JOURNAL-012 | Medium | No encryption at rest for journal entries |
| BUG-JOURNAL-013 | Medium | LIKE search doesn't escape `%` / `_` |
| BUG-JOURNAL-014 | Medium | Weekly prompt week derived from elapsed time, not completion |
| BUG-JOURNAL-015 | Medium | User message flushed before LLM call → orphans on failure |
| BUG-JOURNAL-016 | Medium | Streaming placeholder removed on abort, user message stays orphaned |
| BUG-JOURNAL-017 | Medium | No prompt-injection guard on user input |
| BUG-JOURNAL-018 | Low | Monthly-usage reset has a narrow concurrency window |

---

### BUG-JOURNAL-001: Hardcoded `max_tokens=1024`
**Severity:** Critical
**Component:** `backend/src/services/botmason.py:374` (non-streaming), `:569` (streaming)
**Symptom:** Both the OpenAI and Anthropic calls fix `max_tokens=1024`. With a 20-message history plus a long user message, the model runs out of output budget and truncates mid-sentence.
**Fix:** Scale dynamically. Target at least `max_tokens = clamp(1024, 4096, model_max - prompt_tokens - safety_margin)`. Budget using a tokenizer, not a string-length heuristic.

---

### BUG-JOURNAL-002: Cross-user journal injection via `bot-response`
**Severity:** Critical
**Component:** `backend/src/routers/journal.py:120-135`; schema `backend/src/schemas/journal.py:27-34`
**Symptom:** The handler takes `user_id` directly from the payload; the authenticated user is bound to `_current_user` and ignored. Any logged-in user can write arbitrary bot messages into arbitrary journals.
**Fix:** Remove `user_id` from `JournalBotMessageCreate`; source it from `Depends(get_current_user)` only. Or, better, make `POST /journal/bot-response` an internal-only endpoint protected by a service token — since bot messages flow through the chat endpoint anyway, this route might not need to exist at all.

---

### BUG-JOURNAL-003: Duplicate-response race on weekly prompts
**Severity:** Critical
**Component:** `backend/src/routers/prompts.py:169-177`
**Symptom:** Double-submit between SELECT and INSERT can produce two `PromptResponse` rows for the same `(user_id, week_number)`.
**Fix:**
1. Add DB unique constraint `(user_id, week_number)` (migration).
2. Handle `IntegrityError` in the handler and return 409 "already_responded".
3. Optionally use `INSERT ... ON CONFLICT DO NOTHING RETURNING ...`.

---

### BUG-JOURNAL-004: `user_id` leaks in response schema
**Severity:** Critical
**Component:** `backend/src/schemas/journal.py:37-47`
**Symptom:** Every journal entry response contains `user_id`. The client already knows its own ID. Exposing it aids enumeration and targeted attacks.
**Fix:** Remove `user_id` from `JournalMessageResponse` and any other response schemas where it isn't strictly needed.

---

### BUG-JOURNAL-005: No timeout on provider calls
**Severity:** High
**Component:** `backend/src/services/botmason.py:336` (OpenAI), `:363` (Anthropic)
**Symptom:** Default client timeouts are minutes-long; a wedged provider hangs requests and the frontend.
**Fix:**
```python
client = AsyncAnthropic(api_key=key, timeout=30.0)
client = AsyncOpenAI(api_key=key, http_client=httpx.AsyncClient(timeout=httpx.Timeout(30.0)))
```
Return 504 / SSE `error` promptly.

---

### BUG-JOURNAL-006: No retry / backoff
**Severity:** High
**Component:** `backend/src/services/botmason.py:217-247`, `:429-449`
**Symptom:** Single transient 5xx or 429 fails the request permanently and consumes quota.
**Fix:** Wrap provider calls in a retry helper with exponential backoff (`1s, 2s`, max 2 attempts) for `429 / 5xx / network`. Charge quota only on final success.

---

### BUG-JOURNAL-007: Conversation history limit of 20 is too low
**Severity:** High
**Component:** `backend/src/services/botmason.py:29`; consumer `backend/src/services/journal.py:25-40`
**Symptom:** 20 total messages = ~10 exchanges. Deeper reflections drop out of context; the bot forgets.
**Fix:** Bump to 50–100, combined with dynamic `max_tokens` (BUG-001). Consider a summarization step for older turns to keep prompts small while preserving memory.

---

### BUG-JOURNAL-008: No per-user rate limit on chat
**Severity:** High
**Component:** `backend/src/routers/botmason.py:53, 67`
**Symptom:** Global limit (`10/minute`) is per-route, not per-user. One user can exhaust the budget for everyone.
**Fix:** Use SlowAPI `key_func` that returns `str(current_user)` (or IP fallback for anonymous). Add a daily cap layered on top.

---

### BUG-JOURNAL-009: Stream error swallowed
**Severity:** High
**Component:** `backend/src/services/chat_stream.py:160-165`
**Symptom:** `except Exception:` with no logging; ops can't debug production LLM outages.
**Fix:** `logger.exception("Stream provider error", extra={"user_id": user_id})` before rollback and SSE error emit. Also consider emitting an opaque error code to the client and a correlation ID for support.

---

### BUG-JOURNAL-010: `X-LLM-API-Key` not in CORS allow-list
**Severity:** High
**Component:** `backend/src/routers/botmason.py:45`; CORS config in `backend/src/main.py`
**Symptom:** BYOK header blocked by browsers on preflight; users silently fall back to the server key.
**Fix:** Add `X-LLM-API-Key` (and any other custom headers) to CORSMiddleware `allow_headers`. Document in `DEPLOYMENT.md`.

---

### BUG-JOURNAL-011: Default Anthropic model string hardcoded
**Severity:** Medium
**Component:** `backend/src/services/botmason.py:371`, `backend/src/services/llm_pricing.py:38-39`
**Symptom:** `claude-sonnet-4-20250514` may drift from Anthropic's current catalog / pricing.
**Fix:** Centralize `MODEL_DEFAULTS` in a config module. Add a startup warning if `LLM_MODEL` is not in the pricing table. Prefer newer, tested stable snapshots. (Note: the latest 4.x Sonnet snapshot may be fine — the fix is the indirection, not the specific version.)

---

### BUG-JOURNAL-012: No encryption at rest for journal entries
**Severity:** Medium
**Component:** `backend/src/models/journal_entry.py`
**Symptom:** Private reflections stored in plaintext. Database compromise exposes everything.
**Fix:** Application-layer column encryption (Fernet or `pgp_sym_encrypt`). Rotate keys with a KMS. Document in `DEPLOYMENT.md` and the privacy policy.

---

### BUG-JOURNAL-013: LIKE wildcards not escaped
**Severity:** Medium
**Component:** `backend/src/routers/journal.py:56`
**Symptom:** Searches for literal `%` or `_` produce false positives; no SQL injection (SQLAlchemy parameterizes), but UX is broken.
**Fix:** Escape `%`, `_`, `\` and pass `escape="\\"` to `.ilike`. Longer-term: migrate to Postgres full-text search.

---

### BUG-JOURNAL-014: Weekly prompt week from elapsed time
**Severity:** Medium
**Component:** `backend/src/routers/prompts.py:28-49`
**Symptom:** `int(elapsed / 7 days) + 1` auto-advances regardless of whether the user completed the earlier prompt. Users who miss a week lose access to that week's prompt forever.
**Fix:** Derive current week from `max(PromptResponse.week_number) + 1`, not elapsed time. Optionally cap by `current_stage`.

---

### BUG-JOURNAL-015: User message flushed before LLM call
**Severity:** Medium
**Component:** `backend/src/services/journal.py:43-58`, `backend/src/services/chat_stream.py:158-161`
**Symptom:** `flush()` persists the user's message; if the LLM call fails, the rollback only rolls back open work, but with autoflush/explicit flush semantics the write may still be visible. Orphaned user messages with no bot reply appear in history.
**Fix:** Do not `flush()` before the LLM call. Either:
- Persist both messages together after the LLM succeeds, OR
- Keep the pre-flush but on failure append a bot "error" placeholder marked as such so the UI has a sibling row, OR
- Use a savepoint: `async with session.begin_nested(): ...`.

---

### BUG-JOURNAL-016: Stream abort leaves user message stranded
**Severity:** Medium
**Component:** `backend/src/services/chat_stream.py`, `frontend/src/features/Journal/JournalScreen.tsx:519-540`
**Symptom:** On SSE error/close without `complete`, the frontend removes the bot placeholder but the user message remains — the user sees their own question with no response or indication.
**Fix:** Keep a "failed" bot placeholder with a retry affordance. Persist partial responses server-side when possible and reconcile on reload.

---

### BUG-JOURNAL-017: No prompt-injection guard
**Severity:** Medium
**Component:** `backend/src/services/botmason.py:199-214`
**Symptom:** User messages are concatenated raw with the system prompt; well-known injection phrases pass through.
**Fix:** Add a lightweight heuristic warning (log only, do not block) plus structured delimiters. Rely on the provider's instruction hierarchy — e.g., put user text inside an XML tag in the user message, and document in the system prompt that the assistant should only treat text inside `<user_input>` as user intent.

---

### BUG-JOURNAL-018: Monthly-usage reset concurrency window
**Severity:** Low
**Component:** `backend/src/services/wallet.py:59-76`
**Symptom:** At the exact rollover boundary, two requests can both see `monthly_reset_date <= now`. The WHERE clause makes the UPDATE idempotent, so damage is limited, but subtly derived counters elsewhere could double-reset.
**Fix:** Log the reset; add an assertion test for monthly rollover. Consider a Postgres advisory lock per user for the reset path.

---

## Suggested remediation order

1. **002, 004** (privacy/security) — same PR, small surface.
2. **003** (race + unique constraint) — migration + handler change.
3. **001, 005, 006** (LLM reliability) — land together so quota-consuming retries are safe.
4. **009, 010, 008** (observability + CORS + per-user limits).
5. **015, 016** (orphan messages + stream UX) — coordinate backend + frontend.
6. Remaining MEDIUM / LOW.
