"""The triage command dispatch fails closed.

``POST /actions`` accepts a discriminated union of four commands. Pydantic
refuses anything outside it at the boundary, so the dispatcher's job is to
send each variant to its own writer -- and, if a fifth variant is ever added to
the union without a branch here, to refuse it rather than route it somewhere
plausible. A bare ``else`` that sent every unknown command to ``add_note``
would turn a missing branch into a silent misroute that writes an audit event.

The type-level half of this is mypy strict with ``assert_never``; this module
proves the runtime half.
"""

from __future__ import annotations

from typing import cast

import pytest
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from dependencies.admin import AdminContext
from models.feedback import FeedbackReport
from models.user import User
from routers import admin_feedback
from routers.admin_feedback import apply_triage_command
from schemas.feedback_admin import FeedbackTriageCommand
from services.feedback_triage import Actor


class _FifthCommand(BaseModel):
    """A command the dispatcher has no branch for."""

    action: str = "reopen_everything"
    body: str = "not a note"


@pytest.mark.asyncio
async def test_an_unknown_command_is_refused_not_misrouted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No writer is called, and the dispatcher raises."""
    called: list[str] = []

    async def _record_call(*_args: object, **_kwargs: object) -> None:
        called.append("writer")

    for writer in ("transition", "link_duplicate", "unlink_duplicate", "add_note"):
        monkeypatch.setattr(admin_feedback.feedback_triage, writer, _record_call)
    context = AdminContext(session=cast("AsyncSession", object()), admin=cast("User", object()))

    with pytest.raises(AssertionError):
        await apply_triage_command(
            cast("FeedbackTriageCommand", _FifthCommand()),
            cast("FeedbackReport", object()),
            context,
            cast("Actor", object()),
        )
    assert called == []
