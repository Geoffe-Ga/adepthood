# Backend App, CORS, Middleware & Infrastructure Bug Report — 2026-04-18

**Scope:** `backend/src/main.py` (256 LOC — FastAPI app, CORS, `SecurityHeadersMiddleware`, rate-limit handler, middleware order, router mounting, `/health`), `backend/src/errors.py` (30 LOC), `backend/src/rate_limit.py` (13 LOC), `backend/src/observability.py` (112 LOC), `backend/src/load_options.py` (41 LOC).

**Total bugs:** 10 — **2 Critical / 6 High / 2 Medium / 0 Low**.

**Note on IDs:** Inline comments in `main.py` reference `BUG-INFRA-001` through `BUG-INFRA-025` from the prior 2026-04-14 audit. This report uses the new `BUG-APP-` prefix to avoid collision.

## Executive summary

Two Critical findings dominate this report:

- **BUG-APP-001 (Critical)** — Middleware registration order is the reverse of what the comment claims. `app.add_middleware` pushes onto a stack; Starlette then dispatches in LIFO order, so the outermost request-handler is the *last* middleware registered (CORS), not the first (CorrelationId). The practical effect: any response produced by `SlowAPIMiddleware` or `SecurityHeadersMiddleware` (e.g. a 429, a 5xx from inside a middleware) ships *without* the `Access-Control-Allow-Origin` header, so the browser drops the response and the frontend sees a generic "network error" instead of a typed 429. This is the class of bug that hides rate-limit failures from the UI.
- **BUG-APP-006 (Critical)** — `rate_limit.py` uses `slowapi.util.get_remote_address`, which blindly trusts `X-Forwarded-For`. A single header injected on any request bypasses rate limits for that IP on every endpoint. This extends BUG-AUTH-008 (already tracked for the auth-only login-attempt table) to the *entire* API surface.

Six High-severity findings follow:

- **BUG-APP-002** — CORS preflight short-circuits ahead of `SecurityHeadersMiddleware`, so `OPTIONS` responses lack CSP, HSTS, X-Frame-Options.
- **BUG-APP-003** — `_validate_https_origins` is a prefix check only: `https://192.168.1.1`, `https://localhost`, `https://user:pass@evil.com`, and `https://*.example.com` all pass. <!-- pragma: allowlist secret -->
- **BUG-APP-004** — `/health` conflates liveness + readiness with no probe timeout, so transient DB slowness triggers Railway restart loops.
- **BUG-APP-007** — `install_trace_id_logging` runs inside the lifespan startup hook, which is too late for import-time log lines (they're emitted without `trace_id`), and it does not attach to uvicorn's handler-level filter chain.
- **BUG-APP-008** — inbound `X-Request-ID` values are echoed into logs and response headers with only `strip()` + length cap, enabling log-injection via embedded newlines or JSON metacharacters.
- **BUG-APP-009** — `HABIT_WITH_GOALS_AND_COMPLETIONS` is built by chaining `.selectinload(...)` on the shared `HABIT_WITH_GOALS` Load instance, aliasing path state between the two loader options and silently over-fetching completions on the "light" habits list endpoint.

Two Medium findings round out the report: Swagger UI is left publicly accessible in production and broken by the strict CSP (BUG-APP-005), and `errors.py` contains no custom exception classes or global handler so unhandled errors render as Starlette's default bare-text 500 with no JSON envelope and no `trace_id` (BUG-APP-010).

## Table of contents

| ID | Severity | Component | Title |
|----|----------|-----------|-------|
| BUG-APP-001 | Critical | `main.py:198-217` | Middleware add order is LIFO — CORS is innermost, so 429s/5xx from earlier middlewares ship without CORS headers |
| BUG-APP-002 | High     | `main.py:211-217, 150-174` | CORS preflight short-circuits before `SecurityHeadersMiddleware` — preflight responses lack CSP/HSTS/X-Frame-Options |
| BUG-APP-003 | High     | `main.py:52-76` | `_validate_https_origins` is a pure prefix check — accepts bare IPs, `localhost`, userinfo, wildcards as valid prod origins |
| BUG-APP-004 | High     | `main.py:236-256` | `/health` conflates liveness + readiness with no probe timeout — transient DB slowness triggers Railway restart loops |
| BUG-APP-005 | Medium   | `main.py:189` | `FastAPI(lifespan=lifespan)` leaves `/docs` public in prod; strict CSP breaks Swagger CDN assets anyway; no title/version |
| BUG-APP-006 | Critical | `rate_limit.py:1-13` | `get_remote_address` trusts `X-Forwarded-For` globally — extends BUG-AUTH-008 bypass to every rate-limited endpoint |
| BUG-APP-007 | High     | `observability.py` (startup / filter install) | `install_trace_id_logging` runs in lifespan startup — too late for import-time log lines; bypasses uvicorn handler filters |
| BUG-APP-008 | High     | `observability.py` (CorrelationIdMiddleware) | Inbound `X-Request-ID` only stripped + length-capped — enables log-injection via embedded newlines / JSON metacharacters |
| BUG-APP-009 | High     | `load_options.py` | `HABIT_WITH_GOALS_AND_COMPLETIONS` aliases loader-path state by chaining `.selectinload` onto the shared `HABIT_WITH_GOALS` |
| BUG-APP-010 | Medium   | `errors.py` | No custom exception classes, no global `Exception` handler — unhandled errors return bare-text 500 with no JSON envelope |

---

## Critical, High & Medium — App root, CORS & middleware (`main.py`)

### BUG-APP-001: CORS middleware registered outermost — 429, 500, and other error responses are invisible to browsers
**Severity:** Critical
**Component:** `backend/src/main.py:195-217`
**Symptom:** When the rate limiter fires (or any other middleware/handler raises before CORS runs), the resulting `JSONResponse` lacks `Access-Control-Allow-Origin`. Browsers then drop the response with a CORS error, and the user sees a generic "Network Error" instead of the actual 429 / 500 / correlation ID. This turns every rate-limit hit and every crash into an unexplained outage from the frontend's perspective.
**Root cause:**
```python
# Correlation-ID middleware sits at the outermost edge so every other
# middleware (security headers, CORS, slowapi) and every route handler sees
# the trace ID through ``contextvars`` (BUG-INFRA-025).
app.add_middleware(CorrelationIdMiddleware)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(SlowAPIMiddleware)
...
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    ...
)
```
Starlette applies middleware in **reverse** registration order, so the effective request flow is `CORS (innermost) → SlowAPI → SecurityHeaders → CorrelationId (outermost)`. The code comment on line 204-205 claims the opposite ("CORS (outermost) → SlowAPI → SecurityHeaders → route handler"), i.e. the author believed `add_middleware` stacks in call order. When SlowAPI's `_rate_limit_exceeded_handler` short-circuits with a 429, the response never passes through `CORSMiddleware`, so no `Access-Control-Allow-Origin` header is attached and cross-origin browsers reject the payload.

**Fix:** Register `CORSMiddleware` **last** (so it becomes the outermost wrapper and stamps CORS headers on every response, including 429s and 5xxs). Either reorder the `add_middleware` calls to `CORS → SlowAPI → SecurityHeaders → CorrelationId` (registration order), or — preferred — explicitly attach CORS headers inside `_rate_limit_exceeded_handler` and any other exception handler that can fire before CORS. Add a test that asserts `OPTIONS /auth/login` and a forced-429 response both carry `Access-Control-Allow-Origin`.

---

### BUG-APP-002: SecurityHeadersMiddleware bypassed for CORS preflights — OPTIONS responses ship without CSP / HSTS / X-Frame-Options
**Severity:** High
**Component:** `backend/src/main.py:150-174, 195-217`
**Symptom:** Any `OPTIONS` request with CORS preflight headers (`Origin` + `Access-Control-Request-Method`) is answered directly by `CORSMiddleware` with a 200, short-circuiting the rest of the stack. Because `SecurityHeadersMiddleware` sits *inside* CORS in the actual execution order (see BUG-APP-001), preflight responses carry **no** `Content-Security-Policy`, `X-Frame-Options: DENY`, `Referrer-Policy`, or `Strict-Transport-Security`. Security scanners and CSP-compliance audits flag these OPTIONS endpoints as unhardened; a network-level attacker can also MITM the preflight in production because HSTS is absent.
**Root cause:**
```python
class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        ...
```
`CORSMiddleware` intercepts preflight `OPTIONS` before delegating to `call_next`, so downstream middleware (including `SecurityHeadersMiddleware`) never runs. Combined with the ordering bug, even non-preflight responses that error out early can miss these headers.

**Fix:** Move `SecurityHeadersMiddleware` outside (later-registered than) `CORSMiddleware`, or implement header injection as a Starlette `Response` subclass / `ASGI` wrapper that also handles the synthetic OPTIONS response CORS produces. Add an integration test: `OPTIONS /auth/login` with a valid `Origin` must return `Content-Security-Policy`, `X-Frame-Options`, and (in prod/staging) `Strict-Transport-Security`.

---

### BUG-APP-003: `_validate_https_origins` accepts `https://` bare-IP and localhost origins in production
**Severity:** High
**Component:** `backend/src/main.py:52-56, 59-76`
**Symptom:** Setting `PROD_DOMAIN=https://192.168.1.10,https://localhost:8443` under `ENV=production` passes validation and is accepted as a trusted CORS origin. A misconfigured deployment (e.g. internal IP copied from a dev note, or a staging origin that leaks into prod config) will happily allow credentialed cross-origin requests from that origin — including from a phishing page that manages to trick a browser into resolving the host. The code's "fail fast on bad config" docstring promise is not honoured.
**Root cause:**
```python
def _validate_https_origins(origins: list[str]) -> None:
    """Ensure every origin uses HTTPS; raise RuntimeError otherwise."""
    for origin in origins:
        if not origin.startswith("https://"):
            raise RuntimeError(f"PROD_DOMAIN entries must use HTTPS, got '{origin}'")
```
The check is purely a string-prefix test. It does not parse the URL, reject bare IPs, reject `localhost` / `127.0.0.1` / private RFC1918 ranges, reject userinfo, reject paths/queries, or reject wildcards like `https://*.example.com` that would pass the prefix test but be meaningless to `CORSMiddleware` (which does exact-string match). It also does not reject trailing slashes, which **also** break CORS exact-match silently.

**Fix:** Parse each origin with `urllib.parse.urlparse`; require `scheme == "https"`, a non-empty hostname that is not an IP literal (`ipaddress.ip_address` should raise), not `localhost`, not in private ranges, no path/query/fragment, and no userinfo. Normalise by stripping trailing slashes. In staging, you may want to allow `localhost` explicitly — do that with a separate code path, not by loosening prod.

---

### BUG-APP-004: `/health` depends on DB session and turns transient DB blips into Railway restart loops
**Severity:** High
**Component:** `backend/src/main.py:236-256`
**Symptom:** Railway's health-checker pings `/health` on a short interval. Any momentary DB unavailability — a Postgres failover, a connection-pool saturation spike, an idle-terminator killing the checkout — returns 503 and Railway marks the container unhealthy. If enough consecutive probes fail, Railway restarts the container, which (a) drops all in-flight requests, (b) re-opens DB connections, increasing load on the already-stressed DB, and (c) can cascade across replicas, producing a restart loop that looks like an outage even though the app process is fine. There is also no liveness/readiness split, so the orchestrator cannot tell "process wedged" from "DB slow".
**Root cause:**
```python
@app.get("/health")
async def health_check(
    session: AsyncSession = Depends(get_session),  # noqa: B008
) -> dict[str, str]:
    ...
    try:
        await session.execute(text("SELECT 1"))
    except Exception as exc:
        logger.exception("health_check_failed")
        raise HTTPException(status_code=503, detail="Database unavailable") from exc
    return {"status": "healthy", "database": "connected"}
```
One endpoint is doing two jobs (liveness + readiness) and the DB dependency means any DB hiccup fails both. The endpoint also has no timeout on the `SELECT 1`, so a slow DB can make `/health` hang for the full connection-acquire timeout (often tens of seconds), breaking the probe SLA from the other direction.

**Fix:** Split into two endpoints: `/health/live` that returns 200 unconditionally (process responsiveness only — this is what Railway should probe for restart decisions), and `/health/ready` that runs the `SELECT 1` and returns 503 when the DB is unreachable (for load-balancer pool membership). Wrap the DB probe in `asyncio.wait_for(..., timeout=2.0)` so a hung pool checkout can't stall the probe. Document which endpoint Railway should call.

---

### BUG-APP-005: `FastAPI(lifespan=lifespan)` ships to production with no `title`/`version`/`description` and `/docs` wide open
**Severity:** Medium
**Component:** `backend/src/main.py:136-145, 189`
**Symptom:** Two related issues. (1) The interactive Swagger UI at `/docs` and ReDoc at `/redoc` are enabled in production because `docs_url` / `redoc_url` / `openapi_url` are not disabled, exposing the full API surface (including admin endpoints) to anyone who can reach the server. (2) When Swagger UI loads, it pulls its JS/CSS from `https://cdn.jsdelivr.net/npm/swagger-ui-dist@...`, but `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'` blocks those cross-origin assets, so the page renders blank with console errors — making `/docs` useless even for developers. Separately, the OpenAPI schema reports `"title": "FastAPI"`, `"version": "0.1.0"`, with no description, which pollutes generated client SDKs and support tooling.
**Root cause:**
```python
_CSP_DIRECTIVES = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self'; "
    ...
)
...
app = FastAPI(lifespan=lifespan)
```
The app constructor takes defaults for all metadata and all docs-route toggles, and the CSP is locked to `'self'` for scripts and styles with no carve-out for the Swagger CDN.

**Fix:** (a) In production/staging, pass `docs_url=None, redoc_url=None, openapi_url=None` to `FastAPI(...)` (or gate them behind an admin-only auth dependency) so the schema isn't publicly enumerable. (b) If `/docs` must remain reachable in dev, either host Swagger assets locally via `fastapi.openapi.docs.get_swagger_ui_html(..., swagger_js_url=..., swagger_css_url=...)` pointing at files served from `'self'`, or add an env-gated CSP relaxation (`script-src 'self' https://cdn.jsdelivr.net; style-src 'self' https://cdn.jsdelivr.net`) scoped to dev only. (c) Populate `title="Adepthood API"`, `version=` (read from package metadata), and `description=` so the OpenAPI schema is publishable.

---

## Critical, High & Medium — Supporting infrastructure modules

### BUG-APP-006: Global rate limiter keys off spoofable `X-Forwarded-For`, defeating abuse protection
**Severity:** Critical
**Component:** `backend/src/rate_limit.py:3-13`
**Symptom:** Any attacker can bypass the `60/minute` global rate limit (and the `3/minute` signup / `5/minute` login caps that depend on the same limiter) by attaching a rotating `X-Forwarded-For` header to every request. Because `slowapi.util.get_remote_address` trusts the left-most value of `X-Forwarded-For` when present, sending `X-Forwarded-For: <random-ipv4>` on each request lands every request in a fresh bucket, effectively making the limit unbounded. This is the same root issue already tracked for auth as BUG-AUTH-008, but elevated to *global* scope: every endpoint on the API, not just `/auth/login`, inherits the bypass.
**Root cause:**
```python
from slowapi.util import get_remote_address
...
limiter = Limiter(key_func=get_remote_address, default_limits=[DEFAULT_RATE_LIMIT])
```
`get_remote_address` reads `request.client.host` as a fallback but `Limiter`, when used with `SlowAPIMiddleware`, honours the `X-Forwarded-For` header by default on the ASGI scope. No trusted-proxy allow-list is configured, so headers sent by untrusted clients are treated as authoritative.

**Fix:** Replace the key function with a hardened variant that (a) only honours `X-Forwarded-For` when the immediate peer is in a trusted-proxy CIDR list loaded from env (e.g. Railway's ingress range), (b) falls back to `request.client.host` otherwise, and (c) for authenticated routes composes the key with the JWT `sub` claim so one user behind NAT can't be knocked offline by a neighbour. Gate this behind a shared helper used by both this module and `routers/auth.py::_get_client_ip` so the two can't drift.

---

### BUG-APP-007: `install_trace_id_logging` is a no-op after the first call, but logs emitted before lifespan startup have no `trace_id`
**Severity:** High
**Component:** `backend/src/observability.py:102-112` + `backend/src/main.py:177-186`
**Symptom:** Any log line emitted before the FastAPI lifespan `startup` phase runs (module imports, `database.py` engine construction, router import-time logging, Alembic autogenerate warnings) is produced *without* the `TraceIdLogFilter` attached. If an operator configures a formatter with `%(trace_id)s` — as the module docstring invites them to — those early records raise `KeyError: 'trace_id'` inside the logging subsystem, which Python swallows and prints to stderr as `--- Logging error ---`, losing the original message entirely. The idempotency guard is correct but solves the wrong problem: the bug is *late* installation, not double installation.
**Root cause:**
```python
def install_trace_id_logging() -> None:
    root = logging.getLogger()
    if not any(isinstance(f, TraceIdLogFilter) for f in root.filters):
        root.addFilter(TraceIdLogFilter())
```
And in `main.py`:
```python
@asynccontextmanager
async def lifespan(_application: FastAPI) -> AsyncIterator[None]:
    import models  # noqa: F401, PLC0415
    install_trace_id_logging()
    yield
```
The filter is installed only after the app object exists and lifespan runs — i.e. after every `import` in `main.py` has already fired. Additionally, `logging.Filter` attached to the root logger does not propagate to records created by loggers whose effective handlers are child-level (uvicorn's access logger, for example, installs its own handlers and filters at the `uvicorn.access` logger). Those records never see the filter regardless of when it's installed.

**Fix:** Call `install_trace_id_logging()` at module import time in `observability.py` (or in a dedicated `_bootstrap.py` imported first by `main.py`) so it runs before any other module-level logging. Additionally, attach the filter to each `logging.Handler` rather than just the root logger so that handlers with their own filter chains (uvicorn's) still get `trace_id`. Keep the idempotency check, but key it on a module-level sentinel (`_INSTALLED = False`) rather than walking `root.filters`, since handler-level filters won't show up there.

---

### BUG-APP-008: `CorrelationIdMiddleware` reflects attacker-controlled trace IDs into responses and logs without character sanitisation
**Severity:** High
**Component:** `backend/src/observability.py:52-65, 82-99`
**Symptom:** A malicious client can send `X-Request-ID: <arbitrary-256-char-string>` and the server will (a) store that string in the `trace_id` contextvar, (b) inject it into every log record for the request lifetime, and (c) echo it back in the `X-Request-ID` response header. If the log pipeline ships JSON through a text-based aggregator (Loki, Papertrail, CloudWatch), an attacker who sends `X-Request-ID: "}\n{"severity":"CRITICAL","msg":"fake"` can forge log lines and poison dashboards / alerting rules — classic log-injection. The `_MAX_TRACE_ID_LENGTH = 256` cap limits volume but does nothing about content. Starlette blocks literal CRLF in response headers, so the *header* reflection is mostly safe, but the *log* reflection is not.
**Root cause:**
```python
def _normalise_trace_id(raw: str | None) -> str:
    if raw is None:
        return uuid.uuid4().hex
    candidate = raw.strip()
    if not candidate or len(candidate) > _MAX_TRACE_ID_LENGTH:
        return uuid.uuid4().hex
    return candidate
```
`strip()` removes only leading/trailing whitespace. Internal `\n`, `\r`, `\t`, control bytes, JSON metacharacters, ANSI escapes, and arbitrary UTF-8 all pass through unchanged and end up in every downstream log record for the request.

**Fix:** Tighten the normaliser to a conservative allow-list — e.g. `re.fullmatch(r"[A-Za-z0-9._=\-]{1,128}", candidate)` — and mint a UUID4 when the inbound value fails to match. This is the convention used by most ingress proxies (AWS ALB, GCP LB) and matches the shape of UUIDs / ULIDs / `xxhash-hex` IDs the backend is likely to see in practice. The docstring's "we don't try to enforce a specific format" stance is too permissive for a value that lands in logs and response headers.

---

### BUG-APP-009: Chaining `HABIT_WITH_GOALS.selectinload(...)` mutates the shared `HABIT_WITH_GOALS` option, causing unintended eager loads
**Severity:** High
**Component:** `backend/src/load_options.py:31-37`
**Symptom:** Every query that imports `HABIT_WITH_GOALS` (intended for lightweight goal-scalar responses on `GET /habits`) also eager-loads `Goal.completions`, because `HABIT_WITH_GOALS_AND_COMPLETIONS` is built by *extending* the same `_AbstractLoad` instance. SQLAlchemy's `Load.selectinload(...)` returns a new `Load` but appends the child path to the parent's internal `context` on some versions / in some chained forms, so the two module-level constants end up pointing at overlapping path specs. The observable symptom is a silent N+1-style over-fetch on the habits list endpoint (`completions` pulled for every goal of every habit) and — worse — this coupling means a future editor who *removes* `.selectinload(Goal.completions)` from the "heavy" option has no way to do so without also affecting the "light" one.
**Root cause:**
```python
HABIT_WITH_GOALS: _AbstractLoad = selectinload(Habit.goals)  # type: ignore[arg-type]

HABIT_WITH_GOALS_AND_COMPLETIONS: _AbstractLoad = HABIT_WITH_GOALS.selectinload(
    Goal.completions  # type: ignore[arg-type]
)
```
Sharing module-level loader options between callers is already fragile because loader options can carry mutable path state; building the "extended" option *from* the base option makes the two aliases of the same underlying path tree. The `# type: ignore[arg-type]` comments hide that mypy is already uncomfortable with the shape.

**Fix:** Construct each option independently from a fresh `selectinload(...)` call so their internal paths can't alias each other:
```python
HABIT_WITH_GOALS = selectinload(Habit.goals)
HABIT_WITH_GOALS_AND_COMPLETIONS = selectinload(Habit.goals).selectinload(Goal.completions)
```
Add a regression test that issues `select(Habit).options(HABIT_WITH_GOALS)` against a fixture with populated completions and asserts (via SQLAlchemy's statement compilation or `sqlalchemy.event.listens_for("after_cursor_execute")`) that no `goalcompletion` SELECT is emitted. Remove the `# type: ignore[arg-type]` once the true signature is satisfied; if mypy still complains, fix the type, don't silence it.

---

### BUG-APP-010: No global exception handler — unhandled exceptions return Starlette's default 500 with no trace ID, breaking incident forensics
**Severity:** Medium
**Component:** `backend/src/errors.py` (whole file) + `backend/src/main.py:189-217`
**Symptom:** `errors.py` only exposes factories that return `HTTPException`; there are no custom exception classes and — crucially — no global exception handler is registered on the app for bare `Exception`. Any unhandled exception inside a route (e.g. `IntegrityError` from the duplicate-signup race in BUG-AUTH-003, a `ValueError` from malformed JSON in a handler, a `KeyError` on a missing dict key) falls through to Starlette's default `ServerErrorMiddleware`, which returns a plain-text `Internal Server Error` response with **no JSON envelope, no `detail` field, and no `X-Request-ID` / trace_id correlation in the body**. Operators triaging a production 500 have to join uvicorn's stderr traceback against the echoed `X-Request-ID` response header — which the client may or may not have captured — instead of getting a single structured payload. Worse, when `DEBUG` is set (Starlette's convention), the full traceback IS rendered to the client, which is an information-disclosure footgun waiting for the first person to flip the flag in staging.
**Root cause:**
```python
# errors.py — only HTTPException factories, nothing else
def not_found(resource: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{resource}_not_found")
# ... bad_request, forbidden, conflict, payment_required ...
```
And in `main.py` only one handler is registered:
```python
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
```
There is no `app.add_exception_handler(Exception, ...)` and no `app.add_exception_handler(StarletteHTTPException, ...)` that would guarantee every error response shares the `{"detail": "..."}` shape that the rest of the API uses.

**Fix:** Register a catch-all handler alongside the rate-limit one:
```python
async def _unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("unhandled_exception", extra={"path": request.url.path})
    return JSONResponse(
        status_code=500,
        content={"detail": "internal_error", "trace_id": get_trace_id()},
    )
app.add_exception_handler(Exception, _unhandled_exception_handler)
```
This guarantees (a) every 5xx is logged with the correlation ID via `logger.exception`, (b) the client receives the same `{"detail": ...}` envelope used everywhere else plus a `trace_id` they can quote to support, and (c) no traceback ever leaks in the response body regardless of `DEBUG`. Pair with a unit test that patches a route to raise `RuntimeError` and asserts the 500 response shape.

---

## Suggested remediation order

1. **BUG-APP-001** — reorder `add_middleware` calls (or add CORS headers inside `_rate_limit_exceeded_handler`). Trivial change that makes every 429/5xx visible to the frontend. Regression test: `OPTIONS` + forced-429 must both carry `Access-Control-Allow-Origin`.
2. **BUG-APP-006** — switch `rate_limit.py` from `get_remote_address` to a trust-aware key function that only honours `X-Forwarded-For` when the upstream proxy is in a configured allow-list. Shares scaffolding with BUG-AUTH-008.
3. **BUG-APP-002** — attach security headers to CORS preflights (either bypass `CORSMiddleware`'s short-circuit or duplicate the security-header stamping in the preflight response).
4. **BUG-APP-008** — harden `X-Request-ID` parsing in `CorrelationIdMiddleware`: reject any value that fails a strict UUID/hex regex; log only the generated ID, never the inbound one.
5. **BUG-APP-004** — split `/health` into `/livez` (no DB check) and `/readyz` (DB check with short timeout and cached result). Tell Railway to use `/livez` for restart decisions.
6. **BUG-APP-003** — replace the prefix check in `_validate_https_origins` with `urllib.parse.urlparse`; reject IP hostnames, userinfo, wildcards, and any path/query.
7. **BUG-APP-007** — call `install_trace_id_logging()` at module import time (top of `main.py`), not inside `lifespan`; also attach the filter to uvicorn's named loggers so access logs carry `trace_id`.
8. **BUG-APP-009** — rebuild the compound loader option from scratch instead of chaining onto `HABIT_WITH_GOALS`: create a new `selectinload(Habit.goals)` and attach `selectinload(Habit.completions)` to it independently.
9. **BUG-APP-010** — add a generic `Exception` handler in `main.py` that logs with `trace_id` and returns a consistent JSON envelope (`{"detail": "internal_error", "trace_id": "..."}`). Add a minimal `errors.py` hierarchy for domain-specific error classes.
10. **BUG-APP-005** — gate `/docs` and `/redoc` behind env (`if ENV in ("production", "staging"): openapi_url=None`) or behind the admin auth guard. Set a real `title` and `version` on `FastAPI(...)`.

## Cross-references

- **BUG-APP-001 + BUG-APP-002** feed the user-visible "network error" symptom that masked the actual tab-boot 401 response in the initial user report — when the browser drops a CORS-less error, the client's error handler (`errorMessages.ts` → BUG-API-018) falls through to generic copy.
- **BUG-APP-006** extends the auth-only `X-Forwarded-For` trust problem in **BUG-AUTH-008** to the entire rate-limited API surface.
- **BUG-APP-007 + BUG-APP-008** compound any investigation of the user-reported bug: import-time log lines have no trace ID, and inbound-ID poisoning means an attacker (or a confused client) can make one user's log line read like another's.
- **BUG-APP-009** affects the Habits list endpoint's response size and is the first of several N+1 / over-fetch bugs that will surface in reports 07 (models/schemas) and 09 (habits).
- **BUG-APP-010** is the backend mirror of **BUG-API-018** (frontend mapping of 500 → generic message). Both need to move together for the error surface to become debuggable.
