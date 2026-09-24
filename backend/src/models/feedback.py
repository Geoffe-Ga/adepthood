"""One private beta report: what a tester wrote, plus a tiny approved envelope.

The shape of this table is the whole privacy argument for the feature, so it is
worth stating rather than inferring from the columns.

*What the account wrote* — the summary and the three category-specific answers —
is prose, and is stored the way every other piece of this product's prose is
stored: as ``EncryptedString`` ciphertext, exported with the account's archive,
erased with the account, and kept out of ``repr`` by
:class:`models._prose_repr.ProseRedactingRepr`.

*What the app observed* is the diagnostic envelope, and it is an allowlist
rather than a redaction: seven bounded fields, each with a shape narrow enough
that a URL with a query string, a stack trace, a header map or a log bundle
cannot be spelled in it. There is no free-form key, so there is nothing for a
well-meaning client to stuff a screenshot into.

**One table, not two.** The idempotency key lives here, nullable, behind a
partial UNIQUE index on ``(user_id, idem_key)`` — the
:mod:`models.energy_plan` shape. The other precedent in this schema,
``PracticeSessionSpend``, is a separate table because the deduplicated object is
a *different row* from the thing created; here the deduplicated object **is** the
report, so a second table would buy a second deletion policy, a second export
rule, a second cascade and a window in which a report exists without its dedup
record, for nothing.

The enum columns are plaintext ``str`` with a generated CHECK — the
:mod:`models.journal_entry` convention, where the Python enum types the DTO and
the CHECK pins what the database will hold. The CHECKs are spelled
``col IN ('a','b')`` from *sorted* members: that is the shape
``tests/helpers/account_seed.py`` reads permitted values out of, so the deletion
end-to-end sweep reaches this table with no hand-maintained entry anywhere, and
sorting keeps the rendered DDL stable so ``alembic --autogenerate`` sees no
spurious diff.
"""

from __future__ import annotations

import enum
import secrets
from datetime import UTC, datetime
from typing import Final

from sqlalchemy import CheckConstraint, Column, DateTime, Index, String
from sqlmodel import Field, SQLModel

from models._prose_repr import ProseRedactingRepr
from security.idempotency import IDEMPOTENCY_DIGEST_COLUMN_WIDTH
from services.journal_encryption import EncryptedString


class FeedbackCategory(enum.StrEnum):
    """What kind of report this is, in the tester's own framing."""

    BROKEN = "broken"
    CONFUSING = "confusing"
    IDEA = "idea"
    PRAISE = "praise"


class FeedbackImpact(enum.StrEnum):
    """How much the thing being reported cost the person reporting it."""

    BLOCKED = "blocked"
    CAN_CONTINUE = "can_continue"
    COSMETIC = "cosmetic"
    NOT_APPLICABLE = "not_applicable"


class FeedbackPlatform(enum.StrEnum):
    """Which client the report came from. A closed set, not a user-agent string."""

    ANDROID = "android"
    IOS = "ios"
    WEB = "web"


class FeedbackViewportClass(enum.StrEnum):
    """How much room the layout had, in classes rather than pixel dimensions.

    Bucketed deliberately: an exact viewport size is a fingerprinting surface
    and answers no triage question that the class does not.
    """

    COMPACT = "compact"
    EXPANDED = "expanded"
    REGULAR = "regular"


class FeedbackStatus(enum.StrEnum):
    """Where a report stands in the operator's triage, and nothing more.

    Operator-authored state about the report, not the reporter's writing: it is
    never shown on the receipt and never carried in the reporter's export. The
    edges between these states live in :data:`domain.feedback_triage.TRANSITIONS`.
    """

    CLOSED = "closed"
    NEW = "new"
    PLANNED = "planned"
    TRIAGED = "triaged"


# --------------------------------------------------------------------------
# Bounds. Every one of them is named, because each is asserted somewhere else:
# the request schema validates against it, the column is declared at it, and
# ``tests/test_input_length_constraints.py`` drives a rejection past it.
# --------------------------------------------------------------------------

# One sentence, not an essay — the essay goes in the three answers below.
FEEDBACK_SUMMARY_MAX_LENGTH: Final = 280
# Long enough for a careful description of what someone expected; far short of
# anywhere a pasted log bundle would fit.
FEEDBACK_ANSWER_MAX_LENGTH: Final = 2000
FEEDBACK_SCREEN_MAX_LENGTH: Final = 64
FEEDBACK_CONTROL_MAX_LENGTH: Final = 64
FEEDBACK_BUILD_MAX_LENGTH: Final = 32
FEEDBACK_LOCALE_MAX_LENGTH: Final = 16
# A canonical UUID in its hyphenated string form.
FEEDBACK_CORRELATION_ID_LENGTH: Final = 36

# The enum columns are plaintext strings; the CHECK is what bounds their value,
# so the width only has to clear the longest member.
_ENUM_COLUMN_WIDTH: Final = 20

_TABLE: Final = "feedbackreport"

# ``FB-`` plus eight characters.
PUBLIC_ID_PREFIX: Final = "FB-"
PUBLIC_ID_BODY_LENGTH: Final = 8
PUBLIC_ID_MAX_LENGTH: Final = len(PUBLIC_ID_PREFIX) + PUBLIC_ID_BODY_LENGTH

# Digits 2-9 and the capitals, less I, L, O and U. A reference gets read down a
# phone line and typed back in, so the pairs that are read wrong are simply not
# minted; excluding U keeps the alphabet from spelling anything.
PUBLIC_ID_ALPHABET: Final = "23456789ABCDEFGHJKMNPQRSTVWXYZ"
PUBLIC_ID_PATTERN: Final = rf"^{PUBLIC_ID_PREFIX}[{PUBLIC_ID_ALPHABET}]{{{PUBLIC_ID_BODY_LENGTH}}}$"

# How long a report is kept. The privacy policy states this number, and
# ``tests/test_legal_documents.py`` reads it from here so the two cannot drift.
FEEDBACK_RETENTION_DAYS: Final = 180

# Detached column used ONLY to build the partial-index WHERE expression, exactly
# as ``models.energy_plan`` does: it matches the real ``idem_key`` column by name
# at DDL-compile time and is never attached to the table itself.
_IDEM_KEY_COLUMN = Column("idem_key", String(IDEMPOTENCY_DIGEST_COLUMN_WIDTH), nullable=True)


def mint_public_id() -> str:
    """Mint a fresh, non-sequential public reference.

    ``secrets`` rather than ``random`` because the reference is the only handle
    on a report and a guessable one would be an enumeration oracle over other
    people's reports — even though the receipt route also checks ownership, a
    reference nobody can guess is what keeps that check from being the only
    thing standing between an attacker and a hit.
    """
    body = "".join(secrets.choice(PUBLIC_ID_ALPHABET) for _ in range(PUBLIC_ID_BODY_LENGTH))
    return f"{PUBLIC_ID_PREFIX}{body}"


def enum_check(table: str, column: str, values: type[enum.StrEnum]) -> CheckConstraint:
    """CHECK pinning ``table.column`` to ``values``, in the shape the seeder can read.

    ``col IN ('a','b')`` is the one form ``tests/helpers/account_seed.py``
    parses, so writing it this way is what lets the account-deletion end-to-end
    sweep synthesise a row here without a hand-maintained entry. Members are
    sorted so the rendered SQL is order-stable and ``alembic --autogenerate``
    reports no drift against the migration.

    ``table`` is a parameter rather than a literal because the triage tables in
    :mod:`models.feedback_triage` enumerate columns too, and a constraint named
    ``ck_feedbackreport_action_valid`` on a table that is not ``feedbackreport``
    would send whoever reads the violation to the wrong table.
    """
    quoted = ", ".join(f"'{member.value}'" for member in sorted(values))
    return CheckConstraint(f"{column} IN ({quoted})", name=f"ck_{table}_{column}_valid")


class FeedbackReport(ProseRedactingRepr, SQLModel, table=True):
    """One report: the tester's words, the approved envelope, and the receipt.

    ``ProseRedactingRepr`` is listed first so its ``__repr__`` wins the MRO over
    the one SQLModel supplies, which renders every field verbatim.

    ``idem_key`` is the SHA-256 digest of ``(user_id, Idempotency-Key)`` and is
    NULL for unkeyed submissions; each of those gets its own row. Keyed
    submissions collide on the partial UNIQUE index, so a concurrent duplicate
    raises ``IntegrityError`` and the router resolves to the stored row rather
    than writing a second one.
    """

    __tablename__ = _TABLE
    __table_args__ = (
        enum_check(_TABLE, "category", FeedbackCategory),
        enum_check(_TABLE, "impact", FeedbackImpact),
        enum_check(_TABLE, "platform", FeedbackPlatform),
        enum_check(_TABLE, "viewport_class", FeedbackViewportClass),
        enum_check(_TABLE, "status", FeedbackStatus),
        Index("ix_feedbackreport_public_id", "public_id", unique=True),
        # The inbox's default read: one status, newest first, id as the tiebreak.
        Index("ix_feedbackreport_status_created_at_id", "status", "created_at", "id"),
        Index(
            "ix_feedbackreport_user_idem_key",
            "user_id",
            "idem_key",
            unique=True,
            postgresql_where=_IDEM_KEY_COLUMN.is_not(None),
            sqlite_where=_IDEM_KEY_COLUMN.is_not(None),
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True, ondelete="CASCADE")
    public_id: str = Field(sa_column=Column(String(PUBLIC_ID_MAX_LENGTH), nullable=False))

    category: str = Field(sa_column=Column(String(_ENUM_COLUMN_WIDTH), nullable=False))
    impact: str = Field(sa_column=Column(String(_ENUM_COLUMN_WIDTH), nullable=False))
    platform: str = Field(sa_column=Column(String(_ENUM_COLUMN_WIDTH), nullable=False))
    viewport_class: str = Field(sa_column=Column(String(_ENUM_COLUMN_WIDTH), nullable=False))

    # Operator triage. Written only by :mod:`services.feedback_triage`, read
    # only by the admin routes, dropped from the reporter's export, and absent
    # from the receipt. ``server_default`` is what backfilled the rows that
    # existed before triage did.
    status: str = Field(
        default=FeedbackStatus.NEW.value,
        sa_column=Column(
            String(_ENUM_COLUMN_WIDTH),
            nullable=False,
            server_default=FeedbackStatus.NEW.value,
        ),
    )
    # The report this one repeats, if an operator said so. ``SET NULL`` so a
    # canonical report leaving (retention, or its reporter's account deletion)
    # detaches its duplicates rather than taking them with it. The service
    # clears it explicitly too, and the reader resolves a dangling id to
    # ``None``, because SQLite -- which the suite runs on -- never fires it.
    duplicate_of_id: int | None = Field(
        default=None,
        foreign_key="feedbackreport.id",
        ondelete="SET NULL",
        nullable=True,
        index=True,
    )

    # The account's own writing. Encrypted at rest, exported, erased, and kept
    # out of ``repr``. No ``max_length`` on the Field: it cannot coexist with
    # ``sa_column``, ciphertext is longer than its plaintext, and the real bound
    # is enforced at the write boundary by ``schemas.feedback.FeedbackCreate``.
    summary: str = Field(sa_column=Column(EncryptedString(), nullable=False))
    intent: str | None = Field(default=None, sa_column=Column(EncryptedString(), nullable=True))
    expected: str | None = Field(default=None, sa_column=Column(EncryptedString(), nullable=True))
    actual: str | None = Field(default=None, sa_column=Column(EncryptedString(), nullable=True))

    # The allowlisted envelope, in the clear: none of it is the account's
    # writing, and triage reads it.
    screen: str = Field(sa_column=Column(String(FEEDBACK_SCREEN_MAX_LENGTH), nullable=False))
    control: str | None = Field(
        default=None,
        sa_column=Column(String(FEEDBACK_CONTROL_MAX_LENGTH), nullable=True),
    )
    app_build: str = Field(sa_column=Column(String(FEEDBACK_BUILD_MAX_LENGTH), nullable=False))
    locale: str | None = Field(
        default=None,
        sa_column=Column(String(FEEDBACK_LOCALE_MAX_LENGTH), nullable=True),
    )
    correlation_id: str | None = Field(
        default=None,
        sa_column=Column(String(FEEDBACK_CORRELATION_ID_LENGTH), nullable=True),
    )

    idem_key: str | None = Field(
        default=None,
        sa_column=Column(String(IDEMPOTENCY_DIGEST_COLUMN_WIDTH), nullable=True),
    )
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
