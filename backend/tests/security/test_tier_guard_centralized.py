"""No sink may decide tier eligibility with its own deny-list (#3059).

``domain.privacy_tier`` is the one place a tier is judged. A comparison against
the Intimate tier anywhere else is a deny-list, and a deny-list fails open on
every tier it does not name -- which is how an identity check let a plain
``str`` ``"intimate"`` reach a provider. This gate fails on any such comparison
in ``backend/src`` outside the policy module.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from tests.support.tier_guards import (
    find_inline_tier_comparisons,
    inline_tier_comparisons_in_source,
)

_SRC_ROOT = Path(__file__).resolve().parents[2] / "src"

#: The policy module is the one place allowed to name the denied tier.
_EXEMPT = frozenset({"domain/privacy_tier.py"})


def test_no_inline_tier_comparisons_in_src() -> None:
    """Every sink routes through ``admits_egress`` / ``egress_*_clause``; none compares inline."""
    hits = find_inline_tier_comparisons(_SRC_ROOT, exempt=_EXEMPT)

    assert hits == [], "inline tier deny-lists (use domain.privacy_tier): " + ", ".join(
        str(hit) for hit in hits
    )


def test_the_scan_reaches_the_source_tree() -> None:
    """A scan that found no files would pass vacuously; pin that it reads the real tree."""
    assert (_SRC_ROOT / "routers" / "journal.py").is_file()
    assert (_SRC_ROOT / "domain" / "privacy_tier.py").is_file()


@pytest.mark.parametrize(
    "snippet",
    [
        "x == JournalClassification.INTIMATE",
        "col(c) != JournalClassification.INTIMATE",
        "c is JournalClassification.INTIMATE",
        "c is not JournalClassification.INTIMATE",
        "c in {'intimate'}",
        "c not in ('public', 'intimate')",
        "c == EXCLUDED_TIER",
        "c == models.EXCLUDED_TIER",
        "'intimate' == c",
        "c == 'Intimate'",
        "col(c).in_([JournalClassification.INTIMATE])",
        "col(c).not_in(('intimate',))",
    ],
)
def test_scanner_flags_planted_violations(snippet: str) -> None:
    """Each deny-list shape is caught exactly once."""
    assert len(inline_tier_comparisons_in_source(snippet, "planted.py")) == 1


@pytest.mark.parametrize(
    "snippet",
    [
        "EXCLUDED_TIER = JournalClassification.INTIMATE",
        "MAP = {'intimate': VaultTierCeiling.INTIMATE}",
        "ceiling is VaultTierCeiling.INTIMATE",
        "c == JournalClassification.PERSONAL",
        "admits_egress(c)",
        "c == 'personal'",
    ],
)
def test_scanner_ignores_non_decisions(snippet: str) -> None:
    """An assignment, a dict key, the vault-ceiling enum and allowlist checks are not deny-lists."""
    assert inline_tier_comparisons_in_source(snippet, "planted.py") == []
