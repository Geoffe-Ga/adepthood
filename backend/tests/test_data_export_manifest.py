"""The export manifest, checked against the schema rather than against belief.

A hand-written list of "what the export includes" is true on the day it is
written. The failure mode is a model somebody adds later that nobody remembers
to add here — and unlike a missing deletion policy, a missing export rule is
silent: the endpoint keeps returning 200 and simply stops carrying part of the
user's writing.

So the manifest is total by construction, exactly as the deletion policy is:
every table in the ORM metadata must carry a rule saying it is exported or
saying why it is not. These tests are what make that claim checkable, and they
are what a new model trips.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, date, datetime
from decimal import Decimal

import pytest
from sqlalchemy import Column
from sqlalchemy.types import TypeEngine
from sqlmodel import SQLModel

from domain.data_export import (
    EXPORTABLE_TYPES,
    MANIFEST,
    Included,
    Omitted,
    included_rules,
    manifest_gaps,
)
from services.data_export import _SOFT_DELETE_COLUMN, _encode
from services.journal_encryption import EncryptedString

# Columns that hold a live secret. None of them belongs in a plaintext archive
# a user is invited to keep on their own device.
_CREDENTIAL_COLUMNS = frozenset({"password_hash", "api_key", "token", "token_hash"})

# One value per type the manifest is allowed to export, so the serialiser can
# be exercised on each rather than asserted about.
_SAMPLE_VALUES: Mapping[type, object] = {
    str: "a",
    int: 1,
    float: 1.5,
    bool: True,
    datetime: datetime(2026, 1, 1, tzinfo=UTC),
    date: date(2026, 1, 1),
    Decimal: Decimal("1.5"),
    list: [1, "a"],
    dict: {"a": 1},
}


def _exported_python_type(column: Column[object]) -> type | None:
    """The Python type a column hands the serialiser, seen through decorators.

    ``AutoString`` and ``EncryptedString`` both decorate ``String`` and both
    raise from ``python_type`` rather than answering, so asking the column
    directly would mark 57 perfectly ordinary text columns unrenderable. What
    reaches ``json.dumps`` is the implementation type. ``None`` means nothing
    in the chain would say — which is not a column to wave through, it is
    precisely the unknown this guard exists to catch.
    """
    try:
        return column.type.python_type
    except NotImplementedError:
        implementation: TypeEngine[object] | None = getattr(column.type, "impl_instance", None)
    if implementation is None:
        return None
    try:
        return implementation.python_type
    except NotImplementedError:
        return None


def test_manifest_covers_the_live_schema() -> None:
    """Every table is either exported or explicitly, reasonedly, left out."""
    assert manifest_gaps(SQLModel.metadata) == ()


def test_every_table_in_the_manifest_still_exists() -> None:
    """A rule for a table the schema dropped is stale bookkeeping, not coverage."""
    assert set(MANIFEST) <= set(SQLModel.metadata.tables)


@pytest.mark.parametrize("table_name", sorted(MANIFEST))
def test_every_rule_states_a_reason(table_name: str) -> None:
    """Inclusion and omission both have to be argued, not merely decided."""
    assert MANIFEST[table_name].rationale.strip()


def test_collection_names_are_unique() -> None:
    """Two tables filed under one key would silently overwrite each other."""
    keys = [rule.key for rule in included_rules().values()]
    assert len(keys) == len(set(keys))


@pytest.mark.parametrize("table_name", sorted(included_rules()))
def test_every_exported_table_is_paged_by_an_integer_id(table_name: str) -> None:
    """Keyset paging is what keeps a long corpus streaming; it needs ``id``."""
    primary_key = list(SQLModel.metadata.tables[table_name].primary_key)
    assert [column.name for column in primary_key] == ["id"]


@pytest.mark.parametrize("table_name", sorted(included_rules()))
def test_no_exported_table_carries_a_credential_into_the_archive(table_name: str) -> None:
    """A secret in the export is a secret on whatever device the file lands on."""
    rule = included_rules()[table_name]
    columns = {column.name for column in SQLModel.metadata.tables[table_name].columns}
    assert not (columns & _CREDENTIAL_COLUMNS) - set(rule.drop_columns)


def test_every_omission_names_a_table_the_user_did_not_write() -> None:
    """The one thing an omission may never be is the user's own journal text."""
    omitted = {name for name, rule in MANIFEST.items() if isinstance(rule, Omitted)}
    encrypted_text_tables = {
        table.name
        for table in SQLModel.metadata.tables.values()
        if any(isinstance(column.type, EncryptedString) for column in table.columns)
    }
    # ``uservaultconfig`` is the one encrypted column that is a credential
    # rather than writing, and it is omitted for exactly that reason.
    assert omitted & encrypted_text_tables == {"uservaultconfig"}


def test_the_journal_is_exported() -> None:
    """The floor of the whole feature, asserted where it cannot drift."""
    rule = MANIFEST["journalentry"]
    assert isinstance(rule, Included)
    assert rule.key == "journal_entries"


@pytest.mark.parametrize("table_name", sorted(included_rules()))
def test_every_exported_column_is_one_the_archive_can_render(table_name: str) -> None:
    """A type the serialiser has never seen would truncate a live archive.

    The rows are streamed, so the ``200`` and the opening braces are already on
    the wire before the first unrenderable value is reached. A ``TypeError``
    there does not become a ``500``; it becomes a half-written file the user is
    told is their data. Catching it against the schema is the only place the
    failure is still cheap.
    """
    rule = included_rules()[table_name]
    withheld = rule.dropped()
    presented = {
        column.name: _exported_python_type(column)
        for column in SQLModel.metadata.tables[table_name].columns
        if column.name not in withheld
    }
    offenders = {
        name: python_type
        for name, python_type in presented.items()
        if python_type not in EXPORTABLE_TYPES
    }
    assert not offenders, (
        f"{table_name} exports {offenders}, which _json_default cannot render; "
        "teach the serialiser the type or drop the column from the manifest"
    )


@pytest.mark.parametrize("python_type", EXPORTABLE_TYPES)
def test_the_serialiser_renders_every_type_the_manifest_is_allowed(
    python_type: type,
) -> None:
    """``EXPORTABLE_TYPES`` is a promise about ``_json_default``, not a wish.

    The test above trusts that tuple to describe what the archive can write. If
    the tuple were widened without teaching the serialiser, that test would go
    on passing while exports broke — so this one closes the loop from the other
    side.
    """
    sample = _SAMPLE_VALUES.get(python_type)
    assert sample is not None, (
        f"{python_type.__name__} was added to EXPORTABLE_TYPES without a sample, "
        "so nothing here ever asks the serialiser whether it can render one"
    )
    assert _encode(sample)


def test_the_archive_knows_which_exported_tables_can_be_soft_deleted() -> None:
    """The filter is structural, so this pins what it currently covers.

    ``_page`` excludes ``deleted_at IS NOT NULL`` for any included table that
    carries the column, rather than each rule opting in — opting in is exactly
    what failed, since the Markdown route remembered and the JSON route did
    not. This test is the record of which tables that reaches today, so a new
    soft-deletable table shows up here as a diff and gets a deliberate look
    rather than silently inheriting a policy nobody chose for it.
    """
    soft_deletable = {
        name for name in included_rules() if _SOFT_DELETE_COLUMN in SQLModel.metadata.tables[name].c
    }
    assert soft_deletable == {"journalentry", "user"}, (
        f"the set of soft-deletable exported tables changed to {sorted(soft_deletable)}; "
        "confirm the archive should omit that table's deleted rows, then update this"
    )
