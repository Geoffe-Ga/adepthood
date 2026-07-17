"""Main FastAPI application instance."""

import asyncio
import ipaddress
import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated
from urllib.parse import urlparse

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from database import async_session_factory, get_session
from errors import install_exception_handlers
from middleware import (
    CorrelationIdMiddleware,
    RequestLoggingMiddleware,
    SecurityHeadersMiddleware,
)
from observability import configure_logging, install_trace_id_logging
from rate_limit import limiter
from routers.admin import router as admin_router
from routers.auth import router as auth_router
from routers.botmason import router as botmason_router
from routers.course import router as course_router
from routers.depth_preferences import router as depth_preferences_router
from routers.energy import router as energy_router
from routers.goal_completions import router as goal_completion_router
from routers.goal_groups import router as goal_groups_router
from routers.goal_groups import seed_goal_group_templates
from routers.goals import router as goals_router
from routers.habits import router as habits_router
from routers.invitations import router as invitations_router
from routers.journal import router as journal_router
from routers.metta_return import router as metta_return_router
from routers.practice_recipes import router as practice_recipes_router
from routers.practice_sessions import router as practice_sessions_router
from routers.practice_share import router as practice_share_router
from routers.practice_tags import router as practice_tags_router
from routers.practices import router as practices_router
from routers.promotions import router as promotions_router
from routers.prompts import router as prompts_router
from routers.reflections import router as reflections_router
from routers.stages import router as stages_router
from routers.transcription import router as transcription_router
from routers.ui_flags import router as ui_flags_router
from routers.user_practices import router as user_practices_router
from routers.users import router as users_router
from seed_content import seed_content
from seed_practice_recipes import seed_practice_recipes
from seed_practices import seed_practices
from seed_stages import seed_stages
from services.botmason import get_provider
from services.content_repository import (
    ContentRepositoryError,
    content_version_info,
    get_content_repository,
)

logger = logging.getLogger(__name__)

VALID_ENVIRONMENTS = {"development", "staging", "production"}

DEV_ORIGINS = [
    "http://localhost:3000",
    "http://localhost:8080",
    "http://127.0.0.1:3000",
]

# CORS — only the methods the API actually serves are allowed.  Listing them
# explicitly (BUG-INFRA-008) keeps the preflight surface tight.  PATCH is
# required: several endpoints (user-practices customize, journal, practice tags
# and recipes) are PATCH, and omitting it 400s their browser preflight so every
# save fails on the web app.  ``test_allowed_methods_cover_all_routes`` guards
# that this list stays a superset of the verbs the routers actually serve.
ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
# ``X-Request-ID`` is included so browser clients on a different origin
# can SET the header on outbound requests (otherwise the preflight
# strips it).  It is also exposed via ``EXPOSED_HEADERS`` below so the
# response copy survives the cross-origin filter and the AuthContext /
# logging adapter can correlate client-side telemetry with server logs.
ALLOWED_HEADERS = [
    "Authorization",
    "Content-Type",
    "X-LLM-API-Key",
    "X-Request-ID",
]
# Headers the browser is allowed to read from the response.  Without
# ``expose_headers`` the trace-id echoed by ``CorrelationIdMiddleware``
# is silently dropped by every cross-origin browser client and the PR's
# end-to-end correlation contract is broken (BUG-APP-001 follow-up).
EXPOSED_HEADERS = ["X-Request-ID"]


_LOOPBACK_HOSTNAMES = frozenset({"localhost", "127.0.0.1", "::1"})


def _check_origin_hostname(origin: str, hostname: str | None) -> None:
    """Hostname-related slice of the CORS allow-list checks (BUG-APP-003).

    Split out so the parent ``_validate_prod_origin`` stays at xenon
    rank A; the IP-literal try/except plus the loopback set membership
    plus the empty-hostname guard add up to four branches that read
    cleaner here.
    """
    if not hostname:
        msg = f"PROD_DOMAIN entry has no hostname: '{origin}'"
        raise RuntimeError(msg)
    if hostname in _LOOPBACK_HOSTNAMES:
        msg = f"PROD_DOMAIN cannot point at loopback: '{origin}'"
        raise RuntimeError(msg)
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        # Hostname is not a bare IP literal -- this is the good case.
        return
    msg = f"PROD_DOMAIN cannot be a bare IP: '{origin}'"
    raise RuntimeError(msg)


def _validate_prod_origin(origin: str) -> None:
    """Reject obviously-wrong production origins (BUG-APP-003).

    The previous ``startswith("https://")`` check let through bare IPs,
    ``https://localhost``, embedded userinfo  # pragma: allowlist secret
    (``https://user@host`` style URLs with credentials in the netloc),
    wildcards (``https://*.example.com``), and trailing-slash typos --
    each of which silently broke or weakened the CORS allow-list.

    The strict ruleset:

    * Scheme must be ``https`` (already covered, kept).
    * Hostname must be set, must not be a literal IP address, must
      not be ``localhost`` / ``127.0.0.1``.
    * No wildcards (``*``) or userinfo (``@``) in the URL.

    A misconfigured deployment fails the readiness probe at startup
    rather than serving traffic with a hole in the allow-list.
    """
    parsed = urlparse(origin)
    if parsed.scheme != "https":
        msg = f"PROD_DOMAIN entries must use HTTPS, got '{origin}'"
        raise RuntimeError(msg)
    _check_origin_hostname(origin, parsed.hostname)
    if "*" in origin or "@" in origin:
        msg = f"PROD_DOMAIN cannot contain wildcard or userinfo: '{origin}'"
        raise RuntimeError(msg)


def _validate_https_origins(origins: list[str]) -> None:
    """Validate every origin against ``_validate_prod_origin``.

    Wraps the per-origin check so callers iterate once over the parsed
    list and the per-origin failure message is rich enough to identify
    which entry is bad.
    """
    for origin in origins:
        _validate_prod_origin(origin)


def _parse_prod_origins() -> list[str]:
    """Parse and validate PROD_DOMAIN for staging/production environments.

    Raises ``RuntimeError`` when PROD_DOMAIN is missing, empty, or contains
    non-HTTPS entries — the server should fail fast on bad config.
    """
    prod_domain = os.getenv("PROD_DOMAIN")
    if not prod_domain:
        raise RuntimeError("PROD_DOMAIN must be set in production/staging")

    origins = [d.strip() for d in prod_domain.split(",") if d.strip()]
    if not origins:
        raise RuntimeError("PROD_DOMAIN must not be empty")

    _validate_https_origins(origins)
    # BUG-INFRA-007: order-preserving dedup so duplicate entries in
    # PROD_DOMAIN don't produce duplicate Access-Control-Allow-Origin lines.
    return list(dict.fromkeys(origins))


def get_cors_origins(env: str | None = None) -> list[str]:
    """Build the CORS allowed-origins list based on the current environment.

    Raises ``RuntimeError`` for invalid configuration so the server fails fast
    rather than silently accepting bad requests.
    """
    if env is None:
        env = os.getenv("ENV", "development")

    if env not in VALID_ENVIRONMENTS:
        raise RuntimeError(
            f"Unknown ENV value '{env}'. Must be one of: {', '.join(sorted(VALID_ENVIRONMENTS))}"
        )

    if env == "development":
        # BUG-INFRA-006: warn loudly when PROD_DOMAIN is set in dev so
        # developers notice misconfiguration before staging rollout.
        if os.getenv("PROD_DOMAIN"):
            logger.warning(
                "PROD_DOMAIN is set but ENV=development — production origins ignored. "
                "Set ENV=staging or ENV=production to honour PROD_DOMAIN."
            )
        return list(DEV_ORIGINS)

    return _parse_prod_origins()


def _assert_credentials_safe(origins: list[str]) -> None:
    """Reject ``*`` in the CORS allow-list; require explicit origins.

    Originally guarded the spec-forbidden ``Access-Control-Allow-Origin: *`` +
    ``Access-Control-Allow-Credentials: true`` combo (BUG-INFRA-005). Credentials
    mode is now off, but a wildcard origin is still rejected as defense-in-depth:
    explicit origins keep fine-grained CORS control regardless of credentials.
    Failing closed at startup surfaces the misconfiguration immediately.
    """
    if "*" in origins:
        raise RuntimeError(
            "CORS allow-list contains '*'. Use explicit origins — a wildcard "
            "origin disables fine-grained CORS control regardless of credentials mode."
        )


def _rate_limit_exceeded_handler(_request: Request, exc: Exception) -> JSONResponse:
    """Return a JSON 429 response with Retry-After header when rate limit is exceeded.

    The signature widens ``exc`` to :class:`Exception` so it conforms
    to FastAPI's ``add_exception_handler`` callable shape (without
    needing a ``# type: ignore``).  ``add_exception_handler`` only ever
    routes ``RateLimitExceeded`` instances here — the wider type is a
    contract concession, not a runtime hazard.  ``getattr`` reads
    ``retry_after`` so a generic ``Exception`` (impossible at runtime
    given the dispatch table) still produces a sensible 60-second
    fallback rather than crashing.
    """
    retry_after = getattr(exc, "retry_after", 60)
    return JSONResponse(
        status_code=429,
        content={"detail": "rate_limit_exceeded"},
        headers={"Retry-After": str(retry_after)},
    )


# BUG-APP-007: install the trace-id log filter at *import* time, not in the
# lifespan startup hook.  Module imports (router registration, seed data
# loading) run before lifespan fires, and a missing filter at that point
# would leave their log records without a ``trace_id`` field — breaking
# the formatter and causing a flood of ``KeyError`` messages on the very
# first request a worker process serves.  The function is idempotent.
install_trace_id_logging()


async def _seed_startup_data(session: AsyncSession) -> None:
    """Run the idempotent seeders, with isolation and a stages prerequisite.

    Each dependent seeder (``seed_practices``, ``seed_practice_recipes``,
    ``seed_content``, ``seed_goal_group_templates``) reads from the seeded
    ``CourseStage`` rows, so a ``seed_stages`` failure must short-circuit
    — otherwise the dependents run against an empty stages table and log
    a misleading ``seed_complete inserted=0``. The dependents are
    independent of each other, so each is isolated in its own try/except:
    a failure in one (e.g. a new mode landing in a CHECK constraint before
    the seed list catches up) must not starve the others. Successes log the
    inserted count so a quiet deploy is still verifiable from the boot log.
    """
    try:
        inserted = await seed_stages(session)
        # Name and count ride in the message itself — ``extra`` fields
        # don't render through a plain formatter, and the deploy-verify
        # contract (docs/content.md) reads the boot log text.
        logger.info("seed_complete seeder=%s inserted=%d", "stages", inserted)
    except Exception:
        logger.exception("seed_failed seeder=%s", "stages", extra={"seeder": "stages"})
        await session.rollback()
        return

    for name, seeder in (
        ("practices", seed_practices),
        ("practice_recipes", seed_practice_recipes),
        ("content", seed_content),
        ("goal_group_templates", seed_goal_group_templates),
    ):
        try:
            inserted = await seeder(session)
            logger.info("seed_complete seeder=%s inserted=%d", name, inserted)
        except Exception:
            logger.exception("seed_failed seeder=%s", name, extra={"seeder": name})
            await session.rollback()


def _log_botmason_provider() -> None:
    """Report the active LLM provider at boot (issue #402).

    Stub-in-production must be an explicit, visible choice — a deploy that
    forgot ``BOTMASON_PROVIDER``/``LLM_API_KEY`` would otherwise silently
    serve canned chat responses to real users.
    """
    provider = get_provider()
    logger.info("botmason_provider provider=%s", provider)
    if provider == "stub" and os.getenv("ENV", "development") == "production":
        logger.warning(
            "botmason_stub_in_production: BOTMASON_PROVIDER is 'stub' — real "
            "users will get canned responses. Set BOTMASON_PROVIDER and "
            "LLM_API_KEY (see backend/.env.example) if this is unintentional."
        )


def _log_content_status() -> None:
    """Report the vendored content state at boot — loud on failure.

    A missing or invalid content directory must never silently degrade to
    a blank Course screen (issue #397): the error log names the problem
    and the fix.  On success, the live pin is logged for observability.
    """
    try:
        chapter_count = len(get_content_repository().list_chapters())
    except ContentRepositoryError:
        logger.exception(
            "content_missing_or_invalid — Course screens will be empty "
            "until a content pin is vendored (see docs/content.md)"
        )
        return
    version = content_version_info() or {}
    logger.info(
        "content_loaded sha=%s chapters=%d",
        version.get("sha", "unknown"),
        chapter_count,
    )


@asynccontextmanager
async def lifespan(_application: FastAPI) -> AsyncIterator[None]:
    """Startup/shutdown lifecycle for the application."""
    # First thing on boot: give the root logger a real handler.  Uvicorn
    # only configures its own ``uvicorn.*`` loggers, so without this every
    # app record below WARNING — including every ``seed_complete`` /
    # ``content_loaded`` line this very function emits — is silently
    # dropped, and a production seeding failure looks identical to a
    # successful boot.
    configure_logging()
    # Deliberate lazy imports: ``models`` registers every SQLModel table
    # with the metadata exactly once at startup (the unused name is the
    # point), and ``_get_secret_key`` would import-cycle at module load.
    # The F401/PLC0415 exceptions are scoped per-file in pyproject.toml
    # (issue #272) instead of inline noqa comments.
    import models
    from routers.auth import _get_secret_key
    from services import journal_encryption

    # Make the journal-encryption state observable per worker (each uvicorn
    # worker caches its own key registry) without reading source (audit-destub-05b).
    logger.info("journal_encryption_enabled=%s", journal_encryption.is_enabled())

    # BUG-AUTH-011: validate ``SECRET_KEY`` once at startup so a misconfigured
    # deployment fails the orchestrator's health probe immediately rather than
    # silently serving traffic and crashing on the first auth request.  The
    # underlying check is the same lazy guard ``_get_secret_key`` already does;
    # invoking it here turns "first user pays" into "deploy never goes live".
    _get_secret_key()

    # ritual-practice ops: on every boot, seed the catalog (stages, presets,
    # course content) so a fresh database is immediately usable.
    # Opt-out via ``SKIP_STARTUP_SEED=1`` for tests and contexts where the
    # database is intentionally empty (e.g. integration suites mounting a
    # mocked alembic chain). A seeder failure is logged and swallowed — the
    # orchestrator should still be able to take the pod live so an operator
    # can SSH in and run ``alembic upgrade head`` if migrations are missing.
    if os.getenv("SKIP_STARTUP_SEED") != "1":
        try:
            async with async_session_factory() as session:
                await _seed_startup_data(session)
        except Exception:
            logger.exception("startup seed failed; continuing without seeded catalog")

    # Issue #397: surface a bad content deploy at boot, not at first
    # chapter open.  Loud log rather than crash — the app's non-content
    # features must stay serviceable, mirroring the seeder policy above.
    _log_content_status()
    # Issue #402: make the active LLM provider observable at startup.
    _log_botmason_provider()

    yield


app = FastAPI(lifespan=lifespan)

# Attach the rate limiter to the app so slowapi can find it
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# BUG-OBS-002 / -003: install the global exception handlers BEFORE the
# routers are mounted so any unhandled exception during route execution
# (or in the middleware stack itself) is caught, logged with the
# request ID, reported to Sentry, and returned as a stable JSON envelope
# instead of leaking exception messages to the client.
install_exception_handlers(app)

# BUG-APP-001: Starlette's ``add_middleware`` is LIFO — the LAST class added
# becomes the OUTERMOST layer.  We register innermost-first so the actual
# request flow becomes:
#
#   RequestLoggingMiddleware  (outermost; always emits an access record)
#   -> CorrelationIdMiddleware  (mints / honours X-Request-ID)
#      -> SecurityHeadersMiddleware  (CSP / HSTS / Referrer-Policy / etc.)
#         -> CORSMiddleware  (preflight handling + ACAO / ACAC)
#            -> SlowAPIMiddleware  (rate-limit; innermost so 429s carry headers)
#               -> route handler
#
# Putting CORS *inside* SecurityHeaders means preflight (BUG-APP-002) and
# rate-limited responses inherit the security-header set; putting trace-id
# outside CORS means even preflight responses echo ``X-Request-ID``.
origins = get_cors_origins()
_assert_credentials_safe(origins)

app.add_middleware(SlowAPIMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    # The API authenticates with ``Authorization: Bearer`` tokens and sets no
    # cookies, so credentials mode is unnecessary; disabling it shrinks the CORS
    # attack surface and avoids the ``*``-origin restriction (audit §5.3).
    allow_credentials=False,
    allow_methods=ALLOWED_METHODS,
    allow_headers=ALLOWED_HEADERS,
    expose_headers=EXPOSED_HEADERS,
)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(CorrelationIdMiddleware)
app.add_middleware(RequestLoggingMiddleware)

# Register feature routers
app.include_router(admin_router)
app.include_router(auth_router)
app.include_router(botmason_router)
app.include_router(course_router)
app.include_router(practices_router)
app.include_router(practice_share_router)
app.include_router(practice_recipes_router)
app.include_router(practice_tags_router)
app.include_router(user_practices_router)
app.include_router(practice_sessions_router)
app.include_router(habits_router)
app.include_router(journal_router)
app.include_router(transcription_router)
app.include_router(reflections_router)
app.include_router(promotions_router)
app.include_router(prompts_router)
app.include_router(energy_router)
app.include_router(goal_completion_router)
app.include_router(goal_groups_router)
app.include_router(goals_router)
app.include_router(stages_router)
app.include_router(users_router)
app.include_router(depth_preferences_router)
app.include_router(ui_flags_router)
app.include_router(invitations_router)
app.include_router(metta_return_router)


# BUG-APP-004: separate liveness from readiness so the orchestrator can
# distinguish "process is up" from "process can serve traffic".  A
# liveness probe that fails the way a readiness probe should (DB hiccup,
# slow query, etc.) restarts the container; a readiness probe that
# fails takes the pod out of rotation without restarting it, which is
# what we actually want during a transient DB blip.  Combined ``/health``
# kept for backwards compatibility (Railway / existing dashboards) --
# behaves like the readiness probe so a healthy old-style monitor is
# still meaningful.
_DB_PROBE_TIMEOUT_SECONDS = 2.0


async def _probe_db(session: AsyncSession, *, log_event: str, detail: str) -> None:
    """Run the bounded ``SELECT 1`` readiness probe, raising 503 on failure.

    Shared by ``readiness`` and ``health_check`` so the timeout window, the
    caught-exception tuple, and the 503 contract live in one place -- the single
    seam behind the BUG-APP-004 liveness/readiness split.  ``log_event`` and
    ``detail`` let each caller keep its own log-event name and 503 ``detail``
    (``"not_ready"`` vs. the legacy ``"Database unavailable"``) while sharing the
    probe body.

    Session lifecycle is owned by ``Depends(get_session)`` -- we don't open or
    close the session here, so a failed ``SELECT 1`` cannot leak a connection.
    """
    try:
        async with asyncio.timeout(_DB_PROBE_TIMEOUT_SECONDS):
            await session.execute(text("SELECT 1"))
    except (TimeoutError, OSError, SQLAlchemyError) as exc:
        logger.exception(log_event)
        raise HTTPException(status_code=503, detail=detail) from exc


@app.get("/health/live")
async def liveness() -> dict[str, str]:
    """Liveness probe: process is responsive (no DB dependency).

    Always returns ``{"status": "alive"}`` 200 as long as the event
    loop can dispatch a request.  An orchestrator restart on this
    failing means the *process* is wedged -- restart is the right
    response.  A DB outage should NOT trip this probe.
    """
    return {"status": "alive"}


@app.get("/health/ready")
async def readiness(
    session: Annotated[AsyncSession, Depends(get_session)],
) -> dict[str, str]:
    """Readiness probe: app + DB are both serving traffic.

    Bounded by ``_DB_PROBE_TIMEOUT_SECONDS`` so a slow database does
    not hang the probe forever and silently keep an unhealthy pod in
    rotation.  Failures (timeout or query error) return 503 so the
    orchestrator drops the pod from the load-balancer pool until the
    next successful probe.

    Session lifecycle is owned by ``Depends(get_session)`` -- we don't
    open or close the session here, so a failed ``SELECT 1`` cannot
    leak a connection.  The dependency's ``async with`` (in
    ``database.py``) guarantees ``close()`` runs even when the handler
    raises.
    """
    await _probe_db(session, log_event="readiness_check_failed", detail="not_ready")
    return {"status": "ready", "database": "connected"}


@app.get("/health")
async def health_check(
    session: Annotated[AsyncSession, Depends(get_session)],
) -> dict[str, str]:
    """Combined probe (legacy): mirrors ``/health/ready`` for back-compat.

    Existing Railway / dashboard probes hit this path; rather than
    breaking them, the response shape is preserved (``status: healthy``
    + ``database: connected``).  New deployments should hit
    ``/health/live`` and ``/health/ready`` directly so liveness and
    readiness can be configured independently (BUG-APP-004).
    """
    await _probe_db(session, log_event="health_check_failed", detail="Database unavailable")
    # Surface the live content pin so dashboards can alert on an unexpected
    # value after a deploy. "none" = nothing vendored yet.
    content_version = (content_version_info() or {}).get("sha", "none")
    return {"status": "healthy", "database": "connected", "content_version": content_version}
