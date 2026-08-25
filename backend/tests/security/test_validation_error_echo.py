"""A 422 must never hand the submitted value back to the caller.

FastAPI's stock ``RequestValidationError`` handler serialises an ``input``
key (and a ``ctx`` key) into every entry of the ``detail`` list, where
``input`` is the material that failed validation.  For a schema-shape
rejection that is harmless; for an auth payload it is a credential
disclosure, because a 422 is exactly the response clients feel safe
logging verbatim, forwarding to an error tracker, or rendering into a
support ticket.

Two echo shapes exist and both matter:

- ``missing`` -- when a *required* field is absent, Pydantic has no single
  offending value to point at, so ``input`` becomes the **entire request
  body**.  A field that carries no constraint of its own (and therefore
  never fails validation itself) still leaks, purely by travelling
  alongside the omitted one.
- ``string_too_short`` / ``string_too_long`` -- ``input`` is that one
  field's value.  On ``password``, ``new_password``, ``token`` and
  ``id_token`` that value *is* the secret.

The remediation is a global handler that rebuilds each entry keeping only
``type``, ``loc`` and ``msg``.  The status stays 422 and the body keeps its
``{"detail": [...]}`` list shape, so clients that read ``loc``/``msg`` are
unaffected -- which is what the shape-preservation test below pins, so a
future handler cannot "fix" the leak by flattening the contract away.

Everything here drives the real application through ``async_client``
rather than a synthetic app, because the claim under test is that the
handler is *installed on the app as shipped* -- a bare app would prove
only that the sanitiser function works in isolation.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

import pytest
from fastapi import status
from httpx import AsyncClient, Response

from routers.auth import _MAX_ID_TOKEN_LENGTH, _MAX_PASSWORD_LENGTH, _MIN_PASSWORD_LENGTH
from schemas.password_reset import _TOKEN_MIN_LENGTH

_LOGIN_PATH = "/auth/login"
_SIGNUP_PATH = "/auth/signup"
_RESET_CONFIRM_PATH = "/auth/password-reset/confirm"
_RESET_CANCEL_PATH = "/auth/password-reset/cancel"
_GOOGLE_OAUTH_PATH = "/auth/oauth/google"
_APPLE_OAUTH_PATH = "/auth/oauth/apple"

# Any syntactically valid address will do: every request below is rejected
# at the schema layer, so no row is ever looked up.
_PROBE_EMAIL = "echo-probe@example.com"

# Sentinels are spelled as instructions rather than as plausible secrets so a
# failure message names its own diagnosis, and are derived from the schema
# bounds they violate so a future change to a bound cannot quietly turn one of
# these requests into a *valid* one that never reaches the handler at all.
_SENTINEL_PASSWORD = "SENTINEL-PASSWORD-MUST-NOT-BE-ECHOED"  # pragma: allowlist secret
_SENTINEL_SHORT_PASSWORD = "N0ECHO!"[: _MIN_PASSWORD_LENGTH - 1]  # pragma: allowlist secret
_OVERLONG_PASSWORD_STEM = "SENTINEL-OVERLONG-PASSWORD-NOT-ECHOED"  # pragma: allowlist secret
_SENTINEL_LONG_PASSWORD = _OVERLONG_PASSWORD_STEM.ljust(_MAX_PASSWORD_LENGTH + 1, "x")
_RESET_TOKEN_STEM = "SENTINEL-RESET-TOKEN-NOT-ECHOED"  # pragma: allowlist secret
_SENTINEL_RESET_TOKEN = _RESET_TOKEN_STEM[: _TOKEN_MIN_LENGTH - 1]
_ID_TOKEN_STEM = "SENTINEL-ID-TOKEN-NOT-ECHOED"  # pragma: allowlist secret
_SENTINEL_ID_TOKEN = _ID_TOKEN_STEM.ljust(_MAX_ID_TOKEN_LENGTH + 1, "x")
_SENTINEL_LICENSE_KEY = "SENTINEL-LICENSE-KEY-MUST-NOT-BE-ECHOED"  # pragma: allowlist secret

# Keys the sanitised entry must not carry.  ``ctx`` goes with ``input``
# because it restates the violated bound and, on some Pydantic error types,
# embeds the offending value a second time.
_FORBIDDEN_ENTRY_KEYS = ("input", "ctx")

# Keys the sanitised entry must still carry, so clients that map a
# validation failure onto a form field keep working.
_REQUIRED_ENTRY_KEYS = ("type", "loc", "msg")


@dataclass(frozen=True)
class _RejectedRequest:
    """One request the schema layer rejects, and the secrets it carried in.

    ``sent_secrets`` is the material a caller would be horrified to find in
    a log line: the plaintext password, the single-use reset token, the
    replayable OIDC assertion, the purchase license key.
    """

    path: str
    payload: Mapping[str, object]
    sent_secrets: tuple[str, ...]


# The ``missing`` shape: no field-level constraint is involved at all, so the
# whole submitted body becomes ``input`` and the password rides along.
_LOGIN_MISSING_EMAIL = _RejectedRequest(
    path=_LOGIN_PATH,
    payload={"password": _SENTINEL_PASSWORD},
    sent_secrets=(_SENTINEL_PASSWORD,),
)
_SIGNUP_MISSING_EMAIL = _RejectedRequest(
    path=_SIGNUP_PATH,
    payload={"password": _SENTINEL_PASSWORD, "license_key": _SENTINEL_LICENSE_KEY},
    sent_secrets=(_SENTINEL_PASSWORD, _SENTINEL_LICENSE_KEY),
)

# The length-bound shapes: ``input`` is the single offending value, which on a
# password field is the plaintext itself.
_LOGIN_SHORT_PASSWORD = _RejectedRequest(
    path=_LOGIN_PATH,
    payload={"email": _PROBE_EMAIL, "password": _SENTINEL_SHORT_PASSWORD},
    sent_secrets=(_SENTINEL_SHORT_PASSWORD,),
)
_SIGNUP_LONG_PASSWORD = _RejectedRequest(
    path=_SIGNUP_PATH,
    payload={"email": _PROBE_EMAIL, "password": _SENTINEL_LONG_PASSWORD},
    sent_secrets=(_SENTINEL_LONG_PASSWORD,),
)

# Both fields violate their bound in one request, so the response carries two
# entries and therefore both secrets: the reset token is single-use but until
# it is spent it is a full account takeover on its own.
_RESET_CONFIRM_SHORT_BOTH = _RejectedRequest(
    path=_RESET_CONFIRM_PATH,
    payload={"token": _SENTINEL_RESET_TOKEN, "new_password": _SENTINEL_SHORT_PASSWORD},
    sent_secrets=(_SENTINEL_RESET_TOKEN, _SENTINEL_SHORT_PASSWORD),
)

# The cancel route accepts the same single-use token as confirm, so it is the
# same disclosure on the route nobody thinks to check.
_RESET_CANCEL_SHORT_TOKEN = _RejectedRequest(
    path=_RESET_CANCEL_PATH,
    payload={"token": _SENTINEL_RESET_TOKEN},
    sent_secrets=(_SENTINEL_RESET_TOKEN,),
)

# An OIDC assertion is bearer material until it expires: anyone holding it can
# present it to this same route and be signed in as its subject.
_GOOGLE_OVERLONG_ID_TOKEN = _RejectedRequest(
    path=_GOOGLE_OAUTH_PATH,
    payload={"id_token": _SENTINEL_ID_TOKEN},
    sent_secrets=(_SENTINEL_ID_TOKEN,),
)
# Apple via the ``missing`` shape instead, so the OAuth pair is covered from
# both directions and the whole-body echo is pinned on a route whose only
# required field is the credential.
_APPLE_MISSING_ID_TOKEN = _RejectedRequest(
    path=_APPLE_OAUTH_PATH,
    payload={"license_key": _SENTINEL_LICENSE_KEY, "full_name": "Echo Probe"},
    sent_secrets=(_SENTINEL_LICENSE_KEY,),
)

_ALL_CASES = (
    _LOGIN_MISSING_EMAIL,
    _SIGNUP_MISSING_EMAIL,
    _LOGIN_SHORT_PASSWORD,
    _SIGNUP_LONG_PASSWORD,
    _RESET_CONFIRM_SHORT_BOTH,
    _RESET_CANCEL_SHORT_TOKEN,
    _GOOGLE_OVERLONG_ID_TOKEN,
    _APPLE_MISSING_ID_TOKEN,
)

_CASE_IDS = (
    "login-missing-email",
    "signup-missing-email",
    "login-password-too-short",
    "signup-password-too-long",
    "reset-confirm-token-and-password",
    "reset-cancel-token-too-short",
    "google-id-token-too-long",
    "apple-missing-id-token",
)


async def _reject(client: AsyncClient, case: _RejectedRequest) -> Response:
    """POST ``case`` and assert it was rejected by the schema layer, not elsewhere.

    Guards the whole file against the silent-pass failure mode where a route
    is renamed and every "the secret is absent" assertion holds trivially
    because the response is a 404 that never saw the body.
    """
    resp = await client.post(case.path, json=dict(case.payload))
    assert resp.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT, (
        f"{case.path} answered {resp.status_code}, not a schema rejection; "
        f"the probe never reached validation. Body: {resp.text!r}"
    )
    return resp


def _detail_entries(resp: Response) -> list[dict[str, object]]:
    """Return the ``detail`` list, asserting the envelope shape on the way in."""
    body: object = resp.json()
    assert isinstance(body, dict), f"422 body was not a JSON object: {resp.text!r}"
    detail: object = body.get("detail")
    assert isinstance(detail, list), f"422 body has no 'detail' list: {resp.text!r}"
    entries: list[dict[str, object]] = []
    for entry in detail:
        assert isinstance(entry, dict), f"'detail' entry was not an object: {entry!r}"
        entries.append(entry)
    return entries


def _assert_no_secret_echoed(resp: Response, case: _RejectedRequest) -> None:
    """Assert none of the submitted secrets survives anywhere in the response text.

    Scanned against the raw text rather than a parsed field so a future
    handler cannot move the value into a message string, a header-adjacent
    envelope, or a nested ``ctx`` and still pass.
    """
    for sent in case.sent_secrets:
        assert sent not in resp.text, (
            f"{case.path} echoed a submitted secret back to the caller in its "
            f"422 body -- a client logging this response logs the credential. "
            f"Body: {resp.text!r}"
        )


@pytest.mark.asyncio
async def test_login_missing_email_does_not_echo_the_password(async_client: AsyncClient) -> None:
    """An omitted ``email`` must not make the whole login body the error payload.

    The ``missing`` shape is the nastiest of the two because ``password``
    is not what failed: it is disclosed purely for being in the same body
    as the field that did.
    """
    resp = await _reject(async_client, _LOGIN_MISSING_EMAIL)
    _assert_no_secret_echoed(resp, _LOGIN_MISSING_EMAIL)


@pytest.mark.asyncio
async def test_signup_missing_email_does_not_echo_password_or_license(
    async_client: AsyncClient,
) -> None:
    """Signup's whole-body echo also discloses the purchase license key.

    A license key is transferable value, not just an identifier, so it
    belongs in the same class as the password beside it.
    """
    resp = await _reject(async_client, _SIGNUP_MISSING_EMAIL)
    _assert_no_secret_echoed(resp, _SIGNUP_MISSING_EMAIL)


@pytest.mark.asyncio
async def test_login_password_below_minimum_is_not_echoed(async_client: AsyncClient) -> None:
    """A too-short login password is still the user's real password.

    Users type their actual credential and get length-rejected all the
    time -- most often when the field is one character short of the floor,
    which means the echoed value is a near-miss of a live secret.
    """
    resp = await _reject(async_client, _LOGIN_SHORT_PASSWORD)
    _assert_no_secret_echoed(resp, _LOGIN_SHORT_PASSWORD)


@pytest.mark.asyncio
async def test_signup_password_above_maximum_is_not_echoed(async_client: AsyncClient) -> None:
    """An over-long signup password is a passphrase the user intends to keep using.

    Pinned alongside the too-short case because the two bounds are separate
    Pydantic error types (``string_too_long`` / ``string_too_short``) and a
    handler that special-cased one of them would leave the other open.
    """
    resp = await _reject(async_client, _SIGNUP_LONG_PASSWORD)
    _assert_no_secret_echoed(resp, _SIGNUP_LONG_PASSWORD)


@pytest.mark.asyncio
async def test_password_reset_confirm_echoes_neither_token_nor_new_password(
    async_client: AsyncClient,
) -> None:
    """The reset token is as disclosing as the password it is being used to change.

    Until it is spent, the token authorises setting a new password on the
    account without knowing the old one -- so a response that echoes it
    converts a truncated-paste typo into a takeover primitive.
    """
    resp = await _reject(async_client, _RESET_CONFIRM_SHORT_BOTH)
    _assert_no_secret_echoed(resp, _RESET_CONFIRM_SHORT_BOTH)


@pytest.mark.asyncio
async def test_password_reset_cancel_does_not_echo_the_token(async_client: AsyncClient) -> None:
    """Cancel takes the same credential as confirm and must redact it too.

    Pinned separately because the two routes share a token but not a schema
    class, which is exactly the shape of gap a per-endpoint fix would leave
    open on the quieter of the pair.
    """
    resp = await _reject(async_client, _RESET_CANCEL_SHORT_TOKEN)
    _assert_no_secret_echoed(resp, _RESET_CANCEL_SHORT_TOKEN)


@pytest.mark.asyncio
async def test_google_oauth_does_not_echo_the_id_token(async_client: AsyncClient) -> None:
    """An over-long ``id_token`` must not come back in the rejection.

    The assertion is replayable for as long as it is valid: an echoed copy
    in a client log is a sign-in credential sitting in plaintext.
    """
    resp = await _reject(async_client, _GOOGLE_OVERLONG_ID_TOKEN)
    _assert_no_secret_echoed(resp, _GOOGLE_OVERLONG_ID_TOKEN)


@pytest.mark.asyncio
async def test_apple_oauth_missing_id_token_does_not_echo_the_body(
    async_client: AsyncClient,
) -> None:
    """Omitting the credential still echoes everything sent beside it.

    Covers the OAuth pair from the ``missing`` direction, where no field
    bound is consulted and the disclosure comes entirely from FastAPI's
    default handler rather than from any constraint the router declared.
    """
    resp = await _reject(async_client, _APPLE_MISSING_ID_TOKEN)
    _assert_no_secret_echoed(resp, _APPLE_MISSING_ID_TOKEN)


@pytest.mark.asyncio
@pytest.mark.parametrize("case", _ALL_CASES, ids=_CASE_IDS)
async def test_no_rejection_entry_carries_input_or_ctx(
    async_client: AsyncClient, case: _RejectedRequest
) -> None:
    """No entry in any 422 ``detail`` may carry ``input`` or ``ctx``.

    The structural twin of the sentinel scans above: those prove no
    *known* secret came back, this proves the echo channel itself is
    closed, so a field nobody thought to add a sentinel for is covered
    too.  Neither key is declared anywhere in the generated OpenAPI
    schema, so dropping them moves the app towards its published
    contract rather than away from it.
    """
    resp = await _reject(async_client, case)
    for index, entry in enumerate(_detail_entries(resp)):
        for key in _FORBIDDEN_ENTRY_KEYS:
            assert key not in entry, (
                f"{case.path} detail[{index}] still carries {key!r}, which "
                f"reflects submitted material back to the caller: {entry!r}"
            )


@pytest.mark.asyncio
@pytest.mark.parametrize("case", _ALL_CASES, ids=_CASE_IDS)
async def test_rejection_keeps_its_detail_shape(
    async_client: AsyncClient, case: _RejectedRequest
) -> None:
    """Sanitising must not flatten the envelope clients already parse.

    The cheap way to stop echoing ``input`` is to replace the body with a
    bare string, which would break every caller that maps ``loc`` onto a
    form field.  Pinning the list shape and the three surviving keys is
    what makes the fix a redaction rather than a contract change.
    """
    resp = await _reject(async_client, case)
    entries = _detail_entries(resp)
    assert entries, f"{case.path} returned an empty 'detail' list: {resp.text!r}"
    for index, entry in enumerate(entries):
        for key in _REQUIRED_ENTRY_KEYS:
            assert entry.get(key), (
                f"{case.path} detail[{index}] lost its {key!r} value, so a "
                f"client cannot tell which field was rejected: {entry!r}"
            )
