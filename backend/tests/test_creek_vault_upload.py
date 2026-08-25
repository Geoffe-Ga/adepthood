"""Tests for the Creek Vault upload seam (domain, HTTP adapter, and write service).

This is the TDD RED suite for the document-upload path: a user hands adepthood
one file, adepthood forwards the bytes to the vault's ``creek.upload``
capability, and the vault -- not adepthood -- decides which ingestor parses it.

Three layers are pinned here, in the order a request crosses them:

1. :mod:`domain.creek_vault` -- the ``UPLOAD`` capability member, the frozen
   request/result pair, and the promise that document bytes stay out of every
   ``repr()``.
2. :mod:`services.creek_vault_client` -- the HTTP adapter's capability gate,
   its request shape, and the local-fallback no-op.
3. :mod:`services.creek_vault_upload` -- the graceful-degradation orchestration
   the router calls, which never raises a vault error.

The endpoint sitting on top of all three is covered in
``tests/test_journal_upload.py``.
"""

from __future__ import annotations

import base64
import json
import logging
from collections.abc import AsyncGenerator, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from http import HTTPStatus

import httpx
import pytest
import pytest_asyncio

from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
    CreekCapabilityUnsupportedError,
    CreekCeilingUnrepresentableError,
    CreekVaultAuthError,
    CreekVaultClient,
    CreekVaultContractError,
    CreekVaultUnavailableError,
    HandshakeResult,
    VaultClassification,
    VaultErrorCode,
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
from services.creek_vault_client import HttpCreekVaultClient, LocalFallbackCreekVaultClient
from services.creek_vault_upload import (
    UploadDegradeReason,
    UploadedDocument,
    VaultUploadOutcome,
    store_upload,
    upload_external_id,
)
from tests.test_creek_vault_http_client import Handler as _VaultHandler
from tests.test_creek_vault_http_client import _handshake_payload as _vault_capability_payload

_CREATED_AT = datetime(2026, 8, 8, 9, 30, tzinfo=UTC)

_OWNER_ID = 7

_FILENAME = "field-notes.pdf"

_VAULT_URL = "https://vault.example.test"
_VAULT_API_KEY = "creek-vault-upload-path-key"  # pragma: allowlist secret

# The path prefix the adapter probes for capabilities, mirrored here so the
# routed handler below can tell a handshake apart from the upload under test.
_CAPABILITIES_SEGMENT = "/v1/capabilities"

# Creek's own published capability names, written out rather than read back
# through the adapter's translation table: a test that sourced its wire names
# from the mapping under test would agree with that mapping no matter what it
# said. ``upload`` joined the list at contract 0.8.0 and is the one name whose
# advertisement depends on the caller's declared minor.
_UPLOAD_WIRE_NAME = "upload"
_ADVERTISED_WIRE_NAMES = (
    "capabilities",
    "journal-upsert",
    "reflections",
    "wheel",
    _UPLOAD_WIRE_NAME,
)

# Distinctive enough to spot anywhere it must not appear: a repr, a log record,
# or an exception message. The bytes a user uploads are the most private thing
# this seam touches, so "absent by construction" is asserted, not assumed.
_SENTINEL_BYTES = b"SENTINEL_DOCUMENT_BYTES_DO_NOT_LOG"
_CONTENT_B64 = base64.b64encode(_SENTINEL_BYTES).decode("ascii")
_SENTINEL_B64_FRAGMENT = _CONTENT_B64[:16]

_SENTINEL_ERROR_TEXT = "SENTINEL_VAULT_ERROR_TEXT_DO_NOT_LOG"

_FRAGMENT_ID = "vault-fragment-upload-1"

_VaultClientFactory = Callable[[_VaultHandler], httpx.AsyncClient]


def _empty_reflection() -> VaultReflection:
    """Return the reflection an unexercised reflect path answers with."""
    return VaultReflection(
        status=VaultReflectionStatus.EMPTY,
        notes=(),
        essay=None,
        essay_grounded=False,
        routed_tier=VaultTierCeiling.OPEN,
    )


class RecordingUploadClient:
    """Fake :class:`CreekVaultClient` recording upload calls and returning scripted results.

    Only the upload surface is scripted; every other capability answers the
    inert value the upload path never consults, so a test that accidentally
    reached one would fail on its assertion rather than on an attribute error.
    """

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
        self.handshake_calls = 0
        self._capabilities = capabilities
        self._available = available
        self._stored = stored
        self._tags = tags
        self._upload_error = upload_error

    async def handshake(self) -> HandshakeResult:
        """Count the probe and report the configured availability."""
        self.handshake_calls += 1
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
        """Report not-stored -- the upload path never calls journal ingest."""
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
        """Return no tags -- the upload path never calls classify."""
        return VaultClassification(tags=())

    async def reflect(self, _body: str, _tier_ceiling: VaultTierCeiling, /) -> VaultReflection:
        """Return an empty reflection -- the upload path never calls reflect."""
        return _empty_reflection()

    async def wheel(self) -> VaultWheelBalance:
        """Return an empty balance -- the upload path never calls wheel."""
        return VaultWheelBalance(aspects=())


def _upload_request(*, filename: str = _FILENAME) -> VaultUploadRequest:
    """Build a well-formed upload request for the adapter-level tests."""
    return VaultUploadRequest(
        external_id=upload_external_id(_OWNER_ID, filename),
        filename=filename,
        content_base64=_CONTENT_B64,
        tier=VaultTierCeiling.PERSONAL,
        tier_ceiling=VaultTierCeiling.PERSONAL,
        created_at=_CREATED_AT,
    )


async def _store(
    client: CreekVaultClient,
    *,
    classification: str = "personal",
    filename: str = _FILENAME,
) -> VaultUploadOutcome:
    """Run the write service against a scripted client with the common arguments."""
    return await store_upload(
        client,
        UploadedDocument(
            owner_user_id=_OWNER_ID,
            filename=filename,
            content_base64=_CONTENT_B64,
            classification=classification,
            created_at=_CREATED_AT,
        ),
    )


class TestUploadCapability:
    """The vault capability vocabulary gains exactly one new, correctly-spelled member."""

    def test_upload_capability_has_the_wire_name_creek_upload(self) -> None:
        """The member's value is contract: it is what a vault advertises."""
        assert CreekCapability.UPLOAD.value == "creek.upload"

    def test_advertising_journal_does_not_advertise_upload(self) -> None:
        """The two are separately advertised: taking entries implies nothing about files."""
        journal_only = frozenset({CreekCapability.JOURNAL})
        assert CreekCapability.UPLOAD not in journal_only


class TestUploadRequestPrivacy:
    """Document bytes never reach a repr, a str, or anything built from one."""

    def test_repr_omits_the_document_bytes(self) -> None:
        """``repr()`` of a request must not carry the base64 payload."""
        assert _SENTINEL_B64_FRAGMENT not in repr(_upload_request())

    def test_repr_still_identifies_the_upload(self) -> None:
        """Suppressing the payload must not blind an operator to which upload it was."""
        assert _FILENAME in repr(_upload_request())

    def test_request_is_frozen(self) -> None:
        """A built request cannot mutate between construction and the wire."""
        request = _upload_request()
        with pytest.raises(AttributeError):
            request.filename = "other.pdf"  # type: ignore[misc]


class TestExternalId:
    """The external id is a stable, idempotent function of the upload's identity."""

    def test_same_owner_and_filename_yield_the_same_id(self) -> None:
        """A re-send must address the same fragment so the vault edits in place."""
        assert upload_external_id(_OWNER_ID, _FILENAME) == upload_external_id(_OWNER_ID, _FILENAME)

    def test_different_filenames_yield_different_ids(self) -> None:
        """Two documents from one user are two fragments, not one overwritten twice."""
        assert upload_external_id(_OWNER_ID, _FILENAME) != upload_external_id(
            _OWNER_ID, "other.pdf"
        )

    def test_different_owners_yield_different_ids(self) -> None:
        """One user's upload must never address another user's fragment."""
        assert upload_external_id(_OWNER_ID, _FILENAME) != upload_external_id(
            _OWNER_ID + 1, _FILENAME
        )

    def test_id_does_not_embed_the_filename(self) -> None:
        """The id travels in a URL; a filename is the user's words and stays out of it."""
        assert _FILENAME not in upload_external_id(_OWNER_ID, _FILENAME)

    def test_id_is_a_single_inert_url_segment(self) -> None:
        """Nothing in the id can climb out of its path segment or need escaping."""
        generated = upload_external_id(_OWNER_ID, _FILENAME)
        assert generated
        assert all(character.isalnum() or character == "-" for character in generated)


class TestStoreUploadDegradation:
    """The write service answers with a status for every vault condition, never a raise."""

    @pytest.mark.asyncio
    async def test_happy_path_reports_accepted_with_the_vault_ref(self) -> None:
        """A durable upload carries the fragment id back for the response."""
        outcome = await _store(RecordingUploadClient())
        assert outcome.status is VaultUploadStatus.ACCEPTED
        assert outcome.vault_ref == _FRAGMENT_ID

    @pytest.mark.asyncio
    async def test_happy_path_forwards_filename_and_bytes_unparsed(self) -> None:
        """Adepthood hands over the file; the vault picks the ingestor from the name."""
        client = RecordingUploadClient()
        await _store(client)
        assert client.upload_calls[0].filename == _FILENAME
        assert client.upload_calls[0].content_base64 == _CONTENT_B64

    @pytest.mark.asyncio
    async def test_happy_path_labels_the_request_at_the_writers_tier(self) -> None:
        """Both tier and ceiling are the writer's own tier, as journal ingest does."""
        client = RecordingUploadClient()
        await _store(client)
        assert client.upload_calls[0].tier is VaultTierCeiling.PERSONAL
        assert client.upload_calls[0].tier_ceiling is VaultTierCeiling.PERSONAL

    @pytest.mark.asyncio
    async def test_tags_are_empty_until_the_vault_returns_them(self) -> None:
        """Per-fragment tags depend on unshipped upstream work; empty is the truth today."""
        outcome = await _store(RecordingUploadClient())
        assert outcome.tags == ()

    @pytest.mark.asyncio
    async def test_tags_are_carried_through_when_the_vault_supplies_them(self) -> None:
        """When the vault does classify in-pipeline, adepthood keeps what it said."""
        outcome = await _store(RecordingUploadClient(tags=("courage", "threshold")))
        assert outcome.tags == ("courage", "threshold")

    @pytest.mark.asyncio
    async def test_capability_absent_degrades_without_calling_upload(self) -> None:
        """A journal-only vault must degrade, not attempt a call it never advertised."""
        client = RecordingUploadClient(capabilities=frozenset({CreekCapability.JOURNAL}))
        outcome = await _store(client)
        assert outcome.status is VaultUploadStatus.CAPABILITY_UNSUPPORTED
        assert client.upload_calls == []

    @pytest.mark.asyncio
    async def test_unavailable_vault_degrades_to_vault_unavailable(self) -> None:
        """An unreachable vault is a distinct outcome from one that cannot upload."""
        client = RecordingUploadClient(available=False)
        outcome = await _store(client)
        assert outcome.status is VaultUploadStatus.VAULT_UNAVAILABLE
        assert client.upload_calls == []

    @pytest.mark.asyncio
    async def test_transport_failure_degrades_rather_than_raising(self) -> None:
        """A vault error is absorbed: the caller gets a status, never an exception."""
        client = RecordingUploadClient(
            upload_error=CreekVaultUnavailableError(_SENTINEL_ERROR_TEXT)
        )
        outcome = await _store(client)
        assert outcome.status is VaultUploadStatus.DEGRADED
        assert outcome.vault_ref is None

    @pytest.mark.asyncio
    async def test_contract_failure_degrades_rather_than_raising(self) -> None:
        """A refused request is our defect to fix, and still must not reach the user as a 500."""
        client = RecordingUploadClient(upload_error=CreekVaultContractError(_SENTINEL_ERROR_TEXT))
        outcome = await _store(client)
        assert outcome.status is VaultUploadStatus.DEGRADED

    @pytest.mark.asyncio
    async def test_auth_failure_degrades_rather_than_raising(self) -> None:
        """A rejected credential is an operator's problem, not the uploader's crash."""
        client = RecordingUploadClient(upload_error=CreekVaultAuthError(_SENTINEL_ERROR_TEXT))
        outcome = await _store(client)
        assert outcome.status is VaultUploadStatus.DEGRADED

    @pytest.mark.asyncio
    async def test_capability_error_raised_mid_call_reports_capability_unsupported(self) -> None:
        """A capability refused after the handshake advertised it is still a refused capability.

        The race this pins is real -- a vault can withdraw ``creek.upload``
        between the probe and the call -- but it is no longer the only way here,
        and the outcome it used to assert was wrong for both. ``DEGRADED`` tells
        the user to try again, and a retry re-runs the same handshake against the
        same vault: it succeeds only if the vault changed its mind in the
        meantime, which is not something the person holding the document can do.
        The pre-call gate's answer is the honest one on either route.
        """
        client = RecordingUploadClient(
            upload_error=CreekCapabilityUnsupportedError(_SENTINEL_ERROR_TEXT)
        )
        outcome = await _store(client)
        assert outcome.status is VaultUploadStatus.CAPABILITY_UNSUPPORTED
        assert outcome.vault_ref is None

    @pytest.mark.asyncio
    async def test_not_stored_result_degrades_rather_than_inventing_a_ref(self) -> None:
        """A vault that answered without storing must not look like a success."""
        outcome = await _store(RecordingUploadClient(stored=False))
        assert outcome.status is VaultUploadStatus.DEGRADED
        assert outcome.vault_ref is None


class TestStoreUploadIntimateTier:
    """An intimate document does not leave this process, and is not silently lost either.

    These tests used to assert the opposite -- that an intimate document was
    forwarded, at the intimate ceiling, like any other. That was ratified as an
    amendment to Decision 6 of
    ``docs/adr/0004-creek-vault-http-application-boundary.md`` and it was
    untestable in the only way that counts: the client refused every upload
    unconditionally, so no request was ever built and no assertion here could
    reach the wire. Creek's ``UploadRequest.tier`` is typed to the two ceilings a
    remote caller may declare, so the first real request at that tier would have
    been refused at adepthood's own door regardless of what these tests said.

    So the behaviour is now the one the contract permits, decided where the
    journal write decides the same thing -- before the client is touched -- and
    asserted in both directions: withheld at ``intimate``, sent at ``personal``.
    """

    @pytest.mark.asyncio
    async def test_intimate_is_never_handed_to_the_client_at_all(self) -> None:
        """The client is not touched, so there is nothing for a transport to get wrong.

        Asserted on the client rather than on a captured request: "no bytes on the
        wire" is a claim about what was *called*, and a test that inspected an
        outgoing request would already have conceded that one was built.
        """
        client = RecordingUploadClient()

        outcome = await _store(client, classification="intimate")

        assert client.upload_calls == []
        assert outcome.status is VaultUploadStatus.CAPABILITY_UNSUPPORTED
        assert outcome.vault_ref is None

    @pytest.mark.asyncio
    async def test_intimate_is_withheld_before_the_vault_is_even_probed(self) -> None:
        """The refusal is adepthood's own and needs no vault to make it.

        The same shape :mod:`services.creek_vault_write` uses for an intimate
        journal entry: decided locally, before any handshake, so an unreachable
        vault and an intimate document never have to be told apart.
        """
        client = RecordingUploadClient()

        await _store(client, classification="intimate")

        assert client.handshake_calls == 0

    @pytest.mark.asyncio
    async def test_a_lower_tier_from_the_same_document_still_goes(self) -> None:
        """Non-vacuity: the withholding is about the tier, not about this test's setup."""
        client = RecordingUploadClient()

        outcome = await _store(client, classification="personal")

        assert outcome.status is VaultUploadStatus.ACCEPTED
        assert client.upload_calls[0].tier is VaultTierCeiling.PERSONAL

    @pytest.mark.asyncio
    async def test_the_withheld_upload_is_still_countable_by_an_operator(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """A document that silently goes nowhere is the one failure nobody would see.

        The reason is its own value rather than the generic contract label, so a
        deployment can tell "your tier vocabulary is refusing these" apart from
        "your vault is refusing these" without reading any of them.
        """
        with caplog.at_level(logging.WARNING):
            await _store(RecordingUploadClient(), classification="intimate")

        record = next(r for r in caplog.records if r.levelno == logging.WARNING)
        assert getattr(record, "reason", None) == UploadDegradeReason.CEILING_UNREPRESENTABLE.value
        assert getattr(record, "capability", None) == CreekCapability.UPLOAD.value
        assert _SENTINEL_B64_FRAGMENT not in caplog.text

    @pytest.mark.asyncio
    async def test_a_vault_refusing_the_declared_ceiling_degrades_honestly(self) -> None:
        """A refused ceiling must not be retried at a lower one to force a success.

        Driven at ``personal`` now that ``intimate`` never reaches a vault to be
        refused. The rule is unchanged and is the one that matters: Creek
        re-derives a fragment's tier from the bytes themselves, so a document
        whose own content outranks the ceiling its uploader declared is refused
        with ``privacy_refused`` -- and answering that by asking again for less is
        a downgrade the uploader never chose.
        """
        client = RecordingUploadClient(
            upload_error=CreekVaultContractError(
                _SENTINEL_ERROR_TEXT, code=VaultErrorCode.PRIVACY_REFUSED
            )
        )

        outcome = await _store(client, classification="personal")

        assert outcome.status is VaultUploadStatus.DEGRADED
        assert len(client.upload_calls) == 1

    @pytest.mark.asyncio
    async def test_unknown_classification_fails_closed(self) -> None:
        """An unrecognized tier must never widen to OPEN; it raises instead."""
        with pytest.raises(ValueError, match="classification"):
            await _store(RecordingUploadClient(), classification="not-a-tier")


class TestStoreUploadLogging:
    """A degraded upload is countable without any of it being readable."""

    async def _degraded_records(
        self, caplog: pytest.LogCaptureFixture, *, filename: str = _FILENAME
    ) -> None:
        """Run one degrading upload with WARNING capture enabled."""
        client = RecordingUploadClient(
            upload_error=CreekVaultUnavailableError(_SENTINEL_ERROR_TEXT)
        )
        with caplog.at_level(logging.WARNING):
            await _store(client, filename=filename)

    @pytest.mark.asyncio
    async def test_degrade_log_omits_the_document_bytes(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """The payload is the one thing a failure log must never quote."""
        await self._degraded_records(caplog)
        assert _SENTINEL_B64_FRAGMENT not in caplog.text

    @pytest.mark.asyncio
    async def test_degrade_log_omits_the_vaults_own_error_text(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """A vault must not be able to choose what text lands in an operator's log."""
        await self._degraded_records(caplog)
        assert _SENTINEL_ERROR_TEXT not in caplog.text

    @pytest.mark.asyncio
    async def test_degrade_log_omits_the_filename(self, caplog: pytest.LogCaptureFixture) -> None:
        """A filename is the user's own words about their life; it stays out of logs."""
        await self._degraded_records(caplog, filename="my-divorce-settlement.pdf")
        assert "divorce" not in caplog.text

    @pytest.mark.asyncio
    async def test_degrade_log_names_the_capability_and_a_reason(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """What an operator needs -- which capability, which reason -- is still recorded."""
        await self._degraded_records(caplog)
        record = next(r for r in caplog.records if r.levelno == logging.WARNING)
        assert getattr(record, "capability", None) == CreekCapability.UPLOAD.value
        assert getattr(record, "reason", None)

    @pytest.mark.asyncio
    async def test_a_refused_capability_is_still_recorded_for_an_operator(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Answering the user calmly must not make the gap invisible to whoever can close it.

        This is the one failure whose status now reads as an ordinary,
        undramatic state of affairs, so the record is the only place a
        deployment sees how often documents are hitting it.
        """
        client = RecordingUploadClient(
            upload_error=CreekCapabilityUnsupportedError(_SENTINEL_ERROR_TEXT)
        )
        with caplog.at_level(logging.WARNING):
            await _store(client)

        record = next(r for r in caplog.records if r.levelno == logging.WARNING)
        assert getattr(record, "reason", None) == UploadDegradeReason.UNSUPPORTED_CAPABILITY.value
        assert _SENTINEL_ERROR_TEXT not in caplog.text

    @pytest.mark.asyncio
    async def test_a_coded_contract_error_logs_its_code(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """A code adepthood recognizes is the one vault-derived value worth recording.

        Safe precisely because it is not vault-chosen *text*: the adapter drops any
        code outside :class:`~domain.creek_vault.VaultErrorCode` before it gets
        here, so what reaches the log is always one of our own enum values.
        """
        client = RecordingUploadClient(
            upload_error=CreekVaultContractError(
                _SENTINEL_ERROR_TEXT, code=VaultErrorCode.INVALID_REQUEST
            )
        )
        with caplog.at_level(logging.WARNING):
            await _store(client)

        record = next(r for r in caplog.records if r.levelno == logging.WARNING)
        assert getattr(record, "code", None) == VaultErrorCode.INVALID_REQUEST.value
        assert _SENTINEL_ERROR_TEXT not in caplog.text

    @pytest.mark.asyncio
    async def test_an_uncoded_contract_error_logs_no_code_field(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """No code means the vault named none -- inventing one would fabricate a fact."""
        client = RecordingUploadClient(upload_error=CreekVaultContractError(_SENTINEL_ERROR_TEXT))
        with caplog.at_level(logging.WARNING):
            await _store(client)

        record = next(r for r in caplog.records if r.levelno == logging.WARNING)
        assert not hasattr(record, "code")


@dataclass
class _UploadRoutes:
    """Answer the capability probe with a handshake and everything else as the upload.

    The shared helpers in ``test_creek_vault_http_client`` answer *every*
    request identically, which cannot express "handshake succeeded, then the
    upload did X" -- the two-step shape every adapter test here needs.

    A callable object rather than a closure so the uploads it served survive the
    call. What this seam puts on the wire *is* the thing under test: a body
    carrying a field Creek does not publish, or a document sent toward a vault
    that never advertised the route, are failures no assertion about the answer
    could ever catch.

    ``resend_payload`` answers every upload after the first, which is how an
    idempotent re-send is expressed: one vault, two calls, and the second
    reporting that nothing new was written.
    """

    upload_payload: object = None
    capabilities: list[str] | None = None
    upload_status: int = HTTPStatus.OK
    upload_error: Exception | None = None
    upload_text: str | None = None
    resend_payload: object | None = None
    uploads: list[httpx.Request] = field(default_factory=list)

    @property
    def advertised(self) -> list[str]:
        """Return the capability names the handshake answers with."""
        if self.capabilities is not None:
            return self.capabilities
        return [CreekCapability.JOURNAL.value, CreekCapability.UPLOAD.value]

    @property
    def bodies(self) -> list[object]:
        """Return each recorded upload's decoded JSON body, in the order sent."""
        return [json.loads(request.content) for request in self.uploads]

    def _answer(self) -> httpx.Response:
        """Answer one recorded upload from the script this handler was built with."""
        if self.upload_text is not None:
            return httpx.Response(self.upload_status, text=self.upload_text)
        if self.resend_payload is not None and len(self.uploads) > 1:
            return httpx.Response(self.upload_status, json=self.resend_payload)
        return httpx.Response(self.upload_status, json=self.upload_payload)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Route the capability probe to the handshake payload, all else to the upload."""
        if request.url.path.endswith(_CAPABILITIES_SEGMENT):
            return httpx.Response(
                HTTPStatus.OK, json=_vault_capability_payload(capabilities=self.advertised)
            )
        self.uploads.append(request)
        if self.upload_error is not None:
            raise self.upload_error
        return self._answer()


@pytest_asyncio.fixture
async def vault_http_clients() -> AsyncGenerator[_VaultClientFactory, None]:
    """Yield a factory for MockTransport-backed clients, closing each afterwards."""
    created: list[httpx.AsyncClient] = []

    def _build(handler: _VaultHandler) -> httpx.AsyncClient:
        """Build one in-memory client and register it for teardown."""
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        created.append(client)
        return client

    yield _build
    for client in created:
        await client.aclose()


def _stored_payload(
    action: str = VaultIngestAction.CREATED.value, **extra: object
) -> dict[str, object]:
    """Build the 2xx body a vault answers a durable upload with."""
    return {"action": action, "fragment_id": _FRAGMENT_ID, **extra}


# Creek's published upload route, written out rather than read back from the
# adapter: a test that sourced the URL from the code under test would agree with
# whatever that code invented, which is exactly how the earlier
# ``PUT /v1/uploads/{external_id}`` -- a route Creek has never served -- survived
# as long as it did.
_UPLOADS_SEGMENT = "/v1/uploads"
_UPLOAD_URL = f"{_VAULT_URL}{_UPLOADS_SEGMENT}"

# The published ``UploadRequest`` field set, exactly. Upstream declares
# ``additionalProperties: false``, so a sixth field is a rejected request rather
# than a harmless extra, and an absent ``tier`` is not defaultable -- both halves
# are asserted because each fails in its own direction.
_UPLOAD_REQUEST_FIELDS = frozenset(
    {"filename", "content_base64", "external_id", "timestamp", "tier"}
)

# The two headers a write declares itself with. Spelled out here for the reason
# the route is: these are Creek's contract, not adepthood's choice.
_CEILING_HEADER = "X-Creek-Tier-Ceiling"
_CONTRACT_VERSION_HEADER = "X-Creek-Contract-Version"

# The minor a 0.8.0-pinned caller declares. Creek keys the upload capability on
# it from 0.8.0 onward, so sending the wrong one is refused at the route.
_CONTRACT_MINOR = "0.8"


def _decoded_body(request: httpx.Request) -> dict[str, object]:
    """Return one recorded request's JSON body as an object."""
    body = json.loads(request.content)
    assert isinstance(body, dict)
    return body


async def _handshaken(clients: _VaultClientFactory, handler: _UploadRoutes) -> HttpCreekVaultClient:
    """Return an adapter that has completed a handshake against ``handler``."""
    client = HttpCreekVaultClient(_VAULT_URL, _VAULT_API_KEY, http_client=clients(handler))
    assert (await client.handshake()).available is True
    return client


def _intimate_request() -> VaultUploadRequest:
    """Build the one request whose ceiling has no spelling on Creek's wire."""
    return VaultUploadRequest(
        external_id=upload_external_id(_OWNER_ID, _FILENAME),
        filename=_FILENAME,
        content_base64=_CONTENT_B64,
        tier=VaultTierCeiling.INTIMATE,
        tier_ceiling=VaultTierCeiling.INTIMATE,
        created_at=_CREATED_AT,
    )


class TestHttpClientUpload:
    """The adapter speaks Creek's published upload route, and speaks only that.

    The unconditional refusal this class replaces was right while it stood.
    Through contract 0.7 the ratified ``/v1`` vocabulary was a closed set of four
    capability names answered identically to every caller, so no conformant vault
    could advertise or serve an upload and an adapter that sent one would have
    been improvising a wire format. Contract 0.8.0 publishes ``upload`` as a
    fifth name, ``POST /v1/uploads`` as its route, and ``UploadRequest`` /
    ``UploadResponse`` as its shapes -- all three vendored under
    ``tests/fixtures/creek_v1/``. Every assertion below is read off that bundle
    rather than off this adapter, which is the same discipline that deleted the
    invented ``PUT``.
    """

    @pytest.mark.asyncio
    async def test_a_document_is_posted_to_the_published_collection_url(
        self, vault_http_clients: _VaultClientFactory
    ) -> None:
        """One ``POST`` of the collection, with no identifier smuggled into the path.

        The idempotency key is a *field* of the published request, not a path
        segment, so there is no per-document URL to address and nothing for a
        filename or an id to redirect by its shape.
        """
        handler = _UploadRoutes(_stored_payload())
        client = await _handshaken(vault_http_clients, handler)

        await client.upload(_upload_request())

        assert len(handler.uploads) == 1
        sent = handler.uploads[0]
        assert sent.method == "POST"
        assert str(sent.url) == _UPLOAD_URL
        assert sent.url.query == b""

    @pytest.mark.asyncio
    async def test_the_body_is_exactly_the_published_upload_request(
        self, vault_http_clients: _VaultClientFactory
    ) -> None:
        """Five published fields, JSON and base64, and nothing adepthood invented.

        The field set is asserted as a whole rather than field by field: an
        omission and an addition are both contract faults, and ``UploadRequest``
        forbids unknown properties outright, so a sixth field would be a refused
        request rather than something the vault quietly ignores.
        """
        handler = _UploadRoutes(_stored_payload())
        client = await _handshaken(vault_http_clients, handler)
        request = _upload_request()

        await client.upload(request)

        body = _decoded_body(handler.uploads[0])
        assert frozenset(body) == _UPLOAD_REQUEST_FIELDS
        assert body["filename"] == _FILENAME
        assert body["content_base64"] == _CONTENT_B64
        assert body["external_id"] == request.external_id
        assert body["timestamp"] == _CREATED_AT.isoformat()
        assert body["tier"] == VaultTierCeiling.PERSONAL.value

    @pytest.mark.asyncio
    async def test_the_ceiling_and_the_declared_minor_travel_in_their_headers(
        self, vault_http_clients: _VaultClientFactory
    ) -> None:
        """The write declares what it is admitted at and which minor it speaks.

        The declared minor is load-bearing from 0.8.0 in a way it was not before:
        Creek keys the upload capability on the caller's own declared minor and
        refuses a caller below the threshold outright, so a request that omitted
        it would be refused by a vault that serves the route perfectly well.
        """
        handler = _UploadRoutes(_stored_payload())
        client = await _handshaken(vault_http_clients, handler)

        await client.upload(_upload_request())

        headers = handler.uploads[0].headers
        assert headers["Authorization"] == f"Bearer {_VAULT_API_KEY}"
        assert headers[_CEILING_HEADER] == VaultTierCeiling.PERSONAL.value
        assert headers[_CONTRACT_VERSION_HEADER] == _CONTRACT_MINOR

    @pytest.mark.asyncio
    async def test_a_durable_upload_reads_back_the_vaults_own_fragment(
        self, vault_http_clients: _VaultClientFactory
    ) -> None:
        """The result carries the vault's fragment id and the action it reported."""
        handler = _UploadRoutes(_stored_payload())
        client = await _handshaken(vault_http_clients, handler)

        result = await client.upload(_upload_request())

        assert result == VaultUploadResult(
            stored=True, vault_ref=_FRAGMENT_ID, action=VaultIngestAction.CREATED, tags=()
        )

    @pytest.mark.asyncio
    async def test_a_resend_addresses_one_fragment_and_creates_nothing_new(
        self, vault_http_clients: _VaultClientFactory
    ) -> None:
        """Idempotence survives the wire: the same id twice, and the vault says so.

        Both halves matter. The id is what makes the second call an edit rather
        than a duplicate, and ``unchanged`` is the vault reporting that it was --
        a result adepthood must keep rather than flatten into "stored", since a
        continuous re-send is the steady state this path is built for.
        """
        handler = _UploadRoutes(
            _stored_payload(), resend_payload=_stored_payload(VaultIngestAction.UNCHANGED.value)
        )
        client = await _handshaken(vault_http_clients, handler)

        first = await client.upload(_upload_request())
        second = await client.upload(_upload_request())

        sent_ids = [_decoded_body(upload)["external_id"] for upload in handler.uploads]
        assert len(sent_ids) == 2
        assert sent_ids[0] == sent_ids[1]
        assert first.action is VaultIngestAction.CREATED
        assert second.action is VaultIngestAction.UNCHANGED
        assert second.vault_ref == first.vault_ref

    @pytest.mark.asyncio
    async def test_upload_requires_the_advertised_capability_without_egress(
        self, vault_http_clients: _VaultClientFactory
    ) -> None:
        """A vault that never advertised uploads gets no document, only a refusal.

        The no-egress half is the load-bearing one, and it is why this test
        survives the refusal being retired: refusing after sending would already
        have put a user's whole document on a wire toward a surface nobody
        claimed to serve.
        """
        handler = _UploadRoutes(
            _stored_payload(),
            capabilities=[name for name in _ADVERTISED_WIRE_NAMES if name != _UPLOAD_WIRE_NAME],
        )
        client = await _handshaken(vault_http_clients, handler)

        with pytest.raises(CreekCapabilityUnsupportedError) as caught:
            await client.upload(_upload_request())

        assert CreekCapability.UPLOAD.value in str(caught.value)
        assert handler.uploads == []
        assert _SENTINEL_B64_FRAGMENT not in str(caught.value)

    @pytest.mark.asyncio
    async def test_an_intimate_document_never_reaches_the_wire(
        self, vault_http_clients: _VaultClientFactory
    ) -> None:
        """The wire cannot express ``intimate``, so the request is refused before it exists.

        Not a fourth guard of this seam's own: ``wire_ceiling_for`` is the single
        door between adepthood's three tiers and the two Creek publishes, and it
        raises rather than narrowing. Narrowing would be the worst available
        outcome -- an intimate document filed under a depth its owner never
        chose, in a request every downstream check would find well-formed.
        """
        handler = _UploadRoutes(_stored_payload())
        client = await _handshaken(vault_http_clients, handler)

        with pytest.raises(CreekCeilingUnrepresentableError):
            await client.upload(_intimate_request())

        assert handler.uploads == []

    @pytest.mark.asyncio
    async def test_a_version_refusal_is_a_contract_error_carrying_its_code(
        self, vault_http_clients: _VaultClientFactory
    ) -> None:
        """Creek refuses a below-threshold caller at the route, and the code survives.

        This is a real runtime state rather than a theoretical one: the
        capability list is keyed on the caller's minor from 0.8.0, so a vault can
        serve the route and still refuse *this* caller. The code is what tells an
        operator that no retry reaches it.
        """
        handler = _UploadRoutes(
            {"code": VaultErrorCode.INCOMPATIBLE_VERSION.value, "message": _SENTINEL_ERROR_TEXT},
            upload_status=HTTPStatus.CONFLICT,
        )
        client = await _handshaken(vault_http_clients, handler)

        with pytest.raises(CreekVaultContractError) as caught:
            await client.upload(_upload_request())

        assert caught.value.code is VaultErrorCode.INCOMPATIBLE_VERSION
        assert _SENTINEL_ERROR_TEXT not in str(caught.value)

    @pytest.mark.asyncio
    async def test_a_privacy_refusal_reads_as_a_refusal_not_a_rejected_credential(
        self, vault_http_clients: _VaultClientFactory
    ) -> None:
        """Creek publishes ``privacy_refused`` at 403, which is also an auth status.

        Deciding on the status class first would send an operator to rotate a key
        that was never refused. The code is authoritative, exactly as it is on
        the journal write.
        """
        handler = _UploadRoutes(
            {"code": VaultErrorCode.PRIVACY_REFUSED.value, "message": _SENTINEL_ERROR_TEXT},
            upload_status=HTTPStatus.FORBIDDEN,
        )
        client = await _handshaken(vault_http_clients, handler)

        with pytest.raises(CreekVaultContractError) as caught:
            await client.upload(_upload_request())

        assert caught.value.code is VaultErrorCode.PRIVACY_REFUSED

    @pytest.mark.asyncio
    async def test_a_transport_failure_normalises_without_echoing_the_document(
        self, vault_http_clients: _VaultClientFactory
    ) -> None:
        """A dropped call becomes one static, capability-named message and nothing else.

        The original exception's text can carry the URL or the request body, so
        neither its message nor its traceback context may ride along.
        """
        handler = _UploadRoutes(
            _stored_payload(), upload_error=httpx.ConnectError(_SENTINEL_ERROR_TEXT)
        )
        client = await _handshaken(vault_http_clients, handler)

        with pytest.raises(CreekVaultUnavailableError) as caught:
            await client.upload(_upload_request())

        assert CreekCapability.UPLOAD.value in str(caught.value)
        assert _SENTINEL_ERROR_TEXT not in str(caught.value)
        assert _SENTINEL_B64_FRAGMENT not in repr(caught.value)

    @pytest.mark.asyncio
    async def test_a_2xx_the_parser_cannot_read_is_not_a_durable_write(
        self, vault_http_clients: _VaultClientFactory
    ) -> None:
        """A 200 that does not say a fragment was stored must not look like one.

        A proxy error page served as 200 is the usual cause, and reporting it as
        a success would tell someone their document is in their vault when it is
        nowhere at all -- and this path has no local copy to fall back on.
        """
        handler = _UploadRoutes(None, upload_text="<html>gateway timeout</html>")
        client = await _handshaken(vault_http_clients, handler)

        with pytest.raises(CreekVaultUnavailableError):
            await client.upload(_upload_request())

    @pytest.mark.asyncio
    async def test_a_2xx_missing_the_fragment_id_reports_not_stored(
        self, vault_http_clients: _VaultClientFactory
    ) -> None:
        """A readable body that names no fragment is a write we cannot verify."""
        handler = _UploadRoutes({"action": VaultIngestAction.CREATED.value})
        client = await _handshaken(vault_http_clients, handler)

        result = await client.upload(_upload_request())

        assert result == VaultUploadResult(stored=False, vault_ref=None, action=None, tags=())

    @pytest.mark.asyncio
    async def test_a_vault_advertising_the_upload_wire_name_is_believed(
        self, vault_http_clients: _VaultClientFactory
    ) -> None:
        """The published name maps onto the capability rather than being dropped as unknown."""
        client = HttpCreekVaultClient(
            _VAULT_URL,
            _VAULT_API_KEY,
            http_client=vault_http_clients(
                _UploadRoutes(_stored_payload(), capabilities=[_UPLOAD_WIRE_NAME])
            ),
        )
        await client.handshake()

        assert client.supports(CreekCapability.UPLOAD) is True

    @pytest.mark.asyncio
    async def test_a_vault_below_the_upload_threshold_is_not_credited_with_it(
        self, vault_http_clients: _VaultClientFactory
    ) -> None:
        """The other direction: silence about ``upload`` must never read as support.

        This is the shape a vault serving a pre-0.8 caller answers with, and the
        one adepthood saw from every vault before the pin moved.
        """
        client = HttpCreekVaultClient(
            _VAULT_URL,
            _VAULT_API_KEY,
            http_client=vault_http_clients(
                _UploadRoutes(
                    _stored_payload(),
                    capabilities=[
                        name for name in _ADVERTISED_WIRE_NAMES if name != _UPLOAD_WIRE_NAME
                    ],
                )
            ),
        )
        await client.handshake()

        assert client.supports(CreekCapability.UPLOAD) is False


class TestStoreUploadAgainstAnAdvertisingVault:
    """The whole path, end to end, for the population a 0.8 vault actually puts on it.

    Every other test of this seam pins one layer: the adapter's ``supports``
    answer, or the service's reaction to a *scripted* client. Neither notices
    that recognising ``upload`` moved a real deployment from one branch of
    :func:`store_upload` to another -- the pre-call gate no longer fires, so the
    call itself is what decides. This class drives the real adapter through the
    real service so the status the router will hand a person is asserted where
    the two meet.

    It replaces a pair that pinned the opposite outcome. While the adapter
    refused unconditionally, an advertising vault still ended at
    ``CAPABILITY_UNSUPPORTED`` -- correctly, because no retry could reach a call
    adepthood had not built. That is the sentence this issue retires.
    """

    def _routes(
        self,
        *,
        upload_payload: object | None = None,
        upload_status: int = HTTPStatus.OK,
        upload_error: Exception | None = None,
    ) -> _UploadRoutes:
        """Build routes for a vault advertising the full 0.8 name list."""
        return _UploadRoutes(
            _stored_payload() if upload_payload is None else upload_payload,
            capabilities=list(_ADVERTISED_WIRE_NAMES),
            upload_status=upload_status,
            upload_error=upload_error,
        )

    def _client(self, clients: _VaultClientFactory, routes: _UploadRoutes) -> HttpCreekVaultClient:
        """Point a real adapter at ``routes``."""
        return HttpCreekVaultClient(_VAULT_URL, _VAULT_API_KEY, http_client=clients(routes))

    @pytest.mark.asyncio
    async def test_an_advertising_vault_accepts_the_document(
        self, vault_http_clients: _VaultClientFactory
    ) -> None:
        """The whole path lands: one document over the wire, one fragment back."""
        routes = self._routes()
        outcome = await _store(self._client(vault_http_clients, routes))

        assert outcome.status is VaultUploadStatus.ACCEPTED
        assert outcome.vault_ref == _FRAGMENT_ID
        assert len(routes.uploads) == 1

    @pytest.mark.asyncio
    async def test_the_pre_call_gate_is_genuinely_passed_on_the_way_there(
        self, vault_http_clients: _VaultClientFactory
    ) -> None:
        """Guards the test above against passing for the wrong reason.

        If ``supports`` ever answered ``False`` again the service would return
        before any request was built, and this class would silently stop
        covering the branch it exists for.
        """
        routes = self._routes()
        client = self._client(vault_http_clients, routes)
        await _store(client)

        assert client.supports(CreekCapability.UPLOAD) is True
        assert routes.uploads != []

    @pytest.mark.asyncio
    async def test_a_transport_failure_mid_call_now_genuinely_degrades(
        self, vault_http_clients: _VaultClientFactory
    ) -> None:
        """A working upload that broke is the one failure a retry *can* clear.

        This branch was unreachable while the adapter refused before sending:
        every failure a real deployment saw arrived as a refused capability. Now
        that the call is made, "the vault dropped it" and "the vault will not take
        files" are two different sentences again, and only the first ends at
        ``DEGRADED``.
        """
        routes = self._routes(upload_error=httpx.ConnectError(_SENTINEL_ERROR_TEXT))
        outcome = await _store(self._client(vault_http_clients, routes))

        assert outcome.status is VaultUploadStatus.DEGRADED
        assert routes.uploads != []

    @pytest.mark.asyncio
    async def test_a_version_refusal_at_the_route_does_not_promise_a_retry(
        self, vault_http_clients: _VaultClientFactory
    ) -> None:
        """A caller below the upload threshold is a dead end, not a transient fault.

        The capability list is keyed on the caller's declared minor from 0.8.0,
        so a vault can advertise, be reached, and still refuse this caller at the
        route. ``DEGRADED`` would tell them to retry something no retry reaches.
        """
        routes = self._routes(
            upload_payload={
                "code": VaultErrorCode.INCOMPATIBLE_VERSION.value,
                "message": _SENTINEL_ERROR_TEXT,
            },
            upload_status=HTTPStatus.CONFLICT,
        )
        outcome = await _store(self._client(vault_http_clients, routes))

        assert outcome.status is VaultUploadStatus.CAPABILITY_UNSUPPORTED
        assert outcome.vault_ref is None

    @pytest.mark.asyncio
    async def test_an_intimate_document_is_withheld_before_the_vault_is_probed(
        self, vault_http_clients: _VaultClientFactory
    ) -> None:
        """The one classification that cannot cross this wire never starts the journey.

        Not a fourth guard of the service's own: the decision is
        :func:`~domain.creek_vault.wire_ceiling_for`'s, asked before anything
        else happens, exactly as the journal write asks its own question before
        the client is touched. The status is the one that promises no retry,
        because none is possible -- Creek's ``UploadRequest.tier`` is typed to
        the two ceilings a remote caller may name, and ``intimate`` is not one of
        them at any version either side could reach today.
        """
        routes = self._routes()
        client = self._client(vault_http_clients, routes)

        outcome = await _store(client, classification="intimate")

        assert outcome.status is VaultUploadStatus.CAPABILITY_UNSUPPORTED
        assert outcome.vault_ref is None
        assert routes.uploads == []


class TestLocalFallbackUpload:
    """With no vault configured, an upload is a silent no-op rather than an error."""

    @pytest.mark.asyncio
    async def test_upload_reports_not_stored_without_raising(self) -> None:
        """Postgres stays the system of record; there is simply nowhere to put the file."""
        result = await LocalFallbackCreekVaultClient().upload(_upload_request())
        assert result == VaultUploadResult(stored=False, vault_ref=None, action=None, tags=())

    @pytest.mark.asyncio
    async def test_fallback_never_advertises_the_upload_capability(self) -> None:
        """The write service's gate must see "unsupported" and degrade before calling."""
        assert LocalFallbackCreekVaultClient().supports(CreekCapability.UPLOAD) is False
