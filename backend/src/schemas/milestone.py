"""Milestone schemas — streak-day thresholds the UI surfaces as toasts."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

# Built-in milestone names the streak engine emits.  ``Literal`` rather
# than free string so the API contract is explicit and a typo at the
# emit site fails type-check before it surfaces as a missing-toast UX
# bug (BUG-SCHEMA-002).
MilestoneKind = Literal[
    "streak_started",
    "streak_milestone",
    "personal_best",
    "comeback",
]


class Milestone(BaseModel):
    """A streak event the UI may surface as a celebratory toast.

    The original schema carried a single ``threshold: int`` field with
    no kind, label, or timestamp -- consumers had no way to know
    *which* milestone fired or render an appropriate copy.

    ``threshold`` -- the consecutive-day count that triggered the
    milestone (e.g. 3, 7, 30).  Always positive.

    ``kind`` -- one of :data:`MilestoneKind`.  Defaults to
    ``"streak_milestone"`` so existing call sites that emit only the
    threshold continue to work without forcing a producer change.

    ``label`` -- optional human-readable copy for the toast.  When
    present, the UI renders it verbatim; when absent, the UI looks up
    a default for ``kind`` + ``threshold``.

    ``achieved_at`` -- when the milestone fired (server-side).  Helps
    clients dedupe rapid back-to-back submissions and order recent
    milestones in a history view.
    """

    threshold: int = Field(ge=1)
    kind: MilestoneKind = "streak_milestone"
    label: str | None = Field(default=None, max_length=120)
    achieved_at: datetime | None = None
