"""Tests for the journal API — chat messages, tagging, search, and pagination."""

from __future__ import annotations

from http import HTTPStatus

import pytest
from cryptography.fernet import Fernet
from httpx import AsyncClient

from services import journal_encryption


def _message_payload(**overrides: object) -> dict[str, object]:
    """Return a valid journal message creation payload."""
    payload: dict[str, object] = {"message": "Today I meditated for 20 minutes."}
    payload.update(overrides)
    return payload


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
async def test_unauthenticated_create_returns_401(async_client: AsyncClient) -> None:
    resp = await async_client.post("/journal/", json=_message_payload())
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_unauthenticated_list_returns_401(async_client: AsyncClient) -> None:
    resp = await async_client.get("/journal/")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


# ── Create ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_create_journal_entry(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.post("/journal/", json=_message_payload(), headers=headers)
    assert resp.status_code == HTTPStatus.CREATED
    data = resp.json()
    assert data["message"] == "Today I meditated for 20 minutes."
    assert data["sender"] == "user"
    assert data["id"] is not None
    assert data["timestamp"] is not None
    assert data["tag"] == "freeform"


@pytest.mark.asyncio
async def test_create_journal_entry_with_tag(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.post(
        "/journal/",
        json=_message_payload(tag="stage_reflection"),
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED
    data = resp.json()
    assert data["tag"] == "stage_reflection"


@pytest.mark.asyncio
async def test_create_journal_entry_with_practice_note_tag(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.post(
        "/journal/",
        json=_message_payload(tag="practice_note"),
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED
    assert resp.json()["tag"] == "practice_note"


@pytest.mark.asyncio
async def test_create_journal_entry_with_habit_note_tag(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.post(
        "/journal/",
        json=_message_payload(tag="habit_note"),
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED
    assert resp.json()["tag"] == "habit_note"


@pytest.mark.asyncio
async def test_create_journal_entry_invalid_tag_returns_422(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.post(
        "/journal/",
        json=_message_payload(tag="nonexistent"),
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_create_journal_entry_with_practice_session(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.post(
        "/journal/",
        json=_message_payload(practice_session_id=42, user_practice_id=7),
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED
    data = resp.json()
    assert data["practice_session_id"] == 42
    assert data["user_practice_id"] == 7


# ── List & Pagination ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_list_journal_entries_newest_first(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    await async_client.post("/journal/", json=_message_payload(message="First"), headers=headers)
    await async_client.post("/journal/", json=_message_payload(message="Second"), headers=headers)
    await async_client.post("/journal/", json=_message_payload(message="Third"), headers=headers)

    resp = await async_client.get("/journal/", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    assert data["total"] == 3
    messages = [item["message"] for item in data["items"]]
    assert messages == ["Third", "Second", "First"]


@pytest.mark.asyncio
async def test_list_journal_pagination(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    for i in range(5):
        await async_client.post(
            "/journal/", json=_message_payload(message=f"Entry {i}"), headers=headers
        )

    resp = await async_client.get("/journal/?limit=2&offset=0", headers=headers)
    data = resp.json()
    assert len(data["items"]) == 2
    assert data["total"] == 5
    assert data["has_more"] is True

    resp2 = await async_client.get("/journal/?limit=2&offset=4", headers=headers)
    data2 = resp2.json()
    assert len(data2["items"]) == 1
    assert data2["has_more"] is False


# ── Get single entry ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_journal_entry(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    create_resp = await async_client.post("/journal/", json=_message_payload(), headers=headers)
    entry_id = create_resp.json()["id"]

    resp = await async_client.get(f"/journal/{entry_id}", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["message"] == "Today I meditated for 20 minutes."


@pytest.mark.asyncio
async def test_get_nonexistent_entry_returns_404(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.get("/journal/9999", headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND


# ── Delete ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_delete_journal_entry(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    create_resp = await async_client.post("/journal/", json=_message_payload(), headers=headers)
    entry_id = create_resp.json()["id"]

    resp = await async_client.delete(f"/journal/{entry_id}", headers=headers)
    assert resp.status_code == HTTPStatus.NO_CONTENT

    get_resp = await async_client.get(f"/journal/{entry_id}", headers=headers)
    assert get_resp.status_code == HTTPStatus.NOT_FOUND


# ── Bot response (internal endpoint) ────────────────────────────────────


@pytest.mark.asyncio
async def test_create_bot_response(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.post(
        "/journal/bot-response",
        json={"message": "Great job with your meditation!"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED
    data = resp.json()
    assert data["sender"] == "bot"
    assert data["message"] == "Great job with your meditation!"


@pytest.mark.asyncio
async def test_bot_response_ignores_user_id_in_payload(async_client: AsyncClient) -> None:
    """BUG-JOURNAL-002: user_id in the payload must not override the authenticated user."""
    alice_headers = await _signup(async_client, "alice")
    bob_headers = await _signup(async_client, "bob")

    # Alice tries to inject a bot message into Bob's journal by passing user_id
    resp = await async_client.post(
        "/journal/bot-response",
        json={"message": "Injected message", "user_id": 999},
        headers=alice_headers,
    )
    # user_id in payload is simply ignored (not in schema), entry uses auth user
    assert resp.status_code == HTTPStatus.CREATED

    # Bob should not see Alice's bot message
    bob_journal = await async_client.get("/journal/", headers=bob_headers)
    assert bob_journal.json()["total"] == 0


# ── Search ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_search_by_keyword(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    await async_client.post(
        "/journal/", json=_message_payload(message="I practiced guitar today"), headers=headers
    )
    await async_client.post(
        "/journal/", json=_message_payload(message="Meditated for 10 minutes"), headers=headers
    )
    await async_client.post(
        "/journal/", json=_message_payload(message="Guitar scales went well"), headers=headers
    )

    resp = await async_client.get("/journal/?search=guitar", headers=headers)
    data = resp.json()
    assert data["total"] == 2
    for item in data["items"]:
        assert "guitar" in item["message"].lower()


@pytest.mark.asyncio
async def test_search_case_insensitive(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    await async_client.post(
        "/journal/", json=_message_payload(message="Yoga stretches"), headers=headers
    )

    resp = await async_client.get("/journal/?search=YOGA", headers=headers)
    assert resp.json()["total"] == 1


# ── Tag filtering ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_filter_by_tag_stage_reflection(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    await async_client.post(
        "/journal/",
        json=_message_payload(message="Reflection on stage 2", tag="stage_reflection"),
        headers=headers,
    )
    await async_client.post(
        "/journal/", json=_message_payload(message="Just a note"), headers=headers
    )

    resp = await async_client.get("/journal/?tag=stage_reflection", headers=headers)
    data = resp.json()
    assert data["total"] == 1
    assert data["items"][0]["tag"] == "stage_reflection"


@pytest.mark.asyncio
async def test_filter_by_tag_practice_note(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    await async_client.post(
        "/journal/",
        json=_message_payload(message="Practice went great", tag="practice_note"),
        headers=headers,
    )
    await async_client.post(
        "/journal/", json=_message_payload(message="Random thought"), headers=headers
    )

    resp = await async_client.get("/journal/?tag=practice_note", headers=headers)
    data = resp.json()
    assert data["total"] == 1
    assert data["items"][0]["tag"] == "practice_note"


@pytest.mark.asyncio
async def test_filter_by_tag_habit_note(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    await async_client.post(
        "/journal/",
        json=_message_payload(message="Habit streak broken", tag="habit_note"),
        headers=headers,
    )

    resp = await async_client.get("/journal/?tag=habit_note", headers=headers)
    data = resp.json()
    assert data["total"] == 1


@pytest.mark.asyncio
async def test_filter_by_tag_freeform(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    await async_client.post(
        "/journal/", json=_message_payload(message="Freeform entry"), headers=headers
    )
    await async_client.post(
        "/journal/",
        json=_message_payload(message="Tagged entry", tag="habit_note"),
        headers=headers,
    )

    resp = await async_client.get("/journal/?tag=freeform", headers=headers)
    data = resp.json()
    assert data["total"] == 1
    assert data["items"][0]["tag"] == "freeform"


@pytest.mark.asyncio
async def test_filter_by_invalid_tag_returns_422(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    resp = await async_client.get("/journal/?tag=nonexistent", headers=headers)
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


# ── Practice session filtering ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_filter_by_practice_session_id(async_client: AsyncClient) -> None:
    headers = await _signup(async_client)
    await async_client.post(
        "/journal/",
        json=_message_payload(message="Session reflection", practice_session_id=10),
        headers=headers,
    )
    await async_client.post(
        "/journal/", json=_message_payload(message="Unrelated"), headers=headers
    )

    resp = await async_client.get("/journal/?practice_session_id=10", headers=headers)
    data = resp.json()
    assert data["total"] == 1
    assert data["items"][0]["practice_session_id"] == 10


# ── User isolation ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_user_cannot_see_other_users_entries(async_client: AsyncClient) -> None:
    alice_headers = await _signup(async_client, "alice")
    bob_headers = await _signup(async_client, "bob")

    await async_client.post(
        "/journal/", json=_message_payload(message="Alice's secret"), headers=alice_headers
    )

    resp = await async_client.get("/journal/", headers=bob_headers)
    assert resp.json()["total"] == 0


@pytest.mark.asyncio
async def test_user_cannot_get_other_users_entry(async_client: AsyncClient) -> None:
    """BUG-T7: cross-user GET returns 403 (was 404).  See ``tests/security/test_idor.py``."""
    alice_headers = await _signup(async_client, "alice")
    bob_headers = await _signup(async_client, "bob")

    create_resp = await async_client.post(
        "/journal/", json=_message_payload(), headers=alice_headers
    )
    entry_id = create_resp.json()["id"]

    resp = await async_client.get(f"/journal/{entry_id}", headers=bob_headers)
    assert resp.status_code == HTTPStatus.FORBIDDEN


@pytest.mark.asyncio
async def test_user_cannot_delete_other_users_entry(async_client: AsyncClient) -> None:
    """BUG-T7: cross-user DELETE returns 403 (was 404)."""
    alice_headers = await _signup(async_client, "alice")
    bob_headers = await _signup(async_client, "bob")

    create_resp = await async_client.post(
        "/journal/", json=_message_payload(), headers=alice_headers
    )
    entry_id = create_resp.json()["id"]

    resp = await async_client.delete(f"/journal/{entry_id}", headers=bob_headers)
    assert resp.status_code == HTTPStatus.FORBIDDEN


# ── Length and search bounds ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_create_rejects_empty_message(async_client: AsyncClient) -> None:
    """BUG-JOURNAL-001: empty body must be rejected at the schema layer."""
    headers = await _signup(async_client, "empty")
    resp = await async_client.post("/journal/", json={"message": ""}, headers=headers)
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_search_rejects_below_min_length(async_client: AsyncClient) -> None:
    """BUG-JOURNAL-009: ``ILIKE '%a%'`` matches almost everything; cap min length."""
    headers = await _signup(async_client, "shortq")
    resp = await async_client.get("/journal/?search=a", headers=headers)
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_search_rejects_oversized_query(async_client: AsyncClient) -> None:
    """BUG-JOURNAL-009: a 5MB ``term`` would pin a worker on ``ILIKE`` planning."""
    headers = await _signup(async_client, "longq")
    resp = await async_client.get(f"/journal/?search={'x' * 65}", headers=headers)
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


# ── BUG-JOURNAL-007: soft-delete behaviour ──────────────────────────────


@pytest.mark.asyncio
async def test_deleted_entry_not_visible_in_list(async_client: AsyncClient) -> None:
    """BUG-JOURNAL-007: after delete, the entry must not appear in the list.

    The old hard-delete also passed this test; the soft-delete must keep
    the row in the DB (for the FK audit trail) while making it invisible to
    the API consumer.
    """
    headers = await _signup(async_client)
    resp = await async_client.post("/journal/", json=_message_payload(), headers=headers)
    entry_id = resp.json()["id"]

    await async_client.delete(f"/journal/{entry_id}", headers=headers)

    list_resp = await async_client.get("/journal/", headers=headers)
    assert list_resp.json()["total"] == 0
    assert not any(item["id"] == entry_id for item in list_resp.json()["items"])


@pytest.mark.asyncio
async def test_deleted_entry_not_retrievable_by_get(async_client: AsyncClient) -> None:
    """BUG-JOURNAL-007: GET on a soft-deleted entry must return 404."""
    headers = await _signup(async_client)
    resp = await async_client.post("/journal/", json=_message_payload(), headers=headers)
    entry_id = resp.json()["id"]

    await async_client.delete(f"/journal/{entry_id}", headers=headers)

    get_resp = await async_client.get(f"/journal/{entry_id}", headers=headers)
    assert get_resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_delete_is_idempotent_for_already_deleted(async_client: AsyncClient) -> None:
    """BUG-JOURNAL-007: deleting an already-deleted entry yields 404 (row is invisible)."""
    headers = await _signup(async_client)
    resp = await async_client.post("/journal/", json=_message_payload(), headers=headers)
    entry_id = resp.json()["id"]

    await async_client.delete(f"/journal/{entry_id}", headers=headers)
    resp2 = await async_client.delete(f"/journal/{entry_id}", headers=headers)
    assert resp2.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_create_journal_entry_max_length(async_client: AsyncClient) -> None:
    """BUG-JOURNAL-001: a message at exactly the max length (10_000 chars) is accepted."""
    headers = await _signup(async_client)
    max_msg = "x" * 10_000
    resp = await async_client.post("/journal/", json={"message": max_msg}, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED


@pytest.mark.asyncio
async def test_create_journal_entry_over_max_length_rejected(async_client: AsyncClient) -> None:
    """BUG-JOURNAL-001: a message over the max length (10_001 chars) is rejected with 422."""
    headers = await _signup(async_client)
    over_msg = "x" * 10_001
    resp = await async_client.post("/journal/", json={"message": over_msg}, headers=headers)
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_user_id_not_in_journal_response(async_client: AsyncClient) -> None:
    """BUG-JOURNAL-004: ``user_id`` must not appear in the API response."""
    headers = await _signup(async_client)
    resp = await async_client.post("/journal/", json=_message_payload(), headers=headers)
    assert resp.status_code == HTTPStatus.CREATED
    assert "user_id" not in resp.json()

    list_resp = await async_client.get("/journal/", headers=headers)
    for item in list_resp.json()["items"]:
        assert "user_id" not in item


@pytest.fixture
def _encryption_key(monkeypatch: pytest.MonkeyPatch) -> object:
    """Enable journal encryption for a test; always clear the cached registry."""
    monkeypatch.setenv("JOURNAL_ENCRYPTION_KEYS", Fernet.generate_key().decode())
    journal_encryption.reset_cache()
    yield
    journal_encryption.reset_cache()


@pytest.mark.asyncio
@pytest.mark.usefixtures("_encryption_key")
async def test_search_rejected_when_encryption_enabled(async_client: AsyncClient) -> None:
    """With encryption on, keyword search 422s instead of silently returning nothing.

    The message column holds Fernet ciphertext, so an ILIKE substring match can
    never hit; the endpoint rejects search explicitly (audit-destub-05b).
    """
    headers = await _signup(async_client, "searcher")
    await async_client.post(
        "/journal/", json=_message_payload(message="encrypted guitar note"), headers=headers
    )
    resp = await async_client.get("/journal/?search=guitar", headers=headers)
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    # A non-search list still works (and round-trips decrypted content).
    ok = await async_client.get("/journal/", headers=headers)
    assert ok.status_code == HTTPStatus.OK
    assert ok.json()["items"][0]["message"] == "encrypted guitar note"
