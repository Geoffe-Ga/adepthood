"""Tests for GET /ui-flags and PATCH /ui-flags."""

from __future__ import annotations

from http import HTTPStatus

import pytest
from httpx import AsyncClient

_FLAGS_URL = "/ui-flags"

# Both flag keys the response must carry.
_FLAG_KEYS = ("has_seen_welcome", "energy_scaffolding_archived")


async def _signup(client: AsyncClient, username: str = "uiflagsuser") -> dict[str, str]:
    """Create an account and return auth headers."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    token = resp.json()["token"]
    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------------------
# GET — auto-provision
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_auto_provisions_defaults(async_client: AsyncClient) -> None:
    """Fresh user with no flags row gets 200 with both flags false."""
    headers = await _signup(async_client)

    resp = await async_client.get(_FLAGS_URL, headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    for key in _FLAG_KEYS:
        assert body[key] is False, f"expected {key}=False, got {body[key]}"


@pytest.mark.asyncio
async def test_get_is_idempotent(async_client: AsyncClient) -> None:
    """Calling GET twice returns identical all-false state (no duplicate/error)."""
    headers = await _signup(async_client, "idem_flags")

    first = await async_client.get(_FLAGS_URL, headers=headers)
    second = await async_client.get(_FLAGS_URL, headers=headers)

    assert first.status_code == HTTPStatus.OK
    assert second.status_code == HTTPStatus.OK
    assert first.json() == second.json()
    for key in _FLAG_KEYS:
        assert second.json()[key] is False


# ---------------------------------------------------------------------------
# PATCH — partial update
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_patch_toggles_one_flag(async_client: AsyncClient) -> None:
    """PATCH with one key flips that flag and leaves the other false."""
    headers = await _signup(async_client, "one_flag")

    resp = await async_client.patch(
        _FLAGS_URL,
        json={"has_seen_welcome": True},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["has_seen_welcome"] is True
    assert body["energy_scaffolding_archived"] is False


@pytest.mark.asyncio
async def test_patch_partial_preserves_previous(async_client: AsyncClient) -> None:
    """Second PATCH keeps the first flag true; both flags end up true."""
    headers = await _signup(async_client, "two_patch_flags")

    first_patch = await async_client.patch(
        _FLAGS_URL,
        json={"has_seen_welcome": True},
        headers=headers,
    )
    assert first_patch.status_code == HTTPStatus.OK

    second_patch = await async_client.patch(
        _FLAGS_URL,
        json={"energy_scaffolding_archived": True},
        headers=headers,
    )

    assert second_patch.status_code == HTTPStatus.OK
    body = second_patch.json()
    assert body["has_seen_welcome"] is True
    assert body["energy_scaffolding_archived"] is True


@pytest.mark.asyncio
async def test_patch_returns_both_keys(async_client: AsyncClient) -> None:
    """PATCH response always includes both flag booleans."""
    headers = await _signup(async_client, "full_resp_flags")

    resp = await async_client.patch(
        _FLAGS_URL,
        json={"has_seen_welcome": True},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    for key in _FLAG_KEYS:
        assert key in body, f"response missing key '{key}'"
        assert isinstance(body[key], bool), f"expected bool for '{key}', got {type(body[key])}"


# ---------------------------------------------------------------------------
# Auth required
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_requires_auth(async_client: AsyncClient) -> None:
    """GET without a token returns 401."""
    resp = await async_client.get(_FLAGS_URL)

    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_get_invalid_token_returns_401(async_client: AsyncClient) -> None:
    """GET with a malformed token returns 401."""
    resp = await async_client.get(
        _FLAGS_URL,
        headers={"Authorization": "Bearer not.a.valid.token"},
    )

    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_patch_requires_auth(async_client: AsyncClient) -> None:
    """PATCH without a token returns 401."""
    resp = await async_client.patch(_FLAGS_URL, json={"has_seen_welcome": True})

    assert resp.status_code == HTTPStatus.UNAUTHORIZED


# ---------------------------------------------------------------------------
# Caller-only isolation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_patch_does_not_affect_other_user(async_client: AsyncClient) -> None:
    """Toggling one user's flag leaves another user's flags all-false."""
    alice_headers = await _signup(async_client, "alice_flags")
    bob_headers = await _signup(async_client, "bob_flags")

    # Alice marks the welcome flag seen.
    patch = await async_client.patch(
        _FLAGS_URL,
        json={"has_seen_welcome": True},
        headers=alice_headers,
    )
    assert patch.status_code == HTTPStatus.OK
    assert patch.json()["has_seen_welcome"] is True

    # Bob's flags are untouched; no user_id in the request body.
    bob_resp = await async_client.get(_FLAGS_URL, headers=bob_headers)
    assert bob_resp.status_code == HTTPStatus.OK
    for key in _FLAG_KEYS:
        assert bob_resp.json()[key] is False, f"Bob's {key} was mutated by Alice's PATCH"

    # Alice's state is her own; re-GET confirms persistence.
    alice_resp = await async_client.get(_FLAGS_URL, headers=alice_headers)
    assert alice_resp.json()["has_seen_welcome"] is True


# ---------------------------------------------------------------------------
# Empty-body rejection (mirrors JournalEntryUpdate at-least-one guard)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_patch_empty_body_returns_422(async_client: AsyncClient) -> None:
    """PATCH with no fields set is rejected so a no-op cannot reach the DB."""
    headers = await _signup(async_client, "empty_flags")

    resp = await async_client.patch(_FLAGS_URL, json={}, headers=headers)

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


# ---------------------------------------------------------------------------
# writing_session_habit_id — the habit a finished writing session checks off
# ---------------------------------------------------------------------------

_LINK_KEY = "writing_session_habit_id"

# An id no seeded row can carry, so the missing-row branch is exercised.
_MISSING_HABIT_ID = 999_999

# One past the int32 ceiling every row-id field is bounded by.
_PAST_INT32_MAX = 2**31


async def _create_habit(client: AsyncClient, headers: dict[str, str], name: str) -> int:
    """Create a habit the caller owns and return its id."""
    resp = await client.post(
        "/habits/",
        json={
            "name": name,
            "icon": "✍️",
            "start_date": "2024-01-01",
            "energy_cost": 1,
            "energy_return": 2,
        },
        headers=headers,
    )
    assert resp.status_code in {HTTPStatus.OK, HTTPStatus.CREATED}, resp.text
    return int(resp.json()["id"])


@pytest.mark.asyncio
async def test_fresh_user_has_no_writing_habit_link(async_client: AsyncClient) -> None:
    """A fresh account's flags carry the link key, and it is null."""
    headers = await _signup(async_client, "fresh_link")

    resp = await async_client.get(_FLAGS_URL, headers=headers)

    assert resp.status_code == HTTPStatus.OK
    assert _LINK_KEY in resp.json()
    assert resp.json()[_LINK_KEY] is None


@pytest.mark.asyncio
async def test_patch_links_an_owned_habit_and_get_reads_it_back(
    async_client: AsyncClient,
) -> None:
    """PATCH stores the caller's own habit id; a later GET reads the same id back."""
    headers = await _signup(async_client, "link_owned")
    habit_id = await _create_habit(async_client, headers, "Morning pages")

    patch = await async_client.patch(_FLAGS_URL, json={_LINK_KEY: habit_id}, headers=headers)

    assert patch.status_code == HTTPStatus.OK
    assert patch.json()[_LINK_KEY] == habit_id
    get = await async_client.get(_FLAGS_URL, headers=headers)
    assert get.json()[_LINK_KEY] == habit_id


@pytest.mark.asyncio
async def test_patch_explicit_null_clears_the_link(async_client: AsyncClient) -> None:
    """An explicit ``null`` is the one way to clear the link."""
    headers = await _signup(async_client, "link_clear")
    habit_id = await _create_habit(async_client, headers, "Morning pages")
    await async_client.patch(_FLAGS_URL, json={_LINK_KEY: habit_id}, headers=headers)

    patch = await async_client.patch(_FLAGS_URL, json={_LINK_KEY: None}, headers=headers)

    assert patch.status_code == HTTPStatus.OK
    assert patch.json()[_LINK_KEY] is None
    get = await async_client.get(_FLAGS_URL, headers=headers)
    assert get.json()[_LINK_KEY] is None


@pytest.mark.asyncio
async def test_patch_that_omits_the_link_leaves_it_unchanged(async_client: AsyncClient) -> None:
    """A boolean-only PATCH neither clears nor rewrites a stored link."""
    headers = await _signup(async_client, "link_keep")
    habit_id = await _create_habit(async_client, headers, "Morning pages")
    await async_client.patch(_FLAGS_URL, json={_LINK_KEY: habit_id}, headers=headers)

    patch = await async_client.patch(
        _FLAGS_URL, json={"energy_scaffolding_archived": True}, headers=headers
    )

    assert patch.status_code == HTTPStatus.OK
    assert patch.json()[_LINK_KEY] == habit_id
    assert patch.json()["energy_scaffolding_archived"] is True
    get = await async_client.get(_FLAGS_URL, headers=headers)
    assert get.json()[_LINK_KEY] == habit_id


@pytest.mark.asyncio
async def test_patch_a_missing_habit_404s_and_writes_nothing(async_client: AsyncClient) -> None:
    """An id no habit carries is refused with 404 -- and the boolean beside it is not applied."""
    headers = await _signup(async_client, "link_missing")

    patch = await async_client.patch(
        _FLAGS_URL,
        json={_LINK_KEY: _MISSING_HABIT_ID, "has_seen_welcome": True},
        headers=headers,
    )

    assert patch.status_code == HTTPStatus.NOT_FOUND
    get = await async_client.get(_FLAGS_URL, headers=headers)
    assert get.json()[_LINK_KEY] is None
    assert get.json()["has_seen_welcome"] is False


@pytest.mark.parametrize("bad_id", [0, -1, _PAST_INT32_MAX])
@pytest.mark.asyncio
async def test_patch_an_out_of_range_id_is_a_422(async_client: AsyncClient, bad_id: int) -> None:
    """A value no row id can take is refused by the schema bound, never looked up."""
    headers = await _signup(async_client, f"link_bound_{abs(bad_id) % 1000}")

    patch = await async_client.patch(_FLAGS_URL, json={_LINK_KEY: bad_id}, headers=headers)

    assert patch.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_deleting_the_linked_habit_clears_the_link(async_client: AsyncClient) -> None:
    """DELETE /habits/{id} leaves the next GET /ui-flags with no link."""
    headers = await _signup(async_client, "link_delete")
    habit_id = await _create_habit(async_client, headers, "Morning pages")
    await async_client.patch(_FLAGS_URL, json={_LINK_KEY: habit_id}, headers=headers)

    deleted = await async_client.delete(f"/habits/{habit_id}", headers=headers)

    assert deleted.status_code == HTTPStatus.NO_CONTENT
    get = await async_client.get(_FLAGS_URL, headers=headers)
    assert get.json()[_LINK_KEY] is None


@pytest.mark.asyncio
async def test_deleting_an_unlinked_habit_keeps_the_link(async_client: AsyncClient) -> None:
    """Deleting some other habit leaves the stored link exactly where it was."""
    headers = await _signup(async_client, "link_delete_other")
    linked = await _create_habit(async_client, headers, "Morning pages")
    other = await _create_habit(async_client, headers, "Stretch")
    await async_client.patch(_FLAGS_URL, json={_LINK_KEY: linked}, headers=headers)

    deleted = await async_client.delete(f"/habits/{other}", headers=headers)

    assert deleted.status_code == HTTPStatus.NO_CONTENT
    get = await async_client.get(_FLAGS_URL, headers=headers)
    assert get.json()[_LINK_KEY] == linked
