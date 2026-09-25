"""requirements.txt and requirements-lock.txt must agree, and Starlette must float.

The backend has two dependency files. ``requirements.txt`` declares the direct
dependencies with exact pins; ``requirements-lock.txt`` is the full transitive
resolve of it, and every CI job except ``backend-compat`` installs the lock.
Until #2923 the requirements header claimed the two "install one identical set".
That held for the direct pins and was false for every transitive, and nothing
checked either half -- a prose claim that survived until an upstream Starlette
release proved it wrong.

This module makes the true version of that claim executable:

* every exact pin in ``requirements.txt`` appears at the same version in the
  lock, so the lock-installing jobs test the versions the project declares;
* ``requirements.txt`` does not pin Starlette, because ``backend-compat``
  installs that file unresolved precisely so Starlette floats to its newest
  release -- a pin there would blind the canary;
* the lock does pin Starlette, because the lock is where the adopted version is
  recorded.

A Dependabot PR that bumps ``requirements.txt`` without regenerating the lock
goes red here on purpose: the lock-installing jobs would otherwise be testing a
version nobody declared. The failure names the command that fixes it.

The parsing reuses ``scripts.check_dependency_drift``'s readers, so an
unparseable line fails closed as "could not verify" rather than being skipped.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from scripts.check_dependency_drift import (
    PinnedRequirement,
    Unevaluated,
    iter_requirement_lines,
    normalize_name,
    parse_pin,
)

_BACKEND_ROOT = Path(__file__).resolve().parents[2]
_REQUIREMENTS = _BACKEND_ROOT / "requirements.txt"
_LOCK = _BACKEND_ROOT / "requirements-lock.txt"

LOCK_COMMAND = "uv pip compile backend/requirements.txt -o backend/requirements-lock.txt"
_CANARY = normalize_name("starlette")


def _pins(path: Path) -> tuple[dict[str, PinnedRequirement], list[Unevaluated]]:
    """Return a requirements file's exact pins by normalised name, plus refusals."""
    pins: dict[str, PinnedRequirement] = {}
    refused: list[Unevaluated] = []
    for number, text in iter_requirement_lines(path):
        parsed = parse_pin(path, number, text)
        if isinstance(parsed, Unevaluated):
            refused.append(parsed)
        else:
            pins[parsed.name] = parsed
    return pins, refused


def direct_pin_mismatches(requirements: Path, lock: Path) -> list[str]:
    """Return every way the direct pins and the lock disagree.

    Args:
        requirements: The direct-dependency file (``requirements.txt``).
        lock: Its transitive resolve (``requirements-lock.txt``).

    Returns:
        One human-readable violation per problem: a line either file cannot be
        read as an exact pin, a direct pin missing from the lock or locked at
        another version, a Starlette pin in the direct file, or no Starlette pin
        in the lock. Empty when the two agree.
    """
    declared, declared_refused = _pins(requirements)
    locked, locked_refused = _pins(lock)
    violations = [
        f"{item.source.name}:{item.line_number}: cannot verify {item.text!r} ({item.reason})"
        for item in declared_refused + locked_refused
    ]
    for name, pin in declared.items():
        found = locked.get(name)
        locked_as = "absent" if found is None else f"=={found.version}"
        if found is None or found.version != pin.version:
            violations.append(
                f"{requirements.name}:{pin.line_number}: {name}=={pin.version} is "
                f"{locked_as} in {lock.name}; regenerate the lock with `{LOCK_COMMAND}`"
            )
    if _CANARY in declared:
        violations.append(
            f"{requirements.name}:{declared[_CANARY].line_number}: starlette must stay "
            "unpinned here -- backend-compat installs this file unresolved to canary "
            "new Starlette releases, and a pin blinds it; adopt a version in the lock "
            "instead (see the comment beside fastapi, #2923)"
        )
    if _CANARY not in locked:
        violations.append(
            f"{lock.name}: no starlette pin -- the lock is where the adopted Starlette "
            f"version is recorded; regenerate it with `{LOCK_COMMAND}`"
        )
    return violations


def test_direct_pins_agree_with_the_lock_and_starlette_floats() -> None:
    """The real files: direct pins equal the lock, and only the lock pins Starlette."""
    assert direct_pin_mismatches(_REQUIREMENTS, _LOCK) == []


def _write(path: Path, *lines: str) -> Path:
    """Write a requirements-style fixture and return its path."""
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


@pytest.fixture
def agreeing_lock(tmp_path: Path) -> Path:
    """A lock that resolves the fixture requirements, starlette included."""
    return _write(
        tmp_path / "requirements-lock.txt",
        "# autogenerated",
        "email-validator==2.3.0",
        "    # via -r requirements.txt",
        "fastapi==0.141.1",
        "sqlalchemy==2.0.52",
        "starlette==1.7.0",
        "    # via fastapi",
    )


def test_agreeing_files_report_nothing(tmp_path: Path, agreeing_lock: Path) -> None:
    """Name normalisation and extras do not manufacture a mismatch."""
    requirements = _write(
        tmp_path / "requirements.txt",
        "# comment",
        "email_validator==2.3.0",
        "sqlalchemy[asyncio]==2.0.52",
        "FastAPI==0.141.1  # inline comment",
    )

    assert direct_pin_mismatches(requirements, agreeing_lock) == []


def test_a_direct_pin_the_lock_disagrees_with_names_the_fix(
    tmp_path: Path, agreeing_lock: Path
) -> None:
    """A Dependabot-style bump without a relock is reported, with the command."""
    requirements = _write(tmp_path / "requirements.txt", "fastapi==0.142.0")

    assert direct_pin_mismatches(requirements, agreeing_lock) == [
        (
            "requirements.txt:1: fastapi==0.142.0 is ==0.141.1 in requirements-lock.txt; "
            f"regenerate the lock with `{LOCK_COMMAND}`"
        )
    ]


def test_a_direct_pin_missing_from_the_lock_is_reported(
    tmp_path: Path, agreeing_lock: Path
) -> None:
    """A new direct dependency nobody relocked is reported as absent."""
    requirements = _write(tmp_path / "requirements.txt", "fastapi==0.141.1", "slowapi==0.1.10")

    assert direct_pin_mismatches(requirements, agreeing_lock) == [
        (
            "requirements.txt:2: slowapi==0.1.10 is absent in requirements-lock.txt; "
            f"regenerate the lock with `{LOCK_COMMAND}`"
        )
    ]


def test_a_starlette_pin_in_the_direct_file_is_reported(
    tmp_path: Path, agreeing_lock: Path
) -> None:
    """Pinning Starlette in requirements.txt blinds the canary, even when it agrees."""
    requirements = _write(tmp_path / "requirements.txt", "fastapi==0.141.1", "starlette==1.7.0")

    violations = direct_pin_mismatches(requirements, agreeing_lock)

    assert len(violations) == 1
    assert violations[0].startswith("requirements.txt:2: starlette must stay unpinned here")


def test_a_lock_without_starlette_is_reported(tmp_path: Path) -> None:
    """The lock is the adoption record; losing Starlette from it is a violation."""
    requirements = _write(tmp_path / "requirements.txt", "fastapi==0.141.1")
    lock = _write(tmp_path / "requirements-lock.txt", "fastapi==0.141.1")

    assert direct_pin_mismatches(requirements, lock) == [
        (
            "requirements-lock.txt: no starlette pin -- the lock is where the adopted "
            f"Starlette version is recorded; regenerate it with `{LOCK_COMMAND}`"
        )
    ]


def test_an_unreadable_line_fails_closed(tmp_path: Path, agreeing_lock: Path) -> None:
    """A range or marker is "could not verify", never silently skipped."""
    requirements = _write(tmp_path / "requirements.txt", "fastapi>=0.141")

    assert direct_pin_mismatches(requirements, agreeing_lock) == [
        "requirements.txt:1: cannot verify 'fastapi>=0.141' (not an exact == pin)"
    ]
