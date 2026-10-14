"""Meta-tests for ``backend/scripts/retention_sweep.py``, the nightly cron entrypoint (#3266).

The per-store cutoffs are pinned in ``tests/services/test_retention_sweep.py``.
This file pins the run as a whole, as the Railway cron service invokes it:

* every store is swept and reported, against a schema with a row everywhere;
* ``--dry-run`` reports counts and changes no row anywhere;
* a second run straight after the first removes nothing;
* output carries names and integers only -- no id, email, IP, token or content;
* one store failing is reported, the others still run, and the exit is non-zero;
* the production image ships the script, so the cron start command can run it.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import NoReturn

import pytest
import sqlalchemy as sa
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import SQLModel

from domain.retention import LOGIN_ATTEMPT_RETENTION_DAYS, REVOKED_TOKEN_GRACE_DAYS
from models.login_attempt import LoginAttempt
from models.revoked_token import RevokedToken
from scripts import retention_sweep as cli
from services.retention_sweep import SWEEPS, StoreSweep, SweepCounts, sweep_for
from tests.helpers.account_seed import SeedAccount, seed_one_row_everywhere, seed_shared_tables
from tests.helpers.telemetry_canaries import SHORT_CANARY, assert_no_canary

_BACKEND = Path(__file__).resolve().parents[2]
_DOCKERFILE = _BACKEND / "Dockerfile"
_CANARY_EMAIL = f"{SHORT_CANARY.lower()}@example.com"
_CANARY_IP = "203.0.113.77"
_CANARY_JTI = f"jti-{SHORT_CANARY}"
_EXTRA_DAYS = 2
#: argparse's own exit code for a malformed command line.
_ARGPARSE_USAGE_EXIT = 2
_EVENT = "retention_sweep_store"
#: The only fields a per-store record may carry beyond logging's own.
_ALLOWED_FIELDS = frozenset({"store", "mode", "eligible", "deleted", "blocked", "duration_ms"})
_STANDARD_FIELDS = frozenset(logging.makeLogRecord({}).__dict__) | {"message", "asctime"}


@pytest.fixture
def _cli_session(db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch) -> None:
    """Point the command at the test database session."""

    @asynccontextmanager
    async def _factory() -> AsyncIterator[AsyncSession]:
        yield db_session

    monkeypatch.setattr(cli, "async_session_factory", _factory)


def _old(days: int) -> datetime:
    return datetime.now(UTC) - timedelta(days=days + _EXTRA_DAYS)


async def _seed_expired(session: AsyncSession) -> None:
    """Rows past their period in two stores, carrying values output must never show."""
    session.add(
        LoginAttempt(
            email=_CANARY_EMAIL,
            ip_address=_CANARY_IP,
            created_at=_old(LOGIN_ATTEMPT_RETENTION_DAYS),
        )
    )
    session.add(RevokedToken(jti=_CANARY_JTI, expires_at=_old(REVOKED_TOKEN_GRACE_DAYS)))
    await session.commit()


async def _row_counts(session: AsyncSession) -> dict[str, int]:
    counts: dict[str, int] = {}
    for name, table in SQLModel.metadata.tables.items():
        statement = sa.select(sa.func.count()).select_from(table)
        counts[name] = int((await session.execute(statement)).scalar_one())
    return counts


def _store_lines(out: str) -> dict[str, str]:
    lines = [line for line in out.splitlines() if line.startswith(f"{_EVENT} ")]
    return {line.split("store=", 1)[1].split(" mode=", 1)[0]: line for line in lines}


@pytest.mark.asyncio
@pytest.mark.usefixtures("_cli_session")
async def test_every_store_is_swept_against_a_full_schema(
    db_session: AsyncSession, capsys: pytest.CaptureFixture[str]
) -> None:
    """With a row in every table, every store runs cleanly and reports one line."""
    shared = await seed_shared_tables(db_session)
    await seed_one_row_everywhere(
        db_session, SeedAccount(user_id=1, email="seed@example.com"), shared
    )
    await _seed_expired(db_session)

    assert await cli.run([]) == cli.EXIT_CLEAN

    out = capsys.readouterr().out
    lines = _store_lines(out)
    assert set(lines) == {sweep.store for sweep in SWEEPS}
    assert "deleted=1" in lines["loginattempt"]
    assert "deleted=1" in lines["revokedtoken"]
    assert f"retention_sweep_done mode=apply stores={len(SWEEPS)} failed=0" in out


@pytest.mark.asyncio
@pytest.mark.usefixtures("_cli_session")
async def test_a_dry_run_changes_no_row_anywhere(
    db_session: AsyncSession, capsys: pytest.CaptureFixture[str]
) -> None:
    """--dry-run counts what would go and leaves every table exactly as it was."""
    await _seed_expired(db_session)
    before = await _row_counts(db_session)

    assert await cli.run(["--dry-run"]) == cli.EXIT_CLEAN

    assert await _row_counts(db_session) == before
    lines = _store_lines(capsys.readouterr().out)
    assert "mode=dry-run eligible=1 deleted=0" in lines["loginattempt"]
    assert "mode=dry-run eligible=1 deleted=0" in lines["revokedtoken"]


@pytest.mark.asyncio
@pytest.mark.usefixtures("_cli_session")
async def test_a_second_run_removes_nothing(
    db_session: AsyncSession, capsys: pytest.CaptureFixture[str]
) -> None:
    """The run is idempotent: straight after itself, every store deletes zero rows."""
    await _seed_expired(db_session)
    assert await cli.run([]) == cli.EXIT_CLEAN
    capsys.readouterr()

    assert await cli.run([]) == cli.EXIT_CLEAN

    for store, line in _store_lines(capsys.readouterr().out).items():
        assert "eligible=0 deleted=0" in line, store


@pytest.mark.asyncio
@pytest.mark.usefixtures("_cli_session")
async def test_output_carries_counts_and_names_only(
    db_session: AsyncSession,
    capsys: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """No email, IP, token or id reaches stdout or a log record; extras are allow-listed."""
    await _seed_expired(db_session)
    caplog.set_level(logging.INFO, logger=cli.logger.name)

    assert await cli.run([]) == cli.EXIT_CLEAN

    out = capsys.readouterr().out
    records = [record for record in caplog.records if record.name == cli.logger.name]
    blob = out + "".join(f"{r.getMessage()} {r.__dict__!r}" for r in records)
    assert_no_canary(blob, SHORT_CANARY)
    for value in (_CANARY_EMAIL, _CANARY_IP, _CANARY_JTI):
        assert value not in blob
    store_records = [record for record in records if record.getMessage() == _EVENT]
    assert len(store_records) == len(SWEEPS)
    for record in store_records:
        extras = set(record.__dict__) - _STANDARD_FIELDS
        assert extras == _ALLOWED_FIELDS, extras


def _failing_sweep() -> StoreSweep:
    async def run(session: AsyncSession, now: datetime, *, dry_run: bool) -> NoReturn:
        del session, now, dry_run
        raise OperationalError(_CANARY_EMAIL, {}, Exception(SHORT_CANARY))

    return StoreSweep(store="broken", covers=(), run=run)


@pytest.mark.asyncio
@pytest.mark.usefixtures("_cli_session")
async def test_one_store_failing_does_not_stop_the_others(
    db_session: AsyncSession,
    capsys: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The failure is logged by class, the next store still sweeps, and the exit is 1."""
    await _seed_expired(db_session)
    caplog.set_level(logging.INFO, logger=cli.logger.name)

    exit_code = await cli.run([], sweeps=(_failing_sweep(), sweep_for("loginattempt")))

    assert exit_code == cli.EXIT_STORE_FAILED
    out = capsys.readouterr().out
    assert "retention_sweep_store_failed store=broken mode=apply error=OperationalError" in out
    assert "eligible=1 deleted=1" in _store_lines(out)["loginattempt"]
    assert "failed=1" in out
    failures = [r for r in caplog.records if r.getMessage() == "retention_sweep_store_failed"]
    assert len(failures) == 1
    assert failures[0].levelno == logging.ERROR
    blob = out + "".join(f"{r.getMessage()} {r.__dict__!r}" for r in caplog.records)
    assert_no_canary(blob, SHORT_CANARY)
    assert _CANARY_EMAIL not in blob


def test_main_configures_logging_and_returns_the_runs_exit_code(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The synchronous entrypoint the cron start command calls."""
    configured: list[bool] = []

    async def _run(argv: list[str] | None) -> int:
        assert argv == ["--dry-run"]
        return cli.EXIT_STORE_FAILED

    monkeypatch.setattr(cli, "configure_logging", lambda: configured.append(True))
    monkeypatch.setattr(cli, "run", _run)

    assert cli.main(["--dry-run"]) == cli.EXIT_STORE_FAILED
    assert configured == [True]


def test_an_unknown_option_is_a_usage_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """A typo is refused as a usage error rather than running an unintended sweep."""
    monkeypatch.setattr(cli, "configure_logging", lambda: None)
    with pytest.raises(SystemExit) as raised:
        cli.main(["--dryrun"])
    assert raised.value.code == _ARGPARSE_USAGE_EXIT


def test_the_image_ships_the_entrypoint() -> None:
    """The cron service runs the backend image, so the image must carry the script."""
    text = _DOCKERFILE.read_text(encoding="utf-8")
    assert "COPY backend/scripts/__init__.py backend/scripts/retention_sweep.py scripts/" in text


def test_counts_are_plain_integers() -> None:
    """The counts type has no room for anything but integers."""
    assert set(SweepCounts.__dataclass_fields__) == {"eligible", "deleted", "blocked"}
