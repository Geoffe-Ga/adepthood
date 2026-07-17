"""RED-state tests for the handwriting-transcription prompt builder.

``domain.transcription`` does not exist yet, so importing
:func:`~domain.transcription.build_transcription_prompt` below fails with
``ModuleNotFoundError: No module named 'domain.transcription'``. That failure,
not a passing test, is the correct RED state for this module.

The rest of these tests pin the contract the implementation must satisfy once
it exists: the prompt is a constant, zero-argument, plain-text string that
leads with the shared medication-safety guardrail from :mod:`domain.care`,
carries fixed conventions for illegible and uncertain handwriting, preserves
cross-outs and margin insertions faithfully, returns body text only (no
preamble or markdown), and never inherits the STRICT-JSON response contract
used by the sibling resonance/detection prompt builders.
"""

from __future__ import annotations

import inspect

import pytest

from domain.care import MEDICATION_GUARDRAIL
from domain.transcription import build_transcription_prompt

# Independent copy of the prompt body after the guardrail. Any drift between
# this literal and the source constant fails the golden test below.
_PROMPT_BODY = (
    "You are transcribing a photographed page of someone's handwritten "
    "journal into faithful body text for their digital journal entry.\n\n"
    "Transcribe every word exactly as written. Do not summarize, paraphrase, "
    "correct grammar or spelling, reword sentences, or add anything the "
    "writer did not write.\n\n"
    "Conventions:\n"
    "- If a word or short phrase is illegible, write [illegible] in its "
    "place and keep transcribing the rest of the sentence.\n"
    "- If you can make out a word but are not certain, write your best "
    "guess followed by a question mark inside brackets, e.g. [word?].\n"
    "- If a word or phrase is crossed out or struck through, omit it "
    "entirely from the transcription — do not include struck-through text, "
    "even in brackets.\n"
    "- If the writer added a word or phrase via a caret insertion or a "
    "margin note pointing back into the text, integrate it inline at the "
    "point the writer intended it to be inserted.\n\n"
    "Examples:\n"
    "- Handwriting shows: I felt <s>angry</s> frustrated about the "
    "meeting. Transcribe as: I felt frustrated about the meeting.\n"
    "- Handwriting shows a word you cannot make out in the middle of a "
    "sentence. Transcribe as: I went to the [illegible] with my sister.\n\n"
    "Return only the journal entry body text. No preamble, no commentary, "
    "no markdown formatting, no headers — just the transcribed body text."
)

# Golden snapshot: guardrail plus the exact remainder above, byte for byte.
_EXPECTED_PROMPT = f"{MEDICATION_GUARDRAIL}\n\n{_PROMPT_BODY}"


# ---------------------------------------------------------------------------
# Medication-safety guardrail
# ---------------------------------------------------------------------------


def test_build_transcription_prompt_starts_with_medication_guardrail() -> None:
    """The prompt begins with MEDICATION_GUARDRAIL, not merely contains it."""
    prompt = build_transcription_prompt()
    assert prompt.startswith(MEDICATION_GUARDRAIL)


# ---------------------------------------------------------------------------
# Transcription conventions
# ---------------------------------------------------------------------------

_CONVENTION_TOKENS = (
    ("illegible-word marker", "[illegible]"),
    ("uncertain-word marker", "[word?]"),
    ("cross-out omission rule", "crossed out or struck through"),
    ("caret / margin-note integration rule", "caret insertion or a margin note"),
    ("body-only, no-preamble, no-markdown rule", "no markdown formatting"),
    ("faithful, non-summarizing rule", "Do not summarize, paraphrase"),
)


_CONVENTION_IDS = [label for label, _ in _CONVENTION_TOKENS]


@pytest.mark.parametrize(("label", "token"), _CONVENTION_TOKENS, ids=_CONVENTION_IDS)
def test_build_transcription_prompt_contains_convention(label: str, token: str) -> None:
    """Each transcription convention/rule the AC requires is present verbatim."""
    prompt = build_transcription_prompt()
    assert token in prompt, f"missing {label!r}: expected {token!r} in prompt"


# ---------------------------------------------------------------------------
# Few-shot examples
# ---------------------------------------------------------------------------


def test_build_transcription_prompt_includes_cross_out_example() -> None:
    """The cross-out few-shot example's resolved output is present."""
    prompt = build_transcription_prompt()
    assert "felt frustrated about" in prompt


def test_build_transcription_prompt_includes_illegible_mid_sentence_example() -> None:
    """The illegible-mid-sentence few-shot example is present."""
    prompt = build_transcription_prompt()
    assert "I went to the [illegible] with my sister" in prompt


# ---------------------------------------------------------------------------
# Not the sibling STRICT-JSON contract
# ---------------------------------------------------------------------------


def test_build_transcription_prompt_has_no_json_response_contract() -> None:
    """This prompt returns body text, not the resonance/detection JSON tail."""
    prompt = build_transcription_prompt()
    assert "JSON" not in prompt


# ---------------------------------------------------------------------------
# Determinism and purity
# ---------------------------------------------------------------------------


def test_build_transcription_prompt_is_deterministic() -> None:
    """Two calls return the identical string — no hidden randomness or state."""
    assert build_transcription_prompt() == build_transcription_prompt()


def test_build_transcription_prompt_takes_no_arguments() -> None:
    """Zero-arg signature pins the cache-hit contract: nothing request-varying."""
    assert inspect.signature(build_transcription_prompt).parameters == {}


# ---------------------------------------------------------------------------
# Golden snapshot
# ---------------------------------------------------------------------------


def test_build_transcription_prompt_matches_golden_snapshot() -> None:
    """Exact text match against _EXPECTED_PROMPT, guardrail plus literal body."""
    assert build_transcription_prompt() == _EXPECTED_PROMPT
