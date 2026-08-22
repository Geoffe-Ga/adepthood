"""Tests for the weekly reflection prompts API."""

from __future__ import annotations

import asyncio
from http import HTTPStatus

import pytest
from httpx import AsyncClient

from domain import weekly_prompts
from domain.journal_prompt_parser import JournalPrompt

# Beige is the floor of the curriculum with three prompts. Blue is a
# four-prompt stage whose cadences are not all the same, which is what makes
# it the stage worth asserting cadence against; it opens in week 10.
_BEIGE_PROMPT_COUNT = 3
_BLUE_PROMPT_COUNT = 4
_BLUE_STAGE_NUMBER = 4
_BLUE_FIRST_WEEK = 10


async def _signup(client: AsyncClient, username: str = "alice") -> dict[str, str]:
    """Create a user and return auth headers."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    token = resp.json()["token"]
    return {"Authorization": f"Bearer {token}"}


# ── Unauthenticated access ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_unauthenticated_current_returns_401(async_client: AsyncClient) -> None:
    resp = await async_client.get("/prompts/current")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_unauthenticated_history_returns_401(async_client: AsyncClient) -> None:
    resp = await async_client.get("/prompts/history")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_unauthenticated_respond_returns_401(async_client: AsyncClient) -> None:
    resp = await async_client.post("/prompts/1/respond", json={"response": "a thoughtful answer"})
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


# ── GET /prompts/current ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_current_prompt_returns_week_1_for_new_user(
    async_client: AsyncClient,
) -> None:
    headers = await _signup(async_client)
    resp = await async_client.get("/prompts/current", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["week_number"] == 1
    assert data["has_responded"] is False
    assert data["question"] is not None
    assert len(data["question"]) > 0
    assert data["response"] is None


@pytest.mark.asyncio
async def test_get_current_prompt_advances_after_submit(
    async_client: AsyncClient,
) -> None:
    """After responding to week 1, current prompt advances to week 2 (BUG-JOURNAL-014)."""
    headers = await _signup(async_client)
    # Submit a response for week 1
    await async_client.post(
        "/prompts/1/respond",
        json={"response": "I feel grounded today."},
        headers=headers,
    )
    resp = await async_client.get("/prompts/current", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    # Week advances to 2 after completing week 1
    assert data["week_number"] == 2
    assert data["has_responded"] is False


# ── GET /prompts/{week_number} ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_prompt_by_week(async_client: AsyncClient) -> None:
    """A user who has reached week 5 can fetch it (BUG-PROMPT-002 allow case)."""
    headers = await _signup(async_client)
    # Advance to week 5 by responding to weeks 1..4.
    for week in range(1, 5):
        resp_w = await async_client.post(
            f"/prompts/{week}/respond",
            json={"response": f"Week {week} answer"},
            headers=headers,
        )
        assert resp_w.status_code == HTTPStatus.CREATED
    resp = await async_client.get("/prompts/5", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["week_number"] == 5
    assert data["has_responded"] is False
    assert data["question"] is not None


@pytest.mark.asyncio
async def test_get_prompt_invalid_week_returns_404(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.get("/prompts/99", headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_get_prompt_week_zero_returns_404(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.get("/prompts/0", headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND


# ── POST /prompts/{week_number}/respond ─────────────────────────────────


@pytest.mark.asyncio
async def test_submit_prompt_response(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.post(
        "/prompts/1/respond",
        json={"response": "Safety means having a stable home."},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED
    data = resp.json()
    assert data["week_number"] == 1
    assert data["has_responded"] is True
    assert data["response"] == "Safety means having a stable home."
    assert data["timestamp"] is not None


@pytest.mark.asyncio
async def test_submit_duplicate_response_returns_409(async_client: AsyncClient) -> None:
    """BUG-PROMPT-004: every duplicate submission must surface the same 409.

    The earlier handler split into a 400 fast path (pre-check matched)
    and a 409 race path (constraint fired).  Clients had to handle both
    codes for one semantic condition.  The pre-check is gone and the
    ``uq_promptresponse_user_week`` constraint is the single source of
    truth for "already responded."
    """
    headers = await _signup(async_client)
    await async_client.post(
        "/prompts/1/respond",
        json={"response": "First response."},
        headers=headers,
    )
    resp = await async_client.post(
        "/prompts/1/respond",
        json={"response": "Second response."},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CONFLICT
    assert resp.json()["detail"] == "already_responded"


@pytest.mark.asyncio
async def test_submit_response_invalid_week_returns_404(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.post(
        "/prompts/99/respond",
        json={"response": "a thoughtful response"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.NOT_FOUND


# ── BUG-PROMPT-001 / BUG-PROMPT-002: weekly unlock gate ─────────────────


@pytest.mark.asyncio
async def test_get_future_week_is_forbidden(async_client: AsyncClient) -> None:
    """BUG-PROMPT-002: GET /prompts/{week} must 403 for weeks past user_week.

    Without the gate a week-1 user could enumerate /prompts/1..36 and lift
    every future question.  The curriculum is supposed to unlock one week
    at a time as responses are submitted.
    """
    headers = await _signup(async_client)
    resp = await async_client.get("/prompts/36", headers=headers)
    assert resp.status_code == HTTPStatus.FORBIDDEN
    assert resp.json()["detail"] == "week_locked"


@pytest.mark.asyncio
async def test_submit_future_week_is_forbidden(async_client: AsyncClient) -> None:
    """BUG-PROMPT-001: POST to a future week must 403 before writing.

    Under the old max(week)+1 derivation, one POST to /prompts/36/respond
    would set the user's current_week to 36 on the next read, voiding the
    entire 36-week pacing in a single request.
    """
    headers = await _signup(async_client)
    resp = await async_client.post(
        "/prompts/36/respond",
        json={"response": "skip-ahead attempt"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.FORBIDDEN
    assert resp.json()["detail"] == "week_locked"


@pytest.mark.asyncio
async def test_current_week_derives_from_response_count_not_max(
    async_client: AsyncClient,
) -> None:
    """BUG-PROMPT-001: user_week is ``count + 1``, never ``max + 1``.

    The skip-ahead POST from ``test_submit_future_week_is_forbidden`` would,
    under the old derivation, have left this user at week 37→clamped-to-36.
    With count-based derivation a blocked future submit doesn't count, so
    the user remains at week 1 — the intended behaviour.
    """
    headers = await _signup(async_client)
    # Submit a response for week 1 successfully.
    resp1 = await async_client.post(
        "/prompts/1/respond",
        json={"response": "Grounding feels like home."},
        headers=headers,
    )
    assert resp1.status_code == HTTPStatus.CREATED

    # Attempt a future week — must fail and NOT be persisted.
    resp_skip = await async_client.post(
        "/prompts/10/respond",
        json={"response": "sneaky attempt to skip"},
        headers=headers,
    )
    assert resp_skip.status_code == HTTPStatus.FORBIDDEN

    # Current should be week 2 (count=1, next=2), not week 11.
    resp_current = await async_client.get("/prompts/current", headers=headers)
    assert resp_current.status_code == HTTPStatus.OK
    assert resp_current.json()["week_number"] == 2


@pytest.mark.asyncio
async def test_submit_response_creates_journal_entry(async_client: AsyncClient) -> None:
    """Submitting a prompt response creates a journal entry tagged ``weekly_prompt``."""
    headers = await _signup(async_client)
    await async_client.post(
        "/prompts/1/respond",
        json={"response": "I reflected on grounding."},
        headers=headers,
    )

    journal_resp = await async_client.get("/journal/", headers=headers)
    assert journal_resp.status_code == HTTPStatus.OK
    journal_data = journal_resp.json()
    assert journal_data["total"] == 1
    entry = journal_data["items"][0]
    assert entry["message"] == "I reflected on grounding."
    assert entry["tag"] == "weekly_prompt"
    assert entry["sender"] == "user"


# ── Prompt title (mirrored to the JournalEntry) ─────────────────────────


@pytest.mark.asyncio
async def test_submit_without_title_uses_band_default(async_client: AsyncClient) -> None:
    headers = await _signup(async_client, "title_default")
    await async_client.post(
        "/prompts/1/respond",
        json={"response": "Safety means having a stable home."},
        headers=headers,
    )
    journal_resp = await async_client.get("/journal/", headers=headers)
    entry = journal_resp.json()["items"][0]
    assert entry["title"] == "Beige week 1 Prompt #1"


@pytest.mark.asyncio
async def test_submit_with_title_override_is_persisted(async_client: AsyncClient) -> None:
    headers = await _signup(async_client, "title_override")
    await async_client.post(
        "/prompts/1/respond",
        json={
            "response": "Safety means having a stable home.",
            "title": "Reclaiming my anger",
        },
        headers=headers,
    )
    journal_resp = await async_client.get("/journal/", headers=headers)
    entry = journal_resp.json()["items"][0]
    assert entry["title"] == "Reclaiming my anger"


@pytest.mark.asyncio
async def test_submit_with_whitespace_only_title_falls_back_to_default(
    async_client: AsyncClient,
) -> None:
    headers = await _signup(async_client, "title_whitespace")
    await async_client.post(
        "/prompts/1/respond",
        json={"response": "Safety means having a stable home.", "title": "   "},
        headers=headers,
    )
    journal_resp = await async_client.get("/journal/", headers=headers)
    entry = journal_resp.json()["items"][0]
    assert entry["title"] == "Beige week 1 Prompt #1"


@pytest.mark.asyncio
async def test_submit_title_is_sanitized(async_client: AsyncClient) -> None:
    """A zero-width space embedded in the title is stripped by ``sanitize_user_text``."""
    headers = await _signup(async_client, "title_zerowidth")
    dirty_title = "Anger" + chr(0x200B)
    await async_client.post(
        "/prompts/1/respond",
        json={"response": "Safety means having a stable home.", "title": dirty_title},
        headers=headers,
    )
    journal_resp = await async_client.get("/journal/", headers=headers)
    entry = journal_resp.json()["items"][0]
    assert entry["title"] == "Anger"


@pytest.mark.asyncio
async def test_submit_zero_width_only_title_falls_back_to_default(
    async_client: AsyncClient,
) -> None:
    """A title of only zero-width chars sanitizes to empty and must not persist blank."""
    headers = await _signup(async_client, "title_all_zerowidth")
    await async_client.post(
        "/prompts/1/respond",
        json={"response": "Safety means having a stable home.", "title": chr(0x200B) * 3},
        headers=headers,
    )
    journal_resp = await async_client.get("/journal/", headers=headers)
    entry = journal_resp.json()["items"][0]
    assert entry["title"] == "Beige week 1 Prompt #1"


@pytest.mark.asyncio
async def test_submit_title_over_max_length_returns_422(async_client: AsyncClient) -> None:
    headers = await _signup(async_client, "title_toolong")
    resp = await async_client.post(
        "/prompts/1/respond",
        json={"response": "Safety means having a stable home.", "title": "x" * 201},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


# ── GET /prompts/history ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_prompt_history_empty_for_new_user(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.get("/prompts/history", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["total"] == 0
    assert data["items"] == []
    assert data["has_more"] is False


@pytest.mark.asyncio
async def test_prompt_history_returns_responses(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    # Submit responses for weeks 1 and 2
    await async_client.post(
        "/prompts/1/respond", json={"response": "Week 1 answer"}, headers=headers
    )
    await async_client.post(
        "/prompts/2/respond", json={"response": "Week 2 answer"}, headers=headers
    )

    resp = await async_client.get("/prompts/history", headers=headers)
    data = resp.json()
    assert data["total"] == 2
    # Newest week first
    assert data["items"][0]["week_number"] == 2
    assert data["items"][1]["week_number"] == 1


@pytest.mark.asyncio
async def test_prompt_history_pagination(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    for week in range(1, 6):
        await async_client.post(
            f"/prompts/{week}/respond",
            json={"response": f"Week {week} answer"},
            headers=headers,
        )

    resp = await async_client.get("/prompts/history?limit=2&offset=0", headers=headers)
    data = resp.json()
    assert len(data["items"]) == 2
    assert data["total"] == 5
    assert data["has_more"] is True

    resp2 = await async_client.get("/prompts/history?limit=2&offset=4", headers=headers)
    data2 = resp2.json()
    assert len(data2["items"]) == 1
    assert data2["has_more"] is False


# ── User isolation ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_user_cannot_see_other_users_responses(async_client: AsyncClient) -> None:
    alice_headers = await _signup(async_client, "alice")
    bob_headers = await _signup(async_client, "bob")

    await async_client.post(
        "/prompts/1/respond",
        json={"response": "Alice's reflection"},
        headers=alice_headers,
    )

    # Bob should not see Alice's response
    resp = await async_client.get("/prompts/1", headers=bob_headers)
    assert resp.json()["has_responded"] is False

    resp_history = await async_client.get("/prompts/history", headers=bob_headers)
    assert resp_history.json()["total"] == 0


@pytest.mark.asyncio
async def test_both_users_can_respond_to_same_week(async_client: AsyncClient) -> None:
    alice_headers = await _signup(async_client, "alice")
    bob_headers = await _signup(async_client, "bob")

    resp_a = await async_client.post(
        "/prompts/1/respond",
        json={"response": "Alice's answer"},
        headers=alice_headers,
    )
    resp_b = await async_client.post(
        "/prompts/1/respond",
        json={"response": "Bob's answer"},
        headers=bob_headers,
    )
    assert resp_a.status_code == HTTPStatus.CREATED
    assert resp_b.status_code == HTTPStatus.CREATED


# ── Concurrency (BUG-JOURNAL-003) ─────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.usefixtures("disable_rate_limit")
async def test_concurrent_prompt_responses_allow_exactly_one(
    concurrent_async_client: AsyncClient,
) -> None:
    """Only one of N concurrent prompt submissions for the same (user, week) wins."""
    headers = await _signup(concurrent_async_client)

    responses = await asyncio.gather(
        *[
            concurrent_async_client.post(
                "/prompts/1/respond",
                json={"response": f"A meaningful attempt #{i}"},
                headers=headers,
            )
            for i in range(5)
        ]
    )

    status_codes = [r.status_code for r in responses]
    successes = status_codes.count(HTTPStatus.CREATED)
    # With the pre-check gone the constraint is the only rejector; every
    # loser hits exactly 409 (BUG-PROMPT-004).
    rejections = status_codes.count(HTTPStatus.CONFLICT)

    assert successes == 1, f"Expected exactly 1 success, got {successes}"
    assert rejections == 4, f"Expected 4 conflicts, got {rejections}"


@pytest.mark.asyncio
async def test_response_rejects_whitespace_only(async_client: AsyncClient) -> None:
    """A whitespace-only response is rejected at the schema layer."""
    headers = await _signup(async_client)
    resp = await async_client.post(
        "/prompts/1/respond",
        json={"response": "   "},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_response_rejects_short_answer(async_client: AsyncClient) -> None:
    """A short stripped response (< threshold) is rejected."""
    headers = await _signup(async_client)
    resp = await async_client.post(
        "/prompts/1/respond",
        json={"response": "ok."},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_response_rejects_at_threshold_minus_one(async_client: AsyncClient) -> None:
    """Boundary: 9 stripped chars is below the 10-char threshold and is rejected."""
    headers = await _signup(async_client)
    resp = await async_client.post(
        "/prompts/1/respond",
        json={"response": "  abcdefghi  "},  # strip()-> 9 chars
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_response_accepts_at_threshold(async_client: AsyncClient) -> None:
    """Boundary: 10 stripped chars meets the threshold and is accepted."""
    headers = await _signup(async_client)
    resp = await async_client.post(
        "/prompts/1/respond",
        json={"response": "  abcdefghij  "},  # strip()-> 10 chars
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED


@pytest.mark.asyncio
async def test_history_offset_is_capped(async_client: AsyncClient) -> None:
    """Out-of-range ``offset`` is rejected at the schema layer."""
    headers = await _signup(async_client)
    resp = await async_client.get("/prompts/history?offset=1000000000&limit=1", headers=headers)
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_history_skips_count_when_total_disabled(async_client: AsyncClient) -> None:
    """``include_total=false`` returns ``total=None`` (opt-out) and skips the count subquery."""
    headers = await _signup(async_client)
    await async_client.post(
        "/prompts/1/respond",
        json={"response": "A meaningful first reflection."},
        headers=headers,
    )
    resp = await async_client.get("/prompts/history?include_total=false", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["total"] is None  # opt-out sentinel; ``has_more`` drives pagination
    assert len(body["items"]) == 1


@pytest.mark.asyncio
async def test_history_cursor_has_more_false_when_no_more_items(
    async_client: AsyncClient,
) -> None:
    """Cursor mode reports ``has_more=False`` on the last real page.

    Submit one response, then page with ``limit=1&offset=1`` -- the
    peek pattern (``limit + 1`` fetch) returns zero rows, so the
    response correctly says no more pages exist even though
    ``offset + limit < TOTAL_WEEKS``.
    """
    headers = await _signup(async_client)
    await async_client.post(
        "/prompts/1/respond",
        json={"response": "A meaningful first reflection."},
        headers=headers,
    )
    resp = await async_client.get(
        "/prompts/history?include_total=false&limit=1&offset=1",
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["items"] == []
    assert body["has_more"] is False


@pytest.mark.asyncio
async def test_history_cursor_has_more_true_when_more_remain(
    async_client: AsyncClient,
) -> None:
    """Cursor mode reports ``has_more=True`` when a peek row materialises."""
    headers = await _signup(async_client)
    for week in range(1, 4):
        resp = await async_client.post(
            f"/prompts/{week}/respond",
            json={"response": f"Week {week} reflection text."},
            headers=headers,
        )
        assert resp.status_code == HTTPStatus.CREATED

    resp = await async_client.get(
        "/prompts/history?include_total=false&limit=1&offset=0",
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert len(body["items"]) == 1
    assert body["has_more"] is True


@pytest.mark.asyncio
async def test_history_total_aware_has_more_false_at_boundary(
    async_client: AsyncClient,
) -> None:
    """Count-aware mode reports ``has_more=False`` when ``offset + limit == total``.

    Pins the strict-less-than comparison in the count-aware branch so a
    future ``<=`` regression would fail this test instead of inflating
    ``has_more`` for clients that have read every row.
    """
    headers = await _signup(async_client)
    for week in range(1, 4):
        resp = await async_client.post(
            f"/prompts/{week}/respond",
            json={"response": f"Week {week} reflection text."},
            headers=headers,
        )
        assert resp.status_code == HTTPStatus.CREATED

    resp = await async_client.get(
        "/prompts/history?include_total=true&limit=3&offset=0",
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["total"] == 3
    assert len(body["items"]) == 3
    assert body["has_more"] is False


@pytest.mark.asyncio
async def test_history_question_uses_live_curriculum(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The persisted ``question`` snapshot is overridden by the live content.

    Submit a response, then swap the parsed prompt list the week resolves
    through -- history must re-read it rather than echo the snapshot it stored
    at submit time, so a content sync reaches old rows too.
    """
    headers = await _signup(async_client)
    await async_client.post(
        "/prompts/1/respond",
        json={"response": "A meaningful first reflection."},
        headers=headers,
    )

    revised = (JournalPrompt(ordinal=1, title="REVISED prompt for week 1.", body=""),)
    monkeypatch.setattr(weekly_prompts, "prompts_for_color", lambda _colour: revised)
    resp = await async_client.get("/prompts/history", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["items"][0]["question"] == "REVISED prompt for week 1."


# ── GET /prompts/stage/{stage_number} ───────────────────────────────────


async def _advance_to_week(client: AsyncClient, headers: dict[str, str], week: int) -> None:
    """Answer weeks 1..``week - 1`` so the user's current week becomes ``week``."""
    for earlier in range(1, week):
        resp = await client.post(
            f"/prompts/{earlier}/respond",
            json={"response": f"Week {earlier} reflection text."},
            headers=headers,
        )
        assert resp.status_code == HTTPStatus.CREATED


@pytest.mark.asyncio
async def test_unauthenticated_stage_returns_401(async_client: AsyncClient) -> None:
    resp = await async_client.get("/prompts/stage/1")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_stage_prompts_returns_every_prompt_beige_carries(
    async_client: AsyncClient,
) -> None:
    """Beige ships three prompts, and all three are addressable from week 1."""
    headers = await _signup(async_client, "stage_beige")
    resp = await async_client.get("/prompts/stage/1", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["stage"] == 1
    assert body["stage_name"] == "Beige"
    assert [p["ordinal"] for p in body["prompts"]] == [1, 2, _BEIGE_PROMPT_COUNT]
    assert all(p["title"].strip() for p in body["prompts"])


@pytest.mark.asyncio
@pytest.mark.usefixtures("disable_rate_limit")
async def test_stage_prompts_returns_four_prompts_each_with_its_cadence(
    async_client: AsyncClient,
) -> None:
    """Blue is a four-prompt stage, and its prompts do not share one rhythm.

    A single question per week cannot say that Blue's fourth prompt is written
    half as often as its first; four prompts each carrying their own cadence
    can, which is the whole point of the stage-scoped read.
    """
    headers = await _signup(async_client, "stage_blue")
    await _advance_to_week(async_client, headers, _BLUE_FIRST_WEEK)

    resp = await async_client.get(f"/prompts/stage/{_BLUE_STAGE_NUMBER}", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["stage_name"] == "Blue"
    assert len(body["prompts"]) == _BLUE_PROMPT_COUNT
    cadences = [p["cadence"] for p in body["prompts"]]
    assert all(cadences)
    assert len(set(cadences)) > 1


@pytest.mark.asyncio
async def test_stage_prompts_of_a_locked_stage_is_forbidden(async_client: AsyncClient) -> None:
    """Exposing four prompts per stage must not leak the stages still locked."""
    headers = await _signup(async_client, "stage_locked")
    resp = await async_client.get("/prompts/stage/10", headers=headers)

    assert resp.status_code == HTTPStatus.FORBIDDEN
    assert resp.json()["detail"] == "week_locked"


@pytest.mark.asyncio
@pytest.mark.parametrize("stage_number", [0, 11])
async def test_stage_prompts_out_of_range_returns_404(
    async_client: AsyncClient, stage_number: int
) -> None:
    """There are ten positions; an eleventh is an ontology change, not a lookup.

    The detail is asserted, not just the status: an unrouted path 404s too, so
    without it this would pass against an endpoint that does not exist.
    """
    headers = await _signup(async_client, f"stage_range_{stage_number}")
    resp = await async_client.get(f"/prompts/stage/{stage_number}", headers=headers)

    assert resp.status_code == HTTPStatus.NOT_FOUND
    assert resp.json()["detail"] == "stage_not_found"


# ── Addressing a specific prompt on POST ────────────────────────────────


@pytest.mark.asyncio
async def test_submit_with_prompt_ordinal_records_that_prompt(
    async_client: AsyncClient,
) -> None:
    """A week's response identifies which of its stage's prompts it answers."""
    headers = await _signup(async_client, "ordinal_pick")
    resp = await async_client.post(
        "/prompts/1/respond",
        json={"response": "Answering the third one.", "prompt_ordinal": _BEIGE_PROMPT_COUNT},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.CREATED
    body = resp.json()
    assert body["prompt_ordinal"] == _BEIGE_PROMPT_COUNT
    assert body["question"] == weekly_prompts.get_prompt_for_week(1, ordinal=_BEIGE_PROMPT_COUNT)

    journal_resp = await async_client.get("/journal/", headers=headers)
    entry = journal_resp.json()["items"][0]
    assert entry["title"] == f"Beige week 1 Prompt #{_BEIGE_PROMPT_COUNT}"


@pytest.mark.asyncio
async def test_submit_with_ordinal_beyond_the_stage_returns_404(
    async_client: AsyncClient,
) -> None:
    """Beige carries three prompts, so its fourth is not a prompt that exists."""
    headers = await _signup(async_client, "ordinal_over")
    resp = await async_client.post(
        "/prompts/1/respond",
        json={"response": "No such prompt here.", "prompt_ordinal": _BEIGE_PROMPT_COUNT + 1},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_submit_with_zero_ordinal_returns_422(async_client: AsyncClient) -> None:
    """Ordinals are 1-based; zero is rejected at the schema layer."""
    headers = await _signup(async_client, "ordinal_zero")
    resp = await async_client.post(
        "/prompts/1/respond",
        json={"response": "Ordinals start at one.", "prompt_ordinal": 0},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_reading_a_week_reflects_the_ordinal_that_was_answered(
    async_client: AsyncClient,
) -> None:
    """The read path re-resolves the prompt the row answered, not the week's default."""
    headers = await _signup(async_client, "ordinal_read")
    await async_client.post(
        "/prompts/1/respond",
        json={"response": "Answering the second one.", "prompt_ordinal": 2},
        headers=headers,
    )

    resp = await async_client.get("/prompts/1", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["prompt_ordinal"] == 2
    assert body["question"] == weekly_prompts.get_prompt_for_week(1, ordinal=2)
    assert body["default_title"] == "Beige week 1 Prompt #2"


# ── Default journal title, served rather than mirrored client-side ──────


@pytest.mark.asyncio
async def test_current_prompt_carries_the_servers_default_title(
    async_client: AsyncClient,
) -> None:
    """The compose default comes from the server so no client mirrors the band table."""
    headers = await _signup(async_client, "default_title")
    resp = await async_client.get("/prompts/current", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["default_title"] == "Beige week 1 Prompt #1"


@pytest.mark.asyncio
async def test_history_carries_the_default_title(async_client: AsyncClient) -> None:
    headers = await _signup(async_client, "history_title")
    await async_client.post(
        "/prompts/1/respond",
        json={"response": "A meaningful first reflection."},
        headers=headers,
    )

    resp = await async_client.get("/prompts/history", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["items"][0]["default_title"] == "Beige week 1 Prompt #1"


@pytest.mark.asyncio
async def test_history_falls_back_to_the_weeks_prompt_when_the_stage_shrinks(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A content sync that drops prompts must not blank the entries that used them.

    Answer Beige's third prompt, then swap the parsed list for a one-prompt
    stage. The stored ordinal no longer resolves, so the row falls back to the
    prompt its week draws rather than losing its question — while still
    reporting the ordinal it was actually written against.
    """
    headers = await _signup(async_client, "stage_shrank")
    await async_client.post(
        "/prompts/1/respond",
        json={"response": "Answering the third one.", "prompt_ordinal": _BEIGE_PROMPT_COUNT},
        headers=headers,
    )

    shrunk = (JournalPrompt(ordinal=1, title="The only prompt left.", body=""),)
    monkeypatch.setattr(weekly_prompts, "prompts_for_color", lambda _colour: shrunk)
    resp = await async_client.get("/prompts/history", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    item = resp.json()["items"][0]
    assert item["question"] == "The only prompt left."
    assert item["prompt_ordinal"] == _BEIGE_PROMPT_COUNT
    assert item["default_title"] == "Beige week 1 Prompt #1"


@pytest.mark.asyncio
async def test_history_falls_back_to_its_snapshot_for_a_retired_week(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A week the curriculum no longer has still reads back the question it stored.

    Shortening the program is the one case where live content cannot answer at
    all, and the stored snapshot is the only thing standing between an old
    entry and an empty prompt.
    """
    headers = await _signup(async_client, "retired_week")
    await async_client.post(
        "/prompts/1/respond",
        json={"response": "A meaningful first reflection."},
        headers=headers,
    )

    monkeypatch.setattr(weekly_prompts, "TOTAL_WEEKS", 0)
    resp = await async_client.get("/prompts/history", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    item = resp.json()["items"][0]
    assert item["question"].startswith("List the systemic, social, and cultural influences")
    assert item["default_title"] is None
