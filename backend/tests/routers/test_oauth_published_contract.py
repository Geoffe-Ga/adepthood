"""What the OAuth endpoints send, judged by the document they publish (#3532).

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

from http import HTTPStatus
from typing import Any, Final

import pytest
from httpx import AsyncClient

from services.oauth_authorization import OAUTH_ISSUER_ENV_VAR
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
