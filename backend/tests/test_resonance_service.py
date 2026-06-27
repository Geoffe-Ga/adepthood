"""Tests for the resonance generation domain service (journal-resonance-04)."""

from __future__ import annotations

import json

import pytest

from domain import resonance
from domain.resonance import generate_marginalia
from models.marginalia import MarginaliaKind

_BODY = (
    "Today I walked by the river and felt the old fear rise again. "
    "But I noticed the willow bending without breaking, and something settled."
)


class FakeLLM:
    """Injected LLM stub: returns a fixed completion, records the prompt."""

    def __init__(self, completion: str) -> None:
        """Store the canned completion this fake will return."""
        self._completion = completion
        self.prompt: str | None = None

    async def complete(self, prompt: str) -> str:
        self.prompt = prompt
        return self._completion


def _notes_json(*notes: dict[str, str]) -> str:
    return json.dumps({"notes": list(notes)})


def test_valid_kinds_match_the_model_enum() -> None:
    """The domain's local kind set must not drift from MarginaliaKind."""
    assert {k.value for k in MarginaliaKind} == resonance.VALID_KINDS


@pytest.mark.asyncio
async def test_valid_drafts_become_anchored_notes() -> None:
    """Each kept note's offsets exactly index the body."""
    llm = FakeLLM(
        _notes_json(
            {"kind": "theme", "quote": "the old fear rise again", "note": "Fear returns, gently."},
            {"kind": "symbol", "quote": "the willow bending", "note": "The willow holds you."},
        )
    )
    out = await generate_marginalia(_BODY, llm=llm)
    assert len(out) == 2
    for note in out:
        assert _BODY[note.anchor_start : note.anchor_end] == note.anchor_text
        assert note.anchor_text in _BODY
        assert note.kind in {k.value for k in MarginaliaKind}


@pytest.mark.asyncio
async def test_absent_quote_is_dropped_not_raised() -> None:
    """A quote that isn't a verbatim substring is silently dropped."""
    llm = FakeLLM(
        _notes_json(
            {"kind": "theme", "quote": "a phrase not in the entry", "note": "n"},
            {"kind": "theme", "quote": "the willow bending", "note": "kept"},
        )
    )
    out = await generate_marginalia(_BODY, llm=llm)
    assert len(out) == 1
    assert out[0].note == "kept"


@pytest.mark.asyncio
async def test_unknown_kind_is_dropped() -> None:
    """A note with an out-of-set kind is dropped."""
    llm = FakeLLM(_notes_json({"kind": "vibe", "quote": "the willow bending", "note": "n"}))
    assert await generate_marginalia(_BODY, llm=llm) == []


@pytest.mark.asyncio
async def test_malformed_json_returns_empty() -> None:
    """Non-JSON / wrong-shape completions never raise — they yield no notes."""
    assert await generate_marginalia(_BODY, llm=FakeLLM("not json at all")) == []
    assert await generate_marginalia(_BODY, llm=FakeLLM('{"notes": "nope"}')) == []
    assert await generate_marginalia(_BODY, llm=FakeLLM("{}")) == []


@pytest.mark.asyncio
async def test_overlapping_spans_are_deduped() -> None:
    """Two notes anchoring to overlapping spans keep only the first."""
    llm = FakeLLM(
        _notes_json(
            {"kind": "theme", "quote": "the willow bending without breaking", "note": "first"},
            {"kind": "symbol", "quote": "willow bending", "note": "overlaps-first"},
        )
    )
    out = await generate_marginalia(_BODY, llm=llm)
    assert len(out) == 1
    assert out[0].note == "first"


@pytest.mark.asyncio
async def test_max_notes_is_respected() -> None:
    """No more than max_notes are returned even when more anchor cleanly."""
    llm = FakeLLM(
        _notes_json(
            {"kind": "theme", "quote": "Today", "note": "1"},
            {"kind": "theme", "quote": "river", "note": "2"},
            {"kind": "theme", "quote": "fear", "note": "3"},
        )
    )
    out = await generate_marginalia(_BODY, llm=llm, max_notes=2)
    assert len(out) == 2


@pytest.mark.asyncio
async def test_prompt_includes_prior_entries_for_connection_context() -> None:
    """prior_entries are embedded in the prompt for connection notes."""
    llm = FakeLLM(_notes_json())
    await generate_marginalia(_BODY, llm=llm, prior_entries=["An earlier page about the river."])
    assert llm.prompt is not None
    assert "An earlier page about the river." in llm.prompt
