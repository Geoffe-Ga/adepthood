"""Tests for ``backend/scripts/journal_encryption_sweep.py`` (#3058).

Encryption at rest is only as good as the rows it has actually reached. Three
kinds of row escape it silently: one written before any key was configured
(legacy plaintext), one written under a key since rotated out of first place
(an old-key token that pins the old key forever), and one no configured key can
read at all. The operator tool has two halves, and the contract tested here is:

* ``audit`` counts those kinds per ``table.column`` -- plaintext, per key
  position, undecryptable, NULL -- and prints *only* counts and names. It exits
  non-zero while anything still needs the sweep.
* ``reencrypt`` is a dry run unless ``--apply`` is given. Applied, it moves every
  plaintext and old-key value to the primary key, batch by batch, with a
  compare-and-swap write; it is idempotent, resumable, refuses outright with no
  key, and stops on an undecryptable value *before* writing anything in that
  batch. It never writes plaintext.

Then the point of all of it: after a sweep the old key can be removed and every
row still reads.
"""

from __future__ import annotations

import re
from collections.abc import AsyncIterator, Callable, Iterable, Iterator, Sequence
from contextlib import asynccontextmanager
from typing import NoReturn

import pytest
from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from models.journal_entry import JournalEntry
from scripts import journal_encryption_sweep as sweep
from services import journal_encryption as je
from services.encryption_inventory import (
    ROW_ID_COLUMN,
    EncryptedColumn,
    encrypted_columns,
    raw_table,
)
from tests.support.encrypted_rows import ROW_FACTORIES, insert_row

_COLUMNS = encrypted_columns()
_MESSAGE = EncryptedColumn("journalentry", "message")
_TITLE = EncryptedColumn("journalentry", "title")
# The on-disk marker, spelled out so the oracle below shares nothing with the codec.
_MARKER = "enc::v1::"
_COUNT_LINE = re.compile(r"^audit (\S+) (.*)$")


def _canary(phase: str, column: str) -> str:
    return f"canary-{phase}-{column}: the thing I have never told anyone"


def _texts(phase: str, table: str) -> Callable[[str], str]:
    """The canary writer for one table: column name -> that column's canary."""
    return lambda column: _canary(phase, f"{table}.{column}")


@pytest.fixture(autouse=True)
def _isolated_environment(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """No inherited key or production signal may decide an outcome here."""
    for name in (je.KEYS_ENV_VAR, *je.PRODUCTION_SIGNAL_ENV_VARS):
        monkeypatch.delenv(name, raising=False)
    je.reset_cache()
    yield
    je.reset_cache()


@pytest.fixture
def _cli_session(db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch) -> None:
    """Point the command at the test database session."""

    @asynccontextmanager
    async def _factory() -> AsyncIterator[AsyncSession]:
        yield db_session

    monkeypatch.setattr(sweep, "async_session_factory", _factory)


def _keys(monkeypatch: pytest.MonkeyPatch, *keys: str) -> None:
    """Configure ``keys`` (or none) and drop the cache -- the restart."""
    if keys:
        monkeypatch.setenv(je.KEYS_ENV_VAR, ",".join(keys))
    else:
        monkeypatch.delenv(je.KEYS_ENV_VAR, raising=False)
    je.reset_cache()


async def _seed_every_table(session: AsyncSession, phase: str) -> dict[str, int]:
    """One row per encrypted table under the current keys; returns table -> id."""
    ids = {table: await insert_row(session, table, _texts(phase, table)) for table in ROW_FACTORIES}
    await session.commit()
    return ids


async def _raw(session: AsyncSession, target: EncryptedColumn) -> dict[int, str | None]:
    """Every stored value of one column, by row id, read without the TypeDecorator."""
    raw = raw_table(target)
    rows = await session.execute(select(raw.c[ROW_ID_COLUMN], raw.c[target.column]))
    return dict(rows.tuples().all())


async def _raw_everything(session: AsyncSession) -> dict[str, dict[int, str | None]]:
    return {target.qualified: await _raw(session, target) for target in _COLUMNS}


def _audit_counts(output: str) -> dict[str, dict[str, int]]:
    """Parse ``audit table.column k=v ...`` lines into nested dicts."""
    counts: dict[str, dict[str, int]] = {}
    for line in output.splitlines():
        match = _COUNT_LINE.match(line)
        if match:
            pairs = (item.split("=") for item in match.group(2).split())
            counts[match.group(1)] = {key: int(value) for key, value in pairs}
    return counts


def _oracle_counts(values: Iterable[str | None], *keys: str) -> dict[str, int]:
    """Count stored values independently of the code under test, with raw Fernet."""
    counts = {"null": 0, "plaintext": 0, "undecryptable": 0} | {
        f"key{index}": 0 for index in range(len(keys))
    }
    for value in values:
        if value is None:
            counts["null"] += 1
        elif not value.startswith(_MARKER):
            counts["plaintext"] += 1
        else:
            counts[_oracle_slot(value.removeprefix(_MARKER), keys)] += 1
    return counts


def _oracle_slot(token: str, keys: Sequence[str]) -> str:
    for index, key in enumerate(keys):
        try:
            Fernet(key.encode()).decrypt(token.encode())
        except InvalidToken:
            continue
        return f"key{index}"
    return "undecryptable"


def _assert_no_content(text: str) -> None:
    assert "canary-" not in text
    assert "never told anyone" not in text


@pytest.mark.asyncio
@pytest.mark.usefixtures("_cli_session")
async def test_audit_counts_every_kind_per_column_and_prints_no_content(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Plaintext, old-key, primary-key and NULL are each counted, for every column."""
    old, new = Fernet.generate_key().decode(), Fernet.generate_key().decode()
    await _seed_every_table(db_session, "legacy")
    _keys(monkeypatch, old)
    await _seed_every_table(db_session, "old")
    _keys(monkeypatch, new, old)
    await _seed_every_table(db_session, "new")
    db_session.add(JournalEntry(sender="user", user_id=1, message="untitled"))
    await db_session.commit()

    exit_code = await sweep.run(["audit"])

    captured = capsys.readouterr()
    assert exit_code == sweep.EXIT_ROWS_REMAIN
    counts = _audit_counts(captured.out)
    assert set(counts) == {target.qualified for target in _COLUMNS}
    for target in _COLUMNS:
        expected = _oracle_counts((await _raw(db_session, target)).values(), new, old)
        assert counts[target.qualified] == expected, target.qualified
        # Every kind is present in every column, so no count is vacuously zero.
        assert min(expected["plaintext"], expected["key0"], expected["key1"]) >= 1
    assert counts[_TITLE.qualified]["null"] >= 1
    _assert_no_content(captured.out + captured.err + caplog.text)
    assert old not in captured.out + captured.err
    assert new not in captured.out + captured.err


@pytest.mark.asyncio
@pytest.mark.usefixtures("_cli_session")
async def test_sweep_moves_everything_to_the_new_key_so_the_old_one_can_go(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Legacy plaintext and old-key rows end on key 0; then the old key is removable."""
    old, new = Fernet.generate_key().decode(), Fernet.generate_key().decode()
    legacy_ids = await _seed_every_table(db_session, "legacy")
    _keys(monkeypatch, old)
    old_ids = await _seed_every_table(db_session, "old")
    _keys(monkeypatch, new, old)

    before = await _raw_everything(db_session)
    capsys.readouterr()
    assert await sweep.run(["reencrypt"]) == sweep.EXIT_ROWS_REMAIN
    dry = capsys.readouterr()
    assert await _raw_everything(db_session) == before, "a dry run wrote"
    assert "committed" not in dry.err, "a dry run committed a batch"
    assert "mode=dry-run" in dry.out

    assert await sweep.run(["reencrypt", "--apply"]) == sweep.EXIT_CLEAN
    assert await sweep.run(["audit"]) == sweep.EXIT_CLEAN

    # The restart without the old key: every row still reads, through the ORM too.
    _keys(monkeypatch, new)
    assert await sweep.run(["audit"]) == sweep.EXIT_CLEAN
    for target in _COLUMNS:
        stored = await _raw(db_session, target)
        for phase, ids in (("legacy", legacy_ids), ("old", old_ids)):
            value = stored[ids[target.table]]
            assert value is not None
            assert je.is_ciphertext(value), target.qualified
            assert je.decrypt(value) == _canary(phase, target.qualified)
    db_session.expire_all()
    entry = await db_session.get(JournalEntry, legacy_ids["journalentry"])
    assert entry is not None
    assert entry.message == _canary("legacy", _MESSAGE.qualified)

    capsys.readouterr()
    assert await sweep.run(["reencrypt", "--apply"]) == sweep.EXIT_CLEAN
    rerun = capsys.readouterr().out
    assert "encrypted=0 rotated=0" in rerun
    assert "encrypted=1" not in rerun
    assert "rotated=1" not in rerun
    _assert_no_content(rerun + caplog.text)


@pytest.mark.asyncio
async def test_without_a_key_both_commands_refuse_before_touching_the_database(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """No key: nothing to verify against and nothing to encrypt with -- so no session."""

    def _refuse_any_session() -> NoReturn:
        pytest.fail("the command opened a database session with no key configured")

    monkeypatch.setattr(sweep, "async_session_factory", _refuse_any_session)

    assert await sweep.run(["audit"]) == sweep.EXIT_INTEGRITY
    assert await sweep.run(["reencrypt", "--apply"]) == sweep.EXIT_INTEGRITY
    assert je.KEYS_ENV_VAR in capsys.readouterr().err


@pytest.mark.asyncio
async def test_an_invalid_key_is_refused_by_name_never_by_value(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A malformed key stops the command and is never quoted back."""
    sentinel = "SENTINEL-NOT-A-FERNET-KEY"  # pragma: allowlist secret
    _keys(monkeypatch, sentinel)

    assert await sweep.run(["audit"]) == sweep.EXIT_INTEGRITY

    captured = capsys.readouterr()
    assert je.KEYS_ENV_VAR in captured.err
    assert sentinel not in captured.out + captured.err


@pytest.mark.asyncio
@pytest.mark.usefixtures("_cli_session")
async def test_a_wrong_key_stops_the_sweep_before_any_write_in_the_batch(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """An undecryptable row stops the sweep; its batch is unwritten, plaintext included."""
    await _seed_every_table(db_session, "legacy")
    _keys(monkeypatch, Fernet.generate_key().decode())
    await _seed_every_table(db_session, "old")
    _keys(monkeypatch, Fernet.generate_key().decode())
    before = await _raw_everything(db_session)

    assert await sweep.run(["audit"]) == sweep.EXIT_INTEGRITY
    audit = capsys.readouterr()
    for line in _audit_counts(audit.out).values():
        assert line["undecryptable"] >= 1
        assert line["key0"] == 0

    # Dry, too: a token nothing can read is not "would rotate".
    assert await sweep.run(["reencrypt"]) == sweep.EXIT_INTEGRITY
    dry = capsys.readouterr()
    assert await sweep.run(["reencrypt", "--apply"]) == sweep.EXIT_INTEGRITY
    refusal = capsys.readouterr()

    assert await _raw_everything(db_session) == before
    first = _COLUMNS[0].qualified
    assert first in refusal.err
    _assert_no_content(audit.out + audit.err + dry.out + dry.err + refusal.out + refusal.err)


@pytest.mark.asyncio
@pytest.mark.usefixtures("_cli_session")
async def test_an_interrupted_sweep_resumes_and_finishes_on_rerun(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Batches already committed stay committed; a rerun completes only the rest."""
    for phase in ("a", "b", "c"):
        await insert_row(db_session, "journalentry", _texts(phase, "journalentry"))
    await db_session.commit()
    _keys(monkeypatch, Fernet.generate_key().decode())

    real_rotate = je.rotate
    calls = {"n": 0}

    def _fail_second(value: str) -> str:
        calls["n"] += 1
        if calls["n"] == 2:
            msg = "simulated crash mid-sweep"
            raise je.JournalEncryptionError(msg)
        return real_rotate(value)

    monkeypatch.setattr(sweep.je, "rotate", _fail_second)
    args = ["reencrypt", "--apply", "--batch-size", "1", "--start-after", f"{_MESSAGE.qualified}:0"]
    assert await sweep.run(args) == sweep.EXIT_INTEGRITY
    after_crash = sorted(await _raw(db_session, _MESSAGE))
    stored = await _raw(db_session, _MESSAGE)
    assert [je.is_ciphertext(stored[row_id] or "") for row_id in after_crash] == [
        True,
        False,
        False,
    ]

    monkeypatch.setattr(sweep.je, "rotate", real_rotate)
    assert await sweep.run(["reencrypt", "--apply", "--batch-size", "1"]) == sweep.EXIT_CLEAN
    assert await sweep.run(["audit"]) == sweep.EXIT_CLEAN


@pytest.mark.asyncio
@pytest.mark.usefixtures("_cli_session")
async def test_start_after_skips_earlier_columns_and_rows(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``--start-after table.column:id`` resumes exactly there and nowhere earlier."""
    ids = await _seed_every_table(db_session, "first")
    second = await insert_row(db_session, "journalentry", _texts("second", "journalentry"))
    await db_session.commit()
    _keys(monkeypatch, Fernet.generate_key().decode())

    start = f"{_MESSAGE.qualified}:{ids['journalentry']}"
    assert await sweep.run(["reencrypt", "--apply", "--start-after", start]) == sweep.EXIT_CLEAN

    message = await _raw(db_session, _MESSAGE)
    assert message[ids["journalentry"]] == _canary("first", _MESSAGE.qualified)
    assert je.is_ciphertext(message[second] or "")
    for target in _COLUMNS:
        stored = (await _raw(db_session, target))[ids[target.table]] or ""
        expected_rewritten = target > _MESSAGE
        assert je.is_ciphertext(stored) is expected_rewritten, target.qualified


@pytest.mark.parametrize(
    "bad",
    ["journalentry.nope:0", "journalentry.message", "journalentry.message:x", "nope:1"],
)
def test_start_after_rejects_anything_but_a_known_column_and_id(bad: str) -> None:
    """A typo in the resume point is a usage error, not a silent full rescan."""
    with pytest.raises(SystemExit) as excinfo:
        sweep.parse_args(["reencrypt", "--start-after", bad])
    assert excinfo.value.code == sweep.EXIT_USAGE


@pytest.mark.asyncio
async def test_the_write_is_compare_and_swap(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A row a user rewrote since it was read is skipped, never clobbered."""
    row_id = await insert_row(db_session, "journalentry", _texts("cas", "journalentry"))
    await db_session.commit()
    _keys(monkeypatch, Fernet.generate_key().decode())
    current = (await _raw(db_session, _MESSAGE))[row_id]
    assert current is not None
    replacement = je.rotate(current)

    written = await sweep.apply_rewrites(
        db_session, _MESSAGE, [(row_id, "a value this row no longer holds", replacement)]
    )
    assert written == 0
    assert (await _raw(db_session, _MESSAGE))[row_id] == current

    written = await sweep.apply_rewrites(db_session, _MESSAGE, [(row_id, current, replacement)])
    assert written == 1
    assert (await _raw(db_session, _MESSAGE))[row_id] == replacement


def test_main_runs_the_command_and_returns_its_exit_code() -> None:
    """The synchronous entry point drives the async command (no key: refused)."""
    assert sweep.main(["audit"]) == sweep.EXIT_INTEGRITY


@pytest.mark.parametrize("bad", ["0", "-1", "ten"])
def test_batch_size_must_be_a_positive_integer(bad: str) -> None:
    """A zero or negative page would never advance the cursor; refuse it up front."""
    with pytest.raises(SystemExit) as excinfo:
        sweep.parse_args(["audit", "--batch-size", bad])
    assert excinfo.value.code == sweep.EXIT_USAGE


@pytest.mark.asyncio
@pytest.mark.usefixtures("_cli_session")
async def test_an_applied_sweep_that_skips_a_concurrent_edit_exits_rows_remain(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A row a user rewrote mid-sweep is skipped, kept, counted, and the run exits 1.

    Exit 0 is what an operator scripts key retirement on, so a sweep that left a
    row behind must never report clean.
    """
    row_id = await insert_row(db_session, "journalentry", _texts("race", "journalentry"))
    await db_session.commit()
    _keys(monkeypatch, Fernet.generate_key().decode())
    edited = je.encrypt("the user's newer sentence")
    real_apply = sweep.apply_rewrites

    async def _user_edits_first(
        session: AsyncSession, target: EncryptedColumn, rewrites: Sequence[sweep.Rewrite]
    ) -> int:
        if target == _MESSAGE:
            raw = raw_table(target)
            await session.execute(
                update(raw).where(raw.c[ROW_ID_COLUMN] == row_id).values({target.column: edited})
            )
        return await real_apply(session, target, rewrites)

    monkeypatch.setattr(sweep, "apply_rewrites", _user_edits_first)
    capsys.readouterr()

    assert await sweep.run(["reencrypt", "--apply"]) == sweep.EXIT_ROWS_REMAIN

    out = capsys.readouterr().out
    message_line = next(line for line in out.splitlines() if f" {_MESSAGE.qualified} " in line)
    assert "skipped=1" in message_line
    assert (await _raw(db_session, _MESSAGE))[row_id] == edited
