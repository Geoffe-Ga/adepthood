"""Transcription prompt and reply classifier for the Journal Photographer.

Build the plain-text instruction sent to the vision LLM when a writer captures
an image of text -- a handwritten page, a typed or printed page, a screenshot of
messages or a document, a sign, a whiteboard, a photo of another screen -- and
wants its text as faithful body text for a digital entry. Like its sibling
resonance/detection prompt builders, this leads with the shared
medication-safety guardrail from :mod:`domain.care`, but unlike them it
deliberately returns *body text only* -- it carries no STRICT-JSON response
contract, because the model's job here is transcription, not structured
extraction.

The conventions are fixed: transcribe every word verbatim (no summarizing,
correcting, or rewording); never judge whether the image belongs in a journal,
and answer an image with no readable text with exactly :data:`NO_TEXT_SENTINEL`.
For handwriting, mark an unreadable word ``[illegible]``; mark an uncertain
reading as a best guess with a trailing question mark in brackets, e.g.
``[word?]``; drop struck-through text entirely; and integrate caret or margin
insertions inline where the writer intended them. Conversations follow
:data:`CONVERSATION_FORMAT_RULE` (one sender-labelled message per line, in
reading order), which client-side screenshot-overlap dedupe (#2929) relies on;
photos of a screen follow :data:`SCREEN_PHOTO_RULE`.

The prompt is a zero-argument, deterministic constant derived from nothing
user-specific. Holding the whole instruction as a fixed string means every call
sends byte-identical text, which lets the provider serve prompt-cache hits
across requests instead of re-billing the shared preamble each time.

:func:`classify_transcription` is the pure check the endpoint runs on the reply
before metering or returning it: the sentinel (or an empty reply) and a short
on-topic refusal are typed outcomes, never the page's text (#2851).
"""

from __future__ import annotations

import enum
import re

from domain.care import MEDICATION_GUARDRAIL

#: The exact reply the prompt asks for when an image holds no readable text.
NO_TEXT_SENTINEL = "[no text found]"

#: How a conversation screenshot is written out. Pinned verbatim by its test
#: because client-side overlap dedupe (#2929) matches lines in this format.
CONVERSATION_FORMAT_RULE = (
    "If the image shows a conversation, such as a text-message thread or a "
    "chat, write one message per line in reading order, prefix each line with "
    "the sender label exactly as shown (or Me: for the writer's own messages "
    "and the contact's name for theirs when no label is shown), keep a "
    "timestamp only when it sits inline with the message text, and ignore "
    "interface chrome such as the status bar, the input field and reaction "
    "badges."
)

#: How a photo of another screen (laptop, monitor, second phone) is read.
SCREEN_PHOTO_RULE = (
    "If the image is a photo of a screen, transcribe the document or messages "
    "shown on it. Ignore window frames, browser tabs, menus, toolbars, "
    "taskbars, notifications and any other windows. Glare, moiré or a "
    "skewed angle are not reasons to decline — write [illegible] for any "
    "span you cannot read and keep going."
)

# The prompt body after the guardrail: the scope, the fixed transcription
# conventions, the few-shot examples, and the body-only output rule. One module
# constant so the wording is reviewed in a single place; it interpolates only
# the module constants above, at import time, so it stays byte-identical.
_TRANSCRIPTION_INSTRUCTIONS = (
    "You are transcribing the text in an image into faithful body text for "
    "someone's digital journal entry. The image may be a handwritten page, a "
    "typed or printed page, a screenshot of messages or a document, a sign or "
    "a whiteboard, or a photo of a screen.\n\n"
    "Transcribe every word exactly as written. Do not summarize, paraphrase, "
    "correct grammar or spelling, reword sentences, or add anything the "
    "writer did not write.\n\n"
    "Do not judge whether the image belongs in a journal. The writer chose "
    "it; your only job is to transcribe its text. If the image contains no "
    f"readable text at all, reply with exactly {NO_TEXT_SENTINEL} and nothing "
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
    f"Conversations: {CONVERSATION_FORMAT_RULE}\n\n"
    f"Screens: {SCREEN_PHOTO_RULE}\n\n"
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

#: The closed set of phrasings a vision model opens a refusal with. A reply is
#: only a refusal when it *starts* with one of these (see
#: :func:`classify_transcription` for the other conditions).
REFUSAL_OPENERS = (
    "I'm not able to",
    "I can't",
    "I cannot",
    "I'm unable to",
    "Sorry, I can't",
)

#: A refusal's *first sentence* names what it declines: the act of
#: transcribing, or the image/request itself with a pointing determiner ("this
#: image", "the image you've shared"). Bare nouns are not enough -- a journal
#: page says "I can't picture my life...", "the photo of Dad", "my request" --
#: so only these determiner-bound phrases count, and only in the first sentence.
REFUSAL_OBJECT_CUES = (
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

#: Cues that are word stems rather than whole words: ``transcri`` stands for
#: transcribe, transcription and the like, so only its start is anchored.
_OPEN_ENDED_CUES = frozenset({"transcri"})

#: :data:`REFUSAL_OBJECT_CUES` as whole-word matches. A plain substring test
#: read "this imagery" as "this image" and "this requested" as "this request",
#: throwing a writer's page away as a refusal.
_REFUSAL_OBJECT_PATTERN = re.compile(
    "|".join(
        rf"\b{re.escape(cue)}" + ("" if cue in _OPEN_ENDED_CUES else r"\b")
        for cue in REFUSAL_OBJECT_CUES
    )
)

#: Longest reply that can still be a refusal. The reported refusal (#2851) is
#: 401 characters once completed past the ellipsis it was reported with; half
#: again absorbs a longer apology while keeping most real pages out of reach.
MAX_REFUSAL_CHARS = 600

_PARAGRAPH_BREAK = "\n\n"
# The first sentence ends at the first terminal punctuation or line break.
_SENTENCE_END = re.compile(r"[.!?\n]")
# Providers emit typographic apostrophes ("I\u2019m"); fold them so the ASCII
# openers still match.
_APOSTROPHE_FOLD = str.maketrans({"\u2019": "'", "\u2018": "'"})


class TranscriptionVerdict(enum.StrEnum):
    """What a transcription reply turned out to be.

    The two failure values are the endpoint's 422 ``detail`` codes, so the wire
    taxonomy is defined once, here.
    """

    TRANSCRIBED = "transcribed"
    NO_TEXT_FOUND = "no_text_found"
    REFUSED = "transcription_refused"


def build_transcription_prompt() -> str:
    """Return the any-image-of-text transcription prompt (guardrail + conventions).

    Pure, zero-argument, and deterministic: the medication-safety guardrail
    followed by the fixed transcription instructions, identical on every call.
    Returns body-text instructions only — no STRICT-JSON response contract.
    """
    return f"{MEDICATION_GUARDRAIL}\n\n{_TRANSCRIPTION_INSTRUCTIONS}"


def _normalise(reply: str) -> str:
    """Fold typographic apostrophes and strip surrounding whitespace."""
    return reply.translate(_APOSTROPHE_FOLD).strip()


def _is_no_text(normalised: str) -> bool:
    """Return True for an empty reply or the sentinel in any case (trailing period allowed)."""
    return normalised.rstrip(".").casefold() in {"", NO_TEXT_SENTINEL}


def _first_sentence(normalised: str) -> str:
    """Return the casefolded text before the first sentence end or line break."""
    return _SENTENCE_END.split(normalised, maxsplit=1)[0].casefold()


def _is_refusal(normalised: str) -> bool:
    """Return True for a short, single-paragraph reply whose first sentence declines the image."""
    opening = _first_sentence(normalised)
    return (
        _PARAGRAPH_BREAK not in normalised
        and len(normalised) <= MAX_REFUSAL_CHARS
        and normalised.startswith(REFUSAL_OPENERS)
        and _REFUSAL_OBJECT_PATTERN.search(opening) is not None
    )


def classify_transcription(reply: str) -> TranscriptionVerdict:
    """Classify a vision reply as page text, an empty read, or a refusal.

    Pure and never logs: the reply is page content. Only the sentinel or an
    empty reply is :attr:`~TranscriptionVerdict.NO_TEXT_FOUND`; a refusal must
    be one paragraph, at most :data:`MAX_REFUSAL_CHARS` long, open with one of
    :data:`REFUSAL_OPENERS`, and name one of :data:`REFUSAL_OBJECT_CUES` in its
    first sentence.
    Everything else -- including a long or multi-paragraph page that opens
    "I can't believe..." -- is :attr:`~TranscriptionVerdict.TRANSCRIBED`.
    """
    normalised = _normalise(reply)
    if _is_no_text(normalised):
        return TranscriptionVerdict.NO_TEXT_FOUND
    if _is_refusal(normalised):
        return TranscriptionVerdict.REFUSED
    return TranscriptionVerdict.TRANSCRIBED
