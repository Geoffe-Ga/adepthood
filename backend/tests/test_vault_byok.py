"""The writer's key on its way to a managed vault: its type, its parse and its decision (#3437)."""

from __future__ import annotations

import json
import pickle
from typing import TYPE_CHECKING, Final, cast

import pytest

from domain.creek_vault import (
    CONTRACT_VERSION,
    HandshakeResult,
    VaultKeyProvider,
    VaultProviderKey,
)
from scripts.creek_contract_drift import BUNDLE_ROOT
from services.creek_vault_client import _parse_handshake
from services.creek_vault_relay import parse_request_key_providers
from services.reflection_boundary import ReflectionBoundary
from services.vault_byok import key_vendor, relayable_key, vault_provider_key
from tests.provider_transport import ANTHROPIC_KEY, OPENAI_KEY

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from domain.creek_vault import CreekVaultClient

_SECRET: Final = "sk-ant-api03-REDACTIONcanary3437zz"  # pragma: allowlist secret


def _handshake(*providers: VaultKeyProvider, available: bool = True) -> HandshakeResult:
    return HandshakeResult(
        available=available,
        contract_version=CONTRACT_VERSION,
        ontology_version="1.0.0",
        capabilities=frozenset(),
        attestation=None,
        request_key_providers=frozenset(providers),
    )


class _Vault:
    """A vault whose handshake is scripted and counted."""

    def __init__(self, handshake: HandshakeResult) -> None:
        self._handshake = handshake
        self.probes = 0

    async def handshake(self) -> HandshakeResult:
        self.probes += 1
        return self._handshake


class _Session:
    """Counts commits, the one thing the decision may do to the session."""

    def __init__(self) -> None:
        self.commits = 0

    async def commit(self) -> None:
        self.commits += 1


def _as_session(session: _Session) -> AsyncSession:
    """The decision touches only ``commit``; the stand-in provides exactly that."""
    return cast("AsyncSession", session)


def _as_vault(vault: _Vault) -> CreekVaultClient:
    """The decision touches only ``handshake``; the stand-in provides exactly that."""
    return cast("CreekVaultClient", vault)


def test_the_key_never_renders_its_value() -> None:
    """Every rendering names the vendor and redacts the key."""
    key = VaultProviderKey(provider=VaultKeyProvider.ANTHROPIC, _secret=_SECRET)

    for rendered in (repr(key), str(key), f"{key}", repr([key]), repr({"k": key})):
        assert _SECRET not in rendered
        assert "anthropic" in rendered
    assert key.reveal() == _SECRET


def test_the_key_refuses_to_be_pickled() -> None:
    """No queue, cache or log record can serialise it."""
    key = VaultProviderKey(provider=VaultKeyProvider.OPENAI, _secret=_SECRET)

    with pytest.raises(TypeError, match="never serialised"):
        pickle.dumps(key)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (["anthropic", "openai"], {VaultKeyProvider.ANTHROPIC, VaultKeyProvider.OPENAI}),
        (["openai", "gemini", 7, None], {VaultKeyProvider.OPENAI}),
        ([], set()),
        (None, set()),
        ("anthropic", set()),
        ({"anthropic": True}, set()),
    ],
    ids=["both", "unknown-dropped", "empty", "absent", "a-string", "an-object"],
)
def test_request_key_providers_are_read_leniently(raw: object, expected: set[str]) -> None:
    """Only known vendors survive the parse; anything else means "send no key"."""
    assert parse_request_key_providers(raw) == expected


def test_a_conformant_handshake_carries_its_key_vendors() -> None:
    """A Creek 0.18 capability document is parsed through to ``accepts_key``."""
    minor = ".".join(CONTRACT_VERSION.split(".")[:2])
    parsed = _parse_handshake(
        {
            "contract_version": CONTRACT_VERSION,
            "supported_contract_minors": [minor],
            "ontology_version": "1.0.0",
            "vault": {"available": True},
            "capabilities": ["reflections"],
            "request_key_providers": ["anthropic"],
        }
    )

    assert parsed.accepts_key(VaultKeyProvider.ANTHROPIC)
    assert not parsed.accepts_key(VaultKeyProvider.OPENAI)


def test_creeks_published_capability_example_is_read_through_to_accepts_key() -> None:
    """The vendored 0.18 ``capabilities/success`` cell, parsed as the client parses it.

    Creek's own published document, not a hand-written one: if the bundle's
    field name or vendor spelling ever moves, the relay must stop admitting
    keys rather than keep reading a field nobody serves.
    """
    example = json.loads(
        (BUNDLE_ROOT / "examples" / "capabilities" / "success.json").read_text(encoding="utf-8")
    )

    parsed = _parse_handshake(example)

    assert parsed.request_key_providers == frozenset(VaultKeyProvider)
    assert all(parsed.accepts_key(vendor) for vendor in VaultKeyProvider)


def test_an_unavailable_vault_accepts_no_key() -> None:
    """Availability is part of the answer, whatever the vault listed."""
    assert not _handshake(VaultKeyProvider.OPENAI, available=False).accepts_key(
        VaultKeyProvider.OPENAI
    )


@pytest.mark.parametrize(
    ("header", "vendor"),
    [(OPENAI_KEY, VaultKeyProvider.OPENAI), (ANTHROPIC_KEY, VaultKeyProvider.ANTHROPIC)],
    ids=["openai", "anthropic"],
)
def test_a_key_is_bound_to_the_vendor_its_prefix_names(
    header: str, vendor: VaultKeyProvider
) -> None:
    """The vendor comes from the key itself, never from anything the client claims."""
    assert key_vendor(header) == (header, vendor)


def test_a_malformed_header_never_fails_an_onboarding_save() -> None:
    """The lenient read relays nothing rather than refusing a journal save."""
    assert relayable_key("not-a-key") is None
    assert relayable_key(None) is None
    relayed = relayable_key(OPENAI_KEY)
    assert relayed is not None
    assert relayed.provider is VaultKeyProvider.OPENAI


@pytest.mark.asyncio
async def test_a_vault_bound_key_is_relayed_only_when_the_vault_spends_that_vendor() -> None:
    """The one decision: vault-bound, a usable key, and a vault advertising its vendor."""
    session = _Session()
    spends = _Vault(_handshake(VaultKeyProvider.OPENAI))
    other_vendor = _Vault(_handshake(VaultKeyProvider.ANTHROPIC))
    advertises_none = _Vault(_handshake())

    relayed = await vault_provider_key(
        _as_session(session), _as_vault(spends), ReflectionBoundary.VAULT_BOUND, OPENAI_KEY
    )

    assert relayed is not None
    assert relayed.reveal() == OPENAI_KEY
    assert session.commits == 1
    assert (
        await vault_provider_key(
            _as_session(session),
            _as_vault(other_vendor),
            ReflectionBoundary.VAULT_BOUND,
            OPENAI_KEY,
        )
        is None
    )
    assert (
        await vault_provider_key(
            _as_session(session),
            _as_vault(advertises_none),
            ReflectionBoundary.VAULT_BOUND,
            OPENAI_KEY,
        )
        is None
    )


@pytest.mark.asyncio
async def test_no_probe_without_a_vault_bound_key() -> None:
    """An app-provider caller, or a keyless one, never makes the vault be asked."""
    session = _Session()
    vault = _Vault(_handshake(VaultKeyProvider.OPENAI))

    assert (
        await vault_provider_key(
            _as_session(session), _as_vault(vault), ReflectionBoundary.APP_PROVIDER, OPENAI_KEY
        )
        is None
    )
    assert (
        await vault_provider_key(
            _as_session(session), _as_vault(vault), ReflectionBoundary.VAULT_BOUND, None
        )
        is None
    )
    assert vault.probes == 0
    assert session.commits == 0
