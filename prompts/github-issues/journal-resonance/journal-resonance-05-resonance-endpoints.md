# journal-resonance-05: Resonance + marginalia endpoints

**Labels:** `backend`, `enhancement`
**Epic:** [Journal Resonance](journal-resonance-epic.md)
**Depends on:** [journal-resonance-02](journal-resonance-02-entry-document-fields.md), [journal-resonance-04](journal-resonance-04-resonance-service.md)
**Estimated LoC:** ~250

## Role

You are a backend engineer exposing the resonance service over HTTP and
persisting its results, with the existing wallet charge applied.

## Goal

Add `POST /journal/{entry_id}/resonance` (run a pass → persist `Marginalia` →
return them + wallet balances) and `GET /journal/{entry_id}/marginalia` (list a
page's notes). One pass charges one wallet unit by default, reusing BotMason's
existing wallet/preflight logic.

## Context

- Wallet preflight + charge (monthly cap, offering balance, BYOK, rate limit)
  already exists for chat in `backend/src/routers/botmason.py`. Reuse those
  helpers — do not reimplement billing.
- `generate_marginalia` (issue 04) produces anchored notes from a body.
- Response shapes are fixed in the epic contract.

## Tasks

1. **Schemas** in `schemas/journal.py` (or a new `schemas/marginalia.py`):
   - `MarginaliaResponse` (exact epic shape; omit `user_id`).
   - `ResonanceResponse`: `{ marginalia: list[MarginaliaResponse],
     remaining_messages: int, remaining_balance: int, monthly_reset_date }`
     (mirror `ChatResponse` wallet fields).
   - `MarginaliaListResponse`: `{ items: list[MarginaliaResponse] }`.
2. **`POST /journal/{entry_id}/resonance`**:
   - Load caller's non-deleted entry or `404`.
   - Wallet preflight (same as chat); `402`/`429` exactly as chat does.
   - Call `generate_marginalia(entry.message, llm=provider,
     prior_entries=<recent entries excerpts>)`.
   - Persist each anchored note as a `Marginalia` row (`status="active"`,
     `user_id` from auth, `essay=None`).
   - Charge one wallet unit (monthly first, then offerings) — only on success.
   - Return `ResonanceResponse` with refreshed balances.
   - Optional `Idempotency-Key` support mirroring chat (nice-to-have; if the
     chat idempotency helper is reusable, wire it; otherwise leave a TODO ref).
3. **`GET /journal/{entry_id}/marginalia`**:
   - Load caller's entry or `404`; return all its marginalia (active + stale),
     ordered by `anchor_start`.
4. **Tests** — `backend/tests/test_resonance_endpoints.py` (fake LLM + wallet):
   - Successful pass persists N rows and returns them; wallet decremented by 1.
   - Insufficient wallet → `402`, **no** rows persisted, **no** charge.
   - Another user's entry → `404` on both endpoints.
   - `GET` returns persisted notes ordered by `anchor_start`; `user_id` absent.
   - LLM error mid-pass → no partial charge, surfaced as the mapped error.

## Acceptance Criteria

- [ ] `POST .../resonance` persists anchored marginalia and charges exactly one
      wallet unit on success, nothing on failure.
- [ ] `GET .../marginalia` lists a page's notes, ownership-scoped, `user_id` hidden.
- [ ] Wallet/rate-limit/`402` behavior matches the existing chat endpoint.
- [ ] `./scripts/backend/check-all.sh` green.

## Files to Create / Modify

| File | Action |
|------|--------|
| `backend/src/routers/journal.py` | Modify (or a new `routers/resonance.py` mounted under `/journal`) |
| `backend/src/schemas/marginalia.py` | **Create** |
| `backend/tests/test_resonance_endpoints.py` | **Create** |

## Constraints

- Charge once per pass; never partially charge on error (transactional).
- Reuse the existing wallet/preflight/rate-limit helpers; do not fork them.
- Persist only notes whose anchors resolved (the service already guarantees
  `body[start:end] == anchor_text`).
