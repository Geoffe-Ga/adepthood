"""The ``CourseStage`` table: one row per APTITUDE Stage."""

from __future__ import annotations

from datetime import datetime
from typing import Final

from sqlalchemy import Column, DateTime, String
from sqlalchemy.engine.default import DefaultExecutionContext
from sqlmodel import Field, SQLModel

from domain.stage_keys import STAGE_KEY_MAX_LENGTH, legacy_stage_key

#: Width of the ``source_repo`` provenance column (``owner/name``).
SOURCE_REPO_MAX_LENGTH: Final[int] = 255
#: Width of the ``source_sha`` column: a full git commit sha.
SOURCE_SHA_LENGTH: Final[int] = 40
#: Width of the ``source_path`` column: a path inside the source repository.
SOURCE_PATH_MAX_LENGTH: Final[int] = 512
#: Width of the ``source_sha256`` column: a hex sha256 digest.
SOURCE_SHA256_LENGTH: Final[int] = 64
#: Width of the ``artifact_schema_version`` column (a semantic version).
SCHEMA_VERSION_MAX_LENGTH: Final[int] = 32


def _derived_stage_key(context: DefaultExecutionContext) -> str:
    """Default ``stage_key`` from the row's own ``stage_number`` at INSERT time.

    The seeder always sets the key explicitly; this default exists so a row
    built without one (a hand-built test row, say) still satisfies the
    NOT NULL, unique column with the same key the migration would backfill.
    """
    # ``current_parameters`` is the row being inserted, one per row even when
    # the ORM batches several rows into one INSERT (insertmanyvalues).
    parameters = context.current_parameters or {}
    return legacy_stage_key(int(parameters["stage_number"]))


class CourseStage(SQLModel, table=True):
    """Represents a single educational stage in the APTITUDE course.

    Includes metadata used for organizing curriculum content, contextually
    relevant theory (e.g., Spiral Dynamics color, developmental stage, etc.),
    and aesthetic display.

    ``stage_key`` is the Stage's stable colour-slug identity (``beige`` ..
    ``clearlight``), unique and NOT NULL in the database (migration
    ``d7f9b1c3e5a2``). It reads ``None`` only on an instance that has not been
    flushed yet and was built without one; INSERT derives it from
    ``stage_number``. The ``source_*``, ``artifact_schema_version`` and
    ``reconciled_at`` columns record which stage-correspondence artifact the
    seeder last reconciled the row from; they stay ``NULL`` until it does.
    """

    id: int | None = Field(default=None, primary_key=True)
    stage_key: str | None = Field(
        default=None,
        sa_column=Column(
            String(STAGE_KEY_MAX_LENGTH),
            nullable=False,
            default=_derived_stage_key,
        ),
    )
    title: str
    subtitle: str
    stage_number: int
    overview_url: str
    category: str
    aspect: str
    spiral_dynamics_color: str
    growing_up_stage: str
    divine_gender_polarity: str
    relationship_to_free_will: str
    free_will_description: str
    source_repo: str | None = Field(
        default=None, sa_column=Column(String(SOURCE_REPO_MAX_LENGTH), nullable=True)
    )
    source_sha: str | None = Field(
        default=None, sa_column=Column(String(SOURCE_SHA_LENGTH), nullable=True)
    )
    source_path: str | None = Field(
        default=None, sa_column=Column(String(SOURCE_PATH_MAX_LENGTH), nullable=True)
    )
    source_sha256: str | None = Field(
        default=None, sa_column=Column(String(SOURCE_SHA256_LENGTH), nullable=True)
    )
    artifact_schema_version: str | None = Field(
        default=None, sa_column=Column(String(SCHEMA_VERSION_MAX_LENGTH), nullable=True)
    )
    reconciled_at: datetime | None = Field(
        default=None, sa_column=Column(DateTime(timezone=True), nullable=True)
    )
