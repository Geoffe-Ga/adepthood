# phase-6-02: Course entitlement model and signup gating via license redemption

**Labels:** `phase-6`, `backend`, `monetization`, `priority-high`
**Epic:** Phase 6 — Gumroad-gated access and monetization
**Depends on:** phase-6-01
**Estimated LoC:** ~400–500 (including tests)

## Problem

Once phase-6-01 is in place, the backend can verify Gumroad licenses and
receive sale webhooks, but nothing gates access on them. Any email +
password combination still produces a usable account.

This issue introduces the **course entitlement** — a per-user, binary
"may access paid course content" flag — and modifies signup so that an
account can only be created alongside a verified Gumroad license. It
also wires the webhook handler from phase-6-01 to grant entitlement
when a sale event arrives for a pre-registered email.

Refund and cancellation revocation are out of scope for this issue and
are covered in phase-6-05.

## Design decisions

- **Entitlement, not role**: We use a dedicated `Entitlement` table
  rather than a boolean column on `User`, because we anticipate more
  kinds of entitlements (BotMason tokens in phase-6-04, future
  cohort-gated content, etc.), and because entitlements have their own
  lifecycle (granted, revoked, source sale, timestamps) that doesn't
  belong on the user record.
- **Email as the join key**: Gumroad's identity is the buyer's email.
  At signup we require the user to use the same email they used on
  Gumroad; the license verification proves they hold the key for a sale
  issued to that email.
- **License key required for the primary signup flow**: Per the epic,
  every user must have a Gumroad sale. The signup request therefore
  requires `license_key` in addition to `email` and `password`.
- **Verify-then-create**: The signup transaction verifies the license
  first. Only on verification success does it create the `User` and
  `Entitlement` rows. A failed verification returns a generic
  `invalid_license` error without revealing whether the key format, the
  key value, or the product ID was the mismatch — same account-
  enumeration caution that already guards login.
- **Webhook-first paths also work**: If a Gumroad sale webhook arrives
  for an email that already has a `User` but no `Entitlement`, the
  webhook handler creates the entitlement. This covers the case where
  someone buys a new SKU (e.g. a monthly subscription) after signing
  up.

## Scope

### 1. Entitlement model (`backend/src/models/entitlement.py`)

- Fields: `id`, `user_id` (FK, indexed), `kind` (enum:
  `course_access` for now; `botmason_tokens` lands in phase-6-04),
  `product_id` (nullable; links to the Gumroad SKU when applicable),
  `source_sale_id` (FK to `GumroadSale`, nullable for manual grants),
  `granted_at`, `revoked_at` (nullable), `metadata` (JSON column for
  future extensibility without migrations).
- Unique partial index on `(user_id, kind)` where `revoked_at IS NULL`,
  so a user has at most one active entitlement of each kind.
- Alembic migration adds the table and index.

### 2. Domain logic (`backend/src/domain/entitlements.py`)

- `grant_course_access(session, user, sale)` — idempotent: if an active
  `course_access` entitlement already exists for the user, update
  `source_sale_id` in place rather than creating a duplicate. Returns
  the entitlement.
- `has_course_access(session, user_id) -> bool` — reads the active
  entitlement, used by the signup gate and by any route that later
  wants to paywall content.
- `revoke_course_access(session, user_id, reason)` — sets
  `revoked_at=now()`; a helper for phase-6-05 (refund handling) and
  phase-6-06 (admin revocation).
- Structured logging on every grant/revoke with
  `reason_code` (e.g. `signup_redemption`, `webhook_sale`, `refund`,
  `admin_override`).

### 3. Modified signup flow (`backend/src/routers/auth.py`)

- `AuthRequest` gains an optional `license_key` field. Make it optional
  in the schema to preserve login's payload, but required in the
  signup handler's validation.
- Before creating the user:
  1. Call `gumroad.verify_license(product_id=<each APTITUDE id>,
     license_key=payload.license_key)` against the allowlist from
     `GUMROAD_APTITUDE_PRODUCT_IDS` until one matches. Stop on first
     match.
  2. On no match → `raise bad_request("invalid_license")` with the
     same generic message used for the other account-enumeration
     defenses (200 ms dummy-hash delay kept).
  3. On match → assert the license's email matches
     `payload.email` (case-insensitive). If not, return
     `invalid_license` (don't expose that the key is valid for a
     different account).
  4. Find or create the `User` row. If found with no active
     entitlement (webhook-preregistered), continue; if found with
     an active entitlement, return the same `invalid_license` to
     avoid account enumeration while logging
     `reason_code=duplicate_signup` server-side.
  5. Create the `Entitlement` with `source_sale_id` pointing at the
     `GumroadSale` row we can look up by `gumroad_sale_id`.
  6. Issue the JWT and return.
- The rate limit stays at `3/minute` on signup. Add a second-layer
  limit of `10/hour` per IP on invalid-license attempts specifically,
  to blunt brute-forcing of license keys. Hooks into the existing
  `slowapi` limiter.

### 4. Webhook handler for sale events

- Extend `backend/src/routers/gumroad.py` (from phase-6-01): when the
  stored `GumroadSale.resource_name == "sale"`, dispatch to a handler
  that looks up an existing `User` by email.
  - If the user exists: call `grant_course_access` (idempotent).
  - If no user exists yet: do nothing beyond persisting the
    `GumroadSale` row. The next signup attempt with that email +
    license key will find it.

### 5. Tests

- Unit: `grant_course_access` is idempotent, revoking then re-granting
  works, uniqueness is preserved.
- Integration: signup with no `license_key` → 400.
- Integration: signup with invalid `license_key` → 400, no user row
  created, no entitlement created.
- Integration: signup with a valid key for a non-APTITUDE product → 400
  (license matches but product not on allowlist).
- Integration: signup with a valid key but mismatched email → 400 with
  same `invalid_license` message; server logs `email_mismatch`.
- Integration: signup with a valid key, matched product, matched email
  → 201, user row, entitlement row, JWT returned.
- Integration: duplicate signup (same email, same key) returns
  `invalid_license` without leaking that the account exists.
- Integration: sale webhook arrives before signup → only
  `GumroadSale` row; subsequent signup succeeds and links to it.

## Acceptance criteria

- Signup without a valid APTITUDE Gumroad license is impossible.
- The $0 free-tier SKU works identically to paid SKUs, as long as its
  product ID is on `GUMROAD_APTITUDE_PRODUCT_IDS`.
- Webhook-arriving-first and signup-arriving-first both produce the
  same end state (user + entitlement + link to sale).
- No account-enumeration leak from any rejection path.
- Coverage ≥ 90% on new files; existing auth tests still pass.

## Files to create / modify

| File | Action |
|------|--------|
| `backend/src/models/entitlement.py` | Create |
| `backend/src/domain/entitlements.py` | Create |
| `backend/src/routers/auth.py` | Modify (license gate) |
| `backend/src/routers/gumroad.py` | Modify (sale-event dispatch) |
| `backend/alembic/versions/xxxx_entitlement.py` | Create |
| `backend/tests/routers/test_auth_signup_license.py` | Create |
| `backend/tests/routers/test_gumroad_sale_dispatch.py` | Create |
| `backend/tests/domain/test_entitlements.py` | Create |
| `frontend/src/api/types.ts` | Regenerate (OpenAPI) |

## Notes for implementer

- The "always verify against every APTITUDE product ID" loop is
  acceptable because the allowlist is small (single digits). If it
  grows large, switch to reading the sale by ID once we get it back.
- Do not expose Gumroad's verify-response fields in our API response.
  Only the JWT leaves the backend.
- Preserve the timing-attack defense: all failure paths should still
  do the dummy bcrypt hash that the current signup does.
