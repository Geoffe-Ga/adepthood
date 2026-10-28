"""``GET /vault/connection`` says when the writer's key was refused by their provider.

The fact is read from the account's latest *settled* classification row: a
``failed`` run carrying Creek 0.26's ``request_key_rejected`` code turns it on,
and any later run that settles turns it off. A run still in flight changes
nothing, because it has not answered yet. Content-free by construction: one
boolean, read from a closed token on the caller's own rows only.
"""

from __future__ import annotations

from http import HTTPStatus
from typing import Final

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from domain.creek_vault import VaultPipelineStage
from models.vault_pipeline_run import VaultPipelineOutcome, VaultPipelineRun

_CONNECTION_PATH: Final = "/vault/connection"
_PASSWORD: Final = "secret12345"  # pragma: allowlist secret
_REJECTED: Final = "request_key_rejected"
_FIELD: Final = "classification_key_rejected"


async def _signup(client: AsyncClient, name: str) -> tuple[dict[str, str], int]:
    """A fresh account's auth header and id."""
    response = await client.post(
        "/auth/signup", json={"email": f"{name}@example.com", "password": _PASSWORD}
    )
    assert response.status_code == HTTPStatus.OK
    body = response.json()
    return {"Authorization": f"Bearer {body['token']}"}, int(body["user_id"])


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


async def _rejected(client: AsyncClient, headers: dict[str, str]) -> object:
    """The field as the caller reads it."""
    response = await client.get(_CONNECTION_PATH, headers=headers)
    assert response.status_code == HTTPStatus.OK
    return response.json()[_FIELD]


@pytest.mark.asyncio
async def test_an_account_with_no_classification_reads_false(async_client: AsyncClient) -> None:
    """Nothing ran, so nothing was refused."""
    headers, _ = await _signup(async_client, "no-runs")
    assert await _rejected(async_client, headers) is False


@pytest.mark.asyncio
async def test_a_rejected_key_reads_true_until_a_later_run_settles(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """On after the refusal, unmoved by work in flight, off once a pass lands."""
    headers, user_id = await _signup(async_client, "rejected")
    await _row(db_session, user_id, VaultPipelineOutcome.COMPLETED)
    await _row(db_session, user_id, VaultPipelineOutcome.FAILED, failure_code=_REJECTED)
    assert await _rejected(async_client, headers) is True

    await _row(
        db_session, user_id, VaultPipelineOutcome.COMPLETED, stage=VaultPipelineStage.TEMPORAL
    )
    await _row(db_session, user_id, VaultPipelineOutcome.ATTEMPTED)
    assert await _rejected(async_client, headers) is True

    await _row(db_session, user_id, VaultPipelineOutcome.INCOMPLETE)
    assert await _rejected(async_client, headers) is False


@pytest.mark.asyncio
async def test_a_failure_without_a_named_reason_is_not_a_rejected_key(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An outage or an older vault's bare failure says nothing about the key."""
    headers, user_id = await _signup(async_client, "bare-failure")
    await _row(db_session, user_id, VaultPipelineOutcome.FAILED)
    assert await _rejected(async_client, headers) is False


@pytest.mark.asyncio
async def test_another_accounts_rejected_key_never_reaches_this_one(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The read is scoped to the caller's own rows."""
    _, other_id = await _signup(async_client, "other-writer")
    headers, _ = await _signup(async_client, "this-writer")
    await _row(db_session, other_id, VaultPipelineOutcome.FAILED, failure_code=_REJECTED)
    assert await _rejected(async_client, headers) is False
