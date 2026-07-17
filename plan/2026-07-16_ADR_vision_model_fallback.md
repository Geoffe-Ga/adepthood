# ADR-3: Fallback Policy for a Vision-Incapable Global Model

**Status:** Proposed · **Date:** 2026-07-16 · **Feature:** Journal
Photographer · **Depends on:** ADR-1 (server-side call)

**Context:** Transcription defaults to the globally configured model
(`BOTMASON_PROVIDER` + `LLM_MODEL`, `backend/src/services/botmason.py:204-206,
516`). What happens when that model cannot accept images?

Facts from research (findings § R2.3):

- **Every real model currently allowlisted supports vision** (gpt-4o-mini,
  gpt-4o, gpt-4-turbo; claude-sonnet-4-20250514, claude-haiku-4-5-20251001,
  claude-opus-4-7, claude-sonnet-4-6). The policy matters for (a) the
  **`stub` provider — the out-of-box default** — and (b) any future
  allowlist additions (e.g. a text-only or embedding-class model).
- The registry is declarative (`PROVIDER_REGISTRY`, `botmason.py:112-136`)
  and already fails fast on non-allowlisted `LLM_MODEL`
  (`botmason.py:520-527`) — the natural place for a capability flag.
- Precedent for "feature unavailable → explicit HTTP error with a stable
  error code": 402 `llm_key_required` (`botmason.py:272-273`), 502
  `llm_provider_error` (`routers/journal.py:508-512`).

**Impact:** provider registry shape, transcription endpoint error contract,
client failure-path copy, operator documentation (`.env.example`).

---

## Option 1: Explicit error with guidance (no fallback)

Add vision capability metadata to the registry (e.g. `vision_models:
frozenset[str]` per provider, or a `supports_vision` predicate). If the
resolved model lacks vision, the endpoint returns **422
`model_lacks_vision`** with a message naming the configured model and the
vision-capable options on that provider's allowlist. The client maps this to
a user-facing "Photo transcription isn't available with the configured AI
model" state. The `stub` provider is treated as vision-capable via a canned
stub transcription (dev/test parity with `_stub_response`,
`botmason.py:656-673`).

**Pros:** no surprise model substitution — the operator's (or BYOK user's)
explicit model choice is never silently overridden on cost or behavior;
matches the codebase's fail-fast philosophy (`botmason.py:520-527`,
`llm_pricing.py`'s refusal to guess unknown-model cost); trivially testable;
zero new configuration.

**Cons:** feature is hard-down until the operator changes `LLM_MODEL` —
though today that configuration is impossible with real providers (all
allowlisted models have vision), so the cost is theoretical.

**Effort:** Low.

## Option 2: Silent fallback to a designated vision model

Registry gains a `default_vision_model` per provider; when the configured
model lacks vision, transcription transparently uses that model (same
provider, so the same API key works).

**Pros:** feature always works; zero operator action.

**Cons:** violates least surprise — the operator pinned a model
(deliberately, per the pin-vs-alias commentary at `botmason.py:100-110`) and
gets a different one billed and logged; cost can silently jump (e.g.
configured haiku → fallback sonnet is 3× input / 3× output per
`llm_pricing.py:70-82`); usage log rows show a model the operator never
configured, confusing the admin cost dashboard (`routers/admin.py:110-182`);
BYOK users are billed on their own key for a model they didn't choose.

**Effort:** Low–Medium (plus documentation debt).

## Option 3: Dedicated `LLM_VISION_MODEL` env override + error otherwise

A new optional env var explicitly names the transcription model; unset →
use the global model if vision-capable, else the Option-1 error.

**Pros:** operators can run cheap text models globally and a specific vision
model for transcription; explicit, never silent.

**Cons:** new configuration surface and documentation for a need no current
deployment has (all real allowlisted models have vision); a second
model-resolution path in `_get_model` to test; premature flexibility.

**Effort:** Medium.

---

## Comparison matrix

| Criterion | 1: explicit error | 2: silent fallback | 3: env override |
|---|---|---|---|
| Respects operator/BYOK model choice | ✅ | ❌ | ✅ |
| Cost predictability | ✅ | ❌ silent jumps | ✅ |
| Usage-log / dashboard accuracy | ✅ | ❌ unexpected model rows | ✅ |
| Feature availability when misconfigured | ❌ hard-down (theoretical today) | ✅ | ✅ if set |
| New config surface | none | none | +1 env var |
| Consistency with codebase fail-fast style | ✅ | ❌ | ⚠️ |
| Effort | Low | Low–Med | Medium |

## Recommendation

**Option 1 — explicit 422 error with guidance**, with vision capability
declared in the provider registry and a stub-provider canned transcription
path. Every real allowlisted model supports vision today, so the error is a
guard rail, not a user-visible state; silent fallback (Option 2) buys
availability nobody currently needs at the price of cost and audit
surprises. Option 3 can be layered on later without breaking the Option-1
contract if a text-only model ever joins the allowlist — note that in
`.env.example` rather than building it now.

**Question for reviewer:** confirm Option 1 (with Option 3 noted as the
future escape hatch).
