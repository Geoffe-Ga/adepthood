"""The prose-redacting ``repr`` derives what it hides, and still says something.

The model under test is declared against its own SQLAlchemy registry rather than
against ``SQLModel.metadata``: a ``table=True`` class defined in a test would
join the live schema and make the deletion-policy, export-manifest and
account-seeder totality gates fail on a table that exists only here.
"""

from __future__ import annotations

import re
from collections.abc import Callable

import pytest
import sqlalchemy as sa
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from models._prose_repr import REDACTED, ProseRedactingRepr, encrypted_attribute_names
from services.journal_encryption import EncryptedString

_SENTINEL = "SENTINEL_PROSE_XYZ"

# ``key=<redacted>`` as the mixin renders it, so the test reads the behaviour
# rather than a helper's opinion about the behaviour.
_REDACTED_ATTRIBUTE = re.compile(rf"(\w+)={re.escape(REDACTED)}")


class _Base(DeclarativeBase):
    """A registry of this module's own, disjoint from the application schema."""


class _Fixture(ProseRedactingRepr, _Base):
    """Two encrypted columns and two plaintext ones, to tell the halves apart."""

    __tablename__ = "prose_repr_fixture"

    id: Mapped[int] = mapped_column(sa.Integer, primary_key=True)
    public_id: Mapped[str] = mapped_column(sa.String(16))
    body: Mapped[str] = mapped_column(EncryptedString())
    note: Mapped[str] = mapped_column(EncryptedString())


def test_the_repr_hides_every_encrypted_column() -> None:
    """No ciphertext column's plaintext appears in the rendered form."""
    row = _Fixture(id=1, public_id="FB-23456789", body=_SENTINEL, note=_SENTINEL)

    assert _SENTINEL not in repr(row)


def test_the_repr_still_renders_the_identifying_columns() -> None:
    """The honesty half: a blanket ``"_Fixture()"`` must not satisfy the test above."""
    row = _Fixture(id=1, public_id="FB-23456789", body=_SENTINEL, note=_SENTINEL)
    rendered = repr(row)

    assert "_Fixture" in rendered
    assert "FB-23456789" in rendered
    assert "id=1" in rendered


def test_the_redaction_set_is_derived_from_the_column_type_not_a_hand_list() -> None:
    """What the repr hides equals what the mapper says is ciphertext, exactly.

    No field list is written here. A hardcoded redaction set inside the mixin
    fails this the moment the fixture's two encrypted columns disagree with it,
    which is the failure a hand-written ``__repr__`` cannot be made to have.
    """
    row = _Fixture(id=1, public_id="FB-23456789", body=_SENTINEL, note=_SENTINEL)
    hidden = set(_REDACTED_ATTRIBUTE.findall(repr(row)))

    derived = {
        attr.key
        for attr in sa.inspect(_Fixture).mapper.column_attrs
        if isinstance(attr.columns[0].type, EncryptedString)
    }
    assert hidden == derived
    assert encrypted_attribute_names(_Fixture) == frozenset(derived)


def test_an_unset_column_renders_without_emitting_sql() -> None:
    """An attribute the instance never loaded is named, not lazily fetched."""
    rendered = repr(_Fixture(id=2))

    assert "public_id=<unloaded>" in rendered
    assert f"body={REDACTED}" in rendered


# Every channel that renders an object to text. ``repr`` is the one people think
# of; the rest are the ones that actually leak, because ``logger.debug("%s", row)``
# and an f-string both go through ``__str__``.
_RENDERERS = (
    ("repr", repr),
    ("str", str),
    ("format", format),
    ("fstring", lambda value: f"{value}"),
)
_RENDERER_IDS = [name for name, _ in _RENDERERS]


@pytest.mark.parametrize(("name", "render"), _RENDERERS, ids=_RENDERER_IDS)
def test_no_rendering_channel_reproduces_the_prose(
    name: str, render: Callable[[object], str]
) -> None:
    """Redacting ``__repr__`` alone is not enough, and never was."""
    row = _Fixture(id=1, public_id="FB-23456789", body=_SENTINEL, note=_SENTINEL)

    assert _SENTINEL not in render(row), name


@pytest.mark.parametrize(("name", "render"), _RENDERERS, ids=_RENDERER_IDS)
def test_every_rendering_channel_still_identifies_the_row(
    name: str, render: Callable[[object], str]
) -> None:
    """The honesty half, applied to each channel: none may render nothing."""
    row = _Fixture(id=1, public_id="FB-23456789", body=_SENTINEL, note=_SENTINEL)

    assert "FB-23456789" in render(row), name


def test_the_representation_hook_is_redacted_at_source() -> None:
    """``__repr_args__`` is what ``__str__``, ``__pretty__`` and ``__rich_repr__`` read.

    Closing it at source is what stops a future renderer -- devtools, rich, a
    Pydantic release that adds another one -- reopening the hole behind a
    ``__repr__`` that still looks correct.
    """
    row = _Fixture(id=1, public_id="FB-23456789", body=_SENTINEL, note=_SENTINEL)

    rendered = {key: repr(value) for key, value in row.__repr_args__()}

    assert rendered["body"] == REDACTED
    assert rendered["note"] == REDACTED
    assert rendered["public_id"] == "'FB-23456789'"
