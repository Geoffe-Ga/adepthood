"""What telemetry may say about an exception: its type and a declared code, never its text.

An exception message is authored at the raise site, and a message that
interpolates a value can interpolate a journal entry, a search term, or a
provider's error body quoting either. No review of raise sites can keep that
closed as the code grows, so every telemetry channel -- the Sentry envelope
(:mod:`sentry`) and the root log stream (:mod:`observability`) -- describes an
exception only through this module, which never calls ``str()`` or ``repr()``
on one (#3064).

What survives is what an operator groups and diagnoses by: the exception's
class, its frames (rendered by each channel), and, when the class opts in, a
static ``safe_code`` it declares. A code is a class-level constant matching
:data:`SAFE_CODE_PATTERN`; it is read from the class, never the instance, so a
value assigned at the raise site cannot pose as one. Everything else reads
:data:`MESSAGE_WITHHELD`.
"""

from __future__ import annotations

import builtins
import re
from typing import Final

#: Class attribute an exception declares its content-free code under.
SAFE_CODE_ATTR: Final = "safe_code"

#: Shape of a declared code: a lowercase identifier, short enough to be a name
#: and incapable of carrying prose (no spaces, no punctuation, no capitals).
SAFE_CODE_PATTERN: Final = re.compile(r"[a-z][a-z0-9_]{0,63}")

#: Reported in place of every exception message. Itself a valid code, so a
#: dashboard sees one vocabulary.
MESSAGE_WITHHELD: Final = "message_withheld"


def declared_safe_code(exc_type: type[BaseException]) -> str | None:
    """Return the code ``exc_type`` declares, or ``None`` if it declares no valid one."""
    code = getattr(exc_type, SAFE_CODE_ATTR, None)
    if isinstance(code, str) and SAFE_CODE_PATTERN.fullmatch(code):
        return code
    return None


def exception_reason(exc: BaseException) -> str:
    """Return the content-free reason telemetry reports for ``exc``."""
    return declared_safe_code(type(exc)) or MESSAGE_WITHHELD


def exception_type_name(exc: BaseException) -> str:
    """Return ``exc``'s class as a traceback would print it, module-qualified."""
    exc_type = type(exc)
    if exc_type.__module__ == builtins.__name__:
        return exc_type.__qualname__
    return f"{exc_type.__module__}.{exc_type.__qualname__}"


def exception_label(exc: BaseException) -> str:
    """Return the ``Type: reason`` line telemetry prints where a message would go."""
    return f"{exception_type_name(exc)}: {exception_reason(exc)}"


def linked_exceptions(exc: BaseException) -> list[BaseException]:
    """Return the exceptions ``exc`` links to directly, in traceback order.

    The explicit cause, else the implicit context unless ``raise ... from None``
    suppressed it, then -- for an exception group -- each member.
    """
    linked: list[BaseException] = []
    if exc.__cause__ is not None:
        linked.append(exc.__cause__)
    elif exc.__context__ is not None and not exc.__suppress_context__:
        linked.append(exc.__context__)
    if isinstance(exc, BaseExceptionGroup):
        linked.extend(exc.exceptions)
    return linked


def exception_chain(exc: BaseException) -> list[BaseException]:
    """Return ``exc`` and every exception reachable from it, each exactly once.

    Depth-first in traceback order. Guarded by identity, so a context cycle
    (which Python permits) terminates instead of recursing forever.
    """
    chain: list[BaseException] = []
    seen: set[int] = set()
    pending = [exc]
    while pending:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        chain.append(current)
        pending.extend(reversed(linked_exceptions(current)))
    return chain
