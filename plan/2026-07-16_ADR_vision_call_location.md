# ADR-1: Where the Vision (Transcription) Call Happens

**Status:** Proposed · **Date:** 2026-07-16 · **Feature:** Journal
Photographer

**Context:** Journal-page images must be transcribed by an LLM. Someone has
to hold provider credentials, apply the transcription prompt, enforce
retry/timeout/rate-limit policy, and record usage. The app already routes
every LLM call through the backend (`backend/src/services/botmason.py`), with
optional BYOK via the `X-LLM-API-Key` header
(`frontend/src/api/index.ts:189`).

**Impact:** backend router + `botmason.py`, frontend API client, privacy
guarantees (R4), usage metering (`services/llm_usage.py`), rate limiting.

---

## Option 1: Client → FastAPI → Provider (server-side call)

The RN client uploads image(s) to a new backend endpoint; the backend builds
the vision message and calls the provider through the existing
`generate_response(...)` path.

**Pros**

- Reuses the entire existing LLM stack unchanged: provider registry +
  model resolution (`botmason.py:112-136`, `:516`), 30s timeout + 2-retry
  transient handling (`botmason.py:139-144`, `:575-602`), `LLMProviderError`
  → 502 mapping (`routers/journal.py:508-512`), BYOK resolution
  (`botmason.py:291-323`), and token-count-only usage logging
  (`services/llm_usage.py:26-57`).
- Server key (`LLM_API_KEY`) never ships to the device; BYOK keeps working
  identically (header already forwarded by the client for resonance).
- Transcription prompt lives server-side next to the other prompt builders
  (`domain/resonance.py:77-110` convention) — updatable without an app
  release; prompt-injection wrapping conventions stay in one place.
- Server-side enforcement of page cap, per-image size/content-type
  validation, and slowapi rate limits (matching `10/minute` on resonance,
  `journal.py:717`) — a client-direct call could bypass none of these.
- Usage metering and any future wallet charging are only possible here.

**Cons**

- Image bytes transit our backend (memory-only, per R4 constraints) — one
  more hop, one more surface to keep log/persistence-clean.
- Backend bandwidth/latency: ~0.4–0.8 MB base64 per page through Railway.

**Implementation effort:** Medium (one endpoint + content-block extension to
`botmason.py`).

## Option 2: Client → Provider directly (device-side call)

The RN app calls Anthropic/OpenAI vision APIs itself; only the resulting
text is sent to the backend as a normal journal entry.

**Pros**

- Image bytes never touch our infrastructure — the strongest possible
  server-side no-persistence story.
- One less network hop for the image payload.

**Cons**

- **Key handling is disqualifying for the default path:** the server's
  `LLM_API_KEY` would have to be embedded in or delivered to the app —
  extractable from any device. Only BYOK users could use the feature safely,
  inverting the current model where BYOK is optional
  (`resolve_chat_api_key`, `botmason.py:272-273`).
- Duplicates the provider abstraction, retry, timeout, and error taxonomy in
  TypeScript — a parallel implementation of `botmason.py` to keep in sync
  (violates the "existing LLM infrastructure, no new provider abstraction"
  product requirement).
- Transcription prompt ships in the app bundle — fixed per release,
  extractable, and outside the server prompt conventions.
- No server-side page cap, size validation, rate limiting, or usage
  metering; wallet integration impossible.
- Client CSP/network assumptions: the API layer is built exclusively around
  `API_BASE_URL` (`index.ts:749`); provider calls would be the first
  third-party origin.

**Implementation effort:** High (parallel LLM stack in the client).

---

## Comparison matrix

| Criterion | 1: via FastAPI | 2: client-direct |
|---|---|---|
| Server API key safety | ✅ never leaves server | ❌ extractable from app |
| Works without BYOK | ✅ | ❌ |
| Reuses existing LLM infra (product requirement) | ✅ 100% | ❌ duplicates it |
| Prompt updatable server-side | ✅ | ❌ app release |
| Page cap / size validation / rate limit enforceable | ✅ | ❌ |
| Usage metering + future wallet | ✅ | ❌ |
| Image bytes touch our backend | ⚠️ yes (memory-only) | ✅ no |
| Dev effort / maintenance | Medium | High + ongoing duplication |

## Recommendation

**Option 1 — client → FastAPI → provider.** It is the only option compatible
with the settled product requirement to use the existing LLM infrastructure
and default global model settings, and the only one where key handling,
validation, and metering are enforceable. The one advantage of Option 2
(images never touch the backend) is addressed by the R4 constraints: bounded
base64 JSON, in-memory handling only, no `UploadFile` spooling, no
content-bearing logs, verified by regression tests.

**Question for reviewer:** confirm Option 1.
