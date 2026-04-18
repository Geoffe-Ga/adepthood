# Backend Observability & Admin Bug Report — 2026-04-18

**Scope:** `backend/src/observability.py` (112 LOC), `backend/src/routers/admin.py` (133 LOC), `backend/src/services/usage.py` (62 LOC), `backend/src/models/llm_usage_log.py` (41 LOC). Covers correlation-ID propagation, structured logging, admin endpoint surface, and the LLM-usage rollup path.

**Total bugs: 10 — 1 Critical / 5 High / 4 Medium / 0 Low**

## Executive Summary

1. **No real admin identity (Critical).** BUG-ADMIN-001: admin access is gated on a single shared env-var secret because the `User` model has no `is_admin` column (BUG-MODEL-001). There is no per-user attribution, no rotation path, no audit of who ran which admin action. One leaked secret = full takeover of the admin surface.
2. **Log injection + header-splitting exposure (High).** BUG-OBS-001: `X-Request-ID` from the client is echoed back into the response header and written unescaped into log lines. An attacker can inject CRLF or control characters to forge log entries or split the response. Pairs with BUG-APP-001 (middleware ordering).
3. **Unhandled exceptions bypass correlated logging (High).** BUG-OBS-003: no global exception handler means 500s escape without a log line that carries the request's `trace_id`. On-call engineers cannot tie a user's bug report to a server-side stack trace.
4. **Admin DoS + monetary drift (High).** BUG-ADMIN-002: `/admin/usage-stats` runs three unbounded `SUM()` aggregates with no time window and returns an uncapped per-user breakdown. BUG-ADMIN-004: `estimated_cost_usd` is a `float` summed with `func.sum`, guaranteeing decimal drift vs. provider invoices. Cross-link BUG-SCHEMA-009 (credit minting).
5. **Observability wiring gaps (Medium).** BUG-OBS-002: `install_trace_id_logging()` runs inside `lifespan` startup, so import-time log records have no `trace_id` attribute and can crash a strict formatter. BUG-OBS-004: `CorrelationIdMiddleware` is registered first (innermost), so CORS-preflight responses skip trace-ID injection (mirrors BUG-APP-001). BUG-OBS-005: module claims background-task propagation but ships no helper — `ContextVar` does not survive `asyncio.create_task` by default.
6. **Admin data hygiene (Medium).** BUG-ADMIN-003: per-user breakdown exposes raw `user_id` with no audit log of who viewed it. BUG-ADMIN-005: `LLMUsageLog.user_id` FK has no `ondelete`, no composite `(user_id, timestamp)` index — time-windowed per-user queries scan the whole table (pairs with BUG-MODEL-002).

## Table of Contents

| # | ID | Severity | Component | Title |
|---|----|----------|-----------|-------|
| 1 | BUG-ADMIN-001 | Critical | `routers/admin.py` | No `is_admin` flag; shared env-var secret with no attribution |
| 2 | BUG-OBS-001 | High | `observability.py` | `X-Request-ID` not validated — log injection + header-splitting |
| 3 | BUG-OBS-002 | High | `observability.py` | `install_trace_id_logging()` runs in lifespan — import logs crash formatter |
| 4 | BUG-OBS-003 | High | `observability.py` | No global exception handler — 500s lose correlation |
| 5 | BUG-ADMIN-002 | High | `routers/admin.py` | `/admin/usage-stats` unbounded aggregates + per-user response |
| 6 | BUG-ADMIN-004 | High | `services/usage.py` | `estimated_cost_usd` stored as `float` — monetary drift |
| 7 | BUG-OBS-004 | Medium | `observability.py` + `main.py` | Middleware ordering — preflight skips trace-ID |
| 8 | BUG-OBS-005 | Medium | `observability.py` | Claims worker propagation but no `ContextVar` helper |
| 9 | BUG-ADMIN-003 | Medium | `routers/admin.py` | Raw `user_id` in per-user breakdown, no audit |
| 10 | BUG-ADMIN-005 | Medium | `models/llm_usage_log.py` | No `ondelete`, no composite `(user_id, timestamp)` index |

---

# Fragment 08 — Observability and Admin Surface

Scope: `backend/src/observability.py`, `backend/src/routers/admin.py`,
`backend/src/services/usage.py`, `backend/src/models/llm_usage_log.py`.
Main.py middleware wiring is referenced for context only.

---

### BUG-OBS-001 — Client-supplied X-Request-ID is echoed unsanitised, enabling log injection and response-header splitting (Severity: High)

**Component:** `backend/src/observability.py:52-65` (`_normalise_trace_id`), `backend/src/observability.py:91-99` (`CorrelationIdMiddleware.dispatch`)

**Symptom:** A malicious client can inject CR/LF, ANSI escape sequences, or
arbitrary terminal/log-framework control characters into every log line for
the duration of the request via `X-Request-ID`. The same unvalidated value
is written back into the response header, enabling header-splitting against
any naive downstream proxy that doesn't re-validate.

**Root cause:**
```python
def _normalise_trace_id(raw: str | None) -> str:
    if raw is None:
        return uuid.uuid4().hex
    candidate = raw.strip()
    if not candidate or len(candidate) > _MAX_TRACE_ID_LENGTH:
        return uuid.uuid4().hex
    return candidate  # <-- any printable/control chars survive

# dispatch():
response.headers[TRACE_ID_HEADER] = trace_id  # echoed unescaped
```

**Fix:** Restrict accepted characters to a conservative charset (e.g.
`[A-Za-z0-9._-]`) using a compiled regex and mint a fresh UUID4 on any
violation. Reject embedded whitespace, CR/LF, and non-ASCII. The same
sanitised value should be used both in the contextvar and in the response
header.

**Cross-references:** BUG-APP-001

---

### BUG-OBS-002 — Trace-ID log filter is installed inside `lifespan` startup, leaving import-time and pre-startup logs without a `trace_id` attribute and crashing `%(trace_id)s` formatters (Severity: High)

**Component:** `backend/src/main.py:184` (calls `install_trace_id_logging()` from `lifespan`), `backend/src/observability.py:102-112`

**Symptom:** Any log record emitted before FastAPI's `lifespan` startup hook
runs — including module-import logs, Alembic autogen, rate-limit warnings
at middleware construction, and exception tracebacks during startup itself
— is missing the `trace_id` attribute. A formatter that expects
`%(trace_id)s` will raise `KeyError: 'trace_id'`, which can crash the log
handler and silently drop records. This is an observability blind spot
exactly when visibility is most critical (boot failures).

**Root cause:**
```python
# main.py
@asynccontextmanager
async def lifespan(_application: FastAPI) -> AsyncIterator[None]:
    import models  # noqa: F401
    install_trace_id_logging()  # <-- too late; runs after import-time logs
    yield
```

**Fix:** Call `install_trace_id_logging()` at module import time in
`observability.py` (or at the very top of `main.py` before any other
imports that may log). The function is already idempotent, so this is
safe. Alternatively, defensively add a `logging.LogRecord` factory that
sets `trace_id = NO_TRACE` by default.

---

### BUG-OBS-003 — No global exception handler: unhandled errors leak stack traces to clients and are not correlated with the trace ID (Severity: High)

**Component:** `backend/src/observability.py` (entire module — missing error-path hook), `backend/src/main.py:189-220` (no `add_exception_handler(Exception, ...)`)

**Symptom:** When a route handler raises an uncaught exception, Starlette's
default 500 response may include the traceback in debug mode and in
production at minimum exposes the fact that no correlated entry was
written with the trace ID. Support staff cannot tie a user-reported
`X-Request-ID` to a log line because the exception escapes the middleware
chain before the handler logs it.

**Root cause:**
```python
async def dispatch(self, request, call_next):
    trace_id = _normalise_trace_id(request.headers.get(TRACE_ID_HEADER))
    token = trace_id_var.set(trace_id)
    try:
        response = await call_next(request)
    finally:
        trace_id_var.reset(token)
    # no exception-handler wiring, no logger.exception() on failure
```

**Fix:** Wrap `call_next` in `try/except Exception as exc`, call
`logger.exception("unhandled_request_error", extra={"trace_id": trace_id})`,
and return a generic JSON 500 with the trace ID echoed so users can quote
it to support. Also register an app-level `add_exception_handler(Exception, ...)`
that never leaks `str(exc)` to the client.

---

### BUG-OBS-004 — Middleware ordering places CorrelationIdMiddleware outermost, which means CORS-preflight OPTIONS responses emitted by `CORSMiddleware` skip trace-ID injection (Severity: Medium)

**Component:** `backend/src/main.py:198-217` (middleware stack)

**Symptom:** `CorrelationIdMiddleware` is added first, then
`SecurityHeadersMiddleware`, then `SlowAPIMiddleware`, then
`CORSMiddleware`. Starlette executes the last-added middleware as the
outermost, so CORS preflight responses are generated *before*
`CorrelationIdMiddleware.dispatch` runs and never receive the
`X-Request-ID` header. Browser clients correlating failures across
preflight + real requests lose the link.

**Root cause:**
```python
app.add_middleware(CorrelationIdMiddleware)      # innermost
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(SlowAPIMiddleware)
app.add_middleware(CORSMiddleware, ...)          # outermost — short-circuits preflight
```

**Fix:** Add `CorrelationIdMiddleware` last (so it becomes the outermost
middleware) or attach the trace ID inside the CORS preflight response by
registering an `http` middleware via decorator. Update the docstring on
line 13-15 which currently claims the middleware sits outermost — this is
now false.

**Cross-references:** BUG-APP-001

---

### BUG-OBS-005 — `trace_id` contextvar is bound on the middleware task but not propagated into `asyncio.create_task` / background workers, silently breaking correlation for fire-and-forget work (Severity: Medium)

**Component:** `backend/src/observability.py:44` (module-level `ContextVar`), module docstring lines 13-15 claim background-task support

**Symptom:** The module advertises that "the core mechanics work in
background tasks and Celery / RQ workers without modification," but a
plain `asyncio.create_task(coro)` inherits the current context only at
task-creation time. Workers started from a pool (Celery, RQ) start with
an empty contextvar and will log `trace_id=-` instead of the originating
request's ID. There is no helper to snapshot and restore the context.

**Root cause:**
```python
trace_id_var: contextvars.ContextVar[str] = contextvars.ContextVar(
    "trace_id", default=NO_TRACE
)
# No public `bind_trace_id(ctx)` / `run_with_trace_id(trace_id, coro)` helper
```

**Fix:** Add a `run_with_trace_id(trace_id: str, coro)` helper and a
`capture_trace_id() -> str` snapshot helper. Document explicitly that
cross-thread / cross-process propagation requires passing the trace ID as
a message-queue header, not relying on `ContextVar`. Update the docstring
to match reality.

---

### BUG-ADMIN-001 — No admin flag on `User`; admin gate is a single shared env-var secret with no rotation, no audit, and no per-admin attribution (Severity: Critical)

**Component:** `backend/src/routers/admin.py:37-50` (`_require_admin`)

**Symptom:** Every admin action is performed by "the holder of
`ADMIN_API_KEY`." There is no way to know *which* operator inspected
user-level spend, revoke access for one admin without rotating for all,
or audit admin reads against user IDs. If the key leaks (CI logs,
env-dump, browser devtools on a misconfigured dashboard) the attacker
gains full read access to all users' aggregated LLM spend.

**Root cause:**
```python
def _require_admin(
    x_admin_api_key: str | None = Header(default=None, alias=ADMIN_API_KEY_HEADER),
) -> None:
    expected = os.getenv("ADMIN_API_KEY", "")
    if not expected:
        raise forbidden("admin_api_disabled")
    if not x_admin_api_key or not hmac.compare_digest(x_admin_api_key, expected):
        raise forbidden("admin_auth_required")
```

**Fix:** Add `is_admin: bool = False` to the `User` model and swap
`_require_admin` for a dependency that resolves the current JWT-authed
user and rejects `user.is_admin is False`. Keep the shared-secret path
behind a feature flag for break-glass only. Log every admin request with
the acting user ID.

**Cross-references:** BUG-AUTH-018, BUG-MODEL-001

---

### BUG-ADMIN-002 — `/admin/usage-stats` returns unbounded per-user breakdown (full table-scan aggregation + unbounded result set) (Severity: High)

**Component:** `backend/src/routers/admin.py:81-92` (per-user aggregate query), `backend/src/routers/admin.py:94-106` (per-model aggregate query)

**Symptom:** With N users and M rows per user, the aggregation scans the
whole `llmusagelog` table on every call (three separate queries!) and
returns one `UserUsageBreakdown` per user with no `LIMIT`. At scale
(100k users) this pushes megabytes over the wire and pegs the DB. A bored
admin can DoS the control plane simply by refreshing the dashboard.

**Root cause:**
```python
per_user_rows = (
    await session.execute(
        select(col(LLMUsageLog.user_id), func.count(...), ...)
        .group_by(col(LLMUsageLog.user_id))
        .order_by(func.sum(col(LLMUsageLog.estimated_cost_usd)).desc())
    )   # <-- no .limit(), no time-window filter
).all()
```

**Fix:** Cap `per_user` at e.g. `LIMIT 100` and accept a query param
`top_n: int = Query(100, ge=1, le=1000)`. Add a required
`window: Literal["24h","7d","30d","all"]` parameter and use it to filter
`timestamp` so the common case hits the `timestamp` index. Consider
materialising a per-day rollup table if the table grows past a few
million rows.

---

### BUG-ADMIN-003 — `/admin/usage-stats` exposes raw `user_id` without a PII boundary; should be opt-in / aggregated-only by default (Severity: Medium)

**Component:** `backend/src/routers/admin.py:114-122` (per-user response), `backend/src/schemas/admin.py:8-14`

**Symptom:** The per-user breakdown surfaces raw numeric `user_id`s. While
the IDs themselves are not PII, joining them against a leak of the `user`
table (or a compromised admin device) yields a per-user spend profile.
Best practice for cost dashboards is "aggregates by default, drill-down
on explicit request with a reason field."

**Root cause:**
```python
per_user=[
    UserUsageBreakdown(
        user_id=int(user_id),  # <-- always exposed
        call_count=int(calls),
        ...
    )
    for user_id, calls, tokens, cost in per_user_rows
],
```

**Fix:** Gate the per-user list behind a separate endpoint
`GET /admin/usage-stats/by-user` that requires an audit-log reason
parameter and emits a log line naming the acting admin + user queried.
Keep `/usage-stats` to totals + per-model only.

---

### BUG-ADMIN-004 — `estimated_cost_usd` stored as `float` and summed with `func.sum`; repeated aggregation drifts from the true USD amount (Severity: High)

**Component:** `backend/src/models/llm_usage_log.py:40` (`estimated_cost_usd: float`), `backend/src/routers/admin.py:75, 87, 101` (float sums), `backend/src/routers/admin.py:113` (`float(total_cost)`)

**Symptom:** Money in `float` accumulates IEEE-754 rounding. Summing
millions of rows produces a headline "total spend" that disagrees with
the provider's invoice by tens of cents to dollars. Because the schema
returns `float` and the admin dashboard likely reconciles against
Anthropic/OpenAI billing exports, this will generate false alarms every
month.

**Root cause:**
```python
# models/llm_usage_log.py
estimated_cost_usd: float = Field(default=0.0, ge=0.0)

# routers/admin.py
func.coalesce(func.sum(col(LLMUsageLog.estimated_cost_usd)), 0.0),
```

**Fix:** Change the column to `Numeric(12, 6)` mapped to
`decimal.Decimal` (micro-dollar precision covers per-token pricing). Sum
as `Decimal`, convert to `str` in the response, or expose an integer
`estimated_cost_micros`. Update `UsageStatsResponse` accordingly.

**Cross-references:** BUG-SCHEMA-009

---

### BUG-ADMIN-005 — `LLMUsageLog.user_id` FK has no `ondelete` and no composite `(user_id, timestamp)` index; per-user time-windowed queries scan the full table and orphan rows break user deletion (Severity: Medium)

**Component:** `backend/src/models/llm_usage_log.py:30-34` (field defs)

**Symptom:** Two distinct problems with one root cause — the schema is
under-specified:
(1) The `user_id` FK declares no `ondelete`, so when a user is deleted
(GDPR export + erase, account closure) the DB raises an integrity error
or leaves orphan rows depending on PG default.
(2) Time-windowed per-user queries (`WHERE user_id=? AND timestamp > ?`)
cannot use the single-column indexes efficiently; a composite
`(user_id, timestamp DESC)` index is the correct shape.

**Root cause:**
```python
user_id: int = Field(foreign_key="user.id", index=True)  # no ondelete
timestamp: datetime = Field(
    default_factory=lambda: datetime.now(UTC),
    sa_column=Column(DateTime(timezone=True), nullable=False, index=True),
)
# no __table_args__ = (Index("ix_llmusagelog_user_ts", "user_id", "timestamp"),)
```

**Fix:** Declare the FK via `sa_column=Column(ForeignKey("user.id", ondelete="CASCADE"))`
(or `SET NULL` if the audit log must outlive the user — then make
`user_id` nullable). Add `__table_args__ = (Index("ix_llmusagelog_user_ts", "user_id", "timestamp"),)`.
Ship both changes in a single Alembic migration.

**Cross-references:** BUG-MODEL-002

---

---

## Suggested Remediation Order

1. **BUG-ADMIN-001** (Critical) — Add `User.is_admin` (pairs with BUG-MODEL-001). Replace the shared env-var secret with a per-user admin check + audit log. All admin endpoints re-check on every call.
2. **BUG-OBS-001** (High) — Validate `X-Request-ID` against `^[A-Za-z0-9-]{1,64}$`. Reject or regenerate on mismatch. Never echo untrusted input to headers or log lines unquoted.
3. **BUG-OBS-003** (High) — Register a global `Exception` handler on the FastAPI app that logs with the current `trace_id` and returns a sanitized 500. Include the handler in the `main.py` app factory before routers are mounted.
4. **BUG-ADMIN-002** (High) — Require a `since`/`until` query param with a hard max window (e.g. 90 days). Paginate per-user breakdown with `limit<=100`. Add an index that supports the aggregation.
5. **BUG-ADMIN-004** (High) — Migrate `estimated_cost_usd` to `Numeric(12, 6)` (or store integer microcents). Sum in `Decimal`; format for display at the edge only.
6. **BUG-OBS-002** (High) — Install the log filter at `observability` module import time, not inside `lifespan`. Default `trace_id` to a constant like `"-"` so records outside a request still render cleanly.
7. **BUG-OBS-004** (Medium) — Re-order middleware so `CorrelationIdMiddleware` is outermost (added last). Cross-check with BUG-APP-001 CORS ordering so preflight responses always carry the trace ID.
8. **BUG-OBS-005** (Medium) — Delete the "worker propagation" claim from the docstring or add a `propagate_trace_id(coro)` helper that copies the `ContextVar` value into the spawned task.
9. **BUG-ADMIN-003** (Medium) — Either replace `user_id` in the breakdown with a hashed identifier or add an explicit audit log entry per `/admin/usage-stats` call.
10. **BUG-ADMIN-005** (Medium) — Single migration: add `CASCADE` to `LLMUsageLog.user_id`, add a composite index `(user_id, timestamp DESC)`.

## Cross-References

- **BUG-AUTH-018** (no admin gating at the route layer) — root of BUG-ADMIN-001.
- **BUG-MODEL-001** (User missing `is_admin`/`is_active`/`email_verified`) — structural precondition for BUG-ADMIN-001.
- **BUG-MODEL-002** (FKs to `user.id` without `ondelete`) — BUG-ADMIN-005 is the admin-facing instance.
- **BUG-SCHEMA-009** (`BalanceAddRequest.amount` unbounded — credit minting) — downstream consumer of the unreliable `estimated_cost_usd` sum in BUG-ADMIN-004.
- **BUG-APP-001** (middleware LIFO means CORS is innermost) — BUG-OBS-004 is the observability-side mirror: correlation middleware order matters for the same reason.
- **BUG-APP-006** (rate-limit trust of `X-Forwarded-For`) — thematic pair to BUG-OBS-001: both trust client-supplied headers that must be validated or stripped at the edge.
