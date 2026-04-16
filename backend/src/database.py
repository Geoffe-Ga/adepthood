"""Async database engine, session factory, and FastAPI dependency."""

import os
from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine


def normalize_database_url(url: str) -> str:
    """Normalize a database URL for use with SQLAlchemy's async engine.

    Railway and other PaaS providers inject ``DATABASE_URL`` using the plain
    ``postgresql://`` or ``postgres://`` scheme. SQLAlchemy's async engine
    requires the ``postgresql+asyncpg://`` scheme. This function performs the
    conversion while leaving other schemes (e.g. ``sqlite+aiosqlite://``)
    untouched.
    """
    if url.startswith("postgres://"):
        return "postgresql+asyncpg://" + url[len("postgres://") :]
    if url.startswith("postgresql://"):
        return "postgresql+asyncpg://" + url[len("postgresql://") :]
    return url


DATABASE_URL = normalize_database_url(
    os.getenv(
        "DATABASE_URL",
        "postgresql+asyncpg://aptitude:aptitude@localhost:5432/aptitude",
    )
)

engine = create_async_engine(DATABASE_URL, echo=False)

async_session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency that yields an async database session.

    BUG-INFRA-021: wrap the body in ``try/finally`` so a failed handler
    rolls back its transaction *and* releases the connection.  The outer
    ``async with`` already guarantees ``close()``, but adding the explicit
    rollback prevents an in-flight ``BEGIN`` from being silently committed
    by the connection pool when reused.
    """
    async with async_session_factory() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
