"""The reset email has to be openable by the browser that is the only client.

``_build_reset_email`` emits ``adepthood://reset-password?token=...`` and nothing
else. That scheme resolves only inside an installed native build, and no such
build exists -- the web app is the whole of what ships. So every reset email
that has ever been delivered to a real user carried a link their browser cannot
follow, and the endpoint answered 202 the whole time. Delivery working and the
user staying locked out are the same observation from outside.

These tests pin the fix from the wire: they drive the real endpoint and assert on
the body the sender actually received, because a renderer tested in isolation
proves nothing about what the handler passes it. Three properties travel
together and are asserted together:

* the body carries an ``https://`` link a browser can open;
* it still carries the custom-scheme link, so a future native build is not
  broken by the fix for web;
* the origin of the https link comes from deployment configuration and cannot
  be moved by anything in the request. The Host header is the obvious candidate
  for "where is this app", and it is chosen by whoever sent the request -- an
  attacker who can pick it picks where a password-reset link points, which
  turns the recovery flow into a credential-harvesting funnel.

The anti-enumeration contract is re-asserted here rather than left to the
existing suite because this change edits the hit path's rendering: any new way
for the hit path to fail differently from the miss path -- a raise on an unset
origin, an extra branch, a different body -- reopens account enumeration.
"""

from __future__ import annotations

import logging
import re
from typing import TYPE_CHECKING

import pytest

from models.user import User
from routers.auth import _hash_password
from services.email import ConsoleEmailSender

if TYPE_CHECKING:
    from httpx import AsyncClient
    from sqlalchemy.ext.asyncio import AsyncSession

    from services.email import RecordingEmailSender

pytestmark = pytest.mark.usefixtures("wire_email_sender")

_PASSWORD = "correct-horse-battery-staple"  # pragma: allowlist secret

# The origin the deployment configures its web front end at, and a second,
# obviously different one. Two values are what separates "reads configuration"
# from "hardcodes the production host" -- a single value passes either way.
WEB_BASE_URL_ENV_VAR = "APP_BASE_URL"
CONFIGURED_ORIGIN = "https://app.aptitude.guru"
ALTERNATE_ORIGIN = "https://staging.aptitude.guru"

# A host an attacker supplies. It is not a plausible typo: it is the value in a
# crafted request, and its appearance anywhere in the rendered body would mean
# the recipient's reset link points at the attacker's server.
HOSTILE_HOST = "attacker.invalid"

# The two actions the email offers, as the web app routes them. Both need the
# https treatment: a user who did not request the reset needs the "this wasn't
# me" link to work in the same browser as the other one.
RESET_PATH = "/reset-password?token="
CANCEL_PATH = "/cancel-reset?token="

# The custom-scheme links, which stay. Written as the prefix rather than as a
# full URL so the token can be recovered from either.
DEEP_LINK_SCHEME = "adepthood://"

# Number of plaintext token characters the console adapter leaves visible.
# Restated here rather than imported so a change to the module's redaction width
# has to be a deliberate edit in two places, not a silent widening in one.
TOKEN_LOG_PREFIX = 8

_TOKEN_PATTERN = re.compile(r"adepthood://reset-password\?token=([A-Za-z0-9_-]+)")


async def _create_user(db_session: AsyncSession, email: str) -> User:
    """Insert an active user who can request a reset."""
    user = User(
        email=email,
        password_hash=await _hash_password(_PASSWORD),
        is_active=True,
        deleted_at=None,
    )
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)
    return user


def _token_of(body: str) -> str:
    """Recover the plaintext token from a rendered body via the deep link.

    Parsed off the custom-scheme line specifically: that link is the one this
    change must not disturb, so reading the token through it means a test that
    asserts on the https link cannot accidentally be reading its own subject.
    """
    match = _TOKEN_PATTERN.search(body)
    assert match is not None, f"no reset deep link in rendered body: {body!r}"
    return match.group(1)


async def _request_reset(client: AsyncClient, email: str) -> tuple[int, str]:
    """POST a reset request and return the status and the raw response text."""
    response = await client.post("/auth/password-reset/request", json={"email": email})
    return response.status_code, response.text


@pytest.mark.asyncio
async def test_the_reset_email_carries_browser_followable_links(
    async_client: AsyncClient,
    db_session: AsyncSession,
    email_sender: RecordingEmailSender,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The delivered email must contain a link the only shipping client can open.

    This is the whole user-visible bug. A recipient on a laptop -- which is
    every recipient, because no native build exists -- sees a link their browser
    refuses, and there is nothing else in the message to try. Both actions the
    email offers need the treatment: "this wasn't me" is the one a user who did
    not request the reset will reach for, and it is no more openable than the
    other.
    """
    monkeypatch.setenv(WEB_BASE_URL_ENV_VAR, CONFIGURED_ORIGIN)
    await _create_user(db_session, "web-link@example.com")

    status_code, _ = await _request_reset(async_client, "web-link@example.com")

    assert status_code == 202
    body = email_sender.sent[-1].body
    token = _token_of(body)
    assert f"{CONFIGURED_ORIGIN}{RESET_PATH}{token}" in body
    assert f"{CONFIGURED_ORIGIN}{CANCEL_PATH}{token}" in body


@pytest.mark.asyncio
async def test_the_reset_email_keeps_the_native_deep_links(
    async_client: AsyncClient,
    db_session: AsyncSession,
    email_sender: RecordingEmailSender,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Adding the web link must not remove the one the native build will use.

    The custom scheme is what an installed app registers, and the linking config
    in the frontend already routes both of these paths. Replacing rather than
    adding would fix web by breaking the platform this flow was originally
    written for, and it would do so silently -- nothing in a build without a
    native client can notice.
    """
    monkeypatch.setenv(WEB_BASE_URL_ENV_VAR, CONFIGURED_ORIGIN)
    await _create_user(db_session, "deep-link@example.com")

    await _request_reset(async_client, "deep-link@example.com")

    body = email_sender.sent[-1].body
    token = _token_of(body)
    assert f"{DEEP_LINK_SCHEME}reset-password?token={token}" in body
    assert f"{DEEP_LINK_SCHEME}cancel-reset?token={token}" in body


@pytest.mark.asyncio
@pytest.mark.parametrize("origin", [CONFIGURED_ORIGIN, ALTERNATE_ORIGIN])
async def test_the_https_origin_comes_from_configuration(
    origin: str,
    async_client: AsyncClient,
    db_session: AsyncSession,
    email_sender: RecordingEmailSender,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two origins, because one would pass against a hardcoded production host.

    Staging and production are different deployments of the same code, and a
    staging reset link that lands on production sends the user somewhere the
    token does not exist. The variable is read per request, matching the other
    operator-tunable address in this module, so a deployment can be repointed
    without a code change.
    """
    monkeypatch.setenv(WEB_BASE_URL_ENV_VAR, origin)
    await _create_user(db_session, "origin@example.com")

    await _request_reset(async_client, "origin@example.com")

    body = email_sender.sent[-1].body
    assert f"{origin}{RESET_PATH}{_token_of(body)}" in body


@pytest.mark.asyncio
async def test_a_configured_origin_with_a_trailing_slash_does_not_double_it(
    async_client: AsyncClient,
    db_session: AsyncSession,
    email_sender: RecordingEmailSender,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A trailing slash is how half the world writes a base URL, and it must work.

    ``https://host//reset-password`` is a different path from
    ``https://host/reset-password``: some servers normalise it, some 404, and
    the ones that redirect drop the query string on the way. The failure lands
    on the user as a dead link, and on the operator as nothing at all -- so the
    value is normalised here rather than trusted to be typed one way.
    """
    monkeypatch.setenv(WEB_BASE_URL_ENV_VAR, f"{CONFIGURED_ORIGIN}/")
    await _create_user(db_session, "slash@example.com")

    await _request_reset(async_client, "slash@example.com")

    body = email_sender.sent[-1].body
    assert f"{CONFIGURED_ORIGIN}{RESET_PATH}{_token_of(body)}" in body
    assert f"{CONFIGURED_ORIGIN}/{RESET_PATH.lstrip('/')}" in body


@pytest.mark.asyncio
async def test_a_hostile_host_header_cannot_move_the_reset_link(
    async_client: AsyncClient,
    db_session: AsyncSession,
    email_sender: RecordingEmailSender,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The obvious way to build this link is the one that hands it to an attacker.

    ``request.url`` and ``request.base_url`` are assembled from the Host header,
    which the client sends. Anyone can POST a reset request for someone else's
    address with a Host of their choosing; if that header reaches the rendered
    link, the victim receives a real reset email pointing at the attacker's
    server, with a working token in the query string. The forwarding headers are
    sent alongside because a proxy-aware implementation reaches for those next.
    """
    monkeypatch.setenv(WEB_BASE_URL_ENV_VAR, CONFIGURED_ORIGIN)
    await _create_user(db_session, "host-header@example.com")

    response = await async_client.post(
        "/auth/password-reset/request",
        json={"email": "host-header@example.com"},
        headers={
            "Host": HOSTILE_HOST,
            "X-Forwarded-Host": HOSTILE_HOST,
            "X-Forwarded-Proto": "https",
        },
    )

    assert response.status_code == 202
    body = email_sender.sent[-1].body
    assert f"{CONFIGURED_ORIGIN}{RESET_PATH}{_token_of(body)}" in body
    assert HOSTILE_HOST not in body


@pytest.mark.asyncio
async def test_an_unknown_address_stays_indistinguishable_from_a_registered_one(
    async_client: AsyncClient,
    db_session: AsyncSession,
    email_sender: RecordingEmailSender,
    monkeypatch: pytest.MonkeyPatch,
    disable_rate_limit: None,  # noqa: ARG001 -- two requests in one test
) -> None:
    """The 202-always contract is what this change is most likely to break quietly.

    Rendering now depends on a configured value, which is a new way for the hit
    path to behave differently from the miss path. A raise, a different body, or
    a status that varies by whether the address exists turns the endpoint into
    an account-existence oracle -- and the leak is silent, because both arms
    still look like success to the user who typed their own address.
    """
    monkeypatch.setenv(WEB_BASE_URL_ENV_VAR, CONFIGURED_ORIGIN)
    await _create_user(db_session, "known@example.com")

    hit_status, hit_body = await _request_reset(async_client, "known@example.com")
    miss_status, miss_body = await _request_reset(async_client, "nobody@example.com")

    assert hit_status == miss_status == 202
    assert hit_body == miss_body
    assert [message.to for message in email_sender.sent] == ["known@example.com"]


@pytest.mark.asyncio
async def test_the_console_adapter_redacts_the_token_in_the_web_link_too(
    async_client: AsyncClient,
    db_session: AsyncSession,
    email_sender: RecordingEmailSender,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A second copy of the token in the body is a second chance to log it.

    Local development reads reset links out of the terminal, and the console
    adapter masks the token before it writes the body precisely so a screen
    share or a recorded demo cannot leak a working credential. Adding a link
    doubles the token's occurrences in that body; a redaction that only reached
    the first one would put a full token back into the log stream with nothing
    to announce it.
    """
    monkeypatch.setenv(WEB_BASE_URL_ENV_VAR, CONFIGURED_ORIGIN)
    await _create_user(db_session, "console@example.com")
    await _request_reset(async_client, "console@example.com")
    payload = email_sender.sent[-1]
    token = _token_of(payload.body)

    with caplog.at_level(logging.INFO):
        await ConsoleEmailSender().send(payload, redact_for_log=token)

    record = next(r for r in caplog.records if r.message == "email_console_send")
    logged = str(record.__dict__["body"])
    assert token not in logged
    assert f"{CONFIGURED_ORIGIN}{RESET_PATH}{token[:TOKEN_LOG_PREFIX]}..." in logged


@pytest.mark.asyncio
async def test_the_token_reaches_neither_the_response_nor_the_logs(
    async_client: AsyncClient,
    db_session: AsyncSession,
    email_sender: RecordingEmailSender,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The token is a bearer credential for the account; the email is its only home.

    The request path already audits the event and, on a delivery failure, logs a
    warning about it. Both of those lines are written from inside the handler
    that is holding the plaintext, so the rendering change is one careless
    ``extra`` away from putting a working reset credential into the application
    log -- where it is retained far longer than the token's own thirty minutes.
    """
    monkeypatch.setenv(WEB_BASE_URL_ENV_VAR, CONFIGURED_ORIGIN)
    await _create_user(db_session, "quiet@example.com")

    with caplog.at_level(logging.DEBUG):
        status_code, response_text = await _request_reset(async_client, "quiet@example.com")

    assert status_code == 202
    token = _token_of(email_sender.sent[-1].body)
    assert token not in response_text
    for record in caplog.records:
        assert token not in record.getMessage()
        assert token not in str(record.__dict__)
