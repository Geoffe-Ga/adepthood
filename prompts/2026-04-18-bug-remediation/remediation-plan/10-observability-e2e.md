# Prompt 10 — End-to-end observability (Wave 3, parallelizable)

## Role
You are an SRE/observability engineer. You want a single request to be traceable from the React Native error boundary through the API gateway, through the FastAPI handler, into any LLM subcall, and back to the client as a usable error. You use Decimal for money. You never `console.error`-and-forget.

## Goal
Wire frontend + backend to the same Sentry/observability project, add a global exception handler, fix middleware ordering, and convert monetary floats to `Decimal`.

Success criteria:

1. `X-Request-ID` flows through every log line on backend; frontend correlates via response header echo.
2. Global exception handler on FastAPI catches unhandled exceptions, logs with request ID, returns a stable error shape, and reports to Sentry.
3. Middleware order: logging → trace-id → security-headers → CORS → rate-limit — so CORS headers and security headers appear on 4xx/5xx from deeper middlewares.
4. `install_trace_id_logging()` runs at module import (not in lifespan startup) so import-time logs have the trace id filter.
5. `ErrorBoundary` and `FeatureErrorBoundary` report to Sentry (or the project's chosen SDK) with component context, surface a user-visible retry, and reset on route change.
6. All `estimated_cost_usd`, wallet balances, and LLM cost fields use `Decimal` end to end; JSON serialization uses string-quantized form; 0.0 defaults removed for unknown models (surface a warning).
7. Wallet mutations produce an audit trail row (who, amount, reason, before/after).

## Context
- `prompts/2026-04-18-bug-remediation/05-backend-app-cors.md` — **BUG-APP-001** (middleware add order LIFO), **BUG-APP-002** (preflight bypasses security headers), **BUG-APP-007** (trace-id install too late).
- `prompts/2026-04-18-bug-remediation/08-backend-observability-admin.md` — **BUG-OBS-002**, **BUG-OBS-003** (no global exception handler), **BUG-ADMIN-004** (`estimated_cost_usd` as float).
- `prompts/2026-04-18-bug-remediation/13-botmason-wallet-llm.md` — **BUG-BM-008** (float cost; 0.0 default for unknown), **BUG-BM-011** (no audit trail for wallet mutations).
- `prompts/2026-04-18-bug-remediation/18-frontend-design-state-tests.md` — **BUG-FE-UI-101** (`ErrorBoundary` console-only), **BUG-FE-UI-102** (`FeatureErrorBoundary` no route reset).
- `prompts/2026-04-18-bug-remediation/04-frontend-api-client.md` — **BUG-API-018** (401s all mapped to "session expired" — masks dummy-token distinction).

Files you will touch (expect ≤16): `backend/src/main.py`, `backend/src/middleware/{logging,trace_id,security_headers}.py`, `backend/src/errors.py` (global handler), `backend/src/models/wallet.py` (audit trail), `backend/src/domain/wallet.py`, `frontend/src/components/{ErrorBoundary,FeatureErrorBoundary}.tsx`, `frontend/src/observability/sentry.ts` (new), new `backend/alembic/versions/<new>_wallet_audit.py`.

## Output Format
Five atomic commits:

1. `fix(backend): reorder middleware; install trace-id at import (BUG-APP-001, -002, -007)`.
2. `feat(backend): global exception handler + error envelope (BUG-OBS-002, -003)`.
3. `refactor(backend): wallet + cost to Decimal; audit trail table (BUG-ADMIN-004, BUG-BM-008, BUG-BM-011)`.
4. `feat(frontend): wire ErrorBoundary + FeatureErrorBoundary to Sentry; route reset (BUG-FE-UI-101, -102)`.
5. `fix(frontend): distinguish 401 reasons in API client (BUG-API-018)`.

## Examples

Global exception handler:
```python
@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    request_id = request.state.request_id
    logger.exception("unhandled exception", extra={"request_id": request_id})
    sentry_sdk.capture_exception(exc)
    return JSONResponse(
        status_code=500,
        content={"error": "internal_error", "request_id": request_id},
        headers={"X-Request-ID": request_id},
    )
```

Decimal serialization (Pydantic v2):
```python
# Pydantic v2 removed json_encoders. Use @field_serializer (or @model_serializer).
from decimal import Decimal  # idiomatic stdlib import — Pydantic v2 accepts this directly
from pydantic import BaseModel, field_serializer

class WalletBalance(BaseModel):
    amount: Decimal

    @field_serializer("amount")
    def serialize_amount(self, value: Decimal) -> str:
        return format(value, "f")  # fixed-point string, no scientific notation
```

ErrorBoundary:
```tsx
componentDidCatch(error: Error, info: ErrorInfo) {
  Sentry.captureException(error, { contexts: { react: { componentStack: info.componentStack } } });
  this.setState({ hasError: true });
}

// Reset on route change
useEffect(() => {
  const unsub = navigation.addListener("focus", () => setHasError(false));
  return unsub;
}, [navigation]);
```

## Requirements
- `security`: do NOT leak exception messages to the client. Log server-side; return a stable shape `{error, request_id}`.
- `max-quality-no-shortcuts`: when converting float→Decimal, never do `Decimal(some_float)` — always `Decimal(str(value))` or load from a string-typed column.
- Audit trail is append-only; enforce with a DB trigger if your deployment supports it, else via a repository-level check.
- If Sentry is not yet provisioned, stub a `reportException(err, ctx)` with TODO to swap in; do not block this prompt on ops.
- Parallelizable with 04-09. Coordinate with Prompt 01 (which already introduced `authStatus`) — Prompt 10's Sentry wiring reuses it.
- `pre-commit run --all-files` before each commit; coverage >=90%.
