"""Tests for :mod:`services.frequency_classification`.

The load-bearing test is the INTIMATE refusal, written so it fails if a
provider call is even *attempted*: the fake raises rather than returns, so a
refactor that moved the guard below request construction cannot pass by
returning something plausible. A test asserting only the exception type would
still pass after the content had been assembled into a payload.

Everything else is about degrading rather than raising -- classification
enriches a corpus and must never be why a user's write fails -- and about
refusing to absorb a vocabulary the ontology does not contain.
"""

from __future__ import annotations

import inspect
import json
import pathlib
from types import SimpleNamespace

import pytest

from domain.frequencies import (
    FREQUENCY_COLORS,
    FREQUENCY_NAMES,
    Frequency,
    frequency_for_color,
    frequency_table,
)
from models.journal_entry import JournalClassification
from services import frequency_classification as fc
from services.botmason import LLMProviderError

_EXPECTED_FREQUENCY_COUNT = 10

# A syntactically-valid but entirely synthetic BYOK key. Named once so the
# allowlist pragma lives in one place rather than on every line that mentions it.
_FAKE_BYOK_KEY = "sk-ant-fake"  # pragma: allowlist secret


def _patch_provider(monkeypatch: pytest.MonkeyPatch, text: str) -> list[dict[str, object]]:
    """Route ``generate_response`` to a fake, returning the recorded calls."""
    calls: list[dict[str, object]] = []

    async def fake(**kwargs: object) -> SimpleNamespace:
        calls.append(kwargs)
        return SimpleNamespace(text=text)

    monkeypatch.setattr(fc, "generate_response", fake)
    return calls


def _forbid_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make any provider call an outright test failure."""

    async def explode(**kwargs: object) -> SimpleNamespace:
        msg = f"a provider call was made when none was permitted: {sorted(kwargs)}"
        raise AssertionError(msg)

    monkeypatch.setattr(fc, "generate_response", explode)


# --- the vocabulary ----------------------------------------------------------


def test_the_ontology_has_exactly_ten_frequencies() -> None:
    """An eleventh frequency is a contract change, not an implementation detail.

    Creek declares this set with ``extra="forbid"``. Pinning the count means
    adding one cannot happen quietly as a side effect of another change.
    """
    assert len(Frequency) == _EXPECTED_FREQUENCY_COUNT
    assert len(FREQUENCY_NAMES) == _EXPECTED_FREQUENCY_COUNT


def test_every_frequency_has_a_name() -> None:
    """A code with no name would render as a bare F-number somewhere."""
    assert set(FREQUENCY_NAMES) == set(Frequency)
    assert all(FREQUENCY_NAMES[code].strip() for code in Frequency)


def test_the_prompt_is_generated_from_the_vocabulary() -> None:
    """The prompt and the parser must describe the same ontology.

    Restating the table in prose would be a second copy free to drift; this
    asserts the prompt the model actually receives carries every code and name
    from the single definition.
    """
    table = frequency_table()
    for code in Frequency:
        assert code.value in table
        assert FREQUENCY_NAMES[code] in table
    assert table in fc.SYSTEM_PROMPT


# --- INTIMATE never reaches a provider ---------------------------------------


@pytest.mark.asyncio
async def test_intimate_content_never_reaches_a_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The refusal precedes the call, not merely the network.

    The fake raises on any invocation, so this fails if the guard is ever moved
    below request construction -- the failure mode where the content has
    already been assembled into a payload and only the send is skipped.
    """
    _forbid_provider(monkeypatch)

    with pytest.raises(fc.IntimateContentRefusedError):
        await fc.classify_frequencies(
            "Something I would only write to myself.",
            classification=JournalClassification.INTIMATE,
        )


@pytest.mark.asyncio
async def test_public_and_personal_do_reach_a_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The counterpart: the refusal is specific, not blanket.

    Without this, a service that refused *everything* would satisfy the test
    above while classifying nothing at all.
    """
    for tier in (JournalClassification.PUBLIC, JournalClassification.PERSONAL):
        calls = _patch_provider(monkeypatch, '{"weights": {"F1": 0.5}, "overall_confidence": 0.5}')
        result = await fc.classify_frequencies("I finally said no.", classification=tier)
        assert len(calls) == 1
        assert result.is_classified()


# --- parsing ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_well_formed_reply_is_parsed(monkeypatch: pytest.MonkeyPatch) -> None:
    """Weights survive as given -- not renormalised into a distribution."""
    _patch_provider(
        monkeypatch,
        '{"weights": {"F1": 0.7, "F3": 0.5}, "overall_confidence": 0.8}',
    )

    result = await fc.classify_frequencies(
        "I finally said no, and meant it.",
        classification=JournalClassification.PERSONAL,
    )

    assert result.weights == {Frequency.F1: 0.7, Frequency.F3: 0.5}
    assert result.overall_confidence == 0.8
    # Sums to 1.2, preserved: conviction is the quantity of interest, and
    # normalising would erase the difference between strong and weak carriage.
    assert sum(result.weights.values()) > 1.0


@pytest.mark.asyncio
async def test_json_wrapped_in_prose_is_still_parsed(monkeypatch: pytest.MonkeyPatch) -> None:
    """Models add fences and preamble even when told not to."""
    _patch_provider(
        monkeypatch,
        'Here is the classification:\n```json\n{"weights": {"F9": 0.4}, '
        '"overall_confidence": 0.4}\n```\nHope that helps!',
    )

    result = await fc.classify_frequencies(
        "We are one.", classification=JournalClassification.PUBLIC
    )

    assert result.weights == {Frequency.F9: 0.4}


@pytest.mark.asyncio
async def test_an_empty_classification_is_not_an_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """Carrying no frequency is a real answer, distinct from a failure."""
    _patch_provider(monkeypatch, '{"weights": {}, "overall_confidence": 0.0}')

    result = await fc.classify_frequencies(
        "Bought milk.", classification=JournalClassification.PUBLIC
    )

    assert result.weights == {}
    assert not result.is_classified()


# --- refusing to absorb a vocabulary that is not ours -------------------------


@pytest.mark.asyncio
async def test_an_eleventh_frequency_rejects_the_whole_reply(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``F11`` means the two sides disagree about the ontology.

    Dropping the unknown key and keeping the rest would hide that disagreement
    and quietly accept a partial answer from a different vocabulary -- the
    exact drift ``extra="forbid"`` exists to prevent upstream.
    """
    _patch_provider(
        monkeypatch,
        '{"weights": {"F1": 0.6, "F11": 0.9}, "overall_confidence": 0.7}',
    )

    result = await fc.classify_frequencies("...", classification=JournalClassification.PERSONAL)

    assert result is fc.UNCLASSIFIED


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "reply",
    [
        pytest.param("not json at all", id="no-json"),
        pytest.param("{", id="truncated"),
        pytest.param('{"weights": [1, 2], "overall_confidence": 0.5}', id="weights-not-an-object"),
        pytest.param('{"weights": {"F1": 1.5}, "overall_confidence": 0.5}', id="weight-above-one"),
        pytest.param('{"weights": {"F1": -0.1}, "overall_confidence": 0.5}', id="weight-negative"),
        pytest.param('{"weights": {"F1": "high"}, "overall_confidence": 0.5}', id="weight-string"),
        pytest.param('{"weights": {"F1": true}, "overall_confidence": 0.5}', id="weight-bool"),
        pytest.param('{"weights": {"F1": 0.5}}', id="confidence-missing"),
        pytest.param('["F1"]', id="top-level-not-an-object"),
    ],
)
async def test_a_malformed_reply_degrades(monkeypatch: pytest.MonkeyPatch, reply: str) -> None:
    """Every unusable shape returns UNCLASSIFIED rather than raising.

    ``weight-bool`` is here because ``bool`` subclasses ``int`` in Python, so
    ``true`` would otherwise be accepted as the weight ``1.0``.
    """
    _patch_provider(monkeypatch, reply)

    result = await fc.classify_frequencies("...", classification=JournalClassification.PERSONAL)

    assert result is fc.UNCLASSIFIED


# --- degrading, not failing ---------------------------------------------------


@pytest.mark.asyncio
async def test_a_provider_failure_degrades(monkeypatch: pytest.MonkeyPatch) -> None:
    """A dead provider must never be why someone's entry fails to save."""

    async def failing(**_kwargs: object) -> SimpleNamespace:
        raise LLMProviderError("no key configured")

    monkeypatch.setattr(fc, "generate_response", failing)

    result = await fc.classify_frequencies("...", classification=JournalClassification.PERSONAL)

    assert result is fc.UNCLASSIFIED


# --- cost ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_an_oversized_fragment_is_truncated_to_the_ceiling(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The per-fragment ceiling is applied, not merely named.

    A corpus is classified fragment by fragment, so an unbounded input is
    multiplied by the size of somebody's journal. A named constant that never
    reached the call would be decoration.
    """
    calls = _patch_provider(monkeypatch, '{"weights": {}, "overall_confidence": 0.0}')
    oversized = "x" * (fc.MAX_FRAGMENT_CHARS * 3)

    await fc.classify_frequencies(oversized, classification=JournalClassification.PERSONAL)

    sent = calls[0]["user_message"]
    assert isinstance(sent, str)
    assert len(sent) == fc.MAX_FRAGMENT_CHARS


@pytest.mark.asyncio
async def test_a_normal_fragment_is_sent_whole(monkeypatch: pytest.MonkeyPatch) -> None:
    """The ceiling must not clip ordinary writing.

    Paired with the test above so truncation is shown to be conditional -- a
    service that clipped everything to a fixed prefix would satisfy that one
    alone.
    """
    calls = _patch_provider(monkeypatch, '{"weights": {}, "overall_confidence": 0.0}')
    entry = "A long-ish journal entry. " * 40

    await fc.classify_frequencies(entry, classification=JournalClassification.PERSONAL)

    assert calls[0]["user_message"] == entry


# --- BYOK ---------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_callers_key_is_threaded_through(monkeypatch: pytest.MonkeyPatch) -> None:
    """BYOK reuses the chat path's key parameter rather than a second one."""
    calls = _patch_provider(monkeypatch, '{"weights": {}, "overall_confidence": 0.0}')

    await fc.classify_frequencies(
        "...",
        classification=JournalClassification.PERSONAL,
        api_key=_FAKE_BYOK_KEY,
    )

    assert calls[0]["api_key"] == _FAKE_BYOK_KEY


@pytest.mark.asyncio
async def test_no_key_falls_back_to_the_server_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """``None`` is passed through so botmason applies its own resolution."""
    calls = _patch_provider(monkeypatch, '{"weights": {}, "overall_confidence": 0.0}')

    await fc.classify_frequencies("...", classification=JournalClassification.PERSONAL)

    assert calls[0]["api_key"] is None


def test_classification_is_stateless() -> None:
    """No prior turns leak between fragments.

    A shared history would silently make one person's fragment part of
    another's prompt, which is a privacy failure rather than a quality one.
    """
    source = inspect.getsource(fc.classify_frequencies)
    assert "conversation_history=[]" in source


# --- the vocabulary is one thing, not three ----------------------------------
# Aspects of Wholeness == Frequencies == Stages, keyed by colour. NORTH-STAR.md
# states the identity and graph/ontology-spine.md writes it as an equation per
# row. These tests hold the vendored table to the curriculum dataset so the two
# spellings of one ontology cannot drift apart -- which is the whole reason the
# vendored copy is allowed to exist.


def _curriculum_stages() -> list[dict[str, object]]:
    """The curriculum's own copy of the ten positions."""
    source = (
        pathlib.Path(__file__).resolve().parents[2]
        / "src"
        / "curriculum"
        / "archetypal_wavelength.json"
    )
    stages: list[dict[str, object]] = json.loads(source.read_text(encoding="utf-8"))["stages"]
    return stages


def test_the_vendored_colours_match_the_curriculum() -> None:
    """Colour is the primary key, so it is the join that must hold exactly.

    If this fails, one of the two spellings of a single ontology has moved and
    every colour-keyed surface -- content directories, STAGE_COLORS, the habit
    ring -- is now pointing somewhere the other does not agree with.
    """
    curriculum = {
        int(str(stage["stage_number"])): stage["spiral_dynamics_color"]
        for stage in _curriculum_stages()
    }

    assert curriculum == {int(code.value[1:]): FREQUENCY_COLORS[code] for code in Frequency}


def test_the_curriculum_has_exactly_ten_positions() -> None:
    """More than ten rings still means these ten, cycling.

    The habits surface repeats Beige -> Clear Light for extra laps rather than
    extending the set; an eleventh position would be a contract change.
    """
    assert len(_curriculum_stages()) == _EXPECTED_FREQUENCY_COUNT


def _acceptable_names(row: dict[str, object]) -> set[str]:
    """The names a Frequency could carry if it matched the curriculum row."""
    aspect, title = str(row["aspect"]), str(row["title"])
    return {aspect, f"{aspect} / {title}"}


def test_the_two_labelings_of_a_position_may_differ_but_the_colour_may_not() -> None:
    """Names drift between labelings; the colour is what actually joins them.

    This is why colour is the primary key rather than a display detail. The
    vault-side Frequency name and the curriculum's aspect/title agree for six
    of the ten positions and diverge for the middle four:

    ======  ==========================  ============================
    Code    Frequency name              Curriculum aspect / title
    ======  ==========================  ============================
    F5      Achievism                   Intellectual Understanding / Achievist
    F6      Pluralism                   Embodied Understanding / Pluralist
    F7      Integration                 Systems Wisdom / Integrative
    F8      True Self / Transcendence   True Self Connection / Nondual
    ======  ==========================  ============================

    Those are the same four positions under two vocabularies, not eight
    positions. Joining on a name would silently mismatch them; joining on
    colour cannot. Recorded as a test so the divergence is a known, asserted
    fact rather than something the next reader rediscovers as a bug.
    """
    by_number = {int(str(stage["stage_number"])): stage for stage in _curriculum_stages()}
    diverging = {
        code
        for code in Frequency
        if FREQUENCY_NAMES[code] not in _acceptable_names(by_number[int(code.value[1:])])
    }

    assert diverging == {Frequency.F5, Frequency.F6, Frequency.F7, Frequency.F8}


def test_every_colour_resolves_back_to_the_position_it_names() -> None:
    """The colour join reads both ways, and the two directions agree exactly.

    Anything holding a colour — a course stage's ``spiral_dynamics_color``, an
    ``NN-colour`` content directory, a design token — reaches its frequency
    through this. A round trip over all ten is what makes that a fact rather
    than an intention.
    """
    assert {colour: frequency_for_color(colour) for colour in FREQUENCY_COLORS.values()} == {
        FREQUENCY_COLORS[code]: code for code in Frequency
    }


def test_a_colour_arrives_from_more_hands_than_the_vocabulary_does() -> None:
    """Spacing and casing are normalised, because a stored colour has been copied.

    ``Clear Light`` is two words in every surface that spells it, so a row that
    picked up an extra space or a lowercase l on the way through a seeder or a
    fixture still names the position it means.
    """
    assert frequency_for_color("  clear   light ") is Frequency.F10


def test_a_colour_that_names_no_position_resolves_to_nothing() -> None:
    """An unrecognised colour is not coerced onto the nearest position.

    An eleventh colour is a change to the shared ontology — Creek declares the
    set with ``extra="forbid"`` — not a lookup miss to paper over.
    """
    assert frequency_for_color("Chartreuse") is None
