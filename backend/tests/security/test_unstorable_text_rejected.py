"""A value the published contract accepts, and no column can hold, is a 422.

Two independent 500s share one shape: a request body passes every declared
validation, reaches a column that cannot store what it carries, and the
driver's own refusal surfaces as an unhandled exception -- so a caller who sent
something the API never promised to accept is told the server broke.

**An explicit JSON null for an optional PATCH field.**  Both PATCH bodies in
this application declare their fields as optional booleans, so a literal null
validates.  ``model_dump(exclude_unset=True)`` then reports that field as
*set* -- an explicit null is not an omission -- and the router assigns ``None``
into a NOT NULL Boolean column.  ``/depth-preferences`` is where a fuzz run
found it; ``/ui-flags`` is a line-for-line copy of the same router and schema
with the identical defect against its own two columns, reached here by hand
because a defect that was copy-pasted once will be copy-pasted again.

**The code point U+0000 in user text.**  ``Habit.notification_days`` is a
PostgreSQL text array, and PostgreSQL stores no text value containing U+0000 in
any encoding: asyncpg refuses it with CharacterNotInRepertoireError (invalid
byte sequence for encoding UTF8: 0x00) and the request 500s.  **This suite
cannot see that.**  Its database is SQLite, which stores the NUL happily, so
before the fix the habit case below answers **200** and hands the NUL back
inside its own response body.  A reader who takes that 200 for the production
behaviour has read this file backwards.

The two exotic bodies are the ones the fuzz run actually sent, recovered from
its JUnit artifact and embedded as raw byte literals in which every non-ASCII
character is an explicit codepoint escape -- so the file stays plain ASCII and
nothing here depends on an editor, a terminal, or a clipboard preserving an
astral character.  They are sent with ``content=`` and an explicit content
type rather than through httpx's ``json=`` helper, which serialises with
``ensure_ascii=False`` and dies client-side before a request is ever built.

Most of what is startling about those bodies is a red herring.  Every surrogate
in them is a well-formed **pair** encoding an astral-plane character -- there
is not one unpaired surrogate anywhere -- and the exotic keys are schema extras
that both models silently ignore.  What actually breaks is the plain
``"enable_practices": null`` in the first body and the single U+0000 inside
``notification_days[5]`` in the second.

Both bodies are driven exactly as recorded, down to the byte.  Nothing is
trimmed to suit a test, and one detail is worth stating because it looks like a
mistake: the habit body's ``name`` is a single U+008F, a C0 control character
that renders as nothing at all in a terminal.  It is one character, so it
satisfies the ``min_length=1`` on that field, and the request therefore travels
the whole way to the write exactly as the fuzz run sent it.  Anyone who
reformats these literals by hand will silently drop that character -- along
with every other control code in them -- and the body will start being refused
for an empty ``name`` instead, which looks like a passing test and proves
nothing.

Assertions pin the *shape* of each rejection, never the status alone.  A bare
``status_code == 422`` would pass for the wrong reason on every one of these
routes: the empty-body validator already answers 422, and so would the
``min_length`` on ``name`` if these literals were ever mangled.  ``type`` names
which check fired and ``loc`` names where, and no unrelated rejection can
produce that pair.  Each endpoint also carries an ordinary, boring companion
request, so a 422 cannot be a routing artifact.
"""

from __future__ import annotations

from http import HTTPStatus

import pytest
from httpx import AsyncClient, Response

_PREFS_URL = "/depth-preferences"
_UI_FLAGS_URL = "/ui-flags"
_HABITS_URL = "/habits/"

# The recorded bodies are pre-encoded bytes, so the content type has to be
# stated: httpx only infers it for the kwargs that do their own serialising.
_JSON_HEADERS = {"Content-Type": "application/json"}

# Pydantic's own code for "this field is not a boolean", which is what an
# explicit null becomes once the field stops being nullable.  Nothing but the
# declared annotation can produce it.
_NOT_A_BOOLEAN = "bool_type"

# The guard's code for a code point no PostgreSQL text column can hold.  These
# tests are the contract: the rejection an implementation emits has to carry
# this ``type`` and a ``loc`` naming the offending attribute.
_UNSTORABLE_TEXT = "unstorable_text"

# The offending code point, and the escape a JSON encoder would spell it with.
# A response body must contain neither: the whole point of returning a
# structured 422 rather than the driver's message is that the material stays
# out of anything a client might log, forward, or paste into a ticket.
_NUL = chr(0)
_NUL_JSON_ESCAPE = "\\u0000"

# An ordinary habit, for the companion requests: no astral planes, no escapes.
_PLAIN_HABIT = {
    "name": "Morning sit",
    "icon": "candle",
    "start_date": "2026-01-01",
    "energy_cost": 10,
    "energy_return": 20,
    "notification_days": ["mon", "wed"],
    "notification_frequency": "off",
}

_RECORDED_DEPTH_PREFERENCES_BODY = (
    rb'{"c\udbdb\udffd\udb50\udeda\ud859\udfcb\ud805\uddd1\u00c0\u001f\u00dd": [{"l'
    rb'\u00a1\u00dcy\\\u00b8\u00d1R\u00e33\u008b\u0019": "\u00a0\u0091\u00bf\u0089", '
    rb'"\u0014\u0013z\u00a8\u0003": {}, "\u00b4": {}}, [-11172]], "enable_practices":'
    rb' null, "enable_course": true}'
)

_RECORDED_HABIT_BODY = (
    rb'{"\u00da\udbd7\udde6k\u0095\u0004\ud8da\udd62\udb85\udd9a\n": [[]], "": {}, "'
    rb"\u00b3)\u00a8\ud8b9\udd17\udaba\udf55HD\u00c4\uda1a\ude56\ud928\udf15\f\u001b"
    rb'\u00e8\u00c7": null, "notification_times": null, "energy_cost": 170, "revealed'
    rb'": false, "icon": "\u00e2\ud889\udd67\udb49\udf89\u00d2/\u00bb\u00c3\u0013\nL'
    rb'\u00c6\u00dc\r", "is_carryover": true, "energy_return": 914, "sort_order": nul'
    rb'l, "stage": "\u009e[\u4523[\"\udb8d\ude48", "notification_days": ["", "\u0017C'
    rb"P\u00feX\ud8d4\udcd0\u0017\ud857\udead5\ud818\udd5f\u00fd,\ud922\udc8b d\uc3aa"
    rb'\u001e", "\u00e2QJ1", "\u00e7\ud9ca\udcd0\ud8ad\udd15Eo\uda3f\udc52", "", "'
    rb"\u0000\udb33\udf03Z\u00d6\u852d\u0004\udbb5\udebc\u00e3\r\u00ae\ud82f\udcb1"
    rb"\uda1f\udf08\u0083/y\udba2\udc05\uda04\udd90\u00a2p\u009a\u00dej\ud838\udcd8"
    rb"\ub1fd\u00da\udb17\udc0d\u00b5\u00e9\u00d6\"\u0018~\ud8cf\udfc0\u00cc\u00de"
    rb'\udbd5\udd93e\u00f4\udafc\ude0a", "\u008a\udb44\ude33qQ\u00b6\u00f8\u008ew'
    rb'\u00ba\u0094(\udaa9\udc84\ud861\ude26", "Q\udae6\udd9d\u00a8)\u00a9", "", "'
    rb'\u001d\rx\u00e9(\u0096", "\u00ef\u00efv\u00dc\u0080", "L\u00fb\u0092=\u0096'
    rb'\u00b0\u00ed\u00d4=\u0012\u00b2", "\u00df#H\u0089\u008f\ud9c6\udcff\u00b3", ""'
    rb', "\u00c8\u009c\u00da\ud9cc\ude64", "\ud95c\udf71H\udb5a\udf8e\u000b\uda18'
    rb'\udd80\udab5\udfcb\u00ce\u00e9\u00a3P\u0095\ud9ba\udf98\u00a0\ud932\udeea"], "'
    rb'start_date": "1766-02-05", "name": "\u008f", "milestone_notifications": true, '
    rb'"notification_frequency": "off"}'
)


async def _signup(client: AsyncClient, username: str) -> dict[str, str]:
    """Create an account and return its auth headers."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK, resp.text
    return {"Authorization": f"Bearer {resp.json()['token']}"}


def _entries(resp: Response) -> list[dict[str, object]]:
    """Return the ``detail`` list of a 422, asserting the response really is one.

    The ``isinstance`` check is load-bearing rather than defensive.  A handler
    answering a rejection with a bare string ``detail`` is a live failure mode
    on this application -- one endpoint already shipped that way and broke its
    own published response schema -- so the list shape is pinned here, once,
    for every rejection this file drives.
    """
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY, (
        f"expected a schema rejection, got {resp.status_code}: {resp.text}"
    )
    detail = resp.json()["detail"]
    assert isinstance(detail, list), (
        f"a 422 'detail' must be a list of entries, never a bare string: {resp.text}"
    )
    assert detail, f"the 422 carries an empty 'detail' list: {resp.text}"
    return detail


def _assert_rejected_as(resp: Response, error_type: str, loc: list[object]) -> None:
    """Assert the 422 carries an entry of ``error_type`` located at ``loc``.

    Searched rather than indexed, because a body carrying several problems may
    legitimately be rejected for more than one of them; what matters is that
    the one under test is among them and is named precisely.
    """
    entries = _entries(resp)
    assert any(entry.get("type") == error_type and entry.get("loc") == loc for entry in entries), (
        f"no entry rejected {loc!r} as {error_type!r}; a 422 from some other "
        f"cause does not prove this value was refused: {entries!r}"
    )


def _assert_nothing_echoed(resp: Response) -> None:
    """Assert the response repeats neither the NUL nor its JSON escape."""
    assert _NUL not in resp.text, "the response carries the offending code point verbatim"
    assert _NUL_JSON_ESCAPE not in resp.text, (
        "the response carries the offending code point as a JSON escape"
    )


@pytest.mark.asyncio
async def test_explicit_null_ring_toggle_is_refused_before_the_column(
    async_client: AsyncClient,
) -> None:
    """The recorded PATCH must be refused at ``enable_practices``, not by the driver.

    Before the fix this is a 500: the null passes validation, is reported as
    set, and hits ``NOT NULL constraint failed:
    userdepthpreferences.enable_practices``.
    """
    headers = await _signup(async_client, "recorded-depth")

    resp = await async_client.patch(
        _PREFS_URL,
        content=_RECORDED_DEPTH_PREFERENCES_BODY,
        headers={**_JSON_HEADERS, **headers},
    )

    _assert_rejected_as(resp, _NOT_A_BOOLEAN, ["body", "enable_practices"])


@pytest.mark.asyncio
async def test_a_ring_toggle_the_caller_actually_set_is_still_applied(
    async_client: AsyncClient,
) -> None:
    """An ordinary PATCH must still store the value and leave the other rings alone.

    The companion that makes the rejection above mean something: without it a
    422 could equally come from a route that stopped accepting anything.
    """
    headers = await _signup(async_client, "plain-depth")

    resp = await async_client.patch(_PREFS_URL, json={"enable_practices": False}, headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()
    assert body["enable_practices"] is False
    assert body["enable_course"] is True


@pytest.mark.asyncio
async def test_explicit_null_ui_flag_is_refused_before_the_column(
    async_client: AsyncClient,
) -> None:
    """The copy-pasted twin must reject a null flag exactly as its sibling does.

    No fuzz run ever reached this route; the defect is here because the code
    is.  Before the fix this is a 500 on ``NOT NULL constraint failed:
    useruiflags.has_seen_welcome``.
    """
    headers = await _signup(async_client, "null-ui-flag")

    resp = await async_client.patch(
        _UI_FLAGS_URL,
        json={"has_seen_welcome": None, "energy_scaffolding_archived": True},
        headers=headers,
    )

    _assert_rejected_as(resp, _NOT_A_BOOLEAN, ["body", "has_seen_welcome"])


@pytest.mark.asyncio
async def test_a_ui_flag_the_caller_actually_set_is_still_applied(
    async_client: AsyncClient,
) -> None:
    """An ordinary PATCH must still store the flag and leave its sibling alone."""
    headers = await _signup(async_client, "plain-ui-flag")

    resp = await async_client.patch(_UI_FLAGS_URL, json={"has_seen_welcome": True}, headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()
    assert body["has_seen_welcome"] is True
    assert body["energy_scaffolding_archived"] is False


@pytest.mark.asyncio
async def test_a_nul_in_notification_days_is_refused_rather_than_written(
    async_client: AsyncClient,
) -> None:
    """The recorded body, made storable in every other respect, must still be refused.

    Before the fix this answers **200** here and 500 on PostgreSQL -- SQLite
    stores the NUL, so the only honest way to read a pre-fix run of this test
    is as "the habit was created", not "the server survived".
    """
    headers = await _signup(async_client, "nul-habit")

    resp = await async_client.post(
        _HABITS_URL,
        content=_RECORDED_HABIT_BODY,
        headers={**_JSON_HEADERS, **headers},
    )

    _assert_rejected_as(resp, _UNSTORABLE_TEXT, ["body", "notification_days"])


@pytest.mark.asyncio
async def test_a_refused_nul_leaves_no_habit_behind(async_client: AsyncClient) -> None:
    """A rejected habit must not be half-created, and must not be echoed back.

    Separated from the assertion on the rejection's shape because these are two
    different promises: one is that the caller is told what was wrong, the
    other is that nothing was written and nothing was repeated.
    """
    headers = await _signup(async_client, "nul-habit-state")

    resp = await async_client.post(
        _HABITS_URL,
        content=_RECORDED_HABIT_BODY,
        headers={**_JSON_HEADERS, **headers},
    )
    _assert_nothing_echoed(resp)

    listed = await async_client.get(_HABITS_URL, headers=headers)
    assert listed.status_code == HTTPStatus.OK, listed.text
    assert listed.json() == [], "the refused habit was persisted anyway"


@pytest.mark.asyncio
async def test_an_ordinary_habit_is_still_created(async_client: AsyncClient) -> None:
    """Plain notification days must still be stored verbatim.

    The companion for the guard: a check that refuses everything would satisfy
    every rejection assertion in this file and nothing else.
    """
    headers = await _signup(async_client, "plain-habit")

    resp = await async_client.post(_HABITS_URL, json=_PLAIN_HABIT, headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert resp.json()["notification_days"] == ["mon", "wed"]
