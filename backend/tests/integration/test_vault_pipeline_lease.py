"""The identical continuation SQL/CAS truth tables on migrated live Postgres."""

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

pytestmark = pytest.mark.integration


@pytest.mark.asyncio
@pytest.mark.parametrize("case", CLAIM_CASES, ids=lambda case: case.name)
async def test_claim_predicate_and_cas(
    pg_session: AsyncSession, case: ClaimCase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Postgres agrees at the cutoff and rejects cross-account or missing targets."""
    await assert_claim_contract(pg_session, case, monkeypatch)


@pytest.mark.asyncio
@pytest.mark.parametrize("case", ANCHOR_CASES, ids=lambda case: case.name)
async def test_later_anchor_predicate_and_cas(
    pg_session: AsyncSession, case: AnchorCase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The migrated dialect preserves anchor ordering and terminal first-entry policy."""
    await assert_anchor_contract(pg_session, case, monkeypatch)
