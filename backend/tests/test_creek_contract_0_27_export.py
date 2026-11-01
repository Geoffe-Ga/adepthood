"""Creek contract 0.27's owner export, read without moving the 0.22 pin (#3579).

0.27 (Creek-Vault#2033) adds ``GET /v1/export?cursor=&limit=``: one bounded page
of the vault's own content -- each staged document as its original bytes, then
each fragment file verbatim with its tier -- served only to the vault's sole
configured consumer. Creek refuses any minor its ``supported_contract_minors``
does not list, so adepthood may call the route only on a vault that both
advertises ``export`` and lists 0.27; everything else keeps hearing 0.22.

These tests drive the real adapter against a ``MockTransport`` vault and pin:
the snapshot is the producer's; the read declares 0.27 and nothing else does;
a vault that does not offer it is never asked; the answer is parsed strictly
and checked for integrity, so a corrupted or off-schema page is a payload fault
rather than an export that silently differs from what the vault holds; and
every failure is classified the way every other ``/v1`` read's is.

Expectations are literals, never values read off the pin, for the reason
``tests/test_creek_contract_0_21.py`` gives.
"""

from __future__ import annotations

import base64
import copy
import hashlib
import json
from collections.abc import Callable
from http import HTTPStatus
from pathlib import Path
from typing import Any, Final

import httpx
import jsonschema
import pytest

from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
    CreekCapabilityUnsupportedError,
    CreekVaultContractError,
    CreekVaultPayloadError,
    CreekVaultUnavailableError,
    VaultErrorCode,
)
from domain.vault_export import (
    VAULT_EXPORT_MAX_LIMIT,
    VAULT_EXPORT_SINCE_MINOR,
    VaultExportPage,
    VaultExportTier,
)
from services import creek_vault_export_wire as wire
from services.creek_vault_client import (
    _CAPABILITY_BY_WIRE_NAME,
    HttpCreekVaultClient,
    LocalFallbackCreekVaultClient,
)
from services.creek_vault_telemetry import VaultCallTimedOutError

#: The reviewed Creek-Vault commit the snapshot was copied from (a git SHA, not a secret).
_PINNED_COMMIT: Final = "56c7d4b6537ece32344e64fc18ddbcb3848afd85"  # pragma: allowlist secret
_ROOT: Final = Path(__file__).parent / "fixtures" / "creek_export_v027"
_BASE: Final = Path(__file__).parent / "fixtures" / "creek_v1" / "examples"
_VAULT_URL: Final = "https://vault.example.test"
_API_KEY: Final = "contract-027-test-key"  # pragma: allowlist secret
_CONTRACT_HEADER: Final = "X-Creek-Contract-Version"
_EXPORT_PATH: Final = "/v1/export"

#: The minor the export read declares. A literal.
_EXPORT_MINOR: Final = "0.27"
#: The minor every other versioned call declares.
_PINNED_MINOR: Final = "0.22"
#: A well-formed cursor, as Creek mints them.
_CURSOR: Final = "d-" + "a" * 64


def _json(path: Path) -> dict[str, Any]:
    """Load one vendored JSON document."""
    loaded: dict[str, Any] = json.loads(path.read_bytes())
    return loaded


def _capabilities() -> dict[str, Any]:
    """The 0.27 capability document: ``export`` advertised and 0.27 listed."""
    return _json(_ROOT / "examples" / "capabilities" / "success.json")


def _success() -> dict[str, Any]:
    """The published one-document, one-fragment page."""
    return _json(_ROOT / "examples" / "export" / "success.json")


def _document(content: bytes, document_id: str = "adepthood-upload-0a1b.txt") -> dict[str, Any]:
    """A staged document carrying ``content``, with a correct digest and size."""
    return {
        "document_id": document_id,
        "size_bytes": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
        "content_base64": base64.b64encode(content).decode("ascii"),
        "content_included": True,
    }


def _page(**overrides: object) -> dict[str, Any]:
    """An empty page with ``overrides`` applied."""
    return {
        "status": "ok",
        "documents": [],
        "fragments": [],
        "skipped": 0,
        "next_cursor": None,
        **overrides,
    }


class _ExportVault:
    """A vault answering its handshake and the export read, recording each request."""

    def __init__(
        self,
        capabilities: dict[str, Any],
        answer: Callable[[httpx.Request], httpx.Response],
    ) -> None:
        """Serve ``capabilities``, and ``answer`` for anything else."""
        self.capabilities = capabilities
        self.answer = answer
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Record the request, then answer it."""
        self.requests.append(request)
        if request.url.path == "/v1/capabilities":
            return httpx.Response(HTTPStatus.OK, json=self.capabilities)
        return self.answer(request)

    def export_requests(self) -> list[httpx.Request]:
        """Every request that reached the export route."""
        return [request for request in self.requests if request.url.path == _EXPORT_PATH]


def _answering(
    body: object, status: int = HTTPStatus.OK
) -> Callable[[httpx.Request], httpx.Response]:
    """An export route that always answers ``body`` at ``status``."""

    def _answer(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=body)

    return _answer


async def _export(vault: _ExportVault, cursor: str | None = None) -> VaultExportPage:
    """Handshake, then read one export page through the real adapter."""
    async with httpx.AsyncClient(transport=httpx.MockTransport(vault)) as http:
        client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http, managed=True)
        await client.handshake()
        return await client.export_page(cursor)


def test_the_snapshot_is_pinned_to_the_producer_manifest_and_the_pin_stays_0_22() -> None:
    """Every copied byte matches Creek's manifest; the base pin does not move."""
    vendor = _json(_ROOT / "vendor.json")
    manifest = _json(_ROOT / "manifest.json")
    assert vendor["commit"] == _PINNED_COMMIT
    assert vendor["contract_version"] == manifest["contract_version"] == "0.27.0"
    assert CONTRACT_VERSION == "0.22.0"
    assert VAULT_EXPORT_SINCE_MINOR == _EXPORT_MINOR
    upstream = {entry["path"]: entry["sha256"] for entry in manifest["files"]}
    assert set(vendor["files"]) == {
        path.relative_to(_ROOT).as_posix()
        for path in _ROOT.rglob("*.json")
        if path.name != "vendor.json"
    }
    for name, digest in vendor["files"].items():
        assert hashlib.sha256((_ROOT / name).read_bytes()).hexdigest() == digest
        if name != "manifest.json":
            assert upstream[name] == digest


def test_the_capability_table_names_exactly_what_0_27_advertises() -> None:
    """``export`` is translated, and nothing 0.27 publishes is dropped at the parse."""
    assert set(_CAPABILITY_BY_WIRE_NAME) == set(_capabilities()["capabilities"])
    assert _CAPABILITY_BY_WIRE_NAME["export"] is CreekCapability.EXPORT


def test_the_wire_bounds_are_creeks_published_ones() -> None:
    """Tier vocabulary, page limit and cursor pattern are read off the schemas."""
    response = _json(_ROOT / "schemas" / "ExportResponse.schema.json")
    query = _json(_ROOT / "schemas" / "ExportQuery.schema.json")
    defs = response["$defs"]
    assert {tier.value for tier in VaultExportTier} == set(defs["ExportTier"]["enum"])
    assert query["properties"]["cursor"]["anyOf"][0]["pattern"] == wire.EXPORT_CURSOR_PATTERN
    assert response["properties"]["documents"]["maxItems"] == VAULT_EXPORT_MAX_LIMIT
    assert response["properties"]["fragments"]["maxItems"] == VAULT_EXPORT_MAX_LIMIT
    assert defs["ExportDocument"]["properties"]["document_id"]["pattern"] == (
        wire.EXPORT_DOCUMENT_ID_PATTERN
    )


def test_every_page_this_suite_serves_is_one_creek_publishes() -> None:
    """The bodies the fakes below answer validate against the 0.27 schema."""
    schema = _json(_ROOT / "schemas" / "ExportResponse.schema.json")
    jsonschema.validate(_success(), schema)
    jsonschema.validate(_page(documents=[_document(b"synthetic canary bytes")]), schema)
    jsonschema.validate(_page(next_cursor=_CURSOR), schema)


@pytest.mark.asyncio
async def test_the_published_page_is_read_and_only_the_export_declares_0_27() -> None:
    """The read declares 0.27 with the full page limit; the handshake stays unversioned."""
    vault = _ExportVault(_capabilities(), _answering(_success()))
    page = await _export(vault)
    (request,) = vault.export_requests()
    assert request.headers[_CONTRACT_HEADER] == _EXPORT_MINOR
    assert request.headers["authorization"] == f"Bearer {_API_KEY}"
    assert request.url.params["limit"] == "200"
    assert "cursor" not in request.url.params
    assert vault.requests[0].headers.get(_CONTRACT_HEADER) is None
    assert page.next_cursor == _success()["next_cursor"]
    (document,) = page.documents
    assert document.document_id == "adepthood-doc-example-0a1b2c3d4e5f.txt"
    assert base64.b64decode(document.content_base64 or "") == b"synthetic doc\n"
    (fragment,) = page.fragments
    assert fragment.tier is VaultExportTier.PERSONAL
    assert fragment.frequency == "F3"
    assert fragment.markdown is not None
    assert page.answer_bytes > 0


@pytest.mark.asyncio
async def test_a_cursor_is_carried_to_the_vault_verbatim() -> None:
    """The next page is asked for from where the last one stopped."""
    vault = _ExportVault(_capabilities(), _answering(_page()))
    await _export(vault, _CURSOR)
    (request,) = vault.export_requests()
    assert request.url.params["cursor"] == _CURSOR


@pytest.mark.asyncio
async def test_a_malformed_cursor_is_refused_before_any_request() -> None:
    """A cursor Creek would refuse is a caller bug here, not an invalid_request there."""
    vault = _ExportVault(_capabilities(), _answering(_page()))
    with pytest.raises(ValueError, match="cursor"):
        await _export(vault, "../../etc/passwd")
    assert vault.export_requests() == []


@pytest.mark.asyncio
async def test_intimate_fragments_cross_to_the_owner() -> None:
    """The owner's export is the one read that carries every tier, intimate included."""
    fragment = copy.deepcopy(_success()["fragments"][0])
    fragment["tier"] = "intimate"
    vault = _ExportVault(_capabilities(), _answering(_page(fragments=[fragment])))
    page = await _export(vault)
    assert page.fragments[0].tier is VaultExportTier.INTIMATE


@pytest.mark.asyncio
async def test_a_vault_that_does_not_advertise_export_is_never_asked() -> None:
    """An older image's handshake carries no ``export``: refused locally, no request."""
    capabilities = _json(_BASE / "capabilities" / "success.json")
    assert "export" not in capabilities["capabilities"]
    vault = _ExportVault(capabilities, _answering(_success()))
    with pytest.raises(CreekCapabilityUnsupportedError):
        await _export(vault)
    assert vault.export_requests() == []


@pytest.mark.asyncio
async def test_advertising_export_without_listing_0_27_is_not_enough() -> None:
    """Creek would 409 a minor it does not list, so the read is not attempted."""
    capabilities = _capabilities()
    capabilities["supported_contract_minors"] = [
        minor for minor in capabilities["supported_contract_minors"] if minor != _EXPORT_MINOR
    ]
    vault = _ExportVault(capabilities, _answering(_success()))
    with pytest.raises(CreekCapabilityUnsupportedError):
        await _export(vault)
    assert vault.export_requests() == []


def _with_document(**changes: object) -> dict[str, Any]:
    """A one-document page whose document has ``changes`` applied."""
    return _page(documents=[_document(b"synthetic canary bytes") | changes])


def _with_fragment(**changes: object) -> dict[str, Any]:
    """A one-fragment page whose fragment has ``changes`` applied."""
    return _page(fragments=[_success()["fragments"][0] | changes])


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [
        _page(extra="field"),
        _page(status="partial"),
        _page(skipped=-1),
        _page(next_cursor="not-a-cursor"),
        _with_document(sha256=hashlib.sha256(b"other bytes").hexdigest()),
        _with_document(size_bytes=1),
        _with_document(content_base64="not base64!"),
        _with_document(content_base64=None),
        _with_document(content_included=False),
        _with_document(document_id="../escape"),
        _with_document(colour="blue"),
        _with_fragment(markdown=None),
        _with_fragment(content_included=False),
        _with_fragment(tier="secret"),
        [],
    ],
    ids=[
        "extra-envelope-field",
        "wrong-status",
        "negative-skipped",
        "malformed-cursor",
        "digest-mismatch",
        "size-mismatch",
        "bad-base64",
        "included-without-content",
        "content-without-included",
        "unsafe-document-id",
        "extra-document-field",
        "fragment-included-without-markdown",
        "fragment-markdown-without-included",
        "unknown-tier",
        "not-an-object",
    ],
)
async def test_an_off_schema_or_corrupted_page_is_a_payload_fault(body: object) -> None:
    """Strict and checked: an export never silently differs from what the vault holds."""
    vault = _ExportVault(_capabilities(), _answering(body))
    with pytest.raises(CreekVaultPayloadError):
        await _export(vault)


@pytest.mark.asyncio
async def test_a_withheld_item_carries_no_content_and_is_read() -> None:
    """An item past the page budget is listed with null content, and that is well-formed."""
    withheld = {
        "document_id": "adepthood-upload-big.pdf",
        "size_bytes": 11 * 1024 * 1024,
        "sha256": None,
        "content_base64": None,
        "content_included": False,
    }
    vault = _ExportVault(_capabilities(), _answering(_page(documents=[withheld])))
    page = await _export(vault)
    assert not page.documents[0].content_included
    assert page.documents[0].content_base64 is None


@pytest.mark.asyncio
async def test_an_answer_past_the_page_ceiling_is_a_payload_fault(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A page larger than any Creek can send is refused, not echoed into the export."""
    monkeypatch.setattr(wire, "EXPORT_ANSWER_MAX_BYTES", 64)
    vault = _ExportVault(_capabilities(), _answering(_success()))
    with pytest.raises(CreekVaultPayloadError):
        await _export(vault)


@pytest.mark.asyncio
async def test_the_published_unavailable_answer_is_an_unavailable_vault() -> None:
    """``503 unavailable`` is the vault saying it cannot answer, never an empty page."""
    body = _json(_ROOT / "examples" / "export" / "unavailable-service.json")
    vault = _ExportVault(_capabilities(), _answering(body, HTTPStatus.SERVICE_UNAVAILABLE))
    with pytest.raises(CreekVaultUnavailableError) as raised:
        await _export(vault)
    assert raised.value.code is VaultErrorCode.UNAVAILABLE


@pytest.mark.asyncio
async def test_the_published_refusal_is_a_coded_contract_error() -> None:
    """``403 privacy_refused`` (not the sole consumer) is a refusal, not a bad credential."""
    body = _json(_ROOT / "examples" / "export" / "refusal.json")
    vault = _ExportVault(_capabilities(), _answering(body, HTTPStatus.FORBIDDEN))
    with pytest.raises(CreekVaultContractError) as raised:
        await _export(vault)
    assert raised.value.code is VaultErrorCode.PRIVACY_REFUSED


@pytest.mark.asyncio
async def test_a_vault_that_times_out_is_a_timed_out_call() -> None:
    """A slow vault is told apart from an absent one."""

    def _slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("synthetic slow vault", request=request)

    vault = _ExportVault(_capabilities(), _slow)
    with pytest.raises(VaultCallTimedOutError):
        await _export(vault)


@pytest.mark.asyncio
async def test_a_vault_that_drops_the_connection_is_unavailable() -> None:
    """An autostopped vault the edge could not wake is unavailable."""

    def _gone(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("synthetic autostopped vault", request=request)

    vault = _ExportVault(_capabilities(), _gone)
    with pytest.raises(CreekVaultUnavailableError):
        await _export(vault)


@pytest.mark.asyncio
async def test_the_no_vault_client_supports_no_export() -> None:
    """The local fallback has no vault to export from, and says so by raising."""
    client = LocalFallbackCreekVaultClient()
    assert not client.supports(CreekCapability.EXPORT)
    with pytest.raises(CreekCapabilityUnsupportedError):
        await client.export_page(None)
