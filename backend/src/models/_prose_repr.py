"""A ``__repr__`` that cannot name what the column type says is secret.

Encryption at rest defends a stolen disk. It does nothing about the other way a
sentence escapes: something stringifies the ORM object. A traceback frame, a
``logger.debug("%s", row)``, a test failure message, an APM breadcrumb — each
of them calls ``repr`` on a live instance, and SQLModel's inherited ``repr``
renders every field verbatim. Measured at the time of writing, **13
``EncryptedString`` columns across 8 tables** render their plaintext in full
through exactly that path, and none of those models uses this mixin yet.

Two ways to close it, and only one of them stays closed.

A hand-written ``__repr__`` naming the fields to hide is the obvious one, and
it is the same mechanism that produced the hole: it is correct on the day it is
written and silently wrong the moment a column is added beside the ones it
names. So this mixin *derives* its redaction set from the mapper — an attribute
is redacted precisely when its column's type is an
:class:`~services.journal_encryption.EncryptedString`. The declaration that the
value is sensitive is the column type, which is also the declaration that makes
it ciphertext on disk, so the two can never disagree.

The rendered form is deliberately not blank. A ``repr`` that answered
``FeedbackReport()`` would pass any "the prose is absent" assertion while
destroying the diagnostic value the method exists for, so the surrogate id, the
public reference, the enum states and the timestamps all still render; only the
prose becomes :data:`REDACTED`.

**Adoption is one base-class edit per model** — list this mixin *before*
``SQLModel`` in the bases so its ``__repr__`` wins the MRO on a ``table=True``
class. The 13 columns above are knowingly unremediated: sweeping eight models
touches eight unrelated test surfaces and belongs in its own change, not in the
one that introduces the mechanism.
"""

from __future__ import annotations

from typing import Any, Final

from sqlalchemy.orm import class_mapper

from services.journal_encryption import EncryptedString

# What stands in for a redacted value. Angle-bracketed so it can never be
# mistaken for a stored string, and fixed so tests can look for it by name.
REDACTED: Final = "<redacted>"

# Rendered for an attribute the instance has not loaded. Read from the instance
# dict rather than through ``getattr`` on purpose: a ``repr`` that emits SQL to
# satisfy itself can fail, or deadlock, in exactly the traceback that called it.
UNLOADED: Final = "<unloaded>"

_ABSENT: Final = object()


def encrypted_attribute_names(model: type[Any]) -> frozenset[str]:
    """Attributes of ``model`` whose column type marks them as stored ciphertext.

    Derived from :func:`sqlalchemy.inspect`'s mapper rather than from a list
    kept beside it, so a column added later is covered without anybody
    remembering to come back here.
    """
    mapper = class_mapper(model)
    return frozenset(
        attr.key
        for attr in mapper.column_attrs
        if isinstance(attr.columns[0].type, EncryptedString)
    )


class ProseRedactingRepr:
    """Mixin giving a mapped class a ``repr`` that redacts its ciphertext columns.

    List it **before** ``SQLModel`` in the bases; on a ``table=True`` model that
    is what puts this ``__repr__`` ahead of the inherited one in the MRO.
    """

    def __repr__(self) -> str:
        """Render every mapped column, with the encrypted ones replaced."""
        model = type(self)
        redacted = encrypted_attribute_names(model)
        mapper = class_mapper(model)
        rendered: list[str] = []
        for attr in mapper.column_attrs:
            if attr.key in redacted:
                rendered.append(f"{attr.key}={REDACTED}")
                continue
            value = vars(self).get(attr.key, _ABSENT)
            shown = UNLOADED if value is _ABSENT else repr(value)
            rendered.append(f"{attr.key}={shown}")
        return f"{model.__name__}({', '.join(rendered)})"
