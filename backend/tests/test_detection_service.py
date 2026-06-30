"""Tests for the completion-detection domain service (habit-resonance-02)."""

from __future__ import annotations

import json

import pytest

from domain import detection
from domain.detection import (
    MAX_HITS,
    CompletionDetected,
    DetectionCandidate,
    build_detection_prompt,
    detect_completions,
)
from models.completion_suggestion import _LABEL_MAX, CompletionTargetType

_BODY = (
    "This morning I meditated for twenty minutes by the window. "
    "Later I went for a run along the river. "
    "I planned to journal tonight but never got to it."
)

_CANDIDATES = (
    DetectionCandidate(index=0, target_type="habit", target_id=10, name="Meditation"),
    DetectionCandidate(index=1, target_type="practice", target_id=20, name="Run"),
    DetectionCandidate(index=2, target_type="habit", target_id=30, name="Journal"),
)


class FakeLLM:
    """Injected LLM stub: returns a fixed completion and counts calls."""

    def __init__(self, completion: str) -> None:
        """Store the canned completion this fake will return."""
        self._completion = completion
        self.calls = 0
        self.prompt: str | None = None

    async def complete(self, prompt: str) -> str:
        self.calls += 1
        self.prompt = prompt
        return self._completion


def _hits_json(*hits: dict[str, object]) -> str:
    return json.dumps({"hits": list(hits)})


def test_valid_target_types_match_the_model_enum() -> None:
    """The domain's local target-type set must not drift from the model enum."""
    assert {t.value for t in CompletionTargetType} == detection.VALID_TARGET_TYPES


def test_label_max_matches_the_db_column() -> None:
    """LABEL_MAX must equal the CompletionSuggestion.label column cap (#843 review).

    A larger domain cap would let a detected label pass here and then fail at DB
    insert in the endpoint layer.
    """
    assert detection.LABEL_MAX == _LABEL_MAX


@pytest.mark.asyncio
async def test_detects_and_anchors_hits() -> None:
    """Resolved hits carry the candidate's target + a verbatim anchor span."""
    llm = FakeLLM(
        _hits_json(
            {"index": 0, "quote": "I meditated for twenty minutes"},
            {"index": 1, "quote": "I went for a run along the river"},
        )
    )
    hits = await detect_completions(_BODY, candidates=_CANDIDATES, llm=llm)
    assert [(h.target_type, h.target_id) for h in hits] == [("habit", 10), ("practice", 20)]
    for hit in hits:
        assert _BODY[hit.anchor_start : hit.anchor_end] == hit.anchor_text
        assert hit.label == hit.anchor_text


@pytest.mark.asyncio
async def test_empty_candidates_short_circuits_without_calling_llm() -> None:
    """No candidates ⇒ [] and the LLM is never called (the endpoint's cost guard)."""
    llm = FakeLLM(_hits_json({"index": 0, "quote": "I meditated for twenty minutes"}))
    hits = await detect_completions(_BODY, candidates=(), llm=llm)
    assert hits == []
    assert llm.calls == 0


@pytest.mark.asyncio
async def test_out_of_range_index_is_dropped() -> None:
    """An index that addresses no supplied candidate is dropped (ids untrusted)."""
    llm = FakeLLM(_hits_json({"index": 99, "quote": "I meditated for twenty minutes"}))
    assert await detect_completions(_BODY, candidates=_CANDIDATES, llm=llm) == []


@pytest.mark.asyncio
async def test_quote_not_in_body_is_dropped() -> None:
    """A quote that doesn't occur verbatim in the body is dropped (offsets untrusted)."""
    llm = FakeLLM(_hits_json({"index": 0, "quote": "I did not write this"}))
    assert await detect_completions(_BODY, candidates=_CANDIDATES, llm=llm) == []


@pytest.mark.asyncio
async def test_malformed_payload_yields_no_hits() -> None:
    """Junk / wrong-typed items are tolerated and produce no hits."""
    llm = FakeLLM("not json at all")
    assert await detect_completions(_BODY, candidates=_CANDIDATES, llm=llm) == []
    bad = FakeLLM(_hits_json({"index": "zero", "quote": 5}, {"nope": True}))
    assert await detect_completions(_BODY, candidates=_CANDIDATES, llm=bad) == []


@pytest.mark.asyncio
async def test_label_is_sanitized() -> None:
    """The label is the sanitized quote — control characters are stripped."""
    body = "I ran\x07 a mile today."
    cands = (DetectionCandidate(index=0, target_type="practice", target_id=20, name="Run"),)
    llm = FakeLLM(_hits_json({"index": 0, "quote": "ran\x07 a mile"}))
    hits = await detect_completions(body, candidates=cands, llm=llm)
    assert len(hits) == 1
    assert "\x07" not in hits[0].label
    assert "\x07" in hits[0].anchor_text


@pytest.mark.asyncio
async def test_same_target_is_deduped() -> None:
    """Two hits on the same target_id collapse to the first."""
    llm = FakeLLM(
        _hits_json(
            {"index": 0, "quote": "I meditated for twenty minutes"},
            {"index": 0, "quote": "by the window"},
        )
    )
    hits = await detect_completions(_BODY, candidates=_CANDIDATES, llm=llm)
    assert len(hits) == 1
    assert hits[0].target_id == 10


@pytest.mark.asyncio
async def test_overlapping_spans_are_deduped() -> None:
    """Distinct targets whose anchors overlap collapse to the first kept."""
    body = "I meditated and ran in one breath."
    cands = (
        DetectionCandidate(index=0, target_type="habit", target_id=10, name="Meditation"),
        DetectionCandidate(index=1, target_type="practice", target_id=20, name="Run"),
    )
    llm = FakeLLM(
        _hits_json(
            {"index": 0, "quote": "meditated and ran"},
            {"index": 1, "quote": "and ran in one breath"},
        )
    )
    hits = await detect_completions(body, candidates=cands, llm=llm)
    assert len(hits) == 1
    assert hits[0].target_id == 10


@pytest.mark.asyncio
async def test_caps_at_max_hits() -> None:
    """No more than MAX_HITS are returned even if the model proposes more."""
    words = [f"word{i}" for i in range(MAX_HITS + 3)]
    body = " ".join(words)
    cands = tuple(
        DetectionCandidate(index=i, target_type="habit", target_id=100 + i, name=f"H{i}")
        for i in range(MAX_HITS + 3)
    )
    llm = FakeLLM(_hits_json(*({"index": i, "quote": words[i]} for i in range(MAX_HITS + 3))))
    hits = await detect_completions(body, candidates=cands, llm=llm)
    assert len(hits) == MAX_HITS


def test_prompt_excludes_intentions_and_avoidance() -> None:
    """The prompt forbids counting planned/avoided items, not just completed ones."""
    prompt = build_detection_prompt(_BODY, _CANDIDATES)
    lowered = prompt.lower()
    assert "did" in lowered
    assert "completed" in lowered
    assert "planned" in lowered
    assert "avoid" in lowered
    # Candidates are numbered for index addressing.
    assert "0. Meditation (habit)" in prompt


def test_completion_detected_is_frozen() -> None:
    """Detected hits are immutable so callers can't mutate resolved spans."""
    hit = CompletionDetected(
        target_type="habit",
        target_id=10,
        label="ran",
        anchor_start=0,
        anchor_end=3,
        anchor_text="ran",
    )
    with pytest.raises(AttributeError):
        hit.target_id = 99  # type: ignore[misc]
