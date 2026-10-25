"""Copy guards for the agent consent page, in the register of the frontend's vaultCopy (#3532).

The consent page is the moment somebody decides whether a program may read their
writing. These guards hold every sentence on it to the same bans the "Where your
writing lives" Settings deck is held to: no transport or protocol vocabulary,
no pressure or loss framing, no durability promise, the plain product name in
headings, and the Intimate floor stated in so many words.
"""

from __future__ import annotations

import re

import pytest

from services import oauth_consent_copy as copy
from services.oauth_authorization import SUPPORTED_SCOPES

# The vocabulary a person deciding about their writing should never have to
# parse. Wider than the Settings deck's ban, because this page is reached from
# an agent and the words agents use for this flow are all protocol words.
_BANNED_TECHNICAL = re.compile(
    r"\b(host|hostname|url|uri|endpoint|api|token|bearer|credential|mcp|oauth|scope|scopes|"
    r"redirect|client|server|protocol|https?|json|port|loopback|localhost|authorize|"
    r"authorization|pkce|tenant|creek)\b",
    re.IGNORECASE,
)
_BANNED_PRESSURE = re.compile(
    r"\b(backup|back up|safeguard|lose|lost|losing|at risk|danger|required|must|need to|"
    r"hurry|now or never|last chance)\b",
    re.IGNORECASE,
)
_BANNED_DURABILITY = re.compile(
    r"\b(guarantee|guaranteed|never lose|always safe|permanent|permanently)\b", re.IGNORECASE
)


def _every_string() -> dict[str, str]:
    """Every sentence the module exports, keyed so a failure names the one at fault."""
    strings: dict[str, str] = {}
    for name in dir(copy):
        if not name.isupper():
            continue
        value = getattr(copy, name)
        if isinstance(value, str):
            strings[name] = value
        else:
            for key, sentence in value.items():
                strings[f"{name}[{key}]"] = sentence
    return strings


_STRINGS = _every_string()


def test_the_sweep_reads_every_constant() -> None:
    """A guard over an empty blob passes for the wrong reason."""
    assert len(_STRINGS) > len(copy.GRANT_DESCRIPTIONS) + len(copy.ERROR_BODIES)
    assert all(sentence.strip() for sentence in _STRINGS.values())


@pytest.mark.parametrize("name", sorted(_STRINGS))
def test_no_sentence_uses_technical_vocabulary(name: str) -> None:
    """The person reads about their writing, not about the flow carrying it."""
    assert not _BANNED_TECHNICAL.search(_STRINGS[name]), _STRINGS[name]


@pytest.mark.parametrize("name", sorted(_STRINGS))
def test_no_sentence_pressures_or_promises(name: str) -> None:
    """Declining costs nothing, and nothing claims durability it cannot keep."""
    sentence = _STRINGS[name]
    assert not _BANNED_PRESSURE.search(sentence), sentence
    assert not _BANNED_DURABILITY.search(sentence), sentence


def test_every_supported_grant_has_a_plain_description() -> None:
    """A scope added without a sentence would show up on the page as its wire name."""
    assert set(copy.GRANT_DESCRIPTIONS) == set(SUPPORTED_SCOPES)


def test_the_grant_sentences_are_the_ones_the_issue_names() -> None:
    """The three sentences the issue fixes verbatim."""
    assert copy.GRANT_DESCRIPTIONS["vault:desk"] == (
        "Draft and reflect from your Open and Personal writing"
    )
    assert copy.GRANT_DESCRIPTIONS["vault:journal"] == "Add journal entries"
    assert copy.GRANT_DESCRIPTIONS["vault:pipeline"] == "Re-sort your vault"


def test_the_floor_names_intimate_entries() -> None:
    """The one thing no approval can include is said outright."""
    assert copy.CONSENT_FLOOR == "Intimate entries are never included."


def test_the_agents_name_is_marked_as_its_own() -> None:
    """Nothing on the page lets an agent's chosen name read as Adepthood's word."""
    assert "agent gave itself" in copy.CONSENT_NAME_NOTE


def test_the_local_program_note_asks_the_person_to_have_started_it() -> None:
    """The authorization spec asks for a warning when approval returns to this computer."""
    assert "this computer" in copy.CONSENT_LOCAL_PROGRAM_NOTE
    assert "started this agent yourself" in copy.CONSENT_LOCAL_PROGRAM_NOTE


@pytest.mark.parametrize("kind", sorted(copy.ERROR_BODIES))
def test_every_refusal_says_whether_anything_was_shared_or_what_to_do(kind: str) -> None:
    """A refusal tells the person nothing left, or tells them where to go next."""
    body = copy.ERROR_BODIES[kind]
    assert "Nothing was shared." in body or "Settings" in body
