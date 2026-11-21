"""A vault letter says when it is in the writer's own voice, and keeps its related pages (#3778).

Creek 0.35 reports whether a letter was written in the owner's own voice and
0.36 names the praxis, eddies and threads its entry touches. The essay route
caches both beside the letter, so the answer that delivered it and every later
read -- a free reopen, the entry's margin-note listing -- say the same thing.
A letter the vault made no claim about, and every app-provider letter, carries
neither.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime
from http import HTTPStatus
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from dependencies.creek_vault import get_creek_vault_client, get_reflection_boundary
from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
    HandshakeResult,
    VaultIngestAction,
    VaultLetter,
    VaultLetterRequest,
    VaultPraxisKind,
    VaultPraxisStatus,
    VaultRelatedEddy,
    VaultRelatedPraxis,
    VaultTierCeiling,
    VaultVoiceDraftDeleteResult,
)
from domain.vault_related import VaultRelatedThread, VaultReplyVoice, VaultThreadStatus
from main import app
from models.journal_entry import JournalClassification, JournalEntry
from models.marginalia import Marginalia, MarginaliaKind
from services import demo_visibility
from services.creek_vault_client import LocalFallbackCreekVaultClient
from services.reflection_boundary import ReflectionBoundary
from tests.vault_client_doubles import bind_every_account_to_a_recorded_vault

_PASSWORD = "secret12345"  # pragma: allowlist secret
_BODY = "SENTINEL_BODY_3778 I said yes again, and rested only after the collapse."
_LETTER = "A letter in your own words: you already know how to rest before the fall."
_PRICED = {"price_acknowledged": True}
_NOW = datetime(2026, 11, 20, tzinfo=UTC)
_CAPABILITIES = frozenset({CreekCapability.LETTERS, CreekCapability.VOICE_DRAFTS})

_PRAXIS = VaultRelatedPraxis(
    title="Rest before the collapse",
    praxis_type=VaultPraxisKind.PRACTICE,
    status=VaultPraxisStatus.ACTIVE,
    excerpt="Lie down at the first sign, not the last.",
)
_EDDY = VaultRelatedEddy(
    title="Rest and Ruin",
    description="Where the writing circles.",
    fragment_count=12,
    formed="2026-03-04",
)
_THREAD = VaultRelatedThread(
    id="thread-0000000001", title="Leaving the firm", status=VaultThreadStatus.ACTIVE
)
_EXPECTED_RELATED: dict[str, Any] = {
    "praxis": [
        {
            "title": _PRAXIS.title,
            "praxis_type": "practice",
            "status": "active",
            "excerpt": _PRAXIS.excerpt,
        }
    ],
    "eddies": [
        {
            "title": _EDDY.title,
            "description": _EDDY.description,
            "fragment_count": 12,
            "formed": "2026-03-04",
        }
    ],
    "threads": [{"id": _THREAD.id, "title": _THREAD.title, "status": "active"}],
}


class _OwnVoiceVault(LocalFallbackCreekVaultClient):
    """A letter-writing vault answering with a configurable voice and related pages."""

    def __init__(self) -> None:
        super().__init__()
        self.letters: list[VaultLetterRequest] = []
        self.voice: VaultReplyVoice | None = VaultReplyVoice.OWNER
        self.related = True

    async def handshake(self) -> HandshakeResult:
        return HandshakeResult(
            available=True,
            contract_version=CONTRACT_VERSION,
            ontology_version="aptitude-wavelength/2026-05-23",
            capabilities=_CAPABILITIES,
            attestation=None,
        )

    def supports(self, capability: CreekCapability, /) -> bool:
        return capability in _CAPABILITIES

    async def write_letter(self, request: VaultLetterRequest, /) -> VaultLetter:
        self.letters.append(request)
        return VaultLetter(
            letter=_LETTER,
            vault_ref="voice-draft-fragment-3778",
            action=VaultIngestAction.CREATED,
            voice=self.voice,
            related_praxis=(_PRAXIS,) if self.related else (),
            related_eddies=(_EDDY,) if self.related else (),
            related_threads=(_THREAD,) if self.related else (),
        )

    async def delete_voice_draft(
        self, _external_id: str, _tier_ceiling: VaultTierCeiling, /
    ) -> VaultVoiceDraftDeleteResult:
        return VaultVoiceDraftDeleteResult(deleted=True)


@pytest.fixture
def vault(monkeypatch: pytest.MonkeyPatch) -> Iterator[_OwnVoiceVault]:
    """A vault-bound writer whose vault writes in their own voice."""
    bind_every_account_to_a_recorded_vault(monkeypatch)
    letters = _OwnVoiceVault()
    app.dependency_overrides[get_creek_vault_client] = lambda: letters
    app.dependency_overrides[get_reflection_boundary] = lambda: ReflectionBoundary.VAULT_BOUND
    yield letters
    app.dependency_overrides.pop(get_creek_vault_client, None)
    app.dependency_overrides.pop(get_reflection_boundary, None)


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    resp = await client.post(
        "/auth/signup", json={"email": f"{username}@example.com", "password": _PASSWORD}
    )
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    return {"Authorization": f"Bearer {data['token']}"}, int(data["user_id"])


async def _seed_note(session: AsyncSession, user_id: int) -> tuple[int, int]:
    """One Personal entry with one margin note; returns (entry id, note id)."""
    entry = JournalEntry(
        sender="user",
        user_id=user_id,
        message=_BODY,
        classification=JournalClassification.PERSONAL,
    )
    session.add(entry)
    await session.flush()
    note = Marginalia(
        journal_entry_id=entry.id,
        user_id=user_id,
        kind=MarginaliaKind.THEME,
        anchor_start=0,
        anchor_end=8,
        anchor_text=_BODY[:8],
        note="You agree before you check.",
    )
    session.add(note)
    await session.commit()
    assert entry.id is not None
    assert note.id is not None
    return entry.id, note.id


async def _ask(client: AsyncClient, headers: dict[str, str], note_id: int) -> dict[str, Any]:
    resp = await client.post(f"/journal/marginalia/{note_id}/essay", headers=headers, json=_PRICED)
    assert resp.status_code == HTTPStatus.OK, resp.text
    body: dict[str, Any] = resp.json()
    return body


@pytest.mark.asyncio
async def test_an_own_voice_letter_says_so_and_keeps_its_pages_on_every_read(
    async_client: AsyncClient, db_session: AsyncSession, vault: _OwnVoiceVault
) -> None:
    """The answer, a free reopen and the margin listing all carry voice and pages."""
    headers, user_id = await _signup(async_client, "own_voice_letter")
    entry_id, note_id = await _seed_note(db_session, user_id)

    written = await _ask(async_client, headers, note_id)
    reopened = await _ask(async_client, headers, note_id)
    listing = await async_client.get(f"/journal/{entry_id}/marginalia", headers=headers)

    assert listing.status_code == HTTPStatus.OK
    [listed] = listing.json()["items"]
    for body in (written, reopened, listed):
        assert body["essay"] == _LETTER
        assert body["essay_voice"] == "owner"
        assert body["essay_related"] == _EXPECTED_RELATED
    assert len(vault.letters) == 1


@pytest.mark.asyncio
async def test_a_letter_the_vault_made_no_claim_about_carries_neither(
    async_client: AsyncClient, db_session: AsyncSession, vault: _OwnVoiceVault
) -> None:
    """An older vault's letter: no voice line, no pages, and nothing stored for them."""
    vault.voice = None
    vault.related = False
    headers, user_id = await _signup(async_client, "own_voice_unclaimed")
    _, note_id = await _seed_note(db_session, user_id)

    body = await _ask(async_client, headers, note_id)

    assert body["essay"] == _LETTER
    assert body["essay_voice"] is None
    assert body["essay_related"] is None
    db_session.expire_all()
    note = (
        await db_session.execute(select(Marginalia).where(col(Marginalia.id) == note_id))
    ).scalar_one()
    assert (note.essay_voice, note.essay_related) == (None, None)


@pytest.mark.asyncio
async def test_a_higher_self_letter_keeps_its_pages_without_claiming_the_owners_voice(
    async_client: AsyncClient, db_session: AsyncSession, vault: _OwnVoiceVault
) -> None:
    """``higher_self`` is recorded as such; the pages still ride beside it."""
    vault.voice = VaultReplyVoice.HIGHER_SELF
    headers, user_id = await _signup(async_client, "own_voice_higher_self")
    _, note_id = await _seed_note(db_session, user_id)

    body = await _ask(async_client, headers, note_id)

    assert body["essay_voice"] == "higher_self"
    assert body["essay_related"] == _EXPECTED_RELATED


def test_a_stored_document_that_will_not_decode_reads_as_no_pages() -> None:
    """A corrupt row loses its pages, never the note."""
    note = demo_visibility.served_note(
        Marginalia(
            id=1,
            journal_entry_id=1,
            user_id=1,
            kind=MarginaliaKind.THEME,
            anchor_start=0,
            anchor_end=1,
            anchor_text="I",
            note="A note.",
            status="active",
            essay_related="{not json",
            essay_voice="owner",
            created_at=_NOW,
            updated_at=_NOW,
        )
    )
    assert note.essay_related is None
    assert note.essay_voice is VaultReplyVoice.OWNER
