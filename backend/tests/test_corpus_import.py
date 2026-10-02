"""The import surface: a document a user chose, routed by whether they have a vault.

Owner ruling on #3015: a corpus is something you keep in a vault, so you can
only have one if you have a vault to keep it in. A document is therefore taken
to the account's vault or nowhere -- since #3016 there is no second, local
destination for an account the resolver finds no vault for.

Three properties are asserted here, each through the real HTTP surface.

*A caller who reaches a vault is unchanged.* The document goes to the vault at
its own tier, at every tier, and nothing is written to the local corpus and no
provider is contacted -- the vault ingests documents itself.

*A caller who reaches no vault is told so, and nothing else happens.* The
answer is ``vault_required``: the document is not read, no consent is
consulted, no language model is contacted and nothing is stored -- whatever the
format, the tier, or the switch for documents says.

*The request is bounded before it is routed.* The size and encoding guards run
first for every caller, so an oversized or undecodable document is refused as
such whether or not the account has a vault.
"""

from __future__ import annotations

import base64
import json
from collections.abc import AsyncGenerator
from datetime import UTC, datetime
from http import HTTPStatus

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from dependencies.creek_vault import OWNER_ENV_VAR, get_creek_vault_client
from domain.corpus_import import CorpusImportStatus, ImportDestination
from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
    CreekVaultClient,
    HandshakeResult,
    VaultClassification,
    VaultIngestAction,
    VaultIngestRequest,
    VaultIngestResult,
    VaultReflection,
    VaultReflectionStatus,
    VaultTierCeiling,
    VaultUploadRequest,
    VaultUploadResult,
    VaultUploadStatus,
    VaultWheelBalance,
)
from domain.frequencies import Frequency
from main import app
from models.corpus_fragment import CorpusFragment, CorpusSource
from routers import corpus as corpus_router
from schemas.corpus_import import CORPUS_IMPORT_MESSAGES
from schemas.journal_upload import (
    MAX_UPLOAD_BASE64_CHARS,
    MAX_UPLOAD_BYTES,
    DocumentTooLargeError,
    decode_document,
)
from services import frequency_classification as fc
from services.corpus_import import VAULT_REQUIRED_RESULT, import_document, reaches_a_vault
from services.creek_vault_client import LocalFallbackCreekVaultClient
from services.creek_vault_upload import UploadedDocument
from tests.vault_client_doubles import NoPipelineVaultDouble

_SIGNUP_PASSWORD = "secret12345"  # pragma: allowlist secret

_IMPORT_PATH = "/corpus/import"
_CONSENT_PATH = f"/corpus/consent/{CorpusSource.UPLOAD.value}"

_MARKDOWN_NAME = "on-patience.md"
_PROSE = "I kept the appointment I had been dreading, and the dread was the worst of it."
_MARKDOWN_B64 = base64.b64encode(_PROSE.encode()).decode("ascii")

# A reply the classifier's parser accepts, naming one position on the ontology.
_CLASSIFIED_REPLY = json.dumps({"weights": {Frequency.F5.value: 0.9}, "overall_confidence": 0.9})


class _ClassifierCalls:
    """A counting stand-in for the classifier's provider call.

    The count is the point: the cost story for the corpus is one provider call
    per thing imported, and a surface that quietly made two would double every
    account's bill without changing a single visible behaviour.
    """

    def __init__(self, reply: str) -> None:
        """Bind the reply every call answers with."""
        self.count = 0
        self._reply = reply

    async def __call__(self, **_kwargs: object) -> object:
        """Count one call and answer with the bound reply."""
        self.count += 1
        return _Reply(self._reply)


class _Reply:
    """The one field the classifier reads off a provider response."""

    def __init__(self, text: str) -> None:
        """Bind the reply text."""
        self.text = text


@pytest.fixture
def classifier(monkeypatch: pytest.MonkeyPatch, request: pytest.FixtureRequest) -> _ClassifierCalls:
    """Route the classifier's provider call to a counting fake."""
    reply = getattr(request, "param", _CLASSIFIED_REPLY)
    calls = _ClassifierCalls(reply)
    monkeypatch.setattr(fc, "generate_response", calls)
    return calls


def _empty_reflection() -> VaultReflection:
    """Return the reflection an unexercised reflect path answers with."""
    return VaultReflection(
        status=VaultReflectionStatus.EMPTY,
        notes=(),
        essay=None,
        essay_grounded=False,
        routed_tier=VaultTierCeiling.OPEN,
    )


class ScriptedVault(NoPipelineVaultDouble):
    """A reachable, upload-capable vault that records what it was handed."""

    def __init__(self) -> None:
        """Start with an empty record of upload calls."""
        self.upload_calls: list[VaultUploadRequest] = []

    async def handshake(self) -> HandshakeResult:
        """Report available, advertising journal and upload."""
        return HandshakeResult(
            available=True,
            contract_version=CONTRACT_VERSION,
            ontology_version="1.0.0",
            capabilities=frozenset({CreekCapability.JOURNAL, CreekCapability.UPLOAD}),
            attestation=None,
        )

    def is_available(self) -> bool:
        """Report available."""
        return True

    def supports(self, capability: CreekCapability, /) -> bool:
        """Report journal and upload as advertised."""
        return capability in {CreekCapability.JOURNAL, CreekCapability.UPLOAD}

    async def ingest(self, _request: VaultIngestRequest, /) -> VaultIngestResult:
        """Report not stored -- the import surface never calls journal ingest."""
        return VaultIngestResult(stored=False, vault_ref=None)

    async def upload(self, request: VaultUploadRequest, /) -> VaultUploadResult:
        """Record the request and report it durably stored."""
        self.upload_calls.append(request)
        return VaultUploadResult(
            stored=True, vault_ref="vault-fragment-1", action=VaultIngestAction.CREATED, tags=()
        )

    async def classify(self, _body: str, _ceiling: VaultTierCeiling, /) -> VaultClassification:
        """Return no tags -- the import surface never calls vault classify."""
        return VaultClassification(tags=())

    async def reflect(self, _body: str, _ceiling: VaultTierCeiling, /) -> VaultReflection:
        """Return an empty reflection -- the import surface never reflects."""
        return _empty_reflection()

    async def wheel(self) -> VaultWheelBalance:
        """Return an empty balance -- the import surface never reads the wheel."""
        return VaultWheelBalance(aspects=())


def _install(client: CreekVaultClient) -> None:
    """Make ``client`` the vault every request in this test resolves to."""
    app.dependency_overrides[get_creek_vault_client] = lambda: client


@pytest_asyncio.fixture
async def vault() -> AsyncGenerator[ScriptedVault, None]:
    """Serve a caller who has a vault they can reach."""
    client = ScriptedVault()
    _install(client)
    yield client
    app.dependency_overrides.pop(get_creek_vault_client, None)


@pytest_asyncio.fixture
async def no_vault() -> AsyncGenerator[None, None]:
    """Serve a caller who reaches no vault at all -- the floor everyone starts on."""
    _install(LocalFallbackCreekVaultClient())
    yield
    app.dependency_overrides.pop(get_creek_vault_client, None)


async def _signup(client: AsyncClient, username: str) -> dict[str, str]:
    """Sign up a fresh account and return an Authorization header for it."""
    response = await client.post(
        "/auth/signup",
        json={"email": f"{username}@example.com", "password": _SIGNUP_PASSWORD},
    )
    assert response.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {response.json()['token']}"}


async def _grant_consent(client: AsyncClient, headers: dict[str, str]) -> None:
    """Agree to ontologize uploaded documents, through the real consent surface."""
    response = await client.put(_CONSENT_PATH, json={"granted": True}, headers=headers)
    assert response.status_code == HTTPStatus.OK


def _payload(
    *,
    filename: str = _MARKDOWN_NAME,
    content_base64: str = _MARKDOWN_B64,
    classification: str = "personal",
) -> dict[str, str]:
    """Build a request body with per-test overrides."""
    return {
        "filename": filename,
        "content_base64": content_base64,
        "classification": classification,
    }


async def _fragments(session: AsyncSession, source: CorpusSource) -> list[CorpusFragment]:
    """Return every fragment in the database from one source."""
    result = await session.execute(
        select(CorpusFragment).where(col(CorpusFragment.source) == source.value)
    )
    return list(result.scalars().all())


class TestVaultDestinationUnchanged:
    """A caller who reaches a vault gets the vault, at every tier, as before."""

    @pytest.mark.asyncio
    async def test_the_document_goes_to_the_vault(
        self, async_client: AsyncClient, vault: ScriptedVault, classifier: _ClassifierCalls
    ) -> None:
        """The vault's own ingestors read the document; adepthood forwards bytes."""
        headers = await _signup(async_client, "import-vault")
        response = await async_client.post(_IMPORT_PATH, json=_payload(), headers=headers)
        assert response.status_code == HTTPStatus.ACCEPTED
        body = response.json()
        assert body["destination"] == ImportDestination.VAULT.value
        assert body["vault_status"] == VaultUploadStatus.ACCEPTED.value
        assert body["stored"] is True
        assert len(vault.upload_calls) == 1
        assert classifier.count == 0

    @pytest.mark.asyncio
    @pytest.mark.usefixtures("vault")
    async def test_nothing_is_written_to_the_local_corpus(
        self,
        async_client: AsyncClient,
        db_session: AsyncSession,
        classifier: _ClassifierCalls,
    ) -> None:
        """One destination per document. A vault user's corpus is their vault."""
        headers = await _signup(async_client, "import-vault-nolocal")
        await _grant_consent(async_client, headers)
        await async_client.post(_IMPORT_PATH, json=_payload(), headers=headers)
        assert await _fragments(db_session, CorpusSource.UPLOAD) == []
        assert classifier.count == 0

    @pytest.mark.asyncio
    @pytest.mark.usefixtures("vault")
    async def test_an_intimate_document_still_reaches_the_vault_path(
        self, async_client: AsyncClient
    ) -> None:
        """Unchanged: the vault path decides intimate at its own wire door, not here."""
        headers = await _signup(async_client, "import-vault-intimate")
        response = await async_client.post(
            _IMPORT_PATH, json=_payload(classification="intimate"), headers=headers
        )
        assert response.json()["destination"] == ImportDestination.VAULT.value
        assert response.json()["vault_status"] == VaultUploadStatus.CAPABILITY_UNSUPPORTED.value
        assert response.json()["stored"] is False

    @pytest.mark.asyncio
    async def test_a_document_format_adepthood_cannot_read_still_goes_to_the_vault(
        self, async_client: AsyncClient, vault: ScriptedVault
    ) -> None:
        """A PDF is exactly what a vault is for; adepthood's own reader is irrelevant here."""
        headers = await _signup(async_client, "import-vault-pdf")
        pdf = base64.b64encode(b"%PDF-1.7 pages").decode("ascii")
        response = await async_client.post(
            _IMPORT_PATH,
            json=_payload(filename="scan.pdf", content_base64=pdf),
            headers=headers,
        )
        assert response.json()["vault_status"] == VaultUploadStatus.ACCEPTED.value
        assert len(vault.upload_calls) == 1


@pytest.mark.usefixtures("no_vault")
class TestAnAccountWithNoVaultIsAskedForOne:
    """With no vault there is nowhere to keep a document, and the answer says so (#3015)."""

    @pytest.mark.asyncio
    async def test_a_consented_no_vault_import_is_answered_vault_required_and_stores_nothing(
        self,
        async_client: AsyncClient,
        db_session: AsyncSession,
        classifier: _ClassifierCalls,
    ) -> None:
        """Even with the switch for documents on, a document with nowhere to live is not kept."""
        headers = await _signup(async_client, "import-asked-for-a-vault")
        await _grant_consent(async_client, headers)
        response = await async_client.post(_IMPORT_PATH, json=_payload(), headers=headers)
        assert response.status_code == HTTPStatus.ACCEPTED
        body = response.json()
        assert body["destination"] == ImportDestination.CORPUS.value
        assert body["stored"] is False
        assert body["corpus_status"] == CorpusImportStatus.VAULT_REQUIRED.value
        assert body["fragment_id"] is None
        assert body["vault_status"] is None
        assert body["vault_ref"] is None
        assert body["message"] == CORPUS_IMPORT_MESSAGES[CorpusImportStatus.VAULT_REQUIRED]
        assert await _fragments(db_session, CorpusSource.UPLOAD) == []
        assert classifier.count == 0

    @pytest.mark.asyncio
    async def test_a_no_vault_account_without_consent_is_asked_for_a_vault_not_for_consent(
        self, async_client: AsyncClient, classifier: _ClassifierCalls
    ) -> None:
        """Consent is never consulted on this branch, so it cannot be the answer."""
        headers = await _signup(async_client, "import-vault-before-consent")
        response = await async_client.post(_IMPORT_PATH, json=_payload(), headers=headers)
        assert response.json()["corpus_status"] == CorpusImportStatus.VAULT_REQUIRED.value
        assert classifier.count == 0

    @pytest.mark.asyncio
    async def test_a_no_vault_pdf_is_asked_for_a_vault_not_refused_as_unreadable(
        self, async_client: AsyncClient, classifier: _ClassifierCalls
    ) -> None:
        """The document is never read, so its format is never the reason."""
        headers = await _signup(async_client, "import-vault-before-format")
        await _grant_consent(async_client, headers)
        pdf = base64.b64encode(b"%PDF-1.7 pages").decode("ascii")
        response = await async_client.post(
            _IMPORT_PATH,
            json=_payload(filename="scan.pdf", content_base64=pdf),
            headers=headers,
        )
        assert response.json()["corpus_status"] == CorpusImportStatus.VAULT_REQUIRED.value
        assert classifier.count == 0

    @pytest.mark.asyncio
    async def test_a_no_vault_intimate_document_is_asked_for_a_vault_not_refused_by_tier(
        self, async_client: AsyncClient, classifier: _ClassifierCalls
    ) -> None:
        """No language model is in reach on this branch, so the tier is not the reason."""
        headers = await _signup(async_client, "import-vault-before-tier")
        await _grant_consent(async_client, headers)
        response = await async_client.post(
            _IMPORT_PATH, json=_payload(classification="intimate"), headers=headers
        )
        assert response.json()["corpus_status"] == CorpusImportStatus.VAULT_REQUIRED.value
        assert response.json()["stored"] is False
        assert classifier.count == 0

    @pytest.mark.asyncio
    async def test_no_vault_pipeline_is_driven_for_a_document_with_nowhere_to_go(
        self, async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The ontologization pass belongs to a vault; an account without one starts none."""
        driven: list[object] = []

        async def counting(*args: object, **kwargs: object) -> None:
            driven.append((args, kwargs))

        monkeypatch.setattr(corpus_router, "drive_vault_pipeline", counting)
        headers = await _signup(async_client, "import-vault-no-pipeline")
        await _grant_consent(async_client, headers)
        response = await async_client.post(_IMPORT_PATH, json=_payload(), headers=headers)
        assert response.json()["corpus_status"] == CorpusImportStatus.VAULT_REQUIRED.value
        assert driven == []


class TestTheRealResolverAnswersVaultRequired:
    """The rule reads the resolver itself, not only a test's override of it."""

    @pytest.mark.asyncio
    async def test_an_account_the_resolver_finds_no_vault_for_is_asked_for_one(
        self,
        async_client: AsyncClient,
        db_session: AsyncSession,
        classifier: _ClassifierCalls,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """No connection row and no deployment binding: the resolver's fallback answers."""
        monkeypatch.delenv(OWNER_ENV_VAR, raising=False)
        monkeypatch.delenv("CREEK_VAULT_URL", raising=False)
        assert get_creek_vault_client not in app.dependency_overrides
        headers = await _signup(async_client, "import-real-resolver")
        await _grant_consent(async_client, headers)
        response = await async_client.post(_IMPORT_PATH, json=_payload(), headers=headers)
        assert response.status_code == HTTPStatus.ACCEPTED
        assert response.json()["corpus_status"] == CorpusImportStatus.VAULT_REQUIRED.value
        assert await _fragments(db_session, CorpusSource.UPLOAD) == []
        assert classifier.count == 0


class TestTheServiceTakesNoLocalBranch:
    """The no-vault answer is decided before anything about the document is looked at."""

    @pytest.mark.asyncio
    async def test_import_document_answers_vault_required_without_reading_or_classifying(
        self, classifier: _ClassifierCalls
    ) -> None:
        """An undecodable intimate PDF still gets the one answer, and costs nothing.

        The service is handed no session, so there is no consent to read and no
        fragment it could write; the classifier count proves no provider call.
        """
        document = UploadedDocument(
            owner_user_id=1,
            filename="scan.pdf",
            content_base64=base64.b64encode(b"\xff\xfe not text").decode("ascii"),
            classification="intimate",
            created_at=datetime.now(UTC),
        )
        result = await import_document(LocalFallbackCreekVaultClient(), document)
        assert result is VAULT_REQUIRED_RESULT
        assert result.status is CorpusImportStatus.VAULT_REQUIRED
        assert result.stored is False
        assert result.fragment_id is None
        assert classifier.count == 0


@pytest.mark.usefixtures("no_vault")
class TestTheRequestIsBounded:
    """The import reuses the upload path's ceiling rather than inventing a second."""

    @pytest.mark.asyncio
    async def test_an_oversized_document_is_refused_before_it_is_decoded(
        self, async_client: AsyncClient, classifier: _ClassifierCalls
    ) -> None:
        """Rejected on the encoded length, so the decoded bytes are never allocated."""
        headers = await _signup(async_client, "import-too-large")
        response = await async_client.post(
            _IMPORT_PATH,
            json=_payload(content_base64="A" * (MAX_UPLOAD_BASE64_CHARS + 1)),
            headers=headers,
        )
        assert response.status_code == HTTPStatus.REQUEST_ENTITY_TOO_LARGE
        assert response.json()["detail"] == "document_too_large"
        assert classifier.count == 0

    def test_the_decoded_ceiling_catches_what_the_encoded_pre_guard_lets_through(self) -> None:
        """The second gate is not redundant: base64 rounding leaves a gap, and it is real.

        One byte over the ceiling encodes to just *under*
        :data:`MAX_UPLOAD_BASE64_CHARS`, so the cheap pre-guard admits it. Only
        the decoded-length check refuses it, which is why both exist.
        """
        oversized = base64.b64encode(b"a" * (MAX_UPLOAD_BYTES + 1)).decode("ascii")
        assert len(oversized) <= MAX_UPLOAD_BASE64_CHARS
        with pytest.raises(DocumentTooLargeError):
            decode_document(oversized)

    @pytest.mark.asyncio
    async def test_a_document_we_cannot_decode_is_a_different_defect(
        self, async_client: AsyncClient
    ) -> None:
        """A broken encoding is a 422: forwarding bytes we could not read helps nobody."""
        headers = await _signup(async_client, "import-bad-encoding")
        response = await async_client.post(
            _IMPORT_PATH, json=_payload(content_base64="not base64 at all!!"), headers=headers
        )
        assert response.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
        assert response.json()["detail"] == "invalid_document_encoding"

    @pytest.mark.asyncio
    async def test_a_path_shaped_filename_is_refused(self, async_client: AsyncClient) -> None:
        """The import reuses the upload request's own validation rather than a looser copy."""
        headers = await _signup(async_client, "import-bad-name")
        response = await async_client.post(
            _IMPORT_PATH, json=_payload(filename="../secrets.md"), headers=headers
        )
        assert response.status_code == HTTPStatus.UNPROCESSABLE_ENTITY

    @pytest.mark.asyncio
    async def test_an_anonymous_caller_cannot_import(self, async_client: AsyncClient) -> None:
        """The corpus is one account's; there is no unauthenticated way into one."""
        response = await async_client.post(_IMPORT_PATH, json=_payload())
        assert response.status_code == HTTPStatus.UNAUTHORIZED


class TestTheAnswerIsSelfDescribing:
    """One status field is filled, it matches the destination, and it has a sentence."""

    @pytest.mark.asyncio
    @pytest.mark.usefixtures("vault")
    async def test_a_vault_answer_carries_no_corpus_status(self, async_client: AsyncClient) -> None:
        """Exactly one vocabulary answers, so a client never has to guess which applies."""
        headers = await _signup(async_client, "import-shape-vault")
        response = await async_client.post(_IMPORT_PATH, json=_payload(), headers=headers)
        body = response.json()
        assert body["corpus_status"] is None
        assert body["vault_status"] is not None
        assert body["message"]

    @pytest.mark.asyncio
    @pytest.mark.usefixtures("no_vault")
    async def test_a_corpus_answer_carries_no_vault_status(self, async_client: AsyncClient) -> None:
        """The mirror of the above, and the reason the destination field exists."""
        headers = await _signup(async_client, "import-shape-corpus")
        response = await async_client.post(_IMPORT_PATH, json=_payload(), headers=headers)
        body = response.json()
        assert body["vault_status"] is None
        assert body["vault_ref"] is None
        assert body["corpus_status"] == CorpusImportStatus.VAULT_REQUIRED.value
        assert body["message"]

    def test_every_corpus_outcome_has_a_sentence_for_the_person_who_sent_it(self) -> None:
        """A status with no message would reach a user as a bare token from an enum."""
        assert set(CORPUS_IMPORT_MESSAGES) == set(CorpusImportStatus)
        assert all(CORPUS_IMPORT_MESSAGES[status] for status in CorpusImportStatus)


class TestTheRoutingRuleReadsTheResolver:
    """Which destination a document gets is the vault resolver's own answer."""

    def test_the_local_fallback_client_means_no_vault(self) -> None:
        """This is the class the resolver returns for an account that connected none."""
        assert reaches_a_vault(LocalFallbackCreekVaultClient()) is False

    def test_any_other_client_means_a_vault(self) -> None:
        """A connected vault, or the deployment's, is a vault whatever its weather."""
        assert reaches_a_vault(ScriptedVault()) is True
