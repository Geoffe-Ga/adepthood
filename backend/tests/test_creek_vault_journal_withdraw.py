"""HTTP contract tests for Creek's content-free journal withdrawal resource."""

from __future__ import annotations

from http import HTTPStatus

import httpx
import pytest

from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapabilityUnsupportedError,
    CreekVaultUnavailableError,
    VaultErrorCode,
    VaultJournalWithdrawResult,
)
from services.creek_vault_client import HttpCreekVaultClient

_VAULT_URL = "https://vault.example.test"
_VAULT_CREDENTIAL = "test-vault-credential"
_ENTRY_ID = 73


def _minor(version: str) -> str:
    """Return the major/minor pair used by the version request header."""
    return ".".join(version.split(".")[:2])


def _capabilities(*capabilities: str) -> dict[str, object]:
    """Build the published successful capability document for this client pin."""
    return {
        "vault": {"available": True},
        "capabilities": list(capabilities),
        "contract_version": CONTRACT_VERSION,
        "contract_minor": _minor(CONTRACT_VERSION),
        "supported_contract_minors": [_minor(CONTRACT_VERSION)],
        "ontology_version": "aptitude-wavelength/2026-05-23",
        "attestation": None,
    }


class _Handler:
    """Record both negotiation and journal withdrawal without opening a socket."""

    def __init__(
        self,
        reply: object,
        status: int = HTTPStatus.OK,
        *,
        capabilities: tuple[str, ...] = (
            "capabilities",
            "journal-upsert",
            "journal-withdraw",
        ),
    ) -> None:
        self.reply = reply
        self.status = status
        self.capabilities = capabilities
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.method == "GET":
            return httpx.Response(
                HTTPStatus.OK,
                json=_capabilities(*self.capabilities),
            )
        return httpx.Response(self.status, json=self.reply)


async def _client(handler: _Handler) -> HttpCreekVaultClient:
    """Return a handshaken client backed by ``handler``."""
    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = HttpCreekVaultClient(_VAULT_URL, _VAULT_CREDENTIAL, http_client=http)
    result = await client.handshake()
    assert result.available is True
    return client


@pytest.mark.asyncio
async def test_withdraw_uses_stable_id_and_sends_no_body() -> None:
    """The destructive inverse is one authenticated, bounded, body-free DELETE."""
    handler = _Handler({"status": "ok", "tier_ceiling": "personal", "action": "withdrawn"})
    client = await _client(handler)

    result = await client.withdraw_journal_entry(_ENTRY_ID)

    assert result == VaultJournalWithdrawResult(withdrawn=True)
    request = handler.requests[-1]
    assert request.method == "DELETE"
    assert str(request.url) == f"{_VAULT_URL}/v1/journal-entries/{_ENTRY_ID}"
    assert request.content == b""
    assert request.headers["Authorization"] == f"Bearer {_VAULT_CREDENTIAL}"
    assert request.headers["X-Creek-Tier-Ceiling"] == "personal"
    assert request.headers["X-Creek-Contract-Version"] == _minor(CONTRACT_VERSION)


@pytest.mark.asyncio
async def test_withdraw_refuses_locally_when_capability_was_not_negotiated() -> None:
    """An older vault sees no destructive request merely because its PUT route exists."""
    handler = _Handler(
        {"status": "ok", "tier_ceiling": "personal", "action": "withdrawn"},
        capabilities=("capabilities", "journal-upsert"),
    )
    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = HttpCreekVaultClient(_VAULT_URL, _VAULT_CREDENTIAL, http_client=http)
    await client.handshake()
    requests_before = list(handler.requests)

    with pytest.raises(CreekCapabilityUnsupportedError):
        await client.withdraw_journal_entry(_ENTRY_ID)

    assert handler.requests == requests_before


@pytest.mark.asyncio
async def test_withdraw_rejects_an_unconfirmed_success_shape() -> None:
    """A 200 missing any bounded confirmation is not absence the app may claim."""
    handler = _Handler({"status": "ok", "tier_ceiling": "personal"})
    client = await _client(handler)

    result = await client.withdraw_journal_entry(_ENTRY_ID)

    assert result == VaultJournalWithdrawResult(withdrawn=False)


@pytest.mark.asyncio
async def test_withdraw_preserves_retryable_503_as_unavailable() -> None:
    """Creek's partial-cleanup response stays retryable at the Adepthood seam."""
    handler = _Handler(
        {"code": VaultErrorCode.TEMPORARILY_UNAVAILABLE.value, "message": "retry"},
        HTTPStatus.SERVICE_UNAVAILABLE,
    )
    client = await _client(handler)

    with pytest.raises(CreekVaultUnavailableError) as raised:
        await client.withdraw_journal_entry(_ENTRY_ID)

    assert raised.value.code is VaultErrorCode.TEMPORARILY_UNAVAILABLE
