"""Stub output stored before #3096 is treated as absent outside the test seam.

Before the payer gate, a ``stub`` deployment cached demo letters into
``Marginalia.essay`` and stored the notes the stub wrote, each stamped with the
B07 provenance ``demo`` (#3062). Owner decision b07-e4 is that no writer
receives stub text as a generated artefact, and stopping *new* stub output does
not reach the rows already stored. So every read that serves a note or a letter
asks this module first:

* a demo-sourced note is not listed;
* a demo-sourced letter is not returned, not counted as a cached letter (so
  asking for it again goes through the payer gate and is regenerated or
  refused), not shelved as a Voice Draft, and never sent along as a prior
  letter.

Nothing is deleted. Hiding is reversible and a delete is not; an operator may
sweep the rows later. While the stub test seam is armed -- the backend suite
and the end-to-end lane, where the stub is the only answer there is -- demo
rows stay visible, exactly as before.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Final

from sqlmodel import col

from models.marginalia import Marginalia, MarginaliaSource
from schemas.marginalia import MarginaliaResponse
from services.botmason import stub_seam_armed

if TYPE_CHECKING:
    from sqlalchemy import ColumnElement

_DEMO: Final = MarginaliaSource.DEMO.value


def demo_hidden() -> bool:
    """Whether stored demo output is withheld: everywhere but the armed test seam."""
    return not stub_seam_armed()


def visible_note_clauses() -> list[ColumnElement[bool]]:
    """The ``WHERE`` clauses that drop demo-sourced notes, or none inside the seam.

    ``IS DISTINCT FROM`` rather than ``!=`` so a note whose source was never
    recorded (``NULL``, older than receipts) stays listed.
    """
    if not demo_hidden():
        return []
    return [col(Marginalia.source).is_distinct_from(_DEMO)]


def served_letter_clauses() -> list[ColumnElement[bool]]:
    """The ``WHERE`` clauses that drop demo-sourced letters, or none inside the seam."""
    if not demo_hidden():
        return []
    return [col(Marginalia.essay_source).is_distinct_from(_DEMO)]


def has_served_letter(note: Marginalia) -> bool:
    """Whether ``note`` carries a letter that may be served as already written."""
    if note.essay is None:
        return False
    return not (demo_hidden() and note.essay_source == _DEMO)


def served_note(note: Marginalia) -> MarginaliaResponse:
    """Project ``note`` for a response, with a withheld demo letter shown as no letter."""
    response = MarginaliaResponse.model_validate(note, from_attributes=True)
    if note.essay is None or has_served_letter(note):
        return response
    return response.model_copy(
        update={"essay": None, "essay_generated_at": None, "essay_source": None}
    )
