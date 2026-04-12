# phase-6-06: Admin endpoints for manual grants, revocations, and balance adjustments

**Labels:** `phase-6`, `backend`, `admin`, `monetization`, `priority-medium`
**Epic:** Phase 6 — Gumroad-gated access and monetization
**Depends on:** phase-6-02, phase-6-04, phase-6-05
**Estimated LoC:** ~250–350 (including tests)

## Problem

Even with Gumroad as the system of record, manual override is required
for at least four scenarios:

1. **Gumroad is down** and a user needs access to present the course
   at a conference tomorrow.
2. **Comped access** — a friend, an early tester, or a beta cohort
   member needs to bypass the purchase flow entirely.
3. **Goodwill credits** — a support conversation ends in "here, have
   another 5000 tokens on me", with no Gumroad sale behind it.
4. **Corrective revocation** — a user is abusing the service and you
   need to cut them off independent of Gumroad state.

Without this endpoint, those scenarios require a SQL console. That's
error-prone, unauditable, and leaves no paper trail.

This issue adds a small admin surface that wraps the domain helpers
introduced in phase-6-02 (entitlements), phase-6-04 (token wallet),
and phase-6-05 (revocation). Every override is logged with an admin
identity, a reason, and a timestamp.

## Design decisions

- **No new UI.** These are backend endpoints only. The operator uses
  `curl` or a small admin web tool later. Putting this behind a UI
  is explicitly out of scope for this issue.
- **Simple token-based admin auth.** No new user roles — that's more
  complexity than this product needs right now. A single
  `ADMIN_API_TOKEN` env var gates the endpoints, sent as an
  `X-Admin-Token` header. If we later need multi-admin or audit-per-
  person, that's a separate (easy) refactor on top of this.
- **Reason string is required.** Every override records a human-
  readable justification in the ledger / entitlement `metadata`
  column. No mysterious grants.
- **Idempotency by operation key.** Every admin call takes an
  optional `X-Idempotency-Key` header; we reject replays (same
  key, different body) and silently succeed on exact replays. Same
  pattern as `/v1/energy/plan`.

## Scope

### 1. Admin auth dependency (`backend/src/routers/admin.py`)

- `require_admin(x_admin_token: str = Header(...))` — compares the
  header against `ADMIN_API_TOKEN` using `hmac.compare_digest`.
  Raises 401 on mismatch. Logs every rejected attempt with
  `reason_code=admin_auth_failed` and the source IP.
- Startup check in `main.py`: if `ADMIN_API_TOKEN` is unset in
  production, fail fast.

### 2. Endpoints

All mounted at `/admin/` and protected by `require_admin`.

#### `POST /admin/users/{user_id}/entitlements`
Grant a manual entitlement.
- Body: `{ "kind": "course_access", "reason": "string",
  "expires_at": null | datetime }`
- Writes an `Entitlement` row with `source_sale_id=NULL`,
  `metadata={"admin_granted_by": <ip>, "reason": <reason>}`.
- Returns the created entitlement.

#### `DELETE /admin/users/{user_id}/entitlements/{entitlement_id}`
Revoke a specific entitlement.
- Body: `{ "reason": "string" }`
- Sets `revoked_at` and stamps the reason into `metadata`.
- 404 if the entitlement is already revoked or doesn't exist.

#### `POST /admin/users/{user_id}/tokens`
Adjust the token balance by an arbitrary delta.
- Body: `{ "delta": int, "reason": "string" }`
- `delta` may be negative; the balance may go negative. Writes a
  `TokenLedgerEntry` with `kind="admin_adjustment"`,
  `reason_code="admin:<first word of reason>"`.
- Returns the new balance.

#### `GET /admin/users/{user_id}/summary`
Read-only debugging endpoint returning:
- Email, created_at.
- Active entitlements.
- Current token balance.
- Last 20 ledger entries (most recent first).
- Last 10 Gumroad sales by this user's email.

Useful when a user emails support with "why can't I chat with
BotMason?" and you need to see the whole picture in one request.

### 3. Structured logging

Every admin mutation logs:
- `actor="admin"`
- `action` (e.g., `grant_entitlement`, `revoke_entitlement`,
  `adjust_balance`)
- `target_user_id`
- `reason` (free-form)
- `source_ip`

These land in the same structured-log stream as user actions, which
means they show up in whatever log aggregation lands in phase-4-10
(Railway deployment) without extra wiring.

### 4. Rate limiting and audit

- Apply a `slowapi` limit of `30/minute` per IP on admin endpoints.
  If we ever see an admin IP hitting this, something's wrong.
- Persist every admin mutation to an `AdminAuditLog` table (new —
  separate from the structured logs, for queryable history). Fields:
  `id`, `action`, `target_user_id`, `payload` (JSON), `reason`,
  `source_ip`, `idempotency_key`, `created_at`.

### 5. Tests

- Unit: `require_admin` rejects missing header, wrong token, correct
  header.
- Integration: `POST /admin/users/{id}/entitlements` creates the
  entitlement and writes an audit log row.
- Integration: same idempotency key twice returns the same result;
  same key with a different body returns 409.
- Integration: negative balance adjustment is allowed and logged.
- Integration: `GET /admin/users/{id}/summary` returns the expected
  shape with real user data.
- Integration: endpoints return 401 without the admin header.
- Unit: all admin mutations write a structured log with the expected
  fields.

## Acceptance criteria

- Operator can grant/revoke course access without touching SQL.
- Operator can adjust any user's BotMason token balance.
- Operator can see a user's complete entitlement + wallet state in
  one call.
- Every mutation is audited in a queryable table and in structured
  logs.
- Missing/invalid admin token returns 401; valid token is required
  on every admin endpoint.
- Coverage ≥ 90% on the new files.

## Files to create / modify

| File | Action |
|------|--------|
| `backend/src/routers/admin.py` | Modify (large — new admin endpoints) |
| `backend/src/models/admin_audit_log.py` | Create |
| `backend/src/domain/admin.py` | Create (thin layer over entitlements + wallet) |
| `backend/src/main.py` | Modify (admin token env check) |
| `backend/alembic/versions/xxxx_admin_audit_log.py` | Create |
| `backend/.env.example` | Modify (`ADMIN_API_TOKEN`) |
| `backend/tests/routers/test_admin.py` | Create |
| `README.md` | Modify (brief ops note: how to use the admin endpoints) |

## Notes for implementer

- There's already a `backend/src/routers/admin.py` from an earlier
  issue — check its existing contents and augment rather than
  replace. The auth dependency may already exist.
- Do not expose ledger entries to non-admin users. The existing
  `/users/me/tokens` endpoint (phase-6-04) returns only the balance,
  not the history; that's intentional and stays.
- Resist scope creep: this is not the place to build dashboards,
  export CSVs, or add per-admin identities. Those are future issues.
- Keep the admin token out of logs (same caution as the Gumroad
  webhook secret). The `detect-secrets` hook should catch
  accidental leaks but don't rely on it.
