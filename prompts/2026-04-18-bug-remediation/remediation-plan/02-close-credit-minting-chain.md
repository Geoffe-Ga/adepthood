# Prompt 02 — Close the credit-minting chain (Stage 2, serial after Prompt 01)

## Role
You are a backend security engineer with deep FastAPI + SQLModel experience. You handle privilege boundaries, admin identity, and request validation for financial-adjacent endpoints.

## Goal
Make it impossible for an unauthenticated or non-admin caller to add BotMason credits to any user wallet. Three linked bugs enable the current exploit; all three must land in a single coordinated diff.

Success criteria:

1. `POST /user/balance/add` rejects unauthenticated requests with 401 and non-admin callers with 403.
2. `BalanceAddRequest.amount` is clamped to a reasonable positive range (spec below) and rejects zero, negatives, absurd values (>1,000,000), and non-integers.
3. Admin identity is a first-class `User.is_admin: bool` column (not a shared env-var secret). A new test proves a normal user cannot escalate, and the admin check is reused across the admin router and `/user/balance/add`.
4. A migration adds `is_admin` (default `False`), and one existing user can be flipped via a CLI one-liner documented in the PR description.
5. Regression test: unauthenticated + authenticated-non-admin + authenticated-admin paths all exercised; coverage stays >=90%.

## Context
- `prompts/2026-04-18-bug-remediation/08-backend-observability-admin.md` — **BUG-ADMIN-001** (no `is_admin` column; admin router uses shared env-var secret).
- `prompts/2026-04-18-bug-remediation/13-botmason-wallet-llm.md` — **BUG-BM-010** (`POST /user/balance/add` is unauthenticated).
- `prompts/2026-04-18-bug-remediation/07-backend-models-schemas.md` — **BUG-SCHEMA-009** (`BalanceAddRequest.amount` unbounded).
- Files you will touch (expect ≤10): `backend/src/models/user.py`, `backend/src/routers/{admin,wallet_or_balance}.py`, `backend/src/schemas/wallet.py` (or equivalent), `backend/src/dependencies/auth.py` (add `require_admin`), `backend/alembic/versions/<new>_add_user_is_admin.py`, tests.
- Landing order inside the prompt: BUG-ADMIN-001 → BUG-BM-010 → BUG-SCHEMA-009. Do not reorder.

## Output Format
Deliver as **3 atomic commits**:

1. `feat(backend): add User.is_admin column + require_admin dependency` — migration, model change, dependency, admin router switches from env-var secret to `require_admin`.
2. `fix(backend): require admin on POST /user/balance/add` — attach `require_admin`, delete the unauthenticated code path, add 401/403 tests.
3. `fix(backend): clamp BalanceAddRequest.amount to [1, 1_000_000]` — Pydantic field constraints, rejection tests, update OpenAPI docs if needed.

Each commit body lists the BUG-ID it closes and the test file(s) exercising it.

## Examples

Dependency pattern:
```python
# backend/src/dependencies/auth.py
async def require_admin(
    current_user: User = Depends(get_current_user),
) -> User:
    if not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Admin privileges required")
    return current_user
```

Schema clamp:
```python
class BalanceAddRequest(BaseModel):
    amount: int = Field(..., ge=1, le=1_000_000)
```

## Requirements
- Use `security` skill guidance for FastAPI auth boundaries.
- Use `bug-squashing-methodology` — write the RCA + reproduction test before the fix for each BUG-ID.
- Every new endpoint test covers three cases: anonymous, normal user, admin.
- Do not rename `require_current_user` or other existing dependencies; add alongside.
- Do not touch the LLM wallet accounting logic beyond the auth boundary — that is covered by Prompt 12.
- Migration must be reversible (`downgrade()` drops the column).
- Run `pre-commit run --all-files` before every commit; keep coverage >=90%.
- Do not read entire reports — use `Grep` to find each BUG-ID block, read ~50 lines of context.
- Land all three commits before pushing.
