"""``GET /vault/connection`` says whether the account's vault sorting is finished (#3577).

The state is read from the latest classification row that *landed labels* --
outcome ``completed`` or ``incomplete`` -- so a newer ``failed`` or
``ambiguous`` pass, or one still in flight, never hides what the writing last
had done to it. A rules fallback is persisted ``incomplete`` by
:func:`~services.creek_vault_pipeline_results.classification_outcome`, so it
reads ``incomplete`` here by construction and never ``complete``.

``classification_key_rejected`` (#3595) answers a different question from a
different row -- the latest *settled* one -- and the two are pinned side by side
below so they cannot drift into contradicting each other.

Content-free: an enum and a server-owned sentence, on the caller's own rows only.
"""

from __future__ import annotations

from http import HTTPStatus
from typing import Final

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from dependencies.creek_vault import OWNER_ENV_VAR
from domain.creek_vault import (
    VaultClassificationMethod,
    VaultClassificationPass,
    VaultPipelineStage,
)
from models.vault_pipeline_run import VaultPipelineOutcome, VaultPipelineRun
from schemas.vault_config import VAULT_CLASSIFICATION_MESSAGES, VaultClassificationState
from services.creek_vault_pipeline_results import classification_outcome
from services.user_vault_config import store_vault_config

_CONNECTION_PATH: Final = "/vault/connection"
_PASSWORD: Final = "secret12345"  # pragma: allowlist secret
_VAULT_URL: Final = "https://vault.example.com"
_VAULT_KEY: Final = "vault-key-3577"  # pragma: allowlist secret
_VAULT_URL_ENV: Final = "CREEK_VAULT_URL"
_REJECTED: Final = "request_key_rejected"
_INCOMPLETE_MESSAGE: Final = VAULT_CLASSIFICATION_MESSAGES[VaultClassificationState.INCOMPLETE]


@pytest.fixture(autouse=True)
def _no_deployment_vault(monkeypatch: pytest.MonkeyPatch) -> None:
    """Clear the deployment-wide vault so only what a test sets decides "has a vault".

    A developer's own ``CREEK_VAULT_URL`` naming user 1 as its owner would
    otherwise turn the null cases into ``not_run``.
    """
    monkeypatch.delenv(_VAULT_URL_ENV, raising=False)
    monkeypatch.delenv(OWNER_ENV_VAR, raising=False)


async def _signup(client: AsyncClient, name: str) -> tuple[dict[str, str], int]:
    """A fresh account's auth header and id."""
    response = await client.post(
        "/auth/signup", json={"email": f"{name}@example.com", "password": _PASSWORD}
    )
    assert response.status_code == HTTPStatus.OK
    body = response.json()
    return {"Authorization": f"Bearer {body['token']}"}, int(body["user_id"])


async def _connected(
    client: AsyncClient, session: AsyncSession, name: str
) -> tuple[dict[str, str], int]:
    """A fresh account with its own stored vault connection."""
    headers, user_id = await _signup(client, name)
    await store_vault_config(session, user_id, vault_url=_VAULT_URL, api_key=_VAULT_KEY)
    return headers, user_id


async def _row(
    session: AsyncSession,
    user_id: int,
    outcome: VaultPipelineOutcome,
    *,
    failure_code: str | None = None,
    stage: VaultPipelineStage = VaultPipelineStage.CLASSIFY,
) -> None:
    """Persist one content-free pipeline row for ``user_id``."""
    session.add(
        VaultPipelineRun(
            user_id=user_id,
            stage=stage.value,
            outcome=outcome.value,
            failure_code=failure_code,
            fragments_seen=0,
            fragments_touched=0,
            fragments_lost=0,
        )
    )
    await session.commit()


async def _read(client: AsyncClient, headers: dict[str, str]) -> dict[str, object]:
    """The connection answer as the caller reads it."""
    response = await client.get(_CONNECTION_PATH, headers=headers)
    assert response.status_code == HTTPStatus.OK
    body: dict[str, object] = response.json()
    return body


def _state(body: dict[str, object]) -> tuple[object, object]:
    """The two fields this module is about."""
    return body["classification_state"], body["classification_message"]


def test_only_incomplete_carries_a_sentence_and_it_is_calm() -> None:
    """The server owns one sentence, for ``incomplete`` alone, and it asks nothing."""
    assert VAULT_CLASSIFICATION_MESSAGES[VaultClassificationState.COMPLETE] is None
    assert VAULT_CLASSIFICATION_MESSAGES[VaultClassificationState.NOT_RUN] is None
    assert isinstance(_INCOMPLETE_MESSAGE, str)
    assert "Nothing is waiting on you." in _INCOMPLETE_MESSAGE
    assert not any(character.isdigit() for character in _INCOMPLETE_MESSAGE)
    assert set(VAULT_CLASSIFICATION_MESSAGES) == set(VaultClassificationState)


@pytest.mark.asyncio
async def test_an_account_with_no_vault_reads_null(async_client: AsyncClient) -> None:
    """Nothing connected: there is no vault for a sort to be about."""
    headers, _ = await _signup(async_client, "cs-no-vault")
    body = await _read(async_client, headers)
    assert body["connected"] is False
    assert _state(body) == (None, None)


@pytest.mark.asyncio
async def test_a_disconnected_account_with_old_rows_still_reads_null(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Rows left from a vault since removed say nothing about a vault that is not there."""
    headers, user_id = await _signup(async_client, "cs-disconnected")
    await _row(db_session, user_id, VaultPipelineOutcome.INCOMPLETE)
    assert _state(await _read(async_client, headers)) == (None, None)


@pytest.mark.asyncio
async def test_a_connected_vault_with_nothing_landed_reads_not_run(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """In flight, failed and ambiguous passes landed no labels, so nothing has run."""
    headers, user_id = await _connected(async_client, db_session, "cs-not-run")
    assert _state(await _read(async_client, headers)) == ("not_run", None)

    for outcome in (
        VaultPipelineOutcome.FAILED,
        VaultPipelineOutcome.AMBIGUOUS,
        VaultPipelineOutcome.ATTEMPTED,
    ):
        await _row(db_session, user_id, outcome)
    await _row(
        db_session, user_id, VaultPipelineOutcome.COMPLETED, stage=VaultPipelineStage.TEMPORAL
    )
    assert _state(await _read(async_client, headers)) == ("not_run", None)


@pytest.mark.asyncio
async def test_a_completed_pass_reads_complete_with_no_sentence(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A finished semantic pass is the norm, and the norm says nothing."""
    headers, user_id = await _connected(async_client, db_session, "cs-complete")
    await _row(db_session, user_id, VaultPipelineOutcome.COMPLETED)
    assert _state(await _read(async_client, headers)) == ("complete", None)


@pytest.mark.asyncio
async def test_a_partial_pass_reads_incomplete_with_the_servers_sentence(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A pass that skipped fragments is not finished, and says so in the server's words."""
    headers, user_id = await _connected(async_client, db_session, "cs-partial")
    await _row(db_session, user_id, VaultPipelineOutcome.COMPLETED)
    await _row(db_session, user_id, VaultPipelineOutcome.INCOMPLETE)
    assert _state(await _read(async_client, headers)) == ("incomplete", _INCOMPLETE_MESSAGE)


@pytest.mark.asyncio
async def test_a_finished_rules_fallback_reads_incomplete_never_complete(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``method == rules, complete == true`` is persisted incomplete, so it reads incomplete."""
    headers, user_id = await _connected(async_client, db_session, "cs-rules")
    rules_floor = VaultClassificationPass(
        total=3,
        classified=3,
        preserved_manual=0,
        preserved_llm=0,
        privacy_tiers_assigned=0,
        retiered=0,
        praxis_marked=0,
        tags_extracted=0,
        complete=True,
        method=VaultClassificationMethod.RULES,
    )
    await _row(db_session, user_id, classification_outcome(rules_floor))
    assert _state(await _read(async_client, headers)) == ("incomplete", _INCOMPLETE_MESSAGE)


@pytest.mark.asyncio
async def test_a_newer_failure_does_not_mask_an_older_landed_pass(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The two fields read two different rows, and both are true at once.

    The rough sort really happened (``incomplete``) and the pass after it really
    was refused for the writer's key (``classification_key_rejected``). Neither
    field hides the other; a later completed pass clears both.
    """
    headers, user_id = await _connected(async_client, db_session, "cs-masked")
    await _row(db_session, user_id, VaultPipelineOutcome.INCOMPLETE)
    await _row(db_session, user_id, VaultPipelineOutcome.FAILED, failure_code=_REJECTED)
    await _row(db_session, user_id, VaultPipelineOutcome.AMBIGUOUS)
    body = await _read(async_client, headers)
    assert _state(body) == ("incomplete", _INCOMPLETE_MESSAGE)
    assert body["classification_key_rejected"] is False

    await _row(db_session, user_id, VaultPipelineOutcome.FAILED, failure_code=_REJECTED)
    body = await _read(async_client, headers)
    assert _state(body) == ("incomplete", _INCOMPLETE_MESSAGE)
    assert body["classification_key_rejected"] is True

    await _row(db_session, user_id, VaultPipelineOutcome.COMPLETED)
    body = await _read(async_client, headers)
    assert _state(body) == ("complete", None)
    assert body["classification_key_rejected"] is False


@pytest.mark.asyncio
async def test_another_accounts_rows_never_reach_this_one(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The read is scoped to the caller's own rows, in both directions."""
    other_headers, other_id = await _connected(async_client, db_session, "cs-other")
    headers, user_id = await _connected(async_client, db_session, "cs-this")
    await _row(db_session, other_id, VaultPipelineOutcome.INCOMPLETE)
    assert _state(await _read(async_client, headers)) == ("not_run", None)

    await _row(db_session, user_id, VaultPipelineOutcome.COMPLETED)
    assert _state(await _read(async_client, headers)) == ("complete", None)
    assert _state(await _read(async_client, other_headers)) == ("incomplete", _INCOMPLETE_MESSAGE)


@pytest.mark.asyncio
async def test_the_deployment_vaults_owner_reads_a_state_though_not_connected(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The deployment-wide vault's owner has no connection row, yet their writing is sorted.

    ``connected`` stays false for them, as it always has; the sort state follows
    the vault the pipeline actually writes to, as ``classification_key_rejected``
    does (#3595). Anybody else on the same deployment still reads null.
    """
    headers, user_id = await _signup(async_client, "cs-deploy-owner")
    stranger_headers, stranger_id = await _signup(async_client, "cs-deploy-stranger")
    monkeypatch.setenv(_VAULT_URL_ENV, _VAULT_URL)
    monkeypatch.setenv(OWNER_ENV_VAR, str(user_id))
    assert _state(await _read(async_client, headers)) == ("not_run", None)

    await _row(db_session, user_id, VaultPipelineOutcome.INCOMPLETE)
    await _row(db_session, stranger_id, VaultPipelineOutcome.INCOMPLETE)
    body = await _read(async_client, headers)
    assert body["connected"] is False
    assert _state(body) == ("incomplete", _INCOMPLETE_MESSAGE)
    assert _state(await _read(async_client, stranger_headers)) == (None, None)


@pytest.mark.asyncio
async def test_connecting_answers_the_state_in_the_same_reply(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``PUT`` returns the same shape, so a screen that just connected need not re-read."""
    headers, user_id = await _signup(async_client, "cs-put")
    await _row(db_session, user_id, VaultPipelineOutcome.INCOMPLETE)
    monkeypatch.setattr(
        "routers.vault_config._refuse_a_url_this_endpoint_must_not_store",
        _accept_any_url,
    )
    response = await async_client.put(
        _CONNECTION_PATH, headers=headers, json={"vault_url": _VAULT_URL, "api_key": _VAULT_KEY}
    )
    assert response.status_code == HTTPStatus.OK
    assert _state(response.json()) == ("incomplete", _INCOMPLETE_MESSAGE)


async def _accept_any_url(_session: AsyncSession, _url: str) -> None:
    """Stand in for the URL judgement, which this module is not about."""
