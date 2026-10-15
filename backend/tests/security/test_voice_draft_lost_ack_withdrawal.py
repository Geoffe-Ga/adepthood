"""A Voice Draft whose acknowledgment was lost is withdrawn after Intimate and restart (C11, #3354).

The Voice Draft twin of C11's release test
(:func:`tests.security.test_intimate_egress_matrix.test_a_copy_whose_acknowledgment_was_lost_is_withdrawn_after_intimate_and_restart`).
The vault stores the essay and then the call never comes back to adepthood:
either the response is lost (a vault error the mirror absorbs) or the process
dies while the PUT is on the wire. The entry is then made Intimate while the
vault refuses every draft DELETE, so the PATCH can only record the withdrawal
it owes; the process restarts, the recovery sweep runs, and no copy may
remain in the vault.

Only the intent row committed *before* the PUT can make that sweep owe
anything: nothing the PUT answered was ever read. Recording the intent after
the PUT instead fails the process-death cells at the vault-state assertion
(the lost-response cells still pass then: the mirror absorbs the vault error
and goes on to record it). Both the app-provider essay
(mirrored by ``services.creek_vault_voice_drafts``) and the vault-bound letter
(written and kept by the vault in ``services.creek_vault_letters``) stage that
intent, and both are driven here.
"""

from __future__ import annotations

import json
from collections.abc import AsyncGenerator
from http import HTTPStatus
from typing import TYPE_CHECKING, Final

import pytest
import pytest_asyncio
from sqlmodel import col, select

from dependencies.creek_vault import get_creek_vault_client, get_reflection_boundary
from domain.creek_vault import CreekVaultUnavailableError
from domain.frequencies import Frequency
from main import app
from models.voice_draft_retraction import VoiceDraftRetraction, VoiceDraftRetractionState
from services import creek_vault_pipeline as pipeline
from services.creek_vault_voice_drafts import _aware as aware
from services.creek_vault_voice_drafts import resume_voice_draft_retractions
from services.reflection_boundary import ReflectionBoundary
from tests.helpers.sentry_capture import capturing_sentry
from tests.security.test_intimate_egress_matrix import Harness
from tests.security.test_intimate_egress_matrix import _seed_note as seed_note
from tests.support.egress_recorders import (
    Ledger,
    RecordingVault,
    carries,
    record_classifier_inputs,
    record_provider_dials,
    recording_telemetry,
)
from tests.vault_client_doubles import RECORDED_VAULT, bind_every_account_to_a_recorded_vault

if TYPE_CHECKING:
    from httpx import AsyncClient
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from domain.creek_vault import (
        VaultLetter,
        VaultLetterRequest,
        VaultTierCeiling,
        VaultVoiceDraftDeleteResult,
        VaultVoiceDraftRequest,
        VaultVoiceDraftResult,
    )

#: The classifier reply the matrix uses, so a Personal entry is really ontologized.
_CLASSIFIED_REPLY: Final = json.dumps(
    {"weights": {Frequency.F5.value: 0.9}, "overall_confidence": 0.9}
)
_PERSONAL: Final = "personal"
_INTIMATE: Final = "intimate"
#: What the Intimate PATCH may answer while every draft DELETE is refused.
_PATCH_ANSWERS: Final = frozenset({HTTPStatus.OK, HTTPStatus.SERVICE_UNAVAILABLE})


class _ProcessDeathError(BaseException):
    """The process dying while the PUT is on the wire.

    A ``BaseException``, like a real crash: nothing after the dial runs, so no
    code the mirror reaches once the vault answers can record anything.
    """


class _AckLosingVault(RecordingVault):
    """A recording vault that keeps each draft and then loses the answer to it.

    ``lose_draft_acks`` names the fault the PUT raises *after* the draft is
    stored remotely; ``refuse_draft_deletes`` makes every draft DELETE fail, so
    a withdrawal can only be owed, not done.
    """

    def __init__(self, ledger: Ledger) -> None:
        """Start acknowledging every draft and honouring every DELETE."""
        super().__init__(ledger)
        self.lose_draft_acks: BaseException | None = None
        self.refuse_draft_deletes = False

    def _lose_the_ack(self) -> None:
        if self.lose_draft_acks is not None:
            raise self.lose_draft_acks

    async def upsert_voice_draft(self, request: VaultVoiceDraftRequest, /) -> VaultVoiceDraftResult:
        """Store the essay remotely, then lose the acknowledgment if armed."""
        result = await super().upsert_voice_draft(request)
        self._lose_the_ack()
        return result

    async def write_letter(self, request: VaultLetterRequest, /) -> VaultLetter:
        """Write and keep the letter remotely, then lose the acknowledgment if armed."""
        letter = await super().write_letter(request)
        self._lose_the_ack()
        return letter

    async def delete_voice_draft(
        self, external_id: str, tier_ceiling: VaultTierCeiling, /
    ) -> VaultVoiceDraftDeleteResult:
        """Retract the draft, unless every DELETE is being refused."""
        if self.refuse_draft_deletes:
            await self._dial("delete_voice_draft", f"{tier_ceiling} {external_id}")
            msg = "synthetic draft-delete outage"
            raise CreekVaultUnavailableError(msg)
        return await super().delete_voice_draft(external_id, tier_ceiling)


def _drafts(vault: RecordingVault) -> list[str]:
    """The keys of every Voice Draft the vault still holds."""
    return sorted(key for key in vault.remote if key.startswith("draft:"))


@pytest_asyncio.fixture(autouse=True)
async def _isolate_background_pipeline_tasks() -> AsyncGenerator[None, None]:
    """Give each test an empty in-process continuation registry, before and after."""
    await pipeline.close_vault_pipeline_tasks()
    try:
        yield
    finally:
        await pipeline.close_vault_pipeline_tasks()


@pytest_asyncio.fixture
async def harness(
    concurrent_async_client: AsyncClient,
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> AsyncGenerator[Harness, None]:
    """One signed-up account on an acknowledgment-losing vault, every recorder armed."""
    bind_every_account_to_a_recorded_vault(monkeypatch)
    ledger = Ledger()
    vault = _AckLosingVault(ledger)
    app.dependency_overrides[get_creek_vault_client] = lambda: vault
    assert record_provider_dials(monkeypatch, ledger, classifier_reply=_CLASSIFIED_REPLY)
    record_classifier_inputs(monkeypatch, ledger)
    with (
        capturing_sentry(monkeypatch) as sentry_events,
        recording_telemetry(monkeypatch, sentry_events) as telemetry,
    ):
        h = Harness(concurrent_async_client, concurrent_session_factory, ledger, vault, telemetry)
        await h.signup()
        yield h


async def _retractions(h: Harness) -> list[VoiceDraftRetraction]:
    """Every Voice Draft obligation this account has, read from the database."""
    async with h.factory() as session:
        found = await session.execute(
            select(VoiceDraftRetraction).where(col(VoiceDraftRetraction.user_id) == h.user_id)
        )
        return list(found.scalars().all())


def _is_the_crash(exc: BaseException) -> bool:
    """Whether ``exc`` is the injected crash, alone or inside the ASGI stack's task group."""
    if isinstance(exc, BaseExceptionGroup):
        return exc.subgroup(_ProcessDeathError) is not None
    return isinstance(exc, _ProcessDeathError)


async def _write_letter_losing_the_ack(h: Harness, entry_id: int, fault: BaseException) -> None:
    """Ask for the letter while the vault keeps it and loses the answer.

    Any answer the route gives is acceptable -- a lost response is a degraded
    mirror, or a refunded vault letter -- but a crash is the only thing that
    may escape it.
    """
    vault = h.vault
    assert isinstance(vault, _AckLosingVault)
    note_id = await seed_note(h, entry_id)
    vault.lose_draft_acks = fault
    try:
        await h.client.post(
            f"/journal/marginalia/{note_id}/essay",
            json={"price_acknowledged": True},
            headers=h.headers,
        )
    except BaseException as exc:
        if not _is_the_crash(exc):
            raise
        assert isinstance(fault, _ProcessDeathError), "only the injected crash may escape"
    finally:
        vault.lose_draft_acks = None


async def _restart_and_sweep(h: Harness) -> None:
    """Stop in-process work, then run the recovery sweep once the PATCH's backoff is due.

    A fresh process's sweep reads only what was committed. The PATCH's failed
    attempt backed the row off, so the sweep runs at the moment it is due --
    a restart that came later, not a clock this test bends past the backoff.
    """
    await pipeline.close_vault_pipeline_tasks()
    due = [aware(row.next_attempt_at) for row in await _retractions(h) if row.next_attempt_at]

    async def _client(_session: AsyncSession, _user_id: int) -> RecordingVault:
        return h.vault

    async def _destination(_session: AsyncSession, _user_id: int) -> str | None:
        return RECORDED_VAULT

    await resume_voice_draft_retractions(
        h.factory, _client, _destination, now=max(due, default=None)
    )


_FAULTS: Final = [
    pytest.param(CreekVaultUnavailableError("synthetic lost acknowledgment"), id="lost-response"),
    pytest.param(_ProcessDeathError(), id="process-death"),
]
_BOUNDARIES: Final = [
    pytest.param(ReflectionBoundary.APP_PROVIDER, id="mirrored-essay"),
    pytest.param(ReflectionBoundary.VAULT_BOUND, id="vault-letter"),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("boundary", _BOUNDARIES)
@pytest.mark.parametrize("fault", _FAULTS)
async def test_a_voice_draft_whose_acknowledgment_was_lost_is_withdrawn_after_intimate_and_restart(
    harness: Harness, boundary: ReflectionBoundary, fault: BaseException
) -> None:
    """The vault kept the draft, adepthood never heard back; Intimate and a restart withdraw it."""
    app.dependency_overrides[get_reflection_boundary] = lambda: boundary
    vault = harness.vault
    assert isinstance(vault, _AckLosingVault)
    entry_id = await harness.create(message=harness.body(), title=None, tier=_PERSONAL)

    await _write_letter_losing_the_ack(harness, entry_id, fault)
    held = _drafts(vault)
    assert held, "the fault was not injected: the vault kept no draft"
    assert all(carries(vault.remote[key], harness.canary) for key in held)

    vault.refuse_draft_deletes = True
    response = await harness.patch(entry_id, classification=_INTIMATE)
    # 503 while the owed withdrawal is unconfirmed. A 200 here means nothing was
    # owed -- the bug this test exists for -- and is left to the vault-state
    # assertions below, which are the claim itself.
    assert response.status_code in _PATCH_ANSWERS, response.text
    assert _drafts(vault) == held, "the PATCH withdrew the draft: the restart would prove nothing"
    vault.refuse_draft_deletes = False

    await _restart_and_sweep(harness)

    assert _drafts(vault) == []
    assert vault.remote_copies_carrying(harness.canary) == []
    (obligation,) = await _retractions(harness)
    assert obligation.state == VoiceDraftRetractionState.CONFIRMED
    assert obligation.confirmed_at is not None
