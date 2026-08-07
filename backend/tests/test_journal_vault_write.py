"""Integration tests wiring the journal router to the Creek Vault write path.

These drive the real create/update endpoints against a scripted vault client to
pin the guarantee the router owes the writer: the entry lands in Postgres and
comes back to the user whatever the vault does, and the ``vault_ref`` /
``vault_tags`` columns are reconciled to the write outcome -- written on a
durable ingest, cleared when an entry turns intimate, and left alone on a
transient failure so a passing blip never drops a good reference.
"""

from __future__ import annotations

from collections.abc import Sequence
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
    CreekVaultContractError,
    CreekVaultUnavailableError,
    HandshakeResult,
    VaultClassification,
    VaultErrorCode,
    VaultIngestAction,
    VaultIngestRequest,
    VaultIngestResult,
    VaultReflection,
    VaultReflectionStatus,
    VaultTierCeiling,
    VaultWheelBalance,
)
from main import app
from models.journal_entry import JournalEntry
from routers.journal import _record_vault_outcome
from services.creek_vault_write import get_creek_vault_client

_SIGNUP_PASSWORD = "secret12345"  # pragma: allowlist secret


async def _signup(client: AsyncClient, username: str) -> dict[str, str]:
    """Sign up a fresh user and return an Authorization header for it."""
    resp = await client.post(
        "/auth/signup",
        json={"email": f"{username}@example.com", "password": _SIGNUP_PASSWORD},
    )
    assert resp.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {resp.json()['token']}"}


async def _entry_row(db_session: AsyncSession, entry_id: int) -> JournalEntry:
    """Fetch the persisted JournalEntry row by id."""
    result = await db_session.execute(select(JournalEntry).where(col(JournalEntry.id) == entry_id))
    return result.scalar_one()


def _empty_reflection() -> VaultReflection:
    """Return the reflection an unexercised reflect path answers with.

    The vault said nothing, successfully -- which is a different fact from an
    unreachable one, and this path asserts neither.
    """
    return VaultReflection(
        status=VaultReflectionStatus.EMPTY,
        notes=(),
        essay=None,
        essay_grounded=False,
        routed_tier=VaultTierCeiling.OPEN,
    )


class SequencedVaultClient:
    """Fake CreekVaultClient: available, ingests successfully, refs increment per call."""

    def __init__(
        self,
        *,
        capabilities: frozenset[CreekCapability] = frozenset(
            {CreekCapability.JOURNAL, CreekCapability.CLASSIFY}
        ),
        ingest_error: Exception | None = None,
    ) -> None:
        """Store the advertised capabilities and any scripted ingest failure."""
        self.ingest_calls: list[VaultIngestRequest] = []
        self._capabilities = capabilities
        self._ingest_error = ingest_error

    async def handshake(self) -> HandshakeResult:
        """Report available with the configured capability set."""
        return HandshakeResult(
            available=True,
            contract_version=CONTRACT_VERSION,
            ontology_version="1.0.0",
            capabilities=self._capabilities,
            attestation=None,
        )

    def is_available(self) -> bool:
        """Always report available -- this fake never degrades on handshake."""
        return True

    def supports(self, capability: CreekCapability, /) -> bool:
        """Return whether ``capability`` is in the configured capability set."""
        return capability in self._capabilities

    async def ingest(self, request: VaultIngestRequest, /) -> VaultIngestResult:
        """Record the request, then raise or return an incrementing vault ref."""
        self.ingest_calls.append(request)
        if self._ingest_error is not None:
            raise self._ingest_error
        return VaultIngestResult(stored=True, vault_ref=f"vault-ref-{len(self.ingest_calls)}")

    async def classify(self, _body: str, _tier_ceiling: VaultTierCeiling, /) -> VaultClassification:
        """Return a fixed classification tag set."""
        return VaultClassification(tags=("courage",))

    async def reflect(self, _body: str, _tier_ceiling: VaultTierCeiling, /) -> VaultReflection:
        """Return an empty reflection (unused by the write path)."""
        return _empty_reflection()

    async def wheel(self) -> VaultWheelBalance:
        """Return an empty wheel balance (unused by the write path)."""
        return VaultWheelBalance(aspects=())


# The one fragment a vault keyed off a stable entry id keeps handing back, no
# matter how often the entry is re-sent.
_STABLE_FRAGMENT_ID = "vault-fragment-stable"


def _stable_action(seen: Sequence[str], body: str) -> VaultIngestAction:
    """Return created on first sight, unchanged for an identical re-send, updated otherwise."""
    if not seen:
        return VaultIngestAction.CREATED
    if seen[-1] == body:
        return VaultIngestAction.UNCHANGED
    return VaultIngestAction.UPDATED


class StableFragmentVaultClient(SequencedVaultClient):
    """Fake vault that edits one fragment in place: the ref never changes across re-sends.

    The realistic counterpart to :class:`SequencedVaultClient`'s incrementing
    refs -- a vault keying its fragment off the entry id answers the same
    ``fragment_id`` every time and reports what it did in ``action``.
    """

    def __init__(self) -> None:
        """Start with no ingested bodies and no recorded actions."""
        super().__init__()
        self.actions: list[VaultIngestAction] = []
        self._bodies: list[str] = []

    async def ingest(self, request: VaultIngestRequest, /) -> VaultIngestResult:
        """Record the request and answer with this entry's one stable fragment id."""
        self.ingest_calls.append(request)
        action = _stable_action(self._bodies, request.body)
        self.actions.append(action)
        self._bodies.append(request.body)
        return VaultIngestResult(stored=True, vault_ref=_STABLE_FRAGMENT_ID, action=action)


@pytest.mark.asyncio
async def test_record_vault_outcome_skips_when_entry_id_is_none(
    db_session: AsyncSession,
) -> None:
    """An entry that has no id yet returns before any vault call is made."""
    fake = SequencedVaultClient()
    entry = JournalEntry(sender="user", user_id=1, message="An unsaved draft.")
    await _record_vault_outcome(db_session, entry, fake)
    assert fake.ingest_calls == []


@pytest.mark.asyncio
async def test_create_non_intimate_entry_persists_vault_ref_and_tags(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A non-intimate create with an available vault persists the ref and empty tags."""
    fake = SequencedVaultClient()
    app.dependency_overrides[get_creek_vault_client] = lambda: fake
    headers = await _signup(async_client, "vault_create")

    resp = await async_client.post(
        "/journal/",
        json={"message": "A public reflection.", "classification": "public"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED

    row = await _entry_row(db_session, int(resp.json()["id"]))
    assert row.vault_ref == "vault-ref-1"
    assert row.vault_tags == []


@pytest.mark.asyncio
async def test_create_intimate_entry_never_touches_vault(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An intimate create leaves vault_ref/vault_tags unset and never calls the vault."""
    fake = SequencedVaultClient()
    app.dependency_overrides[get_creek_vault_client] = lambda: fake
    headers = await _signup(async_client, "vault_intimate")

    resp = await async_client.post(
        "/journal/",
        json={"message": "A private confession.", "classification": "intimate"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED

    row = await _entry_row(db_session, int(resp.json()["id"]))
    assert row.vault_ref is None
    assert row.vault_tags is None
    assert fake.ingest_calls == []


@pytest.mark.asyncio
async def test_create_degrades_gracefully_when_ingest_raises(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A vault ingest failure never blocks the write -- the entry still saves, unrefed."""
    fake = SequencedVaultClient(
        ingest_error=CreekVaultUnavailableError("creek vault call failed: creek.journal")
    )
    app.dependency_overrides[get_creek_vault_client] = lambda: fake
    headers = await _signup(async_client, "vault_degrade")

    resp = await async_client.post(
        "/journal/",
        json={"message": "Written while the vault is down.", "classification": "personal"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED

    row = await _entry_row(db_session, int(resp.json()["id"]))
    assert row.vault_ref is None


@pytest.mark.asyncio
async def test_create_with_default_provider_and_no_vault_configured_behaves_as_today(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With no dependency override and no CREEK_VAULT_URL, the write path is a no-op."""
    monkeypatch.delenv("CREEK_VAULT_URL", raising=False)
    headers = await _signup(async_client, "vault_unconfigured")

    resp = await async_client.post(
        "/journal/",
        json={"message": "Ordinary entry, no vault configured.", "classification": "personal"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED

    row = await _entry_row(db_session, int(resp.json()["id"]))
    assert row.vault_ref is None


@pytest.mark.asyncio
async def test_create_with_a_stale_retired_protocol_still_saves_the_entry(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A retired CREEK_VAULT_PROTOCOL costs the replication, never the writing.

    The vault client is built by a per-request dependency, so a factory that
    raised on a stale selector would mean this handler's body never ran at all:
    the writer would get a 500 and the entry would exist nowhere. ``mcp`` is
    precisely the value this repository's own env template prescribed until the
    transport was retired, so this is the configuration a real deployment drifts
    into -- and it must degrade exactly like a deployment that never had a vault.
    """
    monkeypatch.setenv("CREEK_VAULT_URL", "https://vault.example.test")
    monkeypatch.setenv("CREEK_VAULT_PROTOCOL", "mcp")
    headers = await _signup(async_client, "vault_stale_protocol")

    resp = await async_client.post(
        "/journal/",
        json={"message": "Written while the protocol was stale.", "classification": "personal"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED

    row = await _entry_row(db_session, int(resp.json()["id"]))
    assert row.message == "Written while the protocol was stale."
    assert row.vault_ref is None


@pytest.mark.asyncio
async def test_create_with_an_unrecognized_protocol_still_saves_the_entry(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A typo'd CREEK_VAULT_PROTOCOL costs the replication, never the writing.

    The same reasoning as the retired selector above, for the far likelier
    mistake: nobody has to have deployed an old adepthood to end up here, only to
    have fat-fingered one environment variable. Since the client is built by a
    per-request dependency, a factory that raised would mean every journal save
    returned a 500 with the entry saved nowhere -- the one loss this whole seam
    promises can never happen for a vault's sake.
    """
    monkeypatch.setenv("CREEK_VAULT_URL", "https://vault.example.test")
    monkeypatch.setenv("CREEK_VAULT_PROTOCOL", "htp")
    headers = await _signup(async_client, "vault_unknown_protocol")

    resp = await async_client.post(
        "/journal/",
        json={"message": "Written while the protocol was a typo.", "classification": "personal"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED

    row = await _entry_row(db_session, int(resp.json()["id"]))
    assert row.message == "Written while the protocol was a typo."
    assert row.vault_ref is None


@pytest.mark.asyncio
async def test_patch_message_edit_reingests_and_updates_vault_ref(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Editing the body re-ingests and the persisted vault_ref advances to the new ref."""
    fake = SequencedVaultClient()
    app.dependency_overrides[get_creek_vault_client] = lambda: fake
    headers = await _signup(async_client, "vault_patch_body")

    created = await async_client.post(
        "/journal/",
        json={"message": "Original body.", "classification": "public"},
        headers=headers,
    )
    entry_id = int(created.json()["id"])
    first_row = await _entry_row(db_session, entry_id)
    assert first_row.vault_ref == "vault-ref-1"

    patched = await async_client.patch(
        f"/journal/{entry_id}", json={"message": "Revised body."}, headers=headers
    )
    assert patched.status_code == HTTPStatus.OK

    second_row = await _entry_row(db_session, entry_id)
    assert len(fake.ingest_calls) == 2
    assert second_row.vault_ref == "vault-ref-2"


@pytest.mark.asyncio
async def test_patch_title_only_does_not_reingest(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A title-only PATCH sends no body to the vault -- no second ingest call."""
    fake = SequencedVaultClient()
    app.dependency_overrides[get_creek_vault_client] = lambda: fake
    headers = await _signup(async_client, "vault_patch_title")

    created = await async_client.post(
        "/journal/",
        json={"message": "Untouched body.", "classification": "public"},
        headers=headers,
    )
    entry_id = int(created.json()["id"])
    assert len(fake.ingest_calls) == 1

    patched = await async_client.patch(
        f"/journal/{entry_id}", json={"title": "A new title"}, headers=headers
    )
    assert patched.status_code == HTTPStatus.OK
    assert len(fake.ingest_calls) == 1

    row = await _entry_row(db_session, entry_id)
    assert row.vault_ref == "vault-ref-1"


@pytest.mark.asyncio
async def test_patch_to_intimate_clears_prior_vault_ref_and_tags(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Re-classifying an ingested entry as intimate clears its ref/tags and re-sends nothing."""
    fake = SequencedVaultClient()
    app.dependency_overrides[get_creek_vault_client] = lambda: fake
    headers = await _signup(async_client, "vault_to_intimate")

    created = await async_client.post(
        "/journal/",
        json={"message": "A shareable reflection.", "classification": "public"},
        headers=headers,
    )
    entry_id = int(created.json()["id"])
    first_row = await _entry_row(db_session, entry_id)
    assert first_row.vault_ref == "vault-ref-1"
    assert first_row.vault_tags == []

    patched = await async_client.patch(
        f"/journal/{entry_id}", json={"classification": "intimate"}, headers=headers
    )
    assert patched.status_code == HTTPStatus.OK

    await db_session.refresh(first_row)
    assert len(fake.ingest_calls) == 1
    assert first_row.vault_ref is None
    assert first_row.vault_tags is None


@pytest.mark.asyncio
async def test_patch_from_intimate_to_personal_ingests(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Re-classifying an intimate entry as personal ingests it for the first time."""
    fake = SequencedVaultClient()
    app.dependency_overrides[get_creek_vault_client] = lambda: fake
    headers = await _signup(async_client, "vault_from_intimate")

    created = await async_client.post(
        "/journal/",
        json={"message": "A private note, later shared.", "classification": "intimate"},
        headers=headers,
    )
    entry_id = int(created.json()["id"])
    assert fake.ingest_calls == []

    patched = await async_client.patch(
        f"/journal/{entry_id}", json={"classification": "personal"}, headers=headers
    )
    assert patched.status_code == HTTPStatus.OK

    row = await _entry_row(db_session, entry_id)
    assert len(fake.ingest_calls) == 1
    assert row.vault_ref == "vault-ref-1"


@pytest.mark.asyncio
async def test_patch_message_edit_with_a_stable_fragment_id_keeps_the_vault_ref(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A vault that edits its fragment in place leaves the persisted ref exactly where it was."""
    fake = StableFragmentVaultClient()
    app.dependency_overrides[get_creek_vault_client] = lambda: fake
    headers = await _signup(async_client, "vault_stable_ref")

    created = await async_client.post(
        "/journal/",
        json={"message": "Original body.", "classification": "public"},
        headers=headers,
    )
    entry_id = int(created.json()["id"])
    first_row = await _entry_row(db_session, entry_id)
    assert first_row.vault_ref == _STABLE_FRAGMENT_ID

    patched = await async_client.patch(
        f"/journal/{entry_id}", json={"message": "Revised body."}, headers=headers
    )
    assert patched.status_code == HTTPStatus.OK

    second_row = await _entry_row(db_session, entry_id)
    assert fake.actions == [VaultIngestAction.CREATED, VaultIngestAction.UPDATED]
    assert second_row.vault_ref == _STABLE_FRAGMENT_ID


@pytest.mark.asyncio
async def test_resending_unchanged_content_leaves_one_vault_ref(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Re-sending identical content reports unchanged and never earns the row a second ref."""
    fake = StableFragmentVaultClient()
    app.dependency_overrides[get_creek_vault_client] = lambda: fake
    headers = await _signup(async_client, "vault_unchanged")
    message = "A body saved twice, word for word."

    created = await async_client.post(
        "/journal/",
        json={"message": message, "classification": "public"},
        headers=headers,
    )
    entry_id = int(created.json()["id"])

    patched = await async_client.patch(
        f"/journal/{entry_id}", json={"message": message}, headers=headers
    )
    assert patched.status_code == HTTPStatus.OK

    row = await _entry_row(db_session, entry_id)
    assert fake.actions == [VaultIngestAction.CREATED, VaultIngestAction.UNCHANGED]
    assert row.vault_ref == _STABLE_FRAGMENT_ID


@pytest.mark.asyncio
async def test_entry_saves_locally_when_ingest_raises_a_contract_error(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A contract fault is ours to fix, never the writer's to lose: the entry still saves."""
    fake = SequencedVaultClient(
        ingest_error=CreekVaultContractError(
            "creek vault rejected the request", code=VaultErrorCode.INVALID_REQUEST
        )
    )
    app.dependency_overrides[get_creek_vault_client] = lambda: fake
    headers = await _signup(async_client, "vault_contract_error")

    resp = await async_client.post(
        "/journal/",
        json={"message": "Written against a rejected contract.", "classification": "personal"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED

    row = await _entry_row(db_session, int(resp.json()["id"]))
    assert row.vault_ref is None
    assert len(fake.ingest_calls) == 1
