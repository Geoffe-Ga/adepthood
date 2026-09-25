"""Tests for the Journal Photographer's transcription prompt and reply classifier.

The prompt is a constant, zero-argument, plain-text string that leads with the
shared medication-safety guardrail from :mod:`domain.care`. It asks for the text
in *any* image the writer captures -- handwritten, typed or printed pages,
screenshots of messages or documents, signs, whiteboards, photos of a screen --
keeps the handwriting conventions for handwritten text, fixes the conversational
line format that overlapping-screenshot dedupe (#2929) matches against, returns
body text only, and never inherits the STRICT-JSON response contract used by the
sibling resonance/detection prompt builders.

:func:`~domain.transcription.classify_transcription` is the pure check the
endpoint runs on the reply before it bills or returns anything: the
``[no text found]`` sentinel and a short refusal are typed outcomes, never the
page's text (#2851).
"""

from __future__ import annotations

import inspect

import pytest

from domain.care import MEDICATION_GUARDRAIL
from domain.transcription import (
    CONVERSATION_FORMAT_RULE,
    MAX_REFUSAL_CHARS,
    NO_TEXT_SENTINEL,
    REFUSAL_OPENERS,
    REFUSAL_TOPIC_CUES,
    SCREEN_PHOTO_RULE,
    TranscriptionVerdict,
    build_transcription_prompt,
    classify_transcription,
)
from tests.transcription_helpers import REPORTED_REFUSAL, REPORTED_REFUSAL_CURLY

# Independent copy of the conversational format sentence. #2929 merges
# overlapping screenshots by matching these lines, so the wording is pinned here
# separately from the golden body: a drift fails loudly in both places.
_CONVERSATION_FORMAT_SENTENCE = (
    "If the image shows a conversation, such as a text-message thread or a "
    "chat, write one message per line in reading order, prefix each line with "
    "the sender label exactly as shown (or Me: for the writer's own messages "
    "and the contact's name for theirs when no label is shown), keep a "
    "timestamp only when it sits inline with the message text, and ignore "
    "interface chrome such as the status bar, the input field and reaction "
    "badges."
)

# Independent copy of the screen-photo convention from the 2026-09-25 addendum.
_SCREEN_PHOTO_SENTENCE = (
    "If the image is a photo of a screen, transcribe the document or messages "
    "shown on it. Ignore window frames, browser tabs, menus, toolbars, "
    "taskbars, notifications and any other windows. Glare, moiré or a "
    "skewed angle are not reasons to decline — write [illegible] for any "
    "span you cannot read and keep going."
)

# Independent copy of the prompt body after the guardrail. Any drift between
# this literal and the source constant fails the golden test below.
_PROMPT_BODY = (
    "You are transcribing the text in an image into faithful body text for "
    "someone's digital journal entry. The image may be a handwritten page, a "
    "typed or printed page, a screenshot of messages or a document, a sign or "
    "a whiteboard, or a photo of a screen.\n\n"
    "Transcribe every word exactly as written. Do not summarize, paraphrase, "
    "correct grammar or spelling, reword sentences, or add anything the "
    "writer did not write.\n\n"
    "Do not judge whether the image belongs in a journal. The writer chose "
    "it; your only job is to transcribe its text. If the image contains no "
    "readable text at all, reply with exactly [no text found] and nothing "
    "else.\n\n"
    "Handwriting conventions (these apply to handwritten text):\n"
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
    f"Conversations: {_CONVERSATION_FORMAT_SENTENCE}\n\n"
    f"Screens: {_SCREEN_PHOTO_SENTENCE}\n\n"
    "Examples:\n"
    "- Handwriting shows: I felt <s>angry</s> frustrated about the "
    "meeting. Transcribe as: I felt frustrated about the meeting.\n"
    "- Handwriting shows a word you cannot make out in the middle of a "
    "sentence. Transcribe as: I went to the [illegible] with my sister.\n"
    "- A screenshot shows a message from Sam, then the writer's reply. "
    "Transcribe as:\nSam: Are you still coming tonight?\n"
    "Me: Yes — leaving at 6.\n"
    "- A phone photo of a laptop shows a document. Transcribe the document's "
    "paragraphs only, not the tab title, the address bar or the menu.\n\n"
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
# Scope: any image of text
# ---------------------------------------------------------------------------

_INPUT_TERMS = (
    "handwritten page",
    "typed or printed page",
    "screenshot of messages or a document",
    "a sign or a whiteboard",
    "photo of a screen",
)


@pytest.mark.parametrize("term", _INPUT_TERMS)
def test_build_transcription_prompt_names_each_input_kind(term: str) -> None:
    """The model is told the full range of inputs, so it transcribes instead of refusing."""
    assert term in build_transcription_prompt()


def test_build_transcription_prompt_does_not_scope_to_handwritten_journals() -> None:
    """The opening no longer frames the task as handwritten-journal-only (#2851)."""
    assert "handwritten journal" not in build_transcription_prompt()


def test_build_transcription_prompt_forbids_judging_and_names_the_sentinel() -> None:
    """The model is told not to gatekeep, and how to report an image with no text."""
    prompt = build_transcription_prompt()
    assert "Do not judge whether the image belongs in a journal." in prompt
    assert f"reply with exactly {NO_TEXT_SENTINEL} and nothing else" in prompt
    assert NO_TEXT_SENTINEL == "[no text found]"


def test_conversation_format_sentence_is_pinned_verbatim() -> None:
    """#2929 relies on this exact sentence; it must not drift silently."""
    assert _CONVERSATION_FORMAT_SENTENCE == CONVERSATION_FORMAT_RULE
    assert _CONVERSATION_FORMAT_SENTENCE in build_transcription_prompt()


def test_screen_photo_convention_is_present() -> None:
    """Photos of another screen: ignore chrome, do not decline for glare."""
    assert _SCREEN_PHOTO_SENTENCE == SCREEN_PHOTO_RULE
    prompt = build_transcription_prompt()
    assert _SCREEN_PHOTO_SENTENCE in prompt
    for token in ("window frames", "taskbars", "notifications", "moiré", "not reasons to decline"):
        assert token in prompt


# ---------------------------------------------------------------------------
# Transcription conventions
# ---------------------------------------------------------------------------

_CONVENTION_TOKENS = (
    ("handwriting-conventions label", "Handwriting conventions (these apply to handwritten text):"),
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


def test_build_transcription_prompt_includes_sender_labelled_example() -> None:
    """The message-thread example shows sender-labelled lines."""
    prompt = build_transcription_prompt()
    assert "Sam: Are you still coming tonight?\nMe: Yes — leaving at 6." in prompt


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


# ---------------------------------------------------------------------------
# Reply classifier constants
# ---------------------------------------------------------------------------


def test_refusal_openers_are_the_closed_set() -> None:
    """The openers are exactly the five refusal phrasings, nothing broader."""
    assert REFUSAL_OPENERS == (
        "I'm not able to",
        "I can't",
        "I cannot",
        "I'm unable to",
        "Sorry, I can't",
    )


def test_refusal_topic_cues_are_the_closed_set() -> None:
    """The cues name the request or the image, never everyday journal words."""
    assert REFUSAL_TOPIC_CUES == ("image", "photo", "picture", "screenshot", "transcri", "request")


# The "~400 characters" cap the issue body proposed; the reported refusal alone
# overruns it, which is why the real cap is larger.
_ISSUE_PROPOSED_CAP = 400


def test_max_refusal_chars_leaves_slack_over_the_reported_refusal() -> None:
    """The reported refusal is already past 400 chars; the cap must clear it."""
    assert len(REPORTED_REFUSAL) > _ISSUE_PROPOSED_CAP
    assert len(REPORTED_REFUSAL) < MAX_REFUSAL_CHARS


def test_verdict_values_are_the_wire_codes() -> None:
    """The failure verdicts double as the endpoint's 422 detail codes."""
    assert TranscriptionVerdict.NO_TEXT_FOUND.value == "no_text_found"
    assert TranscriptionVerdict.REFUSED.value == "transcription_refused"
    assert TranscriptionVerdict.TRANSCRIBED.value == "transcribed"


# ---------------------------------------------------------------------------
# Reply classifier
# ---------------------------------------------------------------------------

_LONG_I_CANT_BELIEVE = (
    "I can't believe how the day went. " * 40
    + "The photo from the lake is still on my desk and I keep looking at it."
)
_TWO_PARAGRAPH_I_CANT_BELIEVE = (
    "I can't believe she sent that screenshot to the whole group.\n\n"
    "Tomorrow I will ask her why, calmly, and listen before I answer."
)
_STUB_VISION_REPLY = (
    'BotMason gazes at your 1 attached image(s) and reflects on your words: "" '
    "— Let the Archetypal Wavelength guide your reflection."
)

_CLASSIFIER_CASES = (
    pytest.param("[no text found]", TranscriptionVerdict.NO_TEXT_FOUND, id="sentinel"),
    pytest.param("  [no text found]\n", TranscriptionVerdict.NO_TEXT_FOUND, id="sentinel-padded"),
    pytest.param("[no text found].", TranscriptionVerdict.NO_TEXT_FOUND, id="sentinel-period"),
    pytest.param("", TranscriptionVerdict.NO_TEXT_FOUND, id="empty"),
    pytest.param(" \n\t ", TranscriptionVerdict.NO_TEXT_FOUND, id="whitespace-only"),
    pytest.param(REPORTED_REFUSAL, TranscriptionVerdict.REFUSED, id="reported-refusal"),
    pytest.param(REPORTED_REFUSAL_CURLY, TranscriptionVerdict.REFUSED, id="reported-curly"),
    pytest.param(
        "I cannot transcribe this image.", TranscriptionVerdict.REFUSED, id="i-cannot-transcribe"
    ),
    pytest.param(
        "I'm unable to read the text in this photo.", TranscriptionVerdict.REFUSED, id="unable"
    ),
    pytest.param(
        "Sorry, I can't help with this request.", TranscriptionVerdict.REFUSED, id="sorry"
    ),
    pytest.param(
        "  I can\u2019t read this picture.  ", TranscriptionVerdict.REFUSED, id="curly-padded"
    ),
    pytest.param(
        "I can't sleep again tonight.", TranscriptionVerdict.TRANSCRIBED, id="journal-i-cant"
    ),
    pytest.param(
        "I cannot keep doing this.", TranscriptionVerdict.TRANSCRIBED, id="journal-i-cannot"
    ),
    pytest.param(_LONG_I_CANT_BELIEVE, TranscriptionVerdict.TRANSCRIBED, id="long-i-cant-believe"),
    pytest.param(
        _TWO_PARAGRAPH_I_CANT_BELIEVE, TranscriptionVerdict.TRANSCRIBED, id="two-paragraphs"
    ),
    pytest.param(
        "The screenshot said I'm not able to come.",
        TranscriptionVerdict.TRANSCRIBED,
        id="opener-not-at-start",
    ),
    pytest.param(
        "Sam: Are you still coming tonight?\nMe: Yes — leaving at 6.",
        TranscriptionVerdict.TRANSCRIBED,
        id="message-thread",
    ),
    pytest.param("[no text found] on the back", TranscriptionVerdict.TRANSCRIBED, id="not-bare"),
    pytest.param(_STUB_VISION_REPLY, TranscriptionVerdict.TRANSCRIBED, id="dev-stub"),
)


@pytest.mark.parametrize(("reply", "verdict"), _CLASSIFIER_CASES)
def test_classify_transcription(reply: str, verdict: TranscriptionVerdict) -> None:
    """Only the sentinel, an empty read, or a short on-topic refusal are unusable."""
    assert classify_transcription(reply) is verdict


def _refusal_of_length(length: int) -> str:
    """Return a single-paragraph opener+cue refusal padded to exactly ``length``."""
    head = "I can't read this image"
    return head + "." * (length - len(head))


def test_refusal_exactly_at_the_cap_is_refused() -> None:
    """A refusal-shaped reply of exactly MAX_REFUSAL_CHARS still counts."""
    reply = _refusal_of_length(MAX_REFUSAL_CHARS)
    assert len(reply) == MAX_REFUSAL_CHARS
    assert classify_transcription(reply) is TranscriptionVerdict.REFUSED


def test_refusal_shape_one_past_the_cap_is_transcribed() -> None:
    """One character past the cap is too long to be a refusal; it is page text."""
    reply = _refusal_of_length(MAX_REFUSAL_CHARS + 1)
    assert classify_transcription(reply) is TranscriptionVerdict.TRANSCRIBED
