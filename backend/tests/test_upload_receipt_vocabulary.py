"""The statuses an upload receipt may carry, pinned across enum, model and migration (#3775).

``uploadreceipt.vault_status`` is a ``VARCHAR`` guarded by a CHECK, not a
database enum. The model derives its CHECK from
:data:`~models.upload_receipt.RECEIPT_VAULT_STATUSES`; the migration that
creates the table freezes the same list as a literal, because a revision must
mean the same thing forever. Nothing but this module notices when the two part:
``create_all`` builds the test database from the model, so a status the model
admits and the deployed CHECK does not passes every unit test and fails the
first real INSERT with a 500 -- which is exactly how ``vault_busy`` (#3770) and
``unsupported_source`` (#3771) broke ``POST /corpus/import`` against a migrated
database.

Pinned here: the recordable statuses are every :class:`VaultUploadStatus`
except the unsettled ones (a busy vault is a wait, and the same document is
sent again), and the model's CHECK and the migration's frozen tuple admit
exactly those. A new member of the enum fails this module until it is either
declared unsettled or admitted by a migration that widens the deployed CHECK.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType
from typing import Final

from sqlalchemy import CheckConstraint
from sqlmodel import SQLModel

from domain.creek_vault import VaultUploadStatus
from models.upload_receipt import RECEIPT_VAULT_STATUSES, UNSETTLED_VAULT_STATUSES

_MIGRATION_FILE: Final = (
    Path(__file__).parent.parent / "migrations" / "versions" / "c4d8e1f2a7b3_add_uploadreceipt.py"
)
_TABLE: Final = "uploadreceipt"
_STATUS_CHECK: Final = "ck_uploadreceipt_vault_status_valid"


def _load_migration() -> ModuleType:
    """Import the revision module by path (versions/ is not a package)."""
    spec = importlib.util.spec_from_file_location("uploadreceipt_migration", _MIGRATION_FILE)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _model_check_text() -> str:
    """The SQL text of the model's ``vault_status`` CHECK."""
    (check,) = (
        constraint
        for constraint in SQLModel.metadata.tables[_TABLE].constraints
        if isinstance(constraint, CheckConstraint) and constraint.name == _STATUS_CHECK
    )
    return str(check.sqltext)


def test_only_a_busy_vault_is_unsettled() -> None:
    """A wait is not an answer; every other outcome, ``unsupported_source`` included, is."""
    assert frozenset({VaultUploadStatus.VAULT_BUSY}) == UNSETTLED_VAULT_STATUSES


def test_the_recordable_statuses_are_every_settled_outcome() -> None:
    """A new member of the enum is recordable unless it is declared unsettled."""
    settled = tuple(s.value for s in VaultUploadStatus if s not in UNSETTLED_VAULT_STATUSES)
    assert settled == RECEIPT_VAULT_STATUSES
    assert VaultUploadStatus.UNSUPPORTED_SOURCE.value in RECEIPT_VAULT_STATUSES
    assert VaultUploadStatus.VAULT_BUSY.value not in RECEIPT_VAULT_STATUSES


def test_the_migration_freezes_exactly_the_recordable_statuses() -> None:
    """The deployed CHECK admits what the receipt writer can write, no more and no less."""
    assert _load_migration().FROZEN_VAULT_STATUSES == RECEIPT_VAULT_STATUSES


def test_the_models_check_admits_exactly_the_recordable_statuses() -> None:
    """``create_all`` builds the same CHECK the migration deploys."""
    expected = "vault_status IN ({})".format(
        ", ".join(f"'{value}'" for value in RECEIPT_VAULT_STATUSES)
    )
    assert _model_check_text() == expected
