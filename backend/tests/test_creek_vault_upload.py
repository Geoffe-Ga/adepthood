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
import logging
from collections.abc import AsyncGenerator, Callable
from datetime import UTC, datetime
from http import HTTPStatus

import httpx
import pytest
import pytest_asyncio

from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
    CreekCapabilityUnsupportedError,
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
    """An intimate document goes to the vault, at the intimate tier, and nowhere else.

    The vault is the user's own corpus behind one operator-held
    ``CREEK_VAULT_URL``, not a third-party service, so reaching it is not the
    cloud disclosure the privacy floor guards against -- and this path calls no
    LLM at all. Ratified as an amendment to Decision 6 of
    ``docs/adr/0004-creek-vault-http-application-boundary.md``.
    """

    @pytest.mark.asyncio
    async def test_intimate_is_forwarded_to_the_vault(self) -> None:
        """The document reaches the vault like any other classification."""
        client = RecordingUploadClient()
        outcome = await _store(client, classification="intimate")
        assert outcome.status is VaultUploadStatus.ACCEPTED
        assert len(client.upload_calls) == 1

    @pytest.mark.asyncio
    async def test_intimate_is_labelled_at_the_intimate_tier(self) -> None:
        """Never widened so a call can succeed: the vault stores at the chosen depth."""
        client = RecordingUploadClient()
        await _store(client, classification="intimate")
        assert client.upload_calls[0].tier is VaultTierCeiling.INTIMATE
        assert client.upload_calls[0].tier_ceiling is VaultTierCeiling.INTIMATE

    @pytest.mark.asyncio
    async def test_a_vault_refusing_the_intimate_tier_degrades_honestly(self) -> None:
        """A refused ceiling must not be retried at a lower one to force a success."""
        client = RecordingUploadClient(
            upload_error=CreekVaultContractError(
                _SENTINEL_ERROR_TEXT, code=VaultErrorCode.PRIVACY_REFUSED
            )
        )
        outcome = await _store(client, classification="intimate")
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


def _routed_handler(
    upload_payload: object,
    *,
    capabilities: list[str] | None = None,
    upload_status: int = HTTPStatus.OK,
    upload_error: Exception | None = None,
    upload_text: str | None = None,
) -> _VaultHandler:
    """Answer the capability probe with a handshake and everything else as the upload.

    The shared helpers in ``test_creek_vault_http_client`` answer *every*
    request identically, which cannot express "handshake succeeded, then the
    upload did X" -- the two-step shape every adapter test here needs.
    """
    advertised = capabilities or [CreekCapability.JOURNAL.value, CreekCapability.UPLOAD.value]

    def _handle(request: httpx.Request) -> httpx.Response:
        """Route the capability probe to the handshake payload, all else to the upload."""
        if request.url.path.endswith(_CAPABILITIES_SEGMENT):
            return httpx.Response(
                HTTPStatus.OK, json=_vault_capability_payload(capabilities=advertised)
            )
        if upload_error is not None:
            raise upload_error
        if upload_text is not None:
            return httpx.Response(upload_status, text=upload_text)
        return httpx.Response(upload_status, json=upload_payload)

    return _handle


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


class TestHttpClientUploadRefuses:
    """The route exists now; this adapter has not been built onto it, so it still refuses.

    This class used to drive a ``PUT`` against ``/v1/uploads/{external_id}`` — a
    route Creek has never served — and the refusal replaced that guessed wire
    shape. Refusing rather than guessing still holds. The *reason* it used to
    give does not: the published capability vocabulary was a closed enum of four
    names, the same four answered to every caller on every supported contract
    minor, so the claim was that no conformant vault could ever advertise an
    upload at all.

    Contract 0.8.0 falsifies that. ``upload`` is a published fifth name,
    ``POST /v1/uploads`` is its route, and — this being the first bump whose
    capability list is not minor-independent — the advertisement is keyed on the
    caller's declared minor: a client below ``0.8`` is not shown it and is
    refused the route with ``incompatible_version``.

    So the refusal survives on a narrower and truer claim: adepthood recognises
    the wire name but has not implemented the call. Recognising and calling are
    separate changes; only the first is made here, and the tests below pin the
    seam between them so the two cannot silently merge into one.
    """

    @pytest.mark.asyncio
    async def test_upload_refuses_even_when_the_vault_advertises_the_route(
        self, vault_http_clients: _VaultClientFactory
    ) -> None:
        """The refusal is adepthood's own, not a capability gate the vault happened to trip."""
        client = HttpCreekVaultClient(
            _VAULT_URL,
            _VAULT_API_KEY,
            http_client=vault_http_clients(
                _routed_handler(_stored_payload(), capabilities=list(_ADVERTISED_WIRE_NAMES))
            ),
        )
        await client.handshake()

        assert client.supports(CreekCapability.UPLOAD) is True
        with pytest.raises(CreekCapabilityUnsupportedError) as caught:
            await client.upload(_upload_request())

        assert CreekCapability.UPLOAD.value in str(caught.value)

    @pytest.mark.asyncio
    async def test_a_vault_advertising_the_upload_wire_name_is_believed(
        self, vault_http_clients: _VaultClientFactory
    ) -> None:
        """The published name maps onto the capability rather than being dropped as unknown."""
        client = HttpCreekVaultClient(
            _VAULT_URL,
            _VAULT_API_KEY,
            http_client=vault_http_clients(
                _routed_handler(_stored_payload(), capabilities=[_UPLOAD_WIRE_NAME])
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
                _routed_handler(
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
    refusal now arrives from inside the call instead. This class drives the real
    adapter through the real service so the status the router will hand a person
    is asserted where the two meet.
    """

    def _advertising_client(self, clients: _VaultClientFactory) -> HttpCreekVaultClient:
        """Build an adapter pointed at a vault advertising the full 0.8 name list."""
        return HttpCreekVaultClient(
            _VAULT_URL,
            _VAULT_API_KEY,
            http_client=clients(
                _routed_handler(_stored_payload(), capabilities=list(_ADVERTISED_WIRE_NAMES))
            ),
        )

    @pytest.mark.asyncio
    async def test_an_advertising_vault_reports_the_capability_as_unsupported(
        self, vault_http_clients: _VaultClientFactory
    ) -> None:
        """The gap is permanent until adepthood builds the call, so it must not read as transient.

        ``DEGRADED`` means "it broke, try again", and the router says exactly
        that. A retry cannot succeed here for any vault at contract 0.8 or
        above, which is every vault this recognition was added for -- so the
        honest answer is the one that does not promise a retry.
        """
        outcome = await _store(self._advertising_client(vault_http_clients))
        assert outcome.status is VaultUploadStatus.CAPABILITY_UNSUPPORTED

    @pytest.mark.asyncio
    async def test_the_pre_call_gate_is_genuinely_passed_on_the_way_there(
        self, vault_http_clients: _VaultClientFactory
    ) -> None:
        """Guards the test above against passing for the old reason.

        If ``supports`` ever answered ``False`` again the status would still be
        ``CAPABILITY_UNSUPPORTED``, from the pre-call gate -- and this class
        would silently stop covering the branch it exists for.
        """
        client = self._advertising_client(vault_http_clients)
        await _store(client)
        assert client.supports(CreekCapability.UPLOAD) is True


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
