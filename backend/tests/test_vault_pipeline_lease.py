"""Fast SQLite truth tables for durable continuation ownership."""

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from tests.vault_pipeline_lease_contract import (
    ANCHOR_CASES,
    CLAIM_CASES,
    AnchorCase,
    ClaimCase,
    assert_anchor_contract,
    assert_claim_contract,
)


@pytest.mark.asyncio
@pytest.mark.parametrize("case", CLAIM_CASES, ids=lambda case: case.name)
async def test_claim_predicate_and_cas(
    db_session: AsyncSession, case: ClaimCase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Owner, lifecycle, cutoff and account/run identity control the real UPDATE."""
    await assert_claim_contract(db_session, case, monkeypatch)


@pytest.mark.asyncio
@pytest.mark.parametrize("case", ANCHOR_CASES, ids=lambda case: case.name)
async def test_later_anchor_predicate_and_cas(
    db_session: AsyncSession, case: AnchorCase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Only a later unfinished same-account owner/attempt blocks terminal entry."""
    await assert_anchor_contract(db_session, case, monkeypatch)
