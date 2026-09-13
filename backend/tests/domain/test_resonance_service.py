"""Guardrail-presence tests for :mod:`domain.resonance` prompt builders.

Issue #890 — medication-safety guardrail in every prompt that sends user writing
to a model.  These tests assert that :data:`~domain.care.MEDICATION_GUARDRAIL`
is embedded in the output of every resonance prompt builder, pinning the
single-source-of-truth constant rather than a copied literal.

The constant does not yet exist in :mod:`domain.care`; these tests therefore
FAIL on import (``ImportError: cannot import name 'MEDICATION_GUARDRAIL'``) until
the implementation-specialist adds it.  That is the correct RED state.
"""

from __future__ import annotations

import pytest

from domain.care import MEDICATION_GUARDRAIL
from domain.resonance import (
    _DEFAULT_MAX_NOTES,
    _PRIOR_LETTER_SEPARATOR,
    NO_STYLE_TRANSFER_INSTRUCTION,
    PRIOR_DRAFT_CHARS,
    PRIOR_DRAFT_LIMIT,
    _build_essay_prompt,
    _retry_prompt,
    build_prompt,
)

# ---------------------------------------------------------------------------
# Fixtures shared across this module
# ---------------------------------------------------------------------------

_BODY = (
    "Today I walked by the river and felt the old fear rise again. "
    "But I noticed the willow bending without breaking, and something settled."
)

_ANCHOR_TEXT = "the willow bending without breaking"
_KIND = "symbol"
_NOTE = "The willow holds you."


# ---------------------------------------------------------------------------
# build_prompt — main resonance prompt
# ---------------------------------------------------------------------------


def test_build_prompt_contains_medication_guardrail() -> None:
    """MEDICATION_GUARDRAIL must be a substring of build_prompt(<body>).

    The guardrail is sourced from :data:`domain.care.MEDICATION_GUARDRAIL` so
    the constant is the single source of truth; a copied literal would not
    satisfy this test if the constant wording changes.
    """
    prompt = build_prompt(_BODY)
    assert MEDICATION_GUARDRAIL in prompt, (
        "build_prompt must embed MEDICATION_GUARDRAIL verbatim so it reaches "
        "the model on every resonance call"
    )


def test_build_prompt_with_prior_entries_contains_medication_guardrail() -> None:
    """Guardrail must survive the prior-entries branch of build_prompt."""
    prompt = build_prompt(_BODY, prior_entries=["An earlier entry about water."])
    assert MEDICATION_GUARDRAIL in prompt


# ---------------------------------------------------------------------------
# _build_essay_prompt — expansion prompt
# ---------------------------------------------------------------------------


def test_build_essay_prompt_contains_medication_guardrail() -> None:
    """MEDICATION_GUARDRAIL must be a substring of _build_essay_prompt(...).

    The essay builder sends the full entry body to the model; the guardrail
    must accompany that call too (NORTH-STAR §10).
    """
    prompt = _build_essay_prompt(_BODY, _ANCHOR_TEXT, _KIND, _NOTE)
    assert MEDICATION_GUARDRAIL in prompt, (
        "_build_essay_prompt must embed MEDICATION_GUARDRAIL verbatim"
    )


# ---------------------------------------------------------------------------
# Non-regression: existing parse / anchoring contract must not break
# ---------------------------------------------------------------------------
# The added guardrail text is instruction overhead injected into the system /
# prompt string; it must not interfere with the JSON parsing contract.
# The parse-and-anchor tests live in ``tests/test_resonance_service.py``
# (the top-level module that was the original home for resonance tests).
# We do not duplicate them here — see that file for coverage.


# ---------------------------------------------------------------------------
# prior letters — content-only anti-repetition context (issue #2574)
# ---------------------------------------------------------------------------
# The Higher Self could not see the letters it had already written, so it
# repeated itself. At most PRIOR_DRAFT_LIMIT of them now ride along in their
# own ``<prior_letters>`` block. They are there for CONTENT -- what has already
# been said -- and never for STYLE, which is what NO_STYLE_TRANSFER_INSTRUCTION
# is for. Every assertion below slices *between the delimiters* rather than
# testing ``sentinel in prompt``: a bare substring check would also pass on a
# letter that leaked into the ``<prior>`` grounding block, which is a different
# guarantee entirely.

_MARCH_LETTER_SENTINEL = "MARCH_LETTER_SENTINEL_a7f3"
_PRIOR_LETTERS_OPEN = "<prior_letters>"
_PRIOR_LETTERS_CLOSE = "</prior_letters>"


def _prior_letters_section(prompt: str) -> str:
    """Return the text between the ``<prior_letters>`` delimiters.

    Fails the calling test with a clear message when the block is absent, so a
    missing section reports itself rather than surfacing as a bare ``ValueError``
    from :meth:`str.index`.
    """
    assert _PRIOR_LETTERS_OPEN in prompt, "the prompt carries no <prior_letters> block"
    assert _PRIOR_LETTERS_CLOSE in prompt, "the <prior_letters> block is never closed"
    start = prompt.index(_PRIOR_LETTERS_OPEN) + len(_PRIOR_LETTERS_OPEN)
    return prompt[start : prompt.index(_PRIOR_LETTERS_CLOSE)]


def test_build_prompt_carries_prior_letters_inside_their_own_delimiter() -> None:
    """A prior letter reaches the model inside ``<prior_letters>``, not loose in the prompt."""
    prompt = build_prompt(_BODY, prior_drafts=[_MARCH_LETTER_SENTINEL])
    assert _MARCH_LETTER_SENTINEL in _prior_letters_section(prompt), (
        "the prior letter must sit inside the <prior_letters> delimiter so the "
        "model can tell it apart from the writer's own words"
    )


def test_build_prompt_with_prior_letters_forbids_style_transfer() -> None:
    """The letters never travel without the rule that governs them.

    Pinned to :data:`domain.resonance.NO_STYLE_TRANSFER_INSTRUCTION` rather than
    a copied literal, so the constant stays the single source of truth. The
    mutation this catches is deleting the interpolation, not rewording it:
    rewording moves both sides of the assertion at once.
    """
    prompt = build_prompt(_BODY, prior_drafts=[_MARCH_LETTER_SENTINEL])
    assert prompt.count(NO_STYLE_TRANSFER_INSTRUCTION) == 1, (
        "prior letters are content-only context; sending them with no "
        "single anti-imitation rule is the failure mode this feature is defined against"
    )
    assert "must never mean writing fewer notes" in NO_STYLE_TRANSFER_INSTRUCTION


@pytest.mark.parametrize("empty", [None, []])
def test_build_prompt_omits_the_whole_section_when_there_are_no_prior_letters(
    empty: list[str] | None,
) -> None:
    """No letters means no block and no rule about a block -- not an empty one."""
    prompt = build_prompt(_BODY, prior_drafts=empty)
    assert _PRIOR_LETTERS_OPEN not in prompt, (
        f"prior_drafts={empty!r} still emitted a <prior_letters> delimiter"
    )
    assert NO_STYLE_TRANSFER_INSTRUCTION not in prompt, (
        f"prior_drafts={empty!r} still emitted the anti-imitation rule, which "
        "governs letters that are not there"
    )


def _over_cap_drafts() -> list[str]:
    """Return ``PRIOR_DRAFT_LIMIT + 1`` letters, each longer than ``PRIOR_DRAFT_CHARS``."""
    return [
        f"letter-{index}-" + "x" * PRIOR_DRAFT_CHARS + f"OVERCAP_SENTINEL_{index}"
        for index in range(PRIOR_DRAFT_LIMIT + 1)
    ]


def test_build_prompt_caps_both_how_many_prior_letters_and_how_long_each_is() -> None:
    """Two bounds, one constant each: the count and the characters per letter.

    ``PRIOR_DRAFT_LIMIT`` bounds the SQL ``LIMIT`` and this slice alike, so an
    over-supplying caller cannot widen what leaves the deployment. The
    per-letter cap is what keeps that bound meaningful in tokens rather than
    only in rows.
    """
    section = _prior_letters_section(build_prompt(_BODY, prior_drafts=_over_cap_drafts()))
    segments = section.split(_PRIOR_LETTER_SEPARATOR)
    assert len(segments) == PRIOR_DRAFT_LIMIT, (
        f"expected exactly {PRIOR_DRAFT_LIMIT} letters in the block, got {len(segments)}"
    )
    for index in range(PRIOR_DRAFT_LIMIT + 1):
        assert f"OVERCAP_SENTINEL_{index}" not in section, (
            f"letter {index} was sent past character {PRIOR_DRAFT_CHARS}"
        )


def test_prior_letters_are_added_beside_the_existing_prompt_furniture() -> None:
    """The new block is additive: the grounding block and the guardrail both survive."""
    prompt = build_prompt(
        _BODY,
        prior_entries=["An earlier entry about water."],
        prior_drafts=[_MARCH_LETTER_SENTINEL],
    )
    assert MEDICATION_GUARDRAIL in prompt
    assert "<prior>" in prompt, "the earlier-entries grounding block was displaced"
    assert _MARCH_LETTER_SENTINEL in _prior_letters_section(prompt)


def test_the_retry_prompt_carries_the_prior_letters_too() -> None:
    """A second attempt asks the same question, prior letters included.

    :func:`_retry_prompt` rebuilds through :func:`build_prompt`, so a dropped
    keyword there is a silent half-failure: the first pass would be grounded
    against what has already been said and the retry would not, and only the
    retry would repeat itself.
    """
    prompt = _retry_prompt(_BODY, None, _DEFAULT_MAX_NOTES, prior_drafts=[_MARCH_LETTER_SENTINEL])
    assert _MARCH_LETTER_SENTINEL in _prior_letters_section(prompt)
    assert NO_STYLE_TRANSFER_INSTRUCTION in prompt


def test_the_essay_prompt_carries_prior_letters_under_the_same_rule() -> None:
    """The essay half gets the same block, and the same anti-imitation rule.

    This is the half that reaches every account: ``_cache_essay`` builds a cloud
    LLM unconditionally, while the resonance half is discarded wholesale by a
    connected vault (see ``tests/test_creek_vault_reflect.py``).
    """
    prompt = _build_essay_prompt(
        _BODY, _ANCHOR_TEXT, _KIND, _NOTE, prior_drafts=[_MARCH_LETTER_SENTINEL]
    )
    assert _MARCH_LETTER_SENTINEL in _prior_letters_section(prompt)
    assert prompt.count(NO_STYLE_TRANSFER_INSTRUCTION) == 1


@pytest.mark.parametrize("empty", [None, []])
def test_the_essay_prompt_omits_the_section_when_there_are_no_prior_letters(
    empty: list[str] | None,
) -> None:
    """The essay builder's empty case matches the resonance builder's."""
    prompt = _build_essay_prompt(_BODY, _ANCHOR_TEXT, _KIND, _NOTE, prior_drafts=empty)
    assert _PRIOR_LETTERS_OPEN not in prompt
    assert NO_STYLE_TRANSFER_INSTRUCTION not in prompt
