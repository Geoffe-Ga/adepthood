"""End-to-end tests for boundary sanitization (BUG-JOURNAL-003 / BUG-PROMPT-003).

These tests submit payloads containing control characters, zero-width
codepoints, and bidirectional-override codepoints through the public HTTP
API and assert that the persisted row is sanitized.  Sanitization is a
one-time operation applied at the trust boundary (router) so every
downstream sink — DB row, log line, LLM prompt — sees the cleaned value.
"""

from __future__ import annotations

from http import HTTPStatus
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from models.corpus_fragment import CorpusFragment
from models.journal_entry import JournalEntry
from models.user import User
from models.vault_pipeline_run import VaultPipelineRun
from models.wallet_audit import WalletAudit
from routers import journal as journal_router
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


async def _signup_with_id(
    client: AsyncClient, session: AsyncSession, username: str
) -> tuple[dict[str, str], int]:
    """Create a user and return both auth headers and the server-owned id."""
    headers = await _signup(client, username)
    result = await session.execute(select(User.id).where(User.email == f"{username}@example.com"))
    return headers, int(result.scalar_one())


async def _journal_side_effect_counts(session: AsyncSession) -> tuple[int, int, int, int]:
    """Count every durable write a refused journal body must leave untouched."""
    counts: list[int] = []
    for model in (JournalEntry, CorpusFragment, VaultPipelineRun, WalletAudit):
        result = await session.execute(select(func.count()).select_from(model))
        counts.append(int(result.scalar_one()))
    return counts[0], counts[1], counts[2], counts[3]


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


@pytest.mark.parametrize(
    ("case", "raw"),
    [
        ("spaces", "   "),
        ("tabs-newlines", "\t\n\r"),
        ("controls", "\x00\x07\x1b\x7f"),
        ("zero-width", "\u200b\u200c\u2060\ufeff"),
    ],
)
@pytest.mark.asyncio
async def test_journal_post_rejects_message_emptied_by_sanitization_without_side_effects(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    case: str,
    raw: str,
) -> None:
    """Post-sanitization emptiness is a stable refusal before any durable or remote work."""
    headers = await _signup(async_client, f"empty-sanitized-{case}")
    vault_write = AsyncMock()
    corpus_write = AsyncMock()
    monkeypatch.setattr(journal_router, "_record_vault_outcome", vault_write)
    monkeypatch.setattr(journal_router, "_record_corpus_fragment", corpus_write)
    before = await _journal_side_effect_counts(db_session)

    resp = await async_client.post("/journal/", json={"message": raw}, headers=headers)

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json() == {"detail": "journal_message_empty"}
    assert await _journal_side_effect_counts(db_session) == before
    vault_write.assert_not_awaited()
    corpus_write.assert_not_awaited()


@pytest.mark.asyncio
async def test_journal_patch_rejects_message_emptied_by_sanitization_without_side_effects(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A refused edit keeps the live body and every downstream store unchanged."""
    headers = await _signup(async_client, "empty-sanitized-patch")
    created = await async_client.post(
        "/journal/", json={"message": "The body that must remain."}, headers=headers
    )
    assert created.status_code == HTTPStatus.CREATED
    entry_id = int(created.json()["id"])
    vault_write = AsyncMock()
    corpus_write = AsyncMock()
    monkeypatch.setattr(journal_router, "_record_vault_outcome", vault_write)
    monkeypatch.setattr(journal_router, "_record_corpus_fragment", corpus_write)
    before = await _journal_side_effect_counts(db_session)

    resp = await async_client.patch(
        f"/journal/{entry_id}", json={"message": " \u200b\x00\t\n "}, headers=headers
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json() == {"detail": "journal_message_empty"}
    assert await _journal_side_effect_counts(db_session) == before
    vault_write.assert_not_awaited()
    corpus_write.assert_not_awaited()
    persisted = await async_client.get(f"/journal/{entry_id}", headers=headers)
    assert persisted.json()["message"] == "The body that must remain."


@pytest.mark.asyncio
async def test_journal_post_preserves_multiline_prose_while_removing_controls(
    async_client: AsyncClient,
) -> None:
    """Visible prose keeps its internal layout even when unsafe codepoints surround it."""
    headers = await _signup(async_client, "multiline-controls")
    raw = "  First\tline\x00\nSecond\u200b line\x1b  "

    resp = await async_client.post("/journal/", json={"message": raw}, headers=headers)

    assert resp.status_code == HTTPStatus.CREATED
    assert resp.json()["message"] == "First\tline\nSecond line"


@pytest.mark.asyncio
async def test_legacy_empty_entry_refuses_resonance_before_wallet_or_provider(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A row created before the boundary fix is explicit 422, never reflection input."""
    headers, user_id = await _signup_with_id(async_client, db_session, "legacy-empty-resonance")
    entry = JournalEntry(user_id=user_id, sender="user", message="")
    db_session.add(entry)
    await db_session.commit()
    await db_session.refresh(entry)
    assert entry.id is not None
    payment = AsyncMock(side_effect=AssertionError("wallet/provider path reached"))
    monkeypatch.setattr(journal_router, "_resonance_payment", payment)
    before = await _journal_side_effect_counts(db_session)

    resp = await async_client.post(f"/journal/{entry.id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json() == {"detail": "journal_message_empty"}
    assert await _journal_side_effect_counts(db_session) == before
    payment.assert_not_awaited()


@pytest.mark.asyncio
async def test_legacy_empty_entry_refuses_completion_detection_before_candidate_or_provider_work(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The second reflective route gives a pre-fix empty row the same safe disposition."""
    headers, user_id = await _signup_with_id(async_client, db_session, "legacy-empty-detection")
    entry = JournalEntry(user_id=user_id, sender="user", message="")
    db_session.add(entry)
    await db_session.commit()
    await db_session.refresh(entry)
    assert entry.id is not None
    candidates = AsyncMock(side_effect=AssertionError("candidate/provider path reached"))
    monkeypatch.setattr(journal_router, "_unoffered_candidates", candidates)
    before = await _journal_side_effect_counts(db_session)

    resp = await async_client.post(f"/journal/{entry.id}/suggestions/detect", headers=headers)

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json() == {"detail": "journal_message_empty"}
    assert await _journal_side_effect_counts(db_session) == before
    candidates.assert_not_awaited()


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
    reflections = [e for e in journal.json()["items"] if e["tag"] == "weekly_prompt"]
    assert reflections, "weekly-prompt journal entry should exist"
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
            json={"response": "hello world friend"},
            headers=headers,
        )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json()["detail"] == "response_too_long"
