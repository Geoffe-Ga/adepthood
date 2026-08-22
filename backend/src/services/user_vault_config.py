"""Reading, replacing and removing one account's stored vault connection.

Three functions and one table. They are here rather than inline in the router
because the *read* has a second caller with nothing to do with HTTP:
:mod:`dependencies.creek_vault` runs it on every request that touches a vault,
and a lookup written twice is a lookup that can come to disagree about which
row belongs to whom.

Every function is keyed on ``user_id`` taken from the caller's own token. No
account identifier is ever accepted from a path or a body, so there is no
parameter here that a request could aim at somebody else's row.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlmodel import col, delete, select

from models.user_vault_config import UserVaultConfig

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


async def load_vault_config(session: AsyncSession, user_id: int) -> UserVaultConfig | None:
    """Return the vault this account connected, or ``None`` if it connected none.

    ``None`` is the ordinary answer, not an error: connecting a vault is
    optional, and an account that has not is served the local pipeline exactly
    as every account on a vault-less deployment always has been.
    """
    result = await session.execute(
        select(UserVaultConfig).where(UserVaultConfig.user_id == user_id)
    )
    return result.scalars().first()


async def store_vault_config(
    session: AsyncSession, user_id: int, *, vault_url: str, api_key: str
) -> UserVaultConfig:
    """Replace this account's connection with ``vault_url`` and ``api_key``.

    An update in place when a row already exists, so reconnecting moves the one
    row rather than adding a second the unique constraint would refuse anyway.
    Both columns are written together: a user pointing at a different vault is
    presenting a different credential, and carrying the old key over to a new
    URL would send one vault's secret to another.
    """
    existing = await load_vault_config(session, user_id)
    config = existing or UserVaultConfig(user_id=user_id, vault_url=vault_url, api_key=api_key)
    config.vault_url = vault_url
    config.api_key = api_key
    session.add(config)
    await session.commit()
    await session.refresh(config)
    return config


async def clear_vault_config(session: AsyncSession, user_id: int) -> None:
    """Remove this account's connection, credential included.

    Idempotent: disconnecting a vault nobody connected is a no-op rather than a
    404, because the state the caller asked for -- "no vault of mine is stored"
    -- is the state they end up in either way.
    """
    await session.execute(delete(UserVaultConfig).where(col(UserVaultConfig.user_id) == user_id))
    await session.commit()
