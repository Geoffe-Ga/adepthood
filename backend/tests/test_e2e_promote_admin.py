"""The e2e lane's operator arrange promotes exactly the named account, or fails loudly."""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from models.user import User
from tests.e2e.promote_admin import PromoteAdminError, _require_env, promote
from tests.helpers.feedback_triage import make_account


@pytest.mark.asyncio
async def test_promote_sets_the_flag_on_the_named_account_only(db_session: AsyncSession) -> None:
    """The target becomes an operator; a bystander does not."""
    target = await make_account(db_session, "e2e-operator@example.com")
    bystander = await make_account(db_session, "e2e-bystander@example.com")

    payload = await promote(db_session, "  E2E-Operator@Example.com ")

    assert payload == {"user_id": target.user_id, "is_admin": True}
    db_session.expire_all()
    promoted = await db_session.get(User, target.user_id)
    untouched = await db_session.get(User, bystander.user_id)
    assert promoted is not None
    assert untouched is not None
    assert promoted.is_admin is True
    assert untouched.is_admin is False


@pytest.mark.asyncio
async def test_promote_refuses_an_address_nobody_holds(db_session: AsyncSession) -> None:
    """An arrange that promoted nobody must not pass as one that worked."""
    with pytest.raises(PromoteAdminError, match="no user is registered"):
        await promote(db_session, "nobody@example.com")


def test_the_database_url_is_required(monkeypatch: pytest.MonkeyPatch) -> None:
    """No URL, no arrange -- rather than a default database."""
    monkeypatch.delenv("DATABASE_URL", raising=False)
    with pytest.raises(PromoteAdminError, match="DATABASE_URL"):
        _require_env("DATABASE_URL")
