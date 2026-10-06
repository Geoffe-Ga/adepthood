"""Error monitoring: report unhandled exceptions without reporting the user.

Adepthood is a private journal, so the default configuration of every error
monitor on the market is unusable here: request bodies, frame locals, and log
breadcrumbs are exactly where a journal entry, a transcript, or a bearer key
lives at the moment something throws.  Shipping those to a vendor would be a
worse failure than the invisibility this module exists to fix.

Two independent locks keep it shut:

* :func:`init_error_monitoring` turns off every automatic capture channel.
  ``default_integrations`` / ``auto_enabling_integrations`` are off, so no
  ASGI, logging, or HTTP instrumentation ever runs and the SDK sees nothing it
  was not explicitly handed; ``include_local_variables`` and
  ``max_request_body_size`` close the two channels named by hand below.  The
  only path an event can take into the vendor is the explicit
  :func:`capture_exception` call the global handler in ``errors.py`` already
  makes — there is no second error-handling path.
* :func:`scrub_event` then *rebuilds* every outgoing event from an allowlist
  of fields: release and request identity, and per exception its type, frame
  locations and a content-free reason.  The exception message itself is never
  copied — it is authored at the raise site and can interpolate anything — so
  neither it nor any field a future SDK adds can reach the vendor (#3079).

Monitoring is wholly optional, on the same terms as ``CREEK_VAULT_URL``:
with ``SENTRY_DSN`` unset the SDK is never initialised, the deployment runs
normally, and boot says so exactly once.  Degrading is not swallowing — the
structured ``unhandled_exception`` log record with its traceback (frames and
exception types; messages are withheld by ``observability``'s formatter) is
emitted by ``errors._sanitized_500`` either way, so an unconfigured
deployment loses the operator inbox, never the diagnosis.
"""

from __future__ import annotations

import logging
import os
import re
from collections.abc import Mapping
from datetime import datetime
from typing import Final, TypedDict, Unpack, cast

import sentry_sdk
from sentry_sdk.transport import Transport
from sentry_sdk.types import Breadcrumb, BreadcrumbHint, Event, Hint
from sentry_sdk.utils import BadDsn

from telemetry_safety import MESSAGE_WITHHELD, exception_chain, exception_reason

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

# Seconds the shutdown flush may spend draining the queue.  Bounded because a
# monitoring vendor being slow must not hold a deploy's rollover open.
SHUTDOWN_FLUSH_TIMEOUT_SECONDS: Final = 2.0

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
    "SMTP_PASSWORD",
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


# The allowlist an outgoing event is rebuilt from (#3079). Every field below is
# release identity, request identity, or the location and class of a failure;
# none is authored from user input. Widening any of these is a privacy decision
# -- and backend/tests/security/test_telemetry_sentinels.py asserts the output
# stays inside them.
_TOP_LEVEL_FIELDS: Final = ("event_id", "timestamp", "platform", "level", "environment", "release")
_SDK_FIELDS: Final = ("name", "version")
_TAG_FIELDS: Final = ("request_id",)
# Derived from the TypedDict, so the one reviewed place to add a context field
# is still :class:`SentryContext`.
_REQUEST_CONTEXT_FIELDS: Final = tuple(sorted(SentryContext.__optional_keys__))
# ``value`` is deliberately absent: it is the exception message, and is
# replaced by a content-free reason instead of copied.
_ENTRY_FIELDS: Final = ("type", "module")
# ``data`` and ``description`` are left out: both are free text.
_MECHANISM_FIELDS: Final = ("type", "handled", "exception_id", "parent_id", "is_exception_group")
# A frame's location only. ``abs_path`` names the host's filesystem, and
# ``pre_context``/``context_line``/``post_context``/``vars`` are source and
# locals -- exactly where the entry body sits at the moment of the raise.
_FRAME_FIELDS: Final = ("filename", "module", "function", "lineno", "in_app")
# Values a picked field may hold. A container in a scalar slot is dropped, not
# walked, so nothing nested can ride in under an allowlisted name.
_SCALARS: Final = (str, bool, int, float, datetime)
# ``sys.exc_info()`` is a (type, value, traceback) triple.
_EXC_INFO_ARITY: Final = 3

#: Reported as the exception type when an entry carries no usable one.
UNREPORTABLE_EXCEPTION_TYPE: Final = "UnreportableEvent"

#: SDK integrations a deployment may run with. Empty: no automatic capture of
#: requests, log records or outbound calls. A test pins the client's installed
#: set to this, so an SDK upgrade that re-enables a default fails loudly.
APPROVED_INTEGRATIONS: Final[frozenset[str]] = frozenset()


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


def _string_keyed(node: object) -> dict[str, object]:
    """Return ``node``'s string-keyed items if it is a mapping, else nothing."""
    if not isinstance(node, dict):
        return {}
    return {key: value for key, value in node.items() if isinstance(key, str)}


def _items(node: object) -> list[object]:
    """Return ``node`` if it is a list, else nothing."""
    return node if isinstance(node, list) else []


def _pick(node: object, fields: tuple[str, ...]) -> dict[str, object]:
    """Copy the named fields of a mapping, keeping only scalar values."""
    source = _string_keyed(node)
    return {field: source[field] for field in fields if isinstance(source.get(field), _SCALARS)}


def _rebuild_frames(entry: dict[str, object]) -> list[dict[str, object]]:
    """Return an entry's frames as location only: no source lines, no locals."""
    frames = _items(_string_keyed(entry.get("stacktrace")).get("frames"))
    return [_pick(frame, _FRAME_FIELDS) for frame in frames if isinstance(frame, dict)]


def _unreportable_entry() -> dict[str, object]:
    """Return the entry reported when nothing about the exception was usable."""
    return {"type": UNREPORTABLE_EXCEPTION_TYPE, "value": MESSAGE_WITHHELD}


def _rebuild_entry(entry: dict[str, object], codes: dict[str, str]) -> dict[str, object]:
    """Rebuild one exception entry: type, module, mechanism, frames, and a code."""
    rebuilt = _pick(entry, _ENTRY_FIELDS)
    exc_type = rebuilt.get("type")
    if not isinstance(exc_type, str):
        return _unreportable_entry()
    rebuilt["value"] = codes.get(exc_type, MESSAGE_WITHHELD)
    mechanism = _pick(entry.get("mechanism"), _MECHANISM_FIELDS)
    if mechanism:
        rebuilt["mechanism"] = mechanism
    frames = _rebuild_frames(entry)
    if frames:
        rebuilt["stacktrace"] = {"frames": frames}
    return rebuilt


def _exception_entries(event: dict[str, object]) -> list[dict[str, object]]:
    """Return the event's exception entries, tolerating any other shape."""
    values = _items(_string_keyed(event.get("exception")).get("values"))
    return [_string_keyed(entry) for entry in values if isinstance(entry, dict)]


def _declared_codes(hint: Mapping[str, object]) -> dict[str, str]:
    """Map each exception type name in the hint's chain to the code it declares.

    The SDK names an entry by its type alone, so the code is matched by name.
    A name two classes in the chain share, with different codes, is left out:
    the entry then reports the marker rather than a guess.
    """
    exc_info = hint.get("exc_info")
    if not isinstance(exc_info, tuple) or len(exc_info) != _EXC_INFO_ARITY:
        return {}
    exc = exc_info[1]
    if not isinstance(exc, BaseException):
        return {}
    candidates: dict[str, set[str]] = {}
    for linked in exception_chain(exc):
        reason = exception_reason(linked)
        for name in {type(linked).__name__, type(linked).__qualname__}:
            candidates.setdefault(name, set()).add(reason)
    return {name: reasons.pop() for name, reasons in candidates.items() if len(reasons) == 1}


def _rebuild_event(event: dict[str, object], codes: dict[str, str]) -> dict[str, object]:
    """Construct the outgoing event from the allowlist alone."""
    rebuilt = _pick(event, _TOP_LEVEL_FIELDS)
    request_context = _pick(
        _string_keyed(event.get("contexts")).get(REQUEST_CONTEXT_KEY), _REQUEST_CONTEXT_FIELDS
    )
    sections: dict[str, dict[str, object]] = {
        "sdk": _pick(event.get("sdk"), _SDK_FIELDS),
        "tags": _pick(event.get("tags"), _TAG_FIELDS),
        "contexts": {REQUEST_CONTEXT_KEY: request_context} if request_context else {},
    }
    rebuilt.update({name: section for name, section in sections.items() if section})
    entries = [_rebuild_entry(entry, codes) for entry in _exception_entries(event)]
    rebuilt["exception"] = {"values": entries or [_unreportable_entry()]}
    return rebuilt


def _minimal_event() -> dict[str, object]:
    """Return the event shipped when the rebuild itself failed."""
    return {"level": "error", "exception": {"values": [_unreportable_entry()]}}


def _redacted(node: object, secrets: tuple[str, ...]) -> object:
    """Return ``node`` with every string passed through :func:`redact_text`."""
    if isinstance(node, str):
        return redact_text(node, secrets)
    if isinstance(node, dict):
        return {key: _redacted(value, secrets) for key, value in node.items()}
    if isinstance(node, list):
        return [_redacted(item, secrets) for item in node]
    return node


def scrub_event(event: object, hint: Mapping[str, object]) -> dict[str, object]:
    """Rebuild an outgoing event from an allowlist (``before_send``).

    Constructive, not subtractive: the result is a new dict holding only the
    fields named in this module -- release identity, the request-identity
    context, and per exception its type, mechanism, frame locations and a
    content-free reason (:func:`telemetry_safety.exception_reason`). An
    exception message, a frame's source lines or locals, a request body, a log
    entry, or a key some future SDK invents is never copied, so it cannot ship.

    Never raises and never returns its input: a shape it cannot read yields
    :func:`_minimal_event`. Credential redaction then runs over the strings
    that survived, as a second, independent lock.
    """
    try:
        rebuilt = _rebuild_event(_string_keyed(event), _declared_codes(hint))
    except Exception:
        logger.exception(
            "error_monitoring_event_unreadable: the outgoing event could not be rebuilt, "
            "so a minimal event naming no detail was reported in its place"
        )
        rebuilt = _minimal_event()
    return cast("dict[str, object]", _redacted(rebuilt, _configured_secret_values()))


def _before_send(event: Event, hint: Hint) -> Event:
    """Adapt :func:`scrub_event` to the SDK's ``before_send`` signature.

    The SDK types an event as a closed ``TypedDict``; the rebuild constructs a
    plain dict from an allowlist of SDK field names, so it is cast back here.
    """
    return cast("Event", scrub_event(event, hint))


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
