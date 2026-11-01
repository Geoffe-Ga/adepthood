"""``GET /users/me/export/vault`` — what a managed vault holds of yours, handed back (#3579).

On a managed vault the vault holds the only copy of every imported document
(#3016) and the writer cannot reach it except through adepthood (ADR 0009), so
"Export my data" owes them its contents. These tests drive the real route, the
real owner-safe vault resolver and the real HTTP adapter against a
``MockTransport`` vault speaking the vendored 0.27 contract, and pin the
promise end to end:

* a synthetic canary document stored only in the vault comes back, byte for
  byte, across more than one page, and an Intimate fragment comes back with it;
* a vault that cannot be reached, answers ``503``, or predates 0.27 is *said*,
  never exported as an empty file;
* a failure after the first page ends the file marked incomplete, never
  complete, and so does every bound the export stops at;
* nothing adepthood logs carries the content or a document's name.

The cross-tenant half lives in ``tests/security/test_idor.py``.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
from collections.abc import Callable
from datetime import UTC, datetime
from http import HTTPStatus
from pathlib import Path
from typing import Any, Final

import httpx
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from services import vault_export
from services.creek_vault_client import HttpCreekVaultClient
from tests.helpers import oauth as oauth_flow

_ROUTE: Final = "/users/me/export/vault"
_FIXTURES: Final = Path(__file__).parent / "fixtures"
_CAPABILITIES_027: Final = _FIXTURES / "creek_export_v027" / "examples" / "capabilities"
_CAPABILITIES_022: Final = _FIXTURES / "creek_v1" / "examples" / "capabilities"
_CONTRACT_HEADER: Final = "X-Creek-Contract-Version"

# Synthetic content that exists only in the fake vault. Nothing in adepthood's
# own database ever holds either string, so finding one in the export proves
# the export reached into the vault for it.
_CANARY_BYTES: Final = b"synthetic canary document 7f3c held only in the vault\n"
_CANARY_DOCUMENT_ID: Final = "adepthood-upload-7f3c0d1e2b4a59687788990011aabbcc.txt"
_CANARY_FRAGMENT_ID: Final = "frag-canary-7f3c"
_CANARY_MARKDOWN: Final = (
    "---\ntype: fragment\nid: frag-canary-7f3c\nprivacy_tier: intimate\n---\n"
    "synthetic intimate canary 7f3c\n"
)
_SECOND_PAGE: Final = "f-" + "b" * 64

_LOG_EVENT: Final = "vault_data_exported"
_QUIETED_CLIENT_LOGGERS: Final = frozenset({"httpx"})

Answer = Callable[[httpx.Request], httpx.Response]


def _capabilities(directory: Path) -> dict[str, Any]:
    """One vendored capability document."""
    loaded: dict[str, Any] = json.loads((directory / "success.json").read_bytes())
    return loaded


def _document(
    content: bytes = _CANARY_BYTES, document_id: str = _CANARY_DOCUMENT_ID
) -> dict[str, Any]:
    """A staged document carrying ``content``, as Creek sends one."""
    return {
        "document_id": document_id,
        "size_bytes": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
        "content_base64": base64.b64encode(content).decode("ascii"),
        "content_included": True,
    }


def _fragment(**changes: object) -> dict[str, Any]:
    """The intimate canary fragment, ingested from the canary document."""
    return {
        "fragment_id": _CANARY_FRAGMENT_ID,
        "tier": "intimate",
        "frequency": "F7",
        "phase": "rising",
        "source_platform": "document",
        "document_id": _CANARY_DOCUMENT_ID,
        "markdown": _CANARY_MARKDOWN,
        "content_included": True,
        **changes,
    }


def _page(**fields: object) -> dict[str, Any]:
    """One ``ExportResponse`` page; an empty last page unless told otherwise."""
    return {
        "status": "ok",
        "documents": [],
        "fragments": [],
        "skipped": 0,
        "next_cursor": None,
        **fields,
    }


def _ok(body: object) -> Answer:
    """An answer of ``body`` at 200."""
    return lambda _request: httpx.Response(HTTPStatus.OK, json=body)


def _status(status: int, code: str) -> Answer:
    """A published error envelope at ``status``."""
    body = {"code": code, "message": "synthetic", "request_id": "req-synthetic"}
    return lambda _request: httpx.Response(status, json=body)


def _unreachable(request: httpx.Request) -> httpx.Response:
    """An autostopped vault the edge could not wake."""
    raise httpx.ConnectError("synthetic unreachable vault", request=request)


# The two pages the canary export reads: the document first, then the fragment.
_TWO_PAGES: Final[dict[str | None, Answer]] = {
    None: _ok(_page(documents=[_document()], next_cursor=_SECOND_PAGE)),
    _SECOND_PAGE: _ok(_page(fragments=[_fragment()])),
}


class _Vault:
    """A managed vault: a handshake, and one answer per export cursor."""

    def __init__(
        self,
        pages: dict[str | None, Answer],
        capabilities: dict[str, Any] | None = None,
        handshake: Answer | None = None,
    ) -> None:
        """Answer ``pages`` by cursor, after ``capabilities`` (0.27 by default)."""
        self.pages = pages
        document = capabilities if capabilities is not None else _capabilities(_CAPABILITIES_027)
        self.handshake = handshake or _ok(document)
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Record the request and answer it."""
        self.requests.append(request)
        if request.url.path.endswith("/capabilities"):
            return self.handshake(request)
        return self.pages[request.url.params.get("cursor")](request)

    def exports(self) -> list[httpx.Request]:
        """Every request that reached the export route."""
        return [request for request in self.requests if request.url.path.endswith("/export")]


def _install(monkeypatch: pytest.MonkeyPatch, vault: _Vault) -> None:
    """Make every stored vault this test resolves dial ``vault``."""

    def _build(url: str, api_key: str, *, managed: bool) -> HttpCreekVaultClient:
        return HttpCreekVaultClient(
            url,
            api_key,
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(vault)),
            managed=managed,
        )

    async def _dialable(_session: AsyncSession, _vault_url: str) -> bool:
        return False

    monkeypatch.setattr("services.creek_vault_stored_client.build_connected_vault_client", _build)
    monkeypatch.setattr("services.creek_vault_stored_client.stored_host_is_undialable", _dialable)


async def _managed_writer(
    async_client: AsyncClient, db_session: AsyncSession, name: str
) -> dict[str, str]:
    """A signed-up account with a ready managed vault; its auth headers."""
    headers, user_id = await oauth_flow.signup(async_client, name)
    await oauth_flow.connect_managed_vault(db_session, user_id, name)
    return headers


async def _export(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    vault: _Vault,
    name: str,
) -> httpx.Response:
    """Export ``name``'s vault, which is ``vault``."""
    headers = await _managed_writer(async_client, db_session, name)
    _install(monkeypatch, vault)
    return await async_client.get(_ROUTE, headers=headers)


def _items(body: dict[str, Any], kind: str) -> list[dict[str, Any]]:
    """Every exported item of one ``kind``, in file order."""
    return [item for item in body["items"] if item["kind"] == kind]


@pytest.mark.asyncio
async def test_a_canary_held_only_in_the_vault_comes_back_across_two_pages(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The document's original bytes and its Intimate fragment are both in the file."""
    vault = _Vault(_TWO_PAGES)
    response = await _export(async_client, db_session, monkeypatch, vault, "canary_writer")

    assert response.status_code == HTTPStatus.OK
    assert response.headers["content-type"].startswith("application/json")
    stamp = datetime.now(UTC).date().isoformat()
    assert response.headers["content-disposition"] == (
        f'attachment; filename="adepthood-vault-{stamp}.json"'
    )
    body = response.json()
    assert body["format"] == "adepthood-vault-export"
    assert body["complete"] is True
    assert body["incomplete_reason"] is None
    (document,) = _items(body, "document")
    assert document["document_id"] == _CANARY_DOCUMENT_ID
    assert base64.b64decode(document["content_base64"]) == _CANARY_BYTES
    assert document["sha256"] == hashlib.sha256(_CANARY_BYTES).hexdigest()
    (fragment,) = _items(body, "fragment")
    assert fragment["tier"] == "intimate"
    assert fragment["markdown"] == _CANARY_MARKDOWN
    assert fragment["document_id"] == _CANARY_DOCUMENT_ID

    first, second = vault.exports()
    assert "cursor" not in first.url.params
    assert second.url.params["cursor"] == _SECOND_PAGE
    assert {request.headers[_CONTRACT_HEADER] for request in (first, second)} == {"0.27"}


@pytest.mark.asyncio
async def test_the_canary_is_not_in_adepthoods_own_archive(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The main archive never dials the vault, so the canary can only come from the vault."""
    vault = _Vault(_TWO_PAGES)
    headers = await _managed_writer(async_client, db_session, "canary_archive")
    _install(monkeypatch, vault)

    archive = await async_client.get("/users/me/export", headers=headers)

    assert archive.status_code == HTTPStatus.OK
    assert "7f3c" not in archive.text
    assert vault.requests == []
    reason = archive.json()["not_included"]["uservaultconfig"]
    assert "exported from the vault" not in reason
    assert _ROUTE in reason


@pytest.mark.asyncio
async def test_a_vault_without_the_0_27_export_is_told_it_needs_an_update(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An older image is never asked, and the answer says why there is no file."""
    vault = _Vault(_TWO_PAGES, capabilities=_capabilities(_CAPABILITIES_022))
    response = await _export(async_client, db_session, monkeypatch, vault, "older_vault")

    assert response.status_code == HTTPStatus.CONFLICT
    assert response.json() == {"detail": "vault_export_needs_update"}
    assert vault.exports() == []


@pytest.mark.asyncio
async def test_a_vault_answering_503_is_unavailable_not_an_empty_export(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Creek's ``503 unavailable`` is reported as such, never as a file with nothing in it."""
    vault = _Vault({None: _status(HTTPStatus.SERVICE_UNAVAILABLE, "unavailable")})
    response = await _export(async_client, db_session, monkeypatch, vault, "asleep_vault")

    assert response.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert response.json() == {"detail": "vault_unavailable"}


@pytest.mark.asyncio
async def test_an_autostopped_vault_that_cannot_be_reached_is_unavailable(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A handshake that cannot land is the same explicit ``vault_unavailable``."""
    vault = _Vault(_TWO_PAGES, handshake=_unreachable)
    response = await _export(async_client, db_session, monkeypatch, vault, "stopped_vault")

    assert response.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert response.json() == {"detail": "vault_unavailable"}
    assert vault.exports() == []


@pytest.mark.asyncio
async def test_a_vault_refusing_the_export_is_a_failed_export(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``privacy_refused`` (adepthood is not the sole consumer) is a failure, said plainly."""
    vault = _Vault({None: _status(HTTPStatus.FORBIDDEN, "privacy_refused")})
    response = await _export(async_client, db_session, monkeypatch, vault, "refusing_vault")

    assert response.status_code == HTTPStatus.BAD_GATEWAY
    assert response.json() == {"detail": "vault_export_failed"}


@pytest.mark.asyncio
async def test_an_account_with_no_vault_is_told_so(async_client: AsyncClient) -> None:
    """No vault, no export of one: a 404 that names the reason, and nothing dialled."""
    headers, _user_id = await oauth_flow.signup(async_client, "no_vault_writer")
    response = await async_client.get(_ROUTE, headers=headers)

    assert response.status_code == HTTPStatus.NOT_FOUND
    assert response.json() == {"detail": "vault_not_connected"}


@pytest.mark.asyncio
async def test_the_route_requires_a_caller(async_client: AsyncClient) -> None:
    """There is no anonymous export of anybody's vault."""
    response = await async_client.get(_ROUTE)
    assert response.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case",
    [
        (_status(HTTPStatus.SERVICE_UNAVAILABLE, "unavailable"), "vault_unavailable"),
        (_unreachable, "vault_unavailable"),
        (_ok(_page(documents=[_document() | {"size_bytes": 1}])), "vault_failed"),
        (_status(HTTPStatus.FORBIDDEN, "privacy_refused"), "vault_failed"),
    ],
    ids=["503", "dropped", "corrupted", "refused"],
)
async def test_a_failure_after_the_first_page_ends_the_file_incomplete(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    case: tuple[Answer, str],
) -> None:
    """What was read is kept, and the file says it stopped -- never that it finished."""
    failure, reason = case
    pages = {
        None: _ok(_page(documents=[_document()], next_cursor=_SECOND_PAGE)),
        _SECOND_PAGE: failure,
    }
    with caplog.at_level(logging.INFO):
        response = await _export(
            async_client, db_session, monkeypatch, _Vault(pages), f"midway_{reason}"
        )

    assert response.status_code == HTTPStatus.OK
    body = response.json()
    assert body["complete"] is False
    assert body["incomplete_reason"] == reason
    assert len(_items(body, "document")) == 1
    (event,) = [record for record in caplog.records if record.getMessage() == _LOG_EVENT]
    assert event.__dict__["complete"] is False
    assert event.__dict__["incomplete_reason"] == reason


@pytest.mark.asyncio
async def test_the_export_stops_at_its_page_bound_and_says_so(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A vault longer than the bound is cut off, and the file is marked incomplete."""
    monkeypatch.setattr(vault_export, "VAULT_EXPORT_MAX_PAGES", 1)
    vault = _Vault(_TWO_PAGES)
    response = await _export(async_client, db_session, monkeypatch, vault, "long_vault")

    body = response.json()
    assert body["complete"] is False
    assert body["incomplete_reason"] == "export_too_large"
    assert len(vault.exports()) == 1


@pytest.mark.asyncio
async def test_the_export_stops_at_its_byte_bound_and_says_so(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The total received is bounded too, not only the number of pages."""
    monkeypatch.setattr(vault_export, "VAULT_EXPORT_MAX_BYTES", 1)
    vault = _Vault(_TWO_PAGES)
    response = await _export(async_client, db_session, monkeypatch, vault, "heavy_vault")

    body = response.json()
    assert body["complete"] is False
    assert body["incomplete_reason"] == "export_too_large"
    assert len(vault.exports()) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "page",
    [
        _page(
            fragments=[_fragment(markdown=None, content_included=False)],
        ),
        _page(skipped=2),
    ],
    ids=["withheld", "skipped"],
)
async def test_content_the_vault_could_not_include_marks_the_file_incomplete(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    page: dict[str, Any],
) -> None:
    """Every page was read, but something is missing from the file, and it says so."""
    vault = _Vault({None: _ok(page)})
    response = await _export(async_client, db_session, monkeypatch, vault, "partial_vault")

    body = response.json()
    assert body["complete"] is False
    assert body["incomplete_reason"] == "content_not_included"
    assert body["content_withheld"] + body["skipped"] > 0


@pytest.mark.asyncio
async def test_nothing_logged_carries_content_or_a_document_name(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """One count-only event; no canary, no document id, no fragment id, no cursor."""
    with caplog.at_level(logging.DEBUG):
        response = await _export(
            async_client, db_session, monkeypatch, _Vault(_TWO_PAGES), "quiet_vault"
        )
    assert response.status_code == HTTPStatus.OK

    # httpx's own request line is raised to WARNING in every deployment
    # (``observability._OUTBOUND_CLIENT_LOGGERS``), so it never reaches a host's
    # logs; everything the application itself emits is held to the rule.
    emitted = "\n".join(
        f"{record.getMessage()} {record.__dict__}"
        for record in caplog.records
        if record.name not in _QUIETED_CLIENT_LOGGERS
    )
    for secret in ("7f3c", _CANARY_DOCUMENT_ID, _CANARY_FRAGMENT_ID, _SECOND_PAGE):
        assert secret not in emitted
    (event,) = [record for record in caplog.records if record.getMessage() == _LOG_EVENT]
    assert event.__dict__["documents_exported"] == 1
    assert event.__dict__["fragments_exported"] == 1
    assert event.__dict__["pages_read"] == len(_TWO_PAGES)
    assert event.__dict__["complete"] is True
