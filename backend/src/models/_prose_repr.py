"""Rendering a mapped row to text must not be able to name what it holds.

Encryption at rest defends a stolen disk. It does nothing about the other way a
sentence escapes: something turns the ORM object into a string. A traceback
frame, a ``logger.debug("%s", row)``, a test failure message, an APM breadcrumb
— each of them renders a live instance, and SQLModel's inherited rendering shows
every field verbatim. Measured at the time of writing, **13 ``EncryptedString``
columns across 8 tables** render their plaintext in full through exactly that
path, and none of those models uses this mixin yet.

**There is more than one rendering channel, and ``__repr__`` is not the one that
leaks.** An earlier version of this module overrode ``__repr__`` alone and
claimed, in this docstring, to have closed ``logger.debug("%s", row)``. It had
not: ``%s`` goes through ``__str__``, and on a Pydantic-backed class ``__str__``
is built from :meth:`__repr_args__` rather than delegated to ``__repr__`` — so
``repr`` came back redacted while ``str``, ``format`` and every f-string went on
printing the prose. The redaction is therefore applied at
:meth:`__repr_args__`, the one hook ``__str__``, ``__pretty__`` and
``__rich_repr__`` all read, with ``__repr__`` and ``__str__`` derived from it. A
renderer added by a future Pydantic release inherits the redaction rather than
stepping around it.

Two ways to decide *what* to hide, and only one of them stays closed.

A hand-written list of field names is the obvious one, and it is the same
mechanism that produced the hole: correct on the day it is written and silently
wrong the moment a column lands beside the ones it names. So this mixin
*derives* its redaction set from the mapper — an attribute is redacted precisely
when its column's type is an
:class:`~services.journal_encryption.EncryptedString`. The declaration that a
value is sensitive is the column type, which is also the declaration that makes
it ciphertext on disk, so the two can never disagree.

The rendered form is deliberately not blank. A rendering that answered
``FeedbackReport()`` would pass any "the prose is absent" assertion while
destroying the diagnostic value these methods exist for, so the surrogate id,
the public reference, the enum states and the timestamps all still render; only
the prose becomes :data:`REDACTED`.

**Adoption is one base-class edit per model** — list this mixin *before*
``SQLModel`` in the bases so its methods win the MRO on a ``table=True`` class.
The 13 columns above are knowingly unremediated: sweeping eight models touches
eight unrelated test surfaces and belongs in its own change, not in the one that
introduces the mechanism.
"""

from __future__ import annotations

from typing import Any, Final

from sqlalchemy.orm import class_mapper

from services.journal_encryption import EncryptedString

# What stands in for a redacted value. Angle-bracketed so it can never be
# mistaken for a stored string, and fixed so tests can look for it by name.
REDACTED: Final = "<redacted>"

# Rendered for an attribute the instance has not loaded. Read from the instance
# dict rather than through ``getattr`` on purpose: a rendering that emits SQL to
# satisfy itself can fail, or deadlock, inside the very traceback that called it.
UNLOADED: Final = "<unloaded>"


class _Marker:
    """A value whose ``repr`` is a fixed marker, for the rendering hooks.

    ``__repr_args__`` is consumed by renderers that call ``repr()`` on each
    value. Yielding a marker as a plain string would render it quoted --
    ``summary='<redacted>'`` -- which reads like a stored value. Yielding an
    object that *reprs* as the marker gives ``summary=<redacted>``, which cannot.
    """

    __slots__ = ("_text",)

    def __init__(self, text: str) -> None:
        self._text = text

    def __repr__(self) -> str:
        """Render the marker itself, unquoted."""
        return self._text


_REDACTED_MARKER: Final = _Marker(REDACTED)
_UNLOADED_MARKER: Final = _Marker(UNLOADED)

_ABSENT: Final = object()


def encrypted_attribute_names(model: type[Any]) -> frozenset[str]:
    """Attributes of ``model`` whose column type marks them as stored ciphertext.

    Derived from the SQLAlchemy mapper rather than from a list kept beside it,
    so a column added later is covered without anybody remembering to come here.
    """
    return frozenset(
        attr.key
        for attr in class_mapper(model).column_attrs
        if isinstance(attr.columns[0].type, EncryptedString)
    )


class ProseRedactingRepr:
    """Mixin redacting a mapped class's ciphertext columns from every rendering.

    List it **before** ``SQLModel`` in the bases; on a ``table=True`` model that
    is what puts these methods ahead of the inherited ones in the MRO.
    """

    def __repr_args__(self) -> list[tuple[str, object]]:
        """Every mapped column as ``(name, value)``, with the encrypted ones replaced.

        The single source of truth. Pydantic's ``__str__``, ``__pretty__`` and
        ``__rich_repr__`` all read this hook, and so do :meth:`__repr__` and
        :meth:`__str__` below, so there is exactly one place where the decision
        about what may be shown gets made.
        """
        model = type(self)
        redacted = encrypted_attribute_names(model)
        rendered: list[tuple[str, object]] = []
        for attr in class_mapper(model).column_attrs:
            if attr.key in redacted:
                rendered.append((attr.key, _REDACTED_MARKER))
                continue
            value = vars(self).get(attr.key, _ABSENT)
            rendered.append((attr.key, _UNLOADED_MARKER if value is _ABSENT else value))
        return rendered

    def __repr__(self) -> str:
        """Render the class name and its redacted arguments."""
        body = ", ".join(f"{key}={value!r}" for key, value in self.__repr_args__())
        return f"{type(self).__name__}({body})"

    def __str__(self) -> str:
        """Render exactly as :meth:`__repr__`, so the two can never diverge.

        Belt-and-braces rather than the fix: with :meth:`__repr_args__` redacted
        at source, the inherited ``BaseModel.__str__`` is already safe, and
        removing this method leaves every rendering test green. It is kept
        because it costs one line to make ``str`` and ``repr`` the same string,
        and because the next person to touch this class should not have to know
        which of the two hooks is the one carrying the redaction.
        """
        return self.__repr__()
