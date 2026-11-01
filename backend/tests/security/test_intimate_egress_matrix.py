"""An Intimate entry's words reach no sink outside the primary journal boundary (#3159, C07-C11).

The claims (#3069): an Intimate entry does not leave the primary private
journal boundary (C07), is not used for AI inference (C08), corpus indexing or
ontology extraction (C09), is not context for another entry (C10), and is not
replicated to Creek (C11). Each is a *forbidden effect*, so each is asserted
where the effect would happen: at the seam itself, by a recorder that captures
every byte that crossed it (:mod:`tests.support.egress_recorders`).

The matrix
==========

Rows are **derived**, not chosen: every route in
:data:`tests.security.test_egress_barrier_totality.BARRIERED` and every
detached entry point in ``DETACHED_ENTRY_POINTS`` must have at least one row,
and :func:`test_every_egress_door_has_a_matrix_row` fails on a door with none.
``BARRIERED`` is itself held to the call graph and the live route table by
that file's gate, so a new egress route lands here by way of both.

Columns are the lifecycle steps the canary can enter an Intimate entry by
(:class:`Step`): created Intimate, edited while Intimate, reclassified
Personal->Intimate, reclassified while an operation is in flight, and the same
entry after a restart replays durable work. Every cell runs: none is skipped
(:func:`test_every_cell_runs`). Where a row's act is the create itself, the
reclassify cells reclassify the row the create already committed -- after it
answered, or while its own outward dial is held open.

Every (row, step) cell runs once per payer (:class:`Payer`): the app seam, with
no key, and a writer's own ``X-LLM-API-Key`` (BYOK) on every request the flow
sends. A key pays for a call; it never consents to one, so an Intimate cell
builds no provider client for it, while a BYOK row's Personal twin shows the
client *is* built, with the twin's words, on that same flow.

Every cell runs its flow twice, on two accounts sharing the recorders. The
Intimate run asserts the canary is absent at every recorder outside the primary
boundary; then the **Personal twin** runs the identical flow with canaries of
its own and asserts they *arrive* where the row says they do. An absence from a
recorder the twin cannot reach would prove nothing.

Outside the matrix: the C10 transitive leg (reflecting on a second entry after
the source became Intimate) and C11's release test (a lost acknowledgment after
the remote commit, then Intimate, then a restart).

What a cell asserts for an Intimate entry:

* no provider client was built for the writer's key, and no provider dial,
  vault call or classifier input carried the canary (from the step's mark on: a
  Personal->Intimate reclassification legitimately sent the words *before* it);
* no corpus fragment holds it, and the modelled remote vault holds no copy --
  state, read after the flow, so a copy sent before the reclassification and
  never withdrawn still fails;
* no log record and no Sentry envelope carries it at any point;
* the owner can still read their own page through the primary journal.
"""

from __future__ import annotations

import asyncio
import base64
import enum
import json
import logging
import uuid
from collections.abc import AsyncGenerator, Awaitable, Callable, Coroutine, Mapping
from dataclasses import dataclass, field
from datetime import date
from functools import partial
from http import HTTPStatus
from typing import TYPE_CHECKING, Final

import pytest
import pytest_asyncio
import sentry_sdk
from sqlmodel import col, select

from dependencies.creek_vault import get_creek_vault_client, get_reflection_boundary
from domain.creek_vault import VaultPipelineStage
from domain.frequencies import Frequency
from domain.reading_recommendations import ReadingRequest
from main import app
from models.corpus_consent import ConsentDecision, CorpusConsentEvent
from models.course_stage import CourseStage
from models.goal import Goal
from models.habit import Habit
from models.invitation_signal import InvitationSignal
from models.journal_entry import JournalEntry
from models.marginalia import Marginalia, MarginaliaKind
from models.stage_content import StageContent
from models.vault_pipeline_run import VaultPipelineOutcome, VaultPipelineRun
from services import creek_vault_pipeline as pipeline
from services.content_repository import get_content_repository
from services.creek_vault_pipeline import VaultPipelineTrigger
from services.creek_vault_pipeline import _Continuation as Continuation
from services.creek_vault_pipeline import _continue_ladder_body as continue_ladder_body
from services.creek_vault_pipeline import _RunResult as RunResult
from services.creek_vault_voice_drafts import resume_voice_draft_retractions
from services.reflection_boundary import ReflectionBoundary
from tests.helpers.sentry_capture import capturing_sentry
from tests.helpers.telemetry_canaries import SHORT_CANARY
from tests.security.test_egress_barrier_totality import BARRIERED, DETACHED_ENTRY_POINTS
from tests.support.egress_recorders import (
    Ledger,
    Recorder,
    RecordingVault,
    TelemetryRecorder,
    carries,
    corpus_fragments,
    record_classifier_inputs,
    record_provider_constructions,
    record_provider_dials,
    recording_telemetry,
)
from tests.vault_client_doubles import RECORDED_VAULT, bind_every_account_to_a_recorded_vault

if TYPE_CHECKING:
    from httpx import AsyncClient, Response
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

_PASSWORD: Final = "secret12345"  # pragma: allowlist secret
#: A well-formed OpenAI-shaped key a BYOK cell sends. Never valid: no client is
#: really built for it (:func:`record_provider_constructions`).
_BYOK_KEY: Final = "sk-matrix-byok-not-a-real-key"  # pragma: allowlist secret
_BYOK_HEADER: Final = "X-LLM-API-Key"

#: A reply the classifier's parser accepts, placing the fragment on the ontology,
#: so a Personal twin's entry really becomes a corpus fragment.
_CLASSIFIED_REPLY: Final = json.dumps(
    {"weights": {Frequency.F5.value: 0.9}, "overall_confidence": 0.9}
)

#: How long a cell waits for an in-flight dial to reach its pause. Generous on
#: purpose: a loaded runner is slow, and a timeout here fails the cell loudly.
_RENDEZVOUS_SECONDS: Final = 30.0
#: Long enough for a competing request to reach the account barrier and queue.
_QUEUE_PROBE_SECONDS: Final = 0.2
#: The pipeline's retry backoff, shortened: the cells assert what is sent.
_FAST_RETRY_SECONDS: Final = 0.001

#: The document an import carries. Caller-supplied, so it never carries a canary.
_DOCUMENT_BASE64: Final = base64.b64encode(b"%PDF-1.7 synthetic field notes").decode("ascii")

#: The journal consent source the corpus writer reads.
_JOURNAL_SOURCE: Final = "journal"

_INTIMATE: Final = "intimate"
_PERSONAL: Final = "personal"


class Step(enum.StrEnum):
    """How the canary comes to sit in an Intimate entry."""

    CREATE = "create"
    EDIT = "edit"
    RECLASSIFY = "reclassify"
    RECLASSIFY_RACE = "reclassify-race"
    RESTART = "restart"


class Payer(enum.StrEnum):
    """Who a cell's requests say pays for a generation."""

    #: No key of the writer's own: only the armed stub test seam answers.
    APP_SEAM = "app-seam"
    #: The writer's own key, on every request the flow sends.
    BYOK = "byok"


class Expect(enum.Enum):
    """What a Personal twin must show at one recorder."""

    #: The canary arrives: the recorder is on this row's content path.
    CARRIES = "carries"
    #: The recorder is dialled, content-free by design: it is reachable here.
    FIRES = "fires"


# ── The harness ──────────────────────────────────────────────────────────────


def mint_canaries(unique: str) -> tuple[str, str]:
    """An account's (body, title) canaries, ``unique`` first (#3223).

    The probe (:func:`tests.helpers.telemetry_canaries.probes`) reads only a
    canary's head, so a shared prefix in front of the unique part would let
    one account's canary satisfy another's check.
    """
    return f"BODY_{unique}_{SHORT_CANARY}", f"TITLE_{unique}_{SHORT_CANARY}"


@dataclass
class Harness:
    """One account, its canaries, and every recorder, for one cell."""

    client: AsyncClient
    factory: async_sessionmaker[AsyncSession]
    ledger: Ledger
    vault: RecordingVault
    telemetry: TelemetryRecorder
    payer: Payer = Payer.APP_SEAM
    headers: dict[str, str] = field(default_factory=dict)
    user_id: int = 0
    canary: str = ""
    title_canary: str = ""

    def body(self, suffix: str = "") -> str:
        """The entry body: the canary, and something a person might write."""
        return f"{self.canary} I sat with the river this morning.{suffix}"

    async def another(self) -> Harness:
        """A second account on the same recorders, with canaries of its own."""
        other = Harness(
            self.client, self.factory, self.ledger, self.vault, self.telemetry, self.payer
        )
        await other.signup()
        return other

    async def signup(self) -> None:
        """Create the account this harness writes as, and mint its canaries."""
        unique = uuid.uuid4().hex
        self.canary, self.title_canary = mint_canaries(unique)
        tag = unique[:12]
        response = await self.client.post(
            "/auth/signup",
            json={"email": f"matrix-{tag}@example.com", "password": _PASSWORD},
        )
        assert response.status_code == HTTPStatus.OK, response.text
        payload = response.json()
        self.headers = {"Authorization": f"Bearer {payload['token']}"}
        self.user_id = int(payload["user_id"])
        self.pay_with(self.payer)

    def pay_with(self, payer: Payer) -> None:
        """Send every later request -- and a twin's, from :meth:`another` -- as ``payer``."""
        self.payer = payer
        self.headers.pop(_BYOK_HEADER, None)
        if payer is Payer.BYOK:
            self.headers[_BYOK_HEADER] = _BYOK_KEY

    async def consent(self, *, granted: bool = True) -> Response:
        """Agree (or not) to ontologizing this account's journal."""
        return await self.client.put(
            f"/corpus/consent/{_JOURNAL_SOURCE}", json={"granted": granted}, headers=self.headers
        )

    async def create(self, *, message: str, title: str | None, tier: str) -> int:
        """Write one entry and return its id."""
        response = await self.client.post(
            "/journal/",
            json={"message": message, "title": title, "classification": tier},
            headers=self.headers,
        )
        assert response.status_code == HTTPStatus.CREATED, response.text
        return int(response.json()["id"])

    async def patch(self, entry_id: int, **fields: str) -> Response:
        """Edit one entry."""
        return await self.client.patch(f"/journal/{entry_id}", json=fields, headers=self.headers)

    async def read_back(self, entry_id: int) -> Response:
        """The owner reading their own page through the primary journal."""
        return await self.client.get(f"/journal/{entry_id}", headers=self.headers)


def _ok(response: Response) -> None:
    """A route answered without a server error: absence must not come from a crash."""
    assert response.status_code < HTTPStatus.INTERNAL_SERVER_ERROR, response.text


# ── Seeds the acts need ──────────────────────────────────────────────────────


class ReadingRecordingVault(RecordingVault):
    """The optional model operation records the complete context it receives."""

    async def recommend_reading(self, request: ReadingRequest) -> None:
        """Record the actual model input; an empty recommendation is valid."""
        await self._dial("recommend_reading", json.dumps(request.wire_body()))


async def _seed_reading(h: Harness) -> None:
    """Make one real canonical chapter available without visiting the course."""
    async with h.factory() as session:
        stage = (
            await session.execute(select(CourseStage).where(CourseStage.stage_number == 1))
        ).scalar_one_or_none()
        if stage is None:
            stage = CourseStage(
                stage_number=1,
                title="Stage",
                subtitle="Stage",
                overview_url="",
                category="",
                aspect="",
                spiral_dynamics_color="",
                growing_up_stage="",
                divine_gender_polarity="",
                relationship_to_free_will="",
                free_will_description="",
            )
            session.add(stage)
            await session.flush()
            assert stage.id is not None
            chapter = get_content_repository().list_chapters()[0]
            session.add(
                StageContent(
                    course_stage_id=stage.id,
                    title=chapter.title,
                    content_type="essay",
                    release_day=1,
                    url=f"content://{chapter.id}",
                )
            )
        session.add(
            InvitationSignal(user_id=h.user_id, target_type="course", target_id=1, kind="readiness")
        )
        await session.commit()


async def _act_reading(h: Harness, entry_id: int) -> None:
    """List offers for finished writing, exercising the real source filter."""
    async with h.factory() as session:
        entry = await session.get(JournalEntry, entry_id)
        assert entry is not None
        entry.status = "finished"
        session.add(entry)
        await session.commit()
    mark = h.ledger.mark()
    _ok(await h.client.get("/invitations", headers=h.headers))
    async with h.factory() as session:
        current = await session.get(JournalEntry, entry_id)
        assert current is not None
        if current.classification == _PERSONAL:
            assert any(
                event.verb == "recommend_reading" and carries(event.payload, h.canary)
                for event in h.ledger.since(mark, Recorder.VAULT)
            )


async def _seed_habit(h: Harness) -> None:
    """Give the account one habit, so completion detection has a candidate to check."""
    async with h.factory() as session:
        habit = Habit(
            name="Meditation",
            icon="🧘",
            start_date=date(2026, 1, 1),
            energy_cost=1,
            energy_return=2,
            user_id=h.user_id,
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


async def _seed_note(h: Harness, entry_id: int) -> int:
    """A margin note on the entry, anchored in the canary, as resonance writes them."""
    async with h.factory() as session:
        note = Marginalia(
            journal_entry_id=entry_id,
            user_id=h.user_id,
            kind=MarginaliaKind.SYMBOL,
            anchor_start=0,
            anchor_end=len(h.canary),
            anchor_text=h.canary,
            note="A beginning.",
        )
        session.add(note)
        await session.commit()
        await session.refresh(note)
        assert note.id is not None
        return note.id


async def _seed_attempted_run(h: Harness) -> int:
    """A classification run that was in flight when the process went away."""
    async with h.factory() as session:
        run = VaultPipelineRun(
            user_id=h.user_id,
            stage=VaultPipelineStage.CLASSIFY.value,
            trigger=VaultPipelineTrigger.JOURNAL_WRITE.value,
            outcome=VaultPipelineOutcome.ATTEMPTED.value,
            job_id=None,
            attempt_count=1,
            fragments_seen=0,
            fragments_touched=0,
            fragments_lost=0,
        )
        session.add(run)
        await session.commit()
        await session.refresh(run)
        assert run.id is not None
        return run.id


async def _restart(h: Harness) -> None:
    """Stop in-process work, then run what a fresh process runs before traffic.

    The boot-time resume of durable pipeline runs (``main.lifespan``) and the
    recovery loop's withdrawal and retraction sweep, both against this vault.
    """
    await pipeline.close_vault_pipeline_tasks()
    await _seed_attempted_run(h)

    async def _client(_session: AsyncSession, _user_id: int) -> RecordingVault:
        return h.vault

    async def _destination(_session: AsyncSession, _user_id: int) -> str | None:
        return RECORDED_VAULT

    await pipeline.resume_vault_pipeline_runs(h.factory, _client)
    await pipeline.wait_for_vault_pipeline_tasks()
    await resume_voice_draft_retractions(h.factory, _client, _destination)


# ── The acts: one per door ───────────────────────────────────────────────────

Act = Callable[[Harness, int], Coroutine[object, object, None]]


async def _act_nothing(_h: Harness, _entry_id: int) -> None:
    """The step's own ``POST /journal/`` is this row's act."""


async def _act_edit(h: Harness, entry_id: int) -> None:
    _ok(await h.patch(entry_id, message=h.body(" Revised.")))


async def _act_delete(h: Harness, entry_id: int) -> None:
    _ok(await h.client.delete(f"/journal/{entry_id}", headers=h.headers))


async def _act_erase_locally(h: Harness, entry_id: int) -> None:
    _ok(await h.client.post(f"/journal/{entry_id}/erase-locally", headers=h.headers))


async def _act_resonance(h: Harness, entry_id: int) -> None:
    _ok(await h.client.post(f"/journal/{entry_id}/resonance", headers=h.headers))


async def _act_detect(h: Harness, entry_id: int) -> None:
    _ok(await h.client.post(f"/journal/{entry_id}/suggestions/detect", headers=h.headers))


async def _act_essay(h: Harness, entry_id: int) -> None:
    note_id = await _seed_note(h, entry_id)
    _ok(
        await h.client.post(
            f"/journal/marginalia/{note_id}/essay",
            json={"price_acknowledged": True},
            headers=h.headers,
        )
    )


async def _act_import(h: Harness, _entry_id: int) -> None:
    _ok(
        await h.client.post(
            "/corpus/import",
            json={
                "filename": "field-notes.pdf",
                "content_base64": _DOCUMENT_BASE64,
                "classification": _PERSONAL,
            },
            headers=h.headers,
        )
    )


async def _act_consent(h: Harness, _entry_id: int) -> None:
    _ok(await h.consent(granted=True))


async def _act_sweep(h: Harness, _entry_id: int) -> None:
    """Resume the backfill under a grant already standing, as ``POST /corpus/sweep`` does.

    The grant is recorded directly rather than through ``PUT /corpus/consent``,
    whose own sweep would reach the entry first and leave this door nothing to
    carry -- so the Personal twin's words can only have left by this route.
    """
    async with h.factory() as session:
        session.add(
            CorpusConsentEvent(
                user_id=h.user_id,
                source=_JOURNAL_SOURCE,
                decision=ConsentDecision.GRANTED.value,
            )
        )
        await session.commit()
    _ok(await h.client.post("/corpus/sweep", headers=h.headers))


async def _act_ladder(h: Harness, _entry_id: int) -> None:
    run_id = await _seed_attempted_run(h)
    await continue_ladder_body(
        Continuation(
            factory=h.factory,
            client=h.vault,
            user_id=h.user_id,
            trigger=VaultPipelineTrigger.JOURNAL_WRITE,
            pending=RunResult(run_id=run_id, outcome=VaultPipelineOutcome.ATTEMPTED),
            stage=VaultPipelineStage.CLASSIFY,
            remaining=(VaultPipelineStage.TEMPORAL,),
        )
    )


async def _act_resume(h: Harness, _entry_id: int) -> None:
    await pipeline.close_vault_pipeline_tasks()
    await _seed_attempted_run(h)

    async def _client(_session: AsyncSession, _user_id: int) -> RecordingVault:
        return h.vault

    await pipeline.resume_vault_pipeline_runs(h.factory, _client)
    await pipeline.wait_for_vault_pipeline_tasks()


# ── The rows ─────────────────────────────────────────────────────────────────

_Door = tuple[str, str] | str


@dataclass(frozen=True)
class Row:
    """One door, how to drive it, and what its Personal twin must show."""

    door: _Door
    variant: str
    act: Act
    expects: Mapping[Recorder, Expect]
    boundary: ReflectionBoundary = ReflectionBoundary.APP_PROVIDER
    #: Consent to ontologize is given before the step, so the corpus is live.
    preconsent: bool = True
    #: The act removes the page, so owner read-back is not expected after it.
    removes_page: bool = False
    #: The act's route reads ``X-LLM-API-Key`` and the app provider answers it,
    #: so a BYOK Personal twin must show a client built for the key.
    byok: bool = False
    prepare: Callable[[Harness], Awaitable[None]] | None = None

    @property
    def id(self) -> str:
        """A readable test id."""
        door = self.door if isinstance(self.door, str) else " ".join(self.door)
        return f"{door} [{self.variant}]" if self.variant else door


_WRITE_PATH: Final[Mapping[Recorder, Expect]] = {
    Recorder.VAULT: Expect.CARRIES,
    Recorder.CLASSIFIER: Expect.CARRIES,
    Recorder.CORPUS: Expect.CARRIES,
    Recorder.PROVIDER: Expect.CARRIES,
}

ROWS: Final[tuple[Row, ...]] = (
    Row(
        ("GET", "/invitations"),
        "managed reading",
        _act_reading,
        {Recorder.VAULT: Expect.CARRIES},
        prepare=_seed_reading,
    ),
    Row(
        ("POST", "/journal/"),
        "",
        _act_nothing,
        _WRITE_PATH,
    ),
    Row(("PATCH", "/journal/{entry_id}"), "body edit", _act_edit, _WRITE_PATH),
    Row(
        ("DELETE", "/journal/{entry_id}"),
        "",
        _act_delete,
        {Recorder.VAULT: Expect.FIRES},
        removes_page=True,
    ),
    Row(
        ("POST", "/journal/{entry_id}/erase-locally"),
        "",
        _act_erase_locally,
        {Recorder.VAULT: Expect.FIRES},
        removes_page=True,
    ),
    Row(
        ("POST", "/journal/{entry_id}/resonance"),
        "app provider",
        _act_resonance,
        {Recorder.PROVIDER: Expect.CARRIES},
        byok=True,
    ),
    Row(
        ("POST", "/journal/{entry_id}/resonance"),
        "vault bound",
        _act_resonance,
        {Recorder.VAULT: Expect.CARRIES},
        boundary=ReflectionBoundary.VAULT_BOUND,
    ),
    Row(
        ("POST", "/journal/{entry_id}/suggestions/detect"),
        "",
        _act_detect,
        {Recorder.PROVIDER: Expect.CARRIES},
        prepare=_seed_habit,
        byok=True,
    ),
    Row(
        ("POST", "/journal/marginalia/{marginalia_id}/essay"),
        "",
        _act_essay,
        # The stub provider echoes its prompt, so the letter -- a derivative -- carries
        # the canary to the vault as a Voice Draft. In the reclassify cells the mark
        # falls after the write, so only that draft can satisfy the vault column.
        {Recorder.PROVIDER: Expect.CARRIES, Recorder.VAULT: Expect.CARRIES},
        byok=True,
    ),
    Row(
        ("POST", "/journal/marginalia/{marginalia_id}/essay"),
        "vault bound",
        _act_essay,
        # The vault writes the letter itself (#3203): the entry reaches the vault
        # and only the vault, and the letter it keeps is the draft a
        # reclassification must withdraw.
        {Recorder.VAULT: Expect.CARRIES},
        boundary=ReflectionBoundary.VAULT_BOUND,
    ),
    Row(("POST", "/corpus/import"), "", _act_import, {Recorder.VAULT: Expect.FIRES}),
    Row(
        ("PUT", "/corpus/consent/{source}"),
        "",
        _act_consent,
        {
            Recorder.CLASSIFIER: Expect.CARRIES,
            Recorder.CORPUS: Expect.CARRIES,
            Recorder.PROVIDER: Expect.CARRIES,
        },
        preconsent=False,
    ),
    Row(
        ("POST", "/corpus/sweep"),
        "",
        _act_sweep,
        {
            Recorder.CLASSIFIER: Expect.CARRIES,
            Recorder.CORPUS: Expect.CARRIES,
            Recorder.PROVIDER: Expect.CARRIES,
        },
        preconsent=False,
    ),
    Row(
        "the detached ontologization ladder",
        "",
        _act_ladder,
        {Recorder.VAULT: Expect.FIRES},
    ),
    Row(
        "the boot-time resume of durable pipeline runs",
        "",
        _act_resume,
        {Recorder.VAULT: Expect.FIRES},
    ),
)


def missing_rows(
    rows: tuple[Row, ...], barriered: frozenset[tuple[str, str]], detached: frozenset[str]
) -> frozenset[_Door]:
    """Every egress door with no matrix row."""
    covered = frozenset(row.door for row in rows)
    return frozenset[_Door](barriered | detached) - covered


#: Every (row, step, payer) cell. None carries a mark: a skipped cell is a silent
#: gap in the claim (#3200), so a cell that cannot run must be argued out of the
#: matrix in ``docs/privacy/claim-coverage.md``, not skipped in it.
CELLS: Final = [
    pytest.param(row, step, payer, id=f"{row.id}-{step}-{payer}")
    for row in ROWS
    for step in Step
    for payer in Payer
]


# ── Fixtures ─────────────────────────────────────────────────────────────────


@pytest_asyncio.fixture(autouse=True)
async def _isolate_background_pipeline_tasks() -> AsyncGenerator[None, None]:
    """Give each cell an empty in-process continuation registry, before and after."""
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
    """One signed-up account, its vault, and every recorder armed."""
    bind_every_account_to_a_recorded_vault(monkeypatch)
    # A resumed run with no job handle retries its rung after this backoff; the
    # order of what is sent is the property, not the production clock.
    monkeypatch.setattr(pipeline, "_RETRY_INITIAL_SECONDS", _FAST_RETRY_SECONDS)
    ledger = Ledger()
    vault = ReadingRecordingVault(ledger)
    app.dependency_overrides[get_creek_vault_client] = lambda: vault
    assert record_provider_dials(monkeypatch, ledger, classifier_reply=_CLASSIFIED_REPLY), (
        "no module binds the provider dial: the provider recorder would watch nothing"
    )
    assert record_provider_constructions(monkeypatch, ledger), (
        "no provider is registered: the construction recorder would watch nothing"
    )
    record_classifier_inputs(monkeypatch, ledger)
    with (
        capturing_sentry(monkeypatch) as sentry_events,
        recording_telemetry(monkeypatch, sentry_events) as telemetry,
    ):
        h = Harness(concurrent_async_client, concurrent_session_factory, ledger, vault, telemetry)
        await h.signup()
        yield h


# ── Driving one cell ─────────────────────────────────────────────────────────


async def _newest_entry_id(h: Harness) -> int:
    """The id of the account's most recently committed entry, read from the database."""
    async with h.factory() as session:
        newest = (
            select(JournalEntry.id)
            .where(col(JournalEntry.user_id) == h.user_id)
            .order_by(col(JournalEntry.id).desc())
        )
        found: int | None = (await session.execute(newest)).scalars().first()
    assert found is not None, "the create dialled out before committing its row"
    return found


async def _race(
    h: Harness,
    tier: str,
    flight: Callable[[], Coroutine[object, object, object]],
    entry_id: int | None,
    *,
    dial_verb: str | None = None,
) -> tuple[int, int]:
    """Hold ``flight``'s first dial open, reclassify meanwhile, then let it finish.

    ``entry_id`` is the entry to reclassify; ``None`` means ``flight`` is the
    create itself, which commits its row before it dials out
    (``routers.journal.create_journal_entry``), so the id is read from the
    database while the dial is held -- the response has not been sent yet.

    ``dial_verb`` selects the protected model call rather than an earlier
    content-free probe, and requires reclassification to queue while it runs.

    Returns the entry and the mark after which nothing may carry the canary:
    the moment the reclassification answered. For the Personal twin nothing is
    reclassified, and the mark is where the flight began.
    """
    start = h.ledger.mark()
    h.ledger.arm_pause(
        frozenset({Recorder.VAULT, Recorder.PROVIDER, Recorder.CLASSIFIER}), verb=dial_verb
    )
    in_flight = asyncio.create_task(flight())
    try:
        await asyncio.wait_for(h.ledger.paused.wait(), _RENDEZVOUS_SECONDS)
        if entry_id is None:
            entry_id = await _newest_entry_id(h)
        if tier == _PERSONAL:
            h.ledger.release.set()
            await in_flight
            return entry_id, start

        async def reclassify() -> tuple[Response, int]:
            response = await h.patch(entry_id, classification=_INTIMATE)
            return response, h.ledger.mark()

        reclassifying = asyncio.create_task(reclassify())
        await asyncio.sleep(_QUEUE_PROBE_SECONDS)
        if dial_verb is not None:
            assert not reclassifying.done(), "reclassification acknowledged during model egress"
        h.ledger.release.set()
        await in_flight
        reclassified, acknowledged_mark = await reclassifying
    finally:
        h.ledger.disarm_pause()
    assert reclassified.status_code in {HTTPStatus.OK, HTTPStatus.NOT_FOUND}, reclassified.text
    return entry_id, acknowledged_mark


async def _drive(h: Harness, row: Row, step: Step, tier: str) -> tuple[int, int]:
    """Put the canary into an entry by ``step``, drive the row; return (entry, mark).

    The mark is the first ledger position that counts for this flow: where it
    began, or -- after a Personal->Intimate reclassification -- where the entry
    stopped being Personal. A Personal twin whose row has no act of its own (the
    create is the act) keeps the mark where it began, so its create is what it
    must show reaching the recorders.
    """
    mark = h.ledger.mark()
    if row.preconsent:
        _ok(await h.consent())
    if row.prepare is not None:
        await row.prepare(h)
    if step in {Step.CREATE, Step.RESTART}:
        entry_id = await h.create(message=h.body(), title=h.title_canary, tier=tier)
    elif step is Step.EDIT:
        entry_id = await h.create(message="A quiet morning.", title=None, tier=tier)
        _ok(await h.patch(entry_id, message=h.body(), title=h.title_canary))
    elif step is Step.RECLASSIFY_RACE and row.act is _act_nothing:
        return await _race(
            h, tier, partial(h.create, message=h.body(), title=h.title_canary, tier=_PERSONAL), None
        )
    else:
        entry_id = await h.create(message=h.body(), title=h.title_canary, tier=_PERSONAL)
        if step is Step.RECLASSIFY_RACE:
            return await _race(
                h,
                tier,
                partial(row.act, h, entry_id),
                entry_id,
                dial_verb="recommend_reading" if row.act is _act_reading else None,
            )
        if tier == _INTIMATE:
            _ok(await h.patch(entry_id, classification=_INTIMATE))
        if tier == _INTIMATE or row.act is not _act_nothing:
            mark = h.ledger.mark()
    await row.act(h, entry_id)
    if step is Step.RESTART:
        await _restart(h)
    return entry_id, mark


def _leaks(h: Harness, canary: str, mark: int) -> list[str]:
    """Every place outside the boundary the canary was found."""
    return [
        *(f"{e.recorder}: {e.verb}" for e in h.ledger.carrying(canary, since=mark)),
        *(f"vault still holds {key}" for key in h.vault.remote_copies_carrying(canary)),
        *(f"telemetry: {blob[:120]}" for blob in h.telemetry.carrying(canary)),
    ]


async def _assert_absent(h: Harness, row: Row, step: Step, entry_id: int, mark: int) -> None:
    """The Intimate half: no client built, no canary at any recorder outside the boundary."""
    built = [e.verb for e in h.ledger.since(mark, Recorder.PROVIDER_CLIENT)]
    assert built == [], f"a provider client was built for an Intimate entry: {built}"
    fragments = await corpus_fragments(h.factory)
    for canary in (h.canary, h.title_canary):
        assert _leaks(h, canary, mark) == []
        assert not [f for f in fragments if carries(f, canary)], "a corpus fragment kept it"
    if not row.removes_page and step is not Step.RECLASSIFY_RACE:
        # The owner's own lookup through the primary journal stays allowed.
        page = await h.read_back(entry_id)
        assert page.status_code == HTTPStatus.OK, page.text
        assert h.canary in page.json()["message"]


def _expects(h: Harness, row: Row) -> Mapping[Recorder, Expect]:
    """What this twin must show: the row's recorders, plus the key's client on a BYOK row."""
    if row.byok and h.payer is Payer.BYOK:
        return {**row.expects, Recorder.PROVIDER_CLIENT: Expect.CARRIES}
    return row.expects


async def _assert_reached(h: Harness, row: Row, mark: int) -> None:
    """The Personal twin: every recorder this row relies on really fires, or carries."""
    for recorder, expect in _expects(h, row).items():
        if recorder is Recorder.CORPUS:
            fragments = await corpus_fragments(h.factory)
            assert [f for f in fragments if carries(f, h.canary)], (
                "the corpus recorder never held the twin's canary"
            )
            continue
        seen = h.ledger.since(mark, recorder)
        assert seen, f"{recorder} was never dialled in the twin's flow"
        if expect is Expect.CARRIES:
            assert [e for e in seen if carries(e.payload, h.canary)], (
                f"{recorder} was dialled but never carried the twin's canary: "
                f"{[e.verb for e in seen]}"
            )


# ── The matrix ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize(("row", "step", "payer"), CELLS)
async def test_intimate_canary_reaches_no_forbidden_sink(
    harness: Harness, row: Row, step: Step, payer: Payer
) -> None:
    """Zero Intimate canaries outside the primary boundary; the Personal twin reaches each recorder.

    The Intimate flow runs first, on one account; then its Personal twin, the
    identical flow on a second account with canaries of its own, shows every
    recorder the row relies on is live -- so the first half's absence is a
    finding, not a silence. Under :attr:`Payer.BYOK` every request both flows
    send carries the writer's own key, and a BYOK row's twin must build a client
    for it -- so the Intimate flow's zero constructions are a refusal, not a key
    the route never read.
    """
    app.dependency_overrides[get_reflection_boundary] = lambda: row.boundary
    harness.pay_with(payer)
    entry_id, mark = await _drive(harness, row, step, _INTIMATE)
    await _assert_absent(harness, row, step, entry_id, mark)

    twin = await harness.another()
    _twin_entry, twin_mark = await _drive(twin, row, step, _PERSONAL)
    await _assert_reached(twin, row, twin_mark)

    assert harness.telemetry.handler.rendered, "the telemetry recorder saw no record at all"
    assert harness.telemetry.carrying(harness.canary) == []
    assert harness.telemetry.carrying(harness.title_canary) == []


# ── Derivation, cells and recorder liveness ──────────────────────────────────


def test_every_egress_door_has_a_matrix_row() -> None:
    """A barriered route or detached entry point with no row fails here."""
    missing = missing_rows(ROWS, BARRIERED, frozenset(DETACHED_ENTRY_POINTS))

    assert missing == frozenset(), f"egress doors with no Intimate matrix row: {missing}"


def test_a_planted_door_with_no_row_is_reported() -> None:
    """The derivation guard sees a new route, rather than passing over it."""
    planted = ("POST", "/journal/{entry_id}/planted-egress")

    missing = missing_rows(ROWS, BARRIERED | {planted}, frozenset(DETACHED_ENTRY_POINTS))

    assert missing == {planted}


def test_every_row_names_a_live_door() -> None:
    """The other direction: a row for a door that no longer exists hides a gap."""
    live = frozenset[_Door](BARRIERED | frozenset(DETACHED_ENTRY_POINTS))

    assert {row.door for row in ROWS} <= live


def test_every_cell_runs() -> None:
    """Every door meets every step, and no cell is skipped or expected to fail (#3200)."""
    marked = [cell.id for cell in CELLS if cell.marks]

    assert len(CELLS) == len(ROWS) * len(Step) * len(Payer)
    assert marked == []


def test_a_byok_row_reaches_the_keyed_client() -> None:
    """The BYOK leg's positive control exists: some row's BYOK twin must build a client."""
    assert [row.id for row in ROWS if row.byok]


def test_every_content_recorder_has_a_carrying_twin() -> None:
    """Each recorder's positive control exists: some row's Personal twin must carry the canary."""
    carried = {
        recorder
        for row in ROWS
        for recorder, expect in row.expects.items()
        if expect is Expect.CARRIES
    }

    assert carried >= {Recorder.PROVIDER, Recorder.VAULT, Recorder.CLASSIFIER, Recorder.CORPUS}


@pytest.mark.asyncio
async def test_the_telemetry_recorder_detects_a_planted_canary(harness: Harness) -> None:
    """The telemetry recorder's positive control: both its halves are live.

    Personal content must not reach telemetry either (C12), so no twin can
    supply this control. A canary planted in a log record must be found; and an
    event captured through the production Sentry client must arrive as an
    envelope. (The production scrubber withholds the planted message itself --
    that is C12's property, asserted in ``test_telemetry_sentinels.py``; here it
    only matters that the envelope half is not deaf.)
    """
    before = len(harness.telemetry.sentry_events)
    logging.getLogger("adepthood.matrix_probe").warning("probe %s", harness.canary)
    sentry_sdk.capture_message(f"probe {harness.title_canary}")
    sentry_sdk.flush()

    assert harness.telemetry.carrying(harness.canary), "a planted log record was not seen"
    assert len(harness.telemetry.sentry_events) > before, "no Sentry envelope was captured"


# ── Canaries: one account's never satisfies another's probe (#3223) ──────────

#: Two account tags that differ only in their final character: the worst case
#: for a probe that reads a canary's head.
_NEAR_TWIN_TAGS: Final = ("0" * 32, "0" * 31 + "1")


def test_canaries_are_distinct_within_the_probe_window() -> None:
    """No probe of one canary occurs in another: every minted canary is unique where it is read.

    The probe reads a fixed-length head of the canary, so the part that tells
    two accounts (and a body from a title) apart must sit inside that head.
    """
    minted = [canary for tag in _NEAR_TWIN_TAGS for canary in mint_canaries(tag)]

    collisions = [
        (mine, other)
        for mine in minted
        for other in minted
        if mine != other and carries(other, mine)
    ]

    assert len(set(minted)) == len(minted)
    assert collisions == []


@pytest.mark.asyncio
async def test_another_accounts_canary_satisfies_neither_check(harness: Harness) -> None:
    """Negative control: account A's canary planted where only B's belongs fails the matrix.

    It must not pass B's Personal positive control, must not read as B's leak,
    and must still be found as A's own.
    """
    twin = await harness.another()
    mark = harness.ledger.mark()
    planted = f"{harness.body()} {harness.title_canary}"
    harness.ledger.record(Recorder.VAULT, "ingest_journal", planted)
    row = Row("a planted door", "", _act_nothing, {Recorder.VAULT: Expect.CARRIES})

    with pytest.raises(AssertionError, match="never carried the twin's canary"):
        await _assert_reached(twin, row, mark)
    assert _leaks(twin, twin.canary, mark) == []
    assert _leaks(twin, twin.title_canary, mark) == []
    assert _leaks(harness, harness.canary, mark)
    assert _leaks(harness, harness.title_canary, mark)


# ── C10: the transitive leg ──────────────────────────────────────────────────


async def _reflect_on_another_entry(h: Harness, *, make_source_intimate: bool) -> list[str]:
    """Reflect on a source, maybe make it Intimate, then reflect on another entry.

    Returns the payload of every provider dial the *second* reflection made.
    """
    source = await h.create(message=h.body(), title=h.title_canary, tier=_PERSONAL)
    _ok(await h.client.post(f"/journal/{source}/resonance", headers=h.headers))
    if make_source_intimate:
        _ok(await h.patch(source, classification=_INTIMATE))
    other = await h.create(message="A walk in the rain.", title=None, tier=_PERSONAL)
    mark = h.ledger.mark()
    _ok(await h.client.post(f"/journal/{other}/resonance", headers=h.headers))
    dials = [e.payload for e in h.ledger.since(mark, Recorder.PROVIDER)]
    assert dials, "the second entry's reflection never reached the provider"
    return dials


@pytest.mark.asyncio
async def test_reflecting_on_another_entry_carries_no_intimate_source(harness: Harness) -> None:
    """Reflect on a second entry after the source became Intimate: no source canary in its prompt.

    The source is reflected on while Personal first, so a letter, notes and
    quotes derived from it exist; then it is made Intimate. Whatever reaches the
    provider for the *second* entry -- prompt, prior letters, quotes, grounding
    excerpts -- must carry none of it. The Personal twin keeps its source
    Personal and shows the source does reach that context when it may.

    The folded-quote case -- an Intimate passage quoted into a separately
    labelled entry -- is pinned in ``tests/test_privacy_lineage.py``: owner
    decision R5-2 (#3059) excludes that text, and the rest of D01 is still open.
    """
    app.dependency_overrides[get_reflection_boundary] = lambda: ReflectionBoundary.APP_PROVIDER

    dials = await _reflect_on_another_entry(harness, make_source_intimate=True)
    twin = await harness.another()
    twin_dials = await _reflect_on_another_entry(twin, make_source_intimate=False)

    for canary in (harness.canary, harness.title_canary):
        assert [d for d in dials if carries(d, canary)] == [], (
            "an Intimate source was context for another entry"
        )
    assert [d for d in twin_dials if carries(d, twin.canary)], (
        "a Personal source never reached another entry's context: the leg proves nothing"
    )


# ── C11: a lost acknowledgment, then Intimate, then a restart ────────────────


@pytest.mark.asyncio
async def test_a_copy_whose_acknowledgment_was_lost_is_withdrawn_after_intimate_and_restart(
    harness: Harness,
) -> None:
    """C11's release test: the remote commit happened, the local ack did not.

    The vault stores the body and the call then fails, so adepthood never
    learns a ref. The entry is made Intimate and the process restarts. No copy
    may remain in the vault.
    """
    harness.vault.lose_ingest_acks = True
    entry_id = await harness.create(message=harness.body(), title=None, tier=_PERSONAL)
    assert harness.vault.remote_copies_carrying(harness.canary), "the fault was not injected"
    harness.vault.lose_ingest_acks = False

    _ok(await harness.patch(entry_id, classification=_INTIMATE))
    await _restart(harness)

    assert harness.vault.remote_copies_carrying(harness.canary) == []
