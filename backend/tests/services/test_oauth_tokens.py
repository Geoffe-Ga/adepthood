"""The pure rules of the token service, apart from HTTP (#3533).

The endpoint tests in ``tests/routers/test_oauth_token_endpoint.py`` drive the
whole flow; these pin the pieces whose answers must not drift: the PKCE check
against RFC 7636's own worked example, and the derived subject's stability.
"""

from __future__ import annotations

import pytest

from models.agent_grant import AgentGrant
from services.oauth_tokens import (
    AGENT_SUBJECT_HEX_DIGITS,
    AGENT_SUBJECT_PREFIX,
    _persisted_id,
    derived_subject,
    pkce_verifier_matches,
)
from tests.helpers.oauth import CHALLENGE, VERIFIER

# RFC 7636 appendix B: this verifier's S256 challenge, as the RFC prints it.
_RFC_7636_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"  # pragma: allowlist secret
_SECRET = "deployment-secret"  # pragma: allowlist secret


def test_the_verifier_matches_the_rfcs_own_challenge() -> None:
    """The worked example in RFC 7636 appendix B, byte for byte."""
    assert _RFC_7636_CHALLENGE == CHALLENGE
    assert pkce_verifier_matches(VERIFIER, _RFC_7636_CHALLENGE)


@pytest.mark.parametrize(
    "verifier",
    [
        pytest.param(VERIFIER[:-1] + "l", id="one-character-off"),
        pytest.param("a" * 42, id="too-short"),
        pytest.param("a" * 129, id="too-long"),
        pytest.param(VERIFIER[:-1] + "é", id="outside-the-unreserved-set"),
        pytest.param(_RFC_7636_CHALLENGE, id="the-challenge-itself"),
    ],
)
def test_anything_else_does_not_match(verifier: str) -> None:
    """Including the challenge presented as its own verifier: ``plain`` is never accepted."""
    assert not pkce_verifier_matches(verifier, _RFC_7636_CHALLENGE)


def test_the_derived_subject_is_stable_distinct_and_opaque() -> None:
    """One account, one subject; another account or another deployment, another."""
    subject = derived_subject(7, _SECRET)
    assert subject == derived_subject(7, _SECRET)
    assert subject != derived_subject(8, _SECRET)
    assert subject != derived_subject(7, "another-secret")
    digest = subject.removeprefix(AGENT_SUBJECT_PREFIX)
    assert subject.startswith(AGENT_SUBJECT_PREFIX)
    assert len(digest) == AGENT_SUBJECT_HEX_DIGITS
    assert int(digest, 16) >= 0


def test_a_row_never_read_from_the_database_has_no_id_to_issue_under() -> None:
    """Issuing under an unsaved grant is a programming error, refused loudly."""
    with pytest.raises(ValueError, match="AgentGrant was not read from the database"):
        _persisted_id(AgentGrant(user_id=1, client_id="cl_x", resource="https://v.example/mcp"))
