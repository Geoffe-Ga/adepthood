"""The privacy policy's recipient list, reconciled against the recipient register (#3065).

``docs/legal/privacy-policy.md`` opens its recipients section with "Five parties,
and nothing else", then introduces each party with a bold lead-in at the start
of a paragraph. The register knows of more parties than that. This module does
not edit the policy -- the wording is the owner's (B01) -- it pins the gap:

* the five lead-ins are exactly the five the copy has today, read from
  paragraph starts only (a bold phrase mid-paragraph is emphasis, not a party);
* every register row either names the lead-in that discloses it, or is in
  :data:`KNOWN_UNDISCLOSED`;
* each known-undisclosed row is a strict ``xfail``: the day the copy gives it a
  lead-in of its own, the test XPASSes, the run goes red, and whoever corrected
  the copy strikes the row from the set and records the lead-in in the register.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from privacy.recipients import RECIPIENTS, RecipientId

POLICY_PATH = Path(__file__).resolve().parents[3] / "docs" / "legal" / "privacy-policy.md"
SECTION_HEADING = "## Who else receives your data"

EXPECTED_LEAD_INS = frozenset(
    {
        "The language-model provider",
        "Your Creek Vault",
        "Gumroad",
        "Sentry",
        "An email relay",
    }
)

# Parties the register knows of and the policy does not name by a lead-in of
# their own. Each is a B01 copy correction, not a code change.
KNOWN_UNDISCLOSED = frozenset(
    {
        RecipientId.HOSTING_PLATFORM,
        RecipientId.FLY,
        RecipientId.CREEK_DOWNSTREAM_MODEL,
        RecipientId.GOOGLE_IDENTITY,
        RecipientId.APPLE_IDENTITY,
        RecipientId.RESEND,
    }
)

_LEAD_IN = re.compile(r"^\*\*(?P<text>[^*]+)\*\*")


def _section(policy: str) -> str:
    """The recipients section: from its heading up to the next ``## `` heading."""
    start = policy.index(SECTION_HEADING) + len(SECTION_HEADING)
    following = policy.find("\n## ", start)
    return policy[start : following if following != -1 else len(policy)]


def lead_ins(policy: str) -> frozenset[str]:
    """Bold text that opens a paragraph of the recipients section, and nothing else."""
    paragraphs = re.split(r"\n\s*\n", _section(policy))
    found = (_LEAD_IN.match(p.strip()) for p in paragraphs)
    return frozenset(" ".join(m.group("text").split()) for m in found if m is not None)


@pytest.fixture(scope="module")
def policy_lead_ins() -> frozenset[str]:
    """The lead-ins of the policy as it is checked in."""
    return lead_ins(POLICY_PATH.read_text(encoding="utf-8"))


def test_policy_lead_ins_are_exactly_the_known_five(policy_lead_ins: frozenset[str]) -> None:
    """Five parties today; the mid-paragraph emphasis about Fly is not a sixth."""
    assert policy_lead_ins == EXPECTED_LEAD_INS


def test_mid_paragraph_emphasis_is_not_a_lead_in() -> None:
    """The parser reads paragraph starts, so a bold phrase inside a sentence never counts."""
    sample = f"{SECTION_HEADING}\n\n**Alpha**, a party.\n\nIt is **not a party** at all.\n"

    assert lead_ins(sample) == frozenset({"Alpha"})


def test_every_lead_in_maps_to_a_row_and_back(policy_lead_ins: frozenset[str]) -> None:
    """Each lead-in discloses at least one row, and each row's lead-in exists."""
    claimed = {r.policy_lead_in for r in RECIPIENTS.values() if r.policy_lead_in is not None}

    assert claimed == policy_lead_ins


def test_known_undisclosed_is_exactly_rows_without_a_lead_in() -> None:
    """The gap list is derived from the register, so it cannot drift from it."""
    undisclosed = {r.id for r in RECIPIENTS.values() if r.policy_lead_in is None}

    assert undisclosed == KNOWN_UNDISCLOSED


@pytest.mark.xfail(strict=True, reason="B01 copy correction: the policy does not name it yet")
@pytest.mark.parametrize("recipient", sorted(KNOWN_UNDISCLOSED), ids=str)
def test_known_undisclosed_recipient_has_its_own_lead_in(
    recipient: RecipientId, policy_lead_ins: frozenset[str]
) -> None:
    """Fails today for each gap; XPASSes -- and turns the run red -- once the copy names it."""
    name = RECIPIENTS[recipient].short_name.casefold()

    assert any(name in lead_in.casefold() for lead_in in policy_lead_ins)
