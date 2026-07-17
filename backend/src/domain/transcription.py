"""Handwriting-transcription prompt for the Journal Photographer.

Build the plain-text instruction sent to the LLM when a user photographs a page
of their handwritten journal and wants it turned into faithful body text for a
digital entry. Like its sibling resonance/detection prompt builders, this leads
with the shared medication-safety guardrail from :mod:`domain.care`, but unlike
them it deliberately returns *body text only* — it carries no STRICT-JSON
response contract, because the model's job here is transcription, not structured
extraction.

The conventions are fixed: transcribe every word verbatim (no summarizing,
correcting, or rewording); mark an unreadable word ``[illegible]``; mark an
uncertain reading as a best guess with a trailing question mark in brackets,
e.g. ``[word?]``; drop struck-through text entirely; and integrate caret or
margin insertions inline where the writer intended them.

The prompt is a zero-argument, deterministic constant derived from nothing
user-specific. Holding the whole instruction as a fixed string means every call
sends byte-identical text, which lets the provider serve prompt-cache hits
across requests instead of re-billing the shared preamble each time.
"""

from __future__ import annotations

from domain.care import MEDICATION_GUARDRAIL

# The prompt body after the guardrail: the fixed transcription conventions,
# the two few-shot examples, and the body-only output rule. One module
# constant so the wording is reviewed in a single place.
_TRANSCRIPTION_INSTRUCTIONS = (
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


def build_transcription_prompt() -> str:
    """Return the handwriting-transcription prompt (guardrail + conventions).

    Pure, zero-argument, and deterministic: the medication-safety guardrail
    followed by the fixed transcription instructions, identical on every call.
    Returns body-text instructions only — no STRICT-JSON response contract.
    """
    return f"{MEDICATION_GUARDRAIL}\n\n{_TRANSCRIPTION_INSTRUCTIONS}"
