"""Folded-quote lineage: detected, counted content-free, and not yet enforced (#3059).

A promoted quote folded into a review carries its source's plaintext into a
body with its own tier. Whether that passage inherits the source's restriction
is owner decision D01, which the issue forbids assuming, so this slice only
*observes*: a resolver counts restricted lineage, and every egress operation on
a tainted entry logs one content-free shadow event. Nothing is blocked.

The two strict ``xfail`` tests at the bottom pin today's leak. They are not
suppression: ``strict=True`` turns them red the moment enforcement makes them
pass, so the marker has to be removed by the change that closes the gap.
"""

from __future__ import annotations

import ast
import json
import logging
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, date, datetime
from http import HTTPStatus
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession

from dependencies.creek_vault import get_creek_vault_client
from domain.creek_vault import (
    CreekCapability,
    CreekVaultError,
    CreekVaultUnavailableError,
    VaultIngestAction,
    VaultIngestRequest,
    VaultIngestResult,
    VaultTierCeiling,
    VaultVoiceDraftDeleteResult,
    VaultVoiceDraftRequest,
    VaultVoiceDraftResult,
)
from domain.frequencies import Frequency
from main import app
from models.corpus_fragment import CorpusSource
from models.goal import Goal
from models.habit import Habit
from models.journal_entry import JournalClassification, JournalEntry
from models.marginalia import Marginalia, MarginaliaKind
from models.promoted_quote import PromotedQuote
from services import frequency_classification
from services import marginalia as marginalia_service
from services.botmason import STUB_MODEL_NAME, LLMResponse
from services.corpus_store import FragmentDraft, record_fragment
from services.frequency_classification import UNCLASSIFIED
from services.higher_self_grounding import GroundingSource, gather_grounding
from services.privacy_lineage import (
    LINEAGE_SHADOW_EVENT,
    POLICY_VERSION,
    LineageCounts,
    LineageOperation,
    observe_entry_lineage,
    restricted_lineage_counts,
)
from services.privacy_suspension import VAULT_SEND_SUSPEND_ENV_VAR
from tests.incident.test_privacy_suspension import (
    _VaultRecorder,
    handshaken_vault,
    suspend_vault,
)
from tests.support.lineage_canaries import (
    LINEAGE_SENTINEL,
    REVIEW_PROSE,
    FoldedLineage,
    seed_folded_lineage,
)
from tests.support.reflecting_vault import DEFAULT_REFLECT_CAPABILITIES, ReflectingVaultClient

_SRC_ROOT = Path(__file__).resolve().parents[1] / "src"

_CLASSIFIED_REPLY = json.dumps({"weights": {Frequency.F5.value: 0.9}, "overall_confidence": 0.9})

_SHADOW_FIELDS = frozenset(
    {"operation", "user_id", "entry_id", "count", "withdrawn_count", "policy_version"}
)

#: Anchors on the review's own prose, so a resonance pass succeeds.
_ANCHORED_REPLY = (
    '{"notes":[{"kind":"theme","quote":"Some personal thoughts",'
    '"note":"A thoughtful observation."}]}'
)


class _CapturingLLM:
    """Records every prompt handed to ``generate_response`` and answers with ``reply``."""

    def __init__(self, reply: str = _ANCHORED_REPLY) -> None:
        self.prompts: list[str] = []
        self._reply = reply

    async def __call__(
        self, prompt: str, history: object, *, system_prompt: object, api_key: object
    ) -> LLMResponse:
        del history, system_prompt, api_key
        self.prompts.append(prompt)
        return LLMResponse(
            text=self._reply,
            provider="stub",
            model=STUB_MODEL_NAME,
            prompt_tokens=0,
            completion_tokens=0,
        )


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    """Sign up a writer; return their auth headers and id."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    payload = resp.json()
    return {"Authorization": f"Bearer {payload['token']}"}, int(payload["user_id"])


async def _set_source_tier(
    session: AsyncSession, source_id: int, classification: JournalClassification
) -> None:
    source = await session.get(JournalEntry, source_id)
    assert source is not None
    source.classification = classification
    session.add(source)
    await session.commit()


def _shadow_records(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [record for record in caplog.records if record.getMessage() == LINEAGE_SHADOW_EVENT]


def _shadow_summary(record: logging.LogRecord) -> tuple[object, object, object]:
    """``(operation, entry_id, count)`` off a shadow record's ``extra`` fields."""
    return (
        getattr(record, "operation", None),
        getattr(record, "entry_id", None),
        getattr(record, "count", None),
    )


def _assert_no_canary_in_logs(caplog: pytest.LogCaptureFixture) -> None:
    for record in caplog.records:
        assert LINEAGE_SENTINEL not in record.getMessage()
        for value in record.__dict__.values():
            assert LINEAGE_SENTINEL not in str(value)


@contextmanager
def _statements(session: AsyncSession) -> Iterator[list[str]]:
    """Collect the SQL of every statement ``session``'s engine executes inside the block."""
    seen: list[str] = []
    engine = session.get_bind()

    def _record(*args: object) -> None:
        seen.append(str(args[2]))

    event.listen(engine, "before_cursor_execute", _record)
    try:
        yield seen
    finally:
        event.remove(engine, "before_cursor_execute", _record)


# --- the resolver ------------------------------------------------------------


@pytest.mark.asyncio
async def test_restricted_lineage_counts_folded_quote_from_intimate_source(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The count follows the source's *current* tier and liveness, with no epoch."""
    _, user_id = await _signup(async_client, "lineage_counts")
    chain = await seed_folded_lineage(db_session, user_id=user_id)

    async def _counts() -> LineageCounts | None:
        found = await restricted_lineage_counts(
            db_session, user_id=user_id, entry_ids=[chain.review_id]
        )
        return found.get(chain.review_id)

    assert await _counts() == LineageCounts(restricted=1, withdrawn=0)

    await _set_source_tier(db_session, chain.source_id, JournalClassification.PERSONAL)
    assert await _counts() == LineageCounts(restricted=0, withdrawn=0)

    await _set_source_tier(db_session, chain.source_id, JournalClassification.INTIMATE)
    assert await _counts() == LineageCounts(restricted=1, withdrawn=0)

    await _set_source_tier(db_session, chain.source_id, JournalClassification.PERSONAL)
    source = await db_session.get(JournalEntry, chain.source_id)
    assert source is not None
    source.deleted_at = datetime.now(UTC)
    db_session.add(source)
    await db_session.commit()
    assert await _counts() == LineageCounts(restricted=0, withdrawn=1)


@pytest.mark.asyncio
async def test_a_deleted_intimate_source_is_withdrawn_not_also_restricted(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A source deleted while still Intimate is counted once, as withdrawn -- never conflated."""
    _, user_id = await _signup(async_client, "lineage_deleted_intimate")
    chain = await seed_folded_lineage(db_session, user_id=user_id)
    source = await db_session.get(JournalEntry, chain.source_id)
    assert source is not None
    assert source.classification == JournalClassification.INTIMATE
    source.deleted_at = datetime.now(UTC)
    db_session.add(source)
    await db_session.commit()

    found = await restricted_lineage_counts(
        db_session, user_id=user_id, entry_ids=[chain.review_id]
    )

    assert found == {chain.review_id: LineageCounts(restricted=0, withdrawn=1)}


@pytest.mark.asyncio
async def test_another_writers_quote_is_not_counted(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A quote row owned by someone else, pointing at this review, contributes nothing."""
    _, owner_id = await _signup(async_client, "lineage_owner")
    _, other_id = await _signup(async_client, "lineage_other")
    chain = await seed_folded_lineage(db_session, user_id=owner_id)
    foreign = await seed_folded_lineage(db_session, user_id=other_id)
    stray = await db_session.get(PromotedQuote, foreign.quote_id)
    assert stray is not None
    stray.included_in_entry_id = chain.review_id
    db_session.add(stray)
    await db_session.commit()

    found = await restricted_lineage_counts(
        db_session, user_id=owner_id, entry_ids=[chain.review_id]
    )

    assert found == {chain.review_id: LineageCounts(restricted=1, withdrawn=0)}


@pytest.mark.asyncio
async def test_lineage_resolver_issues_one_statement_and_never_reads_anchor_text(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """One query for many ids, none for none, and the quote's text is never selected."""
    _, user_id = await _signup(async_client, "lineage_one_query")
    chains = [await seed_folded_lineage(db_session, user_id=user_id) for _ in range(3)]

    with _statements(db_session) as seen:
        found = await restricted_lineage_counts(
            db_session, user_id=user_id, entry_ids=[chain.review_id for chain in chains]
        )
    assert len(seen) == 1
    assert "anchor_text" not in seen[0]
    assert set(found) == {chain.review_id for chain in chains}

    with _statements(db_session) as seen:
        assert await restricted_lineage_counts(db_session, user_id=user_id, entry_ids=[]) == {}
    assert seen == []


# --- the shadow event ----------------------------------------------------------


async def _resonate(client: AsyncClient, headers: dict[str, str], entry_id: int) -> dict[str, Any]:
    resp = await client.post(f"/journal/{entry_id}/resonance", headers=headers)
    assert resp.status_code == HTTPStatus.OK, resp.text
    body: dict[str, Any] = resp.json()
    return body


def _observable(body: dict[str, Any]) -> tuple[object, ...]:
    """The parts of a resonance answer that do not vary by account or clock."""
    notes = tuple((note["kind"], note["anchor_text"], note["note"]) for note in body["marginalia"])
    return (body.get("private"), notes)


@pytest.mark.asyncio
async def test_lineage_shadow_log_is_content_free_and_observation_only(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """One closed-schema record per pass on a tainted review, and the answer is unchanged."""
    spy = _CapturingLLM()
    monkeypatch.setattr(marginalia_service, "generate_response", spy)
    control_headers, control_id = await _signup(async_client, "lineage_control")
    control = await seed_folded_lineage(db_session, user_id=control_id)
    unlinked = await db_session.get(PromotedQuote, control.quote_id)
    await db_session.delete(unlinked)
    await db_session.commit()
    expected = _observable(await _resonate(async_client, control_headers, control.review_id))

    headers, user_id = await _signup(async_client, "lineage_shadow")
    chain = await seed_folded_lineage(db_session, user_id=user_id)
    caplog.clear()
    with caplog.at_level(logging.INFO):
        answered = await _resonate(async_client, headers, chain.review_id)

    assert _observable(answered) == expected
    records = _shadow_records(caplog)
    assert len(records) == 1
    record = records[0]
    assert {key: getattr(record, key) for key in _SHADOW_FIELDS} == {
        "operation": LineageOperation.RESONANCE.value,
        "user_id": user_id,
        "entry_id": chain.review_id,
        "count": 1,
        "withdrawn_count": 0,
        "policy_version": POLICY_VERSION,
    }
    extra_keys = set(record.__dict__) - set(logging.makeLogRecord({}).__dict__) - {"message"}
    assert extra_keys <= _SHADOW_FIELDS | {"request_id", "trace_id"}
    assert extra_keys >= _SHADOW_FIELDS
    _assert_no_canary_in_logs(caplog)


@pytest.mark.asyncio
async def test_prior_context_carrying_a_tainted_review_is_counted(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """An unrelated entry whose recency window holds the tainted review emits PRIOR_CONTEXT."""
    monkeypatch.setattr(marginalia_service, "generate_response", _CapturingLLM())
    headers, user_id = await _signup(async_client, "lineage_prior")
    await seed_folded_lineage(db_session, user_id=user_id)
    unrelated = JournalEntry(
        user_id=user_id,
        message=REVIEW_PROSE,
        sender="user",
        classification=JournalClassification.PERSONAL,
    )
    db_session.add(unrelated)
    await db_session.commit()
    await db_session.refresh(unrelated)

    caplog.clear()
    with caplog.at_level(logging.INFO):
        await _resonate(async_client, headers, int(unrelated.id or 0))

    records = _shadow_records(caplog)
    assert [_shadow_summary(r) for r in records] == [
        (LineageOperation.PRIOR_CONTEXT.value, unrelated.id, 1)
    ]
    _assert_no_canary_in_logs(caplog)


@pytest.mark.asyncio
async def test_corpus_grounding_from_a_tainted_review_is_counted(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """On the corpus path, a fragment derived from the tainted review reports PRIOR_CONTEXT."""
    _, user_id = await _signup(async_client, "lineage_corpus_prior")
    chain = await seed_folded_lineage(db_session, user_id=user_id)
    await record_fragment(
        db_session,
        user_id=user_id,
        draft=FragmentDraft(
            content=REVIEW_PROSE,
            tier=JournalClassification.PERSONAL,
            source=CorpusSource.JOURNAL,
            classification=UNCLASSIFIED,
            source_entry_id=chain.review_id,
        ),
    )
    await db_session.commit()
    subject = chain.review_id + 1_000

    caplog.clear()
    with caplog.at_level(logging.INFO):
        grounding = await gather_grounding(db_session, user_id=user_id, exclude_entry_id=subject)

    assert grounding.source is GroundingSource.CORPUS
    records = _shadow_records(caplog)
    assert [_shadow_summary(r) for r in records] == [
        (LineageOperation.PRIOR_CONTEXT.value, subject, 1)
    ]


async def _seed_note(session: AsyncSession, *, entry_id: int, user_id: int) -> int:
    note = Marginalia(
        journal_entry_id=entry_id,
        user_id=user_id,
        kind=MarginaliaKind.SYMBOL,
        anchor_start=0,
        anchor_end=4,
        anchor_text=REVIEW_PROSE[:4],
        note="A seed note.",
    )
    session.add(note)
    await session.commit()
    await session.refresh(note)
    return int(note.id or 0)


async def _drive_every_operation(
    client: AsyncClient,
    session: AsyncSession,
    writer: tuple[dict[str, str], int],
    chain: FoldedLineage,
) -> None:
    """Resonance, detection, a body edit and a first letter on the review."""
    headers, user_id = writer
    await _resonate(client, headers, chain.review_id)
    detect = await client.post(f"/journal/{chain.review_id}/suggestions/detect", headers=headers)
    assert detect.status_code == HTTPStatus.OK, detect.text
    review = await session.get(JournalEntry, chain.review_id)
    assert review is not None
    patch = await client.patch(
        f"/journal/{chain.review_id}",
        json={"message": f"{review.message}\n\nOne more line."},
        headers=headers,
    )
    assert patch.status_code == HTTPStatus.OK, patch.text
    note_id = await _seed_note(session, entry_id=chain.review_id, user_id=user_id)
    essay = await client.post(
        f"/journal/marginalia/{note_id}/essay",
        json={"price_acknowledged": True},
        headers=headers,
    )
    assert essay.status_code == HTTPStatus.OK, essay.text


class _DiallingVault(ReflectingVaultClient):
    """A connected vault that takes journal writes and Voice Drafts, so both really dial."""

    def __init__(self) -> None:
        super().__init__(capabilities=DEFAULT_REFLECT_CAPABILITIES | {CreekCapability.VOICE_DRAFTS})
        self.draft_upserts: list[VaultVoiceDraftRequest] = []

    async def upsert_voice_draft(self, request: VaultVoiceDraftRequest, /) -> VaultVoiceDraftResult:
        """Record and accept the draft."""
        self.draft_upserts.append(request)
        return VaultVoiceDraftResult(
            stored=True, vault_ref="voice-draft-1", action=VaultIngestAction.CREATED
        )

    async def delete_voice_draft(
        self, external_id: str, tier_ceiling: VaultTierCeiling, /
    ) -> VaultVoiceDraftDeleteResult:
        """Accept any retraction."""
        del external_id, tier_ceiling
        return VaultVoiceDraftDeleteResult(deleted=True)


def _wire_dialling_vault() -> _DiallingVault:
    vault = _DiallingVault()
    app.dependency_overrides[get_creek_vault_client] = lambda: vault
    return vault


def _fake_classifier(monkeypatch: pytest.MonkeyPatch) -> None:
    """Answer the corpus classifier's provider call, so a consented ingest really classifies."""

    async def classified(**_kwargs: object) -> SimpleNamespace:
        return SimpleNamespace(text=_CLASSIFIED_REPLY)

    monkeypatch.setattr(frequency_classification, "generate_response", classified)


async def _grant_corpus_consent(client: AsyncClient, headers: dict[str, str]) -> None:
    resp = await client.put(
        f"/corpus/consent/{CorpusSource.JOURNAL.value}", json={"granted": True}, headers=headers
    )
    assert resp.status_code == HTTPStatus.OK, resp.text


async def _seed_detection_candidate(session: AsyncSession, user_id: int) -> None:
    """One habit goal, so completion detection has a candidate and really dials."""
    habit = Habit(
        name="Meditation",
        icon="🧘",
        start_date=date(2025, 1, 1),
        energy_cost=1,
        energy_return=2,
        user_id=user_id,
    )
    session.add(habit)
    await session.commit()
    await session.refresh(habit)
    session.add(
        Goal(
            habit_id=habit.id,
            title="clear",
            tier="clear",
            target=1.0,
            target_unit="x",
            frequency=1.0,
            frequency_unit="per_day",
            is_additive=True,
        )
    )
    await session.commit()


def _shadowed_operations(caplog: pytest.LogCaptureFixture, entry_id: int) -> list[str]:
    return sorted(
        str(op)
        for op, subject, _ in map(_shadow_summary, _shadow_records(caplog))
        if subject == entry_id
    )


@pytest.mark.asyncio
async def test_each_egress_operation_on_a_tainted_review_emits_its_shadow(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """With every destination really dialled, each operation reports once with the count."""
    monkeypatch.setattr(marginalia_service, "generate_response", _CapturingLLM())
    _fake_classifier(monkeypatch)
    vault = _wire_dialling_vault()
    headers, user_id = await _signup(async_client, "lineage_every_op")
    await _grant_corpus_consent(async_client, headers)
    await _seed_detection_candidate(db_session, user_id)
    chain = await seed_folded_lineage(db_session, user_id=user_id)

    caplog.clear()
    with caplog.at_level(logging.INFO):
        await _drive_every_operation(async_client, db_session, (headers, user_id), chain)

    assert vault.ingest_calls, "the vault write never dialled"
    assert vault.draft_upserts, "the voice-draft mirror never dialled"
    assert _shadowed_operations(caplog, chain.review_id) == sorted(
        op.value
        for op in (
            LineageOperation.RESONANCE,
            LineageOperation.DETECT,
            LineageOperation.VAULT_WRITE,
            LineageOperation.CORPUS_INGEST,
            LineageOperation.ESSAY,
            LineageOperation.VOICE_DRAFT_MIRROR,
        )
    )
    _assert_no_canary_in_logs(caplog)


class _DegradingVault(_DiallingVault):
    """A vault that receives the body but does not confirm storing it."""

    def __init__(self, *, failure: CreekVaultError | None) -> None:
        super().__init__()
        self._failure = failure

    async def ingest(self, request: VaultIngestRequest, /) -> VaultIngestResult:
        """Record the body as sent, then fail the acknowledgement or decline to store."""
        self.ingest_calls.append(request)
        if self._failure is not None:
            raise self._failure
        return VaultIngestResult(stored=False, vault_ref=None)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure",
    [CreekVaultUnavailableError("synthetic timeout after receipt"), None],
    ids=["ingest_raises", "not_stored"],
)
async def test_a_degraded_vault_write_still_counts_as_sent(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
    failure: CreekVaultError | None,
) -> None:
    """The body reached the vault even when the write degraded, so the shadow fires once."""
    vault = _DegradingVault(failure=failure)
    app.dependency_overrides[get_creek_vault_client] = lambda: vault
    headers, user_id = await _signup(async_client, "lineage_degraded_vault")
    chain = await seed_folded_lineage(db_session, user_id=user_id)
    review = await db_session.get(JournalEntry, chain.review_id)
    assert review is not None

    caplog.clear()
    with caplog.at_level(logging.INFO):
        patch = await async_client.patch(
            f"/journal/{chain.review_id}",
            json={"message": f"{review.message}\n\nOne more line."},
            headers=headers,
        )

    assert patch.status_code == HTTPStatus.OK, patch.text
    assert vault.ingest_calls, "the degraded write never dialled"
    assert _shadowed_operations(caplog, chain.review_id) == [LineageOperation.VAULT_WRITE.value]
    _assert_no_canary_in_logs(caplog)


async def _edit_review(
    async_client: AsyncClient,
    db_session: AsyncSession,
    headers: dict[str, str],
    review_id: int,
) -> None:
    review = await db_session.get(JournalEntry, review_id)
    assert review is not None
    await db_session.refresh(review)
    patch = await async_client.patch(
        f"/journal/{review_id}",
        json={"message": f"{review.message}\n\nOne more line."},
        headers=headers,
    )
    assert patch.status_code == HTTPStatus.OK, patch.text


@pytest.mark.asyncio
async def test_a_suspended_vault_send_emits_no_shadow_until_resumed(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A send the operator switch refused left nothing to count; the first real send counts once.

    Driven through the real HTTP adapter, whose single request site is where
    ``PRIVACY_SUSPEND_VAULT_SEND`` refuses (#3075, #3107). Under the switch the
    vault sees only the content-free capability probe and no shadow is
    recorded; once the switch is lifted the next edit really dials, and the
    shadow is recorded exactly once.
    """
    recorder = _VaultRecorder()
    vault = await handshaken_vault(recorder)
    app.dependency_overrides[get_creek_vault_client] = lambda: vault
    headers, user_id = await _signup(async_client, "lineage_suspended_vault")
    chain = await seed_folded_lineage(db_session, user_id=user_id)

    suspend_vault(monkeypatch)
    caplog.clear()
    with caplog.at_level(logging.INFO):
        await _edit_review(async_client, db_session, headers, chain.review_id)

    assert "PUT" not in recorder.methods()
    assert _shadowed_operations(caplog, chain.review_id) == []

    monkeypatch.delenv(VAULT_SEND_SUSPEND_ENV_VAR)
    caplog.clear()
    with caplog.at_level(logging.INFO):
        await _edit_review(async_client, db_session, headers, chain.review_id)

    assert recorder.methods().count("PUT") == 1
    assert _shadowed_operations(caplog, chain.review_id) == [LineageOperation.VAULT_WRITE.value]
    _assert_no_canary_in_logs(caplog)


@pytest.mark.asyncio
async def test_operations_that_send_nothing_emit_no_shadow(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """No consent, no connected vault, no detection candidate: nothing leaves, nothing is counted.

    The default account has no vault (a local fallback that sends nothing), has
    agreed to no corpus ingest, and has no habit for detection to check -- so a
    body edit, a detection press and a first letter dial none of those three
    destinations, and only the model-bound operations report.
    """
    monkeypatch.setattr(marginalia_service, "generate_response", _CapturingLLM())
    headers, user_id = await _signup(async_client, "lineage_sends_nothing_ops")
    chain = await seed_folded_lineage(db_session, user_id=user_id)

    caplog.clear()
    with caplog.at_level(logging.INFO):
        await _drive_every_operation(async_client, db_session, (headers, user_id), chain)

    assert _shadowed_operations(caplog, chain.review_id) == sorted(
        op.value for op in (LineageOperation.RESONANCE, LineageOperation.ESSAY)
    )


@pytest.mark.asyncio
async def test_untainted_entry_emits_no_shadow_event(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A fold from a Personal source is not restricted lineage, so nothing is logged."""
    monkeypatch.setattr(marginalia_service, "generate_response", _CapturingLLM())
    headers, user_id = await _signup(async_client, "lineage_untainted")
    chain = await seed_folded_lineage(
        db_session, user_id=user_id, source_classification=JournalClassification.PERSONAL
    )

    caplog.clear()
    with caplog.at_level(logging.INFO):
        await _drive_every_operation(async_client, db_session, (headers, user_id), chain)

    assert _shadow_records(caplog) == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("classification", "deleted"),
    [
        (JournalClassification.INTIMATE, False),
        (JournalClassification.PERSONAL, True),
    ],
)
async def test_an_entry_that_sends_nothing_is_not_a_shadow(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
    classification: JournalClassification,
    *,
    deleted: bool,
) -> None:
    """An Intimate or deleted tainted review egresses nothing: no record, and no query either."""
    _, user_id = await _signup(async_client, "lineage_sends_nothing")
    chain = await seed_folded_lineage(db_session, user_id=user_id)
    review = await db_session.get(JournalEntry, chain.review_id)
    assert review is not None
    review.classification = classification
    review.deleted_at = datetime.now(UTC) if deleted else None
    db_session.add(review)
    await db_session.commit()
    await db_session.refresh(review)

    caplog.clear()
    with caplog.at_level(logging.INFO), _statements(db_session) as seen:
        await observe_entry_lineage(db_session, LineageOperation.VAULT_WRITE, review)

    assert seen == []
    assert _shadow_records(caplog) == []


# --- wiring --------------------------------------------------------------------


def _referenced_operations() -> set[str]:
    names: set[str] = set()
    for module in _SRC_ROOT.rglob("*.py"):
        if module.relative_to(_SRC_ROOT).as_posix() == "services/privacy_lineage.py":
            continue
        for node in ast.walk(ast.parse(module.read_text(encoding="utf-8"))):
            if (
                isinstance(node, ast.Attribute)
                and isinstance(node.value, ast.Name)
                and node.value.id == "LineageOperation"
            ):
                names.add(node.attr)
    return names


def test_every_lineage_operation_is_wired() -> None:
    """Each operation is reported from somewhere in ``src``, and nothing reports an unknown one."""
    assert _referenced_operations() == {op.name for op in LineageOperation}


# --- the leak, pinned until D01 ---------------------------------------------------
#
# Each strict xfail below has a passing control that runs the identical flow
# over a fixture whose review keeps the lineage link but not the spliced text.
# The control proves the flow reaches the model and that the canary arrives
# only through the fold, so the xfail is failing on the leak and nothing else.


#: An unrelated page's own words: distinct from the review, so finding the
#: review's prose in a prompt proves it arrived as grounding. Starts with the
#: phrase the canned reply quotes, so the pass anchors.
_UNRELATED_PROSE = "Some personal thoughts about the garden, a page of its own."


async def _unrelated_entry(session: AsyncSession, user_id: int) -> int:
    unrelated = JournalEntry(
        user_id=user_id,
        message=_UNRELATED_PROSE,
        sender="user",
        classification=JournalClassification.PERSONAL,
    )
    session.add(unrelated)
    await session.commit()
    await session.refresh(unrelated)
    return int(unrelated.id or 0)


@pytest.mark.asyncio
async def test_control_unfolded_review_reaches_the_model_without_the_canary(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Same flow as the direct pin, minus the spliced text: the model is reached, no canary."""
    spy = _CapturingLLM()
    monkeypatch.setattr(marginalia_service, "generate_response", spy)
    headers, user_id = await _signup(async_client, "lineage_control_direct")
    chain = await seed_folded_lineage(db_session, user_id=user_id, fold_text_into_review=False)

    await _resonate(async_client, headers, chain.review_id)

    assert spy.prompts
    assert all(LINEAGE_SENTINEL not in prompt for prompt in spy.prompts)


@pytest.mark.asyncio
async def test_control_unfolded_review_grounds_an_unrelated_entry_without_the_canary(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Same flow as the grounding pin, minus the spliced text: grounded, no canary."""
    spy = _CapturingLLM()
    monkeypatch.setattr(marginalia_service, "generate_response", spy)
    headers, user_id = await _signup(async_client, "lineage_control_prior")
    await seed_folded_lineage(db_session, user_id=user_id, fold_text_into_review=False)

    await _resonate(async_client, headers, await _unrelated_entry(db_session, user_id))

    assert spy.prompts
    assert any(REVIEW_PROSE in prompt for prompt in spy.prompts)
    assert all(LINEAGE_SENTINEL not in prompt for prompt in spy.prompts)


@pytest.mark.asyncio
@pytest.mark.xfail(strict=True, reason="D01 pending: lineage enforcement (#3059 AC9)")
async def test_folded_intimate_quote_never_reaches_resonance_prompt(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The Intimate source's words, folded into a Personal review, reach the model today."""
    spy = _CapturingLLM()
    monkeypatch.setattr(marginalia_service, "generate_response", spy)
    headers, user_id = await _signup(async_client, "lineage_leak_direct")
    chain = await seed_folded_lineage(db_session, user_id=user_id)

    await _resonate(async_client, headers, chain.review_id)

    assert spy.prompts, "the review's pass never reached the model"
    assert all(LINEAGE_SENTINEL not in prompt for prompt in spy.prompts)


@pytest.mark.asyncio
@pytest.mark.xfail(strict=True, reason="D01 pending: lineage enforcement (#3059 AC9)")
async def test_folded_intimate_quote_never_reaches_unrelated_entry_grounding(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Through the review, the Intimate source's words ground an unrelated entry's pass today."""
    spy = _CapturingLLM()
    monkeypatch.setattr(marginalia_service, "generate_response", spy)
    headers, user_id = await _signup(async_client, "lineage_leak_prior")
    await seed_folded_lineage(db_session, user_id=user_id)
    unrelated = JournalEntry(
        user_id=user_id,
        message=REVIEW_PROSE,
        sender="user",
        classification=JournalClassification.PERSONAL,
    )
    db_session.add(unrelated)
    await db_session.commit()
    await db_session.refresh(unrelated)

    await _resonate(async_client, headers, int(unrelated.id or 0))

    assert spy.prompts, "the unrelated entry's pass never reached the model"
    assert all(LINEAGE_SENTINEL not in prompt for prompt in spy.prompts)
