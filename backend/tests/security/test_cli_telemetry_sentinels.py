"""Content-free output outside the request path: migrations and uncaught exceptions (#3352).

The runtime CMD runs ``python -m alembic upgrade head`` before uvicorn starts,
so a failing migration prints to the same Railway log collection as the app --
through alembic.ini's own logging config and Python's default excepthook, not
the app's :class:`observability.ContentFreeFormatter`. A database error raised
there quotes the statement and its bound parameters: row data. The canary test
runs the real ``env.py`` in a subprocess, exactly as the container does, against
a fixture migration whose failure carries a canary in its parameters.

A thread that dies with an unhandled exception is printed by
``threading.excepthook``, outside logging altogether; ``configure_logging``
replaces the interpreter's default with a content-free one.
"""

from __future__ import annotations

import io
import logging
import os
import subprocess
import sys
import textwrap
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import NoReturn

import pytest

import telemetry_safety
from observability import (
    ContentFreeFormatter,
    configure_logging,
    make_cli_output_content_free,
    remove_app_log_handlers_for_tests,
)
from tests.helpers.telemetry_canaries import SHORT_CANARY, assert_no_canary

_BACKEND = Path(__file__).resolve().parents[2]
_MIGRATIONS = _BACKEND / "migrations"

#: Long enough for a cold interpreter to import the models and run one migration.
_ALEMBIC_TIMEOUT_SECONDS = 120

#: A migration that fails the way a real one can: a unique violation whose
#: SQLAlchemy message carries the statement's bound parameters -- the row --
#: logged through alembic's own handler on the way out, then left uncaught.
_FAILING_MIGRATION = textwrap.dedent(
    '''
    """Fixture: a migration whose failure quotes a row value."""

    import logging

    import sqlalchemy as sa
    from alembic import op

    revision = "c11canary0001"
    down_revision = None
    branch_labels = None
    depends_on = None

    _ROW = {canary!r}


    def upgrade() -> None:
        """Insert the same unique value twice."""
        op.execute("CREATE TABLE canary_row (value TEXT UNIQUE)")
        insert = sa.text("INSERT INTO canary_row (value) VALUES (:value)")
        op.get_bind().execute(insert, {{"value": _ROW}})
        try:
            op.get_bind().execute(insert, {{"value": _ROW}})
        except sa.exc.IntegrityError:
            logging.getLogger("alembic.runtime.migration").exception("fixture migration failed")
            raise


    def downgrade() -> None:
        """Nothing to undo."""
    '''
)


def _write_fixture_environment(tmp_path: Path, canary: str) -> Path:
    """Write an alembic.ini that runs the real ``env.py`` over one fixture migration.

    The ini is the shipped one with only its script and version locations
    redirected, so its ``[loggers]`` / ``[formatter_generic]`` sections are what
    ``env.py`` loads, as in production.
    """
    versions = tmp_path / "versions"
    versions.mkdir()
    (versions / "c11canary0001_fixture.py").write_text(
        _FAILING_MIGRATION.format(canary=canary), encoding="utf-8"
    )
    shipped = (_BACKEND / "alembic.ini").read_text(encoding="utf-8")
    ini = shipped.replace(
        "script_location = %(here)s/migrations",
        f"script_location = {_MIGRATIONS}\nversion_locations = {versions}",
    )
    assert ini != shipped, "alembic.ini no longer sets script_location the way this test expects"
    path = tmp_path / "alembic.ini"
    path.write_text(ini, encoding="utf-8")
    return path


def _run_alembic_upgrade(tmp_path: Path, canary: str) -> subprocess.CompletedProcess[str]:
    """Run ``python -m alembic upgrade head`` the way the container's CMD does."""
    ini = _write_fixture_environment(tmp_path, canary)
    env = {
        **os.environ,
        "PYTHONPATH": str(_BACKEND / "src"),
        "DATABASE_URL": f"sqlite+aiosqlite:///{tmp_path / 'throwaway.sqlite'}",
    }
    return subprocess.run(
        [sys.executable, "-m", "alembic", "-c", str(ini), "upgrade", "head"],
        cwd=_BACKEND,
        env=env,
        capture_output=True,
        text=True,
        timeout=_ALEMBIC_TIMEOUT_SECONDS,
        check=False,
    )


def test_a_failing_migration_prints_its_type_but_not_the_row(tmp_path: Path) -> None:
    """Neither alembic's log handler nor the uncaught traceback quotes the row."""
    result = _run_alembic_upgrade(tmp_path, SHORT_CANARY)

    output = result.stdout + result.stderr
    assert result.returncode != 0, output
    assert_no_canary(output, SHORT_CANARY)
    # The log handler's line, still in alembic.ini's format, still diagnosable.
    assert "ERROR [alembic.runtime.migration] fixture migration failed" in output
    # The uncaught traceback: frames, then the type with its message withheld.
    assert "Traceback (most recent call last):" in output
    assert f"IntegrityError: {telemetry_safety.MESSAGE_WITHHELD}" in output


class _CanaryError(Exception):
    """An exception whose message is a canary."""


# ── make_cli_output_content_free, in process ─────────────────────────────

_CLI_FORMAT = "%(levelname)-5.5s [%(name)s] %(message)s"


def _every_handler() -> list[logging.Handler]:
    loggers: list[logging.Logger] = [logging.getLogger()]
    loggers.extend(
        logger
        for logger in logging.Logger.manager.loggerDict.values()
        if isinstance(logger, logging.Logger)
    )
    return [handler for logger in loggers for handler in logger.handlers]


@pytest.fixture
def cli_stream(monkeypatch: pytest.MonkeyPatch) -> Iterator[io.StringIO]:
    """A handler as ``fileConfig`` installs one; every formatter and the hook restored after.

    ``make_cli_output_content_free`` reaches every handler in the process --
    pytest's own capture handlers included -- so each one's formatter is put
    back on teardown, and ``sys.excepthook`` is restored by ``monkeypatch``.
    """
    monkeypatch.setattr(sys, "excepthook", sys.excepthook)
    logger = logging.getLogger("tests.cli_telemetry_sentinels")
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(logging.Formatter(_CLI_FORMAT))
    logger.addHandler(handler)
    saved = {h: h.formatter for h in _every_handler()}
    try:
        yield stream
    finally:
        for each, formatter in saved.items():
            each.setFormatter(formatter)
        logger.removeHandler(handler)


def _raise_canary() -> NoReturn:
    raise _CanaryError(SHORT_CANARY)


def _caught_canary() -> BaseException:
    try:
        _raise_canary()
    except _CanaryError as exc:
        return exc


def test_cli_hardening_formats_every_configured_handler_content_free(
    cli_stream: io.StringIO,
) -> None:
    """A ``fileConfig`` handler keeps its format but loses the exception's message."""
    make_cli_output_content_free(_CLI_FORMAT)

    logging.getLogger("tests.cli_telemetry_sentinels").error(
        "migration failed", exc_info=_caught_canary()
    )

    output = cli_stream.getvalue()
    assert_no_canary(output, SHORT_CANARY)
    assert output.startswith("ERROR [tests.cli_telemetry_sentinels] migration failed\n")
    assert f"_CanaryError: {telemetry_safety.MESSAGE_WITHHELD}" in output
    assert all(isinstance(h.formatter, ContentFreeFormatter) for h in _every_handler())


@pytest.mark.usefixtures("cli_stream")
def test_cli_hardening_makes_the_uncaught_traceback_content_free(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """``sys.excepthook`` prints frames and the type, never the message."""
    make_cli_output_content_free(_CLI_FORMAT)
    exc = _caught_canary()

    sys.excepthook(type(exc), exc, exc.__traceback__)

    err = capsys.readouterr().err
    assert_no_canary(err, SHORT_CANARY)
    assert err.startswith("Traceback (most recent call last):\n")
    assert f"_CanaryError: {telemetry_safety.MESSAGE_WITHHELD}" in err


# ── threading.excepthook ───────────────────────────────────────────────────


@pytest.fixture
def default_thread_excepthook(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Start from the interpreter's own thread hook; restore whatever was there after.

    pytest installs its own ``threading.excepthook`` for the session, which
    ``configure_logging`` deliberately leaves alone; this puts the default back
    for the duration of one test, as a production process has it.
    """
    monkeypatch.setattr(threading, "excepthook", threading.__excepthook__)
    remove_app_log_handlers_for_tests()
    try:
        yield
    finally:
        remove_app_log_handlers_for_tests()


@pytest.mark.usefixtures("default_thread_excepthook")
def test_a_thread_dying_uncaught_prints_its_type_but_not_its_message(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """``configure_logging`` makes the thread hook print the content-free rendering."""
    configure_logging()

    worker = threading.Thread(target=_raise_canary, name="canary-worker")
    worker.start()
    worker.join()

    err = capsys.readouterr().err
    assert_no_canary(err, SHORT_CANARY)
    assert "Exception in thread canary-worker" in err
    assert "Traceback (most recent call last):" in err
    assert f"_CanaryError: {telemetry_safety.MESSAGE_WITHHELD}" in err


@pytest.mark.usefixtures("default_thread_excepthook")
def test_a_thread_exiting_via_system_exit_prints_nothing(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Like the default hook, ``SystemExit`` in a thread is a quiet exit."""
    configure_logging()

    worker = threading.Thread(target=sys.exit)
    worker.start()
    worker.join()

    assert capsys.readouterr().err == ""


def test_configure_logging_leaves_a_deliberately_installed_thread_hook_alone(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A hook the host installed (pytest's, a crash reporter's) is not displaced."""

    def host_hook(_args: threading.ExceptHookArgs) -> None:
        """Stand-in for a host-installed hook."""

    monkeypatch.setattr(threading, "excepthook", host_hook)
    remove_app_log_handlers_for_tests()
    try:
        configure_logging()
    finally:
        remove_app_log_handlers_for_tests()

    assert threading.excepthook is host_hook
