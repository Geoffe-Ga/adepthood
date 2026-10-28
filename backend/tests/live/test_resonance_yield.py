"""Measure real-provider resonance yield and habit detection on invented text.

This paid, networked lane is opt-in and is never scheduled. Run it explicitly:

    LIVE_RESONANCE_CHECK=1 BOTMASON_PROVIDER=anthropic LLM_API_KEY=sk-ant-... \
        python -m pytest tests/live/test_resonance_yield.py -m live -q --no-cov -rA

The report contains only aggregate marginalia counts and candidate indices;
it never prints the fixture, model notes, or anchored quotes.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Awaitable, Callable, Sequence
from datetime import date
from pathlib import Path

import pytest

from domain.detection import CompletionDetected, DetectionCandidate, detect_completions
from domain.detection_facts import DetectionClock
from domain.resonance import MarginaliaOutcome, generate_marginalia
from services.botmason import LLMProviderError
from services.marginalia import BotmasonResonanceLLM
from tests.live.resonance_lane import (
    KEY_ENV,
    OPT_IN_ENV,
    provider_is_unreachable,
    resolve_live_resonance_api_key,
)

pytestmark = pytest.mark.live

MIN_NOTES_KEPT = 3

_FIXTURE = Path(__file__).parent / "fixtures" / "resonance_yield_entry.md"
_PRIOR_DRAFTS = (
    (
        "You noticed that quiet does not have to be earned. The open hand in "
        "your morning and the unhurried kitchen both sound like room you are "
        "learning to receive rather than manufacture."
    ),
    (
        "The unfinished shelf keeps changing meaning in your pages. It began "
        "as an accusation, but now you are meeting it as a patient promise and "
        "letting one honest next step be enough."
    ),
)
_CANDIDATES = (
    DetectionCandidate(index=0, target_type="habit", target_id=101, name="Meditation"),
    DetectionCandidate(index=1, target_type="habit", target_id=102, name="Running"),
    DetectionCandidate(index=2, target_type="habit", target_id=103, name="Strength training"),
    DetectionCandidate(index=3, target_type="habit", target_id=104, name="Morning pages"),
    DetectionCandidate(index=4, target_type="habit", target_id=105, name="Guitar practice"),
)
_EXPECTED_INDICES = [0, 2, 3]
# The invented fixture is not tied to wall-clock time.  Pinning both days keeps
# any optional relative-day fact the provider proposes deterministic while the
# live lane continues to exercise the production domain signature.
_DETECTION_CLOCK = DetectionClock(
    entry_day=date(2026, 9, 13),
    today=date(2026, 9, 13),
    max_backfill_days=30,
)


@pytest.fixture(scope="module")
def live_api_key() -> str:
    """Return the explicitly armed production key, or skip while unarmed."""
    api_key = resolve_live_resonance_api_key(os.environ)
    if api_key is None:
        pytest.skip(f"live resonance lane is opt-in; set {OPT_IN_ENV}=1 and {KEY_ENV}")
    return api_key


@pytest.fixture(scope="module")
def journal_body() -> str:
    """Return the committed, wholly invented journal fixture."""
    return _FIXTURE.read_text(encoding="utf-8")


def _skip_if_unreachable(exc: LLMProviderError) -> None:
    """Skip a transport-only failure and return for a loud provider fault."""
    if provider_is_unreachable(exc):
        pytest.skip(
            "real provider was unreachable; no resonance-yield verdict is available "
            f"({type(exc).__name__})"
        )


async def _call_marginalia(
    operation: Callable[[], Awaitable[MarginaliaOutcome]],
) -> MarginaliaOutcome:
    """Run one marginalia operation, skipping only a transport-only failure."""
    try:
        return await operation()
    except LLMProviderError as exc:
        _skip_if_unreachable(exc)
        raise


async def _call_detection(
    operation: Callable[[], Awaitable[list[CompletionDetected]]],
) -> list[CompletionDetected]:
    """Run one detection operation, skipping only a transport-only failure."""
    try:
        return await operation()
    except LLMProviderError as exc:
        _skip_if_unreachable(exc)
        raise


def _print_outcome(label: str, outcome: MarginaliaOutcome) -> None:
    """Print the lane's count-only measurement in a stable order."""
    rendered = " ".join(f"{key}={value}" for key, value in outcome.as_log_extra().items())
    sys.stdout.write(f"{label:<34} {rendered}\n")


def _assert_minimum_yield(label: str, outcome: MarginaliaOutcome) -> None:
    """Require the configured floor with only aggregate counts in the failure."""
    assert outcome.kept >= MIN_NOTES_KEPT, (
        f"{label} kept fewer than {MIN_NOTES_KEPT} notes; counts={outcome.as_log_extra()}"
    )


def _candidate_indices(
    hits: Sequence[CompletionDetected], candidates: Sequence[DetectionCandidate]
) -> list[int]:
    """Map trusted target identities back to the candidate indices supplied."""
    by_target = {
        (candidate.target_type, candidate.target_id): candidate.index for candidate in candidates
    }
    return sorted(by_target[(hit.target_type, hit.target_id)] for hit in hits)


@pytest.mark.asyncio
async def test_plain_marginalia_keeps_at_least_three_notes(
    live_api_key: str, journal_body: str
) -> None:
    """The shipped prompt keeps several anchored notes on a theme-rich page."""
    llm = BotmasonResonanceLLM(live_api_key)
    outcome = await _call_marginalia(lambda: generate_marginalia(journal_body, llm=llm))

    _print_outcome("marginalia/plain", outcome)
    _assert_minimum_yield("marginalia/plain", outcome)


@pytest.mark.asyncio
async def test_prior_letters_preserve_minimum_marginalia_yield(
    live_api_key: str, journal_body: str
) -> None:
    """Grounding in two earlier letters changes selection without collapsing yield."""
    llm = BotmasonResonanceLLM(live_api_key)
    outcome = await _call_marginalia(
        lambda: generate_marginalia(journal_body, llm=llm, prior_drafts=_PRIOR_DRAFTS)
    )

    _print_outcome("marginalia/with_prior_letters", outcome)
    _assert_minimum_yield("marginalia/with_prior_letters", outcome)


@pytest.mark.asyncio
async def test_detects_exactly_the_three_completed_habits(
    live_api_key: str, journal_body: str
) -> None:
    """Completed habits are selected while planned and skipped habits stay absent."""
    llm = BotmasonResonanceLLM(live_api_key)
    hits = await _call_detection(
        lambda: detect_completions(
            journal_body,
            candidates=_CANDIDATES,
            llm=llm,
            clock=_DETECTION_CLOCK,
        )
    )
    indices = _candidate_indices(hits, _CANDIDATES)

    sys.stdout.write(f"{'detection':<34} hits={indices}\n")
    assert indices == _EXPECTED_INDICES, (
        f"detection returned candidate indices {indices}; expected {_EXPECTED_INDICES}"
    )
