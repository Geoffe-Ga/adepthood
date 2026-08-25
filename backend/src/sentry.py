"""Error monitoring: report unhandled exceptions without reporting the user.

Adepthood is a private journal, so the default configuration of every error
monitor on the market is unusable here: request bodies, frame locals, and log
breadcrumbs are exactly where a journal entry, a transcript, or a bearer key
lives at the moment something throws.  Shipping those to a vendor would be a
worse failure than the invisibility this module exists to fix.

The configuration is therefore subtractive twice over:

* :func:`init_error_monitoring` turns off every automatic capture channel.
  ``default_integrations`` / ``auto_enabling_integrations`` are off, so no
  ASGI, logging, or HTTP instrumentation ever runs and the SDK sees nothing it
  was not explicitly handed; ``include_local_variables`` and
  ``max_request_body_size`` close the two channels named by hand below.  The
  only path an event can take into the vendor is the explicit
  :func:`capture_exception` call the global handler in ``errors.py`` already
  makes — there is no second error-handling path.
* :func:`scrub_event` then runs on every outgoing event as a last line of
  defence, deleting the sections a future SDK upgrade (or a re-enabled
  integration) could repopulate and redacting credential-shaped text.

Monitoring is wholly optional, on the same terms as ``CREEK_VAULT_URL``:
with ``SENTRY_DSN`` unset the SDK is never initialised, the deployment runs
normally, and boot says so exactly once.  Degrading is not swallowing — the
structured ``unhandled_exception`` log record with its full traceback is
emitted by ``errors._sanitized_500`` either way, so an unconfigured
deployment loses the operator inbox, never the diagnosis.
"""

from __future__ import annotations

import logging
import os
import re
from typing import Final, TypedDict, Unpack, cast

import sentry_sdk
from sentry_sdk.transport import Transport
from sentry_sdk.types import Breadcrumb, BreadcrumbHint, Event, Hint
from sentry_sdk.utils import BadDsn

logger = logging.getLogger(__name__)

SENTRY_DSN_ENV_VAR: Final = "SENTRY_DSN"
SENTRY_RELEASE_ENV_VAR: Final = "SENTRY_RELEASE"
ENVIRONMENT_ENV_VAR: Final = "ENV"
# Railway injects the deployed commit; honouring it means release tagging works
# on the platform this app deploys to without an operator setting anything.
PLATFORM_RELEASE_ENV_VAR: Final = "RAILWAY_GIT_COMMIT_SHA"
DEFAULT_ENVIRONMENT: Final = "development"
UNKNOWN_RELEASE: Final = "unknown"

# Context key the request metadata is attached under.  Namespaced so it cannot
# collide with a vendor-defined context (``trace``, ``runtime``, ``os``).
REQUEST_CONTEXT_KEY: Final = "adepthood_request"

REDACTED: Final = "[redacted]"
TRUNCATION_MARKER: Final = "…[truncated]"

# Seconds the shutdown flush may spend draining the queue.  Bounded because a
# monitoring vendor being slow must not hold a deploy's rollover open.
SHUTDOWN_FLUSH_TIMEOUT_SECONDS: Final = 2.0

# An exception message is the one field this module cannot structurally
# guarantee: it is authored at the raise site, and a message that interpolates
# a value could interpolate an entry body.  The house rule is that exception
# messages are static and capability-named (see ``dependencies/creek_vault.py``
# refusing to echo a config value); this cap bounds the damage when a message
# somewhere does not follow it.
MAX_EXCEPTION_MESSAGE_CHARS: Final = 512

# Keys deleted wherever they appear in an event.  ``request`` carries the body
# and headers, ``extra``/``breadcrumbs`` carry whatever an integration logged,
# and ``vars`` is a stack frame's locals — the four channels through which a
# default-configured SDK ships user content.
_DROPPED_KEYS: Final = frozenset({"request", "extra", "breadcrumbs", "vars"})

# A string value is redacted outright when its key names a credential, whatever
# the value looks like.  Substring match, so ``x-llm-api-key`` and
# ``authorization`` are both caught by one entry each.
_CREDENTIAL_KEY_MARKERS: Final = ("authorization", "password", "secret", "token", "api_key", "dsn")

# Environment variables whose *value* is a credential.  An opaque vault key has
# no recognisable shape, so the only reliable way to spot one that reached a
# message is to look for the literal this deployment was configured with.
_SECRET_ENV_VARS: Final = (
    "SECRET_KEY",
    "CREEK_VAULT_API_KEY",
    "JOURNAL_ENCRYPTION_KEYS",
    "LLM_API_KEY",
    "GUMROAD_API_TOKEN",
    "GUMROAD_WEBHOOK_SECRET",
)
# Below this length a "secret" is either unset, a placeholder, or so short that
# redacting every occurrence of it would shred unrelated text.
MIN_REDACTABLE_SECRET_CHARS: Final = 8

# Credential shapes that can appear in text this deployment never configured —
# a per-user vault key, a caller's bearer token, a BYOK LLM key.
_CREDENTIAL_PATTERNS: Final = (
    re.compile(r"(?i)\bbearer\s+[\w.~+/=-]{8,}"),
    re.compile(r"\bey[\w-]{8,}\.[\w-]{8,}\.[\w-]+"),
    re.compile(r"\bsk-[\w-]{8,}"),
)


class SentryContext(TypedDict, total=False):
    """Closed allow-list of context fields a capture may attach.

    The shim this replaced took ``**context: object``, which type-checked a
    future call like ``capture_exception(exc, token=bearer)`` — a credential
    that would ship to the vendor.  Narrowing the kwargs to this TypedDict
    makes any new field an explicit, reviewed decision: add it here (with a
    sensitivity check) before a call site can pass it.
    """

    request_id: str
    request_path: str
    request_method: str


def _configured_secret_values() -> tuple[str, ...]:
    """Return this deployment's credential values, long enough to be redactable."""
    values = (os.getenv(name, "") for name in _SECRET_ENV_VARS)
    return tuple(v for v in values if len(v) >= MIN_REDACTABLE_SECRET_CHARS)


def redact_text(text: str, secrets: tuple[str, ...] = ()) -> str:
    """Replace credential-shaped and known-credential substrings with a marker.

    Both halves matter: the patterns catch a credential this deployment never
    configured (a caller's bearer token, a per-user vault key), and ``secrets``
    catches an opaque one it did.
    """
    for secret in secrets:
        text = text.replace(secret, REDACTED)
    for pattern in _CREDENTIAL_PATTERNS:
        text = pattern.sub(REDACTED, text)
    return text


def _is_credential_key(key: str) -> bool:
    """Report whether a key names a field whose value is a credential."""
    lowered = key.lower()
    return any(marker in lowered for marker in _CREDENTIAL_KEY_MARKERS)


def _scrub_mapping(node: dict[str, object], secrets: tuple[str, ...]) -> None:
    """Drop the capture channels and redact the strings of one mapping, in place."""
    for key in _DROPPED_KEYS.intersection(node):
        del node[key]
    for key, value in node.items():
        if isinstance(value, str):
            node[key] = REDACTED if _is_credential_key(key) else redact_text(value, secrets)
        else:
            _scrub_node(value, secrets)


def _scrub_node(node: object, secrets: tuple[str, ...]) -> None:
    """Recurse into a mapping or sequence, scrubbing in place."""
    if isinstance(node, dict):
        _scrub_mapping(node, secrets)
    elif isinstance(node, list):
        for index, item in enumerate(node):
            if isinstance(item, str):
                node[index] = redact_text(item, secrets)
            else:
                _scrub_node(item, secrets)


def _exception_values(event: dict[str, object]) -> list[dict[str, object]]:
    """Return the event's exception entries, tolerating any other shape."""
    exception = event.get("exception")
    if not isinstance(exception, dict):
        return []
    values = exception.get("values")
    if not isinstance(values, list):
        return []
    return [entry for entry in values if isinstance(entry, dict)]


def _cap_exception_messages(event: dict[str, object]) -> None:
    """Truncate over-long exception messages in place."""
    for entry in _exception_values(event):
        message = entry.get("value")
        if isinstance(message, str) and len(message) > MAX_EXCEPTION_MESSAGE_CHARS:
            entry["value"] = message[:MAX_EXCEPTION_MESSAGE_CHARS] + TRUNCATION_MARKER


def scrub_event(event: dict[str, object], _hint: dict[str, object]) -> dict[str, object]:
    """Strip every private channel from an outgoing event (``before_send``).

    Runs on the event the client has already built, so it is defence in depth
    behind the options in :func:`init_error_monitoring`, not a substitute for
    them: if a future SDK version repopulates ``request`` or a frame's ``vars``
    despite the options, this still deletes them before the transport sees the
    event.
    """
    _cap_exception_messages(event)
    _scrub_node(event, _configured_secret_values())
    return event


def _before_send(event: Event, hint: Hint) -> Event:
    """Adapt :func:`scrub_event` to the SDK's ``before_send`` signature.

    The SDK types an event as a closed ``TypedDict``, which cannot be indexed
    by a computed key; :func:`scrub_event` needs exactly that to delete a key
    wherever it appears.  The scrub is in place, so the same object comes back.
    """
    scrub_event(cast("dict[str, object]", event), hint)
    return event


def drop_breadcrumb(_crumb: Breadcrumb, _hint: BreadcrumbHint) -> Breadcrumb | None:
    """Refuse every breadcrumb (``before_breadcrumb``).

    Breadcrumbs are a rolling buffer of whatever ran before the failure — for
    this app, the last screen the user typed into.  The hook's contract is
    "return the crumb to keep it, ``None`` to drop it", so the return type is
    the vendor's optional one and the answer here is always ``None``; the
    buffer is also sized to zero in the options, so this is the second of two
    locks on the same door.
    """
    return None


def _configured_release() -> str:
    """Return the release identifier this deployment should report events under."""
    return (
        os.getenv(SENTRY_RELEASE_ENV_VAR) or os.getenv(PLATFORM_RELEASE_ENV_VAR) or UNKNOWN_RELEASE
    )


def init_error_monitoring(transport: Transport | None = None) -> bool:
    """Initialise error monitoring if a DSN is configured; report whether it is.

    Never raises.  An unset DSN is a supported way to run this app, and a
    mistyped one must not cost a deploy: both degrade to "no vendor, full local
    logs" and say so once, mirroring ``validate_creek_vault_url_config``.

    ``transport`` is an injection seam for the tests, which drive *this*
    function — DSN handling, option set and all — with events landing in a list
    instead of on the network.  A test that assembled its own client instead
    would prove nothing about the options a deployment actually runs under,
    which is where every privacy guarantee in this module lives.
    """
    dsn = (os.getenv(SENTRY_DSN_ENV_VAR) or "").strip()
    if not dsn:
        logger.info(
            "error_monitoring_disabled: %s is unset, so unhandled exceptions are logged "
            "locally and reported to no monitoring vendor. Set it to a Sentry DSN "
            "(backend/.env.example documents the format) to receive them.",
            SENTRY_DSN_ENV_VAR,
        )
        return False
    environment = os.getenv(ENVIRONMENT_ENV_VAR) or DEFAULT_ENVIRONMENT
    release = _configured_release()
    try:
        sentry_sdk.init(
            dsn=dsn,
            environment=environment,
            release=release,
            transport=transport,
            # No automatic instrumentation: nothing observes a request, a log
            # record, or an outbound call, so nothing can capture their
            # contents. The only route into the vendor is the explicit
            # capture_exception below.
            default_integrations=False,
            auto_enabling_integrations=False,
            # Belt and braces on the two channels named above.
            send_default_pii=False,
            max_request_body_size="never",
            include_local_variables=False,
            max_breadcrumbs=0,
            # The SDK never attaches a stack to a message it invented, and no
            # performance traces (which carry route parameters) are sampled.
            attach_stacktrace=False,
            traces_sample_rate=0.0,
            before_send=_before_send,
            before_breadcrumb=drop_breadcrumb,
        )
    except BadDsn as exc:
        # The vendor's own message names the defect without echoing the key,
        # but it is passed through the redactor anyway: a DSN embeds a
        # credential and this log line is one paste away from being one.
        logger.warning(
            "error_monitoring_dsn_unusable: %s is set to a value the Sentry client cannot "
            "use (%s), so this deployment reports no exception anywhere but its own logs. "
            "Correct the value or unset %s to run without monitoring.",
            SENTRY_DSN_ENV_VAR,
            redact_text(str(exc), (dsn,)),
            SENTRY_DSN_ENV_VAR,
        )
        return False
    logger.info("error_monitoring_enabled environment=%s release=%s", environment, release)
    return True


def shutdown_error_monitoring() -> None:
    """Drain the pending event queue on shutdown, within a bounded wait.

    Needed because ``default_integrations=False`` also switches off the SDK's
    own atexit flush: without this, the report for the exception that prompted
    a restart is the one most likely to be dropped.
    """
    sentry_sdk.flush(timeout=SHUTDOWN_FLUSH_TIMEOUT_SECONDS)


def capture_exception(exc: BaseException, **context: Unpack[SentryContext]) -> None:
    """Report an unhandled exception, attaching only allow-listed request metadata.

    A no-op when no DSN was configured — the SDK has no transport to hand the
    event to — and never raises: the caller is an exception handler mid-flight,
    and a monitoring outage must cost the caller nothing but a log line.
    """
    try:
        with sentry_sdk.new_scope() as scope:
            scope.set_context(REQUEST_CONTEXT_KEY, dict(context))
            request_id = context.get("request_id")
            if request_id:
                scope.set_tag("request_id", request_id)
            sentry_sdk.capture_exception(exc)
    except Exception:
        logger.exception(
            "error_monitoring_capture_failed: the exception being handled was logged "
            "above and the request was answered normally; only the vendor report was lost"
        )
