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

import pytest
from sqlmodel import SQLModel

from domain.data_export import (
    MANIFEST,
    Included,
    Omitted,
    included_rules,
    manifest_gaps,
)
from services.journal_encryption import EncryptedString

# Columns that hold a live secret. None of them belongs in a plaintext archive
# a user is invited to keep on their own device.
_CREDENTIAL_COLUMNS = frozenset({"password_hash", "api_key", "token", "token_hash"})


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
