r"""Refuse, at flush, any code point no PostgreSQL text column can hold.

Two code point classes are unstorable no matter which column receives them:

* **U+0000.**  PostgreSQL stores no ``text`` value containing a NUL, in any
  encoding, because its own string representation is NUL-terminated.  asyncpg
  refuses it with ``CharacterNotInRepertoireError`` (``invalid byte sequence for
  encoding "UTF8": 0x00``).
* **Unpaired surrogates, U+D800 through U+DFFF.**  These are not characters;
  no UTF-8 encoder will emit one, so the value dies at the driver rather than
  at the column.  A well-formed surrogate *pair* is a different thing entirely
  -- once JSON has decoded it, an astral-plane character is a single code point
  outside that range -- and passes through here untouched, which is the
  distinction this guard exists to make.  Rejecting astral text would break
  emoji and most of the supplementary planes to close a hole only lone
  surrogates open.

Either one reaches the driver from inside whatever handler was writing, and an
unhandled driver error is a 500: the caller sent something the API never
promised to accept and was told the server broke.  This module is the sibling of
:mod:`bounds`, which answers the same 500-vs-422 question for integers too large
for an ``integer`` column; the difference is that an integer bound can be
declared on the field and published, while storability is a property of every
one of the roughly two hundred string fields in this application at once.

Hence a ``before_flush`` listener on :class:`sqlalchemy.orm.Session` rather than
a check in each router.  An ``AsyncSession`` delegates to a sync ``Session``, so
one registration covers every session the application opens -- and every session
the test suite opens, which matters more than it sounds: the test database is
SQLite, which stores both classes without complaint.  Nothing in a SQLite-backed
suite can reproduce the driver error, so before this guard existed a request
carrying a NUL answered 200 in the suite and 500 in production, and no test could
tell the difference.

Rejection, not sanitization.  :mod:`security.text_sanitize` is the boundary
helper that strips control characters and invisible code points from free text,
and its docstring describes itself as *the* insertion-time boundary -- but it is
applied at five call sites, so for every other field the claim is aspirational.
This guard is the backstop that makes the storability half of it true
everywhere; it is not a replacement, because sanitization also removes code
points that store perfectly well and are merely dangerous.  Where the two
differ, they differ deliberately: a helper a caller opted into may edit the
value it was handed, while a listener nothing opted into may not.  Silently
stripping a code point on the way to the row would turn a refusal nobody can
miss into a corruption nobody can see.

Two limitations, accepted rather than hidden, because a guard that oversells its
reach is worse than one nobody trusts.

*A server-generated unstorable string surfaces as a 422 rather than a 500*,
which misattributes the fault.  Acceptable because every string this application
writes is user-derived, so the misattribution has no instance to occur in -- and
a server that did generate one has a bug worth a loud, structured refusal either
way.

*Only the ORM unit of work is covered.*  The listener walks ``session.new`` and
``session.dirty``, which is every write this application makes today, but a
Core-level ``session.execute(insert(...))`` or ``update(...)``, a
``Session.merge``, or a ``bulk_insert_mappings`` emits SQL without populating
either collection and would pass straight through to the driver -- reopening
exactly the hole this module closes.  Nothing in ``src/`` writes text that way
at present; a change that starts to must either route through the ORM or carry
its own check.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import event
from sqlalchemy.orm import InstanceState, Session
from sqlalchemy.orm.base import PASSIVE_NO_INITIALIZE, instance_state

# The code point PostgreSQL terminates strings with and therefore cannot store
# inside one.  Written as an escape so this file stays plain ASCII.
_NUL = "\x00"

# The surrogate range, inclusive.  A code point in it that survived JSON
# decoding is unpaired by construction: a well-formed pair decodes to one
# astral character above U+FFFF, never to its halves.
_SURROGATE_FIRST = 0xD800
_SURROGATE_LAST = 0xDFFF


class UnstorableTextError(ValueError):
    """A value bound for a text column carries a code point no such column holds.

    Names the model and attribute and nothing else.  This guard sits on the
    write path of every column in the application, including the ones holding a
    person's prose, so an exception message quoting the value would put that
    prose into a log line, a Sentry event, and -- once the handler turns this
    into a 422 -- into whatever the client does with an error body.  Neither
    ``str()`` nor ``repr()`` carries the material.

    Subclassed from :class:`ValueError` because that is what it is: a value the
    caller supplied is not admissible.

    ``attribute`` is the mapped column name, which the 422 handler reports as
    the request field the value arrived in.  Those two coincide for every write
    surface here, and would part company only under a schema that renamed a
    field on the wire -- at which point the alias, not the column, is what a
    client would need told back.
    """

    def __init__(self, model: str, attribute: str) -> None:
        """Record where the offending value sat, never what it was."""
        self.model = model
        self.attribute = attribute
        message = f"{model}.{attribute} carries a code point no text column can store"
        super().__init__(message)


def _is_unstorable_text(text: str) -> bool:
    """Report whether ``text`` holds a NUL or an unpaired surrogate."""
    if _NUL in text:
        return True
    return any(_SURROGATE_FIRST <= ord(character) <= _SURROGATE_LAST for character in text)


def _members(value: object) -> tuple[object, ...]:
    """Return what ``value`` contains, or nothing at all if it contains nothing.

    A mapping contributes its keys alongside its values: a JSON column stores
    the key strings as surely as it stores the value strings, and a NUL in
    either one fails the same way.
    """
    if isinstance(value, dict):
        return (*value.keys(), *value.values())
    if isinstance(value, (list, tuple)):
        return tuple(value)
    return ()


def _holds_unstorable_text(value: object) -> bool:
    """Report whether ``value`` holds unstorable text anywhere inside it.

    Recursive because a column's value is not always a string: the PostgreSQL
    array columns hold lists of them and a JSON column holds arbitrarily nested
    containers.  Anything with no members and no text -- an int, a date, the
    bytes the journal encryption layer produces -- falls out as ``False``.
    """
    if isinstance(value, str):
        return _is_unstorable_text(value)
    return any(_holds_unstorable_text(member) for member in _members(value))


def _mapped_state(instance: object) -> InstanceState[Any]:
    """Return the ORM bookkeeping record SQLAlchemy keeps against ``instance``.

    Read straight off the instance rather than through
    :func:`sqlalchemy.inspect`, whose registrar lookup also answers for engines
    and mappers and is therefore typed as possibly returning nothing.  Every
    object a flush hands this listener is a mapped instance by construction.
    """
    state: InstanceState[Any] = instance_state(instance)
    return state


def _column_keys(state: InstanceState[Any]) -> list[str]:
    """Return the mapped column attribute names behind ``state``.

    Restricted to columns because a relationship attribute holds other mapped
    instances, which arrive at this listener in their own right; walking them
    here would scan the same value once per edge that points at it.
    """
    return [attribute.key for attribute in state.mapper.column_attrs]


def _reject_pending(instance: object) -> None:
    """Raise if any column value set on a pending instance is unstorable."""
    state = _mapped_state(instance)
    values = state.dict
    for key in _column_keys(state):
        if key in values and _holds_unstorable_text(values[key]):
            raise UnstorableTextError(type(instance).__name__, key)


def _reject_modified(instance: object) -> None:
    """Raise if any column value an update is about to write is unstorable.

    Reads each attribute's history rather than its current value, so only what
    this flush actually changes is scanned, and passes ``PASSIVE_NO_INITIALIZE``
    so no attribute is lazily loaded in order to be inspected -- a guard that
    emitted its own SELECTs would be a performance defect on every write in the
    application.
    """
    state = _mapped_state(instance)
    for key in _column_keys(state):
        history = state.get_history(key, PASSIVE_NO_INITIALIZE)
        if any(_holds_unstorable_text(value) for value in history.added):
            raise UnstorableTextError(type(instance).__name__, key)


def guard_unstorable_text(session: Session, _flush_context: object, _instances: object) -> None:
    """Scan everything ``session`` is about to write and refuse unstorable text.

    Both halves of the write surface are covered on purpose: a listener that
    walked only ``session.new`` would let every PUT and PATCH through, which is
    most of what this application does and the half a fuzz run reaches last.
    """
    for instance in session.new:
        _reject_pending(instance)
    for instance in session.dirty:
        _reject_modified(instance)


def register_pg_text_guard() -> bool:
    """Install the guard on the ``Session`` class, and report whether it installed.

    Idempotent, because the call site is module scope in :mod:`database` and a
    module can be imported -- or reloaded by a test -- more than once per
    process; a second registration would stack a duplicate listener onto every
    session there is.  The boolean is the only observable difference between
    "registered once" and "registered twice": :func:`sqlalchemy.event.contains`
    answers ``True`` for both.
    """
    if event.contains(Session, "before_flush", guard_unstorable_text):
        return False
    event.listen(Session, "before_flush", guard_unstorable_text)
    return True
