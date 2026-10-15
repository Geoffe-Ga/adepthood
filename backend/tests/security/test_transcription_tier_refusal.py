"""The server learns a page's declared tier and refuses anything but an egress tier (#3059 AC15).

Photo transcription is a cloud read of the page's own words. The client has
refused an Intimate page since #1882, but until now the server never heard the
tier at all, so a client that skipped its own gate -- a stale build, a bug, a
hand-rolled request -- reached the provider. Both doors now carry the declared
``classification`` of the entry the page belongs to:

* ``POST /journal/transcribe-page`` (the server-relayed read), and
* ``POST /journal/transcribe-page/direct-admission`` (ADR 0009 client-direct:
  the device asks before calling its own vendor, so the server must never
  admit an Intimate page there either).

Eligibility is :func:`domain.privacy_tier.admits_egress`, the one allowlist:
``intimate``, an unknown tier, the empty string and a wrong-case spelling are
all refused 403 ``tier_refused``, and a request that omits the tier is refused
by the schema. Every refusal lands before the vault boundary read, the payer
gate, the generation slot, the wallet, the usage log and the provider.

Each spy below *delegates* to the real function, so the same spies fire on the
``personal`` / ``public`` counterweights: a spy that could not see a call would
fail there rather than pass every refusal.

**The payer dimension** (#3353, C08). Every refusal also runs with a writer's
own key on ``X-LLM-API-Key`` (BYOK), and with the *real* provider dial behind
the router's seam and both vendors' SDK factories recorded
(:func:`tests.support.egress_recorders.record_provider_clients`), so a refused
page must build no provider client whoever would have paid. Neither door
declares that header (ADR 0009 phase (a), #3067): one sent anyway is ignored,
so an *admitted* page carrying a key is still read keyless on the stub seam and
builds no client either -- the BYOK counterweights pin that real behaviour, and
the recorder's own positive control shows a client built with a key is seen.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from http import HTTPStatus
from typing import TYPE_CHECKING, Final

import pytest
from sqlalchemy import func, select
from sqlmodel import col

from models.llm_usage_log import LLMUsageLog
from models.user import User
from routers import transcription as transcription_router
from services import botmason
from tests.incident.test_privacy_suspension import signup
from tests.provider_transport import OPENAI_KEY
from tests.support.egress_recorders import (
    WRITERS_KEY,
    Ledger,
    Recorder,
    record_provider_clients,
)
from tests.transcription_helpers import (
    JPEG_BYTES,
    SENTINEL_TEXT,
    b64,
    patch_generate_response,
    priced_response,
)

if TYPE_CHECKING:
    from httpx import AsyncClient
    from sqlalchemy.ext.asyncio import AsyncSession

_TRANSCRIBE: Final = "/journal/transcribe-page"
_ADMISSION: Final = "/journal/transcribe-page/direct-admission"
_REFUSAL: Final = {"detail": "tier_refused"}

#: Every value the allowlist must deny: the Intimate tier itself, its
#: wrong-case spellings, an unknown tier, the empty string, and a near-miss
#: of an eligible tier.
_DENIED: Final = ("intimate", "INTIMATE", "Intimate", "secret", "", "Personal", " personal")
_ADMITTED: Final = ("personal", "public")

#: Every seam an admitted page crosses, in order, on its way to a kept reading.
_KEYLESS_READ: Final = (
    "require_external_ai_available",
    "resolve_reflection_boundary",
    "require_ai_payer",
    "generation_slot",
    "preflight_deduction",
    "generate_response",
    "record_llm_usage",
)

#: Who would pay for the read: the app's own seam (no key), or the writer's own
#: key on the BYOK header, which neither transcription door declares.
_PAYERS: Final = {"app-seam": {}, "byok": {"X-LLM-API-Key": OPENAI_KEY}}

#: The router-level seams a page read crosses, in order, before it is billed
#: and dialled. ``generate_response`` is the provider dial itself (here a
#: priced canned reply, so nothing leaves the test process).
_ASYNC_SEAMS: Final = (
    "resolve_reflection_boundary",
    "require_ai_payer",
    "preflight_deduction",
    "generate_response",
    "record_llm_usage",
)


def _page(classification: str | None) -> dict[str, str]:
    """A valid one-page body declaring ``classification`` (omitted when ``None``)."""
    body = {"image_base64": b64(JPEG_BYTES), "media_type": "image/jpeg"}
    if classification is not None:
        body["classification"] = classification
    return body


def _record_async(
    calls: list[str], name: str, real: Callable[..., Awaitable[object]]
) -> Callable[..., Awaitable[object]]:
    """Wrap ``real`` so every await is named in ``calls``, then delegated.

    Typed without PEP 695 generics: the 3.11 compat job must parse this file.
    """

    async def _spy(*args: object, **kwargs: object) -> object:
        calls.append(name)
        return await real(*args, **kwargs)

    return _spy


@pytest.fixture
def seams(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Record, in order, every router seam a request reaches (each still runs for real)."""
    calls: list[str] = []
    # A priced reply, so a read that got through keeps a usage row: the stub
    # seam's own canned reply is unpriced and would leave the usage assertions
    # below nothing to see.
    patch_generate_response(monkeypatch, priced_response(SENTINEL_TEXT))
    for name in _ASYNC_SEAMS:
        real = getattr(transcription_router, name)
        monkeypatch.setattr(transcription_router, name, _record_async(calls, name, real))
    real_slot = transcription_router.generation_slot

    @asynccontextmanager
    async def _slot(session: AsyncSession, user_id: int) -> AsyncIterator[None]:
        calls.append("generation_slot")
        async with real_slot(session, user_id):
            yield

    monkeypatch.setattr(transcription_router, "generation_slot", _slot)
    real_gate = transcription_router.require_external_ai_available

    def _gate() -> None:
        calls.append("require_external_ai_available")
        real_gate()

    monkeypatch.setattr(transcription_router, "require_external_ai_available", _gate)
    return calls


@pytest.fixture
def clients(monkeypatch: pytest.MonkeyPatch, seams: list[str]) -> Ledger:
    """Put the real provider dial behind the seam spy, and record every SDK client built.

    ``seams`` answers with a canned reply that never reaches a vendor's SDK, so
    a key that leaked through it could build no client to be seen. Here the
    spy delegates to the real :func:`services.botmason.generate_response`
    instead: a key the router forwarded would select a vendor and build its
    client, at a factory that records it (and talks to an in-process transport).
    """
    real_dial = botmason.generate_response
    monkeypatch.setattr(
        transcription_router,
        "generate_response",
        _record_async(seams, "generate_response", real_dial),
    )
    ledger = Ledger()
    record_provider_clients(monkeypatch, ledger, writer_key=OPENAI_KEY)
    return ledger


@dataclass(frozen=True)
class Watched:
    """The router seams a request reached, and every SDK client it built."""

    seams: list[str]
    clients: Ledger


@pytest.fixture
def watched(seams: list[str], clients: Ledger) -> Watched:
    """Both spies at once, for a test whose parameters leave room for one fixture."""
    return Watched(seams, clients)


def _built(ledger: Ledger) -> list[tuple[str, str]]:
    """Every provider client built, as (vendor, whose key)."""
    return [(e.verb, e.payload) for e in ledger.since(0, Recorder.PROVIDER_CLIENT)]


async def _wallet(session: AsyncSession, user_id: int) -> tuple[int, int]:
    """(monthly_messages_used, offering_balance), read fresh."""
    await session.rollback()
    user = (await session.execute(select(User).where(col(User.id) == user_id))).scalar_one()
    return user.monthly_messages_used, user.offering_balance


async def _usage_rows(session: AsyncSession, user_id: int) -> int:
    """How many metered generations the account has."""
    await session.rollback()
    result = await session.execute(
        select(func.count()).select_from(LLMUsageLog).where(col(LLMUsageLog.user_id) == user_id)
    )
    return int(result.scalar_one())


# --- POST /journal/transcribe-page ---------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("payer", _PAYERS)
@pytest.mark.parametrize("tier", _DENIED)
async def test_a_page_of_a_non_egress_tier_is_refused_before_anything_is_touched(
    async_client: AsyncClient, db_session: AsyncSession, watched: Watched, tier: str, payer: str
) -> None:
    """403 ``tier_refused``: no boundary read, payer, slot, charge, usage row, dial or client."""
    headers, user_id, _ = await signup(async_client, f"tier_refused_{payer}_{tier.encode().hex()}")
    before = await _wallet(db_session, user_id)

    resp = await async_client.post(
        _TRANSCRIBE, headers={**headers, **_PAYERS[payer]}, json=_page(tier)
    )

    assert resp.status_code == HTTPStatus.FORBIDDEN, resp.text
    assert resp.json() == _REFUSAL
    assert watched.seams == []
    assert _built(watched.clients) == []
    assert await _wallet(db_session, user_id) == before
    assert await _usage_rows(db_session, user_id) == 0


@pytest.mark.asyncio
async def test_a_page_with_no_declared_tier_is_refused_before_anything_is_touched(
    async_client: AsyncClient, db_session: AsyncSession, seams: list[str]
) -> None:
    """The tier is required: a body without one never reaches the handler."""
    headers, user_id, _ = await signup(async_client, "tier_missing")
    before = await _wallet(db_session, user_id)

    resp = await async_client.post(_TRANSCRIBE, headers=headers, json=_page(None))

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY, resp.text
    assert [entry["loc"] for entry in resp.json()["detail"]] == [["body", "classification"]]
    assert seams == []
    assert await _wallet(db_session, user_id) == before
    assert await _usage_rows(db_session, user_id) == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("tier", _ADMITTED)
async def test_a_page_of_an_egress_tier_is_still_read_and_billed(
    async_client: AsyncClient, db_session: AsyncSession, seams: list[str], tier: str
) -> None:
    """Counterweight: the same spies see every seam, and the wallet is charged."""
    headers, user_id, _ = await signup(async_client, f"tier_admitted_{tier}")
    before = await _wallet(db_session, user_id)

    resp = await async_client.post(_TRANSCRIBE, headers=headers, json=_page(tier))

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert seams == list(_KEYLESS_READ)
    assert await _wallet(db_session, user_id) != before
    assert await _usage_rows(db_session, user_id) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("tier", _ADMITTED)
async def test_a_writers_key_sent_with_an_egress_tier_page_is_ignored(
    async_client: AsyncClient,
    db_session: AsyncSession,
    seams: list[str],
    clients: Ledger,
    tier: str,
) -> None:
    """BYOK counterweight: the route reads the page keyless on the stub seam, building no client.

    The real behaviour since ADR 0009 phase (a): the header is not declared, so
    the same seams fire as for a keyless page, the real dial is reached without
    the key, the armed stub answers, and no SDK client is ever built with it.
    """
    headers, user_id, _ = await signup(async_client, f"tier_admitted_byok_{tier}")
    before = await _wallet(db_session, user_id)

    resp = await async_client.post(
        _TRANSCRIBE, headers={**headers, **_PAYERS["byok"]}, json=_page(tier)
    )

    assert _built(clients) == [], "the ignored key reached a vendor's SDK"
    assert resp.status_code == HTTPStatus.OK, resp.text
    assert seams == list(_KEYLESS_READ)
    assert await _wallet(db_session, user_id) != before


@pytest.mark.asyncio
async def test_the_client_recorder_sees_a_client_built_with_the_writers_key(
    clients: Ledger,
) -> None:
    """The recorder's positive control: a dial that does carry the key is seen building a client."""
    await botmason.generate_response("Read this page.", [], api_key=OPENAI_KEY)

    assert _built(clients) == [("openai", WRITERS_KEY)]


# --- POST /journal/transcribe-page/direct-admission ----------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("payer", _PAYERS)
@pytest.mark.parametrize("tier", _DENIED)
async def test_the_direct_admission_never_admits_a_non_egress_tier(
    async_client: AsyncClient, seams: list[str], clients: Ledger, tier: str, payer: str
) -> None:
    """The device is told no, so the page never leaves it for the vendor, whoever would pay."""
    headers, _, _ = await signup(async_client, f"admission_refused_{payer}_{tier.encode().hex()}")

    resp = await async_client.post(
        _ADMISSION, headers={**headers, **_PAYERS[payer]}, json={"classification": tier}
    )

    assert resp.status_code == HTTPStatus.FORBIDDEN, resp.text
    assert resp.json() == _REFUSAL
    assert seams == []
    assert _built(clients) == []


@pytest.mark.asyncio
@pytest.mark.parametrize("body", [None, {}], ids=["no-body", "no-classification"])
async def test_the_direct_admission_requires_a_declared_tier(
    async_client: AsyncClient, seams: list[str], body: dict[str, str] | None
) -> None:
    """A request that declares no tier is refused by the schema, never admitted."""
    headers, _, _ = await signup(async_client, f"admission_missing_{body is None}")

    resp = await async_client.post(_ADMISSION, headers=headers, json=body)

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY, resp.text
    assert seams == []


@pytest.mark.asyncio
@pytest.mark.parametrize("payer", _PAYERS)
@pytest.mark.parametrize("tier", _ADMITTED)
async def test_the_direct_admission_still_admits_an_egress_tier(
    async_client: AsyncClient, seams: list[str], clients: Ledger, tier: str, payer: str
) -> None:
    """Counterweight: 204, the incident switch is still consulted, and no client is built.

    The admission carries neither the page nor the key: the device dials its
    own vendor, so a key sent here anyway changes nothing on the server.
    """
    headers, _, _ = await signup(async_client, f"admission_admitted_{payer}_{tier}")

    resp = await async_client.post(
        _ADMISSION, headers={**headers, **_PAYERS[payer]}, json={"classification": tier}
    )

    assert resp.status_code == HTTPStatus.NO_CONTENT, resp.text
    assert resp.content == b""
    assert seams == ["require_external_ai_available"]
    assert _built(clients) == []
