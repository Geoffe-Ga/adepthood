"""The pure rules of beta feedback triage, pinned without a database.

Four rules, each small enough to be wrong in a way that looks right:

- the **transition table**, checked over the full status-by-status matrix so an
  edge added or removed anywhere turns a cell red;
- **build family**, the one piece of the fingerprint that is a product decision
  rather than a hash, pinned by example table;
- the **fingerprint**, which must move when any one of its inputs moves and
  must not confuse a missing control with a control literally named ``none``;
- **duplicate cycles**, which must be caught however long the loop is.

And the draft: its input type is pinned field by field, so a renderer cannot be
widened to read an account id without this file noticing, and its sections are
pinned so a draft missing its reproduction context is a failure too.
"""

from __future__ import annotations

import re
from dataclasses import replace
from itertools import product
from typing import cast

import pytest

from domain.feedback_triage import (
    BUILD_FAMILY_COMPONENTS,
    CONTROL_NULL_SENTINEL,
    DRAFT_SECTIONS,
    DRAFT_TITLE_MAX_LENGTH,
    FINGERPRINT_HEX_LENGTH,
    FORBIDDEN_DRAFT_FIELDS,
    MAX_DUPLICATE_CHAIN,
    NOT_PROVIDED,
    TRANSITION_NOT_ALLOWED,
    TRANSITIONS,
    DraftSource,
    TransitionNotAllowedError,
    build_family,
    check_transition,
    creates_duplicate_cycle,
    fingerprint,
    render_issue_draft,
)
from models.feedback import FeedbackReport, FeedbackStatus
from schemas.feedback import CONTROL_PATTERN

# The edges the product decided on (#2900, decision c), written out a second
# time and independently of ``TRANSITIONS`` so an edit to one is a disagreement
# with the other rather than a tautology.
_ALLOWED_EDGES = frozenset(
    {
        (FeedbackStatus.NEW, FeedbackStatus.TRIAGED),
        (FeedbackStatus.NEW, FeedbackStatus.CLOSED),
        (FeedbackStatus.TRIAGED, FeedbackStatus.PLANNED),
        (FeedbackStatus.TRIAGED, FeedbackStatus.CLOSED),
        (FeedbackStatus.PLANNED, FeedbackStatus.CLOSED),
        (FeedbackStatus.CLOSED, FeedbackStatus.TRIAGED),
    }
)

_ALL_PAIRS = list(product(FeedbackStatus, FeedbackStatus))

# The exact field set a draft may be built from. Pinned literally: the only
# mutation guard a renderer cannot step around is one where the forbidden value
# was never handed to it, and this list is what says it was not.
_DRAFT_SOURCE_FIELDS = (
    "public_id",
    "category",
    "impact",
    "summary",
    "intent",
    "expected",
    "actual",
    "screen",
    "control",
    "platform",
    "app_build",
    "viewport_class",
    "locale",
    "notes",
    "related_public_ids",
)


# ── Transitions ───────────────────────────────────────────────────────────


@pytest.mark.parametrize(("source", "target"), _ALL_PAIRS)
def test_every_cell_of_the_transition_matrix(
    source: FeedbackStatus, target: FeedbackStatus
) -> None:
    """Allowed pairs pass; every other pair, the diagonal included, is refused."""
    if (source, target) in _ALLOWED_EDGES:
        check_transition(source, target)
        assert target in TRANSITIONS[source]
    else:
        with pytest.raises(TransitionNotAllowedError) as raised:
            check_transition(source, target)
        assert str(raised.value) == TRANSITION_NOT_ALLOWED
        assert target not in TRANSITIONS.get(source, frozenset())


def test_the_table_declares_exactly_the_decided_edges() -> None:
    """No edge beyond the decided six, and every status has an entry."""
    declared = {(source, target) for source, targets in TRANSITIONS.items() for target in targets}
    assert declared == _ALLOWED_EDGES
    assert set(TRANSITIONS) == set(FeedbackStatus)


# ── Build family ──────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("app_build", "family"),
    [
        ("1.4.2+318", "1.4"),
        ("1.4.2", "1.4"),
        ("1.4", "1.4"),
        ("1.4.9-rc1", "1.4"),
        ("2026.09.17-beta", "2026.09"),
        ("7", "7"),
        ("abc123", "abc123"),
        ("1.5.0+1", "1.5"),
        ("1-beta.2.3", "1"),
    ],
)
def test_build_family_keeps_the_leading_components(app_build: str, family: str) -> None:
    """Strip the pre-release/build suffix, then keep the first components."""
    assert build_family(app_build) == family


def test_build_family_component_count_is_two() -> None:
    """The rule is named, and it is two."""
    assert BUILD_FAMILY_COMPONENTS == 2


# ── Fingerprint ───────────────────────────────────────────────────────────

_BASE = {
    "category": "broken",
    "screen": "journal.shelf",
    "control": "habit_offer.accept",
    "app_build": "1.4.2+318",
}


def _fp(**overrides: str | None) -> str:
    merged = {**_BASE, **overrides}
    return fingerprint(
        category=cast("str", merged["category"]),
        screen=cast("str", merged["screen"]),
        control=merged["control"],
        app_build=cast("str", merged["app_build"]),
    )


def test_the_fingerprint_is_deterministic_and_fixed_width() -> None:
    """Same inputs, same hex digest, of the named width."""
    first, second = _fp(), _fp()
    assert first == second
    assert len(first) == FINGERPRINT_HEX_LENGTH
    int(first, 16)


@pytest.mark.parametrize(
    "overrides",
    [
        {"category": "confusing"},
        {"screen": "habits.detail"},
        {"control": "habit_offer.decline"},
        {"control": None},
        {"app_build": "1.5.0"},
    ],
)
def test_the_fingerprint_moves_with_each_input(overrides: dict[str, str | None]) -> None:
    """Every input is load-bearing."""
    assert _fp(**overrides) != _fp()


def test_builds_in_one_family_share_a_fingerprint() -> None:
    """``1.4.2+318`` and ``1.4.9`` are one family; that is the point of the rule."""
    assert _fp(app_build="1.4.9") == _fp()


def test_a_missing_control_is_not_a_control_named_none() -> None:
    """The null sentinel cannot be spelled by a real control token."""
    assert _fp(control=None) != _fp(control="none")
    assert CONTROL_NULL_SENTINEL.startswith("\x00")
    assert re.fullmatch(CONTROL_PATTERN, CONTROL_NULL_SENTINEL) is None


# ── Duplicate cycles ──────────────────────────────────────────────────────


def test_a_self_link_is_a_cycle() -> None:
    """Linking a report to itself is the shortest loop there is."""
    assert creates_duplicate_cycle(1, 1, {})


def test_a_two_cycle_is_caught() -> None:
    """``2 -> 1`` exists; ``1 -> 2`` would close it."""
    assert creates_duplicate_cycle(1, 2, {2: 1})


def test_a_three_cycle_is_caught() -> None:
    """``3 -> 2 -> 1`` exists; ``1 -> 3`` would close it, two hops up."""
    assert creates_duplicate_cycle(1, 3, {3: 2, 2: 1})


def test_a_chain_without_the_source_is_not_a_cycle() -> None:
    """Linking onto a chain that never reaches the source is fine."""
    assert not creates_duplicate_cycle(9, 3, {3: 2, 2: 1})


def test_a_chain_longer_than_the_bound_is_refused_as_a_cycle() -> None:
    """Past the bound the walk stops, and stopping is a refusal, not a pass."""
    parents = {step: step - 1 for step in range(2, MAX_DUPLICATE_CHAIN + 3)}
    assert creates_duplicate_cycle(10_000, MAX_DUPLICATE_CHAIN + 2, parents)


def test_a_chain_just_inside_the_bound_is_walked_to_its_end() -> None:
    """A long legal chain is still accepted."""
    parents = {step: step - 1 for step in range(2, MAX_DUPLICATE_CHAIN)}
    assert not creates_duplicate_cycle(10_000, MAX_DUPLICATE_CHAIN - 1, parents)


# ── Draft ─────────────────────────────────────────────────────────────────


def test_the_draft_source_carries_exactly_the_allowlisted_fields() -> None:
    """The input type is the allowlist, and it is pinned literally."""
    assert tuple(DraftSource.__dataclass_fields__) == _DRAFT_SOURCE_FIELDS


def test_no_allowlisted_field_is_a_forbidden_one() -> None:
    """The two declarations cannot overlap."""
    assert FORBIDDEN_DRAFT_FIELDS.isdisjoint(_DRAFT_SOURCE_FIELDS)
    assert {"user_id", "email", "correlation_id", "idem_key"} <= FORBIDDEN_DRAFT_FIELDS


_BASE_SOURCE = DraftSource(
    public_id="FB-23456789",
    category="broken",
    impact="blocked",
    summary="The habit card vanished.",
    intent="Log a sit.",
    expected="The card stays.",
    actual="It disappeared.",
    screen="journal.shelf",
    control="habit_offer.accept",
    platform="ios",
    app_build="1.4.2+318",
    viewport_class="compact",
    locale="en-US",
    notes=(),
    related_public_ids=(),
)


def test_from_report_copies_only_allowlisted_values() -> None:
    """Built from a live row, the source holds none of the row's identity."""
    report = FeedbackReport(
        user_id=4242,
        public_id="FB-23456789",
        category="broken",
        impact="blocked",
        platform="ios",
        viewport_class="compact",
        summary="s",
        screen="journal.shelf",
        app_build="1.4.2",
        correlation_id="00000000-0000-4000-8000-000000000042",
        idem_key="digest-4242",
    )
    source = DraftSource.from_report(report, notes=("n",), related_public_ids=("FB-34567892",))
    rendered = repr(source)
    assert "4242" not in rendered
    assert "00000000-0000-4000-8000-000000000042" not in rendered
    assert "digest-4242" not in rendered
    assert source.notes == ("n",)
    assert source.related_public_ids == ("FB-34567892",)


def test_the_draft_has_every_section_in_order() -> None:
    """Title, then observed / expected / reproduction / impact / environment / sources."""
    draft = render_issue_draft(_BASE_SOURCE)
    positions = [draft.markdown.index(f"## {heading}") for heading in DRAFT_SECTIONS]
    assert positions == sorted(positions)
    assert draft.title.startswith("[broken]")
    assert "The habit card vanished." in draft.title
    for fragment in (
        "It disappeared.",
        "The card stays.",
        "Log a sit.",
        "`journal.shelf`",
        "`habit_offer.accept`",
        "blocked",
        "ios",
        "1.4.2+318",
        "compact",
        "en-US",
        "FB-23456789",
    ):
        assert fragment in draft.markdown


def test_notes_appear_only_when_supplied() -> None:
    """No notes, no operator section; a supplied note is rendered."""
    bare = render_issue_draft(_BASE_SOURCE)
    assert "Operator notes" not in bare.markdown
    noted = render_issue_draft(replace(_BASE_SOURCE, notes=("Seen twice on Android too.",)))
    assert "## Operator notes" in noted.markdown
    assert "Seen twice on Android too." in noted.markdown


def test_absent_answers_render_a_placeholder() -> None:
    """An optional answer left blank is said to be blank, not silently dropped."""
    draft = render_issue_draft(
        replace(_BASE_SOURCE, intent=None, expected=None, actual=None, control=None)
    )
    assert draft.markdown.count(NOT_PROVIDED) >= 4


def test_a_long_summary_is_cut_to_the_title_bound() -> None:
    """GitHub titles have a ceiling; the draft stays under ours."""
    draft = render_issue_draft(replace(_BASE_SOURCE, summary="x" * 500))
    assert len(draft.title) == DRAFT_TITLE_MAX_LENGTH


def test_secret_shapes_in_prose_never_reach_the_draft() -> None:
    """Every prose field is redacted, the title included."""
    poisoned = "ping me at tester@example.com with Bearer abc.def.ghi"
    draft = render_issue_draft(
        replace(
            _BASE_SOURCE,
            summary=poisoned,
            intent=poisoned,
            expected=poisoned,
            actual=poisoned,
            notes=(poisoned,),
        )
    )
    assert "tester@example.com" not in draft.title + draft.markdown
    assert "abc.def.ghi" not in draft.title + draft.markdown


def test_related_references_are_listed() -> None:
    """Reports folded into this one are cited by reference."""
    draft = render_issue_draft(
        replace(_BASE_SOURCE, related_public_ids=("FB-34567892", "FB-45678923"))
    )
    assert "FB-34567892" in draft.markdown
    assert "FB-45678923" in draft.markdown
    assert draft.source_public_ids == ("FB-23456789", "FB-34567892", "FB-45678923")
