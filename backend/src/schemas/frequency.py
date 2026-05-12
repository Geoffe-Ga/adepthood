"""Server-assembled frequency banner payload (ritual-05).

The Practice screen renders the same English string for every user; the
slot values (color / aspect / practice name) come from rows that live in
three different tables (:class:`StageProgress`, :class:`CourseStage`,
:class:`UserPractice` + :class:`Practice`). Assembling the copy on the
client would mean four round-trips and a string-template duplicated per
platform — the endpoint at ``GET /user-practices/current/frequency``
collapses both costs into a single payload.

:data:`BANNER_TEMPLATE` is the single source of truth for the wording:
copy changes happen here and the snapshot test in
``tests/test_frequency_endpoint.py`` pins the exact string so an
accidental edit fails CI.
"""

from __future__ import annotations

from pydantic import BaseModel

#: Three named slots: ``color`` / ``aspect`` / ``practice_name``. The
#: aspect appears twice in the copy but resolves to the same value, so
#: the format spec only declares it once.
BANNER_TEMPLATE = (
    "You are in the {color} frequency of APTITUDE. That means you are "
    "working on {aspect}. Your practice is {practice_name} but you are "
    "encouraged to replace it if another tradition has a practice that "
    "deals with {aspect} that calls to you more."
)


def render_banner_text(*, color: str, aspect: str, practice_name: str) -> str:
    """Render :data:`BANNER_TEMPLATE` with named arguments.

    Kept as a function (not a one-line ``.format`` call at the call site)
    so the wording change surface is a single name the test can import
    and pin.
    """
    return BANNER_TEMPLATE.format(color=color, aspect=aspect, practice_name=practice_name)


class FrequencyResponse(BaseModel):
    """Banner payload for ``GET /user-practices/current/frequency``.

    Structured fields are exposed alongside ``banner_text`` so the client
    can still render chips (color label, aspect badge) without parsing
    the assembled English string. ``user_practice_id`` is ``None`` when
    the user has not yet selected a practice for their current stage —
    the response surfaces the seeded preset for that stage so the banner
    can render before the first selection.
    """

    stage_number: int
    color: str
    aspect: str
    practice_name: str
    practice_id: int
    user_practice_id: int | None = None
    banner_text: str
