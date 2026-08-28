r"""No response body may carry an unpaired surrogate, and none may 500 over one.

A lone surrogate (U+D800-U+DFFF with no partner) survives ``json.loads`` into a
Python ``str`` but has no UTF-8 encoding at all, so *rendering* one is fatal.
Both of this application's response renderers die on it, and which one fires
depends on the route:

* A route declaring a ``response_model`` serialises through pydantic-core --
  FastAPI's ``use_dump_json`` is gated on ``response_field is not None`` -- and
  raises ``PydanticSerializationError``.
* A route without one, and every hand-built ``JSONResponse`` in ``errors.py``,
  goes through Starlette's ``JSONResponse.render``, which uses
  ``ensure_ascii=False`` and raises ``UnicodeEncodeError``.

Either way the handler dies and the caller is told the server broke, over a
value the caller merely typed.

**Nothing here is a regression test for a live defect.** No route can currently
be made to do this; the module exists because the reasons why are incidental,
undocumented, and spread across four unrelated mechanisms:

1. pydantic-core refuses a lone surrogate for any ``str`` carrying a length or
   pattern bound (it needs a Rust ``&str`` to measure), answering
   ``string_unicode`` -- so only the handful of *unconstrained* text fields can
   carry one past validation at all.
2. Those few are each closed by a validator of their own, or by the flush guard
   in :mod:`security.pg_text_guard`.
3. Query and path parameters percent-decode through ``urllib.parse.unquote``,
   whose default is ``errors="replace"``, so a surrogate arrives as U+FFFD.
4. Validator messages quote client text with ``!r``, and ``repr()`` of a lone
   surrogate is pure ASCII (pinned separately, in the sibling module).

Every one of those could be undone by a change that looks like an improvement.
This module is the alarm.

The routes driven below are not a sample. They are the complete set of request
fields that can hold a lone surrogate after field validation, found by walking
the live ``app.routes`` object, taking the transitive closure over nested body
models, and probing every leaf annotation -- eleven fields on nine routes, plus
the three nested config strings reachable through the two ``dict[str, Any]``
fields, plus the query and path shapes.  Eighteen probes over fifteen distinct
operations: ``POST /practice-sessions/`` carries three of them and ``/journal/``
is reached by four different methods.

Bodies are ASCII byte literals in which the surrogate is an explicit ``\udbdb``
escape, sent with ``content=`` and an explicit content type.  httpx's ``json=``
helper serialises with ``ensure_ascii=False`` and would die client-side before a
request was ever built, so the escape is not a stylistic choice.

Each case pins its exact status as well as the invariant.  A bare "not a 500"
would pass for the wrong reason on a 401 from a broken fixture or a 404 from a
renamed route, and would then keep passing forever.
"""

from __future__ import annotations

from datetime import date
from http import HTTPStatus
from urllib.parse import quote

import pytest
from httpx import AsyncClient, Response
from sqlalchemy.ext.asyncio import AsyncSession

from models.goal import Goal
from models.habit import Habit
from tests.test_user_practice_customization import (
    _create_user_practice,
    _seed_practice,
    _signup,
)

# An unpaired *high* surrogate, written as a code point so this file stays plain
# ASCII and nothing depends on an editor or clipboard preserving it.
_LONE_SURROGATE = chr(0xDBDB)

# The whole surrogate block.  A well-formed pair never survives JSON decoding as
# two members of this range -- it decodes to one astral code point above U+FFFF
# -- so anything found in here is unpaired by construction.
_SURROGATE_FIRST = 0xD800
_SURROGATE_LAST = 0xDFFF

_JSON_HEADERS = {"content-type": "application/json"}

# The same surrogate as a percent-encoded path/query segment.  ``surrogatepass``
# is the only codec that will emit these three bytes; a client that produced
# them is exactly the caller this module is about.
_ENCODED_SURROGATE = quote(_LONE_SURROGATE.encode("utf-8", "surrogatepass"))

_SIGNUP_PASSWORD = "securepassword123"  # pragma: allowlist secret
# A placeholder, and nothing more: ``id_token`` declares only a non-empty
# minimum and a 4096-character ceiling, and this value is never verified against
# a provider because the request is rejected at the schema layer. Pydantic
# validates every field independently, so the timezone validator runs whatever
# this holds.
_OAUTH_ID_TOKEN = "x" * 40


def _assert_renderable(response: Response, expected: HTTPStatus, label: str) -> None:
    """Assert ``response`` rendered at all, and carries no unpaired surrogate.

    Three separate claims, because they fail for different reasons: the body is
    decodable UTF-8 (a renderer that emitted ``surrogatepass`` bytes would not
    be), it holds no surrogate code point, and the status is the one this case
    is supposed to produce.
    """
    body = response.content
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError as exc:  # pragma: no cover - a live defect, not a shape
        pytest.fail(f"{label}: body is not valid UTF-8 ({exc})")
    offenders = [hex(ord(ch)) for ch in text if _SURROGATE_FIRST <= ord(ch) <= _SURROGATE_LAST]
    assert not offenders, f"{label}: response body carries surrogate(s) {offenders}: {text!r}"
    assert response.status_code == expected, f"{label}: expected {expected}, got {body!r}"


@pytest.mark.asyncio
async def test_timezone_fields_reject_without_rendering(async_client: AsyncClient) -> None:
    """The four unconstrained ``timezone`` fields answer 422, not 500."""
    _assert_renderable(
        await async_client.post(
            "/auth/signup",
            content=b'{"email":"surrogate@example.com","password":"'
            + _SIGNUP_PASSWORD.encode()
            + b'","timezone":"a\\udbdbb"}',
            headers=_JSON_HEADERS,
        ),
        HTTPStatus.UNPROCESSABLE_ENTITY,
        "POST /auth/signup",
    )
    for path in ("/auth/oauth/google", "/auth/oauth/apple"):
        _assert_renderable(
            await async_client.post(
                path,
                content=b'{"id_token":"' + _OAUTH_ID_TOKEN.encode() + b'","timezone":"a\\udbdbb"}',
                headers=_JSON_HEADERS,
            ),
            HTTPStatus.UNPROCESSABLE_ENTITY,
            f"POST {path}",
        )
    headers, _ = await _signup(async_client)
    _assert_renderable(
        await async_client.put(
            "/users/me/timezone",
            content=b'{"timezone":"a\\udbdbb"}',
            headers={**headers, **_JSON_HEADERS},
        ),
        HTTPStatus.UNPROCESSABLE_ENTITY,
        "PUT /users/me/timezone",
    )


@pytest.mark.asyncio
async def test_habit_notification_lists_reject_without_rendering(
    async_client: AsyncClient,
) -> None:
    """``list[str]`` habit fields answer 422 from the flush guard, not 500."""
    headers, _ = await _signup(async_client)
    for field in (b"notification_days", b"notification_times"):
        _assert_renderable(
            await async_client.post(
                "/habits/",
                content=b'{"name":"n","icon":"i","start_date":"2024-01-01","energy_cost":1,'
                b'"energy_return":2,"' + field + b'":["a\\udbdbb"]}',
                headers={**headers, **_JSON_HEADERS},
            ),
            HTTPStatus.UNPROCESSABLE_ENTITY,
            f"POST /habits/ {field.decode()}",
        )


async def _seed_habit(db_session: AsyncSession, user_id: int) -> Habit:
    """Insert a plain habit so the update half of the write surface is reachable."""
    habit = Habit(
        name="H",
        icon="i",
        start_date=date(2024, 1, 1),
        energy_cost=1,
        energy_return=2,
        user_id=user_id,
    )
    db_session.add(habit)
    await db_session.commit()
    await db_session.refresh(habit)
    return habit


@pytest.mark.asyncio
async def test_habit_update_rejects_without_rendering(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The PUT half of the habit write surface answers 422 too.

    Driven separately from the create case because the flush guard reads
    ``session.dirty`` through a different code path than ``session.new``, and a
    guard that covered only creates would leave every update exposed.
    """
    headers, user_id = await _signup(async_client)
    habit = await _seed_habit(db_session, user_id)
    _assert_renderable(
        await async_client.put(
            f"/habits/{habit.id}",
            content=b'{"name":"n","icon":"i","start_date":"2024-01-01","energy_cost":1,'
            b'"energy_return":2,"notification_days":["a\\udbdbb"]}',
            headers={**headers, **_JSON_HEADERS},
        ),
        HTTPStatus.UNPROCESSABLE_ENTITY,
        "PUT /habits/{id}",
    )


@pytest.mark.asyncio
async def test_goal_days_of_week_rejects_without_rendering(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``days_of_week`` answers 422 with its offending entry quoted via ``!r``."""
    headers, user_id = await _signup(async_client)
    habit = await _seed_habit(db_session, user_id)
    goal = Goal(
        habit_id=habit.id,
        title="g",
        tier="clear",
        target=1,
        target_unit="x",
        frequency=1,
        frequency_unit="per_day",
    )
    db_session.add(goal)
    await db_session.commit()
    await db_session.refresh(goal)
    _assert_renderable(
        await async_client.put(
            f"/goals/{goal.id}",
            content=b'{"title":"t","tier":"clear","target":1,"target_unit":"x",'
            b'"frequency":1,"frequency_unit":"per_day","days_of_week":["a\\udbdbb"]}',
            headers={**headers, **_JSON_HEADERS},
        ),
        HTTPStatus.UNPROCESSABLE_ENTITY,
        "PUT /goals/{id}",
    )


@pytest.mark.asyncio
async def test_reflection_scope_key_rejects_without_rendering(async_client: AsyncClient) -> None:
    """Both ``reflection_scope_key`` surfaces answer 422 from the key parser."""
    headers, _ = await _signup(async_client)
    _assert_renderable(
        await async_client.post(
            "/journal/",
            content=b'{"message":"hello","reflection_level":"week",'
            b'"reflection_scope_key":"a\\udbdbb"}',
            headers={**headers, **_JSON_HEADERS},
        ),
        HTTPStatus.UNPROCESSABLE_ENTITY,
        "POST /journal/",
    )
    _assert_renderable(
        await async_client.patch(
            "/journal/1",
            content=b'{"reflection_level":"week","reflection_scope_key":"a\\udbdbb"}',
            headers={**headers, **_JSON_HEADERS},
        ),
        HTTPStatus.UNPROCESSABLE_ENTITY,
        "PATCH /journal/{id}",
    )


@pytest.mark.asyncio
async def test_mode_config_dict_rejects_without_rendering(async_client: AsyncClient) -> None:
    """A surrogate inside the ``dict[str, Any]`` catalog config answers 422.

    ``unit_label`` is deliberately an *unconstrained* ``str`` on
    ``RepCounterConfig``, so it is one of the few members the length-bound rule
    does not already cover; what refuses it is the tagged-union validator.
    """
    headers, _ = await _signup(async_client)
    _assert_renderable(
        await async_client.post(
            "/practices/",
            content=b'{"stage_number":1,"name":"n","description":"d","instructions":"i",'
            b'"default_duration_minutes":10,"mode":"rep_counter",'
            b'"mode_config":{"mode":"rep_counter","target_reps":5,'
            b'"unit_label":"a\\udbdbb"}}',
            headers={**headers, **_JSON_HEADERS},
        ),
        HTTPStatus.UNPROCESSABLE_ENTITY,
        "POST /practices/",
    )


@pytest.mark.asyncio
async def test_mode_config_override_rejects_without_rendering(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The per-user override answers 422 from its own size-cap validator.

    That validator measures the payload with ``ensure_ascii=False``, so it hits
    the encode error first and reports it as a value error.  The refusal is
    incidental to what the validator is for, which is why it is pinned here.
    """
    headers, user_id = await _signup(async_client)
    practice = await _seed_practice(db_session)
    up_id = await _create_user_practice(async_client, db_session, headers, user_id, practice)
    _assert_renderable(
        await async_client.patch(
            f"/user-practices/{up_id}/customize",
            content=b'{"mode_config_override":{"mode":"meditation_timer",'
            b'"duration_minutes":10,"start_bell":true,"halfway_bell":false,'
            b'"end_bell":true,"x":"a\\udbdbb"}}',
            headers={**headers, **_JSON_HEADERS},
        ),
        HTTPStatus.UNPROCESSABLE_ENTITY,
        "PATCH /user-practices/{id}/customize",
    )


@pytest.mark.asyncio
async def test_session_metadata_tag_rejects_without_rendering(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A surrogate discriminator tag answers 422 with the tag lossily sanitised.

    pydantic-core cannot borrow a Rust ``&str`` from a surrogate-bearing Python
    string, so the tag it quotes back in ``msg`` arrives as U+FFFD.  That
    lossiness is load-bearing: ``msg`` is one of the three keys the validation
    handler keeps, and it is echoed straight into the 422 body.
    """
    headers, user_id = await _signup(async_client)
    practice = await _seed_practice(db_session)
    up_id = await _create_user_practice(async_client, db_session, headers, user_id, practice)
    _assert_renderable(
        await async_client.post(
            "/practice-sessions/",
            content=b'{"user_practice_id":%d,"started_at":"2026-01-01T10:00:00+00:00",'
            b'"ended_at":"2026-01-01T10:10:00+00:00",'
            b'"mode_metadata":{"mode":"a\\udbdbb"}}' % up_id,
            headers={**headers, **_JSON_HEADERS},
        ),
        HTTPStatus.UNPROCESSABLE_ENTITY,
        "POST /practice-sessions/ mode tag",
    )


@pytest.mark.asyncio
async def test_session_metadata_string_rejects_without_rendering(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An unconstrained ``str`` inside session metadata answers 422."""
    headers, user_id = await _signup(async_client)
    practice = await _seed_practice(
        db_session,
        mode="card_meditation",
        mode_config={
            "mode": "card_meditation",
            "deck_id": "d",
            "cards": [{"name": "c", "image_uri": None, "image_asset_key": None, "symbolism": None}],
        },
    )
    up_id = await _create_user_practice(async_client, db_session, headers, user_id, practice)
    _assert_renderable(
        await async_client.post(
            "/practice-sessions/",
            content=b'{"user_practice_id":%d,"started_at":"2026-01-01T10:00:00+00:00",'
            b'"ended_at":"2026-01-01T10:10:00+00:00",'
            b'"mode_metadata":{"mode":"card_meditation","deck_id":"d",'
            b'"card_drawn_name":"a\\udbdbb"}}' % up_id,
            headers={**headers, **_JSON_HEADERS},
        ),
        HTTPStatus.UNPROCESSABLE_ENTITY,
        "POST /practice-sessions/ card_drawn_name",
    )


@pytest.mark.asyncio
async def test_option_key_rejects_before_the_catalog_check(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``chosen_option_key`` answers 422 before the pre-persist catalog check.

    This one is worth its own case because the catalog check that would
    normally reject it runs *before* anything is written, so the flush guard is
    not standing behind it.  Only the union validator is.
    """
    headers, user_id = await _signup(async_client)
    practice = await _seed_practice(
        db_session,
        name="anchor",
        mode="mindful_anchor",
        mode_config={
            "mode": "mindful_anchor",
            "instruction": "sit",
            "min_duration_seconds": 10,
            "options": [{"key": "grass", "label": "Grass", "description": None}],
            "require_option_choice": True,
        },
    )
    up_id = await _create_user_practice(async_client, db_session, headers, user_id, practice)
    _assert_renderable(
        await async_client.post(
            "/practice-sessions/",
            content=b'{"user_practice_id":%d,"started_at":"2026-01-01T10:00:00+00:00",'
            b'"ended_at":"2026-01-01T10:10:00+00:00",'
            b'"mode_metadata":{"mode":"mindful_anchor","chosen_option_key":"a\\udbdbb",'
            b'"duration_seconds":600,"met_min_duration":true}}' % up_id,
            headers={**headers, **_JSON_HEADERS},
        ),
        HTTPStatus.UNPROCESSABLE_ENTITY,
        "POST /practice-sessions/ chosen_option_key",
    )


@pytest.mark.asyncio
async def test_query_and_path_parameters_never_carry_a_surrogate(
    async_client: AsyncClient,
) -> None:
    """A percent-encoded surrogate arrives as U+FFFD, so no parameter can hold one.

    Both decode through ``urllib.parse.unquote``, whose default is
    ``errors="replace"``.  Pinned because it is the assumption that makes the
    body sweep above a *complete* answer rather than a partial one: if a
    parameter could carry a surrogate, every route would be in scope again.
    """
    headers, _ = await _signup(async_client)
    _assert_renderable(
        await async_client.get(f"/journal/?tag={_ENCODED_SURROGATE}", headers=headers),
        HTTPStatus.UNPROCESSABLE_ENTITY,
        "GET /journal/?tag",
    )
    _assert_renderable(
        await async_client.get(f"/course/content/{_ENCODED_SURROGATE}", headers=headers),
        HTTPStatus.UNPROCESSABLE_ENTITY,
        "GET /course/content/{id}",
    )
    _assert_renderable(
        await async_client.get(f"/practices/share/{_ENCODED_SURROGATE}", headers=headers),
        HTTPStatus.NOT_FOUND,
        "GET /practices/share/{token}",
    )
