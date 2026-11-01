"""An un-enrolled writer's stored provider key: kept encrypted, used only for their own sorting.

Owner decision R1-1 with the split confirmed on 2026-11-01 (ADR 0009,
"Amendment 2026-11-01"): an un-enrolled account's BYOK key may be stored
server-decryptable, encrypted at rest, so its vault's *background*
classification -- a keyless save, a detached retry, restart recovery -- runs on
the writer's own key instead of the rules floor.

What is pinned here, through the real HTTP adapter against a scripted managed
vault, so the headers asserted are the ones a socket would have carried:

* retention: only at a keyed classification admission, only for a vendor the
  vault advertises, only while at-rest encryption is configured, and only as
  ciphertext;
* use: every background classification submit relays the stored key when the
  vault advertises its vendor, and is keyless otherwise;
* custody: the key is never another account's (IDOR), and it is deleted on
  removal or replacement, vault disconnect, vendor rejection, enrolment and
  account deletion -- each stopping background use at once.

Synthetic throughout: invented keys, no journal content of anyone's.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Iterator, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from http import HTTPStatus
from pathlib import Path
from typing import Any, Final

import httpx
import pytest
import pytest_asyncio
from cryptography.fernet import Fernet
from httpx import AsyncClient
from sqlalchemy import select as core_select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlmodel import select, update

from dependencies.creek_vault import get_creek_vault_client
from domain.creek_vault import CreekVaultPipelineClient, VaultKeyProvider, VaultProviderKey
from main import app
from models.user import User
from models.vault_classification_key import STORED_KEY_PROVIDERS, VaultClassificationKey
from models.vault_pipeline_run import VaultPipelineOutcome, VaultPipelineRun
from services import creek_vault_pipeline as pipeline
from services import journal_encryption
from services.creek_vault_client import HttpCreekVaultClient
from services.creek_vault_pipeline import VaultPipelineTrigger, drive_vault_pipeline
from services.creek_vault_relay import PROVIDER_HEADER, PROVIDER_KEY_HEADER, forwarding_provider_key
from services.encryption_inventory import EncryptedColumn, raw_table
from services.user_vault_config import clear_vault_config
from services.vault_classification_key import retire_on_enrolment

_FIXTURES: Final = Path(__file__).parent.parent / "fixtures"
_VAULT_URL: Final = "https://vault.example.test"
_VAULT_CREDENTIAL: Final = "stored-key-vault-credential"  # pragma: allowlist secret
_WRITER_KEY: Final = "sk-ant-api03-STOREDkeyCANARYforR11writerAAAA"  # pragma: allowlist secret
_OTHER_KEY: Final = "sk-proj-STOREDkeyCANARYforR11otherWriterBBBB"  # pragma: allowlist secret
_REPLACEMENT_KEY: Final = "sk-ant-api03-STOREDkeyCANARYreplacementCCCC"  # pragma: allowlist secret
_CLASSIFICATIONS: Final = "/v1/classifications"
_JOBS: Final = "/v1/jobs/"
_JOURNAL_ENTRIES: Final = "/v1/journal-entries/"
_JOB_ID: Final = "55555555-5555-4555-8555-555555555555"
_PASSWORD: Final = "secret12345"  # pragma: allowlist secret
_UNUSED_HASH: Final = "not-a-real-hash"  # pragma: allowlist secret
_FAST: Final = 0.001
_WRITER: Final = 1
_NEIGHBOUR: Final = 2
_KEY_COLUMN: Final = EncryptedColumn("vaultclassificationkey", "api_key")
#: Older than every stage's stand-down, so a second pass finds classification due.
_EARLIER_PASS_AGE: Final = timedelta(days=1)
_DELETE_PATH: Final = "/user/vault-classification-key"

_CLASSIFIED: Final[Mapping[str, object]] = {
    "status": "ok",
    "tier_ceiling": "personal",
    "method": "llm",
    "total": 1,
    "classified": 1,
    "preserved_manual": 0,
    "preserved_llm": 0,
    "privacy_tiers_assigned": 0,
    "retiered": 0,
    "praxis_marked": 0,
    "tags_extracted": 1,
    "complete": True,
}


def _capabilities(providers: tuple[str, ...]) -> dict[str, Any]:
    """The published 0.26 handshake, advertising exactly ``providers``."""
    path = _FIXTURES / "creek_jobs_v026" / "examples" / "capabilities" / "success.json"
    loaded: dict[str, Any] = json.loads(path.read_bytes())
    loaded["request_key_providers"] = list(providers)
    return loaded


@dataclass
class _Vault:
    """A scripted managed vault that records the writer's-key headers on every send."""

    providers: tuple[str, ...] = ("anthropic", "openai")
    #: ``ok`` answers counts; ``unavailable`` refuses with 503; ``rejected``
    #: admits a job whose vendor turns the key down (contract 0.26).
    classify: str = "ok"
    sends: list[tuple[str, str | None, str | None]] = field(default_factory=list)

    def classification_keys(self) -> list[str | None]:
        """The key each classification submit carried, in order."""
        return [key for path, _vendor, key in self.sends if path == _CLASSIFICATIONS]

    def keys_seen(self) -> set[str]:
        """Every key any send carried."""
        return {key for _path, _vendor, key in self.sends if key is not None}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Answer one send as a managed vault would."""
        path = request.url.path
        self.sends.append(
            (path, request.headers.get(PROVIDER_HEADER), request.headers.get(PROVIDER_KEY_HEADER))
        )
        if path == "/v1/capabilities":
            return httpx.Response(HTTPStatus.OK, json=_capabilities(self.providers))
        if path == _CLASSIFICATIONS:
            return self._classify()
        if path.startswith(_JOURNAL_ENTRIES):
            return httpx.Response(
                HTTPStatus.OK,
                json={
                    "status": "ok",
                    "action": "created",
                    "external_id": path.removeprefix(_JOURNAL_ENTRIES),
                    "fragment_id": "frag-journal-1",
                    "tier": json.loads(request.content)["tier"],
                    "tier_ceiling": "personal",
                },
            )
        if path.startswith(_JOBS):
            return httpx.Response(
                HTTPStatus.OK,
                json={
                    "status": "ok",
                    "job_id": _JOB_ID,
                    "state": "failed",
                    "result": None,
                    "failure_code": "request_key_rejected",
                },
            )
        return httpx.Response(
            HTTPStatus.OK,
            json={
                "status": "ok",
                "tier_ceiling": "personal",
                "method": json.loads(request.content)["method"],
                "fragment_count": 1,
                "link_count": 1,
                "largest_cluster_fragments": 1,
                "clusters_split": 0,
                "oversized_discarded": 0,
            },
        )

    def _classify(self) -> httpx.Response:
        if self.classify == "unavailable":
            return httpx.Response(
                HTTPStatus.SERVICE_UNAVAILABLE,
                json={"code": "unavailable", "message": "no", "request_id": "req-1"},
            )
        if self.classify == "rejected":
            return httpx.Response(
                HTTPStatus.ACCEPTED,
                json={"status": "accepted", "job_id": _JOB_ID, "state": "queued"},
            )
        return httpx.Response(HTTPStatus.OK, json=dict(_CLASSIFIED))


@pytest.fixture
def _encrypted(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Configure a throwaway at-rest key; retention refuses to run without one."""
    monkeypatch.setenv(journal_encryption.KEYS_ENV_VAR, Fernet.generate_key().decode())
    journal_encryption.reset_cache()
    yield
    journal_encryption.reset_cache()


@pytest.fixture(autouse=True)
def _fast_clocks(monkeypatch: pytest.MonkeyPatch) -> None:
    """Shrink polling and retry backoff so background work finishes inside the test."""
    monkeypatch.setattr(pipeline, "_JOB_POLL_INITIAL_SECONDS", _FAST)
    monkeypatch.setattr(pipeline, "_RETRY_INITIAL_SECONDS", _FAST)


@pytest_asyncio.fixture
async def _accounts(db_session: AsyncSession) -> AsyncIterator[None]:
    """Two accounts: the writer whose key is stored, and a neighbour on the same deployment."""
    for user_id in (_WRITER, _NEIGHBOUR):
        db_session.add(
            User(id=user_id, email=f"stored-key-{user_id}@example.com", password_hash=_UNUSED_HASH)
        )
    await db_session.commit()
    await pipeline.close_vault_pipeline_tasks()
    yield
    await pipeline.close_vault_pipeline_tasks()


def _key(secret: str = _WRITER_KEY) -> VaultProviderKey:
    vendor = (
        VaultKeyProvider.OPENAI if secret.startswith("sk-proj-") else VaultKeyProvider.ANTHROPIC
    )
    return VaultProviderKey(provider=vendor, _secret=secret)


async def _drive(
    session: AsyncSession,
    vault: _Vault,
    *,
    user_id: int = _WRITER,
    request_key: VaultProviderKey | None = None,
) -> None:
    """One journal write's pass for ``user_id``, then whatever it left running in the background."""
    async with httpx.AsyncClient(transport=httpx.MockTransport(vault)) as http:
        client = HttpCreekVaultClient(_VAULT_URL, _VAULT_CREDENTIAL, http_client=http)
        await client.handshake()
        if request_key is None:
            await drive_vault_pipeline(
                session, client, user_id=user_id, trigger=VaultPipelineTrigger.JOURNAL_WRITE
            )
        else:
            with forwarding_provider_key(request_key):
                await drive_vault_pipeline(
                    session, client, user_id=user_id, trigger=VaultPipelineTrigger.JOURNAL_WRITE
                )
        await pipeline.wait_for_vault_pipeline_tasks()


async def _age_passes(session: AsyncSession) -> None:
    """Move every earlier pass out of its stand-down so the next write is due again."""
    await session.execute(
        update(VaultPipelineRun).values(ran_at=datetime.now(UTC) - _EARLIER_PASS_AGE)
    )
    await session.commit()


async def _store(session: AsyncSession, user_id: int, secret: str) -> None:
    """Seed a stored key directly, as an earlier keyed admission would have."""
    session.add(
        VaultClassificationKey(
            user_id=user_id, provider=_key(secret).provider.value, api_key=secret
        )
    )
    await session.commit()


async def _stored_rows(session: AsyncSession) -> dict[int, str]:
    """Every stored key, decrypted, by account -- the ORM read, through the codec."""
    session.expire_all()
    result = await session.execute(select(VaultClassificationKey))
    return {row.user_id: row.api_key for row in result.scalars().all()}


async def _raw_column(session: AsyncSession) -> list[str]:
    """The stored bytes of the key column, read past the codec."""
    target = raw_table(_KEY_COLUMN)
    result = await session.execute(core_select(target.c[_KEY_COLUMN.column]))
    return [str(value) for value in result.scalars().all()]


# ── Retention ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.usefixtures("_encrypted", "_accounts")
async def test_a_keyed_admission_keeps_the_key_as_ciphertext_only(db_session: AsyncSession) -> None:
    """The relayed key is kept, encrypted: the column decrypts to it and never holds it."""
    vault = _Vault()

    await _drive(db_session, vault, request_key=_key())

    assert vault.classification_keys() == [_WRITER_KEY]
    assert await _stored_rows(db_session) == {_WRITER: _WRITER_KEY}
    raw = await _raw_column(db_session)
    assert len(raw) == 1
    assert journal_encryption.is_ciphertext(raw[0])
    assert _WRITER_KEY not in raw[0]
    assert _WRITER_KEY[-12:] not in raw[0]


@pytest.mark.asyncio
@pytest.mark.usefixtures("_accounts")
async def test_no_key_is_kept_while_at_rest_encryption_is_off(db_session: AsyncSession) -> None:
    """Without a configured key the column could only hold plaintext, so nothing is written."""
    vault = _Vault()

    await _drive(db_session, vault, request_key=_key())

    assert vault.classification_keys() == [_WRITER_KEY]
    assert await _stored_rows(db_session) == {}


@pytest.mark.asyncio
@pytest.mark.usefixtures("_encrypted", "_accounts")
async def test_a_vendor_the_vault_does_not_advertise_is_never_kept(
    db_session: AsyncSession,
) -> None:
    """A key the vault would not spend is not sent and not stored."""
    vault = _Vault(providers=("openai",))

    await _drive(db_session, vault, request_key=_key())

    assert vault.keys_seen() == set()
    assert await _stored_rows(db_session) == {}


@pytest.mark.asyncio
@pytest.mark.usefixtures("_encrypted", "_accounts")
async def test_a_different_relayed_key_replaces_the_stored_copy(db_session: AsyncSession) -> None:
    """Replacement overwrites the one row; the old key is gone, not kept beside it."""
    await _store(db_session, _WRITER, _WRITER_KEY)

    await _drive(db_session, _Vault(), request_key=_key(_REPLACEMENT_KEY))

    assert await _stored_rows(db_session) == {_WRITER: _REPLACEMENT_KEY}


@pytest.mark.asyncio
@pytest.mark.usefixtures("_encrypted", "_accounts")
async def test_a_copy_under_a_retired_encryption_key_is_skipped_then_replaced(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An undecryptable copy never fails a submit: it goes keyless; the next relay replaces it."""
    await _store(db_session, _WRITER, _WRITER_KEY)
    monkeypatch.setenv(journal_encryption.KEYS_ENV_VAR, Fernet.generate_key().decode())
    journal_encryption.reset_cache()
    db_session.expire_all()
    keyless = _Vault()

    await _drive(db_session, keyless)

    assert keyless.classification_keys() == [None]
    await _age_passes(db_session)
    await _drive(db_session, _Vault(), request_key=_key(_REPLACEMENT_KEY))
    assert await _stored_rows(db_session) == {_WRITER: _REPLACEMENT_KEY}


# ── Use ──────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.usefixtures("_encrypted", "_accounts")
async def test_a_keyless_save_classifies_with_the_stored_key(db_session: AsyncSession) -> None:
    """The scheduler's submit relays the stored key when its request carries none."""
    await _store(db_session, _WRITER, _WRITER_KEY)
    vault = _Vault()

    await _drive(db_session, vault)

    assert vault.classification_keys() == [_WRITER_KEY]
    # Only the classification submit carries it: no linker stage, no poll.
    assert {path for path, _vendor, key in vault.sends if key} == {_CLASSIFICATIONS}


@pytest.mark.asyncio
@pytest.mark.usefixtures("_encrypted", "_accounts")
async def test_a_stored_key_the_vault_does_not_advertise_stays_home(
    db_session: AsyncSession,
) -> None:
    """Use is gated on the vault's handshake, exactly as a request key is."""
    await _store(db_session, _WRITER, _WRITER_KEY)
    vault = _Vault(providers=("openai",))

    await _drive(db_session, vault)

    assert vault.classification_keys() == [None]
    assert vault.keys_seen() == set()


@pytest.mark.asyncio
@pytest.mark.usefixtures("_encrypted", "_accounts")
async def test_detached_retries_after_the_request_use_the_stored_key(
    db_session: AsyncSession,
) -> None:
    """Every bounded retry the continuation makes off-request is keyed, not just the first send."""
    vault = _Vault(classify="unavailable")

    await _drive(db_session, vault, request_key=_key())

    keys = vault.classification_keys()
    # The first send is the request's own; every later one is a detached retry.
    assert len(keys) > 1
    assert set(keys) == {_WRITER_KEY}


@pytest.mark.asyncio
@pytest.mark.usefixtures("_encrypted", "_accounts")
async def test_restart_recovery_submits_queued_classification_with_the_stored_key(
    db_session: AsyncSession,
) -> None:
    """A queued pass resumed at boot -- no request anywhere -- runs on the writer's key."""
    await _store(db_session, _WRITER, _WRITER_KEY)
    db_session.add(
        VaultPipelineRun(
            user_id=_WRITER,
            stage="classify",
            trigger=VaultPipelineTrigger.JOURNAL_WRITE.value,
            outcome=VaultPipelineOutcome.QUEUED.value,
            attempt_count=0,
            fragments_seen=0,
            fragments_touched=0,
            fragments_lost=0,
        )
    )
    await db_session.commit()
    vault = _Vault()
    factory = async_sessionmaker(db_session.bind, class_=AsyncSession, expire_on_commit=False)

    async with httpx.AsyncClient(transport=httpx.MockTransport(vault)) as http:
        client = HttpCreekVaultClient(_VAULT_URL, _VAULT_CREDENTIAL, http_client=http)

        async def _resolve(_session: AsyncSession, _user_id: int) -> CreekVaultPipelineClient:
            return client

        await pipeline.resume_vault_pipeline_runs(factory, _resolve)
        await pipeline.wait_for_vault_pipeline_tasks()

    assert vault.classification_keys() == [_WRITER_KEY]


# ── Custody ──────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.usefixtures("_encrypted", "_accounts")
async def test_idor_a_neighbours_background_classification_never_uses_the_writers_key(
    db_session: AsyncSession,
) -> None:
    """The stored key is read by the run's own account and no other."""
    await _store(db_session, _WRITER, _WRITER_KEY)
    neighbour_vault = _Vault()

    await _drive(db_session, neighbour_vault, user_id=_NEIGHBOUR)

    assert neighbour_vault.classification_keys() == [None]
    assert neighbour_vault.keys_seen() == set()
    assert await _stored_rows(db_session) == {_WRITER: _WRITER_KEY}


@pytest.mark.asyncio
@pytest.mark.usefixtures("_encrypted", "_accounts")
async def test_idor_each_account_classifies_with_only_its_own_stored_key(
    db_session: AsyncSession,
) -> None:
    """Two stored keys, two background passes, no crossing."""
    await _store(db_session, _WRITER, _WRITER_KEY)
    await _store(db_session, _NEIGHBOUR, _OTHER_KEY)
    writer_vault, neighbour_vault = _Vault(), _Vault()

    await _drive(db_session, writer_vault, user_id=_WRITER)
    await _drive(db_session, neighbour_vault, user_id=_NEIGHBOUR)

    assert writer_vault.keys_seen() == {_WRITER_KEY}
    assert neighbour_vault.keys_seen() == {_OTHER_KEY}


@pytest.mark.asyncio
@pytest.mark.usefixtures("_encrypted", "_accounts")
async def test_a_key_the_vendor_rejects_is_deleted_and_not_spent_again(
    db_session: AsyncSession,
) -> None:
    """Contract 0.26 ``request_key_rejected`` ends the run and the stored copy with it."""
    await _store(db_session, _WRITER, _WRITER_KEY)
    rejecting = _Vault(classify="rejected")

    await _drive(db_session, rejecting)

    assert rejecting.classification_keys() == [_WRITER_KEY]
    assert await _stored_rows(db_session) == {}
    await _age_passes(db_session)
    later = _Vault()
    await _drive(db_session, later)
    assert later.classification_keys() == [None]


@pytest.mark.asyncio
@pytest.mark.usefixtures("_encrypted", "_accounts")
async def test_enrolment_deletes_the_stored_key_and_background_goes_keyless(
    db_session: AsyncSession,
) -> None:
    """An enrolled account keeps its key user-held: no server-readable copy survives."""
    await _store(db_session, _WRITER, _WRITER_KEY)

    await retire_on_enrolment(db_session, _WRITER)

    assert await _stored_rows(db_session) == {}
    vault = _Vault()
    await _drive(db_session, vault)
    assert vault.classification_keys() == [None]


@pytest.mark.asyncio
@pytest.mark.usefixtures("_encrypted", "_accounts")
async def test_disconnecting_the_vault_deletes_the_stored_key(db_session: AsyncSession) -> None:
    """The key exists only for that vault's sorting."""
    await _store(db_session, _WRITER, _WRITER_KEY)
    await _store(db_session, _NEIGHBOUR, _OTHER_KEY)

    await clear_vault_config(db_session, _WRITER)

    assert await _stored_rows(db_session) == {_NEIGHBOUR: _OTHER_KEY}


@pytest.mark.asyncio
@pytest.mark.usefixtures("_encrypted")
async def test_the_stored_row_never_renders_its_key(db_session: AsyncSession) -> None:
    """``repr``/``str`` of the row -- a log line, a traceback frame -- redact the key."""
    db_session.add(User(id=_WRITER, email="render@example.com", password_hash=_UNUSED_HASH))
    await db_session.commit()
    await _store(db_session, _WRITER, _WRITER_KEY)
    row = (await db_session.execute(select(VaultClassificationKey))).scalars().one()

    assert _WRITER_KEY not in repr(row)
    assert _WRITER_KEY not in str(row)
    assert _WRITER_KEY not in f"{row}"


def test_the_stored_vendor_vocabulary_is_the_relay_vocabulary() -> None:
    """The column's closed vocabulary is exactly the vendors a vault may be handed."""
    assert set(STORED_KEY_PROVIDERS) == {provider.value for provider in VaultKeyProvider}


# ── The writer's own controls, at the HTTP edge ─────────────────────────────


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int, str]:
    email = f"{username}@example.com"
    response = await client.post("/auth/signup", json={"email": email, "password": _PASSWORD})
    assert response.status_code == HTTPStatus.OK, response.text
    data = response.json()
    return {"Authorization": f"Bearer {data['token']}"}, int(data["user_id"]), email


@pytest.mark.asyncio
@pytest.mark.usefixtures("_encrypted")
async def test_removing_the_key_deletes_only_the_callers_copy_at_once(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``DELETE /user/vault-classification-key`` is the caller's own row, and idempotent."""
    headers, writer_id, _email = await _signup(async_client, "remover")
    _other_headers, other_id, _other_email = await _signup(async_client, "bystander")
    await _store(db_session, writer_id, _WRITER_KEY)
    await _store(db_session, other_id, _OTHER_KEY)

    first = await async_client.delete(_DELETE_PATH, headers=headers)
    again = await async_client.delete(_DELETE_PATH, headers=headers)

    assert first.status_code == HTTPStatus.NO_CONTENT
    assert again.status_code == HTTPStatus.NO_CONTENT
    assert first.content == b""
    assert await _stored_rows(db_session) == {other_id: _OTHER_KEY}


@pytest.mark.asyncio
async def test_removing_the_key_requires_a_signed_in_caller(async_client: AsyncClient) -> None:
    """No anonymous request can delete, or probe for, anybody's stored key."""
    response = await async_client.delete(_DELETE_PATH)

    assert response.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
@pytest.mark.usefixtures("_encrypted")
async def test_removal_stops_background_use_immediately(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The very next background submit after removal is keyless."""
    headers, writer_id, _email = await _signup(async_client, "stopper")
    await _store(db_session, writer_id, _WRITER_KEY)

    response = await async_client.delete(_DELETE_PATH, headers=headers)
    vault = _Vault()
    await _drive(db_session, vault, user_id=writer_id)

    assert response.status_code == HTTPStatus.NO_CONTENT
    assert vault.classification_keys() == [None]


@pytest.mark.asyncio
@pytest.mark.usefixtures("_encrypted")
async def test_account_deletion_deletes_the_stored_key(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The key goes with the account, and a neighbour's stays."""
    headers, writer_id, email = await _signup(async_client, "leaver_with_key")
    _other_headers, other_id, _other_email = await _signup(async_client, "stayer_with_key")
    await _store(db_session, writer_id, _WRITER_KEY)
    await _store(db_session, other_id, _OTHER_KEY)

    response = await async_client.request(
        "DELETE", "/users/me", json={"confirm_email": email}, headers=headers
    )

    assert response.status_code == HTTPStatus.OK, response.text
    assert await _stored_rows(db_session) == {other_id: _OTHER_KEY}


@pytest.mark.asyncio
@pytest.mark.usefixtures("_encrypted")
async def test_a_keyed_journal_save_on_a_managed_vault_keeps_the_key(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The whole path: ``POST /journal/`` with the header stores the key, encrypted."""
    headers, writer_id, _email = await _signup(async_client, "keeper")
    vault = _Vault()
    async with httpx.AsyncClient(transport=httpx.MockTransport(vault)) as http:
        client = HttpCreekVaultClient(
            _VAULT_URL, _VAULT_CREDENTIAL, http_client=http, pin_destination=False
        )
        app.dependency_overrides[get_creek_vault_client] = lambda: client
        try:
            response = await async_client.post(
                "/journal/",
                json={"message": "a synthetic line", "classification": "personal"},
                headers={**headers, "X-LLM-API-Key": _WRITER_KEY},
            )
            await pipeline.wait_for_vault_pipeline_tasks()
        finally:
            app.dependency_overrides.pop(get_creek_vault_client, None)

    assert response.status_code == HTTPStatus.CREATED, response.text
    assert _WRITER_KEY not in response.text
    assert vault.classification_keys() == [_WRITER_KEY]
    assert await _stored_rows(db_session) == {writer_id: _WRITER_KEY}
    assert all(_WRITER_KEY not in value for value in await _raw_column(db_session))
