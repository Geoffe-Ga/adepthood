"""The one egress predicate: an allowlist of tiers, failing closed on everything else (#3059).

Every model, index and vault sink decides eligibility through
:mod:`domain.privacy_tier`. These tests pin the allowlist itself, the drift
between it and the two older tier maps (the corpus CHECK and the vault ceiling
map), and the SQL form the query-side sinks use.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.creek_vault import VaultTierCeiling, tier_ceiling_for
from domain.privacy_tier import (
    DENIED_TIERS,
    EGRESS_ELIGIBLE_TIERS,
    admits_egress,
    egress_denied_clause,
    egress_eligible_clause,
)
from models.corpus_fragment import EXCLUDED_TIER, RETRIEVABLE_TIERS
from models.journal_entry import JournalClassification, JournalEntry
from models.user import User


@pytest.mark.parametrize(
    ("classification", "expected"),
    [
        ("public", True),
        ("personal", True),
        (JournalClassification.PUBLIC, True),
        (JournalClassification.PERSONAL, True),
        ("intimate", False),
        (JournalClassification.INTIMATE, False),
        ("INTIMATE", False),
        ("Personal", False),
        ("", False),
        ("secret", False),
        (" personal", False),
        (None, False),
        (0, False),
        (b"personal", False),
    ],
)
def test_admits_egress_allowlist_only(classification: object, *, expected: bool) -> None:
    """Only an exact allowlisted spelling egresses; every other value is denied."""
    assert admits_egress(classification) is expected


def test_every_classification_member_is_placed_exactly_once() -> None:
    """A new tier must be placed deliberately; until then it is in neither set and denied."""
    allowed = set(EGRESS_ELIGIBLE_TIERS)

    assert allowed.isdisjoint(DENIED_TIERS)
    assert allowed | DENIED_TIERS == {member.value for member in JournalClassification}
    assert len(EGRESS_ELIGIBLE_TIERS) == len(allowed)


def test_eligible_tiers_are_a_sorted_tuple_for_deterministic_sql() -> None:
    """A frozenset would bind in hash order, so the rendered SQL would vary by process."""
    assert isinstance(EGRESS_ELIGIBLE_TIERS, tuple)
    assert list(EGRESS_ELIGIBLE_TIERS) == sorted(EGRESS_ELIGIBLE_TIERS)


def test_egress_policy_agrees_with_corpus_and_vault_maps() -> None:
    """The corpus CHECK, the vault ceiling map and the egress policy cannot diverge."""
    assert {tier.value for tier in RETRIEVABLE_TIERS} == set(EGRESS_ELIGIBLE_TIERS)
    assert EXCLUDED_TIER.value in DENIED_TIERS
    for tier in EGRESS_ELIGIBLE_TIERS:
        assert tier_ceiling_for(tier) is not VaultTierCeiling.INTIMATE
    for tier in DENIED_TIERS:
        assert tier_ceiling_for(tier) is VaultTierCeiling.INTIMATE


def test_egress_clauses_render_a_fixed_allowlist() -> None:
    """The literal-bound SQL names the allowlist in sorted order, and the denial is its negation."""
    eligible = str(
        egress_eligible_clause(col(JournalEntry.classification)).compile(
            compile_kwargs={"literal_binds": True}
        )
    )
    denied = str(
        egress_denied_clause(col(JournalEntry.classification)).compile(
            compile_kwargs={"literal_binds": True}
        )
    )

    assert "IN ('personal', 'public')" in eligible
    assert "NOT IN ('personal', 'public')" in denied
    assert "IS NULL" in denied


@pytest.mark.asyncio
async def test_egress_clauses_partition_stored_rows(db_session: AsyncSession) -> None:
    """Against a real table the eligible clause selects public+personal, the denied one the rest."""
    user = User(email="tier-clause@example.com", password_hash="x")  # pragma: allowlist secret
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)
    assert user.id is not None
    for tier in JournalClassification:
        db_session.add(
            JournalEntry(
                user_id=user.id,
                message=f"body {tier.value}",
                sender="user",
                classification=tier,
                timestamp=datetime.now(UTC),
            )
        )
    await db_session.commit()

    eligible = await db_session.execute(
        select(JournalEntry.classification).where(
            JournalEntry.user_id == user.id,
            egress_eligible_clause(col(JournalEntry.classification)),
        )
    )
    denied = await db_session.execute(
        select(JournalEntry.classification).where(
            JournalEntry.user_id == user.id,
            egress_denied_clause(col(JournalEntry.classification)),
        )
    )

    assert sorted(eligible.scalars().all()) == ["personal", "public"]
    assert list(denied.scalars().all()) == ["intimate"]
