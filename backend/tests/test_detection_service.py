"""Tests for the completion-detection domain service (habit-resonance-02)."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date

import pytest

from domain import detection, resonance
from domain.dates import MAX_BACKFILL_DAYS
from domain.detection import (
    MAX_HITS,
    CompletionDetected,
    DetectionCandidate,
    build_detection_prompt,
    detect_completions,
)
from domain.detection_facts import DetectionClock, facts_from_model
from models.completion_suggestion import (
    _ANCHOR_TEXT_MAX,
    _LABEL_MAX,
    CompletionTargetType,
    _facts_positive_check,
)

_BODY = (
    "This morning I meditated for twenty minutes by the window. "
    "Later I went for a run along the river. "
    "I planned to journal tonight but never got to it."
)

# One fixed clock for every call site in this file. Threading it is mechanical
# and changes no assertion: ``detect_completions`` requires a clock so that
# forgetting a production path is a type error rather than a half-feature.
_CLOCK = DetectionClock(
    entry_day=date(2026, 9, 12), today=date(2026, 9, 12), max_backfill_days=MAX_BACKFILL_DAYS
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


def test_label_max_matches_the_model_cap() -> None:
    """LABEL_MAX must equal the CompletionSuggestion.label cap (#843 review).

    The column is ``EncryptedString`` (Text), so the DB no longer refuses an
    over-long label the way it once did: this sanitizer is the only enforcement
    left, and drift between the two constants would silently widen it.
    """
    assert detection.LABEL_MAX == _LABEL_MAX


def test_anchor_text_max_matches_the_model_cap() -> None:
    """The quote bound this module applies must equal the anchor_text cap.

    ``detection`` reuses ``resonance._quote_span``, whose ``ANCHOR_TEXT_MAX``
    is what actually refuses an over-long anchor now that the column holds
    ciphertext and cannot bound the plaintext itself.
    """
    assert resonance.ANCHOR_TEXT_MAX == _ANCHOR_TEXT_MAX


@pytest.mark.asyncio
async def test_detects_and_anchors_hits() -> None:
    """Resolved hits carry the candidate's target + a verbatim anchor span."""
    llm = FakeLLM(
        _hits_json(
            {"index": 0, "quote": "I meditated for twenty minutes"},
            {"index": 1, "quote": "I went for a run along the river"},
        )
    )
    hits = await detect_completions(_BODY, candidates=_CANDIDATES, llm=llm, clock=_CLOCK)
    assert [(h.target_type, h.target_id) for h in hits] == [("habit", 10), ("practice", 20)]
    for hit in hits:
        assert _BODY[hit.anchor_start : hit.anchor_end] == hit.anchor_text
        assert hit.label == hit.anchor_text


@pytest.mark.asyncio
async def test_fenced_json_is_parsed() -> None:
    """Detection shares resonance's JSON reader, so it inherits fence tolerance.

    Guarded here as well as in the resonance suite: the two features fail
    independently for a user, and a future reader changing one parser should
    see both call sites go red.
    """
    fenced = (
        "```json\n" + _hits_json({"index": 0, "quote": "I meditated for twenty minutes"}) + "\n```"
    )
    hits = await detect_completions(
        _BODY, candidates=_CANDIDATES, llm=FakeLLM(fenced), clock=_CLOCK
    )
    assert len(hits) == 1
    assert hits[0].anchor_text == "I meditated for twenty minutes"


@pytest.mark.asyncio
async def test_empty_candidates_short_circuits_without_calling_llm() -> None:
    """No candidates ⇒ [] and the LLM is never called (the endpoint's cost guard)."""
    llm = FakeLLM(_hits_json({"index": 0, "quote": "I meditated for twenty minutes"}))
    hits = await detect_completions(_BODY, candidates=(), llm=llm, clock=_CLOCK)
    assert hits == []
    assert llm.calls == 0


@pytest.mark.asyncio
async def test_out_of_range_index_is_dropped() -> None:
    """An index that addresses no supplied candidate is dropped (ids untrusted)."""
    llm = FakeLLM(_hits_json({"index": 99, "quote": "I meditated for twenty minutes"}))
    assert await detect_completions(_BODY, candidates=_CANDIDATES, llm=llm, clock=_CLOCK) == []


@pytest.mark.asyncio
async def test_quote_not_in_body_is_dropped() -> None:
    """A quote that doesn't occur verbatim in the body is dropped (offsets untrusted)."""
    llm = FakeLLM(_hits_json({"index": 0, "quote": "I did not write this"}))
    assert await detect_completions(_BODY, candidates=_CANDIDATES, llm=llm, clock=_CLOCK) == []


@pytest.mark.asyncio
async def test_malformed_payload_yields_no_hits() -> None:
    """Junk / wrong-typed items are tolerated and produce no hits."""
    llm = FakeLLM("not json at all")
    assert await detect_completions(_BODY, candidates=_CANDIDATES, llm=llm, clock=_CLOCK) == []
    bad = FakeLLM(_hits_json({"index": "zero", "quote": 5}, {"nope": True}))
    assert await detect_completions(_BODY, candidates=_CANDIDATES, llm=bad, clock=_CLOCK) == []


@pytest.mark.asyncio
async def test_label_is_sanitized() -> None:
    """The label is the sanitized quote — control characters are stripped."""
    body = "I ran\x07 a mile today."
    cands = (DetectionCandidate(index=0, target_type="practice", target_id=20, name="Run"),)
    llm = FakeLLM(_hits_json({"index": 0, "quote": "ran\x07 a mile"}))
    hits = await detect_completions(body, candidates=cands, llm=llm, clock=_CLOCK)
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
    hits = await detect_completions(_BODY, candidates=_CANDIDATES, llm=llm, clock=_CLOCK)
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
    hits = await detect_completions(body, candidates=cands, llm=llm, clock=_CLOCK)
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
    hits = await detect_completions(body, candidates=cands, llm=llm, clock=_CLOCK)
    assert len(hits) == MAX_HITS


@pytest.mark.asyncio
async def test_anchors_round_trip_through_an_emoji_containing_body() -> None:
    """Every resolved anchor's [start:end) code-point slice matches the anchored phrase.

    Python string indexing is code-point-native, so a leading astral (emoji)
    character never desyncs an offset the way UTF-16 code-unit indexing would --
    this pins that round-trip as a regression guard.
    """
    body = (
        "\U0001f600This morning I meditated for twenty minutes by the window. "
        "Later I went for a run along the river."
    )
    llm = FakeLLM(
        _hits_json(
            {"index": 0, "quote": "I meditated for twenty minutes"},
            {"index": 1, "quote": "I went for a run along the river"},
        )
    )
    hits = await detect_completions(body, candidates=_CANDIDATES, llm=llm, clock=_CLOCK)
    assert len(hits) == 2
    for hit in hits:
        assert body[hit.anchor_start : hit.anchor_end] == hit.anchor_text


_OZ_BODY = "I drank 64 oz of water yesterday and felt better for it."
_OZ_CANDIDATE = (
    DetectionCandidate(
        index=0, target_type="habit", target_id=10, name="Drink water", target_unit="oz"
    ),
)


async def _oz_hit(**facts: object) -> list[CompletionDetected]:
    """Run one detection over the oz-water body with the given model-stated facts."""
    llm = FakeLLM(_hits_json({"index": 0, "quote": "drank 64 oz of water yesterday", **facts}))
    return await detect_completions(_OZ_BODY, candidates=_OZ_CANDIDATE, llm=llm, clock=_CLOCK)


@pytest.mark.asyncio
async def test_amount_unit_and_day_ride_through_to_the_detected_hit() -> None:
    """A stated amount and day reach the hit, resolved against the ENTRY's day."""
    hits = await _oz_hit(amount=64, unit="oz", when="yesterday")
    assert len(hits) == 1
    assert hits[0].completed_units == 64.0
    assert hits[0].completed_on == date(2026, 9, 11)


@pytest.mark.asyncio
async def test_a_hit_with_no_stated_facts_carries_none() -> None:
    """The ordinary case: "I ran" attests to the run and to nothing else."""
    hits = await _oz_hit()
    assert len(hits) == 1
    assert hits[0].completed_units is None
    assert hits[0].completed_on is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "amount",
    [True, float("nan"), float("inf"), -5, 0, "sixty-four", None, {"n": 64}],
)
async def test_an_unbelievable_amount_drops_the_field_and_keeps_the_hit(
    amount: object,
) -> None:
    """Field-wise dropping: the hit rests on its index and quote, never on an extra."""
    hits = await _oz_hit(amount=amount, unit="oz", when="yesterday")
    assert len(hits) == 1
    assert hits[0].completed_units is None
    assert hits[0].completed_on == date(2026, 9, 11)  # the day survives independently


@pytest.mark.asyncio
async def test_a_mismatched_unit_drops_only_the_amount() -> None:
    """Two glasses, against a goal counted in ounces, is not two ounces."""
    hits = await _oz_hit(amount=2, unit="glasses", when="yesterday")
    assert len(hits) == 1
    assert hits[0].completed_units is None
    assert hits[0].completed_on == date(2026, 9, 11)


@pytest.mark.asyncio
async def test_an_unparseable_when_drops_only_the_day() -> None:
    hits = await _oz_hit(amount=64, unit="oz", when="at some point last month")
    assert len(hits) == 1
    assert hits[0].completed_units == 64.0
    assert hits[0].completed_on is None


@pytest.mark.asyncio
async def test_a_practice_candidate_never_carries_an_amount() -> None:
    """Practices track no unit, so no amount stated about one can be believed."""
    llm = FakeLLM(
        _hits_json(
            {
                "index": 1,
                "quote": "I went for a run along the river",
                "amount": 3,
                "unit": "miles",
                "when": "yesterday",
            }
        )
    )
    hits = await detect_completions(_BODY, candidates=_CANDIDATES, llm=llm, clock=_CLOCK)
    assert len(hits) == 1
    assert hits[0].target_type == "practice"
    assert hits[0].completed_units is None


def test_the_factory_positivity_rule_matches_the_model_check() -> None:
    """The DB CHECK and the detection factory must agree that zero is not an amount.

    A backstop that can fire is a 500 inside ``_persist_settle_commit`` that
    also loses the wallet settlement, so the two rules are pinned together the
    way the target-type sets are.
    """
    check = _facts_positive_check()
    assert check.name == "ck_completion_suggestion_completed_units_positive"
    assert str(check.sqltext) == "completed_units IS NULL OR completed_units > 0"
    for rejected in (0.0, -0.001, -1.0):
        units, _ = facts_from_model(
            _RawFacts(amount=rejected, unit="oz", when=None), target_unit="oz", clock=_CLOCK
        )
        assert units is None


@dataclass(frozen=True)
class _RawFacts:
    """The three raw fact fields, standing in for a parsed model draft."""

    amount: object = None
    unit: object = None
    when: object = None


def test_the_prompt_shows_each_candidates_unit_and_forbids_conversion() -> None:
    """The model is told what the goal counts, and told never to convert into it."""
    prompt = build_detection_prompt(_OZ_BODY, _OZ_CANDIDATE)
    assert "0. Drink water (habit, oz)" in prompt
    assert "NEVER converted" in prompt
    assert "VERBATIM as they wrote it" in prompt
    assert '"when"' in prompt


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
