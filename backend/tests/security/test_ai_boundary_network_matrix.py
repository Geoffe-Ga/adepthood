"""A vault-bound writer's AI operations dial only their vault, at the socket (B15, C13/C23).

The socket-level AI boundary matrix of #3161, with each dependency down in turn.

:mod:`tests.security.test_vault_boundary_no_fallback` proves the boundary at the
``generate_response`` seam. This suite proves it one layer lower, where it is a
claim about the network rather than about a function: a recorder replaces
``AsyncHTTPTransport.handle_async_request`` on **both** httpx stacks -- ``httpx``
(the vault client, Anthropic) and ``httpx2`` (OpenAI) -- which is the last call
before a socket opens. Every SDK, the real :class:`HttpCreekVaultClient` and
the real destination-pinning transport run above it unmodified, so a dial a
seam stub would have hidden is still seen here.

Nothing about the boundary is overridden. The writer's vault is a stored
connection row, resolved by the production dependency, and its host resolves
(through the patched resolver the pin consults) to a public address. The
recorder serves a scripted Creek ``/v1`` vault for that one name, a canned
provider for the two provider hosts, and refuses everything else, recording
each request's *name* (the TLS server name the pin carries) and *address*.

The matrix is operation x dependency condition x BYOK header:

* **operations** -- resonance, completion detection inside reflection,
  standalone detection, essay expansion, corpus classification and page
  transcription;
* **conditions** -- healthy, vault down, vault timing out, malformed
  capability, vault replaced mid-request (#3078), provider unreachable.

For a ``VAULT_BOUND`` writer the dialed names must be a subset of
``{their vault host}`` and the addresses a subset of ``{its pinned address}``,
and the answer a success or a closed-vocabulary refusal. An ``APP_PROVIDER``
writer carrying a key is the positive control: the same recorder records
their provider dials, so a recorder that saw nothing is evidence.

Essay expansion and page transcription have no vault capability, so under
``VAULT_BOUND`` they fail closed (#3156): every one of their rows must be the
refunded ``reflection_source_unavailable`` refusal, whatever the condition.

The seam, as well as the socket. Corpus classification and page transcription
never forward a key, and under ADR 0009 phase (a) a keyless request reaches no
cloud provider, so a leak there would never reach a socket: it would be a call
to ``generate_response`` answered by the armed stub here, by a refusal in
production. :func:`test_a_vault_bound_writer_never_reaches_the_app_provider_seam`
pins that those three operations never reach the app-provider dial under
``VAULT_BOUND`` (the leak #3156 closed), beside a live control for the same spy.

Declared limits, so none hides behind a green row:

* **A condition an operation never meets is vacuous for it.** Standalone
  detection under ``VAULT_BOUND`` never dials the vault, so "replaced
  mid-request" cannot fire there; the row still asserts the dial set.
* **The Creek half of C13** -- that the vault's own model is local, pinned and
  serving -- is out of this repository (Geoffe-Ga/Creek-Vault#1849, #2871).
  This suite proves only the routing half: which destinations adepthood dials.
"""

from __future__ import annotations

import enum
import json
import logging
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from dataclasses import dataclass, field, replace
from datetime import date
from http import HTTPStatus
from pathlib import Path
from typing import Final

import httpx
import httpx2
import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import SQLModel, col, select

from domain.creek_vault import CONTRACT_VERSION
from models.goal import Goal
from models.habit import Habit
from models.journal_entry import JournalEntry
from models.marginalia import Marginalia, MarginaliaKind
from models.user import User
from routers import transcription as transcription_router
from services import botmason, creek_vault_url_resolution
from services import frequency_classification as frequency_classification_service
from services import marginalia as marginalia_service
from services.botmason import ImagePayload, LLMResponse
from services.creek_vault_pipeline import wait_for_vault_pipeline_tasks
from services.reflection_boundary import REFLECTION_SOURCE_UNAVAILABLE
from services.user_vault_config import store_vault_config
from tests.provider_transport import OPENAI_KEY, OPENAI_MODEL
from tests.transcription_helpers import JPEG_BYTES, payload

# ── The writer, their vault, and the hosts nobody else may be ─────────────────

_PASSWORD: Final = "secret12345"  # pragma: allowlist secret
_BODY: Final = "I meditated for twenty minutes by the river and the willow bent without breaking."
_QUOTE: Final = "the willow bent without breaking"
_VAULT_NOTE: Final = "The vault reads: you bend and return."
_VAULT_LETTER: Final = "The vault writes: you bent, and you came back."
_BYOK_HEADER: Final = "X-LLM-API-Key"
_VAULT_KEY: Final = "creek-vault-matrix-key"  # pragma: allowlist secret

_VAULT_HOST: Final = "vault-own.example.test"
_REPLACEMENT_HOST: Final = "vault-replacement.example.test"
#: The read that tells a client which vendors' keys its vault would write with.
_VENDORS: Final = "/user/vault-key-vendors"
#: Public answers, so the real pin admits both; distinct, so an address alone
#: tells which vault a socket went to.
_ADDRESSES: Final = {_VAULT_HOST: "93.184.216.34", _REPLACEMENT_HOST: "93.184.216.35"}
_OPENAI_HOST: Final = "api.openai.com"
_ANTHROPIC_HOST: Final = "api.anthropic.com"
_PROVIDER_HOSTS: Final = frozenset({_OPENAI_HOST, _ANTHROPIC_HOST})

# ── The scripted Creek /v1 vault ──────────────────────────────────────────────

_CAPABILITIES_PATH: Final = "/v1/capabilities"
_JOURNAL_PATH: Final = "/v1/journal-entries/"
_REFLECTIONS_PATH: Final = "/v1/reflections"
_LETTERS_PATH: Final = "/v1/letters/"
_MINOR_COMPONENTS: Final = 2
_CONTRACT_MINOR: Final = ".".join(CONTRACT_VERSION.split(".")[:_MINOR_COMPONENTS])
_FIXTURES: Final = Path(__file__).resolve().parents[1] / "fixtures" / "creek_v1" / "examples"


def _fixture(capability: str, state: str) -> dict[str, object]:
    """One published Creek contract example."""
    text = (_FIXTURES / capability / f"{state}.json").read_text(encoding="utf-8")
    loaded: dict[str, object] = json.loads(text)
    return loaded


_HANDSHAKE: Final[dict[str, object]] = {
    "vault": {"available": True},
    "capabilities": ["journal-upsert", "reflections", "voice-drafts", "letters"],
    "contract_version": CONTRACT_VERSION,
    "contract_minor": _CONTRACT_MINOR,
    "supported_contract_minors": [_CONTRACT_MINOR],
    "ontology_version": "1.0.0",
    "attestation": None,
}
#: A managed vault (Creek-Vault ADR-0015): it will write with a writer's own
#: Anthropic or OpenAI key, sent per request, and runs the classification pass.
_MANAGED_HANDSHAKE: Final[dict[str, object]] = {
    **_HANDSHAKE,
    "capabilities": ["journal-upsert", "reflections", "voice-drafts", "letters", "pipeline"],
    "request_key_providers": ["anthropic", "openai"],
}
_PROVIDER_KEY_HEADER: Final = "X-Creek-Provider-Key"
_PROVIDER_HEADER: Final = "X-Creek-Provider"
#: The model-backed answers a vault labels with the route that wrote them
#: (contract 0.19 ``inference_source``), so the only ones this edge stamps.
_LABELLED_PATHS: Final = (_REFLECTIONS_PATH, _LETTERS_PATH)
#: The only vault routes that call a model, so the only ones a key may ride.
_KEYED_PATHS: Final = (_REFLECTIONS_PATH, _LETTERS_PATH, "/v1/classifications")
_REFLECTION: Final[dict[str, object]] = {
    "status": "ok",
    "notes": [{"kind": "pattern", "quote": _QUOTE, "note": _VAULT_NOTE}],
    "essay": None,
    "essay_grounded": False,
    "routed_tier": "personal",
    "tier_ceiling": "personal",
}
_UNAVAILABLE: Final = _fixture("reflections", "unavailable-service")
#: What a healthy vault answers, by path prefix: the journal upsert is keyed by
#: the entry's id under its collection path.
_SERVED: Final[tuple[tuple[str, dict[str, object]], ...]] = (
    (_JOURNAL_PATH, _fixture("journal-upsert", "success")),
    (_REFLECTIONS_PATH, _REFLECTION),
)


def _vault_letter_at(path: str) -> dict[str, object]:
    """The published letter success cell, re-addressed to the id the request named."""
    return {
        **_fixture("letters", "success"),
        "external_id": path.removeprefix(_LETTERS_PATH),
        "letter": _VAULT_LETTER,
    }


def _served(path: str) -> dict[str, object] | None:
    """The healthy vault's answer at ``path``, or ``None`` for a path it does not serve."""
    if path.startswith(_LETTERS_PATH):
        return _vault_letter_at(path)
    return next((body for prefix, body in _SERVED if path.startswith(prefix)), None)


# ── The canned provider ───────────────────────────────────────────────────────

_PROVIDER_REPLY: Final = json.dumps(
    {"notes": [{"kind": "theme", "quote": _QUOTE, "note": "It holds."}], "hits": []}
)
_OPENAI_OK: Final[dict[str, object]] = {
    "id": "chatcmpl-matrix",
    "object": "chat.completion",
    "created": 0,
    "model": OPENAI_MODEL,
    "choices": [
        {
            "index": 0,
            "message": {"role": "assistant", "content": _PROVIDER_REPLY},
            "finish_reason": "stop",
        }
    ],
    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
}


class Condition(enum.StrEnum):
    """One dependency stopped in turn, or none."""

    HEALTHY = "healthy"
    VAULT_DOWN = "vault_down"
    VAULT_TIMEOUT = "vault_timeout"
    MALFORMED_CAPABILITY = "malformed_capability"
    VAULT_REPLACED = "vault_replaced"
    PROVIDER_UNREACHABLE = "provider_unreachable"


@dataclass(frozen=True, slots=True)
class Dial:
    """One request that reached the last call before a socket.

    ``provider_key`` is the writer's key when the request carried one in Creek's
    ``X-Creek-Provider-Key`` header (#3437), so a row can say exactly which
    destination was handed it.
    """

    name: str
    address: str
    path: str
    provider_key: str | None = None


class _Refused(enum.Enum):
    """How a scripted dependency fails on the wire."""

    CONNECT = "connect"
    TIMEOUT = "timeout"


@dataclass(frozen=True, slots=True)
class _Answer:
    """What the wire says back: a JSON body, raw text, or a transport failure."""

    status: int = HTTPStatus.OK
    body: object = None
    text: str | None = None
    refused: _Refused | None = None


_CONNECT_REFUSED: Final = _Answer(refused=_Refused.CONNECT)


@dataclass
class NetworkEdge:
    """The recorder at ``AsyncHTTPTransport.handle_async_request``, both stacks.

    ``condition`` is read per request, so a test arranges under a healthy
    network and stops a dependency only for the operation it drives.
    ``replace`` is the writer's own reconnect, run through the real route the
    first time the vault is asked for anything but its capabilities while the
    condition is :attr:`Condition.VAULT_REPLACED`.
    """

    condition: Condition = Condition.HEALTHY
    dials: list[Dial] = field(default_factory=list)
    replace: Callable[[], Awaitable[httpx.Response]] | None = None
    replaced_status: int | None = None
    #: A managed vault: its handshake advertises the vendors whose writer key it
    #: will spend (Creek contract 0.18, #3437). Off for every pre-#3437 row.
    managed: bool = False
    #: How many capability answers advertise request keys before the vault stops
    #: (#3483's handshake race); ``None`` keeps advertising for as long as
    #: ``managed`` holds.
    advertised_handshakes: int | None = None
    #: The relayed key does not work at its vendor -- a forged, prefix-valid
    #: string -- so the vault answers from its own route instead (#3483).
    key_rejected_by_vendor: bool = False
    #: The route a vault that did not spend a writer key names in its receipt:
    #: the shared pool here, ``local`` for a vault with its own model.
    keyless_route: str = "pool:creek"

    def keyed(self) -> list[Dial]:
        """Every dial that carried a writer's provider key."""
        return [dial for dial in self.dials if dial.provider_key is not None]

    def names(self) -> set[str]:
        """Every destination name dialed."""
        return {dial.name for dial in self.dials}

    def addresses(self) -> set[str]:
        """Every address a socket would have opened to."""
        return {dial.address for dial in self.dials}

    def forget(self) -> None:
        """Drop what arrangement dialed, so only the operation under test is judged."""
        self.dials.clear()

    async def answer(
        self,
        name: str,
        address: str,
        path: str,
        provider_key: str | None = None,
        provider: str | None = None,
    ) -> _Answer:
        """Record the request, then answer it as the scripted network would."""
        self.dials.append(Dial(name=name, address=address, path=path, provider_key=provider_key))
        if name in _PROVIDER_HOSTS:
            return self._provider()
        if name in _ADDRESSES:
            answer = await self._vault(path)
            return self._labelled(answer, path, None if provider_key is None else provider)
        return _CONNECT_REFUSED

    def _labelled(self, answer: _Answer, path: str, key_vendor: str | None) -> _Answer:
        """Stamp a model-backed answer with the route that wrote it, as Creek does.

        ``request_key:<vendor>`` only when a writer key arrived *and* worked;
        every other answer names the vault's own route.
        """
        if not (path.startswith(_LABELLED_PATHS) and isinstance(answer.body, dict)):
            return answer
        spent = key_vendor is not None and not self.key_rejected_by_vendor
        route = f"request_key:{key_vendor}" if spent else self.keyless_route
        return replace(answer, body={**answer.body, "inference_source": route})

    def _provider(self) -> _Answer:
        if self.condition is Condition.PROVIDER_UNREACHABLE:
            return _CONNECT_REFUSED
        return _Answer(body=_OPENAI_OK)

    async def _vault(self, path: str) -> _Answer:
        if self.condition is Condition.VAULT_DOWN:
            return _CONNECT_REFUSED
        if path == _CAPABILITIES_PATH:
            return self._capabilities()
        if self.condition is Condition.VAULT_TIMEOUT:
            return _Answer(refused=_Refused.TIMEOUT)
        if self.condition is Condition.VAULT_REPLACED:
            return await self._replaced()
        served = _served(path)
        if served is None:
            return _Answer(status=HTTPStatus.SERVICE_UNAVAILABLE, body=_UNAVAILABLE)
        return _Answer(body=served)

    def _capabilities(self) -> _Answer:
        if self.condition is Condition.MALFORMED_CAPABILITY:
            return _Answer(text="<html>not a capability document</html>")
        if self.managed and self._still_advertising():
            return _Answer(body=_MANAGED_HANDSHAKE)
        return _Answer(body=_HANDSHAKE)

    def _still_advertising(self) -> bool:
        """Spend one advertised handshake, if a count was scripted at all."""
        if self.advertised_handshakes is None:
            return True
        self.advertised_handshakes -= 1
        return self.advertised_handshakes >= 0

    async def _replaced(self) -> _Answer:
        """The writer reconnects while this call is in flight, then the old vault drops it."""
        if self.replace is not None and self.replaced_status is None:
            self.replaced_status = (await self.replace()).status_code
        return _CONNECT_REFUSED


def _dial_identity(url_host: str, extensions: dict[str, object]) -> tuple[str, str]:
    """The name a request is for and the address it would open, from either stack.

    The pin rewrites the URL host to the checked address and carries the name as
    the TLS server name; an unpinned client leaves the name in the URL, so its
    "address" is that name. A vault dial that slipped past the pin would
    therefore fail the address assertion even though its name is right.
    """
    sni = extensions.get("sni_hostname")
    name = sni if isinstance(sni, str) else url_host
    return name, url_host


def _httpx_response(answer: _Answer, request: httpx.Request) -> httpx.Response:
    if answer.refused is _Refused.CONNECT:
        raise httpx.ConnectError("refused by the network edge", request=request)
    if answer.refused is _Refused.TIMEOUT:
        raise httpx.ReadTimeout("timed out at the network edge", request=request)
    if answer.text is not None:
        return httpx.Response(answer.status, text=answer.text, request=request)
    return httpx.Response(answer.status, json=answer.body, request=request)


def _httpx2_response(answer: _Answer, request: httpx2.Request) -> httpx2.Response:
    if answer.refused is _Refused.CONNECT:
        raise httpx2.ConnectError("refused by the network edge", request=request)
    if answer.refused is _Refused.TIMEOUT:
        raise httpx2.ReadTimeout("timed out at the network edge", request=request)
    if answer.text is not None:
        return httpx2.Response(answer.status, text=answer.text, request=request)
    return httpx2.Response(answer.status, json=answer.body, request=request)


@pytest_asyncio.fixture
async def network_edge(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[NetworkEdge]:
    """Install the recorder below every SDK and the vault client, on both httpx stacks."""
    edge = NetworkEdge()

    async def _httpx(_transport: object, request: httpx.Request) -> httpx.Response:
        name, address = _dial_identity(request.url.host, dict(request.extensions))
        key = request.headers.get(_PROVIDER_KEY_HEADER)
        vendor = request.headers.get(_PROVIDER_HEADER)
        answer = await edge.answer(name, address, request.url.path, key, vendor)
        return _httpx_response(answer, request)

    async def _httpx2(_transport: object, request: httpx2.Request) -> httpx2.Response:
        name, address = _dial_identity(request.url.host, dict(request.extensions))
        key = request.headers.get(_PROVIDER_KEY_HEADER)
        vendor = request.headers.get(_PROVIDER_HEADER)
        answer = await edge.answer(name, address, request.url.path, key, vendor)
        return _httpx2_response(answer, request)

    async def _resolve(host: str) -> tuple[str, ...]:
        return (_ADDRESSES[host],) if host in _ADDRESSES else ()

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", _httpx)
    monkeypatch.setattr(httpx2.AsyncHTTPTransport, "handle_async_request", _httpx2)
    monkeypatch.setattr(creek_vault_url_resolution, "resolve_host_addresses", _resolve)
    # Shorten only provider backoff; scheduler and lease-heartbeat timers keep
    # their own real asyncio sleep and cannot spin on this fixture's database.
    monkeypatch.setattr(botmason, "_RETRY_BASE_DELAY", 0.0)
    monkeypatch.setenv("LLM_MODEL", OPENAI_MODEL)
    try:
        yield edge
    finally:
        # The network patch and StaticPool schema must outlive the bounded
        # continuation this real request admitted.
        await wait_for_vault_pipeline_tasks()


@dataclass(frozen=True, slots=True)
class Harness:
    """The app client, the test's session, and the network edge under them."""

    client: AsyncClient
    session: AsyncSession
    edge: NetworkEdge


@pytest.fixture
def harness(
    async_client: AsyncClient, db_session: AsyncSession, network_edge: NetworkEdge
) -> Harness:
    """Everything a row drives, behind one name."""
    return Harness(async_client, db_session, network_edge)


# ── Writers ───────────────────────────────────────────────────────────────────


@dataclass
class Writer:
    """One signed-up writer, and whatever the operation under test arranged."""

    headers: dict[str, str]
    user_id: int
    target: int = 0

    def with_key(self, *, byok: bool) -> dict[str, str]:
        """The writer's headers, carrying their own provider key when ``byok``."""
        return {**self.headers, _BYOK_HEADER: OPENAI_KEY} if byok else self.headers


async def _signup(client: AsyncClient, session: AsyncSession, username: str) -> Writer:
    resp = await client.post(
        "/auth/signup", json={"email": f"{username}@example.com", "password": _PASSWORD}
    )
    assert resp.status_code == HTTPStatus.OK
    user = (
        await session.execute(select(User).where(col(User.email) == f"{username}@example.com"))
    ).scalar_one()
    assert user.id is not None
    return Writer({"Authorization": f"Bearer {resp.json()['token']}"}, user.id)


def _vault_url(host: str) -> str:
    return f"https://{host}"


async def _connect_vault(session: AsyncSession, writer: Writer) -> None:
    """A stored connection row: the production resolver makes this writer vault-bound."""
    await store_vault_config(
        session, writer.user_id, vault_url=_vault_url(_VAULT_HOST), api_key=_VAULT_KEY
    )


# ── Operations ────────────────────────────────────────────────────────────────


async def _create_entry(client: AsyncClient, writer: Writer) -> httpx.Response:
    return await client.post(
        "/journal/", json={"message": _BODY, "classification": "personal"}, headers=writer.headers
    )


async def _arrange_entry(client: AsyncClient, _session: AsyncSession, writer: Writer) -> None:
    resp = await _create_entry(client, writer)
    assert resp.status_code == HTTPStatus.CREATED
    writer.target = int(resp.json()["id"])


async def _arrange_entry_with_candidate(
    client: AsyncClient, session: AsyncSession, writer: Writer
) -> None:
    """An entry plus one active habit, so detection has a candidate to send."""
    habit = Habit(
        name="Meditation",
        icon="🧘",
        start_date=date(2025, 1, 1),
        energy_cost=1,
        energy_return=2,
        user_id=writer.user_id,
    )
    session.add(habit)
    await session.commit()
    await session.refresh(habit)
    session.add(
        Goal(
            habit_id=habit.id,
            title="clear",
            tier="clear",
            target=20.0,
            target_unit="minutes",
            frequency=1.0,
            frequency_unit="per_day",
            is_additive=True,
        )
    )
    await session.commit()
    await _arrange_entry(client, session, writer)


async def _arrange_note(_client: AsyncClient, session: AsyncSession, writer: Writer) -> None:
    """A margin note on the writer's own entry, so its letter can be asked for."""
    entry = JournalEntry(sender="user", user_id=writer.user_id, message=_BODY)
    session.add(entry)
    await session.flush()
    note = Marginalia(
        journal_entry_id=entry.id,
        user_id=writer.user_id,
        kind=MarginaliaKind.SYMBOL,
        anchor_start=0,
        anchor_end=6,
        anchor_text=_BODY[:6],
        note="A beginning.",
    )
    session.add(note)
    await session.commit()
    await session.refresh(note)
    assert note.id is not None
    writer.target = note.id


async def _arrange_corpus_consent(
    client: AsyncClient, _session: AsyncSession, writer: Writer
) -> None:
    """Consent first, so the entry the operation writes is classified for the corpus."""
    resp = await client.put(
        "/corpus/consent/journal", json={"granted": True}, headers=writer.headers
    )
    assert resp.status_code == HTTPStatus.OK


async def _nothing(_client: AsyncClient, _session: AsyncSession, _writer: Writer) -> None:
    return None


async def _resonance(client: AsyncClient, writer: Writer, *, byok: bool) -> httpx.Response:
    return await client.post(
        f"/journal/{writer.target}/resonance", headers=writer.with_key(byok=byok)
    )


async def _detect(client: AsyncClient, writer: Writer, *, byok: bool) -> httpx.Response:
    return await client.post(
        f"/journal/{writer.target}/suggestions/detect", headers=writer.with_key(byok=byok)
    )


async def _essay(client: AsyncClient, writer: Writer, *, byok: bool) -> httpx.Response:
    return await client.post(
        f"/journal/marginalia/{writer.target}/essay",
        json={"price_acknowledged": True},
        headers=writer.with_key(byok=byok),
    )


async def _classify(client: AsyncClient, writer: Writer, *, byok: bool) -> httpx.Response:
    response = await client.post(
        "/journal/",
        json={"message": _BODY, "classification": "personal"},
        headers=writer.with_key(byok=byok),
    )
    await wait_for_vault_pipeline_tasks()
    return response


async def _transcribe(client: AsyncClient, writer: Writer, *, byok: bool) -> httpx.Response:
    return await client.post(
        "/journal/transcribe-page", json=payload(JPEG_BYTES), headers=writer.with_key(byok=byok)
    )


_Arrange = Callable[[AsyncClient, AsyncSession, Writer], Awaitable[None]]
_Drive = Callable[..., Awaitable[httpx.Response]]


@dataclass(frozen=True, slots=True)
class Operation:
    """One AI operation: how to arrange it and how a writer asks for it.

    ``relays_key`` says whether the server forwards the writer's key to a
    provider on this route; a route that does not can reach no cloud provider
    under ADR 0009 phase (a), so its positive control is the seam spy instead.
    ``asks_vault`` says whether a vault-bound pass asks the vault for more than
    its capabilities -- the only operations a mid-call reconnect can land
    inside, and the ones a healthy row must show reaching the vault at all.
    ``vault_answer`` is text only the healthy vault's answer carries.
    ``fails_closed`` says the operation has no vault capability, so a
    vault-bound writer is always refused with the closed code (#3156).
    """

    name: str
    arrange: _Arrange
    drive: _Drive
    relays_key: bool
    asks_vault: bool = False
    vault_answer: str | None = None
    fails_closed: bool = False


_OPERATIONS: Final = (
    Operation(
        "resonance",
        _arrange_entry,
        _resonance,
        relays_key=True,
        asks_vault=True,
        vault_answer=_VAULT_NOTE,
    ),
    Operation(
        "reflection_detection",
        _arrange_entry_with_candidate,
        _resonance,
        relays_key=True,
        asks_vault=True,
        vault_answer=_VAULT_NOTE,
    ),
    Operation("standalone_detect", _arrange_entry_with_candidate, _detect, relays_key=True),
    Operation(
        "essay",
        _arrange_note,
        _essay,
        relays_key=True,
        asks_vault=True,
        vault_answer=_VAULT_LETTER,
    ),
    Operation(
        "corpus_classification",
        _arrange_corpus_consent,
        _classify,
        relays_key=False,
        asks_vault=True,
    ),
    Operation("transcription", _nothing, _transcribe, relays_key=False, fails_closed=True),
)
_BY_NAME: Final = {operation.name: operation for operation in _OPERATIONS}

#: The refusals a writer may see instead of a result: closed-vocabulary codes,
#: each naming a retryable or unavailable state rather than anything the
#: dependency said.
_CLOSED_REFUSALS: Final = frozenset({REFLECTION_SOURCE_UNAVAILABLE})
_SUCCESS: Final = frozenset({HTTPStatus.OK, HTTPStatus.CREATED})


def _assert_result_or_closed_refusal(resp: httpx.Response) -> None:
    """A result, or a refusal whose detail is one of the closed codes -- never a raw error."""
    if resp.status_code in _SUCCESS:
        return
    assert resp.status_code == HTTPStatus.SERVICE_UNAVAILABLE, resp.text
    assert resp.json()["detail"] in _CLOSED_REFUSALS


# ── The matrix ────────────────────────────────────────────────────────────────


def _vault_bound_case(operation: Operation, condition: Condition, *, byok: bool) -> object:
    key = "byok" if byok else "keyless"
    return pytest.param(operation.name, condition, byok, id=f"{operation.name}-{condition}-{key}")


_VAULT_BOUND_MATRIX: Final = [
    _vault_bound_case(operation, condition, byok=byok)
    for operation in _OPERATIONS
    for condition in Condition
    for byok in (False, True)
]


async def _vault_bound_writer(harness: Harness, username: str) -> Writer:
    """Sign up, connect a vault, and wire the mid-request reconnect to the real route."""
    writer = await _signup(harness.client, harness.session, username)
    await _connect_vault(harness.session, writer)

    async def _reconnect() -> httpx.Response:
        return await harness.client.put(
            "/vault/connection",
            json={"vault_url": _vault_url(_REPLACEMENT_HOST), "api_key": _VAULT_KEY},
            headers=writer.headers,
        )

    harness.edge.replace = _reconnect
    return writer


@pytest.mark.asyncio
@pytest.mark.parametrize(("operation", "condition", "byok"), _VAULT_BOUND_MATRIX)
async def test_vault_bound_operation_dials_only_its_vault(
    harness: Harness,
    operation: str,
    condition: Condition,
    byok: bool,
) -> None:
    """Dialed names stay within the writer's vault host, with each dependency stopped in turn.

    The vault-replaced rows are #3078's: the reconnect lands through the real
    route mid-call, and the pass in flight must neither dial the newly stored
    vault nor anything else. A BYOK header pays for calls; it never permits a
    destination the boundary does not.
    """
    op = _BY_NAME[operation]
    writer = await _vault_bound_writer(harness, f"net_{operation}_{condition}_{int(byok)}")
    await op.arrange(harness.client, harness.session, writer)
    harness.edge.forget()
    harness.edge.condition = condition

    resp = await op.drive(harness.client, writer, byok=byok)

    assert harness.edge.names() <= {_VAULT_HOST}, harness.edge.dials
    assert harness.edge.addresses() <= {_ADDRESSES[_VAULT_HOST]}, harness.edge.dials
    # A vault that never advertised request keys is never handed one (#3437).
    assert harness.edge.keyed() == [], harness.edge.dials
    _assert_result_or_closed_refusal(resp)
    _assert_the_row_is_not_vacuous(op, condition, harness.edge, resp)


def _assert_the_row_is_not_vacuous(
    op: Operation, condition: Condition, edge: NetworkEdge, resp: httpx.Response
) -> None:
    """A row passes for the right reason: the vault was asked, the reconnect landed.

    A healthy row of an operation that asks its vault must show the vault
    asked and its answer served, or a recorder that saw nothing would pass it.
    A replaced row of the same operations must show the writer's reconnect
    really landed mid-call, or the row would prove nothing about #3078. With
    the vault itself healthy their writer gets a result. An operation with no
    vault capability is refused in every row, before anything is dialed.
    """
    if op.fails_closed:
        assert resp.status_code == HTTPStatus.SERVICE_UNAVAILABLE, resp.text
        assert resp.json()["detail"] == REFLECTION_SOURCE_UNAVAILABLE
        assert edge.names() == set(), edge.dials
    if not op.asks_vault:
        return
    if condition in {Condition.HEALTHY, Condition.PROVIDER_UNREACHABLE}:
        assert resp.status_code in _SUCCESS, resp.text
    if condition is Condition.HEALTHY:
        assert edge.names() == {_VAULT_HOST}
        assert op.vault_answer is None or op.vault_answer in resp.text
    if condition is Condition.VAULT_REPLACED:
        assert edge.replaced_status == HTTPStatus.OK


# ── The positive control: the same recorder sees an app-provider writer's dials ──

_KEY_RELAYING: Final = [operation for operation in _OPERATIONS if operation.relays_key]


@pytest.mark.asyncio
@pytest.mark.parametrize("condition", [Condition.HEALTHY, Condition.PROVIDER_UNREACHABLE], ids=str)
@pytest.mark.parametrize("operation", [op.name for op in _KEY_RELAYING])
async def test_app_provider_writer_dials_are_recorded(
    harness: Harness,
    operation: str,
    condition: Condition,
) -> None:
    """No vault, a key of their own: the recorder sees the provider, and only the provider.

    The proof the recorder is live. An unreachable provider is still recorded --
    the dial was attempted -- and still nothing else is dialed in its place.
    """
    op = _BY_NAME[operation]
    writer = await _signup(harness.client, harness.session, f"net_app_{operation}_{condition}")
    await op.arrange(harness.client, harness.session, writer)
    harness.edge.forget()
    harness.edge.condition = condition

    await op.drive(harness.client, writer, byok=True)

    assert harness.edge.names() == {_OPENAI_HOST}, harness.edge.dials


# ── Below the socket's reach: the app-provider seam ───────────────────────────

#: Every module whose binding of the app-provider dial an operation here calls.
_SEAM_MODULES: Final = (marginalia_service, frequency_classification_service, transcription_router)
_SEAM_OPERATIONS: Final = ("essay", "corpus_classification", "transcription")


@dataclass
class _SeamSpy:
    """Counts calls to the app-provider dial, then lets the real one answer."""

    calls: int = 0


def _spy_on_the_seam(monkeypatch: pytest.MonkeyPatch) -> _SeamSpy:
    """Wrap each module's binding of ``generate_response``; the real function still runs."""
    spy = _SeamSpy()
    real = botmason.generate_response

    async def _counting(
        user_message: str,
        conversation_history: list[dict[str, str]],
        system_prompt: str | None = None,
        api_key: str | None = None,
        images: Sequence[ImagePayload] | None = None,
    ) -> LLMResponse:
        spy.calls += 1
        return await real(user_message, conversation_history, system_prompt, api_key, images)

    for module in _SEAM_MODULES:
        assert module.generate_response is real, module.__name__
        monkeypatch.setattr(module, "generate_response", _counting)
    return spy


@pytest.mark.asyncio
@pytest.mark.parametrize("byok", [False, True], ids=["keyless", "byok"])
@pytest.mark.parametrize("operation", _SEAM_OPERATIONS)
async def test_a_vault_bound_writer_never_reaches_the_app_provider_seam(
    harness: Harness,
    monkeypatch: pytest.MonkeyPatch,
    operation: str,
    byok: bool,
) -> None:
    """The leak the socket cannot always see: an app-provider call under ``VAULT_BOUND``.

    With or without a key, none of these operations may reach the app-provider
    dial for a vault-bound writer. Before #3156 every one of them did, and the
    corpus and transcription calls never showed at the socket.
    """
    op = _BY_NAME[operation]
    writer = await _vault_bound_writer(harness, f"seam_{operation}_{int(byok)}")
    await op.arrange(harness.client, harness.session, writer)
    spy = _spy_on_the_seam(monkeypatch)

    await op.drive(harness.client, writer, byok=byok)

    assert spy.calls == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", _SEAM_OPERATIONS)
async def test_the_seam_spy_sees_an_app_provider_writer(
    harness: Harness,
    monkeypatch: pytest.MonkeyPatch,
    operation: str,
) -> None:
    """The same spy, no vault: each of those operations reaches the seam, so silence is evidence."""
    op = _BY_NAME[operation]
    writer = await _signup(harness.client, harness.session, f"seam_app_{operation}")
    await op.arrange(harness.client, harness.session, writer)
    spy = _spy_on_the_seam(monkeypatch)

    await op.drive(harness.client, writer, byok=False)

    assert spy.calls > 0
    # Keyless, so no cloud provider is reached (ADR 0009 phase (a)): the seam,
    # not the socket, is the only place these calls can be seen.
    assert harness.edge.names() == set()


# ── A managed vault spends the writer's own key (#3437, Creek-Vault ADR-0015) ────────

#: The operations whose vault call runs a model, so the ones a managed vault is
#: handed the writer's key for. Detection and page reading have no vault
#: capability and never carry it.
_KEY_SPENDING: Final = ("resonance", "reflection_detection", "essay", "corpus_classification")


@pytest.mark.asyncio
@pytest.mark.parametrize("byok", [False, True], ids=["keyless", "byok"])
@pytest.mark.parametrize("operation", [op.name for op in _OPERATIONS])
async def test_a_managed_vault_writer_dials_only_their_vault_which_alone_is_handed_the_key(
    harness: Harness,
    operation: str,
    byok: bool,
) -> None:
    """The boundary under ADR 0009's 2026-10-16 amendment: the vault dials the vendor, not us.

    A vault-bound writer whose managed vault advertises request keys still
    dials nothing but that vault. When they carry a key, it rides only on the
    vault's model routes -- reflections, letters, the classification pass --
    and on nothing else this request sends; without one, nothing carries a key.
    """
    op = _BY_NAME[operation]
    writer = await _vault_bound_writer(harness, f"managed_{operation}_{int(byok)}")
    await op.arrange(harness.client, harness.session, writer)
    # Advertised only now, so arranging an entry starts no pipeline pass of its own.
    harness.edge.managed = True
    harness.edge.forget()

    resp = await op.drive(harness.client, writer, byok=byok)

    assert harness.edge.names() <= {_VAULT_HOST}, harness.edge.dials
    assert harness.edge.addresses() <= {_ADDRESSES[_VAULT_HOST]}, harness.edge.dials
    _assert_result_or_closed_refusal(resp)
    keyed = harness.edge.keyed()
    assert all(dial.name == _VAULT_HOST for dial in keyed), keyed
    assert all(dial.path.startswith(_KEYED_PATHS) for dial in keyed), keyed
    assert all(dial.provider_key == OPENAI_KEY for dial in keyed), "key altered in transit"
    if byok and operation in _KEY_SPENDING:
        assert keyed, f"{operation}: the managed vault was never handed the writer's key"
    if not byok or operation not in _KEY_SPENDING:
        assert keyed == [], keyed


async def _exhaust_wallet(session: AsyncSession, writer: Writer) -> None:
    """Spend every unit in both wallet buckets, so only a key can pay."""
    user = await session.get(User, writer.user_id)
    assert user is not None
    user.offering_balance = 0
    user.monthly_messages_used = 10_000
    session.add(user)
    await session.commit()


@pytest.mark.asyncio
async def test_a_managed_vault_reading_is_paid_by_the_key_and_labelled_with_its_vendor(
    harness: Harness,
) -> None:
    """No credits, a key: the managed vault answers, nothing is charged, and the pass says why."""
    writer = await _vault_bound_writer(harness, "managed_pays")
    await _arrange_entry(harness.client, harness.session, writer)
    harness.edge.managed = True
    await _exhaust_wallet(harness.session, writer)
    harness.edge.forget()

    resp = await _resonance(harness.client, writer, byok=True)

    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()
    assert _VAULT_NOTE in resp.text
    assert body["provenance"]["paid_by"] == "own_key"
    assert body["provenance"]["own_key_vendor"] == "openai"
    assert body["provenance"]["notes"]["source"] == "creek_vault"
    assert body["remaining_balance"] == 0
    assert OPENAI_KEY not in resp.text


@pytest.mark.asyncio
async def test_a_keyless_managed_vault_reading_still_needs_credits(harness: Harness) -> None:
    """Without a key, behaviour is unchanged: an empty wallet is the payer refusal."""
    writer = await _vault_bound_writer(harness, "managed_keyless")
    await _arrange_entry(harness.client, harness.session, writer)
    harness.edge.managed = True
    await _exhaust_wallet(harness.session, writer)
    harness.edge.forget()

    resp = await _resonance(harness.client, writer, byok=False)

    assert resp.status_code == HTTPStatus.PAYMENT_REQUIRED, resp.text
    assert harness.edge.keyed() == []


@pytest.mark.asyncio
async def test_a_self_connected_vault_reading_with_a_key_still_takes_a_credit(
    harness: Harness,
) -> None:
    """A vault that does not advertise request keys never gets one, so credits pay (#3258)."""
    writer = await _vault_bound_writer(harness, "self_connected_key")
    await _arrange_entry(harness.client, harness.session, writer)
    await _exhaust_wallet(harness.session, writer)
    harness.edge.forget()

    resp = await _resonance(harness.client, writer, byok=True)

    assert resp.status_code == HTTPStatus.PAYMENT_REQUIRED, resp.text
    assert harness.edge.keyed() == []


@pytest.mark.asyncio
async def test_a_managed_vault_letter_is_paid_by_the_key(harness: Harness) -> None:
    """The essay route: no credits, a key, a managed vault -- the vault writes it, free."""
    writer = await _vault_bound_writer(harness, "managed_letter")
    harness.edge.managed = True
    await _arrange_note(harness.client, harness.session, writer)
    await _exhaust_wallet(harness.session, writer)
    harness.edge.forget()

    resp = await harness.client.post(
        f"/journal/marginalia/{writer.target}/essay",
        json={},
        headers=writer.with_key(byok=True),
    )

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert _VAULT_LETTER in resp.text
    assert resp.json()["remaining_balance"] == 0
    assert [dial.path.startswith(_LETTERS_PATH) for dial in harness.edge.keyed()] == [True]


# ── "Paid by your own key" is the vault's receipt, never adepthood's guess (#3483) ──

#: A prefix-valid string no vendor issued: it passes every shape check adepthood
#: can run, and is refused only where the vault spends it.
_FORGED_KEY: Final = "sk-forgedforgedforgedforgedforged00"  # pragma: allowlist secret


async def _wallet_of(session: AsyncSession, writer: Writer) -> tuple[int, int]:
    """The writer's two wallet buckets as stored now: monthly used, offering balance."""
    session.expire_all()
    user = await session.get(User, writer.user_id)
    assert user is not None
    return user.monthly_messages_used, user.offering_balance


async def _notes_on(session: AsyncSession, entry_id: int) -> list[Marginalia]:
    """Every margin note persisted on ``entry_id``."""
    rows = await session.execute(
        select(Marginalia).where(col(Marginalia.journal_entry_id) == entry_id)
    )
    return list(rows.scalars().all())


async def _keyed_reading(
    harness: Harness, username: str, key: str
) -> tuple[Writer, httpx.Response]:
    """An empty-wallet writer on a managed vault asks for a reading with ``key``."""
    writer = await _vault_bound_writer(harness, username)
    await _arrange_entry(harness.client, harness.session, writer)
    harness.edge.managed = True
    await _exhaust_wallet(harness.session, writer)
    harness.edge.forget()
    resp = await harness.client.post(
        f"/journal/{writer.target}/resonance", headers={**writer.headers, _BYOK_HEADER: key}
    )
    return writer, resp


def _assert_refused_unpaid(resp: httpx.Response) -> None:
    """The pass was refused as the retryable vault 503, with no vault prose in it."""
    assert resp.status_code == HTTPStatus.SERVICE_UNAVAILABLE, resp.text
    assert resp.json()["detail"] == REFLECTION_SOURCE_UNAVAILABLE
    assert _VAULT_NOTE not in resp.text
    assert _VAULT_LETTER not in resp.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("username", "key", "route"),
    [
        ("local_fallback", OPENAI_KEY, "local"),
        ("pool_fallback", OPENAI_KEY, "pool:creek"),
        ("forged_key_local_model", _FORGED_KEY, "local"),
    ],
)
async def test_a_vault_that_answers_without_spending_the_key_gives_no_free_reading(
    harness: Harness, username: str, key: str, route: str
) -> None:
    """The key rode to the vault, the vault answered from its own route: no free notes.

    ``forged_key_local_model`` is Creek-Vault#1849's future: a managed vault with
    a local model answers a prefix-valid key nobody issued. Before #3483 that was
    an unlimited free reading labelled "your own key"; now the receipt names
    ``local``, so the pass is refused unpaid and keeps nothing.
    """
    harness.edge.key_rejected_by_vendor = True
    harness.edge.keyless_route = route

    writer, resp = await _keyed_reading(harness, username, key)

    assert [dial.provider_key for dial in harness.edge.keyed()] == [key]
    _assert_refused_unpaid(resp)
    assert await _wallet_of(harness.session, writer) == (10_000, 0)
    assert await _notes_on(harness.session, writer.target) == []


@pytest.mark.asyncio
async def test_a_handshake_that_changes_between_probe_and_dial_gives_no_free_reading(
    harness: Harness,
) -> None:
    """The probe saw request keys; the dial's own handshake did not, so no key rode it.

    The admission probe decided "the key pays" and took no credit; the reflect
    gate's handshake then stopped advertising, the relay omitted the header and
    the vault answered from its pool. The receipt -- read after the answer, so
    it cannot race -- says no key was spent, and the pass is refused unpaid.
    """
    harness.edge.advertised_handshakes = 1

    writer, resp = await _keyed_reading(harness, "handshake_race", OPENAI_KEY)

    assert harness.edge.keyed() == []
    _assert_refused_unpaid(resp)
    assert await _wallet_of(harness.session, writer) == (10_000, 0)
    assert await _notes_on(harness.session, writer.target) == []


@pytest.mark.asyncio
async def test_a_forged_key_on_a_vault_with_a_local_model_buys_no_free_letter(
    harness: Harness,
) -> None:
    """The essay route: the vault's local model wrote it, so no key paid and nothing is kept."""
    harness.edge.key_rejected_by_vendor = True
    harness.edge.keyless_route = "local"
    writer = await _vault_bound_writer(harness, "forged_letter")
    harness.edge.managed = True
    await _arrange_note(harness.client, harness.session, writer)
    await _exhaust_wallet(harness.session, writer)
    harness.edge.forget()

    resp = await harness.client.post(
        f"/journal/marginalia/{writer.target}/essay",
        json={},
        headers={**writer.headers, _BYOK_HEADER: _FORGED_KEY},
    )

    assert [dial.path.startswith(_LETTERS_PATH) for dial in harness.edge.keyed()] == [True]
    _assert_refused_unpaid(resp)
    assert await _wallet_of(harness.session, writer) == (10_000, 0)
    note = await harness.session.get(Marginalia, writer.target)
    assert note is not None
    assert note.essay is None


@pytest.mark.asyncio
async def test_an_intimate_entry_with_a_key_never_reaches_the_managed_vault(
    harness: Harness,
) -> None:
    """The privacy floor holds first: an intimate entry is answered privately, nothing dialled."""
    writer = await _vault_bound_writer(harness, "managed_intimate")
    harness.edge.managed = True
    resp = await harness.client.post(
        "/journal/", json={"message": _BODY, "classification": "intimate"}, headers=writer.headers
    )
    assert resp.status_code == HTTPStatus.CREATED
    writer.target = int(resp.json()["id"])
    harness.edge.forget()

    reading = await _resonance(harness.client, writer, byok=True)

    assert reading.status_code == HTTPStatus.OK, reading.text
    assert reading.json()["private"] is True
    assert harness.edge.dials == []


@pytest.mark.asyncio
async def test_the_vendor_read_discloses_the_vendors_a_managed_vault_writes_with(
    harness: Harness,
) -> None:
    """The client learns, before any charge, that the writer's key would pay.

    From its own read, never from the usage snapshot: a price snapshot still
    dials nothing, even for a managed vault's writer, and the vendor read only
    handshakes -- no key and no stored writing rides it.
    """
    managed = await _vault_bound_writer(harness, "usage_managed")
    harness.edge.managed = True
    harness.edge.forget()
    usage = await harness.client.get("/user/usage", headers=managed.headers)
    usage_dials = list(harness.edge.dials)
    managed_vendors = await harness.client.get(_VENDORS, headers=managed.headers)
    harness.edge.managed = False
    self_connected = await harness.client.get(_VENDORS, headers=managed.headers)
    app_writer = await _signup(harness.client, harness.session, "usage_app")
    harness.edge.forget()
    app_vendors = await harness.client.get(_VENDORS, headers=app_writer.headers)

    assert usage.status_code == HTTPStatus.OK, usage.text
    assert usage_dials == []
    assert "vault_key_vendors" not in usage.json()
    assert managed_vendors.json() == {"vendors": ["anthropic", "openai"]}
    assert self_connected.json() == {"vendors": []}
    assert app_vendors.json() == {"vendors": []}
    assert harness.edge.dials == []
    assert harness.edge.keyed() == []


# ── The canary: the relayed key leaves no trace (#3437) ───────────────────────

_CANARY_KEYS: Final = (
    "sk-ant-api03-CANARY3437relayedKEYneverSTOREDzz",  # pragma: allowlist secret
    "sk-proj-CANARY3437relayedKEYneverSTOREDzz",  # pragma: allowlist secret
)


async def _database_text(session: AsyncSession) -> str:
    """Every row of every table, rendered: the persisted state a key could hide in."""
    rendered: list[str] = []
    for table in SQLModel.metadata.sorted_tables:
        result = await session.execute(table.select())
        rendered.append(repr(result.all()))
    return "\n".join(rendered)


@pytest.mark.asyncio
@pytest.mark.parametrize("canary", _CANARY_KEYS, ids=["anthropic", "openai"])
async def test_a_relayed_key_is_never_logged_persisted_or_echoed(
    harness: Harness,
    caplog: pytest.LogCaptureFixture,
    canary: str,
) -> None:
    """Relay a canary key through every keyed operation and a failing one, then sweep.

    The canary must reach the vault -- that is the feature -- and nowhere else:
    not a response body or header, not a log record at any level (the vault
    client's and the SDKs' DEBUG included), and not a row in any table.
    """
    writer = await _vault_bound_writer(harness, f"canary_{canary[:6]}")
    await _arrange_entry(harness.client, harness.session, writer)
    entry_id = writer.target
    await _arrange_note(harness.client, harness.session, writer)
    harness.edge.managed = True
    keyed = {**writer.headers, _BYOK_HEADER: canary}
    responses: list[httpx.Response] = []

    with caplog.at_level(logging.DEBUG):
        responses.append(await harness.client.post(f"/journal/{entry_id}/resonance", headers=keyed))
        responses.append(
            await harness.client.post(
                f"/journal/marginalia/{writer.target}/essay", json={}, headers=keyed
            )
        )
        responses.append(
            await harness.client.post(
                "/journal/", json={"message": _BODY, "classification": "personal"}, headers=keyed
            )
        )
        await wait_for_vault_pipeline_tasks()
        responses.append(await harness.client.get("/user/usage", headers=keyed))
        responses.append(await harness.client.get(_VENDORS, headers=keyed))
        harness.edge.condition = Condition.VAULT_TIMEOUT
        responses.append(await harness.client.post(f"/journal/{entry_id}/resonance", headers=keyed))

    assert {dial.provider_key for dial in harness.edge.keyed()} == {canary}
    for response in responses:
        assert canary not in response.text
        assert canary not in str(dict(response.headers))
    for record in caplog.records:
        assert canary not in record.getMessage()
        assert canary not in str(record.__dict__)
    assert canary not in await _database_text(harness.session)
