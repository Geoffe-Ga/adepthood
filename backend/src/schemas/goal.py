"""Goal related schemas."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from models.goal import GoalTier


class GoalCompletionPublic(BaseModel):
    """Public representation of a :class:`models.goal_completion.GoalCompletion`.

    Embedded in goal responses so the frontend can rebuild a habit's progress
    bar after a fresh API rehydrate (BUG-FE-HABIT-301).  Without this the
    backend silently discarded the only durable record of a user's logged
    units -- the frontend ``mapApiHabits`` hardcoded ``completions: []`` and
    the progress bar reset to 0% on every cold load even though the streak
    (a scalar on the parent habit) survived.
    """

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


class GoalWithCompletions(Goal):
    """Goal response that includes the embedded completions history.

    Embedded in the habit list / detail responses so the frontend can rebuild
    a habit's progress bar after a fresh API rehydrate (BUG-FE-HABIT-301).
    Without this, the backend silently discarded the only durable record of
    a user's logged units -- ``mapApiHabits`` hardcoded ``completions: []``
    and the progress bar reset to 0% on every cold load even though the
    streak (a scalar on the parent habit) survived.

    Kept as a separate schema from :class:`Goal` so endpoints that don't
    eager-load completions (e.g. ``PUT /goals/{id}``) don't trigger a
    greenlet lazy-load when Pydantic walks the relation.
    """

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
