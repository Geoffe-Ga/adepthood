"""Drift guards between ``DEPLOYMENT.md``'s encryption section and the code (#3058).

The section once said rows "re-encrypt lazily, on their next write". That was
only half true -- SQLAlchemy rewrites a column only when a write modifies it --
and the half that was false is the half an operator acts on: it implied that a
retired key would, in time, stop being needed, so it could be dropped. It never
would have been. What actually finishes a rotation is the sweep command, so the
runbook has to name that command exactly as the code spells it, name the
platform variable the production guard reads, and must not grow the lazy claim
back.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from scripts import journal_encryption_sweep
from services import journal_encryption

_REPO_ROOT = Path(__file__).resolve().parents[2]
_DEPLOYMENT_DOC = _REPO_ROOT / "DEPLOYMENT.md"
# Every operator-facing text that explains rotation, so the claim cannot survive
# in one after being fixed in the other.
_ROTATION_DOCS = (_DEPLOYMENT_DOC, _REPO_ROOT / "backend" / ".env.example")
_SECTION_HEADING = "## Journal Encryption at Rest"
_NEXT_SECTION = re.compile(r"^## ", re.MULTILINE)
# ``scripts/journal_encryption_sweep.py`` -> ``scripts.journal_encryption_sweep``.
_SWEEP_MODULE = journal_encryption_sweep.__name__

# Claims that are false against the code and must not come back in any wording
# these patterns catch.
_RETIRED_CLAIMS = (
    re.compile(r"re-?encrypt\w*\s+lazily", re.IGNORECASE),
    re.compile(r"tracked in issue #2319 until", re.IGNORECASE),
)


@pytest.fixture
def document() -> str:
    """The whole deployment guide."""
    return _DEPLOYMENT_DOC.read_text(encoding="utf-8")


@pytest.fixture
def section(document: str) -> str:
    """The ``Journal Encryption at Rest`` section, heading to heading."""
    start = document.find(_SECTION_HEADING)
    assert start != -1, f"{_DEPLOYMENT_DOC} has no '{_SECTION_HEADING}' section"
    rest = document[start + len(_SECTION_HEADING) :]
    end = _NEXT_SECTION.search(rest)
    return rest[: end.start()] if end else rest


def test_the_section_gives_the_sweep_commands_as_the_code_spells_them(section: str) -> None:
    """Audit, dry run, apply, and resume -- each runnable as written."""
    for command in (
        f"python -m {_SWEEP_MODULE} audit",
        f"python -m {_SWEEP_MODULE} reencrypt",
        f"python -m {_SWEEP_MODULE} reencrypt --apply",
        "--start-after",
    ):
        assert command in section, f"the runbook does not give `{command}`"


def test_the_section_states_the_sweep_exit_codes(section: str) -> None:
    """An operator scripting the sweep needs the codes the command really returns."""
    for code in (
        journal_encryption_sweep.EXIT_CLEAN,
        journal_encryption_sweep.EXIT_ROWS_REMAIN,
        journal_encryption_sweep.EXIT_INTEGRITY,
    ):
        assert re.search(rf"`{code}`", section), f"exit code {code} is not documented"


def test_the_section_names_the_platform_production_signal(section: str) -> None:
    """The guard reads Railway's own environment name; the runbook says which variable."""
    assert journal_encryption.PLATFORM_ENVIRONMENT_NAME_ENV_VARS[0] in section


@pytest.mark.parametrize("path", _ROTATION_DOCS, ids=lambda path: path.name)
def test_retired_claims_do_not_return(path: Path) -> None:
    """Neither the lazy-rotation claim nor the stale #2319 pointer survives anywhere."""
    text = path.read_text(encoding="utf-8")
    found = [pattern.pattern for pattern in _RETIRED_CLAIMS if pattern.search(text)]
    assert found == []
