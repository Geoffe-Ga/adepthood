"""End-to-end tests for boundary sanitization (BUG-JOURNAL-003 / BUG-PROMPT-003).

These tests submit payloads containing control characters, zero-width
codepoints, and bidirectional-override codepoints through the public HTTP
API and assert that the persisted row is sanitized.  Sanitization is a
one-time operation applied at the trust boundary (router) so every
downstream sink — DB row, log line, LLM prompt — sees the cleaned value.
"""

from __future__ import annotations

from http import HTTPStatus
from unittest.mock import patch

import pytest
from httpx import AsyncClient

from security import TextTooLongError


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


# ── Journal sanitization ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_journal_post_strips_null_byte(async_client: AsyncClient) -> None:
    """Null bytes truncate downstream parsers and must not survive insertion."""
    headers = await _signup(async_client, "nullbyte")
    payload = {"message": "before\x00after"}
    resp = await async_client.post("/journal/", json=payload, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED
    assert resp.json()["message"] == "beforeafter"


@pytest.mark.asyncio
async def test_journal_post_strips_zero_width_smuggling(async_client: AsyncClient) -> None:
    """Invisible zero-width chars used for visual spoofing are removed."""
    headers = await _signup(async_client, "zwsp")
    payload = {"message": "hel\u200blo\u200cworld\u200d"}
    resp = await async_client.post("/journal/", json=payload, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED
    assert resp.json()["message"] == "helloworld"


@pytest.mark.asyncio
async def test_journal_post_strips_rlo_trojan_source(async_client: AsyncClient) -> None:
    """RLO (U+202E) flips render direction; the persisted bytes must drop it."""
    headers = await _signup(async_client, "rlo")
    payload = {"message": "filename\u202egnp.exe"}
    resp = await async_client.post("/journal/", json=payload, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED
    assert "\u202e" not in resp.json()["message"]


@pytest.mark.asyncio
async def test_journal_post_preserves_html_metacharacters(async_client: AsyncClient) -> None:
    """``<``, ``>``, ``&`` survive -- render-time escaping is the UI's job."""
    headers = await _signup(async_client, "html")
    raw = "5 < 10 && a > b: <em>note</em>"
    resp = await async_client.post("/journal/", json={"message": raw}, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED
    assert resp.json()["message"] == raw


@pytest.mark.asyncio
async def test_journal_post_normalizes_nfd_to_nfc(async_client: AsyncClient) -> None:
    """NFD-decomposed text is collapsed so downstream comparisons agree."""
    headers = await _signup(async_client, "nfd")
    nfd = "café"  # "café" with combining acute
    resp = await async_client.post("/journal/", json={"message": nfd}, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED
    assert resp.json()["message"] == "café"


@pytest.mark.asyncio
async def test_journal_post_preserves_newlines_and_tabs(async_client: AsyncClient) -> None:
    """Whitespace structure inside the message is preserved verbatim."""
    headers = await _signup(async_client, "ws")
    raw = "line one\nline two\twith tab\nline three"
    resp = await async_client.post("/journal/", json={"message": raw}, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED
    assert resp.json()["message"] == raw


# ── Prompt response sanitization ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_prompt_response_strips_invisible_chars(async_client: AsyncClient) -> None:
    """Submitted reflection is sanitized before either DB row is written."""
    headers = await _signup(async_client, "promptsan")
    payload = {"response": "growing\u200b\u202einto adept\x00hood"}
    resp = await async_client.post("/prompts/1/respond", json=payload, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED
    body = resp.json()
    assert body["response"] == "growinginto adepthood"


@pytest.mark.asyncio
async def test_prompt_response_journal_entry_matches_sanitized(
    async_client: AsyncClient,
) -> None:
    """The mirrored JournalEntry must store the same cleaned text as PromptResponse.

    BUG-PROMPT-003: the two writes used to share an unsanitized payload value;
    sanitizing once at the boundary keeps them byte-identical and clean.
    """
    headers = await _signup(async_client, "promptmirror")
    raw = "hello\u200b\x00world\u202e"
    resp = await async_client.post("/prompts/1/respond", json={"response": raw}, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED

    journal = await async_client.get("/journal/", headers=headers)
    assert journal.status_code == HTTPStatus.OK
    # Filter by the stage_reflection tag rather than indexing items[0] so the
    # assertion does not depend on list-ordering (a future change to the
    # default journal sort would otherwise break this test silently).
    reflections = [e for e in journal.json()["items"] if e["tag"] == "stage_reflection"]
    assert reflections, "stage-reflection journal entry should exist"
    assert reflections[0]["message"] == "helloworld"


# ── Length-cap overflow path ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_journal_post_too_long_returns_422(
    async_client: AsyncClient,
) -> None:
    """``TextTooLongError`` from sanitize is translated to HTTP 422.

    Pydantic's ``max_length`` already rejects raw input over the schema cap,
    so we craft a payload that satisfies the schema and then has its
    sanitized length exceed a deliberately-low override on the helper. The
    integration test pins the *response shape* (422 + JSON detail), not the
    obscure NFC-expansion path that triggers it in production.
    """
    headers = await _signup(async_client, "toolong")
    with patch(
        "routers.journal.sanitize_user_text",
        side_effect=TextTooLongError("text exceeds 10000 chars after sanitization"),
    ):
        resp = await async_client.post(
            "/journal/",
            json={"message": "hello"},
            headers=headers,
        )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json()["detail"] == "message_too_long"


@pytest.mark.asyncio
async def test_prompt_response_too_long_returns_422(
    async_client: AsyncClient,
) -> None:
    """Same defense for prompt responses: overflow surfaces as 422."""
    headers = await _signup(async_client, "ptoolong")
    with patch(
        "routers.prompts.sanitize_user_text",
        side_effect=TextTooLongError("text exceeds 10000 chars after sanitization"),
    ):
        resp = await async_client.post(
            "/prompts/1/respond",
            json={"response": "hello"},
            headers=headers,
        )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json()["detail"] == "response_too_long"
