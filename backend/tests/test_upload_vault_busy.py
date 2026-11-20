"""A busy vault is a wait, not a failed document (#3770).

Creek refuses ``POST /v1/uploads`` with ``503 temporarily_unavailable`` while a
classify or link pass holds its content-mutation lock, and a ``429`` is a shed
by something in front of it. Neither says anything about the document, and
neither kept it. Until #3770 both were collapsed into ``degraded`` -- "we could
not confirm" -- which the Seed run charged against its upload pace and never
retried, so about one file in twenty landed.

Pinned here, layer by layer:

- the adapter carries Creek's ``Retry-After`` out on the error it raises;
- the service answers a retryable refusal as ``vault_busy`` with a wait, and a
  real outage exactly as before;
- the route answers ``202 {vault_status: "vault_busy", retry_after_seconds}``
  and drives no pipeline for a document that did not land;
- a Seed run's documents share one capability handshake (cached per run);
"""

from __future__ import annotations

import base64
from collections.abc import AsyncGenerator, Callable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from http import HTTPStatus

import httpx
import pytest
import pytest_asyncio
from httpx import AsyncClient, MockTransport

from dependencies.creek_vault import get_creek_vault_client
from domain.creek_vault import (
    CreekCapability,
    CreekVaultRateLimitedError,
    CreekVaultUnavailableError,
    HandshakeResult,
    VaultErrorCode,
    VaultSendSuspendedError,
    VaultTierCeiling,
    VaultUploadRequest,
    VaultUploadStatus,
)
from main import app
from schemas.journal_upload import UPLOAD_MESSAGES
from services.creek_vault_client import HttpCreekVaultClient
from services.creek_vault_upload import (
    DEFAULT_VAULT_BUSY_RETRY_AFTER_SECONDS,
    UploadedDocument,
    store_upload,
    upload_external_id,
)
from services.upload_handshake_memo import (
    UPLOAD_HANDSHAKE_MEMO,
    UPLOAD_HANDSHAKE_REUSE_SECONDS,
    UploadHandshakeMemo,
)
from tests.test_creek_vault_http_client import _handshake_payload
from tests.test_document_upload_to_a_vault import ScriptedUploadClient

_SIGNUP_PASSWORD = "secret12345"  # pragma: allowlist secret
_IMPORT_PATH = "/corpus/import"
_VAULT_URL = "https://vault.example.test"
_VAULT_API_KEY = "creek-vault-busy-key"  # pragma: allowlist secret
_CAPABILITIES_SEGMENT = "/v1/capabilities"
_FILENAME = "field-notes.md"
_CONTENT_B64 = base64.b64encode(b"# a note written while the vault was sorting").decode("ascii")
_FRAGMENT_ID = "vault-fragment-busy-1"
_CREATED_AT = datetime(2026, 11, 20, 9, 0, tzinfo=UTC)
_OWNER_ID = 11
_RUN_ID = "seedrun0123456789abcdef0123456789"
_OTHER_RUN_ID = "seedrunfedcba9876543210fedcba9876"

# The wait Creek names on the refusal in the issue's own example.
_CREEK_RETRY_AFTER = 7
# A 429 from an intermediary, naming a different wait so the two cannot be confused.
_SHED_RETRY_AFTER = 12


def _busy_body(code: str = "temporarily_unavailable") -> dict[str, str]:
    """Creek's error envelope for a refusal naming ``code``."""
    return {"code": code, "message": code, "request_id": "req-busy"}


def _stored_body() -> dict[str, object]:
    """The 2xx body a vault answers a durable upload with."""
    return {"action": "created", "fragment_id": _FRAGMENT_ID, "status": "ok"}


@dataclass
class _BusyVault:
    """A vault that refuses the first ``busy_for`` uploads, then stores the rest.

    The capability probe is always answered: Creek's handshake does not take the
    content-mutation lock, which is why a busy vault is still a reachable one.
    Every request is recorded so a test can count the probes as well as the
    uploads.
    """

    busy_for: int = 1
    status: int = HTTPStatus.SERVICE_UNAVAILABLE
    body: object = field(default_factory=_busy_body)
    retry_after: str | None = str(_CREEK_RETRY_AFTER)
    stored_body: object = field(default_factory=_stored_body)
    probes: int = 0
    uploads: int = 0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Answer the probe honestly, refuse while busy, then store."""
        if request.url.path.endswith(_CAPABILITIES_SEGMENT):
            self.probes += 1
            return httpx.Response(
                HTTPStatus.OK, json=_handshake_payload(capabilities=["journal", "upload"])
            )
        self.uploads += 1
        if self.uploads <= self.busy_for:
            headers = {} if self.retry_after is None else {"Retry-After": self.retry_after}
            return httpx.Response(self.status, json=self.body, headers=headers)
        return httpx.Response(HTTPStatus.OK, json=self.stored_body)


_VaultFactory = Callable[[_BusyVault], HttpCreekVaultClient]


@pytest.fixture(autouse=True)
def _fresh_handshake_memo() -> Iterator[None]:
    """Start and end every test with no run's probe remembered.

    The memo is process-wide by design, so without this a probe one test made
    under a run id would be adopted by the next test's adapter.
    """
    UPLOAD_HANDSHAKE_MEMO.clear()
    yield
    UPLOAD_HANDSHAKE_MEMO.clear()


@pytest_asyncio.fixture
async def vault_clients() -> AsyncGenerator[_VaultFactory, None]:
    """Build real adapters over in-memory vaults, closing each afterwards."""
    created: list[httpx.AsyncClient] = []

    def _build(vault: _BusyVault) -> HttpCreekVaultClient:
        """Point a real adapter at ``vault``."""
        http = httpx.AsyncClient(transport=MockTransport(vault))
        created.append(http)
        return HttpCreekVaultClient(
            _VAULT_URL, _VAULT_API_KEY, http_client=http, pin_destination=False
        )

    yield _build
    for http in created:
        await http.aclose()


def _document(run_id: str | None = None, *, owner: int = _OWNER_ID) -> UploadedDocument:
    """One personal-tier document, optionally sent as part of a Seed run."""
    return UploadedDocument(
        owner_user_id=owner,
        filename=_FILENAME,
        content_base64=_CONTENT_B64,
        classification="personal",
        created_at=_CREATED_AT,
        run_id=run_id,
    )


async def _signup(client: AsyncClient, username: str) -> dict[str, str]:
    """Sign up a fresh user and return an Authorization header for it."""
    response = await client.post(
        "/auth/signup",
        json={"email": f"{username}@example.com", "password": _SIGNUP_PASSWORD},
    )
    assert response.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {response.json()['token']}"}


async def _import_against(
    async_client: AsyncClient, vault: _BusyVault, username: str, **extra: str
) -> httpx.Response:
    """POST one document through the real route to a real adapter over ``vault``."""
    headers = await _signup(async_client, username)
    payload = {
        "filename": _FILENAME,
        "content_base64": _CONTENT_B64,
        "classification": "personal",
        **extra,
    }
    async with AsyncClient(transport=MockTransport(vault)) as http:
        client = HttpCreekVaultClient(
            _VAULT_URL, _VAULT_API_KEY, http_client=http, pin_destination=False
        )
        app.dependency_overrides[get_creek_vault_client] = lambda: client
        try:
            return await async_client.post(_IMPORT_PATH, json=payload, headers=headers)
        finally:
            app.dependency_overrides.pop(get_creek_vault_client, None)


class TestTheRouteAnswersABusyVaultAsAWait:
    """``POST /corpus/import`` turns a retryable refusal into ``vault_busy``."""

    @pytest.mark.asyncio
    async def test_temporarily_unavailable_with_retry_after_is_vault_busy(
        self, async_client: AsyncClient
    ) -> None:
        """The issue's own example: 503 + ``Retry-After: 7`` answers busy, 7 s."""
        response = await _import_against(async_client, _BusyVault(), "busy-503")
        body = response.json()
        assert response.status_code == HTTPStatus.ACCEPTED
        assert body["destination"] == "vault"
        assert body["vault_status"] == VaultUploadStatus.VAULT_BUSY.value
        assert body["retry_after_seconds"] == _CREEK_RETRY_AFTER
        assert body["stored"] is False
        assert body["vault_ref"] is None
        assert body["message"] == UPLOAD_MESSAGES[VaultUploadStatus.VAULT_BUSY]

    @pytest.mark.asyncio
    async def test_a_refusal_without_retry_after_waits_the_default(
        self, async_client: AsyncClient
    ) -> None:
        """Creek before #2121 names no wait, so the answer names thirty seconds."""
        vault = _BusyVault(retry_after=None)
        body = (await _import_against(async_client, vault, "busy-no-header")).json()
        assert body["vault_status"] == VaultUploadStatus.VAULT_BUSY.value
        assert body["retry_after_seconds"] == DEFAULT_VAULT_BUSY_RETRY_AFTER_SECONDS
        assert DEFAULT_VAULT_BUSY_RETRY_AFTER_SECONDS == 30

    @pytest.mark.asyncio
    async def test_a_429_is_vault_busy_with_its_own_wait(self, async_client: AsyncClient) -> None:
        """A shed in front of the vault is a wait too, and keeps its own Retry-After."""
        vault = _BusyVault(
            status=HTTPStatus.TOO_MANY_REQUESTS, body={}, retry_after=str(_SHED_RETRY_AFTER)
        )
        body = (await _import_against(async_client, vault, "busy-429")).json()
        assert body["vault_status"] == VaultUploadStatus.VAULT_BUSY.value
        assert body["retry_after_seconds"] == _SHED_RETRY_AFTER

    @pytest.mark.parametrize(
        "unreadable", ["soon", "Wed, 21 Oct 2026 07:28:00 GMT", "-3", "", "1e3"]
    )
    @pytest.mark.asyncio
    async def test_an_unreadable_retry_after_waits_the_default(
        self, async_client: AsyncClient, unreadable: str
    ) -> None:
        """Only whole delta-seconds are read; anything else is no wait named."""
        vault = _BusyVault(retry_after=unreadable)
        body = (await _import_against(async_client, vault, "busy-unreadable")).json()
        assert body["vault_status"] == VaultUploadStatus.VAULT_BUSY.value
        assert body["retry_after_seconds"] == DEFAULT_VAULT_BUSY_RETRY_AFTER_SECONDS

    @pytest.mark.parametrize(
        ("status", "body"),
        [
            pytest.param(HTTPStatus.SERVICE_UNAVAILABLE, {}, id="uncoded-503"),
            pytest.param(HTTPStatus.SERVICE_UNAVAILABLE, _busy_body("unavailable"), id="down"),
            pytest.param(HTTPStatus.INTERNAL_SERVER_ERROR, {}, id="500"),
            pytest.param(HTTPStatus.BAD_GATEWAY, {}, id="502"),
        ],
    )
    @pytest.mark.asyncio
    async def test_a_real_outage_still_settles_as_degraded(
        self, async_client: AsyncClient, status: int, body: object
    ) -> None:
        """Only a retryable refusal waits; every other 5xx answers as it did before."""
        vault = _BusyVault(status=status, body=body)
        answer = (await _import_against(async_client, vault, "busy-outage")).json()
        assert answer["vault_status"] == VaultUploadStatus.DEGRADED.value
        assert answer["retry_after_seconds"] is None

    @pytest.mark.asyncio
    async def test_an_accepted_upload_names_no_wait(self, async_client: AsyncClient) -> None:
        """``retry_after_seconds`` belongs to the busy answer alone."""
        answer = (await _import_against(async_client, _BusyVault(busy_for=0), "busy-ok")).json()
        assert answer["vault_status"] == VaultUploadStatus.ACCEPTED.value
        assert answer["retry_after_seconds"] is None

    def test_the_busy_message_promises_nothing_was_kept_and_offers_the_wait(self) -> None:
        """Nothing reached the vault, so saying so is true; no support desk, no blame."""
        message = UPLOAD_MESSAGES[VaultUploadStatus.VAULT_BUSY]
        assert "busy" in message.lower()
        assert "contact support" not in message.lower()


class TestTheServiceSeparatesAWaitFromAnOutage:
    """:func:`store_upload` answers busy only for the two retryable refusals."""

    @pytest.mark.asyncio
    async def test_the_outcome_carries_creeks_wait(self, vault_clients: _VaultFactory) -> None:
        """The wait travels from the header to the outcome, unchanged."""
        outcome = await store_upload(vault_clients(_BusyVault()), _document())
        assert outcome.status is VaultUploadStatus.VAULT_BUSY
        assert outcome.retry_after_seconds == _CREEK_RETRY_AFTER
        assert outcome.vault_ref is None

    @pytest.mark.asyncio
    async def test_a_send_the_operator_suspended_is_not_a_busy_vault(self) -> None:
        """A suspension is not cleared by waiting, so it keeps degrading (#3618)."""
        outcome = await store_upload(
            ScriptedUploadClient(upload_error=VaultSendSuspendedError()), _document()
        )
        assert outcome.status is VaultUploadStatus.DEGRADED
        assert outcome.retry_after_seconds is None

    @pytest.mark.asyncio
    async def test_a_coded_rate_limit_is_busy_with_the_default_wait(self) -> None:
        """A ``rate_limited`` code with no wait named still answers busy."""
        error = CreekVaultRateLimitedError("shed", code=VaultErrorCode.RATE_LIMITED)
        outcome = await store_upload(ScriptedUploadClient(upload_error=error), _document())
        assert outcome.status is VaultUploadStatus.VAULT_BUSY
        assert outcome.retry_after_seconds == DEFAULT_VAULT_BUSY_RETRY_AFTER_SECONDS

    @pytest.mark.asyncio
    async def test_a_named_wait_of_zero_still_waits_a_second(self) -> None:
        """``Retry-After: 0`` would invite a tight loop, so the floor is one second."""
        error = CreekVaultUnavailableError(
            "busy", code=VaultErrorCode.TEMPORARILY_UNAVAILABLE, retry_after_seconds=0
        )
        outcome = await store_upload(ScriptedUploadClient(upload_error=error), _document())
        assert outcome.retry_after_seconds == 1

    @pytest.mark.asyncio
    async def test_an_uncoded_unavailable_error_is_not_busy(self) -> None:
        """No code, no 429: that is the vault absent, not the vault busy."""
        outcome = await store_upload(
            ScriptedUploadClient(upload_error=CreekVaultUnavailableError("down")), _document()
        )
        assert outcome.status is VaultUploadStatus.DEGRADED


class TestTheAdapterCarriesRetryAfter:
    """The HTTP adapter reads Creek's ``Retry-After`` onto the error it raises."""

    @pytest.mark.parametrize(
        ("raw", "expected"),
        [("7", 7), ("0", 0), (" 15 ", 15), ("soon", None), ("-1", None), ("9" * 12, None)],
    )
    @pytest.mark.asyncio
    async def test_retry_after_is_read_as_whole_seconds_or_not_at_all(
        self, vault_clients: _VaultFactory, raw: str, expected: int | None
    ) -> None:
        """Delta-seconds only: a date, a sign or an absurd length names no wait."""
        client = vault_clients(_BusyVault(retry_after=raw))
        await client.handshake()
        with pytest.raises(CreekVaultUnavailableError) as raised:
            await client.upload(_upload_request())
        assert raised.value.code is VaultErrorCode.TEMPORARILY_UNAVAILABLE
        assert raised.value.retry_after_seconds == expected

    @pytest.mark.asyncio
    async def test_a_429_raises_the_rate_limited_error_with_its_wait(
        self, vault_clients: _VaultFactory
    ) -> None:
        """The subclass keeps the wait its parent carries."""
        vault = _BusyVault(status=HTTPStatus.TOO_MANY_REQUESTS, body={}, retry_after="12")
        client = vault_clients(vault)
        await client.handshake()
        with pytest.raises(CreekVaultRateLimitedError) as raised:
            await client.upload(_upload_request())
        assert raised.value.retry_after_seconds == _SHED_RETRY_AFTER

    def test_an_error_built_without_a_wait_names_none(self) -> None:
        """Every existing raise site keeps meaning what it meant."""
        assert CreekVaultUnavailableError("down").retry_after_seconds is None


class TestTheHandshakeIsCachedPerRun:
    """One capability probe per Seed run, not one per document."""

    @pytest.mark.asyncio
    async def test_documents_of_one_run_share_one_probe(self, vault_clients: _VaultFactory) -> None:
        """Every request builds a fresh adapter; the run is what they share."""
        vault = _BusyVault(busy_for=2)
        outcomes = [await store_upload(vault_clients(vault), _document(_RUN_ID)) for _ in range(4)]
        assert [o.status for o in outcomes] == [
            VaultUploadStatus.VAULT_BUSY,
            VaultUploadStatus.VAULT_BUSY,
            VaultUploadStatus.ACCEPTED,
            VaultUploadStatus.ACCEPTED,
        ]
        assert vault.probes == 1
        assert vault.uploads == len(outcomes)

    @pytest.mark.asyncio
    async def test_without_a_run_every_document_probes(self, vault_clients: _VaultFactory) -> None:
        """A single upload, or any caller that names no run, behaves exactly as before."""
        vault = _BusyVault(busy_for=0)
        for _ in range(2):
            await store_upload(vault_clients(vault), _document())
        assert vault.probes == 2

    @pytest.mark.asyncio
    async def test_runs_and_owners_never_share_a_probe(self, vault_clients: _VaultFactory) -> None:
        """The cache key is the owner, the vault and the run: none may stand in for another."""
        vault = _BusyVault(busy_for=0)
        await store_upload(vault_clients(vault), _document(_RUN_ID))
        await store_upload(vault_clients(vault), _document(_OTHER_RUN_ID))
        await store_upload(vault_clients(vault), _document(_RUN_ID, owner=_OWNER_ID + 1))
        assert vault.probes == 3

    @pytest.mark.asyncio
    async def test_an_outage_forgets_the_probe(self, vault_clients: _VaultFactory) -> None:
        """After a real failure the next document asks the vault again."""
        vault = _BusyVault(busy_for=1, body={})
        first = await store_upload(vault_clients(vault), _document(_RUN_ID))
        await store_upload(vault_clients(vault), _document(_RUN_ID))
        assert first.status is VaultUploadStatus.DEGRADED
        assert vault.probes == 2

    @pytest.mark.asyncio
    async def test_a_vault_without_uploads_is_never_cached(self) -> None:
        """Only a probe that admits the upload is worth reusing."""
        memo = UploadHandshakeMemo()
        client = _CountingProbeClient(capabilities=frozenset({CreekCapability.JOURNAL}))
        for _ in range(2):
            await memo.prepare(client, owner_user_id=_OWNER_ID, run_id=_RUN_ID)
        assert client.probes == 2

    @pytest.mark.asyncio
    async def test_a_probe_is_reused_only_while_fresh(self) -> None:
        """The run re-probes once the reuse window has passed."""
        now = [0.0]
        memo = UploadHandshakeMemo(clock=lambda: now[0])
        client = _CountingProbeClient()
        await memo.prepare(client, owner_user_id=_OWNER_ID, run_id=_RUN_ID)
        now[0] = UPLOAD_HANDSHAKE_REUSE_SECONDS - 1
        await memo.prepare(client, owner_user_id=_OWNER_ID, run_id=_RUN_ID)
        assert client.probes == 1
        now[0] = UPLOAD_HANDSHAKE_REUSE_SECONDS + 1
        await memo.prepare(client, owner_user_id=_OWNER_ID, run_id=_RUN_ID)
        assert client.probes == 2

    @pytest.mark.asyncio
    async def test_the_memo_holds_a_bounded_number_of_runs(self) -> None:
        """A flood of run ids cannot grow the process without limit."""
        memo = UploadHandshakeMemo(max_entries=2)
        client = _CountingProbeClient()
        for run in ("run-aaaaaaaaaaaaaaaa", "run-bbbbbbbbbbbbbbbb", "run-cccccccccccccccc"):
            await memo.prepare(client, owner_user_id=_OWNER_ID, run_id=run)
        await memo.prepare(client, owner_user_id=_OWNER_ID, run_id="run-aaaaaaaaaaaaaaaa")
        assert client.probes == 4

    @pytest.mark.asyncio
    async def test_the_route_reads_the_run_off_the_request(self, async_client: AsyncClient) -> None:
        """``upload_run`` reaches the service, and a malformed one is refused."""
        refused = await async_client.post(
            _IMPORT_PATH,
            json={
                "filename": _FILENAME,
                "content_base64": _CONTENT_B64,
                "classification": "personal",
                "upload_run": "not a run id!",
            },
            headers=await _signup(async_client, "busy-run-refused"),
        )
        assert refused.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
        accepted = await _import_against(
            async_client, _BusyVault(busy_for=0), "busy-run", upload_run=_RUN_ID
        )
        assert accepted.json()["vault_status"] == VaultUploadStatus.ACCEPTED.value


# ---------------------------------------------------------------------------
# Doubles
# ---------------------------------------------------------------------------


def _upload_request() -> VaultUploadRequest:
    """Build the adapter-level request for one personal document."""
    return VaultUploadRequest(
        external_id=upload_external_id(_OWNER_ID, _FILENAME),
        filename=_FILENAME,
        content_base64=_CONTENT_B64,
        tier=VaultTierCeiling.PERSONAL,
        tier_ceiling=VaultTierCeiling.PERSONAL,
        created_at=_CREATED_AT,
    )


class _CountingProbeClient(ScriptedUploadClient):
    """A scripted vault whose probe is counted and whose handshake can be adopted.

    Shaped like the HTTP adapter's two memo hooks, so the memo is exercised on
    its own, without a transport.
    """

    def __init__(
        self,
        capabilities: frozenset[CreekCapability] = frozenset(
            {CreekCapability.JOURNAL, CreekCapability.UPLOAD}
        ),
    ) -> None:
        """Advertise ``capabilities`` and start with no probe made."""
        super().__init__(capabilities=capabilities)
        self.probes = 0
        self.adopted: list[HandshakeResult] = []

    @property
    def base_url(self) -> str:
        """Name one fixed vault."""
        return "https://counting-probe.example.test"

    async def handshake(self) -> HandshakeResult:
        """Count the probe, then answer as the scripted vault does."""
        self.probes += 1
        return await super().handshake()

    def adopt_handshake(self, result: HandshakeResult, /) -> None:
        """Record what the memo handed over."""
        self.adopted.append(result)
