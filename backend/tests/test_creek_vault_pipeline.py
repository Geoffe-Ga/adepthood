"""What adepthood does with a vault that advertises Creek's batch pipeline.

A vault takes journal entries and documents and files them as fragments, but a
fragment nobody classified carries no APTITUDE frequency, no Archetypal
Wavelength phase and no links -- so the reflection surface, the wheel read and
the invitation engine all run over an inert corpus. Creek's answer is two batch
routes, ``POST /v1/classifications`` and ``POST /v1/links``, and until now
adepthood called neither.

Every wire shape asserted here is read out of the vendored bundle under
``tests/fixtures/creek_v1/`` rather than written down a second time. The two
request schemas are ``additionalProperties: false``, so a body carrying a field
adepthood invented fails validation here instead of at a live vault -- which is
the whole reason the bundle is vendored.
"""

from __future__ import annotations

import json
from collections.abc import AsyncGenerator, Callable, Mapping
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
import pytest_asyncio
from jsonschema import Draft202012Validator
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.creek_vault import (
    CreekCapabilityUnsupportedError,
    VaultLinkStage,
    VaultPipelineStage,
)
from models.vault_pipeline_run import VaultPipelineOutcome, VaultPipelineRun
from services import creek_vault_pipeline as pipeline
from services.creek_vault_client import (
    HttpCreekVaultClient,
    LocalFallbackCreekVaultClient,
)
from services.creek_vault_pipeline import VaultPipelineTrigger, drive_vault_pipeline

_VAULT_URL = "https://vault.example.test"
_API_KEY = "test-key"  # pragma: allowlist secret
_OWNER = 1

_BUNDLE = Path(__file__).parent / "fixtures" / "creek_v1"

_CLASSIFICATIONS_PATH = "/v1/classifications"
_LINKS_PATH = "/v1/links"
_CAPABILITIES_PATH = "/v1/capabilities"

# The read budget the adapter applies to every non-pipeline call. The cold
# embedding stages exist precisely because they cannot fit inside it, so a
# recorded read timeout at or below this number means the per-call deadline
# never reached httpx and the feature is a no-op.
_ORDINARY_READ_BUDGET_SECONDS = 10.0


def _example(capability: str, cell: str) -> dict[str, Any]:
    """Load one vendored example body."""
    path = _BUNDLE / "examples" / capability / f"{cell}.json"
    loaded: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return loaded


def _schema(name: str) -> Draft202012Validator:
    """Load one vendored schema as a validator."""
    path = _BUNDLE / "schemas" / f"{name}.schema.json"
    return Draft202012Validator(json.loads(path.read_text(encoding="utf-8")))


def _link_body(stage: str) -> dict[str, Any]:
    """A LinkResponse shaped like the vendored one, echoing ``stage``."""
    body = _example("pipeline", "empty")
    body["method"] = stage
    body["fragment_count"] = 12
    body["link_count"] = 7
    return body


class _Recorder:
    """A MockTransport handler recording every request that reached the wire."""

    def __init__(
        self,
        *,
        classification: httpx.Response | None = None,
        link: Callable[[str], httpx.Response] | None = None,
    ) -> None:
        """Bind optional overrides for either pipeline route."""
        self.requests: list[httpx.Request] = []
        self.bodies: list[Any] = []
        self._classification = classification
        self._link = link

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Answer one request, recording it first."""
        self.requests.append(request)
        self.bodies.append(json.loads(request.content) if request.content else None)
        if request.url.path == _CAPABILITIES_PATH:
            return httpx.Response(200, json=_example("capabilities", "success"))
        if request.url.path == _CLASSIFICATIONS_PATH:
            if self._classification is not None:
                return self._classification
            return httpx.Response(200, json=_example("pipeline", "success"))
        if request.url.path == _LINKS_PATH:
            stage = json.loads(request.content)["method"]
            if self._link is not None:
                return self._link(stage)
            return httpx.Response(200, json=_link_body(stage))
        return httpx.Response(404, json={"code": "not_found", "message": "no", "request_id": "r"})

    @property
    def paths(self) -> list[str]:
        """The path of every request that reached the wire, in order."""
        return [request.url.path for request in self.requests]

    @property
    def pipeline_bodies(self) -> list[Any]:
        """The decoded body of every pipeline request, in order."""
        return [
            body
            for request, body in zip(self.requests, self.bodies, strict=True)
            if request.url.path in {_CLASSIFICATIONS_PATH, _LINKS_PATH}
        ]


@pytest_asyncio.fixture
async def http_clients() -> AsyncGenerator[Callable[[_Recorder], httpx.AsyncClient], None]:
    """Yield a factory for MockTransport-backed clients, closing each afterwards."""
    built: list[httpx.AsyncClient] = []

    def _build(handler: _Recorder) -> httpx.AsyncClient:
        """Build one in-memory client and register it for teardown."""
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        built.append(client)
        return client

    yield _build
    for client in built:
        await client.aclose()


@pytest_asyncio.fixture
async def handshaken() -> Callable[[_Recorder, httpx.AsyncClient], Any]:
    """Yield a builder for an already-handshaken HTTP client."""

    async def _build(recorder: _Recorder, http: httpx.AsyncClient) -> HttpCreekVaultClient:
        client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http)
        await client.handshake()
        recorder.requests.clear()
        recorder.bodies.clear()
        return client

    return _build


async def _rows(session: AsyncSession) -> list[VaultPipelineRun]:
    """Every pipeline row in the order it was written."""
    result = await session.execute(select(VaultPipelineRun).order_by(col(VaultPipelineRun.id)))
    return list(result.scalars().all())


@pytest.mark.asyncio
async def test_an_import_runs_the_published_classify_then_link_ladder_on_its_own_budget(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
) -> None:
    """The deep trigger drives classify then the three link stages, in order."""
    recorder = _Recorder()
    client = await handshaken(recorder, http_clients(recorder))

    await drive_vault_pipeline(
        db_session,
        client,
        user_id=_OWNER,
        trigger=VaultPipelineTrigger.DOCUMENT_IMPORT,
    )

    assert recorder.paths == [
        _CLASSIFICATIONS_PATH,
        _LINKS_PATH,
        _LINKS_PATH,
        _LINKS_PATH,
    ]
    assert recorder.pipeline_bodies == [
        {"method": "rules"},
        {"method": "temporal"},
        {"method": "eddies"},
        {"method": "threads"},
    ]

    classification_schema = _schema("ClassificationRequest")
    link_schema = _schema("LinkRequest")
    classification_schema.validate(recorder.pipeline_bodies[0])
    for body in recorder.pipeline_bodies[1:]:
        link_schema.validate(body)

    for request in recorder.requests:
        assert request.headers["X-Creek-Contract-Version"] == "0.10"
        assert request.headers["X-Creek-Tier-Ceiling"] == "personal"

    budgets = [request.extensions["timeout"]["read"] for request in recorder.requests]
    assert budgets[2] > _ORDINARY_READ_BUDGET_SECONDS
    assert budgets[3] > _ORDINARY_READ_BUDGET_SECONDS

    rows = await _rows(db_session)
    assert [row.stage for row in rows] == [
        VaultPipelineStage.CLASSIFY,
        VaultPipelineStage.TEMPORAL,
        VaultPipelineStage.EDDIES,
        VaultPipelineStage.THREADS,
    ]
    assert {row.outcome for row in rows} == {VaultPipelineOutcome.COMPLETED}
    assert rows[0].fragments_seen == 12
    assert rows[0].fragments_touched == 10
    assert rows[0].fragments_lost == 0


@pytest.mark.asyncio
async def test_a_journal_save_never_reaches_an_embedding_stage(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
) -> None:
    """The write path runs the cheap half only, and under the ordinary budget."""
    recorder = _Recorder()
    client = await handshaken(recorder, http_clients(recorder))

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.JOURNAL_WRITE
    )

    assert recorder.pipeline_bodies == [{"method": "rules"}, {"method": "temporal"}]
    for request in recorder.requests:
        assert request.extensions["timeout"]["read"] <= _ORDINARY_READ_BUDGET_SECONDS


@pytest.mark.asyncio
async def test_a_vault_that_never_advertised_pipeline_is_never_dialled(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
) -> None:
    """A vault whose capability document omits pipeline costs no request and no row."""

    class _NoPipeline(_Recorder):
        def __call__(self, request: httpx.Request) -> httpx.Response:
            if request.url.path == _CAPABILITIES_PATH:
                self.requests.append(request)
                self.bodies.append(None)
                document = _example("capabilities", "success")
                document["capabilities"] = [
                    name for name in document["capabilities"] if name != "pipeline"
                ]
                return httpx.Response(200, json=document)
            return super().__call__(request)

    recorder = _NoPipeline()
    client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http_clients(recorder))
    await client.handshake()
    recorder.requests.clear()

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.DOCUMENT_IMPORT
    )

    assert recorder.requests == []
    assert await _rows(db_session) == []


@pytest.mark.asyncio
async def test_a_vault_less_user_makes_no_extra_call_and_writes_no_row(
    db_session: AsyncSession,
) -> None:
    """The local fallback answers the gate without a socket or a row."""
    await drive_vault_pipeline(
        db_session,
        LocalFallbackCreekVaultClient(),
        user_id=_OWNER,
        trigger=VaultPipelineTrigger.DOCUMENT_IMPORT,
    )

    assert await _rows(db_session) == []


@pytest.mark.asyncio
async def test_the_local_fallback_refuses_both_pipeline_calls() -> None:
    """Neither pipeline call has a local implementation to fall back to."""
    client = LocalFallbackCreekVaultClient()

    with pytest.raises(CreekCapabilityUnsupportedError):
        await client.classify_corpus()
    with pytest.raises(CreekCapabilityUnsupportedError):
        await client.link_corpus(VaultLinkStage.TEMPORAL)


@pytest.mark.asyncio
async def test_a_second_write_inside_the_debounce_window_opens_no_socket(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
) -> None:
    """A stage that ran a moment ago is not run again on the next trigger."""
    recorder = _Recorder()
    client = await handshaken(recorder, http_clients(recorder))

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.JOURNAL_WRITE
    )
    first = len(recorder.requests)
    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.JOURNAL_WRITE
    )

    assert len(recorder.requests) == first
    assert len(await _rows(db_session)) == first


@pytest.mark.asyncio
async def test_the_debounce_is_per_user(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
) -> None:
    """One account's recent pass does not stand down another account's."""
    recorder = _Recorder()
    client = await handshaken(recorder, http_clients(recorder))

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.JOURNAL_WRITE
    )
    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER + 1, trigger=VaultPipelineTrigger.JOURNAL_WRITE
    )

    rows = await _rows(db_session)
    assert {row.user_id for row in rows} == {_OWNER, _OWNER + 1}


@pytest.mark.asyncio
async def test_a_link_stage_never_runs_before_a_classification_landed(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
) -> None:
    """A failed classification leaves the link stages unrun: threads reads its labels."""
    refusal = httpx.Response(503, json=_example("pipeline", "unavailable-service"))
    recorder = _Recorder(classification=refusal)
    client = await handshaken(recorder, http_clients(recorder))

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.DOCUMENT_IMPORT
    )

    assert recorder.paths == [_CLASSIFICATIONS_PATH]
    rows = await _rows(db_session)
    assert [row.stage for row in rows] == [VaultPipelineStage.CLASSIFY]
    assert rows[0].outcome == VaultPipelineOutcome.FAILED


@pytest.mark.asyncio
async def test_a_failed_stage_is_not_recorded_as_done_and_is_not_retried_in_the_request(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
) -> None:
    """A link stage that failed stops the ladder and is recorded as failed, once."""

    def _fail_eddies(stage: str) -> httpx.Response:
        if stage == VaultLinkStage.EDDIES.value:
            return httpx.Response(503, json=_example("pipeline", "unavailable-service"))
        return httpx.Response(200, json=_link_body(stage))

    recorder = _Recorder(link=_fail_eddies)
    client = await handshaken(recorder, http_clients(recorder))

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.DOCUMENT_IMPORT
    )

    assert recorder.pipeline_bodies == [
        {"method": "rules"},
        {"method": "temporal"},
        {"method": "eddies"},
    ]
    rows = await _rows(db_session)
    assert [(row.stage, row.outcome) for row in rows] == [
        (VaultPipelineStage.CLASSIFY, VaultPipelineOutcome.COMPLETED),
        (VaultPipelineStage.TEMPORAL, VaultPipelineOutcome.COMPLETED),
        (VaultPipelineStage.EDDIES, VaultPipelineOutcome.FAILED),
    ]


@pytest.mark.asyncio
async def test_a_stage_that_failed_steps_aside_for_the_one_behind_it(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
) -> None:
    """A stage's own window is what keeps a persistent failure from starving the next."""

    def _fail_eddies(stage: str) -> httpx.Response:
        if stage == VaultLinkStage.EDDIES.value:
            return httpx.Response(503, json=_example("pipeline", "unavailable-service"))
        return httpx.Response(200, json=_link_body(stage))

    recorder = _Recorder(link=_fail_eddies)
    client = await handshaken(recorder, http_clients(recorder))

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.DOCUMENT_IMPORT
    )
    await _age_rows(db_session, only={VaultPipelineStage.CLASSIFY, VaultPipelineStage.TEMPORAL})
    recorder.requests.clear()
    recorder.bodies.clear()

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.DOCUMENT_IMPORT
    )

    assert {body["method"] for body in recorder.pipeline_bodies} == {"rules", "temporal", "threads"}


async def _age_rows(session: AsyncSession, *, only: set[VaultPipelineStage]) -> None:
    """Push the named stages' rows far enough back to reopen their windows."""
    for row in await _rows(session):
        if row.stage in only:
            row.ran_at = datetime.now(UTC) - timedelta(days=7)
            session.add(row)
    await session.commit()


@pytest.mark.asyncio
async def test_an_incomplete_classification_is_not_a_failure(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
) -> None:
    """``complete: false`` means call again, not that the pass failed."""
    body = _example("pipeline", "success")
    body["complete"] = False
    recorder = _Recorder(classification=httpx.Response(200, json=body))
    client = await handshaken(recorder, http_clients(recorder))

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.JOURNAL_WRITE
    )

    rows = await _rows(db_session)
    assert rows[0].outcome == VaultPipelineOutcome.INCOMPLETE
    assert len(rows) == 2


@pytest.mark.asyncio
async def test_zero_privacy_tiers_assigned_is_the_expected_answer(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
) -> None:
    """A network-seeded corpus derives no tiers, and that is a completed pass."""
    assert _example("pipeline", "success")["privacy_tiers_assigned"] == 0
    recorder = _Recorder()
    client = await handshaken(recorder, http_clients(recorder))

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.JOURNAL_WRITE
    )

    rows = await _rows(db_session)
    assert rows[0].outcome == VaultPipelineOutcome.COMPLETED


@pytest.mark.asyncio
async def test_oversized_discarded_is_recorded_as_the_data_loss_it_is(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
) -> None:
    """Fragments dropped to noise are counted, not folded away."""

    def _lossy(stage: str) -> httpx.Response:
        body = _link_body(stage)
        body["oversized_discarded"] = 3
        return httpx.Response(200, json=body)

    recorder = _Recorder(link=_lossy)
    client = await handshaken(recorder, http_clients(recorder))

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.JOURNAL_WRITE
    )

    rows = await _rows(db_session)
    assert rows[1].fragments_lost == 3


@pytest.mark.asyncio
@pytest.mark.parametrize("missing", ["complete", "total", "method", "tier_ceiling", "status"])
async def test_a_classification_missing_a_required_field_is_a_payload_error(
    missing: str,
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
) -> None:
    """A 2xx body short one published field is refused, not completed with a default."""
    body = _example("pipeline", "success")
    del body[missing]
    recorder = _Recorder(classification=httpx.Response(200, json=body))
    client = await handshaken(recorder, http_clients(recorder))

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.JOURNAL_WRITE
    )

    rows = await _rows(db_session)
    assert [row.outcome for row in rows] == [VaultPipelineOutcome.FAILED]


@pytest.mark.asyncio
async def test_a_boolean_in_a_count_field_is_a_payload_error(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
) -> None:
    """``True`` is an ``int`` in Python and is not a count on this wire."""
    body = _example("pipeline", "success")
    body["total"] = True
    recorder = _Recorder(classification=httpx.Response(200, json=body))
    client = await handshaken(recorder, http_clients(recorder))

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.JOURNAL_WRITE
    )

    assert [row.outcome for row in await _rows(db_session)] == [VaultPipelineOutcome.FAILED]


@pytest.mark.asyncio
async def test_a_wider_echoed_ceiling_than_adepthood_accepts_is_refused(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
) -> None:
    """A vault that says it ran wider than adepthood authorized is not believed."""
    body = _example("pipeline", "success")
    body["tier_ceiling"] = "intimate"
    recorder = _Recorder(classification=httpx.Response(200, json=body))
    client = await handshaken(recorder, http_clients(recorder))

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.JOURNAL_WRITE
    )

    assert [row.outcome for row in await _rows(db_session)] == [VaultPipelineOutcome.FAILED]


@pytest.mark.asyncio
async def test_a_link_response_echoing_another_stage_is_refused(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
) -> None:
    """The echoed method is what correlates the answer with the stage that was asked for."""
    recorder = _Recorder(link=lambda _stage: httpx.Response(200, json=_link_body("threads")))
    client = await handshaken(recorder, http_clients(recorder))

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.JOURNAL_WRITE
    )

    rows = await _rows(db_session)
    assert rows[1].outcome == VaultPipelineOutcome.FAILED


def test_the_link_stage_vocabulary_is_exactly_creeks() -> None:
    """``embeddings`` is unconstructible here, not merely unsent."""
    published = json.loads(
        (_BUNDLE / "schemas" / "LinkRequest.schema.json").read_text(encoding="utf-8")
    )
    assert [stage.value for stage in VaultLinkStage] == published["$defs"]["LinkMethod"]["enum"]


@pytest.mark.asyncio
async def test_no_pipeline_request_can_spell_retier(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
) -> None:
    """Re-deriving a tier the operator settled is not adepthood's decision to make."""
    recorder = _Recorder()
    client = await handshaken(recorder, http_clients(recorder))

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.JOURNAL_WRITE
    )

    assert "retier" not in recorder.pipeline_bodies[0]


def test_the_stage_ladder_runs_classification_first_and_the_documented_link_order() -> None:
    """Creek documents classify, then temporal, then eddies, then threads."""
    assert pipeline.LADDER == (
        VaultPipelineStage.CLASSIFY,
        VaultPipelineStage.TEMPORAL,
        VaultPipelineStage.EDDIES,
        VaultPipelineStage.THREADS,
    )


def test_every_link_stage_has_a_wire_spelling_and_classification_has_none() -> None:
    """The ladder's one non-link stage is expressed by absence, not by a branch."""
    mapping: Mapping[VaultPipelineStage, VaultLinkStage] = pipeline.LINK_STAGE_BY_PIPELINE_STAGE
    assert set(mapping) == set(pipeline.LADDER) - {VaultPipelineStage.CLASSIFY}
    assert set(mapping.values()) == set(VaultLinkStage)


@pytest.mark.asyncio
async def test_no_stage_starts_once_the_run_budget_is_spent(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Don't start what won't finish: a spent budget opens no socket at all.

    The rule that bounds what one document import may cost. With the whole
    budget already gone, the ladder must decline to begin rather than start a
    stage it cannot afford and let the request run over.
    """
    monkeypatch.setattr(pipeline, "_DEEP_RUN_BUDGET_SECONDS", 0.0)
    recorder = _Recorder()
    client = await handshaken(recorder, http_clients(recorder))

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.DOCUMENT_IMPORT
    )

    assert recorder.requests == []
    assert await _rows(db_session) == []


@pytest.mark.asyncio
async def test_a_vault_whose_classification_keeps_failing_never_clusters_unlabelled_text(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
) -> None:
    """A failed classification inside its own window leaves the link stages unrun.

    The case the ladder's ordering alone does not cover: on the *second* pass the
    classification window has not reopened, so classification is skipped rather
    than failed -- and the clustering stages must still stand down, because the
    APTITUDE labels they read were never written.
    """
    refusal = httpx.Response(503, json=_example("pipeline", "unavailable-service"))
    recorder = _Recorder(classification=refusal)
    client = await handshaken(recorder, http_clients(recorder))

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.DOCUMENT_IMPORT
    )
    recorder.requests.clear()
    recorder.bodies.clear()

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.DOCUMENT_IMPORT
    )

    assert recorder.requests == []
    assert len(await _rows(db_session)) == 1


@pytest.mark.asyncio
async def test_a_database_that_will_not_record_the_pass_costs_the_caller_nothing(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The pass runs after somebody's entry is committed, so it may never raise."""
    recorder = _Recorder()
    client = await handshaken(recorder, http_clients(recorder))

    async def _refuse() -> None:
        raise OperationalError("INSERT", {}, Exception("disk is full"))

    monkeypatch.setattr(db_session, "commit", _refuse)

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.JOURNAL_WRITE
    )


@pytest.mark.asyncio
async def test_a_busy_journal_does_not_reopen_the_clustering_window(
    db_session: AsyncSession,
    http_clients: Callable[[_Recorder], httpx.AsyncClient],
    handshaken: Callable[[_Recorder, httpx.AsyncClient], Any],
) -> None:
    """A clustering stage's stamp is found however many cheap attempts came after it.

    The cheap stages run every fifteen minutes on an active account, so they
    accumulate rows far faster than the clustering stages do. If the scheduler
    reads "the newest few rows" instead of "the newest row per stage", an hour of
    ordinary journalling buries the clustering stages' stamps, they read as
    never-run, and their six-hour interval reopens on an account that did nothing
    but write.
    """
    recorder = _Recorder()
    client = await handshaken(recorder, http_clients(recorder))
    recent = datetime.now(UTC) - timedelta(minutes=1)
    db_session.add(
        VaultPipelineRun(
            user_id=_OWNER,
            stage=VaultPipelineStage.EDDIES.value,
            outcome=VaultPipelineOutcome.COMPLETED.value,
            fragments_seen=1,
            fragments_touched=1,
            fragments_lost=0,
            ran_at=recent,
        )
    )
    for stage in (VaultPipelineStage.CLASSIFY, VaultPipelineStage.TEMPORAL):
        for _ in range(6):
            db_session.add(
                VaultPipelineRun(
                    user_id=_OWNER,
                    stage=stage.value,
                    outcome=VaultPipelineOutcome.COMPLETED.value,
                    fragments_seen=1,
                    fragments_touched=1,
                    fragments_lost=0,
                    ran_at=datetime.now(UTC) - timedelta(days=1),
                )
            )
    await db_session.commit()

    await drive_vault_pipeline(
        db_session, client, user_id=_OWNER, trigger=VaultPipelineTrigger.DOCUMENT_IMPORT
    )

    assert "eddies" not in {body["method"] for body in recorder.pipeline_bodies}
