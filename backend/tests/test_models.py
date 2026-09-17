"""Schema-contract tests for the ``models`` package.

These pin the load-bearing facts a mutation could silently break — table names,
primary keys, foreign keys + ``ondelete``, unique constraints, column types /
nullability, and relationship ``back_populates`` pairs. The previous tests only
checked that each discovered object "is a class" with a ``str`` ``__name__``,
which survived renaming a column, flipping nullability, or dropping an FK.

Assertions go through SQLAlchemy's ``Model.__table__`` / ``__mapper__`` so they
fail when the underlying schema changes, not just the Python attribute.
"""

from __future__ import annotations

import importlib
import re
from pathlib import Path
from typing import cast

import pytest
from sqlalchemy import DateTime, Table
from sqlalchemy import inspect as sa_inspect
from sqlalchemy.orm import Mapper
from sqlmodel import SQLModel

from models import (
    ContentCompletion,
    CourseStage,
    EnergyPlan,
    Goal,
    GoalCompletion,
    GoalGroup,
    Habit,
    JournalEntry,
    LicenseBinding,
    LLMUsageLog,
    LoginAttempt,
    PasswordResetToken,
    Practice,
    PracticeRecipe,
    PracticeRecipeStep,
    PracticeSession,
    PracticeSessionSpend,
    PracticeShareLink,
    PracticeTag,
    PromptResponse,
    RevokedToken,
    StageContent,
    StageProgress,
    User,
    UserPractice,
    WalletAudit,
)

# Every table model maps to exactly this table name (renaming a table fails here).
EXPECTED_TABLES: dict[type, str] = {
    User: "user",
    Habit: "habit",
    Goal: "goal",
    GoalCompletion: "goalcompletion",
    GoalGroup: "goalgroup",
    JournalEntry: "journalentry",
    PromptResponse: "promptresponse",
    StageProgress: "stageprogress",
    StageContent: "stagecontent",
    PracticeSession: "practicesession",
    UserPractice: "userpractice",
    Practice: "practice",
    PracticeShareLink: "practicesharelink",
    PracticeTag: "practicetag",
    PracticeRecipe: "practicerecipe",
    PracticeRecipeStep: "practicerecipestep",
    ContentCompletion: "contentcompletion",
    EnergyPlan: "energyplan",
    PracticeSessionSpend: "practicesessionspend",
    WalletAudit: "walletaudit",
    LLMUsageLog: "llmusagelog",
    PasswordResetToken: "passwordresettoken",  # pragma: allowlist secret
    CourseStage: "coursestage",
    LoginAttempt: "loginattempt",
    RevokedToken: "revokedtoken",  # pragma: allowlist secret
    LicenseBinding: "licensebinding",
}

# (Model, column, target_table, expected_ondelete) — ``None`` means no ondelete.
FOREIGN_KEYS: list[tuple[type, str, str, str | None]] = [
    (Habit, "user_id", "user", "CASCADE"),
    (Goal, "habit_id", "habit", "CASCADE"),
    (Goal, "goal_group_id", "goalgroup", "SET NULL"),
    (GoalCompletion, "goal_id", "goal", "CASCADE"),
    (GoalCompletion, "user_id", "user", "CASCADE"),
    (GoalGroup, "user_id", "user", "SET NULL"),
    (JournalEntry, "user_id", "user", "CASCADE"),
    (JournalEntry, "practice_session_id", "practicesession", None),
    (JournalEntry, "user_practice_id", "userpractice", None),
    (PromptResponse, "user_id", "user", "CASCADE"),
    (StageProgress, "user_id", "user", "CASCADE"),
    (StageContent, "course_stage_id", "coursestage", None),
    (PracticeSession, "user_id", "user", "CASCADE"),
    (PracticeSession, "user_practice_id", "userpractice", None),
    (UserPractice, "user_id", "user", "CASCADE"),
    (UserPractice, "practice_id", "practice", None),
    (PracticeShareLink, "practice_id", "practice", "CASCADE"),
    (PracticeShareLink, "created_by_user_id", "user", "SET NULL"),
    (PracticeTag, "owner_user_id", "user", "CASCADE"),
    (PracticeRecipe, "owner_user_id", "user", "CASCADE"),
    (PracticeRecipeStep, "recipe_id", "practicerecipe", "CASCADE"),
    (ContentCompletion, "user_id", "user", "CASCADE"),
    (ContentCompletion, "content_id", "stagecontent", None),
    (EnergyPlan, "user_id", "user", "CASCADE"),
    (PracticeSessionSpend, "user_id", "user", "CASCADE"),
    (PracticeSessionSpend, "session_id", "practicesession", "CASCADE"),
    (WalletAudit, "user_id", "user", "CASCADE"),
    (WalletAudit, "actor_user_id", "user", "SET NULL"),
    (LLMUsageLog, "user_id", "user", "CASCADE"),
    (LLMUsageLog, "journal_entry_id", "journalentry", None),
    (PasswordResetToken, "user_id", "user", "CASCADE"),
    (LicenseBinding, "user_id", "user", "CASCADE"),
]

# Named composite UNIQUE constraints that must exist on the table.
COMPOSITE_UNIQUES: list[tuple[type, str]] = [
    (PromptResponse, "uq_promptresponse_user_week"),
    (PracticeSessionSpend, "uq_practicesessionspend_user_idem_key"),
    (ContentCompletion, "uq_contentcompletion_user_content"),
    (LicenseBinding, "uq_licensebinding_gumroad_sale_id"),
]

# (Model, attr, expected back_populates) relationship pairs.
RELATIONSHIPS: list[tuple[type, str, str]] = [
    (User, "habits", "user"),
    (Habit, "user", "habits"),
    (Habit, "goals", "habit"),
    (Goal, "habit", "goals"),
    (Goal, "completions", "goal"),
    (GoalCompletion, "goal", "completions"),
    (Goal, "goal_group", "goals"),
    (GoalGroup, "goals", "goal_group"),
    (User, "stage_progress", "user"),
    (StageProgress, "user", "stage_progress"),
    (User, "journals", "user"),
    (JournalEntry, "user", "journals"),
]


def _table(model: type[SQLModel]) -> Table:
    """Return the mapped :class:`Table` for a model (typed for mypy)."""
    return cast("Table", _mapper(model).local_table)


def _mapper(model: type[SQLModel]) -> Mapper[SQLModel]:
    """Return the ORM mapper for a model (carries the relationship registry)."""
    return cast("Mapper[SQLModel]", sa_inspect(model))


@pytest.mark.parametrize(("model", "table"), list(EXPECTED_TABLES.items()))
def test_table_name(model: type[SQLModel], table: str) -> None:
    """Each model maps to its expected table name."""
    assert _table(model).name == table


@pytest.mark.parametrize("model", list(EXPECTED_TABLES))
def test_has_primary_key(model: type[SQLModel]) -> None:
    """Every table defines at least one primary-key column."""
    assert len(_table(model).primary_key.columns) >= 1


@pytest.mark.parametrize(("model", "column", "target", "ondelete"), FOREIGN_KEYS)
def test_foreign_key_target_and_ondelete(
    model: type[SQLModel], column: str, target: str, ondelete: str | None
) -> None:
    """Each FK points at the right table with the right ``ondelete`` rule."""
    fks = list(_table(model).columns[column].foreign_keys)
    assert len(fks) == 1, f"{model.__name__}.{column} should have exactly one FK"
    fk = fks[0]
    assert fk.column.table.name == target
    assert fk.ondelete == ondelete


@pytest.mark.parametrize(("model", "constraint_name"), COMPOSITE_UNIQUES)
def test_composite_unique_constraint(model: type[SQLModel], constraint_name: str) -> None:
    """The named composite UNIQUE constraint exists on the table."""
    names = {c.name for c in _table(model).constraints}
    assert constraint_name in names


@pytest.mark.parametrize(("model", "attr", "back_populates"), RELATIONSHIPS)
def test_relationship_back_populates(model: type[SQLModel], attr: str, back_populates: str) -> None:
    """Relationship pairs declare matching ``back_populates``."""
    rel = _mapper(model).relationships[attr]
    assert rel.back_populates == back_populates


def test_single_column_unique_fields() -> None:
    """``unique=True`` scalar columns carry the constraint at the column level."""
    assert _table(User).columns["email"].unique is True
    assert _table(StageProgress).columns["user_id"].unique is True
    assert _table(PracticeShareLink).columns["token"].unique is True


def _max_length(model: type[SQLModel], column: str) -> int:
    """Return a string column's declared length (SQLModel uses ``AutoString``)."""
    length = getattr(_table(model).columns[column].type, "length", None)
    assert isinstance(length, int)
    return length


def test_string_column_max_lengths() -> None:
    """Length-bounded text columns keep their declared ``max_length``."""
    assert _max_length(Practice, "name") == 255
    assert _max_length(User, "email") == 254
    assert _max_length(PracticeShareLink, "token") == 64
    assert _max_length(RevokedToken, "jti") == 64


@pytest.mark.parametrize(
    ("model", "column"),
    [(GoalCompletion, "timestamp"), (RevokedToken, "expires_at")],
)
def test_datetime_columns_are_tz_aware_non_null(model: type[SQLModel], column: str) -> None:
    """Timestamp columns are non-null timezone-aware DateTimes."""
    col = _table(model).columns[column]
    assert isinstance(col.type, DateTime)
    assert col.type.timezone is True
    assert col.nullable is False


def test_key_columns_are_non_null() -> None:
    """Owner FKs that anchor a row are NOT NULL (a row cannot orphan)."""
    assert _table(Habit).columns["user_id"].nullable is False
    assert _table(GoalCompletion).columns["goal_id"].nullable is False
    assert _table(PracticeSession).columns["user_id"].nullable is False


def test_no_runtime_side_effects_on_import() -> None:
    """Guard against engines/sessions created at import time."""
    mod = importlib.import_module("models")
    for attr in ("engine", "SessionLocal", "session", "db"):
        assert not hasattr(mod, attr), (
            f"Module unexpectedly defines runtime object '{attr}' at import time."
        )


# Where the package lives, and where its modules do. Walked rather than listed,
# because a list of modules is the thing that goes stale.
_MODELS_PACKAGE = Path(cast("str", importlib.import_module("models").__file__)).parent

# A ``table=True`` class declaration, as every model in this package spells one.
_TABLE_CLASS = re.compile(r"^class\s+(\w+)\((?:[^)]*\b)?table\s*=\s*True", re.MULTILINE)


def _declared_table_classes() -> dict[str, str]:
    """Every ``table=True`` class in the package, mapped to the module declaring it."""
    declared: dict[str, str] = {}
    for path in sorted(_MODELS_PACKAGE.glob("*.py")):
        if path.name.startswith("_"):
            continue
        for name in _TABLE_CLASS.findall(path.read_text(encoding="utf-8")):
            declared[name] = path.name
    return declared


def test_every_table_model_is_imported_by_the_package() -> None:
    """``import models`` must register every table on ``SQLModel.metadata``.

    Load-bearing well beyond tidiness, and it failed silently once.
    ``migrations/env.py`` reaches the schema through exactly one statement --
    ``import models`` -- and hands ``SQLModel.metadata`` to Alembic as
    ``target_metadata``. A model the package never imports is therefore invisible
    to ``alembic check``, the CI gate that proves a migration matches the models
    it claims to create. The table still works at runtime, because the router
    that uses it imports its module directly; what stops working is the gate, and
    a gate that cannot fail is worse than no gate, because it gets deferred to.

    Driven off the source text rather than off ``SQLModel.metadata``, on purpose:
    reading the metadata would only report what some *other* import already
    registered, which is the coincidence this test exists to stop depending on.
    """
    declared = _declared_table_classes()
    assert declared, "found no table models; the scan matched nothing"

    package = importlib.import_module("models")
    missing = sorted(
        f"{name} ({module})" for name, module in declared.items() if not hasattr(package, name)
    )
    assert missing == [], (
        f"models/__init__.py does not import {missing}; alembic check cannot see them"
    )


def test_every_table_model_reaches_the_metadata_alembic_reflects() -> None:
    """The consequence of the import, stated where a reader will look for it."""
    package = importlib.import_module("models")
    tables = SQLModel.metadata.tables

    for name in _declared_table_classes():
        model = cast("type[SQLModel]", getattr(package, name))
        assert model.__tablename__ in tables, name
