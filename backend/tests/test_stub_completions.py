"""The stub provider's canned answer to a structured resonance request.

The default provider is the stub (``BOTMASON_PROVIDER`` unset), which is what
the end-to-end lane runs against: no key, no network, no third party. Until now
it answered every prompt with the same prose, so a resonance pass driven through
it could only ever reach the zero-note half of the journey — the completion was
not JSON and nothing could anchor.

These tests pin the narrow thing that changed: when the prompt is the one
``domain.resonance.build_prompt`` builds, the stub answers in the shape that
prompt asks for, quoting the entry verbatim so the domain's anchoring — which
never trusts a model-supplied index — actually resolves it. Every assertion here
builds its prompt with ``build_prompt`` rather than a hand-copied string, so a
reworded prompt is caught here instead of silently turning the canned reading
back into prose.
"""

from __future__ import annotations

import json

import pytest

from domain.detection import DetectionCandidate, build_detection_prompt, detect_completions
from domain.resonance import (
    ANCHOR_TEXT_MAX,
    ESSAY_TASK_INSTRUCTION,
    MARGINALIA_JSON_SHAPE,
    PROMPT_ECHO_MARKERS,
    MarginaliaAnchored,
    build_prompt,
    explain_no_notes,
    generate_essay,
    generate_marginalia,
)
from services.botmason import STUB_MODEL_NAME, STUB_PROVIDER_NAME, generate_response
from services.marginalia import BotmasonResonanceLLM
from services.stub_completions import canned_completion

ENTRY = "The willow bent all night and did not break. I slept badly and woke grateful."
CLOSING_SENTENCE = "I slept badly and woke grateful."
UNPUNCTUATED = "the willow bending all night without once breaking"


def _notes(completion: str) -> list[dict[str, str]]:
    """Decode a canned completion's ``notes`` array."""
    payload = json.loads(completion)
    assert isinstance(payload, dict)
    notes = payload["notes"]
    assert isinstance(notes, list)
    return notes


def test_ordinary_chat_prompt_gets_no_canned_completion() -> None:
    """A prompt that is not the resonance ask is none of this module's business."""
    assert canned_completion("What is the Archetypal Wavelength?") is None


def test_a_prompt_naming_the_shape_but_carrying_no_entry_gets_prose() -> None:
    """Both halves of the marker are required before anything is canned.

    A chat turn that happens to quote the JSON shape is still a chat turn: with
    no entry to read there is nothing to quote, and answering with an empty
    notes array would be a reading of a page that was never sent.
    """
    assert canned_completion(f"what does {MARGINALIA_JSON_SHAPE} mean?") is None


def test_canned_completion_detects_an_explicitly_completed_candidate() -> None:
    """The default provider makes the habit-offer journey runnable without a network."""
    prompt = build_detection_prompt(
        "I completed Morning walk before breakfast.",
        [DetectionCandidate(index=0, target_type="habit", target_id=7, name="Morning walk")],
    )

    completion = canned_completion(prompt)

    assert completion is not None
    assert json.loads(completion) == {"hits": [{"index": 0, "quote": "completed Morning walk"}]}


@pytest.mark.asyncio
async def test_detection_over_the_stub_resolves_the_candidate_and_quote() -> None:
    body = "I completed Morning walk before breakfast."
    candidates = [
        DetectionCandidate(index=0, target_type="habit", target_id=7, name="Morning walk")
    ]

    hits = await detect_completions(body, candidates=candidates, llm=BotmasonResonanceLLM(None))

    assert len(hits) == 1
    assert hits[0].target_id == 7
    assert hits[0].anchor_text == "completed Morning walk"


def test_canned_detection_does_not_treat_an_intention_as_a_completion() -> None:
    prompt = build_detection_prompt(
        "I plan to complete Morning walk tomorrow.",
        [DetectionCandidate(index=0, target_type="habit", target_id=7, name="Morning walk")],
    )

    completion = canned_completion(prompt)

    assert completion is not None
    assert json.loads(completion) == {"hits": []}


def test_canned_completion_quotes_the_entry_verbatim() -> None:
    """The quote is copied out of the entry, so the domain can anchor it.

    It is the closing sentence, which is what puts the span at a non-zero
    offset: a quote taken from the head of the page anchors at zero, and a test
    reading that span cannot tell a resolved offset from a hard-coded one.
    """
    completion = canned_completion(build_prompt(ENTRY))

    assert completion is not None
    note = _notes(completion)[0]
    assert note["quote"] == CLOSING_SENTENCE
    assert ENTRY.index(note["quote"]) > 0
    assert note["kind"] == "theme"
    assert note["note"].strip() != ""


def test_canned_completion_declines_when_there_is_no_sentence_to_copy() -> None:
    """An entry with no sentence boundary yields a well-formed empty array.

    This is the stub's decline, and it is the only reason it declines: it will
    not paraphrase, so a page it cannot quote is a page it has nothing to say
    about. The lane reaches the zero-note half of the journey through it.
    """
    completion = canned_completion(build_prompt(UNPUNCTUATED))

    assert completion is not None
    assert _notes(completion) == []


def test_canned_quote_never_exceeds_the_anchor_cap() -> None:
    """A long opening sentence is truncated, and a prefix is still verbatim."""
    body = f"{'a rope of river light ' * 40}."
    completion = canned_completion(build_prompt(body))

    assert completion is not None
    quote = _notes(completion)[0]["quote"]
    assert len(quote) <= ANCHOR_TEXT_MAX
    assert quote in body


@pytest.mark.asyncio
async def test_stub_provider_serves_the_canned_completion() -> None:
    """The default provider — no env var, no key, no network — returns it."""
    response = await generate_response(build_prompt(ENTRY), [])

    assert response.provider == STUB_PROVIDER_NAME
    assert response.model == STUB_MODEL_NAME
    # Stub traffic stays free, which is what keeps the usage log honest.
    assert response.prompt_tokens == 0
    assert response.completion_tokens == 0
    assert _notes(response.text)[0]["quote"] == CLOSING_SENTENCE


@pytest.mark.asyncio
async def test_a_pass_over_the_stub_anchors_a_note_to_the_entry() -> None:
    """End of the seam: the domain resolves the canned quote to a real span."""
    outcome = await generate_marginalia(ENTRY, llm=BotmasonResonanceLLM(None))

    assert outcome.kept == 1
    note = outcome.notes[0]
    assert note.anchor_start > 0
    assert ENTRY[note.anchor_start : note.anchor_end] == CLOSING_SENTENCE
    assert explain_no_notes(outcome) is None


@pytest.mark.asyncio
async def test_a_pass_the_stub_declines_leaves_the_writer_a_sentence() -> None:
    """The zero-note half still explains itself rather than going quiet."""
    outcome = await generate_marginalia(UNPUNCTUATED, llm=BotmasonResonanceLLM(None))

    assert outcome.kept == 0
    assert outcome.completion_parsed is True
    assert outcome.proposed == 0
    message = explain_no_notes(outcome)
    assert message is not None
    assert message.strip() != ""


# --- The essay ask (#2762) -------------------------------------------------

_ANCHORED = MarginaliaAnchored(
    kind="theme",
    anchor_start=ENTRY.index(CLOSING_SENTENCE),
    anchor_end=ENTRY.index(CLOSING_SENTENCE) + len(CLOSING_SENTENCE),
    anchor_text=CLOSING_SENTENCE,
    note="You set this down plainly, and then moved past it.",
)


class _PromptRecorder:
    """A ``ResonanceLLM`` that serves the real stub and keeps the prompt it sent."""

    def __init__(self) -> None:
        self.prompt: str | None = None
        self._inner = BotmasonResonanceLLM(None)

    async def complete(self, prompt: str) -> str:
        self.prompt = prompt
        return await self._inner.complete(prompt)


async def _stub_essay_prompt() -> str:
    """Return the essay prompt exactly as ``generate_essay`` builds it."""
    recorder = _PromptRecorder()
    await generate_essay(llm=recorder, body=ENTRY, note=_ANCHORED)
    assert recorder.prompt is not None
    return recorder.prompt


@pytest.mark.asyncio
async def test_the_essay_ask_gets_a_letter_not_the_prompt_back() -> None:
    """The default provider answers the essay prompt with something readable.

    Before #2762 this prompt fell through to the canned chat sentence, which
    quotes its whole input -- so a stub-served letter was the app's own prompt,
    medication guardrail included, handed to the writer.
    """
    completion = canned_completion(await _stub_essay_prompt())

    assert completion is not None
    assert completion.strip() != ""
    for marker in PROMPT_ECHO_MARKERS:
        assert marker not in completion


@pytest.mark.asyncio
async def test_the_canned_letter_quotes_the_passage_it_expands() -> None:
    """It is a letter about *this* note, not a fortune cookie.

    Quoting the writer verbatim also exercises the guard's one real risk: a
    letter that repeats the writer's words must survive it.
    """
    completion = canned_completion(await _stub_essay_prompt())

    assert completion is not None
    assert CLOSING_SENTENCE in completion


@pytest.mark.asyncio
async def test_an_essay_that_survives_the_guard_comes_back_from_the_domain() -> None:
    """End of the seam: the stub's letter is published rather than refused."""
    essay = await generate_essay(llm=BotmasonResonanceLLM(None), body=ENTRY, note=_ANCHORED)

    assert essay is not None
    assert CLOSING_SENTENCE in essay


def test_an_essay_ask_with_no_passage_block_is_not_answered() -> None:
    """Both halves of the marker are required, as on the marginalia side.

    A prompt naming the task but carrying no passage is a shape this module does
    not recognise, and inventing a letter about nothing would be worse than
    declining.
    """
    assert canned_completion(f"Some other ask. {ESSAY_TASK_INSTRUCTION}") is None


def test_the_marginalia_ask_still_gets_json_not_a_letter() -> None:
    """The half that already worked keeps working: essay recognition is additive."""
    completion = canned_completion(build_prompt(ENTRY))

    assert completion is not None
    assert _notes(completion)[0]["quote"] == CLOSING_SENTENCE
