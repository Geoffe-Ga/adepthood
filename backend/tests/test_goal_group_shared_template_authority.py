"""Shared-template goal groups are an operator surface, not a user one.

A ``shared_template`` group is ownerless (``user_id IS NULL``, biconditional with
the flag via ``ck_goalgroup_shared_template_user_id``) and world-readable, and it
carries its goals embedded. Creating one therefore *publishes content to every
user of the deployment*.

Until this module existed, any authenticated signup could do that -- and because
the group is ownerless, the owner-only write check could never match anybody, so
nothing could edit or delete it afterwards. One request permanently injected
chosen content into every user's view with no in-app remedy. That combination is
the sharpest available violation of the governing promise in ``NORTH-STAR.md``
that a user's space is their own and that depth is always declinable.

The rule these tests pin: **creating or mutating a shared template requires
admin; everything about an ordinary private group is unchanged.** Reads stay open
-- a template nobody can see is not a template -- so ``require_visible_goal_group``
keeps its shared-template short-circuit and is deliberately not touched here.
"""

from __future__ import annotations

from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select, update

from models.goal_group import GoalGroup
from models.user import User

_PASSWORD = "secret12345"  # pragma: allowlist secret

_GROUPS = "/goal-groups/"


async def _signup(client: AsyncClient, username: str) -> dict[str, str]:
    """Sign up a fresh (non-admin) user and return an Authorization header."""
    response = await client.post(
        "/auth/signup",
        json={"email": f"{username}@example.com", "password": _PASSWORD},
    )
    assert response.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {response.json()['token']}"}


async def _promote(session: AsyncSession, username: str) -> None:
    """Flip ``is_admin`` for a signed-up user, mirroring the admin-router tests."""
    await session.execute(
        update(User).where(col(User.email) == f"{username}@example.com").values(is_admin=True)
    )
    await session.commit()


def _template_payload(name: str = "Community Template") -> dict[str, object]:
    """Build a shared-template creation body."""
    return {"name": name, "shared_template": True, "source": "community"}


async def _seed_template(session: AsyncSession, name: str = "Seeded Template") -> int:
    """Insert a shared template directly, the way the seeder does.

    Deliberately not via the API: the point of this module is that the API path
    is closed, so the fixture cannot use it to build its own precondition.
    """
    group = GoalGroup(name=name, shared_template=True, user_id=None, source="built-in")
    session.add(group)
    await session.commit()
    await session.refresh(group)
    assert group.id is not None
    return group.id


class TestCreationRequiresAdmin:
    """Publishing to every user is an operator act."""

    @pytest.mark.asyncio
    async def test_an_ordinary_user_cannot_create_a_shared_template(
        self, async_client: AsyncClient
    ) -> None:
        """The broadcast primitive is closed to ordinary signups."""
        headers = await _signup(async_client, "sharer-plain")

        response = await async_client.post(_GROUPS, json=_template_payload(), headers=headers)

        assert response.status_code == HTTPStatus.FORBIDDEN

    @pytest.mark.asyncio
    async def test_a_rejected_creation_writes_no_row(
        self, async_client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """A 403 must mean nothing was published, not merely that nothing was returned."""
        headers = await _signup(async_client, "sharer-norow")
        await async_client.post(
            _GROUPS, json=_template_payload("Should Not Exist"), headers=headers
        )

        result = await db_session.execute(
            select(GoalGroup).where(col(GoalGroup.name) == "Should Not Exist")
        )
        assert result.scalars().first() is None

    @pytest.mark.asyncio
    async def test_an_admin_can_create_a_shared_template(
        self, async_client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """The operator path stays open -- this is a restriction, not a removal."""
        headers = await _signup(async_client, "sharer-admin")
        await _promote(db_session, "sharer-admin")

        response = await async_client.post(_GROUPS, json=_template_payload(), headers=headers)

        assert response.status_code == HTTPStatus.CREATED
        assert response.json()["shared_template"] is True

    @pytest.mark.asyncio
    async def test_an_ordinary_user_can_still_create_a_private_group(
        self, async_client: AsyncClient
    ) -> None:
        """The restriction is scoped to publishing; ordinary use is untouched."""
        headers = await _signup(async_client, "sharer-private")

        response = await async_client.post(
            _GROUPS, json={"name": "My Own Goals", "icon": "🎯"}, headers=headers
        )

        assert response.status_code == HTTPStatus.CREATED
        assert response.json()["shared_template"] is False


class TestMutationHasAnAuthority:
    """No object may be left permanently unmodifiable by everyone."""

    @pytest.mark.asyncio
    async def test_an_ordinary_user_cannot_edit_a_shared_template(
        self, async_client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """A stranger editing a template would republish to everybody."""
        group_id = await _seed_template(db_session)
        headers = await _signup(async_client, "editor-plain")

        response = await async_client.put(
            f"/goal-groups/{group_id}", json={"name": "Hijacked"}, headers=headers
        )

        assert response.status_code == HTTPStatus.FORBIDDEN

    @pytest.mark.asyncio
    async def test_an_admin_can_edit_a_shared_template(
        self, async_client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """The defect this closes: previously nobody could, including operators."""
        group_id = await _seed_template(db_session)
        headers = await _signup(async_client, "editor-admin")
        await _promote(db_session, "editor-admin")

        response = await async_client.put(
            f"/goal-groups/{group_id}",
            json={"name": "Corrected Template", "shared_template": True},
            headers=headers,
        )

        assert response.status_code == HTTPStatus.OK
        assert response.json()["name"] == "Corrected Template"

    @pytest.mark.asyncio
    async def test_an_ordinary_user_cannot_delete_a_shared_template(
        self, async_client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """Deletion is as much a broadcast act as creation."""
        group_id = await _seed_template(db_session)
        headers = await _signup(async_client, "deleter-plain")

        response = await async_client.delete(f"/goal-groups/{group_id}", headers=headers)

        assert response.status_code == HTTPStatus.FORBIDDEN

    @pytest.mark.asyncio
    async def test_an_admin_can_delete_a_shared_template(
        self, async_client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """There is now a remedy for bad published content."""
        group_id = await _seed_template(db_session)
        headers = await _signup(async_client, "deleter-admin")
        await _promote(db_session, "deleter-admin")

        response = await async_client.delete(f"/goal-groups/{group_id}", headers=headers)

        assert response.status_code == HTTPStatus.NO_CONTENT

    @pytest.mark.asyncio
    async def test_an_admin_editing_a_private_group_they_do_not_own_is_still_refused(
        self, async_client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """Admin is an authority over *published* content, not over private spaces.

        The whole point of the product promise is that a user's own space is
        theirs. Widening the shared-template authority into ordinary groups would
        trade one violation for a larger one.
        """
        owner_headers = await _signup(async_client, "private-owner")
        created = await async_client.post(
            _GROUPS, json={"name": "Owner's Private Group"}, headers=owner_headers
        )
        assert created.status_code == HTTPStatus.CREATED
        group_id = created.json()["id"]

        admin_headers = await _signup(async_client, "nosy-admin")
        await _promote(db_session, "nosy-admin")

        response = await async_client.put(
            f"/goal-groups/{group_id}", json={"name": "Snooped"}, headers=admin_headers
        )

        assert response.status_code == HTTPStatus.FORBIDDEN


class TestPutCannotChangeAGroupsKind:
    """``shared_template`` is a kind, not a field -- an edit must not flip it.

    Both directions are refused, for different reasons: publishing a private
    group by editing it would route around the creation gate entirely, and
    demoting a template would strand an ownerless row against the DB CHECK
    constraint.
    """

    @pytest.mark.asyncio
    async def test_an_owner_cannot_publish_their_group_by_editing_it(
        self, async_client: AsyncClient
    ) -> None:
        """Otherwise PUT is a second, ungated broadcast primitive."""
        headers = await _signup(async_client, "publisher-via-put")
        created = await async_client.post(_GROUPS, json={"name": "Mine"}, headers=headers)
        group_id = created.json()["id"]

        response = await async_client.put(
            f"/goal-groups/{group_id}",
            json={"name": "Mine", "shared_template": True},
            headers=headers,
        )

        assert response.status_code == HTTPStatus.OK
        assert response.json()["shared_template"] is False

    @pytest.mark.asyncio
    async def test_an_admin_editing_a_template_without_resending_the_flag_keeps_it(
        self, async_client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """An ordinary edit body carries the flag's False default; it must not demote."""
        group_id = await _seed_template(db_session, "Keeps Its Kind")
        headers = await _signup(async_client, "kind-admin")
        await _promote(db_session, "kind-admin")

        response = await async_client.put(
            f"/goal-groups/{group_id}", json={"name": "Renamed"}, headers=headers
        )

        assert response.status_code == HTTPStatus.OK
        assert response.json()["shared_template"] is True
        assert response.json()["name"] == "Renamed"


class TestReadsStayOpen:
    """A template nobody can read is not a template."""

    @pytest.mark.asyncio
    async def test_any_user_still_sees_shared_templates_in_the_list(
        self, async_client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """The restriction is on publishing, not on reading what was published."""
        await _seed_template(db_session, "Visible Template")
        headers = await _signup(async_client, "reader-list")

        response = await async_client.get(_GROUPS, headers=headers)

        assert response.status_code == HTTPStatus.OK
        assert any(g["name"] == "Visible Template" for g in response.json())

    @pytest.mark.asyncio
    async def test_any_user_still_reads_a_shared_template_directly(
        self, async_client: AsyncClient, db_session: AsyncSession
    ) -> None:
        """The single-GET short-circuit for templates is deliberately preserved."""
        group_id = await _seed_template(db_session, "Directly Readable")
        headers = await _signup(async_client, "reader-get")

        response = await async_client.get(f"/goal-groups/{group_id}", headers=headers)

        assert response.status_code == HTTPStatus.OK
        assert response.json()["shared_template"] is True
