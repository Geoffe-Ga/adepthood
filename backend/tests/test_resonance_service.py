"""Tests for the resonance generation domain service (journal-resonance-04)."""

from __future__ import annotations

import json

import pytest

from domain import resonance
from domain.resonance import DropReason, MarginaliaOutcome, generate_marginalia
from models import marginalia
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


def test_size_constants_match_the_model_caps() -> None:
    """The domain's caps must match the model's, which is what bounds a write.

    The columns are ``EncryptedString`` (a Fernet token exceeds any plaintext
    bound), so the model no longer carries a DB length to compare against: the
    caps declared beside the model are the contract, and this domain is the layer
    that enforces them. Drift between the two is what silently truncates or
    over-accepts a note, so it is pinned here.
    """
    assert resonance.ANCHOR_TEXT_MAX == marginalia.MARGINALIA_ANCHOR_TEXT_MAX
    assert resonance.NOTE_MAX == marginalia.MARGINALIA_NOTE_MAX
    assert resonance.ESSAY_MAX == marginalia.MARGINALIA_ESSAY_MAX


@pytest.mark.asyncio
async def test_prior_entries_are_capped_in_the_prompt() -> None:
    """At most MAX_PRIOR_ENTRIES prior entries reach the prompt, each truncated."""
    llm = FakeLLM(_notes_json())
    priors = [f"PRIOR_{i}_" + ("x" * 5000) for i in range(10)]
    await generate_marginalia(_BODY, llm=llm, prior_entries=priors)
    assert llm.prompt is not None
    included = sum(f"PRIOR_{i}_" in llm.prompt for i in range(10))
    assert included == resonance.MAX_PRIOR_ENTRIES
    # Each included entry is truncated to the per-entry budget.
    assert ("x" * 5000) not in llm.prompt


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
    assert len(out.notes) == 2
    for note in out.notes:
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
    assert len(out.notes) == 1
    assert out.notes[0].note == "kept"


@pytest.mark.asyncio
async def test_unknown_kind_is_dropped() -> None:
    """A note with an out-of-set kind is dropped."""
    llm = FakeLLM(_notes_json({"kind": "vibe", "quote": "the willow bending", "note": "n"}))
    assert (await generate_marginalia(_BODY, llm=llm)).notes == []


@pytest.mark.asyncio
async def test_malformed_json_returns_empty() -> None:
    """Non-JSON / wrong-shape completions never raise — they yield no notes."""
    assert (await generate_marginalia(_BODY, llm=FakeLLM("not json at all"))).notes == []
    assert (await generate_marginalia(_BODY, llm=FakeLLM('{"notes": "nope"}'))).notes == []
    assert (await generate_marginalia(_BODY, llm=FakeLLM("{}"))).notes == []


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
    assert len(out.notes) == 1
    assert out.notes[0].note == "first"


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
    assert len(out.notes) == 2


@pytest.mark.asyncio
async def test_prompt_includes_prior_entries_for_connection_context() -> None:
    """prior_entries are embedded in the prompt for connection notes."""
    llm = FakeLLM(_notes_json())
    await generate_marginalia(_BODY, llm=llm, prior_entries=["An earlier page about the river."])
    assert llm.prompt is not None
    assert "An earlier page about the river." in llm.prompt


class TestDropTally:
    """A pass that produced nothing must say why (issue-2396 shape).

    ``count=0`` states an outcome and never a cause, so three quite different
    situations — the model returned nothing, the completion would not parse, the
    model's every quote was paraphrased past the verbatim anchor — were
    indistinguishable to an operator and identical to the writer: a button that
    does nothing.
    """

    @staticmethod
    def _assert_counts_reconcile(out: MarginaliaOutcome) -> None:
        """Every proposed draft ended in exactly one bucket, or the tally lies."""
        assert out.kept + sum(out.dropped.values()) + out.unexamined == out.proposed

    @pytest.mark.asyncio
    async def test_model_returning_no_drafts_is_not_reported_as_a_failure(self) -> None:
        """An empty ``notes`` array is a model declining to comment, not a fault."""
        out = await generate_marginalia(_BODY, llm=FakeLLM(_notes_json()))

        assert out.notes == []
        assert out.completion_parsed is True
        assert out.proposed == 0
        assert sum(out.dropped.values()) == 0
        assert out.produced_nothing_usable is False
        self._assert_counts_reconcile(out)

    @pytest.mark.asyncio
    async def test_unparsable_completion_is_distinguishable_from_an_empty_one(self) -> None:
        """The model returned text, and none of it was usable — a different event."""
        out = await generate_marginalia(_BODY, llm=FakeLLM("not json at all"))

        assert out.notes == []
        assert out.completion_parsed is False
        assert out.proposed == 0
        assert out.produced_nothing_usable is True

    @pytest.mark.asyncio
    async def test_every_draft_unanchorable_is_recorded_by_reason(self) -> None:
        """The silent-failure case: the model spoke, the writer received nothing."""
        llm = FakeLLM(
            _notes_json(
                {"kind": "theme", "quote": "a phrase not in the entry", "note": "n"},
                {"kind": "symbol", "quote": "another absent phrase", "note": "n"},
            )
        )

        out = await generate_marginalia(_BODY, llm=llm)

        assert out.notes == []
        assert out.proposed == 2
        assert out.examined == 2
        assert out.dropped[DropReason.UNANCHORABLE] == 2
        assert out.produced_nothing_usable is True
        self._assert_counts_reconcile(out)

    @pytest.mark.asyncio
    async def test_each_drop_reason_is_counted_separately(self) -> None:
        """Four faults, four buckets: a bulk failure names its own remedy."""
        long_note = "x" * (resonance.NOTE_MAX + 1)
        raw = json.dumps(
            {
                "notes": [
                    {"kind": "theme", "quote": "the willow bending without breaking", "note": "k"},
                    {"kind": "vibe", "quote": "the old fear", "note": "bad kind"},
                    {"kind": "theme", "quote": "a phrase not in the entry", "note": "no anchor"},
                    {"kind": "theme", "quote": "willow bending", "note": "overlaps the first"},
                    {"kind": "symbol", "quote": "the river", "note": long_note},
                    # Wrong shape: never becomes a draft at all.
                    {"kind": "theme", "quote": 7},
                ]
            }
        )
        llm = FakeLLM(raw)

        out = await generate_marginalia(_BODY, llm=llm)

        assert [note.note for note in out.notes] == ["k"]
        assert out.proposed == 6
        assert out.dropped[DropReason.MALFORMED] == 1
        assert out.dropped[DropReason.KIND] == 1
        assert out.dropped[DropReason.UNANCHORABLE] == 1
        assert out.dropped[DropReason.OVERLAPPING] == 1
        assert out.dropped[DropReason.UNSANITISABLE] == 1
        assert out.produced_nothing_usable is False
        self._assert_counts_reconcile(out)

    @pytest.mark.asyncio
    async def test_drafts_beyond_the_cap_are_unexamined_not_dropped(self) -> None:
        """Hitting ``max_notes`` is a cap, not a fault, and must not read as one."""
        llm = FakeLLM(
            _notes_json(
                {"kind": "theme", "quote": "Today", "note": "1"},
                {"kind": "theme", "quote": "river", "note": "2"},
                {"kind": "theme", "quote": "fear", "note": "3"},
            )
        )

        out = await generate_marginalia(_BODY, llm=llm, max_notes=2)

        assert out.kept == 2
        assert out.unexamined == 1
        assert sum(out.dropped.values()) == 0
        self._assert_counts_reconcile(out)

    @pytest.mark.asyncio
    async def test_log_fields_carry_counts_and_never_text(self) -> None:
        """Journal text is encrypted at rest; the tally must never undo that."""
        quote = "the old fear rise again"
        note_text = "Fear returns, gently."
        llm = FakeLLM(_notes_json({"kind": "theme", "quote": quote, "note": note_text}))

        extra = (await generate_marginalia(_BODY, llm=llm)).as_log_extra()

        assert extra["drafts_proposed"] == 1
        assert extra["drafts_kept"] == 1
        assert extra["completion_parsed"] is True
        assert all(f"dropped_{reason.value}" in extra for reason in DropReason)
        rendered = repr(extra)
        assert quote not in rendered
        assert note_text not in rendered
        assert _BODY not in rendered
