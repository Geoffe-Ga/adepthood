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
    REFUSAL_OBJECT_CUES,
    REFUSAL_OPENERS,
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


def test_refusal_object_cues_are_the_closed_set() -> None:
    """The cues are determiner-bound refusal objects, never bare journal nouns."""
    assert REFUSAL_OBJECT_CUES == (
        "transcri",
        "this image",
        "this photo",
        "this picture",
        "this screenshot",
        "this request",
        "the image you",
        "the photo you",
        "the picture you",
        "the screenshot you",
    )


# The "~400 characters" cap the issue body proposed; the reported refusal alone
# overruns it, which is why the real cap is larger.
_ISSUE_PROPOSED_CAP = 400
# The chosen cap: the reported refusal plus half again.
_REFUSAL_CAP = 600


def test_max_refusal_chars_leaves_slack_over_the_reported_refusal() -> None:
    """The reported refusal is already past 400 chars; the cap must clear it."""
    assert len(REPORTED_REFUSAL) > _ISSUE_PROPOSED_CAP
    assert len(REPORTED_REFUSAL) < MAX_REFUSAL_CHARS
    # Pinned: widening the cap lets more real pages be read as refusals.
    assert MAX_REFUSAL_CHARS == _REFUSAL_CAP


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

# Real journal pages that open like a refusal and use everyday image/request
# words later on (review of #2851). Each is the writer's text and must survive.
_LONG_SLEEPLESS_PAGE = (
    "I can't sleep. "
    + "The house settles and the fridge hums and I lie here counting the hours. " * 13
    + "Maybe I should picture something calm."
)
_JOURNAL_PAGES_THAT_OPEN_LIKE_REFUSALS = (
    pytest.param(
        "I can't picture my life without her anymore. Today was the first day I noticed the quiet.",
        id="picture-my-life",
    ),
    pytest.param(
        "I can't stop looking at the photo of Dad from 1987.\nHe looks so young.",
        id="photo-of-dad",
    ),
    pytest.param(
        "I cannot believe she turned down my request for time off...",
        id="my-request",
    ),
    pytest.param(
        "I'm unable to shake the image of the accident from my mind.",
        id="image-of-the-accident",
    ),
    pytest.param(_LONG_SLEEPLESS_PAGE, id="long-sleepless-page"),
    pytest.param(
        "I can't help with this anymore; Mom needs more than I can give right now.",
        id="help-with-this",
    ),
    pytest.param(
        "Sorry, I can't keep apologising for everything. That was the photo I "
        "wanted to take today.",
        id="sorry-i-cant-keep",
    ),
    pytest.param(
        "I'm not able to run yet, but the physio sent a picture of the stretches.",
        id="not-able-to-run",
    ),
    pytest.param(
        "I cannot remember the last time I took a picture of the sunset.",
        id="picture-of-the-sunset",
    ),
    pytest.param(
        "I can't answer her request tonight. Tomorrow, maybe.",
        id="her-request",
    ),
)


# The refusal object must sit in the *first* sentence: each of these carries a
# cue only after a sentence end (., !, ? or a line break), so it is page text.
_CUE_AFTER_FIRST_SENTENCE = (
    pytest.param("I can't sleep. This image of the moon keeps me up.", id="after-period"),
    pytest.param("I can't believe it! This photo is from our first trip.", id="after-bang"),
    pytest.param("I can't decide? This request from work can wait.", id="after-question"),
    pytest.param(
        "I can't stop crying\nthis picture of us is still on the fridge", id="after-newline"
    ),
)


@pytest.mark.parametrize("page", _CUE_AFTER_FIRST_SENTENCE)
def test_refusal_cue_after_the_first_sentence_is_transcribed(page: str) -> None:
    """Only the opening sentence can make a reply a refusal."""
    assert classify_transcription(page) is TranscriptionVerdict.TRANSCRIBED


# One refusal per object cue, so dropping any single cue is caught by behaviour,
# not only by the tuple-equality test.
_ONE_REFUSAL_PER_CUE = (
    pytest.param("I cannot transcribe handwriting from this kind of file.", id="transcri"),
    pytest.param("I can't read this image.", id="this-image"),
    pytest.param("I'm unable to make out this photo.", id="this-photo"),
    pytest.param("I can't describe this picture for you.", id="this-picture"),
    pytest.param("Sorry, I can't process this screenshot.", id="this-screenshot"),
    pytest.param("I'm not able to complete this request.", id="this-request"),
    pytest.param("I can't read the image you've shared.", id="the-image-you"),
    pytest.param("I cannot work with the photo you sent.", id="the-photo-you"),
    pytest.param("I'm unable to use the picture you uploaded.", id="the-picture-you"),
    pytest.param("I can't read the screenshot you attached.", id="the-screenshot-you"),
)


@pytest.mark.parametrize("reply", _ONE_REFUSAL_PER_CUE)
def test_each_object_cue_marks_a_refusal(reply: str) -> None:
    """Each determiner-bound object in the opening sentence makes a refusal."""
    assert classify_transcription(reply) is TranscriptionVerdict.REFUSED


def test_refusal_shaped_first_paragraph_followed_by_more_is_transcribed() -> None:
    """A second paragraph means page text, even under a refusal-shaped opening."""
    page = "I cannot transcribe this image of my feelings into words.\n\nSo I will just write."
    assert classify_transcription(page) is TranscriptionVerdict.TRANSCRIBED


def test_refusal_cue_match_ignores_case() -> None:
    """A capitalised refusal object in the first sentence still counts."""
    reply = "I can't help with This Request."
    assert classify_transcription(reply) is TranscriptionVerdict.REFUSED


@pytest.mark.parametrize("page", _JOURNAL_PAGES_THAT_OPEN_LIKE_REFUSALS)
def test_journal_page_opening_like_a_refusal_is_transcribed(page: str) -> None:
    """An image or request word outside a refusal-shaped first sentence is page text."""
    assert classify_transcription(page) is TranscriptionVerdict.TRANSCRIBED


_CLASSIFIER_CASES = (
    pytest.param("[no text found]", TranscriptionVerdict.NO_TEXT_FOUND, id="sentinel"),
    pytest.param("  [no text found]\n", TranscriptionVerdict.NO_TEXT_FOUND, id="sentinel-padded"),
    pytest.param("[no text found].", TranscriptionVerdict.NO_TEXT_FOUND, id="sentinel-period"),
    pytest.param("[No text found]", TranscriptionVerdict.NO_TEXT_FOUND, id="sentinel-capitalised"),
    pytest.param("[NO TEXT FOUND].", TranscriptionVerdict.NO_TEXT_FOUND, id="sentinel-shouted"),
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
