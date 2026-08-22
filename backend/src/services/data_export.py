"""Assemble one account's archive and hand it out a chunk at a time.

The manifest (:mod:`domain.data_export`) says *what* leaves; this module issues
the statements and writes the bytes. Three properties are load-bearing.

**It streams.** A long-tenured account is the whole point of the feature and
also the case a buffered response fails: the archive is built as it is sent, a
page of rows at a time, so the first bytes reach the client before the last row
has been read and no proxy is left waiting on a total nobody knows in advance.
Paging is keyset (``id > cursor``) rather than ``OFFSET``, so the hundredth
page costs what the first one did.

**It reads through the ORM, never the raw column.** Journal text is encrypted
at rest, and the only thing standing between a user and an archive full of
``enc::v1::…`` is that every value is read off a mapped attribute, which is
where :class:`~services.journal_encryption.EncryptedString` decrypts. There is
no second decryption path here, and there must never be one.

**It logs that an export happened and nothing about what it said.** The event
carries the account id and a row count. Anything more would put the contents of
the most private file in the product into whatever aggregator collects the logs
— which is the one place the encryption at rest was meant to keep them out of.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Any

from sqlalchemy import Table, literal, select, tuple_
from sqlmodel import SQLModel, col

from domain.data_export import (
    EXPORT_FORMAT,
    EXPORT_FORMAT_VERSION,
    EXPORT_PAGE_SIZE,
    Included,
    included_rules,
    omitted_rules,
)
from domain.ownership import OwnedBy, owner_predicate
from models.journal_entry import JournalEntry

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

# The single log line an export is allowed to emit. Counts only — see the
# module docstring.
_AUDIT_EVENT = "data_exported"

_ID_COLUMN = "id"
_USER_SENDER = "user"
_JOURNAL_TABLE = "journalentry"

# What the Markdown companion calls itself, and the line under it explaining
# what a reader is holding.
_MARKDOWN_FORMAT = "markdown"
_MARKDOWN_TITLE = "# Your Adepthood journal"
_MARKDOWN_LEAD = (
    "Everything you wrote, oldest first, exactly as you wrote it. Entries you deleted are not here."
)


@dataclass(frozen=True)
class ExportSubject:
    """Whose archive this is. Resolved from the caller's token, never from input."""

    user_id: int
    email: str


@dataclass
class _Tally:
    """How many rows an in-flight archive has written, for the audit line."""

    rows: int = 0


def _json_default(value: object) -> str:
    """Render the few column types JSON has no literal for.

    Deliberately narrow: an unrecognised type raises rather than being coerced
    to ``str``, because a silent ``repr`` in an archive is a value the user
    cannot read and cannot re-import.
    """
    if isinstance(value, datetime | date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    msg = f"an export cannot serialise {type(value).__name__}"
    raise TypeError(msg)


def _encode(value: object) -> str:
    """One JSON fragment, with the archive's shared type handling applied."""
    return json.dumps(value, default=_json_default)


def _manifest_parent(name: str) -> tuple[Table, OwnedBy]:
    """A parent table and how the manifest says *that* table is owned."""
    return SQLModel.metadata.tables[name], included_rules()[name].owned_by


def _table_of(name: str) -> Table:
    """The live table one manifest rule is about."""
    return SQLModel.metadata.tables[name]


def _collections() -> Iterator[tuple[Table, Included]]:
    """Every exported table, ordered by the name it appears under.

    Ordering by the collection name rather than by the table name keeps the
    archive's key order stable and alphabetical for a human reading it, and
    independent of anything the schema is later renamed to.
    """
    ordered = sorted(included_rules().items(), key=lambda item: item[1].key)
    return ((_table_of(name), rule) for name, rule in ordered)


def _row_values(row: object, table: Table) -> dict[str, Any]:
    """Every column of one row, read off the mapped attribute.

    Going through the attribute rather than the raw column is what applies
    ``EncryptedString`` and yields the user's own words.
    """
    return {column.name: getattr(row, column.name) for column in table.columns}


async def _page(
    session: AsyncSession,
    table: Table,
    rule: Included,
    subject: ExportSubject,
    cursor: int,
) -> list[Any]:
    """One keyset page of a table's rows for this account, as ORM instances."""
    statement = (
        select(rule.model)
        .where(
            owner_predicate(
                table,
                rule.owned_by,
                user_id=subject.user_id,
                email=subject.email,
                parent_lookup=_manifest_parent,
            ),
        )
        .where(table.c[_ID_COLUMN] > cursor)
        .order_by(table.c[_ID_COLUMN])
        .limit(EXPORT_PAGE_SIZE)
    )
    result = await session.execute(statement)
    return list(result.scalars().all())


def _exported_row(
    row: object,
    table: Table,
    dropped: frozenset[str],
) -> tuple[int, dict[str, Any]]:
    """One row's id, and its values with the withheld columns stripped.

    The id comes back separately because it is the paging cursor and may itself
    be withheld — on ``user`` it is the ownership column, so it never reaches
    the archive even though the loop still needs it.
    """
    values = _row_values(row, table)
    identifier = int(values[_ID_COLUMN])
    return identifier, {name: value for name, value in values.items() if name not in dropped}


async def _iter_rows(
    session: AsyncSession,
    table: Table,
    rule: Included,
    subject: ExportSubject,
) -> AsyncIterator[dict[str, Any]]:
    """Yield one account's rows of one table, withheld columns already stripped.

    Pages until a page comes back empty, carrying the last id forward as the
    cursor, so memory holds one page rather than one table.
    """
    dropped = rule.dropped()
    cursor = 0
    while True:
        rows = await _page(session, table, rule, subject, cursor)
        if not rows:
            return
        for row in rows:
            cursor, values = _exported_row(row, table, dropped)
            yield values


async def _stream_collection(
    session: AsyncSession,
    table: Table,
    rule: Included,
    subject: ExportSubject,
    tally: _Tally,
) -> AsyncIterator[str]:
    """Yield one ``"key": [ … ]`` member of the archive, a row at a time."""
    yield f"{_encode(rule.key)}:["
    separator = ""
    async for values in _iter_rows(session, table, rule, subject):
        tally.rows += 1
        yield separator + _encode(values)
        separator = ","
    yield "]"


def _archive_preamble() -> str:
    """The archive's self-description, written before any row is read."""
    header = {
        "format": EXPORT_FORMAT,
        "format_version": EXPORT_FORMAT_VERSION,
        "exported_at": datetime.now(UTC),
    }
    fields = ",".join(f"{_encode(key)}:{_encode(value)}" for key, value in header.items())
    return "{" + fields + ',"records":{'


def _archive_epilogue() -> str:
    """The closing brace, plus what the archive deliberately does not contain."""
    return "}," + _encode("not_included") + ":" + _encode(dict(omitted_rules())) + "}"


def _record_audit(subject: ExportSubject, tally: _Tally, archive_format: str) -> None:
    """Note that an export completed. Counts only — never a line of it."""
    logger.info(
        _AUDIT_EVENT,
        extra={
            "user_id": subject.user_id,
            "records_exported": tally.rows,
            "archive_format": archive_format,
        },
    )


async def stream_json_export(
    session: AsyncSession,
    subject: ExportSubject,
) -> AsyncIterator[str]:
    """Yield the complete JSON archive for one account, chunk by chunk.

    The document is assembled as text rather than built as a ``dict`` and dumped
    at the end, because holding the whole archive in memory is the thing this
    design exists to avoid.
    """
    tally = _Tally()
    yield _archive_preamble()
    separator = ""
    for table, rule in _collections():
        yield separator
        separator = ","
        async for chunk in _stream_collection(session, table, rule, subject, tally):
            yield chunk
    yield _archive_epilogue()
    _record_audit(subject, tally, EXPORT_FORMAT)


def _entry_heading(values: dict[str, Any]) -> str:
    """``## <date> — <title>``, or just the date when the entry has no title."""
    stamp = values["timestamp"].date().isoformat()
    title = values["title"]
    return f"## {stamp} — {title}" if title else f"## {stamp}"


def _entry_byline(values: dict[str, Any]) -> str:
    """The italic line under the heading: privacy tier, tag, and who spoke."""
    parts = [str(values["classification"]), str(values["tag"])]
    if values["sender"] != _USER_SENDER:
        parts.append(f"written by {values['sender']}")
    return " · ".join(parts)


def _render_entry(values: dict[str, Any]) -> str:
    """One entry as Markdown, separated from the next by a rule."""
    return "\n".join(
        (
            _entry_heading(values),
            "",
            f"*{_entry_byline(values)}*",
            "",
            str(values["message"]),
            "",
            "---",
            "",
            "",
        ),
    )


async def _journal_page(
    session: AsyncSession,
    subject: ExportSubject,
    cursor: tuple[datetime, int] | None,
) -> list[JournalEntry]:
    """One chronological page of the account's live entries.

    The keyset is ``(timestamp, id)`` rather than ``id`` alone so a backdated
    entry lands where it was written about rather than where it was typed, and
    so a page boundary can never fall between two entries sharing an instant.
    """
    ordering = (col(JournalEntry.timestamp), col(JournalEntry.id))
    statement = (
        select(JournalEntry)
        .where(col(JournalEntry.user_id) == subject.user_id)
        .where(col(JournalEntry.deleted_at).is_(None))
        .order_by(*ordering)
        .limit(EXPORT_PAGE_SIZE)
    )
    if cursor is not None:
        instant, last_id = cursor
        statement = statement.where(
            tuple_(*ordering) > tuple_(literal(instant), literal(last_id)),
        )
    result = await session.execute(statement)
    return list(result.scalars().all())


async def stream_journal_markdown(
    session: AsyncSession,
    subject: ExportSubject,
) -> AsyncIterator[str]:
    """Yield the account's journal as Markdown — the half a person can just read."""
    tally = _Tally()
    table = _table_of(_JOURNAL_TABLE)
    yield f"{_MARKDOWN_TITLE}\n\n{_MARKDOWN_LEAD}\n\n"
    cursor: tuple[datetime, int] | None = None
    while True:
        entries = await _journal_page(session, subject, cursor)
        if not entries:
            break
        for entry in entries:
            tally.rows += 1
            yield _render_entry(_row_values(entry, table))
        last = entries[-1]
        cursor = (last.timestamp, int(last.id or 0))
    _record_audit(subject, tally, _MARKDOWN_FORMAT)
