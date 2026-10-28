"""The one egress predicate: which journal tiers may leave the primary boundary (#3059).

Every sink that sends a journal entry's text -- or anything derived from it --
to a language model, a secondary index, or a Creek Vault decides eligibility
here, and nowhere else. The rule is an **allowlist**:

* :data:`EGRESS_ELIGIBLE_TIERS` names the tiers that may egress (``personal``,
  ``public``). A value is eligible only if it is *exactly* one of these
  strings (a :class:`~models.journal_entry.JournalClassification` member is a
  ``str`` and compares equal to its value).
* Everything else is denied: ``intimate`` (ADR 0005, #895), an unknown tier,
  an empty string, a different case, ``None``, a non-string. A tier added to
  ``JournalClassification`` later is therefore **denied by default** until it
  is placed here on purpose; a drift test fails until it is.

Why an allowlist rather than ``!= INTIMATE``: a deny-list fails open on every
value it does not name. Two of the guards this replaced were identity checks
(``is JournalClassification.INTIMATE``) that a plain ``str`` ``"intimate"``
passed straight through. A meta-test (``tests/security/
test_tier_guard_centralized.py``) fails on any new inline tier comparison in
``backend/src`` outside this module.

The module is literal-keyed and imports no model, mirroring
:mod:`domain.creek_vault`'s ``TIER_CEILING_BY_CLASSIFICATION``, so any layer can
import it. ``models.corpus_fragment.RETRIEVABLE_TIERS`` is deliberately *not*
derived from this tuple -- it generates a persisted CHECK, and coupling the two
would turn a policy edit into silent schema drift -- but a test asserts the two
agree.
"""

from __future__ import annotations

from typing import Final

from sqlalchemy import ColumnElement, SQLColumnExpression, or_

#: Tiers whose text may reach a model, an index or a vault. Sorted, and a tuple
#: rather than a set, so the SQL :func:`egress_eligible_clause` renders binds in
#: the same order in every process (a frozenset's order follows the hash seed).
EGRESS_ELIGIBLE_TIERS: Final[tuple[str, ...]] = ("personal", "public")

#: Tiers placed on the deny side on purpose. Not consulted by the predicate --
#: anything outside the allowlist is denied whether or not it is named here --
#: but a drift test requires every ``JournalClassification`` member to sit in
#: exactly one of the two sets, so a new tier is placed by a reviewed edit.
DENIED_TIERS: Final[frozenset[str]] = frozenset({"intimate"})


def admits_egress(classification: object) -> bool:
    """Whether a journal tier may leave the primary boundary; ``False`` for anything unrecognized.

    Accepts ``object`` on purpose: a sink should never need to coerce or
    validate before asking, and every value that is not exactly an allowlisted
    string -- including ``None`` and wrong-case spellings -- is denied.
    """
    return isinstance(classification, str) and classification in EGRESS_ELIGIBLE_TIERS


def egress_eligible_clause(column: SQLColumnExpression[str]) -> ColumnElement[bool]:
    """SQL form of :func:`admits_egress`: rows whose ``column`` is an allowlisted tier."""
    return column.in_(EGRESS_ELIGIBLE_TIERS)


def egress_denied_clause(column: SQLColumnExpression[str]) -> ColumnElement[bool]:
    """SQL negation of :func:`egress_eligible_clause`, including ``NULL``.

    ``column NOT IN (...)`` is ``NULL`` -- not true -- for a ``NULL`` column, so
    the bare negation would quietly drop such a row from a "must be withheld"
    selection. The explicit ``IS NULL`` arm keeps the denial total.
    """
    return or_(column.is_(None), column.not_in(EGRESS_ELIGIBLE_TIERS))
