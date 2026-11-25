"""``GET /vault/pipeline``: did my files land, and what has run over them (#3775).

The "Your vault" dashboard (#3776) reads three things in one owner-only call:
adepthood's own receipts for the documents the account sent to its vault, the
ontologization passes adepthood drove on it, and Creek's own 0.34
``GET /v1/pipeline/status`` re-projected onto adepthood's types. Each test
drives the real route; Creek's half is a real
:class:`~services.creek_vault_client.HttpCreekVaultClient` whose only transport
is a scripted Creek, so the strict parse and the projection run together.

Pinned here:

* **Receipts are written at import time**, for every vault import that
  settled, with names and refs only -- never for an Intimate document, which
  never leaves adepthood, and never for an account with no vault.
* **The account's own rows only**, newest first, receipts paged with
  ``?before=`` and stage runs capped at fifty.
* **Creek never turns the page into an error.** An outage is ``vault: null``
  with ``vault_unreachable: true``; a vault on an image older than 0.34 is
  ``update_needed`` -- asked nothing if its handshake says so, and degraded the
  same way if it answers ``409 incompatible_version`` or ``404`` anyway.
* **Read-only.** No stage is started by the read.
* **Whole-corpus totals (#3795).** ``totals.sent`` counts every receipt of the
  account by outcome, whatever page was asked for and whether or not the vault
  answers. ``vault.stage_totals`` is Creek's 0.37 count of documents per stage,
  asked for only from a vault that lists 0.37 and ``null`` from an earlier one.
"""

from __future__ import annotations

import base64
import json
from collections.abc import AsyncGenerator, Callable, Mapping
from datetime import UTC, datetime, timedelta
from http import HTTPStatus
from pathlib import Path
from typing import Any, Final

import httpx
import pytest
import pytest_asyncio
from httpx import AsyncClient, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from dependencies.creek_vault import get_creek_vault_client
from domain.creek_vault import CreekVaultPipelineClient, VaultPipelineStage
from main import app
from models.upload_receipt import UploadReceipt
from models.vault_pipeline_run import VaultPipelineOutcome, VaultPipelineRun
from services.creek_vault_client import HttpCreekVaultClient, LocalFallbackCreekVaultClient
from services.creek_vault_upload import FolderSource, upload_external_id
from services.upload_receipts import batch_digest
from tests.helpers.oauth import signup
from tests.helpers.openapi_errors import declared_response_schema, live_document, response_validator
from tests.test_document_upload_to_a_vault import ScriptedUploadClient
from tests.test_upload_vault_busy import _busy_body, _BusyVault

_PIPELINE: Final = "/vault/pipeline"
_IMPORT: Final = "/corpus/import"
_SLICE: Final = Path(__file__).parent.parent / "fixtures" / "creek_pipeline_status_v034"
_BASE: Final = Path(__file__).parent.parent / "fixtures" / "creek_v1" / "examples"
_CAPABILITIES_PATH: Final = "/v1/capabilities"
_STATUS_PATH: Final = "/v1/pipeline/status"
_STATUS_MINOR: Final = "0.34"
_TOTALLED_SLICE: Final = Path(__file__).parent.parent / "fixtures" / "creek_pipeline_status_v037"
_TOTALS_MINOR: Final = "0.37"
#: The corpus of Creek's published 0.37 success cell, and its embedded share.
_PUBLISHED_DOCUMENTS: Final = 1240
_PUBLISHED_EMBEDDED: Final = 900
_STAGE_COUNT: Final = 7
#: What an account that sent nothing has sent: every outcome, at zero.
_NOTHING_SENT: Final = {
    "accepted": 0,
    "vault_unavailable": 0,
    "capability_unsupported": 0,
    "degraded": 0,
    "unsupported_source": 0,
}
_STAGE_RUN_CAP: Final = 50
_RECEIPT_PAGE: Final = 100
_FILENAME: Final = "on-attention.html"
_VAULT_URL: Final = "https://vault.example.test"
_VAULT_API_KEY: Final = "creek-pipeline-receipt-key"  # pragma: allowlist secret
_PAGE_OF_TWO: Final = 2
_EDDIES_EMITTED: Final = 9
_DOCUMENT: Final = base64.b64encode(b"<p>a page about attention</p>").decode("ascii")


def _read(path: Path) -> dict[str, Any]:
    """One vendored JSON document."""
    document: dict[str, Any] = json.loads(path.read_bytes())
    return document


def _status_answer() -> dict[str, Any]:
    """Creek's published success answer."""
    return _read(_SLICE / "pipeline-status" / "success.json")


class _Creek:
    """A scripted Creek: a handshake, then one answer for the status read."""

    def __init__(
        self,
        body: object = None,
        *,
        status: int = HTTPStatus.OK,
        handshake: Mapping[str, object] | None = None,
        transport_error: Callable[[httpx.Request], Exception] | None = None,
    ) -> None:
        """Script the status answer and, optionally, the handshake."""
        self.body = _status_answer() if body is None else body
        self.status = status
        self.handshake = (
            _read(_SLICE / "examples" / "capabilities" / "success.json")
            if handshake is None
            else handshake
        )
        self.transport_error = transport_error
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Record and answer one request."""
        self.requests.append(request)
        if self.transport_error is not None:
            raise self.transport_error(request)
        if request.url.path == _CAPABILITIES_PATH:
            return httpx.Response(HTTPStatus.OK, json=self.handshake)
        return httpx.Response(self.status, json=self.body)

    def status_calls(self) -> list[httpx.Request]:
        """Every request that reached the status route."""
        return [r for r in self.requests if r.url.path == _STATUS_PATH]

    def non_reads(self) -> list[httpx.Request]:
        """Every request that was not a ``GET``: a read must start nothing."""
        return [r for r in self.requests if r.method != "GET"]


@pytest_asyncio.fixture
async def serve() -> AsyncGenerator[Callable[[_Creek], None], None]:
    """Make every request's vault an adapter over the given scripted Creek."""

    def _install(creek: _Creek) -> None:
        def _client() -> CreekVaultPipelineClient:
            return HttpCreekVaultClient(
                "https://vault.example.test",
                "pipeline-route-key",  # pragma: allowlist secret
                http_client=httpx.AsyncClient(transport=httpx.MockTransport(creek)),
            )

        app.dependency_overrides[get_creek_vault_client] = _client

    yield _install
    app.dependency_overrides.pop(get_creek_vault_client, None)


def _validate(response: Response) -> None:
    """Hold a live body to the schema the published document declares for it."""
    document = live_document()
    schema = declared_response_schema(document, "get", _PIPELINE, response.status_code)
    response_validator(document, schema).validate(response.json())


async def _receipt(
    db_session: AsyncSession,
    user_id: int,
    filename: str,
    *,
    created_at: datetime | None = None,
    vault_status: str = "accepted",
) -> UploadReceipt:
    """Persist one receipt for ``user_id``."""
    receipt = UploadReceipt(
        user_id=user_id,
        filename=filename,
        batch=None,
        external_id=upload_external_id(user_id, filename),
        vault_ref=f"frag-{filename}" if vault_status == "accepted" else None,
        destination="vault",
        vault_status=vault_status,
        created_at=created_at or datetime.now(UTC),
    )
    db_session.add(receipt)
    await db_session.commit()
    await db_session.refresh(receipt)
    return receipt


async def _run(
    db_session: AsyncSession,
    user_id: int,
    stage: VaultPipelineStage,
    *,
    trigger: str | None = "document_import",
    touched: int = 0,
) -> None:
    """Persist one finished stage run for ``user_id``."""
    db_session.add(
        VaultPipelineRun(
            user_id=user_id,
            stage=stage.value,
            outcome=VaultPipelineOutcome.COMPLETED.value,
            trigger=trigger,
            fragments_seen=touched,
            fragments_touched=touched,
            fragments_lost=0,
        )
    )
    await db_session.commit()


def _matching_document(user_id: int, filename: str) -> dict[str, Any]:
    """Creek's success answer, its one document re-addressed to this account's upload."""
    body = _status_answer()
    body["documents"][0]["external_id"] = upload_external_id(user_id, filename)
    return body


# --- the shape --------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_whole_answer_joins_receipts_runs_and_creeks_status(
    async_client: AsyncClient,
    db_session: AsyncSession,
    serve: Callable[[_Creek], None],
) -> None:
    """One read: the receipt lands in Creek's folder, the run, and Creek's half."""
    headers, user_id = await signup(async_client, "pipeline_whole")
    await _receipt(db_session, user_id, _FILENAME)
    await _run(db_session, user_id, VaultPipelineStage.EDDIES, touched=_EDDIES_EMITTED)
    creek = _Creek(_matching_document(user_id, _FILENAME))
    serve(creek)

    response = await async_client.get(_PIPELINE, headers=headers)

    assert response.status_code == HTTPStatus.OK
    _validate(response)
    body = response.json()
    assert body["vault_status"] == "ok"
    assert body["vault_unreachable"] is False
    (upload,) = body["recent_uploads"]
    assert upload["filename"] == _FILENAME
    assert upload["landed_in"] == "01-Fragments/Writing/Substack"
    assert upload["vault_status"] == "accepted"
    assert upload["destination"] == "vault"
    assert upload["vault_ref"] == f"frag-{_FILENAME}"
    assert body["next_before"] is None
    (run,) = body["stage_runs"]
    assert run["trigger"] == "document_import"
    assert run["stage"] == "eddies"
    assert run["emitted"] == _EDDIES_EMITTED
    vault = body["vault"]
    assert set(vault) == {"folders", "documents", "documents_withheld", "jobs", "stage_totals"}
    assert vault["stage_totals"] is None
    assert body["totals"] == {"sent": _NOTHING_SENT | {"accepted": 1}}
    praxis = next(f for f in vault["folders"] if f["path"] == "04-Praxis/Daily")
    assert praxis == {
        "path": "04-Praxis/Daily",
        "count": 0,
        "last_written_at": None,
        "writer": "classify.praxis",
        "writer_reason": None,
    }
    (document,) = vault["documents"]
    assert document["landed_in"] == "01-Fragments/Writing/Substack"
    assert [stage["stage"] for stage in document["stages"]][-1] == "linked:eddies"
    assert vault["documents_withheld"] == 1
    (job,) = vault["jobs"]
    assert job["state"] == "running"
    assert "job_id" not in job
    assert "external_id" not in document
    assert "on-attention.md" not in response.text
    (status_call,) = creek.status_calls()
    assert status_call.headers["X-Creek-Contract-Version"] == _STATUS_MINOR
    assert creek.non_reads() == []


@pytest.mark.asyncio
async def test_an_account_with_no_vault_is_not_connected_and_asks_nothing(
    async_client: AsyncClient,
) -> None:
    """The local fallback stands in front of no vault, so Creek's half is ``not_connected``."""
    headers, _user_id = await signup(async_client, "pipeline_no_vault")
    app.dependency_overrides[get_creek_vault_client] = LocalFallbackCreekVaultClient
    try:
        response = await async_client.get(_PIPELINE, headers=headers)
    finally:
        app.dependency_overrides.pop(get_creek_vault_client, None)

    assert response.status_code == HTTPStatus.OK
    body = response.json()
    assert body["vault"] is None
    assert body["vault_status"] == "not_connected"
    assert body["vault_unreachable"] is False
    assert body["recent_uploads"] == []
    assert body["stage_runs"] == []


# --- degrading --------------------------------------------------------------


@pytest.mark.asyncio
async def test_an_unreachable_vault_is_vault_null_and_unreachable_never_a_5xx(
    async_client: AsyncClient,
    db_session: AsyncSession,
    serve: Callable[[_Creek], None],
) -> None:
    """A Creek outage leaves the receipts and runs readable, and says the vault is out."""
    headers, user_id = await signup(async_client, "pipeline_outage")
    await _receipt(db_session, user_id, _FILENAME)

    def _down(request: httpx.Request) -> Exception:
        return httpx.ConnectError("synthetic outage", request=request)

    serve(_Creek(transport_error=_down))

    response = await async_client.get(_PIPELINE, headers=headers)

    assert response.status_code == HTTPStatus.OK
    _validate(response)
    body = response.json()
    assert body["vault"] is None
    assert body["vault_unreachable"] is True
    assert body["vault_status"] == "unreachable"
    (upload,) = body["recent_uploads"]
    assert upload["landed_in"] is None


@pytest.mark.asyncio
async def test_a_vault_that_answers_503_is_unreachable(
    async_client: AsyncClient, serve: Callable[[_Creek], None]
) -> None:
    """Creek's own ``503 unavailable`` -- a vault it cannot list -- is the outage case."""
    headers, _user_id = await signup(async_client, "pipeline_503")
    body = _read(_SLICE / "examples" / "pipeline" / "unavailable-service.json")
    serve(_Creek(body, status=HTTPStatus.SERVICE_UNAVAILABLE))

    response = await async_client.get(_PIPELINE, headers=headers)

    assert response.json()["vault_status"] == "unreachable"
    assert response.json()["vault_unreachable"] is True


@pytest.mark.asyncio
async def test_an_off_schema_answer_is_unreachable_and_echoes_nothing(
    async_client: AsyncClient, serve: Callable[[_Creek], None]
) -> None:
    """A vault adding a title to a document is refused whole; nothing of it is shown."""
    headers, _user_id = await signup(async_client, "pipeline_off_schema")
    body = _status_answer()
    body["documents"][0]["title"] = "SENTINEL a title that must not cross"
    serve(_Creek(body))

    response = await async_client.get(_PIPELINE, headers=headers)

    assert response.status_code == HTTPStatus.OK
    assert response.json()["vault"] is None
    assert response.json()["vault_status"] == "unreachable"
    assert "SENTINEL" not in response.text


@pytest.mark.asyncio
async def test_a_vault_older_than_0_34_needs_an_update_and_is_never_asked(
    async_client: AsyncClient, serve: Callable[[_Creek], None]
) -> None:
    """The deployed 0.22-era handshake lists no 0.34, so the read is not attempted."""
    headers, _user_id = await signup(async_client, "pipeline_old_vault")
    creek = _Creek(handshake=_read(_BASE / "capabilities" / "success.json"))
    serve(creek)

    response = await async_client.get(_PIPELINE, headers=headers)

    assert response.status_code == HTTPStatus.OK
    body = response.json()
    assert body["vault"] is None
    assert body["vault_status"] == "update_needed"
    assert body["vault_unreachable"] is False
    assert creek.status_calls() == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "code"),
    [(HTTPStatus.CONFLICT, "incompatible_version"), (HTTPStatus.NOT_FOUND, "not_found")],
)
async def test_a_vault_refusing_the_minor_or_the_route_needs_an_update(
    async_client: AsyncClient, serve: Callable[[_Creek], None], status: int, code: str
) -> None:
    """A vault that listed 0.34 but refuses it, or has no such route, needs an update."""
    headers, _user_id = await signup(async_client, f"pipeline_refused_{status}")
    envelope = {"code": code, "message": "synthetic", "request_id": "req-synthetic"}
    serve(_Creek(envelope, status=status))

    response = await async_client.get(_PIPELINE, headers=headers)

    assert response.status_code == HTTPStatus.OK
    assert response.json()["vault_status"] == "update_needed"
    assert response.json()["vault_unreachable"] is False


# --- the account's own rows -------------------------------------------------


@pytest.mark.asyncio
async def test_receipts_are_newest_first_and_paged_with_before(
    async_client: AsyncClient,
    db_session: AsyncSession,
    serve: Callable[[_Creek], None],
) -> None:
    """``?limit=`` pages the receipts; ``next_before`` carries on from the last one shown."""
    headers, user_id = await signup(async_client, "pipeline_paging")
    start = datetime.now(UTC)
    for offset, name in enumerate(("first.md", "second.md", "third.md")):
        await _receipt(db_session, user_id, name, created_at=start + timedelta(seconds=offset))
    serve(_Creek())

    first = (
        await async_client.get(_PIPELINE, params={"limit": _PAGE_OF_TWO}, headers=headers)
    ).json()
    assert [u["filename"] for u in first["recent_uploads"]] == ["third.md", "second.md"]
    assert first["next_before"] == first["recent_uploads"][-1]["id"]

    rest = (
        await async_client.get(
            _PIPELINE,
            params={"limit": _PAGE_OF_TWO, "before": first["next_before"]},
            headers=headers,
        )
    ).json()
    assert [u["filename"] for u in rest["recent_uploads"]] == ["first.md"]
    assert rest["next_before"] is None


@pytest.mark.asyncio
@pytest.mark.parametrize("limit", ["0", str(_RECEIPT_PAGE + 1)])
async def test_a_receipt_limit_outside_one_to_a_hundred_is_refused(
    async_client: AsyncClient, serve: Callable[[_Creek], None], limit: str
) -> None:
    """The receipt page is at most the last hundred."""
    headers, _user_id = await signup(async_client, f"pipeline_bad_limit_{limit}")
    serve(_Creek())
    response = await async_client.get(_PIPELINE, params={"limit": limit}, headers=headers)
    assert response.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_stage_runs_are_the_last_fifty_newest_first_with_legacy_triggers(
    async_client: AsyncClient,
    db_session: AsyncSession,
    serve: Callable[[_Creek], None],
) -> None:
    """Capped at fifty; a run recorded before triggers were reads ``trigger: null``."""
    headers, user_id = await signup(async_client, "pipeline_runs")
    await _run(db_session, user_id, VaultPipelineStage.CLASSIFY, trigger=None)
    for _ in range(_STAGE_RUN_CAP):
        await _run(db_session, user_id, VaultPipelineStage.TEMPORAL, trigger="journal_write")
    serve(_Creek())

    runs = (await async_client.get(_PIPELINE, headers=headers)).json()["stage_runs"]

    assert len(runs) == _STAGE_RUN_CAP
    assert {run["trigger"] for run in runs} == {"journal_write"}
    assert set(runs[0]) == {
        "trigger",
        "stage",
        "outcome",
        "failure_code",
        "fragments_seen",
        "emitted",
        "fragments_lost",
        "ran_at",
    }


# --- receipts are written at import time ------------------------------------


@pytest_asyncio.fixture
async def upload_vault() -> AsyncGenerator[ScriptedUploadClient, None]:
    """A scripted vault that takes uploads, installed for the import route."""
    client = ScriptedUploadClient()
    app.dependency_overrides[get_creek_vault_client] = lambda: client
    yield client
    app.dependency_overrides.pop(get_creek_vault_client, None)


async def _receipts(db_session: AsyncSession, user_id: int) -> list[UploadReceipt]:
    """Every receipt this account holds, oldest first."""
    result = await db_session.execute(
        select(UploadReceipt)
        .where(col(UploadReceipt.user_id) == user_id)
        .order_by(col(UploadReceipt.id))
    )
    return list(result.scalars().all())


@pytest.mark.asyncio
async def test_a_vault_import_writes_one_receipt_with_names_and_refs_only(
    async_client: AsyncClient,
    db_session: AsyncSession,
    upload_vault: ScriptedUploadClient,
) -> None:
    """The import's own answer is kept: filename, ref, status -- no content, no folder name."""
    headers, user_id = await signup(async_client, "pipeline_import")
    payload = {
        "filename": _FILENAME,
        "content_base64": _DOCUMENT,
        "classification": "personal",
        "source_namespace": "Substack export",
        "source_relative_path": f"posts/{_FILENAME}",
    }

    response = await async_client.post(_IMPORT, json=payload, headers=headers)

    assert response.status_code == HTTPStatus.ACCEPTED
    (receipt,) = await _receipts(db_session, user_id)
    assert receipt.filename == _FILENAME
    assert receipt.batch == batch_digest(
        user_id, FolderSource("Substack export", f"posts/{_FILENAME}")
    )
    assert receipt.batch is not None
    assert "Substack" not in repr(receipt.model_dump())
    assert receipt.destination == "vault"
    assert receipt.vault_status == "accepted"
    assert receipt.vault_ref == response.json()["vault_ref"]
    assert receipt.external_id == upload_vault.upload_calls[0].external_id
    assert _DOCUMENT not in repr(receipt.model_dump())


@pytest.mark.asyncio
async def test_an_unsettled_import_still_leaves_a_receipt_saying_so(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A vault that could not take the file is a receipt too: it says it did not land."""
    client = ScriptedUploadClient(available=False)
    app.dependency_overrides[get_creek_vault_client] = lambda: client
    headers, user_id = await signup(async_client, "pipeline_import_down")
    payload = {"filename": _FILENAME, "content_base64": _DOCUMENT, "classification": "personal"}
    try:
        await async_client.post(_IMPORT, json=payload, headers=headers)
    finally:
        app.dependency_overrides.pop(get_creek_vault_client, None)

    (receipt,) = await _receipts(db_session, user_id)
    assert receipt.vault_status == "vault_unavailable"
    assert receipt.vault_ref is None
    assert receipt.batch is None


@pytest.mark.asyncio
async def test_an_intimate_import_leaves_no_receipt(
    async_client: AsyncClient,
    db_session: AsyncSession,
    upload_vault: ScriptedUploadClient,
) -> None:
    """An Intimate document never leaves adepthood, so not even its name is kept here."""
    headers, user_id = await signup(async_client, "pipeline_import_intimate")
    payload = {"filename": _FILENAME, "content_base64": _DOCUMENT, "classification": "intimate"}

    await async_client.post(_IMPORT, json=payload, headers=headers)

    assert upload_vault.upload_calls == []
    assert await _receipts(db_session, user_id) == []


@pytest.mark.asyncio
async def test_an_account_with_no_vault_leaves_no_receipt(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``vault_required`` stored nothing, so there is nothing to keep a receipt of."""
    headers, user_id = await signup(async_client, "pipeline_import_no_vault")
    app.dependency_overrides[get_creek_vault_client] = LocalFallbackCreekVaultClient
    payload = {"filename": _FILENAME, "content_base64": _DOCUMENT, "classification": "personal"}
    try:
        response = await async_client.post(_IMPORT, json=payload, headers=headers)
    finally:
        app.dependency_overrides.pop(get_creek_vault_client, None)

    assert response.json()["corpus_status"] == "vault_required"
    assert await _receipts(db_session, user_id) == []


async def _post_through(
    async_client: AsyncClient, vault: _BusyVault, headers: Mapping[str, str], *, times: int = 1
) -> list[Response]:
    """POST the same document ``times`` times through a real adapter over ``vault``."""
    payload = {"filename": _FILENAME, "content_base64": _DOCUMENT, "classification": "personal"}
    async with httpx.AsyncClient(transport=httpx.MockTransport(vault)) as http:
        client = HttpCreekVaultClient(
            _VAULT_URL, _VAULT_API_KEY, http_client=http, pin_destination=False
        )
        app.dependency_overrides[get_creek_vault_client] = lambda: client
        try:
            return [
                await async_client.post(_IMPORT, json=payload, headers=dict(headers))
                for _ in range(times)
            ]
        finally:
            app.dependency_overrides.pop(get_creek_vault_client, None)


@pytest.mark.asyncio
async def test_a_busy_vault_leaves_no_receipt_and_its_retry_leaves_one(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``vault_busy`` is a wait, not an answer: the resend that lands is the one receipt."""
    headers, user_id = await signup(async_client, "pipeline_import_busy")
    vault = _BusyVault(busy_for=1)

    (busy,) = await _post_through(async_client, vault, headers)

    assert busy.status_code == HTTPStatus.ACCEPTED
    assert busy.json()["vault_status"] == "vault_busy"
    assert await _receipts(db_session, user_id) == []

    (landed,) = await _post_through(async_client, vault, headers)

    assert landed.status_code == HTTPStatus.ACCEPTED
    assert landed.json()["vault_status"] == "accepted"
    (receipt,) = await _receipts(db_session, user_id)
    assert receipt.vault_status == "accepted"
    assert receipt.vault_ref == landed.json()["vault_ref"]


@pytest.mark.asyncio
async def test_a_refused_file_type_leaves_a_receipt_saying_so(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``unsupported_source`` is settled -- resending is refused the same way -- so it is kept."""
    headers, user_id = await signup(async_client, "pipeline_import_unsupported")
    vault = _BusyVault(
        busy_for=1,
        status=HTTPStatus.UNSUPPORTED_MEDIA_TYPE,
        body=_busy_body("unsupported_source"),
        retry_after=None,
    )

    (response,) = await _post_through(async_client, vault, headers)

    assert response.status_code == HTTPStatus.ACCEPTED
    assert response.json()["vault_status"] == "unsupported_source"
    (receipt,) = await _receipts(db_session, user_id)
    assert receipt.vault_status == "unsupported_source"
    assert receipt.vault_ref is None


@pytest.mark.asyncio
async def test_a_refused_file_types_receipt_reads_back_on_the_dashboard(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The dashboard read carries ``unsupported_source`` through ``recent_uploads``."""
    headers, user_id = await signup(async_client, "pipeline_read_unsupported")
    await _receipt(db_session, user_id, _FILENAME, vault_status="unsupported_source")
    app.dependency_overrides[get_creek_vault_client] = LocalFallbackCreekVaultClient
    try:
        response = await async_client.get(_PIPELINE, headers=headers)
    finally:
        app.dependency_overrides.pop(get_creek_vault_client, None)

    assert response.status_code == HTTPStatus.OK
    (upload,) = response.json()["recent_uploads"]
    assert upload["vault_status"] == "unsupported_source"
    _validate(response)


# --- whole-corpus totals (#3795) --------------------------------------------


def _totalled_creek() -> _Creek:
    """A Creek on contract 0.37: it lists the minor and answers with totals."""
    return _Creek(
        _read(_TOTALLED_SLICE / "pipeline-status" / "success.json"),
        handshake=_read(_TOTALLED_SLICE / "examples" / "capabilities" / "success.json"),
    )


@pytest.mark.asyncio
async def test_sent_totals_count_every_receipt_by_outcome_whatever_the_page(
    async_client: AsyncClient,
    db_session: AsyncSession,
    serve: Callable[[_Creek], None],
) -> None:
    """Three accepted, one degraded, one refused: the same on every page of two."""
    headers, user_id = await signup(async_client, "pipeline_sent_totals")
    for name in ("one.md", "two.md", "three.md"):
        await _receipt(db_session, user_id, name)
    await _receipt(db_session, user_id, "four.md", vault_status="degraded")
    await _receipt(db_session, user_id, "five.pages", vault_status="unsupported_source")
    serve(_Creek())
    expected = {"sent": _NOTHING_SENT | {"accepted": 3, "degraded": 1, "unsupported_source": 1}}

    first = await async_client.get(_PIPELINE, params={"limit": _PAGE_OF_TWO}, headers=headers)
    _validate(first)
    assert len(first.json()["recent_uploads"]) == _PAGE_OF_TWO
    assert first.json()["totals"] == expected

    last = await async_client.get(
        _PIPELINE, params={"limit": 1, "before": first.json()["next_before"]}, headers=headers
    )
    assert last.json()["totals"] == expected
    whole = await async_client.get(_PIPELINE, headers=headers)
    assert whole.json()["totals"] == expected


@pytest.mark.asyncio
async def test_sent_totals_name_every_outcome_at_zero_for_an_account_that_sent_nothing(
    async_client: AsyncClient, serve: Callable[[_Creek], None]
) -> None:
    """An outcome is never inferred from its absence."""
    headers, _user_id = await signup(async_client, "pipeline_sent_nothing")
    serve(_Creek())

    response = await async_client.get(_PIPELINE, headers=headers)

    assert response.json()["totals"] == {"sent": _NOTHING_SENT}


@pytest.mark.asyncio
async def test_sent_totals_never_count_another_accounts_receipts(
    async_client: AsyncClient,
    db_session: AsyncSession,
    serve: Callable[[_Creek], None],
) -> None:
    """Two accounts, each counted alone."""
    headers, user_id = await signup(async_client, "pipeline_totals_mine")
    _other_headers, other_id = await signup(async_client, "pipeline_totals_theirs")
    await _receipt(db_session, user_id, "mine.md")
    for name in ("theirs-1.md", "theirs-2.md"):
        await _receipt(db_session, other_id, name)
    await _receipt(db_session, other_id, "theirs-3.md", vault_status="degraded")
    serve(_Creek())

    response = await async_client.get(_PIPELINE, headers=headers)

    assert response.json()["totals"] == {"sent": _NOTHING_SENT | {"accepted": 1}}


@pytest.mark.asyncio
async def test_sent_totals_are_answered_with_no_vault_connected(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Receipts are adepthood's own rows: a since-disconnected account still counts them."""
    headers, user_id = await signup(async_client, "pipeline_totals_no_vault")
    await _receipt(db_session, user_id, _FILENAME)
    app.dependency_overrides[get_creek_vault_client] = LocalFallbackCreekVaultClient
    try:
        response = await async_client.get(_PIPELINE, headers=headers)
    finally:
        app.dependency_overrides.pop(get_creek_vault_client, None)

    _validate(response)
    body = response.json()
    assert body["vault_status"] == "not_connected"
    assert body["vault"] is None
    assert body["totals"] == {"sent": _NOTHING_SENT | {"accepted": 1}}


@pytest.mark.asyncio
async def test_sent_totals_are_answered_when_the_vault_is_unreachable(
    async_client: AsyncClient,
    db_session: AsyncSession,
    serve: Callable[[_Creek], None],
) -> None:
    """An outage takes Creek's half and nothing of adepthood's."""
    headers, user_id = await signup(async_client, "pipeline_totals_outage")
    await _receipt(db_session, user_id, _FILENAME)
    await _receipt(db_session, user_id, "later.md", vault_status="vault_unavailable")

    def _down(request: httpx.Request) -> Exception:
        return httpx.ConnectError("synthetic outage", request=request)

    serve(_Creek(transport_error=_down))

    response = await async_client.get(_PIPELINE, headers=headers)

    body = response.json()
    assert body["vault_status"] == "unreachable"
    assert body["vault"] is None
    assert body["totals"] == {"sent": _NOTHING_SENT | {"accepted": 1, "vault_unavailable": 1}}


@pytest.mark.asyncio
async def test_a_vault_listing_0_37_is_asked_at_0_37_and_answers_stage_totals(
    async_client: AsyncClient, serve: Callable[[_Creek], None]
) -> None:
    """Creek's totals are re-projected: the corpus, and one row per stage in order."""
    headers, _user_id = await signup(async_client, "pipeline_stage_totals")
    creek = _totalled_creek()
    serve(creek)

    response = await async_client.get(_PIPELINE, headers=headers)

    assert response.status_code == HTTPStatus.OK
    _validate(response)
    body = response.json()
    assert body["vault_status"] == "ok"
    stage_totals = body["vault"]["stage_totals"]
    assert set(stage_totals) == {"documents", "stages"}
    assert stage_totals["documents"] == _PUBLISHED_DOCUMENTS
    assert [row["stage"] for row in stage_totals["stages"]] == [
        "ingested",
        "classified",
        "praxis_scanned",
        "linked:embeddings",
        "linked:temporal",
        "linked:eddies",
        "linked:threads",
    ]
    assert stage_totals["stages"][0] == {
        "stage": "ingested",
        "covered": _PUBLISHED_DOCUMENTS,
        "partial": 0,
        "failed": 0,
    }
    assert stage_totals["stages"][3]["covered"] == _PUBLISHED_EMBEDDED
    assert stage_totals["stages"][5] == {
        "stage": "linked:eddies",
        "covered": 0,
        "partial": _PUBLISHED_DOCUMENTS,
        "failed": 0,
    }
    assert len(body["vault"]["folders"]) > 0
    assert len(body["vault"]["documents"]) == 1
    (status_call,) = creek.status_calls()
    assert status_call.headers["X-Creek-Contract-Version"] == _TOTALS_MINOR
    assert creek.non_reads() == []


@pytest.mark.asyncio
async def test_a_vault_on_0_34_still_answers_its_half_with_null_stage_totals(
    async_client: AsyncClient, serve: Callable[[_Creek], None]
) -> None:
    """Folders, documents and jobs as before; no totals, and no 0.37 declared."""
    headers, _user_id = await signup(async_client, "pipeline_no_stage_totals")
    creek = _Creek()
    serve(creek)

    response = await async_client.get(_PIPELINE, headers=headers)

    _validate(response)
    vault = response.json()["vault"]
    assert response.json()["vault_status"] == "ok"
    assert vault["stage_totals"] is None
    assert len(vault["folders"]) > 0
    assert len(vault["documents"]) == 1
    assert len(vault["jobs"]) == 1
    (status_call,) = creek.status_calls()
    assert status_call.headers["X-Creek-Contract-Version"] == _STATUS_MINOR


def _unknown_stage(totals: dict[str, Any]) -> None:
    """Name a stage Creek never published."""
    totals["stages"][1]["stage"] = "SENTINEL-stage"


def _negative_count(totals: dict[str, Any]) -> None:
    """Count fewer than no documents."""
    totals["stages"][1]["failed"] = -1


def _covered_above_documents(totals: dict[str, Any]) -> None:
    """Cover more documents than the corpus holds."""
    totals["stages"][1]["covered"] = totals["documents"] + 1


@pytest.mark.asyncio
@pytest.mark.parametrize("corrupt", [_unknown_stage, _negative_count, _covered_above_documents])
async def test_totals_off_the_contract_degrade_the_vault_half_and_echo_nothing(
    async_client: AsyncClient,
    db_session: AsyncSession,
    serve: Callable[[_Creek], None],
    caplog: pytest.LogCaptureFixture,
    corrupt: Callable[[dict[str, Any]], None],
) -> None:
    """A contract error, degraded as every read failure is: receipts still answer."""
    headers, user_id = await signup(async_client, f"pipeline_{corrupt.__name__}")
    await _receipt(db_session, user_id, _FILENAME)
    creek = _totalled_creek()
    assert isinstance(creek.body, dict)
    corrupt(creek.body["totals"])
    serve(creek)

    response = await async_client.get(_PIPELINE, headers=headers)

    assert response.status_code == HTTPStatus.OK
    body = response.json()
    assert body["vault"] is None
    assert body["vault_status"] == "unreachable"
    assert body["vault_unreachable"] is True
    assert body["totals"] == {"sent": _NOTHING_SENT | {"accepted": 1}}
    assert "SENTINEL" not in response.text
    assert "SENTINEL" not in caplog.text
    assert _FILENAME not in caplog.text


def test_one_imports_documents_share_a_batch_that_names_nothing() -> None:
    """Same account and namespace: one batch. Another account or import: another."""
    one = batch_digest(1, FolderSource("Therapy notes", "a.md"))
    assert one == batch_digest(1, FolderSource("Therapy notes", "deeper/b.md"))
    assert one != batch_digest(2, FolderSource("Therapy notes", "a.md"))
    assert one != batch_digest(1, FolderSource("Substack export", "a.md"))
    assert one is not None
    assert "Therapy" not in one
    assert batch_digest(1, None) is None
