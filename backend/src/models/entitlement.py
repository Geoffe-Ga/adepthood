"""Per-user entitlements — the "may access paid content" ledger.

An ``Entitlement`` row records that a user holds one kind of access (today
only ``course_access``), where it came from (the Gumroad sale that funded
it, when known), and its lifecycle (granted, optionally revoked). A
dedicated table rather than a boolean on ``User`` because entitlements have
their own lifecycle and more kinds are anticipated (BotMason tokens,
cohort-gated content).

At most one *active* entitlement (``revoked_at IS NULL``) may exist per
``(user_id, kind)``, enforced by a partial unique index declared with both
``postgresql_where`` and ``sqlite_where`` so ``metadata.create_all`` renders
the same constraint on the SQLite test database — no conftest mirror needed.
"""

import enum
from datetime import UTC, datetime

from sqlalchemy import JSON, CheckConstraint, Column, DateTime, ForeignKey, Index
from sqlmodel import Field, SQLModel

# Generous ceiling for the ``kind`` discriminator column; the longest current
# member ("course_access") is 13 characters.
_KIND_MAX = 32


class EntitlementKind(enum.StrEnum):
    """The kinds of access an entitlement can grant.

    ``COURSE_ACCESS`` is the paid-course gate; future kinds (e.g. BotMason
    token bundles) extend this enum and the derived CHECK constraint follows
    automatically.
    """

    COURSE_ACCESS = "course_access"


def _kind_check() -> CheckConstraint:
    """CHECK derived from ``EntitlementKind`` so the DB set can't drift."""
    quoted = ", ".join(f"'{kind.value}'" for kind in EntitlementKind)
    return CheckConstraint(f"kind IN ({quoted})", name="ck_entitlement_kind_valid")


# Bound at module scope so :class:`Index`'s ``*_where`` predicate can resolve
# the column at table-creation time (mirrors ``models.metta_return_arc``).
# Both Postgres and SQLite accept the same ``IS NULL`` form, so the partial
# unique index renders on the test SQLite DB via ``metadata.create_all`` and
# stays drift-free against the migration.
_REVOKED_AT_COLUMN = Column("revoked_at", DateTime(timezone=True), nullable=True)


class Entitlement(SQLModel, table=True):
    """One user's grant of a single access kind, with lifecycle timestamps.

    The partial unique index ``ix_entitlement_user_kind_active`` on
    ``(user_id, kind)`` WHERE ``revoked_at IS NULL`` guarantees a single live
    grant per user per kind while permitting any number of revoked historical
    rows, so revoke-then-regrant always works.

    Naming note: SQLModel reserves the attribute name ``metadata`` (it is the
    SQLAlchemy ``MetaData`` registry), so the JSON extensibility bag lives on
    the Python attribute ``entitlement_metadata`` mapped to the database
    column ``metadata``.
    """

    __table_args__ = (
        _kind_check(),
        Index(
            "ix_entitlement_user_kind_active",
            "user_id",
            "kind",
            unique=True,
            postgresql_where=_REVOKED_AT_COLUMN.is_(None),
            sqlite_where=_REVOKED_AT_COLUMN.is_(None),
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", ondelete="CASCADE", index=True)
    kind: str = Field(default=EntitlementKind.COURSE_ACCESS, max_length=_KIND_MAX)
    # The Gumroad SKU that funded the grant, when known (manual grants omit it).
    product_id: str | None = Field(default=None)
    # Nullable FK, no ondelete cascade: deleting a sale row must never
    # silently revoke access — the link is provenance, not a dependency.
    source_sale_id: int | None = Field(
        default=None,
        sa_column=Column(ForeignKey("gumroadsale.id"), nullable=True),
    )
    granted_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    revoked_at: datetime | None = Field(default=None, sa_column=_REVOKED_AT_COLUMN)
    # Extensibility bag so future per-grant facts need no migration; see the
    # class docstring for the attribute-vs-column naming.
    entitlement_metadata: dict[str, object] = Field(
        default_factory=dict,
        sa_column=Column("metadata", JSON, nullable=False),
    )
