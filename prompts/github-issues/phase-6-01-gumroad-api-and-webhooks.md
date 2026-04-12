# phase-6-01: Gumroad API client, webhook scaffolding, HMAC verification

**Labels:** `phase-6`, `backend`, `monetization`, `priority-high`
**Epic:** Phase 6 — Gumroad-gated access and monetization
**Depends on:** phase-1-03
**Estimated LoC:** ~300–400 (including tests)

## Problem

Adepthood has no integration with Gumroad, so it cannot:

- Verify a buyer's license key before granting course access
- Receive notifications when a sale, refund, cancellation, or
  subscription event happens
- Store a durable record of Gumroad sales for idempotency and audit

This issue builds the shared infrastructure every other Phase 6 issue
depends on: a typed HTTP client for Gumroad's API, a webhook endpoint
that authenticates and deduplicates incoming events, and a raw sale
record used by downstream grant/credit logic.

**This issue intentionally does not change signup, does not grant
course access, and does not touch BotMason.** Those are follow-up issues
that build on the foundation laid here.

## Background — what Gumroad offers

- **License API** — `POST https://api.gumroad.com/v2/licenses/verify`
  with `product_id`, `license_key`, and optional `increment_uses_count`.
  Returns the sale record when valid, 404 when not. This is how we turn
  a user-supplied key into a verified sale at signup time.
- **Resource Subscriptions (webhooks)** — called "ping" in the docs. We
  subscribe (via `POST /v2/resource_subscriptions`) to `sale`, `refund`,
  `dispute`, `cancellation`, and `subscription_ended` events. Each
  event POSTs a form-encoded payload to our endpoint.
- **HMAC signing** — Gumroad supports a shared-secret model where each
  ping includes a signature header. We validate every incoming event
  before trusting any of its fields.

All three require a seller-scoped API token, generated from the Gumroad
seller settings page.

## Scope

### 1. Configuration and secrets

- Add env vars, all read at startup, fail-fast if missing in production:
  - `GUMROAD_API_TOKEN` — seller API token, used for license verification
  - `GUMROAD_WEBHOOK_SECRET` — shared secret for HMAC verification
  - `GUMROAD_APTITUDE_PRODUCT_IDS` — comma-separated allowlist of APTITUDE
    SKU IDs (one-time, monthly, any variants). Used to reject licenses
    from unrelated products.
  - `GUMROAD_TOKEN_PACK_PRODUCT_IDS` — comma-separated allowlist of
    token-pack SKU IDs, used by phase-6-05.
- Document in `backend/.env.example` and `README.md`.

### 2. Typed HTTP client (`backend/src/integrations/gumroad.py`)

- Use `httpx.AsyncClient` (already a transitive dep via FastAPI tests).
- Implement `verify_license(product_id: str, license_key: str) -> GumroadSale | None`
  that returns a typed `GumroadSale` Pydantic model on success and
  `None` on Gumroad's 404.
- Implement a structured logger call on every outbound request with
  latency and status, following the `reason_code` pattern in
  `routers/energy.py`.
- 5-second timeout; retry once on connection error (not on 4xx/5xx).
- Never log the license key or API token.

### 3. Webhook router (`backend/src/routers/gumroad.py`)

- Mount at `/webhooks/gumroad` (not `/auth/*` — these are
  service-to-service, not user-facing).
- `POST /webhooks/gumroad/ping` — single endpoint, event type is in
  the payload's `resource_name` field (`sale`, `refund`, ...).
- Verify the HMAC signature header using
  `hmac.compare_digest(expected, provided)`. Reject with 401 on
  mismatch. Log the rejection with `reason_code=invalid_signature`.
- Deduplicate by `sale_id` using a unique constraint on
  `GumroadSale.gumroad_sale_id` — if a duplicate arrives, return 200
  without reprocessing (idempotent replay).
- For this issue, the endpoint only **persists** the sale record;
  grant/credit logic is a downstream issue's responsibility. Emit a
  typed internal event (e.g., a dispatched pytest hook or a simple
  "unhandled resource type" log) for any `resource_name` we don't
  recognize yet, so `phase-6-02` and `phase-6-05` can wire in their
  handlers without modifying this scaffolding.

### 4. Raw sale model (`backend/src/models/gumroad_sale.py`)

- Fields: `id`, `gumroad_sale_id` (unique, indexed), `product_id`,
  `email`, `resource_name`, `is_recurring_charge`, `refunded`,
  `raw_payload` (JSON column), `created_at`.
- Alembic migration adds the table and unique index.

### 5. Tests

- Unit: `verify_license` mocks httpx and asserts request shape, parses
  success and 404 into the expected types, redacts secrets from logs.
- Unit: HMAC verification rejects tampered payloads and accepts valid
  ones (constant-time comparison; no early-exit on first byte).
- Integration: `POST /webhooks/gumroad/ping` with a valid signature
  persists exactly one `GumroadSale` row; replaying the same payload
  does not create a second row.
- Integration: invalid signature returns 401 and writes nothing.

## Acceptance criteria

- `backend/src/integrations/gumroad.py::verify_license` returns the
  correct typed result for valid, invalid, and unknown-product keys.
- `POST /webhooks/gumroad/ping` requires a valid HMAC signature and is
  idempotent on replay.
- Every Gumroad event we receive is persisted as a `GumroadSale` row
  regardless of whether downstream handlers exist yet.
- Tests pass and coverage for the new files is ≥ 90%.
- `pip-audit` clean; no new high-severity deps.
- `pre-commit run --all-files` green.

## Files to create / modify

| File | Action |
|------|--------|
| `backend/src/integrations/__init__.py` | Create |
| `backend/src/integrations/gumroad.py` | Create (API client) |
| `backend/src/routers/gumroad.py` | Create (webhook endpoint) |
| `backend/src/models/gumroad_sale.py` | Create |
| `backend/src/main.py` | Modify (mount router, validate env at startup) |
| `backend/alembic/versions/xxxx_gumroad_sale.py` | Create |
| `backend/.env.example` | Modify (add 4 vars) |
| `backend/tests/integrations/test_gumroad_client.py` | Create |
| `backend/tests/routers/test_gumroad_webhook.py` | Create |
| `README.md` | Modify (brief setup note with link to Gumroad docs) |

## Notes for implementer

- Store the raw webhook payload verbatim in `raw_payload`. Gumroad
  occasionally adds fields and we don't want to silently drop them.
- Do not hit the real Gumroad API in any test. All tests use mocked
  `httpx` transports.
- Treat the webhook secret as a credential: never log it, include in
  `detect-secrets` baseline if necessary.
- Follow the `reason_code` structured-logging pattern already
  established in `routers/energy.py` for every rejection path.
