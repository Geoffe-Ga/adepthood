"""``/corpus/sweep`` for a vault-bound writer: sorting means handing writing to the vault.

A writer who connected a vault is answered by it or not at all (#3156), so the
app-side sweep correctly refuses to classify their writing -- and before this
module, that refusal was the whole of "Sort": every pass reported nothing
sorted against a remainder that never moved, because the remainder was counted
in app-side fragments that a vault-bound account can never have.

For that writer, unsorted writing is writing their vault does not have yet:
entries saved before the vault was connected, or whose save could not reach
it. Sorting is handing those entries to the vault down the journal save's own
path (:func:`services.journal_vault_write.record_vault_outcome`), whose
pipeline nudge then has the vault classify them. The properties pinned here:

* the count is entries without a vault copy, and a pass drives it to zero;
* the app provider's classifier is never dialled;
* no standing consent, no send -- the same gate the app-side sweep keeps;
* intimate writing is neither counted nor sent;
* a vault that cannot take writing stops the pass after the first refusal;
* one account's sort never sends another account's writing.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from dependencies.creek_vault import get_creek_vault_client
from domain.creek_vault import CreekVaultUnavailableError, HandshakeResult
from main import app
from models.corpus_fragment import CorpusSource
from models.journal_entry import JournalClassification, JournalEntry
from services import corpus_sort_run
from services import frequency_classification as fc
from services.corpus_consent import set_consent
from services.user_vault_config import store_vault_config
from tests.test_journal_vault_write import SequencedVaultClient

_SWEEP_PATH = "/corpus/sweep"
_PASSWORD = "secret12345"  # pragma: allowlist secret
_VAULT_URL = "https://vault.example.test"
_VAULT_KEY = "creek-vault-sort-unit-key"  # pragma: allowlist secret

# More than one, so a count stumbled onto by coincidence cannot pass.
_BACKLOG = 3
# Small enough that a backlog of three spans two cursor batches.
_SMALL_BATCH = 2


@pytest.fixture
def vault() -> Iterator[SequencedVaultClient]:
    """Serve a vault that takes every entry, and record what it was handed."""
    double = SequencedVaultClient()
    app.dependency_overrides[get_creek_vault_client] = lambda: double
    yield double
    app.dependency_overrides.pop(get_creek_vault_client, None)


@pytest.fixture(autouse=True)
def _no_retry_waits(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep the vault lane's retry ladder, without its real waits."""
    retries = len(corpus_sort_run.VAULT_RETRY_DELAYS_SECONDS)
    monkeypatch.setattr(corpus_sort_run, "VAULT_RETRY_DELAYS_SECONDS", (0.0,) * retries)


@pytest.fixture(autouse=True)
def _no_app_classifier(monkeypatch: pytest.MonkeyPatch) -> None:
    """Fail loudly if anything dials the app provider's classifier."""

    async def forbidden(**_kwargs: object) -> None:
        msg = "a vault-bound sort must never dial the app provider"
        raise AssertionError(msg)

    monkeypatch.setattr(fc, "generate_response", forbidden)


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    """Create an account and return its auth headers and id."""
    resp = await client.post(
        "/auth/signup", json={"email": f"{username}@example.com", "password": _PASSWORD}
    )
    assert resp.status_code == HTTPStatus.OK, resp.text
    data = resp.json()
    return {"Authorization": f"Bearer {data['token']}"}, int(data["user_id"])


async def _vault_bound(session: AsyncSession, user_id: int, *, consent: bool = True) -> None:
    """Connect a vault -- the server state that makes the account vault-bound."""
    await store_vault_config(
        session, user_id, vault_url=_VAULT_URL, api_key=_VAULT_KEY, provisioned=True
    )
    if consent:
        await set_consent(session, user_id=user_id, source=CorpusSource.JOURNAL, granted=True)
    await session.commit()


async def _entries(
    session: AsyncSession,
    *,
    user_id: int,
    count: int,
    tier: JournalClassification = JournalClassification.PERSONAL,
    vault_ref: str | None = None,
) -> list[int]:
    """Insert ``count`` entries directly, so no save path has sent them anywhere yet."""
    rows = [
        JournalEntry(
            message=f"a morning {index}",
            sender="user",
            user_id=user_id,
            classification=tier.value,
            timestamp=datetime.now(UTC),
            vault_ref=vault_ref,
        )
        for index in range(count)
    ]
    session.add_all(rows)
    await session.commit()
    return [int(row.id) for row in rows if row.id is not None]


async def _vault_refs(session: AsyncSession, user_id: int) -> list[str | None]:
    """Every entry's vault ref for ``user_id``, read fresh."""
    session.expire_all()
    result = await session.execute(
        select(col(JournalEntry.vault_ref))
        .where(col(JournalEntry.user_id) == user_id)
        .order_by(col(JournalEntry.id))
    )
    return list(result.scalars().all())


async def _pending(client: AsyncClient, headers: dict[str, str]) -> int:
    """``GET /corpus/sweep``'s count."""
    resp = await client.get(_SWEEP_PATH, headers=headers)
    assert resp.status_code == HTTPStatus.OK, resp.text
    return int(resp.json()["entries_pending"])


async def _sort(client: AsyncClient, headers: dict[str, str]) -> dict[str, int]:
    """Press Sort, let the background run finish, and report it in the pass's three counts.

    ``entries_sorted`` is what the run sorted; pending and remaining are the
    count read once it ended -- the numbers the bounded pass used to answer with.
    """
    resp = await client.post(_SWEEP_PATH, headers=headers)
    assert resp.status_code == HTTPStatus.ACCEPTED, resp.text
    await corpus_sort_run.wait_for_corpus_sort_tasks()
    read = await client.get(_SWEEP_PATH, headers=headers)
    assert read.status_code == HTTPStatus.OK, read.text
    pending = int(read.json()["entries_pending"])
    return {
        "entries_pending": pending,
        "entries_sorted": int(read.json()["run"]["entries_sorted"]),
        "entries_remaining": pending,
    }


@pytest.mark.asyncio
async def test_writing_the_vault_lacks_is_counted_and_handed_to_it(
    async_client: AsyncClient, db_session: AsyncSession, vault: SequencedVaultClient
) -> None:
    """The reported bug: a vault-bound pass used to sort nothing, forever."""
    headers, user_id = await _signup(async_client, "vault-sort-sends")
    await _vault_bound(db_session, user_id)
    await _entries(db_session, user_id=user_id, count=_BACKLOG)

    assert await _pending(async_client, headers) == _BACKLOG
    body = await _sort(async_client, headers)

    assert body == {"entries_pending": 0, "entries_sorted": _BACKLOG, "entries_remaining": 0}
    assert len(vault.ingest_calls) == _BACKLOG
    assert None not in await _vault_refs(db_session, user_id)
    assert await _pending(async_client, headers) == 0


@pytest.mark.asyncio
async def test_writing_already_in_the_vault_is_neither_counted_nor_resent(
    async_client: AsyncClient, db_session: AsyncSession, vault: SequencedVaultClient
) -> None:
    """Idempotent: a second press after a full pass sends nothing."""
    headers, user_id = await _signup(async_client, "vault-sort-idempotent")
    await _vault_bound(db_session, user_id)
    await _entries(db_session, user_id=user_id, count=_BACKLOG, vault_ref="already-there")

    assert await _pending(async_client, headers) == 0
    body = await _sort(async_client, headers)

    assert body == {"entries_pending": 0, "entries_sorted": 0, "entries_remaining": 0}
    assert vault.ingest_calls == []


@pytest.mark.asyncio
async def test_no_standing_consent_sends_nothing(
    async_client: AsyncClient, db_session: AsyncSession, vault: SequencedVaultClient
) -> None:
    """The same gate as the app-side sweep: a sort runs under a decision already given."""
    headers, user_id = await _signup(async_client, "vault-sort-no-consent")
    await _vault_bound(db_session, user_id, consent=False)
    await _entries(db_session, user_id=user_id, count=_BACKLOG)

    body = await _sort(async_client, headers)

    assert body == {
        "entries_pending": _BACKLOG,
        "entries_sorted": 0,
        "entries_remaining": _BACKLOG,
    }
    assert vault.ingest_calls == []


@pytest.mark.asyncio
async def test_intimate_writing_is_neither_counted_nor_sent(
    async_client: AsyncClient, db_session: AsyncSession, vault: SequencedVaultClient
) -> None:
    """Intimate entries never leave the deployment, so they are never "unsorted" either."""
    headers, user_id = await _signup(async_client, "vault-sort-intimate")
    await _vault_bound(db_session, user_id)
    await _entries(db_session, user_id=user_id, count=_BACKLOG, tier=JournalClassification.INTIMATE)

    assert await _pending(async_client, headers) == 0
    await _sort(async_client, headers)

    assert vault.ingest_calls == []


class _DownVault(SequencedVaultClient):
    """A vault whose handshake answers unavailable, as the real client degrades one.

    ``outage`` is how many probes fail before it answers again; ``None`` (the
    default) is a vault that never comes back. A managed vault shedding load
    (Creek's concurrency limit, ``503 temporarily_unavailable``) looks like the
    first: unavailable for a moment, then fine.
    """

    def __init__(self, outage: int | None = None) -> None:
        """Start with no probes counted."""
        super().__init__()
        self.handshakes = 0
        self._outage = outage
        self._available = False

    async def handshake(self) -> HandshakeResult:
        """Count the probe; fail it while the outage lasts, never raising."""
        self.handshakes += 1
        self._available = self._outage is not None and self.handshakes > self._outage
        if not self._available:
            return HandshakeResult.unavailable()
        return await super().handshake()

    def is_available(self) -> bool:
        """Report what the last handshake found, as the cached handshake would."""
        return self._available


@pytest.mark.asyncio
async def test_a_vault_that_cannot_take_writing_stops_the_pass(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A vault that stays down through every retry is a fact about the vault: stop."""
    down = _DownVault()
    app.dependency_overrides[get_creek_vault_client] = lambda: down
    try:
        headers, user_id = await _signup(async_client, "vault-sort-down")
        await _vault_bound(db_session, user_id)
        await _entries(db_session, user_id=user_id, count=_BACKLOG)

        body = await _sort(async_client, headers)
    finally:
        app.dependency_overrides.pop(get_creek_vault_client, None)

    assert body["entries_sorted"] == 0
    assert body["entries_remaining"] == _BACKLOG
    assert down.ingest_calls == []
    assert down.handshakes == 1 + len(corpus_sort_run.VAULT_RETRY_DELAYS_SECONDS)


@pytest.mark.asyncio
async def test_one_entry_the_vault_dropped_stays_pending_and_the_rest_go(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A dropped write is about that entry: it waits for the next pass, the others are sent."""
    flaky = SequencedVaultClient(ingest_error=CreekVaultUnavailableError("blip"))
    app.dependency_overrides[get_creek_vault_client] = lambda: flaky
    try:
        headers, user_id = await _signup(async_client, "vault-sort-flaky")
        await _vault_bound(db_session, user_id)
        await _entries(db_session, user_id=user_id, count=_BACKLOG)

        body = await _sort(async_client, headers)
    finally:
        app.dependency_overrides.pop(get_creek_vault_client, None)

    assert len(flaky.ingest_calls) == _BACKLOG
    assert body == {
        "entries_pending": _BACKLOG,
        "entries_sorted": 0,
        "entries_remaining": _BACKLOG,
    }


@pytest.mark.asyncio
async def test_one_press_walks_every_batch_to_the_end(
    async_client: AsyncClient,
    db_session: AsyncSession,
    vault: SequencedVaultClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No ceiling on a press: the run reads batch after batch until nothing is left."""
    monkeypatch.setattr(corpus_sort_run, "SORT_BATCH_SIZE", _SMALL_BATCH)
    headers, user_id = await _signup(async_client, "vault-sort-batches")
    await _vault_bound(db_session, user_id)
    await _entries(db_session, user_id=user_id, count=_BACKLOG)

    body = await _sort(async_client, headers)

    assert body == {"entries_pending": 0, "entries_sorted": _BACKLOG, "entries_remaining": 0}
    assert len(vault.ingest_calls) == _BACKLOG


@pytest.mark.asyncio
async def test_one_accounts_sort_never_sends_anothers_writing(
    async_client: AsyncClient, db_session: AsyncSession, vault: SequencedVaultClient
) -> None:
    """Scoped by the token: another account's unsent writing stays where it is."""
    headers, user_id = await _signup(async_client, "vault-sort-mine")
    _, other_id = await _signup(async_client, "vault-sort-theirs")
    await _vault_bound(db_session, user_id)
    await _vault_bound(db_session, other_id)
    await _entries(db_session, user_id=other_id, count=_BACKLOG)

    assert await _pending(async_client, headers) == 0
    await _sort(async_client, headers)

    assert vault.ingest_calls == []
    assert await _vault_refs(db_session, other_id) == [None] * _BACKLOG
