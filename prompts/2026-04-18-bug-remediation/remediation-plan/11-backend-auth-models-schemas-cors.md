# Prompt 11 — Backend hardening: auth, models, schemas, CORS, migrations (Wave 4, parallelizable)

## Role
You are a backend engineer tidying up the foundations: auth edge cases, model completeness, schema rigor, CORS validation, and migration safety. You work in small, reviewable commits grouped by concern.

## Goal
Fix the remaining High / Critical bugs in reports 01, 05, 06, 07 that are NOT already covered by Prompts 02, 06, 10. These are independent-ish cleanups that benefit from a single owner to keep the patterns consistent.

Success criteria:

1. Auth: bcrypt truncation guarded (explicit pre-hash length check), lockout skip-attempt fixed, malformed JWT `sub` returns 401 (not 500), refresh-token JTI + revocation table, `AuthRequest.password` length bounds, no blank-password accounts.
2. App/CORS: `_validate_https_origins` uses a proper URL parser (rejects bare IPs, `localhost`, userinfo, wildcards in prod), `/health` split into `/health/live` + `/health/ready` with a probe timeout.
3. DB: every FK to `user.id` gets `ondelete=`; downgrade paths for existing migrations fixed (no fractional truncation, prompt-response restore); enum CHECK migrations include upstream normalization.
4. Models/schemas: `User` gets `is_active`, `email_verified`, soft-delete (`deleted_at`); `Milestone` schema expanded beyond one field; `CheckInResult.reason_code` becomes a Literal/Enum; remaining Medium/Low schema gaps closed.
5. Startup secret check: `SECRET_KEY` misconfiguration raised at app init, not first auth request.

## Context
Bug IDs (skip those marked [done-by-N] — covered elsewhere):
- Report 01 (auth): BUG-AUTH-004 (bcrypt truncation), -006 (lockout skip-attempt), -011 (SECRET_KEY check), -012 (malformed sub → 500), -013 (refresh without invalidation), -017 (password length bounds), -018 (blank password default). Skip -001/-003/-007/-008/-016 [done-by-02/06/03].
- Report 05 (app/cors): BUG-APP-003 (origin validation), -004 (health split), -009 (loader-path alias). Skip -001/-002/-006/-007/-008 [done-by-10/02/04].
- Report 06 (db): BUG-DB-003 (no ondelete), -006 (downgrade truncation), -010 (enum check). Skip -001/-002/-007/-008 [done-by-06/05/06].
- Report 07 (models/schemas): BUG-MODEL-001 (User is_active/email_verified/soft-delete) — note the `is_admin` field landed in Prompt 02; add the rest. BUG-MODEL-002 (FK ondelete) — overlap with BUG-DB-003, land together. BUG-SCHEMA-002 (Milestone stub), -003 (reason_code unconstrained), plus Medium items -001/-004/-005/-010 and -MODEL-003/-004/-005. Skip -006/-007/-008/-009 [done-by-03/09/02].

Files you will touch (expect ≤20): `backend/src/routers/auth.py`, `backend/src/domain/auth.py`, `backend/src/models/*.py`, `backend/src/schemas/*.py`, `backend/src/main.py` (startup), `backend/src/middleware/cors.py`, several Alembic migrations.

## Output Format
Four atomic commit clusters (each cluster = 1-3 commits, ≤6 commits total):

1. `fix(backend): auth hardening (bcrypt/lockout/sub/refresh/bounds/default)` — covers BUG-AUTH-004/-006/-011/-012/-013/-017/-018.
2. `fix(backend): CORS origin validation + health split + loader fix (BUG-APP-003/-004/-009)`.
3. `fix(db): add ondelete; fix downgrade truncation; enum normalization (BUG-DB-003/-006/-010)`.
4. `feat(backend): User is_active/email_verified/soft-delete; tighten schemas (BUG-MODEL-001/-002/Medium, BUG-SCHEMA-002/-003/Medium)`.

## Examples

bcrypt length guard:
```python
def hash_password(pw: str) -> str:
    if len(pw.encode("utf-8")) > 72:
        raise ValueError("password too long (bcrypt 72-byte limit)")
    return bcrypt.hashpw(pw.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
```

CORS origin validation:
```python
def _validate_prod_origin(origin: str) -> None:
    p = urlparse(origin)
    if p.scheme != "https":
        raise ValueError("prod origin must be https")
    if not p.hostname or p.hostname in {"localhost", "127.0.0.1"}:
        raise ValueError("prod origin cannot be localhost or loopback")
    try:
        ipaddress.ip_address(p.hostname)
        raise ValueError("prod origin cannot be a bare IP")
    except ValueError:
        pass
    if "*" in origin or "@" in origin:
        raise ValueError("prod origin cannot contain wildcard or userinfo")
```

Health split:
```python
@app.get("/health/live")
async def liveness(): return {"status": "ok"}

@app.get("/health/ready", response_model=ReadyResponse)
async def readiness():
    try:
        async with asyncio.timeout(2.0):
            await session.execute(select(1))
    except (TimeoutError, OperationalError):
        raise HTTPException(503, "db not ready")
    return {"status": "ready"}
```

## Requirements
- `security`: JWT changes MUST include a migration for existing tokens (e.g., bump issuer `iss` or kid rotation) or a grace window; do not silently break every active session.
- `bug-squashing-methodology` for auth bugs — write the failing test first.
- `max-quality-no-shortcuts`: do not `noqa` Pydantic deprecation warnings; upgrade to v2 idioms if needed.
- Refresh token JTI revocation can be a DB table (`revoked_tokens(jti, expires_at)`) — index on `jti`.
- If a Medium-severity schema bug conflicts with a router consumer you don't want to touch, document and skip; leave a follow-up note in the bug report file.
- Do NOT touch `is_admin` (landed in Prompt 02) beyond adding siblings.
- `pre-commit run --all-files` before each commit; coverage >=90%.
- Safe to parallelize with 04-10, 12-15. May conflict with Prompt 06 (unique constraints) — land Prompt 06 first.
