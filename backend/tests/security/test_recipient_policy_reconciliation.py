"""The privacy policy's recipient list, reconciled against the recipient register (#3065).

``docs/legal/privacy-policy.md`` introduces each party that receives a user's
data with a bold lead-in at the start of a paragraph of its recipients section.
The register (:mod:`privacy.recipients`) is the code's list of those parties.
The two are held to each other here:

* the lead-ins are exactly :data:`EXPECTED_LEAD_INS`, read from paragraph
  starts only (a bold phrase mid-paragraph is emphasis, not a party);
* every register row names the lead-in that discloses it, and every lead-in
  discloses at least one row -- so a party the code gains without the policy
  naming it fails here;
* the parties the policy once left out (B01, #3057) are each named, by the
  register's own short name, inside a lead-in of their own.
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
        "Your Creek Vault's model provider",
        "Railway",
        "Fly.io",
        "Gumroad",
        "Sentry",
        "An email relay (Resend, or the deployment's own mail server)",
        "Google and Apple",
    }
)

# Parties the policy did not name until B01 (#3057) gave each a lead-in of its
# own. Each must stay named by the register's short name, so a later edit that
# folds one back into another party's paragraph fails here.
NAMED_SINCE_B01 = frozenset(
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


def test_policy_lead_ins_are_exactly_the_expected_set(policy_lead_ins: frozenset[str]) -> None:
    """Every party has its paragraph; mid-paragraph emphasis adds none."""
    assert policy_lead_ins == EXPECTED_LEAD_INS


def test_mid_paragraph_emphasis_is_not_a_lead_in() -> None:
    """The parser reads paragraph starts, so a bold phrase inside a sentence never counts."""
    sample = f"{SECTION_HEADING}\n\n**Alpha**, a party.\n\nIt is **not a party** at all.\n"

    assert lead_ins(sample) == frozenset({"Alpha"})


def test_every_lead_in_maps_to_a_row_and_back(policy_lead_ins: frozenset[str]) -> None:
    """Each lead-in discloses at least one row, and each row's lead-in exists."""
    claimed = {r.policy_lead_in for r in RECIPIENTS.values() if r.policy_lead_in is not None}

    assert claimed == policy_lead_ins


def test_no_register_row_is_left_without_a_lead_in() -> None:
    """Every party the code can reach is disclosed by some paragraph of the policy."""
    undisclosed = sorted(r.id for r in RECIPIENTS.values() if r.policy_lead_in is None)

    assert undisclosed == []


@pytest.mark.parametrize("recipient", sorted(NAMED_SINCE_B01), ids=str)
def test_once_undisclosed_recipient_is_named_in_its_own_lead_in(
    recipient: RecipientId, policy_lead_ins: frozenset[str]
) -> None:
    """Each party the policy once omitted is named, by its short name, in its lead-in."""
    row = RECIPIENTS[recipient]
    name = row.short_name.casefold()

    assert row.policy_lead_in is not None
    assert row.policy_lead_in in policy_lead_ins
    assert name in row.policy_lead_in.casefold()
