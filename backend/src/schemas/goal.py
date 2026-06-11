"""Goal related schemas."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

from domain.streaks import WEEKDAY_ABBREVIATIONS
from models.goal import GoalTier

# Canonical-case lookup: "mon" -> "Mon", mirroring date.strftime("%a").
_CANONICAL_WEEKDAY: dict[str, str] = {day.lower(): day for day in WEEKDAY_ABBREVIATIONS}


class GoalCompletionPublic(BaseModel):
    """One logged check-in row, embedded on the goal (BUG-FE-HABIT-301)."""

    id: int
    timestamp: datetime
    completed_units: float


class Goal(BaseModel):
    """Public representation of a :class:`models.goal.Goal`.

    This schema mirrors the SQLModel definition so API consumers can rely on a
    stable contract. Only fields exposed over the wire are included.
    """

    id: int
    habit_id: int
    title: str
    description: str | None = None
    tier: GoalTier
    target: float
    target_unit: str
    frequency: float
    frequency_unit: str
    is_additive: bool = True
    goal_group_id: int | None = None
    days_of_week: list[str] | None = None


class GoalWithCompletions(Goal):
    """Goal + embedded completions; separate from :class:`Goal` to avoid lazy-load on PUT."""

    completions: list[GoalCompletionPublic] = Field(default_factory=list)


class GoalUpdate(BaseModel):
    """Payload for ``PUT /goals/{goal_id}``.

    Full-replace REST PUT semantics: every field is required (or has an
    explicit default) and ``model_dump()`` writes them all to the row.
    Optional fields like ``description`` revert to ``None`` if omitted —
    callers building partial-update UIs must read the current goal first
    and resend its values.

    ``habit_id`` is deliberately excluded -- a goal is permanently bound to its
    parent habit.  Allowing the caller to forge ``habit_id`` would let them
    reparent goals across habits (and across tenants if combined with an IDOR).
    The schema rejects unknown fields so the server doesn't silently accept a
    spoofed ``habit_id`` and discard it -- callers see a 422 instead.
    """

    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=2_000)
    tier: GoalTier
    # ``ge=0`` (not ``gt=0``): target=0 is legitimate for subtractive
    # "abstinence" goals — e.g. the stretch tier of caffeine / alcohol /
    # scrolling. ``frequency`` is strictly positive: "do X zero times
    # per week" is meaningless on every tier.
    target: float = Field(ge=0)
    target_unit: str = Field(min_length=1, max_length=50)
    frequency: float = Field(gt=0)
    frequency_unit: str = Field(min_length=1, max_length=50)
    is_additive: bool = True
    goal_group_id: int | None = None
    #: Weekly cadence, e.g. ["Mon", "Wed"]; None means every day.
    days_of_week: list[str] | None = None

    @field_validator("days_of_week")
    @classmethod
    def _validate_days_of_week(cls, value: list[str] | None) -> list[str] | None:
        """Normalise entries to canonical "Mon".."Sun"; reject anything else."""
        if value is None:
            return None
        normalised: list[str] = []
        for day in value:
            canonical = _CANONICAL_WEEKDAY.get(day.lower())
            if canonical is None:
                msg = f"days_of_week entries must be one of {WEEKDAY_ABBREVIATIONS}; got {day!r}"
                raise ValueError(msg)
            normalised.append(canonical)
        return normalised


class GoalUnitsUpdate(BaseModel):
    """Payload for ``PUT /habits/{habit_id}/goals/units`` (issue #289).

    The GoalUnitEditor edits the unit fields once for the user but they
    apply to every tier goal; updating them through three separate
    ``PUT /goals/{id}`` calls left a partial-failure window with tiers on
    mismatched units server-side.  This batch payload carries exactly the
    shared fields so the router can update all of a habit's goals inside
    one transaction.  Bounds mirror :class:`GoalUpdate`.
    """

    model_config = ConfigDict(extra="forbid")

    target_unit: str = Field(min_length=1, max_length=50)
    frequency: float = Field(gt=0)
    frequency_unit: str = Field(min_length=1, max_length=50)
