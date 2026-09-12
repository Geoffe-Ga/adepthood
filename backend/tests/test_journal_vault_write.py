"""Integration tests wiring the journal router to the Creek Vault write path.

These drive the real create/update endpoints against a scripted vault client to
pin the guarantee the router owes the writer: the entry lands in Postgres and
comes back to the user whatever the vault does, and the ``vault_ref`` /
``vault_tags`` columns are reconciled to the write outcome -- written on a
durable ingest, cleared only after confirmed withdrawal, and left alone on a
transient failure so a passing blip never drops a good reference.
"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import col, select

from dependencies.creek_vault import get_creek_vault_client
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
    VaultJournalWithdrawResult,
    VaultReflection,
    VaultReflectionStatus,
    VaultTierCeiling,
    VaultUploadRequest,
    VaultUploadResult,
    VaultWheelBalance,
)
from main import app
from models.journal_entry import JournalEntry
from routers.journal import _record_vault_outcome
from tests.vault_client_doubles import NoPipelineVaultDouble

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


class SequencedVaultClient(NoPipelineVaultDouble):
    """Fake CreekVaultClient: available, ingests successfully, refs increment per call."""

    def __init__(
        self,
        *,
        capabilities: frozenset[CreekCapability] = frozenset(
            {
                CreekCapability.JOURNAL,
                CreekCapability.JOURNAL_WITHDRAW,
                CreekCapability.CLASSIFY,
            }
        ),
        ingest_error: Exception | None = None,
    ) -> None:
        """Store the advertised capabilities and any scripted ingest failure."""
        self.ingest_calls: list[VaultIngestRequest] = []
        self.withdraw_calls: list[int] = []
        self._capabilities = capabilities
        self._ingest_error = ingest_error
        self.handshake_error: Exception | None = None
        self.withdraw_error: Exception | None = None

    async def handshake(self) -> HandshakeResult:
        """Report available with the configured capability set."""
        if self.handshake_error is not None:
            raise self.handshake_error
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

    async def upload(self, request: VaultUploadRequest, /) -> VaultUploadResult:
        """Unused on this path; raises if a test calls it by mistake."""
        raise NotImplementedError(request)

    async def withdraw_journal_entry(self, entry_id: int, /) -> VaultJournalWithdrawResult:
        """Record the content-free stable identity and return a confirmed withdrawal."""
        self.withdraw_calls.append(entry_id)
        if self.withdraw_error is not None:
            raise self.withdraw_error
        return VaultJournalWithdrawResult(withdrawn=True)

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
    assert fake.withdraw_calls == [entry_id]
    assert first_row.vault_ref is None
    assert first_row.vault_tags is None


@pytest.mark.asyncio
async def test_failed_intimate_withdrawal_is_visible_and_retryable_from_persisted_state(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A failed privacy upgrade keeps its handle until the same PATCH confirms absence."""
    fake = SequencedVaultClient()
    app.dependency_overrides[get_creek_vault_client] = lambda: fake
    headers = await _signup(async_client, "vault_intimate_retry")
    created = await async_client.post(
        "/journal/",
        json={"message": "Writing that must leave Creek.", "classification": "personal"},
        headers=headers,
    )
    entry_id = int(created.json()["id"])
    fake.withdraw_error = CreekVaultUnavailableError(
        "creek vault call failed: creek.journal_withdraw"
    )

    failed = await async_client.patch(
        f"/journal/{entry_id}", json={"classification": "intimate"}, headers=headers
    )

    assert failed.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert failed.json() == {"detail": "vault_withdrawal_pending"}
    row = await _entry_row(db_session, entry_id)
    assert row.classification == "intimate"
    assert row.vault_ref == "vault-ref-1"

    fake.withdraw_error = None
    retried = await async_client.patch(
        f"/journal/{entry_id}", json={"classification": "intimate"}, headers=headers
    )

    assert retried.status_code == HTTPStatus.OK
    await db_session.refresh(row)
    assert fake.withdraw_calls == [entry_id, entry_id]
    assert row.vault_ref is None
    assert row.vault_tags is None


@pytest.mark.asyncio
async def test_failed_withdrawal_handshake_is_visible_and_retryable(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A handshake transport failure preserves the same durable Intimate retry state."""
    fake = SequencedVaultClient()
    app.dependency_overrides[get_creek_vault_client] = lambda: fake
    headers = await _signup(async_client, "vault_intimate_handshake_retry")
    created = await async_client.post(
        "/journal/",
        json={"message": "Privacy survives a handshake outage.", "classification": "personal"},
        headers=headers,
    )
    entry_id = int(created.json()["id"])
    fake.handshake_error = CreekVaultUnavailableError("creek vault handshake failed")

    failed = await async_client.patch(
        f"/journal/{entry_id}", json={"classification": "intimate"}, headers=headers
    )

    assert failed.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert failed.json() == {"detail": "vault_withdrawal_pending"}
    row = await _entry_row(db_session, entry_id)
    assert row.classification == "intimate"
    assert row.vault_ref == "vault-ref-1"


@pytest.mark.asyncio
async def test_delete_withdraws_remote_before_soft_delete_and_retries_on_failure(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """DELETE never hides its row while the connected vault still reports a retryable miss."""
    fake = SequencedVaultClient()
    app.dependency_overrides[get_creek_vault_client] = lambda: fake
    headers = await _signup(async_client, "vault_delete_retry")
    created = await async_client.post(
        "/journal/",
        json={"message": "Delete me everywhere.", "classification": "public"},
        headers=headers,
    )
    entry_id = int(created.json()["id"])
    fake.withdraw_error = CreekVaultUnavailableError(
        "creek vault call failed: creek.journal_withdraw"
    )

    failed = await async_client.delete(f"/journal/{entry_id}", headers=headers)

    assert failed.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert failed.json() == {"detail": "vault_withdrawal_pending"}
    row = await _entry_row(db_session, entry_id)
    assert row.deleted_at is None
    assert row.vault_ref == "vault-ref-1"

    fake.withdraw_error = None
    retried = await async_client.delete(f"/journal/{entry_id}", headers=headers)

    assert retried.status_code == HTTPStatus.NO_CONTENT
    await db_session.refresh(row)
    assert fake.withdraw_calls == [entry_id, entry_id]
    assert row.deleted_at is not None
    assert row.vault_ref is None
    assert row.vault_tags is None


@pytest.mark.asyncio
async def test_other_user_cannot_withdraw_an_entry_by_guessing_its_id(
    async_client: AsyncClient,
) -> None:
    """The owner-scoped 404 fires before Creek receives another user's stable id."""
    fake = SequencedVaultClient()
    app.dependency_overrides[get_creek_vault_client] = lambda: fake
    owner = await _signup(async_client, "vault_withdraw_owner")
    other = await _signup(async_client, "vault_withdraw_other")
    created = await async_client.post(
        "/journal/",
        json={"message": "Only the owner may withdraw this.", "classification": "personal"},
        headers=owner,
    )
    entry_id = int(created.json()["id"])

    denied = await async_client.delete(f"/journal/{entry_id}", headers=other)

    assert denied.status_code == HTTPStatus.NOT_FOUND
    assert fake.withdraw_calls == []


class PausedSecondIngestVaultClient(SequencedVaultClient):
    """Pause one update PUT so an intimate PATCH can attempt to overtake it."""

    def __init__(self) -> None:
        """Initialize the two synchronization points for the second ingest."""
        super().__init__()
        self.second_started = asyncio.Event()
        self.release_second = asyncio.Event()
        self.remote_order: list[str] = []

    async def ingest(self, request: VaultIngestRequest, /) -> VaultIngestResult:
        self.remote_order.append("upsert")
        if len(self.remote_order) == 2:
            self.second_started.set()
            await self.release_second.wait()
        return await super().ingest(request)

    async def withdraw_journal_entry(self, entry_id: int, /) -> VaultJournalWithdrawResult:
        self.remote_order.append("withdraw")
        return await super().withdraw_journal_entry(entry_id)


@pytest.mark.asyncio
async def test_late_in_flight_upsert_cannot_resurrect_an_intimate_entry(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """A privacy PATCH linearizes after an already-started PUT, then withdraws it."""
    fake = PausedSecondIngestVaultClient()
    app.dependency_overrides[get_creek_vault_client] = lambda: fake
    headers = await _signup(concurrent_async_client, "vault_upsert_race")
    created = await concurrent_async_client.post(
        "/journal/",
        json={"message": "First body.", "classification": "personal"},
        headers=headers,
    )
    entry_id = int(created.json()["id"])

    editing = asyncio.create_task(
        concurrent_async_client.patch(
            f"/journal/{entry_id}", json={"message": "Second body."}, headers=headers
        )
    )
    await fake.second_started.wait()
    privatizing = asyncio.create_task(
        concurrent_async_client.patch(
            f"/journal/{entry_id}", json={"classification": "intimate"}, headers=headers
        )
    )
    await asyncio.sleep(0)
    fake.release_second.set()
    edited, privatized = await asyncio.gather(editing, privatizing)

    assert edited.status_code == HTTPStatus.OK
    assert privatized.status_code == HTTPStatus.OK
    assert fake.remote_order == ["upsert", "upsert", "withdraw"]
    async with concurrent_session_factory() as checking:
        row = await _entry_row(checking, entry_id)
    assert row.classification == "intimate"
    assert row.vault_ref is None


@pytest.mark.asyncio
async def test_late_in_flight_upsert_cannot_outlive_a_deleted_entry(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """DELETE waits out an already-started PUT, withdraws it, then hides the row."""
    fake = PausedSecondIngestVaultClient()
    app.dependency_overrides[get_creek_vault_client] = lambda: fake
    headers = await _signup(concurrent_async_client, "vault_delete_race")
    created = await concurrent_async_client.post(
        "/journal/",
        json={"message": "First body.", "classification": "personal"},
        headers=headers,
    )
    entry_id = int(created.json()["id"])

    editing = asyncio.create_task(
        concurrent_async_client.patch(
            f"/journal/{entry_id}", json={"message": "Second body."}, headers=headers
        )
    )
    await fake.second_started.wait()
    deleting = asyncio.create_task(
        concurrent_async_client.delete(f"/journal/{entry_id}", headers=headers)
    )
    await asyncio.sleep(0)
    fake.release_second.set()
    edited, deleted = await asyncio.gather(editing, deleting)

    assert edited.status_code == HTTPStatus.OK
    assert deleted.status_code == HTTPStatus.NO_CONTENT
    assert fake.remote_order == ["upsert", "upsert", "withdraw"]
    async with concurrent_session_factory() as checking:
        row = await _entry_row(checking, entry_id)
    assert row.deleted_at is not None
    assert row.vault_ref is None


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


class TransactionObservingVaultClient(SequencedVaultClient):
    """Records whether the request's DB session held a transaction during ingest.

    The whole point of the connection-occupancy work: an open transaction means
    a connection is checked out of the pool, and holding one across a
    third-party HTTP round trip couples pool capacity to that third party's
    latency. This fake observes the session at exactly the moment the network
    call would be in flight.
    """

    def __init__(self, session: AsyncSession) -> None:
        """Watch ``session`` -- the same one the request handler is using."""
        super().__init__()
        self._session = session
        self.in_transaction_during_ingest: list[bool] = []
        self.in_transaction_during_withdraw: list[bool] = []

    async def ingest(self, request: VaultIngestRequest, /) -> VaultIngestResult:
        """Sample the session's transaction state, then ingest normally."""
        self.in_transaction_during_ingest.append(self._session.in_transaction())
        return await super().ingest(request)

    async def withdraw_journal_entry(self, entry_id: int, /) -> VaultJournalWithdrawResult:
        """Sample the request session at the exact content-free DELETE boundary."""
        self.in_transaction_during_withdraw.append(self._session.in_transaction())
        return await super().withdraw_journal_entry(entry_id)


@pytest.mark.asyncio
async def test_create_does_not_hold_a_db_transaction_across_the_vault_call(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """No pooled connection is occupied while the vault request is in flight.

    The pool is at SQLAlchemy's defaults -- five connections plus ten overflow --
    and the vault's whole-request deadline is thirty seconds, so fifteen
    concurrent writes against a *slow* vault would starve every other
    database-backed endpoint for the length of that deadline. A vault that is
    down is already safe; this is about one that answers slowly.
    """
    fake = TransactionObservingVaultClient(db_session)
    app.dependency_overrides[get_creek_vault_client] = lambda: fake
    headers = await _signup(async_client, "vault_no_hold")

    resp = await async_client.post(
        "/journal/",
        json={"message": "A public reflection.", "classification": "public"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED

    assert fake.in_transaction_during_ingest == [False], (
        "the request session held an open transaction -- and therefore a pooled "
        "connection -- while the vault HTTP call was in flight"
    )
    # The outcome must still be persisted through the short-lived session.
    row = await _entry_row(db_session, int(resp.json()["id"]))
    assert row.vault_ref == "vault-ref-1"


@pytest.mark.asyncio
async def test_patch_does_not_hold_a_db_transaction_across_the_vault_call(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The re-ingest path on PATCH carries the same property as create."""
    fake = TransactionObservingVaultClient(db_session)
    app.dependency_overrides[get_creek_vault_client] = lambda: fake
    headers = await _signup(async_client, "vault_no_hold_patch")

    created = await async_client.post(
        "/journal/",
        json={"message": "First body.", "classification": "public"},
        headers=headers,
    )
    assert created.status_code == HTTPStatus.CREATED
    entry_id = int(created.json()["id"])

    patched = await async_client.patch(
        f"/journal/{entry_id}",
        json={"message": "An edited body."},
        headers=headers,
    )
    assert patched.status_code == HTTPStatus.OK

    assert fake.in_transaction_during_ingest == [False, False], (
        "a vault call ran with the request session's transaction still open"
    )


@pytest.mark.asyncio
async def test_withdrawal_does_not_hold_a_db_transaction_across_the_vault_call(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The privacy-critical remote DELETE borrows no request-pool connection."""
    fake = TransactionObservingVaultClient(db_session)
    app.dependency_overrides[get_creek_vault_client] = lambda: fake
    headers = await _signup(async_client, "vault_withdraw_no_hold")
    created = await async_client.post(
        "/journal/",
        json={"message": "A mirrored entry.", "classification": "personal"},
        headers=headers,
    )
    entry_id = int(created.json()["id"])

    patched = await async_client.patch(
        f"/journal/{entry_id}", json={"classification": "intimate"}, headers=headers
    )

    assert patched.status_code == HTTPStatus.OK
    assert fake.in_transaction_during_withdraw == [False]
