"""The erasure policy must cover the schema, and the sweep must obey it.

Two failure modes are guarded here, and they are different failures.

*The policy going stale.* Somebody adds a model; the deletion keeps returning
200 and quietly leaves the new table untouched. :func:`policy_gaps` is the
detector, and it is exercised on both sides — proven to fire on a schema it
does not cover, and proven silent on the one it does.

*The policy lying.* The policy says a table is erased and the sweep does not
reach it. The end-to-end test below seeds a row into every table the schema
allows, deletes one of two accounts, and then asserts an invariant stated
without reference to the policy at all: afterwards, no row anywhere holds the
deleted account's id in a column pointing at ``user``, and no row anywhere
holds its email address. The bystander's rows are counted before and after, so
a sweep that deleted everything would fail just as loudly as one that deleted
nothing.
"""

from __future__ import annotations

from http import HTTPStatus

import pytest
import pytest_asyncio
import sqlalchemy as sa
from httpx import AsyncClient
from sqlalchemy import Column, ForeignKey, Integer, MetaData, String, Table
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import SQLModel

from domain.account_deletion import (
    POLICY,
    Disposition,
    ondelete_disagreements,
    policy_gaps,
)
from models.goal_group import GoalGroup
from tests.helpers.account_seed import (
    SeedAccount,
    seed_one_row_everywhere,
    seed_shared_tables,
)

_PASSWORD = "securepassword123"  # pragma: allowlist secret

# The single place an erased account's email address is allowed to remain: the
# purchase receipt. It stays because the address is how a paid-for licence or
# token pack is matched to its buyer, so erasing it would confiscate something
# the person paid for. Asserted as an exact set — a second surviving mention is
# a leak, and losing this one is a regression of a different kind.
_EXPECTED_SURVIVING_EMAIL_COLUMNS = {"gumroadsale.email"}

# A synthetic schema large enough for the detectors to have something to say
# and small enough to read: an account table and one table the policy knows.
_KNOWN_CHILD = "habit"


def _miniature_schema(*, ondelete: str = "CASCADE", extra_user_column: bool = False) -> MetaData:
    """A two-table stand-in for the real metadata, so gaps can be injected."""
    metadata = MetaData()
    Table("user", metadata, Column("id", Integer, primary_key=True))
    columns = [
        Column("id", Integer, primary_key=True),
        Column("user_id", Integer, ForeignKey("user.id", ondelete=ondelete)),
    ]
    if extra_user_column:
        columns.append(Column("coach_user_id", Integer, ForeignKey("user.id", ondelete="SET NULL")))
    Table(_KNOWN_CHILD, metadata, *columns)
    return metadata


def test_policy_covers_the_live_schema() -> None:
    """Every table and every user reference in the app's own metadata is policed."""
    assert policy_gaps(SQLModel.metadata) == ()


def test_policy_is_silent_on_a_schema_it_covers() -> None:
    """The quiet side: a covered schema produces no findings."""
    assert policy_gaps(_miniature_schema()) == ()


def test_policy_gap_detector_reports_an_unpoliced_table() -> None:
    """The noisy side: a model nobody wrote a policy for is named."""
    metadata = _miniature_schema()
    Table("sanghamembership", metadata, Column("id", Integer, primary_key=True))

    gaps = policy_gaps(metadata)

    assert any("sanghamembership" in gap for gap in gaps)


def test_policy_gap_detector_reports_an_unpoliced_user_column() -> None:
    """A second reference to ``user`` on an already-policed table is a gap too."""
    gaps = policy_gaps(_miniature_schema(extra_user_column=True))

    assert any("coach_user_id" in gap for gap in gaps)


def test_ondelete_matches_the_policy_across_the_live_schema() -> None:
    """Schema cascades and application policy tell the same story."""
    assert ondelete_disagreements(SQLModel.metadata) == ()


def test_ondelete_disagreement_is_reported() -> None:
    """A cascade that contradicts the policy is named rather than assumed benign."""
    findings = ondelete_disagreements(_miniature_schema(ondelete="SET NULL"))

    assert any("habit.user_id" in finding for finding in findings)


@pytest.mark.asyncio
async def test_a_personal_goal_group_cannot_be_anonymised(db_session: AsyncSession) -> None:
    """Proof the ``goalgroup`` deviation is necessary, not a matter of taste.

    The policy erases personal goal groups even though the column declares
    ``ON DELETE SET NULL``. This is why: nulling the owner of a group that is
    not a shared template violates the check constraint that makes "ownerless"
    mean "community template". Anonymising here would either abort the whole
    deletion or promote a private grouping into a public one.
    """
    group = GoalGroup(name="Mornings", user_id=1, shared_template=False)
    db_session.add(group)
    await db_session.commit()
    groups = SQLModel.metadata.tables["goalgroup"]

    async def orphan_the_group() -> None:
        await db_session.execute(
            sa.update(groups).where(groups.c.id == group.id).values(user_id=None),
        )
        await db_session.commit()

    with pytest.raises(IntegrityError):
        await orphan_the_group()
    await db_session.rollback()


def test_the_deviation_is_explained_where_it_is_declared() -> None:
    """A deviation without a written reason is not allowed to exist."""
    deviating = {name for name, policy in POLICY.items() if policy.ondelete_deviation is not None}

    assert deviating == {"goalgroup"}
    assert POLICY["goalgroup"].ondelete_deviation


# ---------------------------------------------------------------------------
# The end-to-end sweep
# ---------------------------------------------------------------------------


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int, str]:
    """Create an account; return ``(auth headers, user id, email)``."""
    email = f"{username}@example.com"
    resp = await client.post("/auth/signup", json={"email": email, "password": _PASSWORD})
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    return {"Authorization": f"Bearer {body['token']}"}, body["user_id"], email


def _user_reference_columns() -> tuple[tuple[Table, sa.Column[int]], ...]:
    """Every column in the schema that points at ``user.id``."""
    return tuple(
        (table, column)
        for table in SQLModel.metadata.sorted_tables
        for column in table.columns
        if any(fk.column.table.name == "user" for fk in column.foreign_keys)
    )


def _holds_text(column: sa.Column[object]) -> bool:
    """Whether a column stores strings.

    SQLModel's ``AutoString`` refuses to name its Python type, and it is the
    type most text columns in this schema actually use — so a check that only
    recognised :class:`sqlalchemy.String` would quietly scan almost nothing and
    the "no trace of the address" assertion would pass vacuously.
    """
    if isinstance(column.type, String):
        return True
    try:
        return column.type.python_type is str
    except NotImplementedError:
        return True


def _text_columns() -> tuple[tuple[Table, sa.Column[str]], ...]:
    """Every string-ish column, where a stray email address could be hiding."""
    return tuple(
        (table, column)
        for table in SQLModel.metadata.sorted_tables
        for column in table.columns
        if _holds_text(column)
    )


async def _count_where(session: AsyncSession, table: Table, clause: sa.ColumnElement[bool]) -> int:
    """How many rows of ``table`` satisfy ``clause``."""
    result = await session.execute(
        sa.select(sa.func.count()).select_from(table).where(clause),
    )
    return int(result.scalar_one())


async def _references_to(session: AsyncSession, user_id: int) -> dict[str, int]:
    """Row counts, per ``table.column``, still naming ``user_id``."""
    return {
        f"{table.name}.{column.name}": await _count_where(session, table, column == user_id)
        for table, column in _user_reference_columns()
    }


async def _rows_mentioning(session: AsyncSession, email: str) -> dict[str, int]:
    """Row counts, per ``table.column``, whose text equals ``email``."""
    return {
        f"{table.name}.{column.name}": await _count_where(session, table, column == email)
        for table, column in _text_columns()
    }


@pytest_asyncio.fixture
async def seeded_pair(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> tuple[dict[str, str], SeedAccount, SeedAccount]:
    """Two fully-populated accounts: one to delete, one that must survive."""
    shared_ids = await seed_shared_tables(db_session)
    doomed_headers, doomed_id, doomed_email = await _signup(async_client, "doomed")
    _, bystander_id, bystander_email = await _signup(async_client, "bystander")
    doomed = SeedAccount(user_id=doomed_id, email=doomed_email)
    bystander = SeedAccount(user_id=bystander_id, email=bystander_email)
    await seed_one_row_everywhere(db_session, doomed, shared_ids)
    await seed_one_row_everywhere(db_session, bystander, shared_ids)
    return doomed_headers, doomed, bystander


@pytest.mark.asyncio
async def test_seeding_reaches_every_user_reference(
    db_session: AsyncSession,
    seeded_pair: tuple[dict[str, str], SeedAccount, SeedAccount],
) -> None:
    """The fixture must actually populate every reference, or the sweep proves nothing."""
    _, doomed, _ = seeded_pair

    before = await _references_to(db_session, doomed.user_id)

    unpopulated = sorted(name for name, count in before.items() if count == 0)
    assert unpopulated == [], f"seeder left references empty: {unpopulated}"


@pytest.mark.asyncio
async def test_deletion_leaves_no_reference_to_the_erased_account(
    async_client: AsyncClient,
    db_session: AsyncSession,
    seeded_pair: tuple[dict[str, str], SeedAccount, SeedAccount],
) -> None:
    """No column pointing at ``user`` still holds the erased account's id."""
    headers, doomed, _ = seeded_pair

    resp = await async_client.request(
        "DELETE",
        "/users/me",
        json={"confirm_email": doomed.email},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK

    references = await _references_to(db_session, doomed.user_id)
    remaining = {name: count for name, count in references.items() if count}
    assert remaining == {}


@pytest.mark.asyncio
async def test_deletion_leaves_no_trace_of_the_erased_address(
    async_client: AsyncClient,
    db_session: AsyncSession,
    seeded_pair: tuple[dict[str, str], SeedAccount, SeedAccount],
) -> None:
    """The address is gone from every text column but the one that keeps it on purpose.

    ``loginattempt`` is the reason this assertion is separate: it records the
    address typed at sign-in and has no foreign key at all, so a sweep driven
    only by foreign keys would miss it and the test above would still pass.

    The equality (rather than a subset check) is deliberate in both directions.
    A new hiding place for the address fails here; so does the purchase receipt
    quietly losing it, which would strand a paid-for licence.
    """
    headers, doomed, _ = seeded_pair
    before = await _rows_mentioning(db_session, doomed.email)
    assert sum(before.values()) > 0

    resp = await async_client.request(
        "DELETE",
        "/users/me",
        json={"confirm_email": doomed.email},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK

    after = {
        name: count
        for name, count in (await _rows_mentioning(db_session, doomed.email)).items()
        if count
    }
    assert set(after) == _EXPECTED_SURVIVING_EMAIL_COLUMNS


@pytest.mark.asyncio
async def test_deletion_leaves_the_other_account_untouched(
    async_client: AsyncClient,
    db_session: AsyncSession,
    seeded_pair: tuple[dict[str, str], SeedAccount, SeedAccount],
) -> None:
    """The quiet side: a sweep that took the whole table would fail here."""
    headers, doomed, bystander = seeded_pair
    before = await _references_to(db_session, bystander.user_id)

    resp = await async_client.request(
        "DELETE",
        "/users/me",
        json={"confirm_email": doomed.email},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK

    assert await _references_to(db_session, bystander.user_id) == before


@pytest.mark.asyncio
async def test_anonymised_rows_survive_the_deletion(
    async_client: AsyncClient,
    db_session: AsyncSession,
    seeded_pair: tuple[dict[str, str], SeedAccount, SeedAccount],
) -> None:
    """A row the policy calls ``anonymise`` keeps its content and loses its owner.

    Without this, "no reference remains" would be satisfied just as well by
    deleting the catalogue entry and the purchase receipt outright — which is
    the opposite of what the policy promises.
    """
    anonymised = sorted(
        name for name, policy in POLICY.items() if policy.disposition is Disposition.ANONYMISE
    )
    assert anonymised, "the policy has nothing to anonymise; this test would be vacuous"
    before = {
        name: await _count_where(db_session, SQLModel.metadata.tables[name], sa.true())
        for name in anonymised
    }
    headers, doomed, _ = seeded_pair

    resp = await async_client.request(
        "DELETE",
        "/users/me",
        json={"confirm_email": doomed.email},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK

    after = {
        name: await _count_where(db_session, SQLModel.metadata.tables[name], sa.true())
        for name in anonymised
    }
    assert after == before
