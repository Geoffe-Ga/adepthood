"""Unit tests for :mod:`telemetry_safety`, the one definition of a reportable exception.

Every telemetry channel (the Sentry envelope, the root log stream) describes an
exception through these primitives, so these tests pin the property each
channel inherits: an exception is described by its type and a statically
declared code, never by its message.
"""

from __future__ import annotations

from typing import ClassVar

import pytest

import telemetry_safety
from tests.helpers.telemetry_canaries import SHORT_CANARY


class _DeclaredFailureError(Exception):
    """An app exception that names its own content-free code."""

    safe_code: ClassVar[str] = "journal_save_failed"


class _InvalidCodeError(Exception):
    """An exception whose declared code is not a code but prose."""

    safe_code: ClassVar[str] = "Has Spaces and prose"


class _NonStringCodeError(Exception):
    """An exception whose declared code is the wrong type entirely."""

    safe_code: ClassVar[object] = 42


class _ExplodingStrError(Exception):
    """An exception whose text must never be read."""

    def __str__(self) -> str:
        """Fail the test if anything renders the message."""
        raise AssertionError("telemetry_safety rendered an exception message")

    def __repr__(self) -> str:
        """Fail the test if anything renders the repr."""
        raise AssertionError("telemetry_safety rendered an exception repr")


def test_an_undeclared_exception_reports_the_withheld_marker() -> None:
    """A plain exception's message is replaced, never quoted."""
    exc = ValueError(SHORT_CANARY)

    assert telemetry_safety.exception_reason(exc) == telemetry_safety.MESSAGE_WITHHELD


def test_a_declared_safe_code_is_reported() -> None:
    """An exception that declares a static code keeps it, for operator grouping."""
    exc = _DeclaredFailureError(SHORT_CANARY)

    assert telemetry_safety.exception_reason(exc) == "journal_save_failed"


@pytest.mark.parametrize("exc_type", [_InvalidCodeError, _NonStringCodeError])
def test_an_invalid_declared_code_falls_back_to_the_marker(exc_type: type[Exception]) -> None:
    """A declaration that is not a lowercase identifier is treated as no declaration."""
    assert telemetry_safety.exception_reason(exc_type()) == telemetry_safety.MESSAGE_WITHHELD


def test_an_instance_attribute_cannot_smuggle_a_code() -> None:
    """Only the class declares; a value assigned at the raise site is ignored.

    An instance attribute is set at runtime, from whatever the raise site had
    in hand -- the exact channel the class-level declaration exists to close.
    """
    exc = ValueError()
    setattr(exc, telemetry_safety.SAFE_CODE_ATTR, "looks_like_a_code")

    assert telemetry_safety.exception_reason(exc) == telemetry_safety.MESSAGE_WITHHELD


def test_the_marker_is_itself_a_valid_code() -> None:
    """Dashboards see one vocabulary: codes, of which the marker is one."""
    assert telemetry_safety.SAFE_CODE_PATTERN.fullmatch(telemetry_safety.MESSAGE_WITHHELD)


def test_describing_an_exception_never_reads_its_message() -> None:
    """The label is built from the class alone: ``__str__``/``__repr__`` never run."""
    exc = _ExplodingStrError()

    label = telemetry_safety.exception_label(exc)

    assert label == f"{__name__}._ExplodingStrError: {telemetry_safety.MESSAGE_WITHHELD}"


def test_a_builtin_exception_label_omits_the_builtins_module() -> None:
    """Builtins read as they do in a standard traceback."""
    label = telemetry_safety.exception_label(KeyError(SHORT_CANARY))

    assert label == f"KeyError: {telemetry_safety.MESSAGE_WITHHELD}"


def _chained() -> Exception:
    """Return a ValueError caused by a KeyError raised while handling a RuntimeError.

    Linked by attribute rather than by raising: the chain walk reads only the
    links, and building them directly keeps the shape exact.
    """
    context = RuntimeError(SHORT_CANARY)
    cause = KeyError(SHORT_CANARY)
    cause.__context__ = context
    outer = ValueError(SHORT_CANARY)
    outer.__cause__ = cause
    return outer


def test_exception_chain_follows_cause_context_and_group_members() -> None:
    """Every linked exception is reachable, so no channel can miss one."""
    group = ExceptionGroup("grp", [_chained(), OSError()])

    chain = telemetry_safety.exception_chain(group)

    assert [type(exc) for exc in chain] == [
        ExceptionGroup,
        ValueError,
        KeyError,
        RuntimeError,
        OSError,
    ]


def test_exception_chain_honours_suppressed_context() -> None:
    """``raise ... from None`` hides the context, as a traceback would."""
    exc = ValueError(SHORT_CANARY)
    exc.__context__ = KeyError(SHORT_CANARY)
    exc.__suppress_context__ = True

    assert telemetry_safety.exception_chain(exc) == [exc]


def test_exception_chain_prefers_the_explicit_cause_over_the_context() -> None:
    """With both links set, the cause is followed and the context is not."""
    exc = ValueError()
    cause = KeyError()
    exc.__context__ = RuntimeError()
    exc.__cause__ = cause

    assert telemetry_safety.exception_chain(exc) == [exc, cause]


def test_exception_chain_survives_a_cycle() -> None:
    """A self-referential context terminates instead of recursing forever."""
    first = ValueError()
    second = KeyError()
    first.__context__ = second
    second.__context__ = first

    assert telemetry_safety.exception_chain(first) == [first, second]
