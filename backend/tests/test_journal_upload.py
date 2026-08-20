"""Integration tests for ``POST /journal/upload``, the document upload endpoint.

These drive the real endpoint against a scripted vault client to pin what the
router owes the person uploading a file. An upload has no local system of
record -- unlike a journal entry, which is already in Postgres before the vault
is ever asked -- so every one of these outcomes is the *whole* answer the user
gets, and each has to be honest and actionable on its own.

Four properties are pinned here that no lower layer can guarantee alone:

- Every vault condition answers 202 with a distinguishable status, never a 500.
- An oversized document is refused by size *before* its bytes are decoded.
- An intimate document is forwarded at its own tier, and is not rerouted
  anywhere when the vault is unreachable.
- A rejection never echoes the document back through the error envelope.
"""

from __future__ import annotations

import base64
from collections.abc import AsyncGenerator
from datetime import UTC, datetime
from http import HTTPStatus

import pytest
import pytest_asyncio
from httpx import AsyncClient

from dependencies.creek_vault import get_creek_vault_client
from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
    CreekCapabilityUnsupportedError,
    CreekVaultClient,
    CreekVaultUnavailableError,
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
from main import app
from routers.journal import _UPLOAD_MESSAGES, UPLOAD_RATE_LIMIT
from routers.transcription import TRANSCRIBE_RATE_LIMIT
from schemas.journal_upload import MAX_UPLOAD_BASE64_CHARS

_SIGNUP_PASSWORD = "secret12345"  # pragma: allowlist secret

_UPLOAD_PATH = "/journal/upload"

_FILENAME = "field-notes.pdf"

_DOCUMENT_BYTES = b"%PDF-1.7 a page of field notes"
_CONTENT_B64 = base64.b64encode(_DOCUMENT_BYTES).decode("ascii")

_FRAGMENT_ID = "vault-fragment-upload-1"


def _empty_reflection() -> VaultReflection:
    """Return the reflection an unexercised reflect path answers with."""
    return VaultReflection(
        status=VaultReflectionStatus.EMPTY,
        notes=(),
        essay=None,
        essay_grounded=False,
        routed_tier=VaultTierCeiling.OPEN,
    )


class ScriptedUploadClient:
    """Fake :class:`CreekVaultClient` whose upload surface is scripted per test."""

    def __init__(
        self,
        *,
        capabilities: frozenset[CreekCapability] = frozenset(
            {CreekCapability.JOURNAL, CreekCapability.UPLOAD}
        ),
        available: bool = True,
        stored: bool = True,
        tags: tuple[str, ...] = (),
        upload_error: Exception | None = None,
    ) -> None:
        """Bind the advertised capabilities and the scripted upload answer."""
        self.upload_calls: list[VaultUploadRequest] = []
        self._capabilities = capabilities
        self._available = available
        self._stored = stored
        self._tags = tags
        self._upload_error = upload_error

    async def handshake(self) -> HandshakeResult:
        """Report the configured availability and capability set."""
        if not self._available:
            return HandshakeResult.unavailable()
        return HandshakeResult(
            available=True,
            contract_version=CONTRACT_VERSION,
            ontology_version="1.0.0",
            capabilities=self._capabilities,
            attestation=None,
        )

    def is_available(self) -> bool:
        """Report the configured availability."""
        return self._available

    def supports(self, capability: CreekCapability, /) -> bool:
        """Report whether ``capability`` is in the configured advertised set."""
        return capability in self._capabilities

    async def ingest(self, _request: VaultIngestRequest, /) -> VaultIngestResult:
        """Report not-stored -- the upload endpoint never calls journal ingest."""
        return VaultIngestResult(stored=False, vault_ref=None)

    async def upload(self, request: VaultUploadRequest, /) -> VaultUploadResult:
        """Record the request, then raise the scripted error or answer with the result."""
        self.upload_calls.append(request)
        if self._upload_error is not None:
            raise self._upload_error
        if not self._stored:
            return VaultUploadResult(stored=False, vault_ref=None, action=None, tags=())
        return VaultUploadResult(
            stored=True,
            vault_ref=_FRAGMENT_ID,
            action=VaultIngestAction.CREATED,
            tags=self._tags,
        )

    async def classify(self, _body: str, _tier_ceiling: VaultTierCeiling, /) -> VaultClassification:
        """Return no tags -- the upload endpoint never calls classify."""
        return VaultClassification(tags=())

    async def reflect(self, _body: str, _tier_ceiling: VaultTierCeiling, /) -> VaultReflection:
        """Return an empty reflection -- the upload endpoint never calls reflect."""
        return _empty_reflection()

    async def wheel(self) -> VaultWheelBalance:
        """Return an empty balance -- the upload endpoint never calls wheel."""
        return VaultWheelBalance(aspects=())


async def _signup(client: AsyncClient, username: str) -> dict[str, str]:
    """Sign up a fresh user and return an Authorization header for it."""
    response = await client.post(
        "/auth/signup",
        json={"email": f"{username}@example.com", "password": _SIGNUP_PASSWORD},
    )
    assert response.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {response.json()['token']}"}


@pytest_asyncio.fixture
async def vault(request: pytest.FixtureRequest) -> AsyncGenerator[ScriptedUploadClient, None]:
    """Install a scripted vault client as the endpoint's dependency for one test.

    Parameterized through ``indirect``: a test that needs a degrading vault names
    the keyword arguments the client should be built from.
    """
    kwargs = getattr(request, "param", {})
    client = ScriptedUploadClient(**kwargs)
    app.dependency_overrides[get_creek_vault_client] = lambda: client
    yield client
    app.dependency_overrides.pop(get_creek_vault_client, None)


def _payload(
    *,
    filename: str = _FILENAME,
    content_base64: str = _CONTENT_B64,
    classification: str = "personal",
) -> dict[str, str]:
    """Build a request body with per-test overrides."""
    return {
        "filename": filename,
        "content_base64": content_base64,
        "classification": classification,
    }


class TestUploadAcceptance:
    """A reachable, upload-capable vault takes the document and says so."""

    @pytest.mark.asyncio
    async def test_accepted_upload_answers_202(
        self, async_client: AsyncClient, vault: ScriptedUploadClient
    ) -> None:
        """202: the vault has it, and nothing further is pending on this request."""
        headers = await _signup(async_client, "uploader-accept")
        response = await async_client.post(_UPLOAD_PATH, json=_payload(), headers=headers)
        assert response.status_code == HTTPStatus.ACCEPTED
        assert response.json()["status"] == VaultUploadStatus.ACCEPTED.value
        assert len(vault.upload_calls) == 1

    @pytest.mark.asyncio
    async def test_accepted_upload_returns_the_vault_ref(
        self, async_client: AsyncClient, vault: ScriptedUploadClient
    ) -> None:
        """The fragment handle is how a client can later refer to what it sent."""
        headers = await _signup(async_client, "uploader-ref")
        response = await async_client.post(_UPLOAD_PATH, json=_payload(), headers=headers)
        assert response.json()["vault_ref"] == _FRAGMENT_ID
        assert vault.upload_calls[0].external_id

    @pytest.mark.asyncio
    async def test_tags_are_empty_until_the_vault_returns_them(
        self, async_client: AsyncClient, vault: ScriptedUploadClient
    ) -> None:
        """Empty is the correct answer today, not a failure -- pinned so it stays honest."""
        headers = await _signup(async_client, "uploader-tags-empty")
        response = await async_client.post(_UPLOAD_PATH, json=_payload(), headers=headers)
        assert response.json()["tags"] == []
        assert len(vault.upload_calls) == 1

    @pytest.mark.parametrize("vault", [{"tags": ("courage", "threshold")}], indirect=True)
    @pytest.mark.asyncio
    async def test_vault_supplied_tags_are_returned_verbatim(
        self, async_client: AsyncClient, vault: ScriptedUploadClient
    ) -> None:
        """The vault classifies in-pipeline; adepthood never builds a second classifier."""
        headers = await _signup(async_client, "uploader-tags")
        response = await async_client.post(_UPLOAD_PATH, json=_payload(), headers=headers)
        assert response.json()["tags"] == ["courage", "threshold"]
        assert len(vault.upload_calls) == 1

    @pytest.mark.asyncio
    async def test_the_document_is_forwarded_unparsed(
        self, async_client: AsyncClient, vault: ScriptedUploadClient
    ) -> None:
        """Adepthood hands over bytes and a name; it never parses the file itself."""
        headers = await _signup(async_client, "uploader-forward")
        await async_client.post(_UPLOAD_PATH, json=_payload(), headers=headers)
        assert vault.upload_calls[0].filename == _FILENAME
        assert vault.upload_calls[0].content_base64 == _CONTENT_B64

    @pytest.mark.asyncio
    async def test_resending_the_same_document_addresses_one_fragment(
        self, async_client: AsyncClient, vault: ScriptedUploadClient
    ) -> None:
        """Idempotence: a re-send edits the fragment in place instead of duplicating it."""
        headers = await _signup(async_client, "uploader-idempotent")
        await async_client.post(_UPLOAD_PATH, json=_payload(), headers=headers)
        await async_client.post(_UPLOAD_PATH, json=_payload(), headers=headers)
        assert vault.upload_calls[0].external_id == vault.upload_calls[1].external_id

    @pytest.mark.asyncio
    async def test_two_users_uploading_the_same_name_get_separate_fragments(
        self, async_client: AsyncClient, vault: ScriptedUploadClient
    ) -> None:
        """One user's ``notes.pdf`` must never overwrite another's."""
        first = await _signup(async_client, "uploader-tenant-a")
        second = await _signup(async_client, "uploader-tenant-b")
        await async_client.post(_UPLOAD_PATH, json=_payload(), headers=first)
        await async_client.post(_UPLOAD_PATH, json=_payload(), headers=second)
        assert vault.upload_calls[0].external_id != vault.upload_calls[1].external_id


class TestUploadDegradation:
    """Every vault condition is a 202 carrying a distinguishable, actionable status."""

    @pytest.mark.parametrize(
        "vault", [{"capabilities": frozenset({CreekCapability.JOURNAL})}], indirect=True
    )
    @pytest.mark.asyncio
    async def test_capability_absent_reports_capability_unsupported(
        self, async_client: AsyncClient, vault: ScriptedUploadClient
    ) -> None:
        """A journal-only vault must degrade without the document reaching the wire."""
        headers = await _signup(async_client, "uploader-nocap")
        response = await async_client.post(_UPLOAD_PATH, json=_payload(), headers=headers)
        assert response.status_code == HTTPStatus.ACCEPTED
        assert response.json()["status"] == VaultUploadStatus.CAPABILITY_UNSUPPORTED.value
        assert vault.upload_calls == []

    @pytest.mark.parametrize("vault", [{"available": False}], indirect=True)
    @pytest.mark.asyncio
    async def test_unreachable_vault_reports_vault_unavailable(
        self, async_client: AsyncClient, vault: ScriptedUploadClient
    ) -> None:
        """Unreachable and cannot-take-files are different problems with different fixes."""
        headers = await _signup(async_client, "uploader-down")
        response = await async_client.post(_UPLOAD_PATH, json=_payload(), headers=headers)
        assert response.json()["status"] == VaultUploadStatus.VAULT_UNAVAILABLE.value
        assert vault.upload_calls == []

    @pytest.mark.parametrize(
        "vault", [{"upload_error": CreekVaultUnavailableError("boom")}], indirect=True
    )
    @pytest.mark.asyncio
    async def test_transport_failure_reports_degraded_not_500(
        self, async_client: AsyncClient, vault: ScriptedUploadClient
    ) -> None:
        """A vault error must never surface as an unhandled server fault."""
        headers = await _signup(async_client, "uploader-degrade")
        response = await async_client.post(_UPLOAD_PATH, json=_payload(), headers=headers)
        assert response.status_code == HTTPStatus.ACCEPTED
        assert response.json()["status"] == VaultUploadStatus.DEGRADED.value
        # A failed upload is dropped, not queued: one attempt, never a retry.
        assert len(vault.upload_calls) == 1

    @pytest.mark.parametrize("vault", [{"stored": False}], indirect=True)
    @pytest.mark.asyncio
    async def test_not_stored_reports_degraded_with_no_ref(
        self, async_client: AsyncClient, vault: ScriptedUploadClient
    ) -> None:
        """A vault that answered without storing must not look like a success."""
        headers = await _signup(async_client, "uploader-notstored")
        response = await async_client.post(_UPLOAD_PATH, json=_payload(), headers=headers)
        assert response.json()["status"] == VaultUploadStatus.DEGRADED.value
        assert response.json()["vault_ref"] is None
        assert len(vault.upload_calls) == 1

    @pytest.mark.parametrize(
        "vault",
        [{"upload_error": CreekCapabilityUnsupportedError("refused")}],
        indirect=True,
    )
    @pytest.mark.asyncio
    async def test_a_refused_capability_reads_as_unsupported_not_as_a_retryable_break(
        self, async_client: AsyncClient, vault: ScriptedUploadClient
    ) -> None:
        """The end of the path a vault takes once it advertises an upload this client cannot make.

        A vault that offers the capability sails through the pre-call gate, so
        the refusal arrives from the call instead -- and mapped as a plain
        transport fault it would answer "please try again", for a condition no
        retry reaches. This asserts the answer the person actually receives,
        message included, rather than the status alone.
        """
        headers = await _signup(async_client, "uploader-refused")
        response = await async_client.post(_UPLOAD_PATH, json=_payload(), headers=headers)
        assert response.status_code == HTTPStatus.ACCEPTED
        assert response.json()["status"] == VaultUploadStatus.CAPABILITY_UNSUPPORTED.value
        assert (
            response.json()["message"] == _UPLOAD_MESSAGES[VaultUploadStatus.CAPABILITY_UNSUPPORTED]
        )
        assert len(vault.upload_calls) == 1

    @pytest.mark.parametrize(
        "vault",
        [
            {"available": False},
            {"capabilities": frozenset({CreekCapability.JOURNAL})},
            {"stored": False},
        ],
        indirect=True,
    )
    @pytest.mark.asyncio
    async def test_every_degraded_outcome_carries_a_self_serve_message(
        self, async_client: AsyncClient, vault: ScriptedUploadClient
    ) -> None:
        """A status the user cannot act on is a status that sends them to support."""
        headers = await _signup(async_client, "uploader-message")
        response = await async_client.post(_UPLOAD_PATH, json=_payload(), headers=headers)
        assert response.json()["message"].strip()
        # However it degraded, it was attempted at most once -- never retried.
        assert len(vault.upload_calls) <= 1


class TestUploadIntimateTier:
    """An intimate document reaches the vault, at its own tier, and nothing else."""

    @pytest.mark.asyncio
    async def test_intimate_is_forwarded_to_the_vault(
        self, async_client: AsyncClient, vault: ScriptedUploadClient
    ) -> None:
        """The vault is the user's own corpus, not the cloud the privacy floor guards."""
        headers = await _signup(async_client, "uploader-intimate")
        response = await async_client.post(
            _UPLOAD_PATH, json=_payload(classification="intimate"), headers=headers
        )
        assert response.json()["status"] == VaultUploadStatus.ACCEPTED.value
        assert vault.upload_calls[0].tier is VaultTierCeiling.INTIMATE

    @pytest.mark.parametrize("vault", [{"available": False}], indirect=True)
    @pytest.mark.asyncio
    async def test_intimate_is_not_rerouted_when_the_vault_is_unreachable(
        self, async_client: AsyncClient, vault: ScriptedUploadClient
    ) -> None:
        """An unreachable vault is an honest failure, never a reason to send it elsewhere."""
        headers = await _signup(async_client, "uploader-intimate-down")
        response = await async_client.post(
            _UPLOAD_PATH, json=_payload(classification="intimate"), headers=headers
        )
        assert response.json()["status"] == VaultUploadStatus.VAULT_UNAVAILABLE.value
        assert vault.upload_calls == []


class TestUploadGuards:
    """The endpoint refuses what it cannot safely forward, before doing any work."""

    @pytest.mark.asyncio
    async def test_oversized_document_is_refused_with_413(
        self, async_client: AsyncClient, vault: ScriptedUploadClient
    ) -> None:
        """Guarded on the encoded length, so the decoded bytes are never allocated."""
        headers = await _signup(async_client, "uploader-huge")
        oversized = "A" * (MAX_UPLOAD_BASE64_CHARS + 1)
        response = await async_client.post(
            _UPLOAD_PATH, json=_payload(content_base64=oversized), headers=headers
        )
        assert response.status_code == HTTPStatus.REQUEST_ENTITY_TOO_LARGE
        assert vault.upload_calls == []

    @pytest.mark.asyncio
    async def test_undecodable_base64_is_refused_with_422(
        self, async_client: AsyncClient, vault: ScriptedUploadClient
    ) -> None:
        """Forwarding bytes we could not decode would hand the vault a broken file."""
        headers = await _signup(async_client, "uploader-badb64")
        response = await async_client.post(
            _UPLOAD_PATH, json=_payload(content_base64="not!valid!base64!"), headers=headers
        )
        assert response.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
        assert vault.upload_calls == []

    @pytest.mark.parametrize(
        "filename",
        [
            "../escape.pdf",
            "nested/path.pdf",
            "back\\slash.pdf",
            "..",
            "control\x00.pdf",
            "line\nbreak.pdf",
            ".hidden.pdf",
            " leading-space.pdf",
            "trailing-space.pdf ",
            "zero\u200bwidth.pdf",
            "bidi\u202eexe.pdf",
        ],
    )
    @pytest.mark.asyncio
    async def test_unsafe_filenames_are_rejected(
        self, async_client: AsyncClient, vault: ScriptedUploadClient, filename: str
    ) -> None:
        """The name steers the vault's ingestor choice, so an ambiguous one is refused."""
        headers = await _signup(async_client, "uploader-badname")
        response = await async_client.post(
            _UPLOAD_PATH, json=_payload(filename=filename), headers=headers
        )
        assert response.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
        assert vault.upload_calls == []

    @pytest.mark.parametrize(
        "filename",
        [
            "résumé.pdf",
            "日本語のノート.docx",
            "Заметки.txt",
            "quarterly report (final).xlsx",
            "notes_2026-08-08.md",
        ],
    )
    @pytest.mark.asyncio
    async def test_international_and_ordinary_filenames_are_accepted(
        self, async_client: AsyncClient, vault: ScriptedUploadClient, filename: str
    ) -> None:
        """Safety must not mean ASCII-only: most of the world's documents are not.

        The guard exists to exclude path separators and non-printing codepoints,
        not to exclude the languages people actually name their files in.
        """
        headers = await _signup(async_client, "uploader-intl")
        response = await async_client.post(
            _UPLOAD_PATH, json=_payload(filename=filename), headers=headers
        )
        assert response.status_code == HTTPStatus.ACCEPTED
        assert vault.upload_calls[0].filename == filename

    @pytest.mark.asyncio
    async def test_upload_requires_authentication(self, async_client: AsyncClient) -> None:
        """A document belongs to whoever uploaded it, so there is no anonymous path."""
        response = await async_client.post(_UPLOAD_PATH, json=_payload())
        assert response.status_code in {HTTPStatus.UNAUTHORIZED, HTTPStatus.FORBIDDEN}

    @pytest.mark.asyncio
    async def test_document_bytes_never_appear_in_an_error_body(
        self, async_client: AsyncClient, vault: ScriptedUploadClient
    ) -> None:
        """A rejection must not echo the document back through the error envelope."""
        headers = await _signup(async_client, "uploader-echo")
        response = await async_client.post(
            _UPLOAD_PATH, json=_payload(filename="../escape.pdf"), headers=headers
        )
        assert _CONTENT_B64 not in response.text
        assert vault.upload_calls == []


class TestUploadTiering:
    """The uploader's chosen depth is what the vault is told to store at."""

    @pytest.mark.parametrize(
        ("classification", "expected"),
        [("public", VaultTierCeiling.OPEN), ("personal", VaultTierCeiling.PERSONAL)],
    )
    @pytest.mark.asyncio
    async def test_classification_maps_onto_the_vault_tier(
        self,
        async_client: AsyncClient,
        vault: ScriptedUploadClient,
        classification: str,
        expected: VaultTierCeiling,
    ) -> None:
        """Stored at exactly the tier chosen -- never widened so a call can succeed."""
        headers = await _signup(async_client, f"uploader-tier-{classification}")
        await async_client.post(
            _UPLOAD_PATH, json=_payload(classification=classification), headers=headers
        )
        assert vault.upload_calls[0].tier is expected
        assert vault.upload_calls[0].tier_ceiling is expected

    @pytest.mark.asyncio
    async def test_upload_timestamp_is_timezone_aware_utc(
        self, async_client: AsyncClient, vault: ScriptedUploadClient
    ) -> None:
        """A naive timestamp would be read in the vault's local time, not the user's."""
        headers = await _signup(async_client, "uploader-tz")
        before = datetime.now(UTC)
        await async_client.post(_UPLOAD_PATH, json=_payload(), headers=headers)
        stamped = vault.upload_calls[0].created_at
        assert stamped.tzinfo is not None
        assert stamped >= before


class TestUploadIsRateLimited:
    """The endpoint is bounded, and bounded deliberately rather than by omission."""

    def test_the_endpoint_declares_a_rate_limit(self) -> None:
        """An unbounded 10 MB endpoint that calls an external dependency is an abuse lever."""
        assert UPLOAD_RATE_LIMIT

    def test_the_limit_matches_the_other_base64_payload_endpoint(self) -> None:
        """Same class of endpoint, same bound -- so the two cannot drift apart silently."""
        assert UPLOAD_RATE_LIMIT == TRANSCRIBE_RATE_LIMIT


class TestUploadMessagesAreExhaustive:
    """Every status the service can return has a sentence to show the user.

    The router looks the message up unconditionally, so a status added to
    :class:`VaultUploadStatus` without a matching entry would raise ``KeyError``
    inside the handler and answer a 500 -- on the one path whose whole design is
    that it never 500s. Today the mapping is complete; this makes that a
    guarantee rather than a coincidence.
    """

    def test_every_status_has_a_message(self) -> None:
        """A missing entry is a 500 on a path that must never 500."""
        assert set(_UPLOAD_MESSAGES) == set(VaultUploadStatus)

    @pytest.mark.parametrize("status", list(VaultUploadStatus))
    def test_no_message_sends_the_user_to_support(self, status: VaultUploadStatus) -> None:
        """Each outcome names a next step the user can take themselves."""
        message = _UPLOAD_MESSAGES[status]
        assert message.strip()
        assert "contact support" not in message.lower()

    def test_the_unsupported_message_does_not_pin_the_gap_on_the_vault_alone(self) -> None:
        """This status is reached from either side's version, so the sentence must own both.

        It is answered both when the vault never offered uploads and when the
        vault offers a route Adepthood cannot yet speak. "Update your vault"
        alone is an instruction that cannot work in the second case, and the
        person following it has no way to tell which case they are in.
        """
        message = _UPLOAD_MESSAGES[VaultUploadStatus.CAPABILITY_UNSUPPORTED]
        assert "Adepthood" in message

    def test_the_unsupported_message_promises_no_retry(self) -> None:
        """Nothing about this outcome changes between one attempt and the next.

        The remedy is a version moving on one side or the other, which is not
        something an upload can bring about -- so an invitation to try again is
        a dead end dressed as an action.
        """
        message = _UPLOAD_MESSAGES[VaultUploadStatus.CAPABILITY_UNSUPPORTED].lower()
        assert "try again" not in message


def _as_vault_client(client: CreekVaultClient) -> CreekVaultClient:
    """Return ``client`` unchanged; the annotation is the assertion.

    A structural check rather than a runtime one: if ``ScriptedUploadClient``
    ever drifts from :class:`CreekVaultClient`, mypy fails here rather than the
    endpoint failing at run time on a method the protocol promised.
    """
    return client


def test_scripted_client_satisfies_the_vault_protocol() -> None:
    """The fake must implement the whole seam, upload included."""
    assert _as_vault_client(ScriptedUploadClient()) is not None
