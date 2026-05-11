"""Practice-related schemas."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from typing import Any, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from domain.constants import TOTAL_STAGES as MAX_STAGE_NUMBER
from domain.practice_modes import PracticeMode
from schemas._base import OwnedResourcePublic
from schemas.practice_mode_config import (
    MeditationTimerConfig,
    ModeConfig,
    ModeConfigAdapter,
)

PRACTICE_NAME_MAX_LENGTH = 255
PRACTICE_DESCRIPTION_MAX_LENGTH = 2_000
PRACTICE_INSTRUCTIONS_MAX_LENGTH = 10_000
PRACTICE_REFLECTION_MAX_LENGTH = 5_000

MAX_DURATION_MINUTES = 24 * 60

# Server-side bounds for ``PracticeSessionCreate`` timestamps (BUG-PRACTICE-006,
# BUG-SCHEMA-008).  Sessions cannot end more than this far in the future
# (clock-skew tolerance) and cannot start more than this far in the past
# (backdate cap).  ``MAX_SESSION_DURATION`` rejects implausibly long sessions
# that would otherwise inflate streak / week-count math.
MAX_FUTURE_SKEW = timedelta(seconds=60)
MAX_BACKDATE_WINDOW = timedelta(hours=24)
MAX_SESSION_DURATION = timedelta(hours=8)


def _session_window_violations(
    started_at: datetime, ended_at: datetime, now: datetime
) -> list[str]:
    """Return the list of rule violations for a (started_at, ended_at) window.

    Returning a list of failure messages instead of raising inline keeps the
    branching shallow enough for xenon — the caller in
    :class:`PracticeSessionCreate` just raises on the first one.
    """
    if started_at.tzinfo is None or ended_at.tzinfo is None:
        return ["started_at and ended_at must be timezone-aware ISO timestamps"]
    rules = (
        (ended_at >= started_at, "ended_at must be greater than or equal to started_at"),
        (ended_at <= now + MAX_FUTURE_SKEW, "ended_at cannot be in the future"),
        (now - started_at <= MAX_BACKDATE_WINDOW, "started_at is too far in the past"),
        (
            ended_at - started_at <= MAX_SESSION_DURATION,
            "session duration exceeds the maximum allowed window",
        ),
    )
    return [message for ok, message in rules if not ok]


# -- Practice ---------------------------------------------------------------


def _validate_mode_config_payload(mode: str, payload: object) -> ModeConfig:
    """Validate a raw ``mode_config`` value against the discriminated union.

    Pydantic raises ``ValidationError`` for any structural / range failure,
    which FastAPI surfaces as 422. The mismatch check below is the one
    rule that isn't expressible inside the union itself — the union picks
    the right subclass from ``payload['mode']``; this guard rejects
    callers who submitted a config whose embedded ``mode`` disagrees with
    the parent ``mode`` field.
    """
    cfg = ModeConfigAdapter.validate_python(payload)
    if cfg.mode != mode:
        msg = f"mode_config.mode='{cfg.mode}' does not match mode='{mode}'"
        raise ValueError(msg)
    return cfg


class PracticeResponse(OwnedResourcePublic):
    """Public representation of a practice.

    ``submitted_by_user_id`` is intentionally excluded (BUG-PRACTICE-001 /
    BUG-SCHEMA-010): exposing the submitter's user id on a catalog GET
    leaks who proposed which draft and turns the practices endpoint into
    a user-id enumeration oracle.
    """

    id: int
    stage_number: int
    name: str
    description: str
    instructions: str
    default_duration_minutes: float
    approved: bool
    mode: str
    mode_config: ModeConfig


class PracticeCreate(BaseModel):
    """Payload for submitting a new user-created practice.

    ``mode`` and ``mode_config`` are optional for backwards compatibility:
    omitting both falls back to a meditation timer derived from
    ``default_duration_minutes`` so existing clients keep working.
    """

    stage_number: int = Field(ge=1, le=MAX_STAGE_NUMBER)
    name: str = Field(min_length=1, max_length=PRACTICE_NAME_MAX_LENGTH)
    description: str = Field(max_length=PRACTICE_DESCRIPTION_MAX_LENGTH)
    instructions: str = Field(max_length=PRACTICE_INSTRUCTIONS_MAX_LENGTH)
    default_duration_minutes: float = Field(gt=0, le=MAX_DURATION_MINUTES)
    # Typed as ``PracticeMode`` so an unknown value (e.g. ``"telepathy"``)
    # surfaces the enum's "Input should be 'meditation_timer', …" error
    # instead of falling through to the misleading "mode_config is
    # required" branch below.
    mode: PracticeMode | None = None
    mode_config: dict[str, Any] | None = None

    @model_validator(mode="after")
    def _resolve_mode_and_config(self) -> Self:
        """Fill in defaults and cross-validate ``mode`` ↔ ``mode_config``.

        The Pydantic model exposes raw types so the wire format stays JSON
        friendly, but the validator round-trips the payload through
        :class:`ModeConfigAdapter` so a malformed config is rejected at
        422 instead of leaking into the ORM row.
        """
        resolved_mode = (self.mode or PracticeMode.MEDITATION_TIMER).value
        if self.mode_config is None:
            if resolved_mode != PracticeMode.MEDITATION_TIMER.value:
                msg = "mode_config is required for non-default modes"
                raise ValueError(msg)
            default = MeditationTimerConfig(duration_minutes=self.default_duration_minutes)
            object.__setattr__(self, "mode_config", default.model_dump())
        else:
            cfg = _validate_mode_config_payload(resolved_mode, self.mode_config)
            object.__setattr__(self, "mode_config", cfg.model_dump())
        object.__setattr__(self, "mode", resolved_mode)
        return self


# -- UserPractice -----------------------------------------------------------


class UserPracticeCreate(BaseModel):
    """Payload for selecting a practice for a stage."""

    practice_id: int
    stage_number: int = Field(ge=1, le=MAX_STAGE_NUMBER)


class UserPracticeResponse(OwnedResourcePublic):
    """Public representation of a user-practice selection.

    ``user_id`` is intentionally excluded (BUG-T7): the row is only ever
    returned to its owner -- cross-user fetches raise 403 in the router
    -- so echoing the surrogate key adds no information and aids
    enumeration.

    ``effective_name`` and ``effective_config`` (ritual-03) collapse the
    catalog row + the user's optional overrides into a single payload so
    frontend code never has to merge by hand. Both are populated by the
    router from :mod:`domain.practice_resolution`.
    """

    id: int
    practice_id: int
    stage_number: int
    start_date: date
    end_date: date | None = None
    custom_name: str | None = None
    mode_config_override: dict[str, Any] | None = None
    effective_name: str | None = None
    effective_config: ModeConfig | None = None


class PracticeSessionSummary(BaseModel):
    """Minimal session info for embedding in user-practice detail."""

    id: int
    duration_minutes: float
    timestamp: datetime
    reflection: str | None = None


class UserPracticeDetail(OwnedResourcePublic):
    """User-practice with session history.

    ``user_id`` is intentionally excluded (BUG-T7); see
    :class:`UserPracticeResponse`.
    """

    id: int
    practice_id: int
    stage_number: int
    start_date: date
    end_date: date | None = None
    custom_name: str | None = None
    mode_config_override: dict[str, Any] | None = None
    effective_name: str | None = None
    effective_config: ModeConfig | None = None
    sessions: list[PracticeSessionSummary]


class UserPracticeCustomize(BaseModel):
    """PATCH body for ``/user-practices/{id}/customize`` (ritual-03).

    Both fields are nullable: passing ``None`` clears the override and
    falls back to the catalog value. Omitting a field leaves the existing
    value untouched (resolved at the router via ``model_fields_set``).
    The ``mode`` cannot be changed here — see
    :func:`domain.practice_resolution.effective_config` for the guard.
    """

    custom_name: str | None = Field(default=None, max_length=PRACTICE_NAME_MAX_LENGTH)
    mode_config_override: dict[str, Any] | None = None


# -- PracticeSession --------------------------------------------------------


class PracticeSessionCreate(BaseModel):
    """Payload for logging a practice session.

    Server-derived duration: clients send ISO ``started_at``/``ended_at``
    (timezone-aware) and the backend computes ``duration_minutes``
    (BUG-PRACTICE-006, BUG-SCHEMA-008).  Legacy clients that still send
    ``duration_minutes`` are rejected with 422 via ``extra="forbid"`` so the
    bug cannot resurface invisibly on a stale build.

    ``user_id`` is derived from the authenticated user's token.
    """

    model_config = ConfigDict(extra="forbid")

    user_practice_id: int
    started_at: datetime
    ended_at: datetime
    reflection: str | None = Field(default=None, max_length=PRACTICE_REFLECTION_MAX_LENGTH)

    @model_validator(mode="after")
    def _check_times(self) -> Self:
        violations = _session_window_violations(self.started_at, self.ended_at, datetime.now(UTC))
        if violations:
            raise ValueError(violations[0])
        return self

    @property
    def duration_minutes(self) -> float:
        """Server-derived duration in minutes (never client-supplied)."""
        return (self.ended_at - self.started_at).total_seconds() / 60


class PracticeSessionResponse(OwnedResourcePublic):
    """Public representation of a practice session.

    ``user_id`` is intentionally excluded (BUG-T7); the session is only
    ever returned to its owner.
    """

    id: int
    user_practice_id: int
    duration_minutes: float
    timestamp: datetime
    reflection: str | None = None
