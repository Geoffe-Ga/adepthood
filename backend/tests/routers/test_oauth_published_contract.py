"""What the OAuth endpoints send, judged by the document they publish (#3532, #3533).

The direct regression for two findings the live contract fuzz raised against
this router at seed 1337:

* ``POST /oauth/register`` handed a body that is not JSON at all answers with
  the framework's own ``{"detail": "There was an error parsing the body"}``,
  while its 400 declared only the RFC 7591 ``{"error": ...}`` shape;
* ``POST /oauth/authorize/sign-in`` past its five-a-minute budget answers with
  the limiter's JSON ``{"detail": "rate_limit_exceeded"}``, while every status
  on the consent-page operations was published as ``text/html``.

Both bodies are the right thing to send; the document was wrong about them. The
requests here are real and the schema is resolved out of each operation's own
``responses`` block, which is all a contract fuzzer does.
"""

from __future__ import annotations

from collections.abc import Iterator
from http import HTTPStatus
from typing import Any, Final

import pytest
from httpx import AsyncClient

from services import oauth_signing_keys
from services.journal_encryption import PRODUCTION_SIGNAL_ENV_VARS
from services.oauth_authorization import OAUTH_ISSUER_ENV_VAR
from services.oauth_signing_keys import SIGNING_KEYS_ENV_VAR
from tests.helpers.oauth import ISSUER, authorize_params, register_agent
from tests.helpers.openapi_errors import (
    JSON_MEDIA_TYPE,
    declared_response_schema,
    live_document,
    operation,
    response_validator,
)

_HTML_MEDIA_TYPE: Final = "text/html"
_REGISTER: Final = "/oauth/register"
_SIGN_IN: Final = "/oauth/authorize/sign-in"

# The consent-page operations, each with the statuses it renders a page for.
# Every other status these operations publish comes from a mechanism that is
# not the page -- the limiter, the framework's validation, the shared refusal
# contract -- and is JSON.
_PAGE_STATUSES: Final[dict[tuple[str, str], frozenset[str]]] = {
    ("get", "/oauth/authorize"): frozenset({"200", "400", "503"}),
    ("post", _SIGN_IN): frozenset({"200", "400", "401", "503"}),
    ("post", "/oauth/authorize/decision"): frozenset({"200", "400", "503"}),
}

# The statuses a page operation publishes that carry no body at all.
_BODILESS_STATUSES: Final = frozenset({"303"})

# The sign-in form's budget per address and minute (``SIGN_IN_RATE_LIMIT``).
_SIGN_IN_BUDGET: Final = 5

# A password nobody holds, guessed until the form's budget runs out.
_GUESSED_PASSWORD: Final = "guessing-123"  # pragma: allowlist secret


@pytest.fixture(autouse=True)
def _issuer(monkeypatch: pytest.MonkeyPatch) -> None:
    """Every test runs against one configured issuer."""
    monkeypatch.setenv(OAUTH_ISSUER_ENV_VAR, ISSUER)


def _media_type(content_type: str) -> str:
    """A ``Content-Type`` header without its parameters."""
    return content_type.split(";", 1)[0].strip()


def _validate(method: str, path: str, status_code: int, body: object) -> None:
    """Check ``body`` against the JSON schema this operation declares for the status."""
    document = live_document()
    schema = declared_response_schema(document, method, path, status_code)
    response_validator(document, schema).validate(body)


@pytest.mark.asyncio
async def test_an_unparseable_registration_body_matches_its_declared_400(
    async_client: AsyncClient,
) -> None:
    """A body that is not JSON is refused by the framework, in a documented shape."""
    response = await async_client.post(
        _REGISTER, content=b"\xff", headers={"Content-Type": JSON_MEDIA_TYPE}
    )
    assert response.status_code == HTTPStatus.BAD_REQUEST
    assert response.json() == {"detail": "There was an error parsing the body"}
    _validate("post", _REGISTER, HTTPStatus.BAD_REQUEST, response.json())


@pytest.mark.asyncio
async def test_an_rfc_registration_refusal_still_matches_its_declared_400(
    async_client: AsyncClient,
) -> None:
    """Widening the 400 must keep admitting the RFC 7591 error it was written for."""
    response = await async_client.post(
        _REGISTER, json={"client_name": "Unregistered", "redirect_uris": ["http://evil.example/cb"]}
    )
    assert response.status_code == HTTPStatus.BAD_REQUEST
    assert response.json()["error"] == "invalid_redirect_uri"
    _validate("post", _REGISTER, HTTPStatus.BAD_REQUEST, response.json())


@pytest.mark.asyncio
async def test_a_throttled_sign_in_is_declared_as_the_json_it_sends(
    async_client: AsyncClient,
) -> None:
    """The limiter's 429 on the consent page is JSON, and the page's document says so."""
    client_id = await register_agent(async_client)
    form = {
        **authorize_params(client_id, "https://v.example/mcp"),
        "email": "who@example.com",
        "password": _GUESSED_PASSWORD,
    }
    for _ in range(_SIGN_IN_BUDGET):
        await async_client.post(_SIGN_IN, data=form)
    response = await async_client.post(_SIGN_IN, data=form)
    assert response.status_code == HTTPStatus.TOO_MANY_REQUESTS
    assert _media_type(response.headers["content-type"]) == JSON_MEDIA_TYPE
    assert response.json() == {"detail": "rate_limit_exceeded"}
    _validate("post", _SIGN_IN, HTTPStatus.TOO_MANY_REQUESTS, response.json())


def _declared_media_types(method: str, path: str) -> dict[str, frozenset[str]]:
    """Each status the operation publishes, with the media types it declares for it."""
    responses: dict[str, Any] = operation(live_document(), method, path)["responses"]
    return {
        code: frozenset(declaration.get("content", {})) for code, declaration in responses.items()
    }


@pytest.mark.parametrize(("method", "path"), list(_PAGE_STATUSES))
def test_a_consent_page_operation_declares_html_only_where_it_renders_a_page(
    method: str, path: str
) -> None:
    """HTML for the statuses a page answers with; JSON for every refusal the app sends."""
    page_statuses = _PAGE_STATUSES[method, path]
    declared = _declared_media_types(method, path)
    assert page_statuses <= set(declared)
    for code, media_types in declared.items():
        if code in _BODILESS_STATUSES:
            assert media_types == frozenset(), code
            continue
        assert (_HTML_MEDIA_TYPE in media_types) == (code in page_statuses), code
        if code != str(HTTPStatus.OK):
            assert JSON_MEDIA_TYPE in media_types, code


# --- the token endpoint and key set (#3533) -----------------------------------
#
# The contract fuzz (seed 1337) first met these operations on an instance with
# no OAUTH_SIGNING_KEYS and answered both with a 503 -- a server error, which
# the fuzz fails whatever the document declares. Off-platform and outside
# production an unset variable is now one process-local key, so the instance
# the fuzz starts serves the key set and judges the request on its merits.

_TOKEN: Final = "/oauth/token"
_JWKS: Final = "/.well-known/jwks.json"
_FORM: Final = {"Content-Type": "application/x-www-form-urlencoded"}


@pytest.fixture
def _unconfigured_laptop(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """No signing key and no sign of a hosted environment: what the fuzz job runs."""
    for name in PRODUCTION_SIGNAL_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.delenv(SIGNING_KEYS_ENV_VAR, raising=False)
    oauth_signing_keys.reset_cache()
    yield
    oauth_signing_keys.reset_cache()


@pytest.mark.asyncio
@pytest.mark.usefixtures("_unconfigured_laptop")
async def test_an_unconfigured_instance_serves_its_key_set_as_published(
    async_client: AsyncClient,
) -> None:
    """The fuzz's ``GET /.well-known/jwks.json``: a 200 key set, never a 503."""
    response = await async_client.get(_JWKS)
    assert response.status_code == HTTPStatus.OK
    assert len(response.json()["keys"]) == 1
    _validate("get", _JWKS, HTTPStatus.OK, response.json())


@pytest.mark.asyncio
@pytest.mark.usefixtures("_unconfigured_laptop")
@pytest.mark.parametrize(
    "body",
    [
        pytest.param(b"", id="empty-form"),
        pytest.param(b"grant_type=authorization_code&code=ac_x", id="partial-code-request"),
        pytest.param(b"grant_type=refresh_token&refresh_token=rt_x", id="unknown-refresh-token"),
        pytest.param(b"grant_type=%00", id="nul-grant-type"),
    ],
)
async def test_an_unconfigured_instance_judges_a_token_request_as_published(
    async_client: AsyncClient, body: bytes
) -> None:
    """The fuzz's ``POST /oauth/token``: the RFC 6749 400 its document declares."""
    response = await async_client.post(_TOKEN, content=body, headers=_FORM)
    assert response.status_code == HTTPStatus.BAD_REQUEST
    _validate("post", _TOKEN, HTTPStatus.BAD_REQUEST, response.json())


@pytest.mark.asyncio
async def test_a_hosted_instance_without_keys_refuses_as_published(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Where a key is required, its absence is the declared 503, naming nothing."""
    monkeypatch.delenv(SIGNING_KEYS_ENV_VAR, raising=False)
    monkeypatch.setenv("RAILWAY_ENVIRONMENT_NAME", "staging")
    oauth_signing_keys.reset_cache()
    try:
        for method, path in (("get", _JWKS), ("post", _TOKEN)):
            response = await async_client.request(method.upper(), path, headers=_FORM)
            assert response.status_code == HTTPStatus.SERVICE_UNAVAILABLE
            assert response.json() == {"detail": "oauth_signing_unconfigured"}
            _validate(method, path, HTTPStatus.SERVICE_UNAVAILABLE, response.json())
    finally:
        oauth_signing_keys.reset_cache()


# --- the registration response (#3543) ----------------------------------------
#
# OpenClaw registers through the MCP TypeScript SDK, whose client-information
# schema types every optional RFC 7591 field as "a string, or absent". A
# ``"logo_uri": null`` is neither, so the SDK refused the registration this
# server had just made and the sign-in stopped one step after it began. RFC
# 7591 section 3.2.1 says the same thing the SDK enforces: a field with no
# value is omitted. Both halves are checked -- the body that is sent, and the
# document that describes it -- because a body that omits the field while the
# document still requires it is a contract the fuzz would fail instead.

_REGISTRATION_MODEL: Final = "ClientRegistrationResponse"
_NULL_TYPE: Final = "null"
_OPTIONAL_METADATA: Final = frozenset({"logo_uri"})
_LOGO: Final = "https://openclaw.example/logo.png"


def _registration_body(**metadata: str) -> dict[str, object]:
    """A registration request OpenClaw would make, with any optional metadata added."""
    return {"client_name": "OpenClaw", "redirect_uris": ["http://localhost/callback"], **metadata}


def _null_paths(value: object, path: str = "$") -> list[str]:
    """Every location in a decoded JSON value that holds ``null``."""
    if value is None:
        return [path]
    if isinstance(value, dict):
        children = [(f"{path}.{key}", item) for key, item in value.items()]
    elif isinstance(value, list):
        children = [(f"{path}[{index}]", item) for index, item in enumerate(value)]
    else:
        return []
    return [found for child_path, item in children for found in _null_paths(item, child_path)]


def _admits_null(schema: object) -> bool:
    """Whether a JSON schema fragment, at any depth, names the ``null`` type."""
    if isinstance(schema, dict):
        declared = schema.get("type")
        if declared == _NULL_TYPE or (isinstance(declared, list) and _NULL_TYPE in declared):
            return True
        return any(_admits_null(item) for item in schema.values())
    if isinstance(schema, list):
        return any(_admits_null(item) for item in schema)
    return False


@pytest.mark.asyncio
async def test_a_registration_without_a_logo_omits_it_and_matches_its_declared_201(
    async_client: AsyncClient,
) -> None:
    """No optional field travels as ``null``; the body still satisfies the published 201."""
    response = await async_client.post(_REGISTER, json=_registration_body())
    assert response.status_code == HTTPStatus.CREATED, response.text
    body = response.json()
    assert _null_paths(body) == []
    assert not _OPTIONAL_METADATA & set(body)
    assert body["token_endpoint_auth_method"] == "none"
    _validate("post", _REGISTER, HTTPStatus.CREATED, body)


@pytest.mark.asyncio
async def test_a_registration_with_a_logo_returns_it_and_matches_its_declared_201(
    async_client: AsyncClient,
) -> None:
    """A field that has a value is still returned, as the string it was registered with."""
    response = await async_client.post(_REGISTER, json=_registration_body(logo_uri=_LOGO))
    assert response.status_code == HTTPStatus.CREATED, response.text
    body = response.json()
    assert body["logo_uri"] == _LOGO
    assert _null_paths(body) == []
    _validate("post", _REGISTER, HTTPStatus.CREATED, body)


def test_the_published_registration_response_is_optional_but_never_null() -> None:
    """The document says what is sent: optional metadata is a plain string, not required."""
    schema = live_document()["components"]["schemas"][_REGISTRATION_MODEL]
    assert not _admits_null(schema)
    assert not _OPTIONAL_METADATA & set(schema["required"])
    for name in _OPTIONAL_METADATA:
        assert schema["properties"][name]["type"] == "string", name
    assert "client_secret" not in schema["properties"]
