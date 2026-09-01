"""The import surface: a document a user chose, routed by whether they have a vault.

Until this existed, a person's corpus held only what they had typed into this
app. The upload path was real but had exactly one destination -- the vault --
so an account with no vault connected sent a document and was told their vault
had not answered, which was not true of a vault they never had.

Three properties are asserted here, each through the real HTTP surface.

*A caller who reaches a vault is unchanged.* The document goes to the vault at
its own tier, at every tier, and nothing is written to the local corpus and no
provider is contacted -- the vault ingests documents itself.

*A caller who reaches no vault is answered honestly.* Their document is read,
classified once, and stored in their own corpus, under the same consent gate
and through the same writer a journal entry goes through.

*INTIMATE never becomes a fragment.* With no vault, an intimate document is
declined outright rather than stored unclassified, and the refusal happens
before any provider is contacted. That asymmetry with the vault path is
deliberate: the vault path calls no language model, and this one does.
"""

from __future__ import annotations

import base64
import json
from collections.abc import AsyncGenerator
from http import HTTPStatus
from types import SimpleNamespace

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from dependencies.creek_vault import get_creek_vault_client
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
from domain.document_text import DocumentReadFailure, read_document
from domain.frequencies import Frequency
from main import app
from models.corpus_fragment import CorpusFragment, CorpusSource
from schemas.corpus_import import CORPUS_IMPORT_MESSAGES
from schemas.journal import JOURNAL_MESSAGE_MAX_LENGTH
from schemas.journal_upload import (
    MAX_UPLOAD_BASE64_CHARS,
    MAX_UPLOAD_BYTES,
    DocumentTooLargeError,
    decode_document,
)
from services import frequency_classification as fc
from services.botmason import LLMCreditExhaustedError
from services.corpus_import import (
    _INGEST_STATUS,
    _READ_FAILURE_STATUS,
    reaches_a_vault,
)
from services.corpus_ingest import IngestOutcome
from services.creek_vault_client import LocalFallbackCreekVaultClient

_SIGNUP_PASSWORD = "secret12345"  # pragma: allowlist secret

_IMPORT_PATH = "/corpus/import"
_CONSENT_PATH = f"/corpus/consent/{CorpusSource.UPLOAD.value}"

_MARKDOWN_NAME = "on-patience.md"
_PROSE = "I kept the appointment I had been dreading, and the dread was the worst of it."
_MARKDOWN_B64 = base64.b64encode(_PROSE.encode()).decode("ascii")

# A reply the classifier's parser accepts, naming one position on the ontology.
_CLASSIFIED_REPLY = json.dumps({"weights": {Frequency.F5.value: 0.9}, "overall_confidence": 0.9})

# A well-formed reply that recognises nothing, which is a real outcome rather
# than a provider fault.
_UNCLASSIFIED_REPLY = json.dumps({"weights": {}, "overall_confidence": 0.0})


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


class ScriptedVault:
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


class TestReadingADocument:
    """What adepthood can and cannot read out of a document on its own."""

    def test_markdown_is_read_as_the_text_it_is(self) -> None:
        """Markdown is text somebody wrote; it needs no parser to be readable."""
        assert read_document(_MARKDOWN_NAME, _PROSE.encode()) == _PROSE

    def test_plain_text_is_read_as_the_text_it_is(self) -> None:
        """A ``.txt`` export is the other half of what a person can hand over by hand."""
        assert read_document("notes.txt", _PROSE.encode()) == _PROSE

    def test_the_suffix_is_matched_regardless_of_case(self) -> None:
        """A file named in capitals is the same file; the extension is not a password."""
        assert read_document("NOTES.MD", _PROSE.encode()) == _PROSE

    def test_a_binary_document_format_is_not_readable_here(self) -> None:
        """A PDF needs an ingestor. Adepthood has none and never claims to."""
        assert read_document("scan.pdf", b"%PDF-1.7 pages") is DocumentReadFailure.FORMAT_UNREADABLE

    def test_bytes_that_are_not_text_are_refused_rather_than_mangled(self) -> None:
        """A ``.md`` full of arbitrary bytes is not writing, whatever it is named."""
        assert read_document("broken.md", b"\xff\xfe\x00rubbish") is DocumentReadFailure.NOT_TEXT

    def test_a_document_with_no_writing_in_it_is_refused(self) -> None:
        """Whitespace carries no position on the ontology, so there is nothing to store."""
        assert read_document("blank.md", b"   \n\n  \t ") is DocumentReadFailure.EMPTY

    def test_more_writing_than_one_fragment_may_hold_is_refused(self) -> None:
        """A fragment is quoted verbatim into a grounding prompt, so it stays bounded."""
        oversized = "a" * (JOURNAL_MESSAGE_MAX_LENGTH + 1)
        assert read_document("essay.md", oversized.encode()) is DocumentReadFailure.TOO_LONG

    def test_a_document_at_the_ceiling_is_read(self) -> None:
        """The ceiling is inclusive; a document exactly at it is not a document over it."""
        at_ceiling = "a" * JOURNAL_MESSAGE_MAX_LENGTH
        assert read_document("essay.md", at_ceiling.encode()) == at_ceiling


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
class TestCorpusDestination:
    """A caller who reaches no vault imports into their own corpus, or is told why not."""

    @pytest.mark.asyncio
    @pytest.mark.usefixtures("classifier")
    async def test_a_consented_document_becomes_a_fragment(
        self, async_client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """The whole point: writing from outside the app reaches the corpus."""
        headers = await _signup(async_client, "import-corpus")
        await _grant_consent(async_client, headers)
        response = await async_client.post(_IMPORT_PATH, json=_payload(), headers=headers)
        assert response.status_code == HTTPStatus.ACCEPTED
        body = response.json()
        assert body["destination"] == ImportDestination.CORPUS.value
        assert body["corpus_status"] == CorpusImportStatus.STORED.value
        assert body["stored"] is True
        assert body["fragment_id"] is not None
        stored = await _fragments(db_session, CorpusSource.UPLOAD)
        assert [fragment.content for fragment in stored] == [_PROSE]

    @pytest.mark.asyncio
    async def test_the_import_costs_exactly_one_classification(
        self, async_client: AsyncClient, classifier: _ClassifierCalls
    ) -> None:
        """One document, one provider call. A second would double every account's bill."""
        headers = await _signup(async_client, "import-corpus-cost")
        await _grant_consent(async_client, headers)
        await async_client.post(_IMPORT_PATH, json=_payload(), headers=headers)
        assert classifier.count == 1

    @pytest.mark.asyncio
    async def test_without_consent_nothing_is_stored_and_nobody_is_contacted(
        self,
        async_client: AsyncClient,
        db_session: AsyncSession,
        classifier: _ClassifierCalls,
    ) -> None:
        """An account that has agreed to nothing has its writing sent nowhere."""
        headers = await _signup(async_client, "import-corpus-noconsent")
        response = await async_client.post(_IMPORT_PATH, json=_payload(), headers=headers)
        body = response.json()
        assert body["corpus_status"] == CorpusImportStatus.CONSENT_REQUIRED.value
        assert body["stored"] is False
        assert classifier.count == 0
        assert await _fragments(db_session, CorpusSource.UPLOAD) == []

    @pytest.mark.asyncio
    async def test_an_intimate_document_is_declined_before_any_provider_is_reached(
        self,
        async_client: AsyncClient,
        db_session: AsyncSession,
        classifier: _ClassifierCalls,
    ) -> None:
        """The asymmetry with the vault path: this destination calls a language model."""
        headers = await _signup(async_client, "import-corpus-intimate")
        await _grant_consent(async_client, headers)
        response = await async_client.post(
            _IMPORT_PATH, json=_payload(classification="intimate"), headers=headers
        )
        body = response.json()
        assert body["destination"] == ImportDestination.CORPUS.value
        assert body["corpus_status"] == CorpusImportStatus.TIER_REFUSED.value
        assert body["stored"] is False
        assert classifier.count == 0
        assert await _fragments(db_session, CorpusSource.UPLOAD) == []

    @pytest.mark.asyncio
    async def test_a_format_adepthood_cannot_read_is_declined_before_classification(
        self, async_client: AsyncClient, classifier: _ClassifierCalls
    ) -> None:
        """With no vault there is no ingestor, and saying so beats storing nothing quietly."""
        headers = await _signup(async_client, "import-corpus-pdf")
        await _grant_consent(async_client, headers)
        pdf = base64.b64encode(b"%PDF-1.7 pages").decode("ascii")
        response = await async_client.post(
            _IMPORT_PATH,
            json=_payload(filename="scan.pdf", content_base64=pdf),
            headers=headers,
        )
        assert response.json()["corpus_status"] == CorpusImportStatus.FORMAT_UNREADABLE.value
        assert classifier.count == 0

    @pytest.mark.parametrize("classifier", [_UNCLASSIFIED_REPLY], indirect=True)
    @pytest.mark.asyncio
    async def test_a_document_carrying_no_frequency_is_not_stored(
        self,
        async_client: AsyncClient,
        db_session: AsyncSession,
        classifier: _ClassifierCalls,
    ) -> None:
        """The corpus earns its place by being ontologized; an unplaced fragment cannot rank."""
        headers = await _signup(async_client, "import-corpus-unclassified")
        await _grant_consent(async_client, headers)
        response = await async_client.post(_IMPORT_PATH, json=_payload(), headers=headers)
        assert response.json()["corpus_status"] == CorpusImportStatus.UNCLASSIFIED.value
        assert classifier.count == 1
        assert await _fragments(db_session, CorpusSource.UPLOAD) == []

    @pytest.mark.asyncio
    async def test_a_provider_that_refused_to_bill_answers_what_a_dead_one_answers(
        self,
        async_client: AsyncClient,
        db_session: AsyncSession,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """One import is one call, so a spent balance changes nothing this caller sees.

        The condition is raised rather than degraded so that a caller offering a
        *batch* can stop paying for a refusal it has already been given. This
        caller offers one document, so it is answered exactly as a dead provider
        already is, stores nothing, and can be offered again.
        """

        async def refusing(**_kwargs: object) -> SimpleNamespace:
            raise LLMCreditExhaustedError("credit balance is too low", provider="anthropic")

        monkeypatch.setattr(fc, "generate_response", refusing)
        headers = await _signup(async_client, "import-corpus-unbilled")
        await _grant_consent(async_client, headers)

        response = await async_client.post(_IMPORT_PATH, json=_payload(), headers=headers)

        assert response.status_code == HTTPStatus.ACCEPTED, response.text
        assert response.json()["corpus_status"] == CorpusImportStatus.UNCLASSIFIED.value
        assert await _fragments(db_session, CorpusSource.UPLOAD) == []

    @pytest.mark.asyncio
    @pytest.mark.usefixtures("classifier")
    async def test_withdrawing_consent_takes_the_imported_writing_with_it(
        self, async_client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """A permission that can be revoked while the material stays is a preference."""
        headers = await _signup(async_client, "import-corpus-revoke")
        await _grant_consent(async_client, headers)
        await async_client.post(_IMPORT_PATH, json=_payload(), headers=headers)
        assert await _fragments(db_session, CorpusSource.UPLOAD) != []
        revoked = await async_client.put(_CONSENT_PATH, json={"granted": False}, headers=headers)
        assert revoked.status_code == HTTPStatus.OK
        assert await _fragments(db_session, CorpusSource.UPLOAD) == []

    @pytest.mark.asyncio
    @pytest.mark.usefixtures("classifier")
    async def test_an_imported_fragment_is_marked_as_uploaded_not_as_journal(
        self, async_client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """Consent is per source, so a fragment has to say which source it came from."""
        headers = await _signup(async_client, "import-corpus-source")
        await _grant_consent(async_client, headers)
        await async_client.post(_IMPORT_PATH, json=_payload(), headers=headers)
        assert await _fragments(db_session, CorpusSource.JOURNAL) == []
        [fragment] = await _fragments(db_session, CorpusSource.UPLOAD)
        assert fragment.source_entry_id is None


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
    @pytest.mark.usefixtures("no_vault", "classifier")
    async def test_a_corpus_answer_carries_no_vault_status(self, async_client: AsyncClient) -> None:
        """The mirror of the above, and the reason the destination field exists."""
        headers = await _signup(async_client, "import-shape-corpus")
        await _grant_consent(async_client, headers)
        response = await async_client.post(_IMPORT_PATH, json=_payload(), headers=headers)
        body = response.json()
        assert body["vault_status"] is None
        assert body["vault_ref"] is None
        assert body["corpus_status"] is not None
        assert body["message"]

    def test_every_corpus_outcome_has_a_sentence_for_the_person_who_sent_it(self) -> None:
        """A status with no message would reach a user as a bare token from an enum."""
        assert set(CORPUS_IMPORT_MESSAGES) == set(CorpusImportStatus)
        assert all(CORPUS_IMPORT_MESSAGES[status] for status in CorpusImportStatus)

    def test_every_read_failure_has_a_status_of_its_own(self) -> None:
        """A reader outcome with no projection would reach a person as a KeyError."""
        assert set(_READ_FAILURE_STATUS) == set(DocumentReadFailure)

    def test_every_ingest_outcome_has_a_status_of_its_own(self) -> None:
        """The ingest spine is shared, so an outcome added there must land here."""
        assert set(_INGEST_STATUS) == set(IngestOutcome)


class TestTheRoutingRuleReadsTheResolver:
    """Which destination a document gets is the vault resolver's own answer."""

    def test_the_local_fallback_client_means_no_vault(self) -> None:
        """This is the class the resolver returns for an account that connected none."""
        assert reaches_a_vault(LocalFallbackCreekVaultClient()) is False

    def test_any_other_client_means_a_vault(self) -> None:
        """A connected vault, or the deployment's, is a vault whatever its weather."""
        assert reaches_a_vault(ScriptedVault()) is True
