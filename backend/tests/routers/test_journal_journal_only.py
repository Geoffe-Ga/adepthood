"""Journal-only regression: saving an entry on a fresh account reaches nothing off-box (#3073).

A user who has given no corpus consent, connected no vault, and is not the
deployment's bound vault owner must be able to journal with no hidden AI on
save. This pins that as an invariant across every classification tier and with
every optional depth ring declined:

* no real vault client is ever built (both builders replaced with raising
  counters; a fresh account falls through to the local fallback);
* no language-model call is made through any module that can reach a provider;
* no outbound HTTP request is opened at all (the test client rides
  ``ASGITransport``, so any ``AsyncHTTPTransport`` request is real egress);
* the stored entry carries no ``vault_ref`` and no corpus fragment exists.

``store_and_classify`` *is* called on every save -- against the
``LocalFallbackCreekVaultClient`` -- so the invariant is "nothing real is
dialled", not "the write path is skipped".
"""

from __future__ import annotations

from http import HTTPStatus

import httpx
import pytest
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from dependencies import creek_vault as creek_vault_dependency
from models.corpus_fragment import CorpusFragment
from models.journal_entry import JournalClassification, JournalEntry
from services import botmason, frequency_classification, marginalia

# Every module whose ``generate_response`` name can carry a journal save to a
# language-model provider. ``botmason`` owns it; the other two import it by
# name, so each binding must be counted where it is looked up.
_PROVIDER_MODULES = (botmason, marginalia, frequency_classification)

_ALL_RINGS_OFF = {
    "enable_habits": False,
    "enable_practices": False,
    "enable_course": False,
    "enable_sangha": False,
}


class _EgressCounters:
    """Counts every attempt to reach a provider, a real vault, or the network."""

    def __init__(self) -> None:
        """Start every counter at zero."""
        self.vault_builds = 0
        self.provider_calls = 0
        self.http_requests = 0

    def total(self) -> dict[str, int]:
        """Return the counters by name, for one exact assertion."""
        return {
            "vault_builds": self.vault_builds,
            "provider_calls": self.provider_calls,
            "http_requests": self.http_requests,
        }


@pytest.fixture
def egress(monkeypatch: pytest.MonkeyPatch) -> _EgressCounters:
    """Unset the deployment vault and replace every egress seam with a refusing counter."""
    monkeypatch.delenv(creek_vault_dependency.OWNER_ENV_VAR, raising=False)
    monkeypatch.delenv("CREEK_VAULT_URL", raising=False)
    counters = _EgressCounters()

    def _refuse_vault(*_args: object, **_kwargs: object) -> None:
        counters.vault_builds += 1
        msg = "a journal-only save must never build a real vault client"
        raise AssertionError(msg)

    async def _refuse_provider(*_args: object, **_kwargs: object) -> None:
        counters.provider_calls += 1
        msg = "a journal-only save must never call a language-model provider"
        raise AssertionError(msg)

    async def _refuse_http(*_args: object, **_kwargs: object) -> None:
        counters.http_requests += 1
        msg = "a journal-only save must never open an outbound HTTP request"
        raise AssertionError(msg)

    monkeypatch.setattr(creek_vault_dependency, "build_creek_vault_client", _refuse_vault)
    monkeypatch.setattr(creek_vault_dependency, "build_connected_vault_client", _refuse_vault)
    for module in _PROVIDER_MODULES:
        monkeypatch.setattr(module, "generate_response", _refuse_provider)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", _refuse_http)
    return counters


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    """Create a fresh account and return (auth headers, user_id)."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    return {"Authorization": f"Bearer {data['token']}"}, int(data["user_id"])


async def _save_and_read_back(
    client: AsyncClient,
    session: AsyncSession,
    headers: dict[str, str],
    classification: JournalClassification | None,
) -> JournalEntry:
    """POST one journal entry and return its stored row."""
    payload: dict[str, str] = {"message": "The kettle sang while the light came up."}
    if classification is not None:
        payload["classification"] = classification.value
    resp = await client.post("/journal/", json=payload, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED, resp.text
    session.expire_all()
    result = await session.execute(
        select(JournalEntry).where(col(JournalEntry.id) == int(resp.json()["id"]))
    )
    return result.scalars().one()


async def _fragment_count(session: AsyncSession, user_id: int) -> int:
    """Count the corpus fragments stored for one user."""
    result = await session.execute(
        select(func.count())
        .select_from(CorpusFragment)
        .where(col(CorpusFragment.user_id) == user_id)
    )
    return int(result.scalar_one())


_CLASSIFICATIONS = [None, *JournalClassification]


@pytest.mark.parametrize("classification", _CLASSIFICATIONS)
@pytest.mark.asyncio
async def test_fresh_account_save_makes_no_provider_or_vault_call(
    async_client: AsyncClient,
    db_session: AsyncSession,
    egress: _EgressCounters,
    classification: JournalClassification | None,
) -> None:
    """A fresh account's save, at any tier, reaches no provider, vault, or network."""
    tier = "default" if classification is None else classification.value
    headers, user_id = await _signup(async_client, f"journalonly_{tier}")

    entry = await _save_and_read_back(async_client, db_session, headers, classification)

    assert entry.vault_ref is None
    assert await _fragment_count(db_session, user_id) == 0
    assert egress.total() == {"vault_builds": 0, "provider_calls": 0, "http_requests": 0}


@pytest.mark.asyncio
async def test_every_ring_declined_save_makes_no_provider_or_vault_call(
    async_client: AsyncClient, db_session: AsyncSession, egress: _EgressCounters
) -> None:
    """With every optional depth declined, journaling still works and stays on-box."""
    headers, user_id = await _signup(async_client, "journalonly_rings_off")
    patched = await async_client.patch("/depth-preferences", json=_ALL_RINGS_OFF, headers=headers)
    assert patched.status_code == HTTPStatus.OK, patched.text
    assert not any(patched.json()[flag] for flag in _ALL_RINGS_OFF)

    entry = await _save_and_read_back(async_client, db_session, headers, None)
    invitations = await async_client.get("/invitations", headers=headers)

    assert entry.vault_ref is None
    assert await _fragment_count(db_session, user_id) == 0
    assert invitations.status_code == HTTPStatus.OK
    assert invitations.json() == []
    assert egress.total() == {"vault_builds": 0, "provider_calls": 0, "http_requests": 0}
