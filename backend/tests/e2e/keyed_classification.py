"""Arrange and inspect one owned classification promise in the throwaway wire lane.

Only enum state, counts and opaque handles are read or written. The authenticated
lane owner's email resolves the account; no provider credential is accepted.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from urllib.parse import urlsplit

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool
from sqlmodel import col, select

from database import normalize_database_url
from domain.creek_vault import VaultPipelineStage
from models import User
from models.vault_pipeline_run import VaultPipelineOutcome, VaultPipelineRun
from services.creek_vault_pipeline import VaultPipelineTrigger


async def inspect_run(session: AsyncSession, email: str, *, arrange: bool) -> dict[str, object]:
    """Resolve this lane's owner and optionally create an unstarted classification."""
    owner = (await session.execute(select(User).where(User.email == email))).scalar_one()
    statement = (
        select(VaultPipelineRun)
        .where(
            col(VaultPipelineRun.user_id) == owner.id,
            col(VaultPipelineRun.stage) == VaultPipelineStage.CLASSIFY.value,
        )
        .order_by(col(VaultPipelineRun.id).desc())
    )
    run = (await session.execute(statement)).scalars().first()
    if arrange:
        if run is not None and run.outcome in {
            VaultPipelineOutcome.QUEUED.value,
            VaultPipelineOutcome.ATTEMPTED.value,
        }:
            raise ValueError("The lane must drain its existing classification first")
        if owner.id is None:
            raise ValueError("The lane owner has no persisted identity")
        run = VaultPipelineRun(
            user_id=owner.id,
            stage=VaultPipelineStage.CLASSIFY.value,
            trigger=VaultPipelineTrigger.JOURNAL_WRITE.value,
            outcome=VaultPipelineOutcome.QUEUED.value,
            attempt_count=0,
            fragments_seen=0,
            fragments_touched=0,
            fragments_lost=0,
        )
        session.add(run)
        # Keep the independent temporal interval closed: this journey owns
        # classification admission and polling, not an unrelated linker pass.
        session.add(
            VaultPipelineRun(
                user_id=owner.id,
                stage=VaultPipelineStage.TEMPORAL.value,
                trigger=VaultPipelineTrigger.JOURNAL_WRITE.value,
                outcome=VaultPipelineOutcome.COMPLETED.value,
                fragments_seen=0,
                fragments_touched=0,
                fragments_lost=0,
            )
        )
        await session.commit()
    return {
        "run_id": None if run is None else run.id,
        "job_id": None if run is None else run.job_id,
        "outcome": None if run is None else run.outcome,
        "attempt_count": None if run is None else run.attempt_count,
    }


async def run(command: str, email: str) -> dict[str, object]:
    """Refuse every database except the explicitly named disposable e2e database."""
    url = os.environ["DATABASE_URL"].strip()
    if not urlsplit(url).path.removeprefix("/").startswith("adepthood_e2e_"):
        raise ValueError("A throwaway adepthood_e2e_ DATABASE_URL is required")
    engine = create_async_engine(normalize_database_url(url), poolclass=NullPool)
    try:
        async with AsyncSession(engine, expire_on_commit=False) as session:
            return await inspect_run(session, email, arrange=command == "queue")
    finally:
        await engine.dispose()


def main() -> None:
    """Arrange or inspect the synthetic owner's content-free queue."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["queue", "show"])
    parser.add_argument("--email", required=True)
    args = parser.parse_args()
    sys.stdout.write(json.dumps(asyncio.run(run(args.command, args.email.strip().lower()))) + "\n")


if __name__ == "__main__":
    main()
