"""RED tests — intimate-entry cloud-LLM guard (issue #895).

The guarantee: when ``entry.classification == 'intimate'`` the cloud LLM
(``services.botmason.generate_response`` — the single choke point used by
``BotmasonResonanceLLM.complete``) is NEVER called; no wallet charge occurs;
no ``LLMUsageLog`` row linked to the entry is written; the endpoint returns a
non-shaming private response.

Two endpoints are covered:
  1. ``POST /journal/{id}/resonance``  (``run_resonance``)
  2. ``POST /journal/marginalia/{id}/essay``  (``expand_marginalia_essay``)

These tests FAIL against current production code (which calls the LLM regardless
of classification) and must be made green by issue #895's implementation.

Spy seam: ``services.marginalia.generate_response`` — the module-level name
imported into ``services.marginalia`` that both ``BotmasonResonanceLLM.complete``
(resonance + essay) resolve through. Patching this single name intercepts every
cloud call made by both endpoints.
"""

from __future__ import annotations

from http import HTTPStatus
from types import SimpleNamespace
from typing import cast

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from models.journal_entry import JournalEntry
from models.llm_usage_log import LLMUsageLog
from models.marginalia import Marginalia, MarginaliaKind
from models.user import User
from services import marginalia as marginalia_service

# ---------------------------------------------------------------------------
# Exact private-response copy (the implementation MUST match this string)
# ---------------------------------------------------------------------------
_INTIMATE_PRIVATE_MESSAGE = (
    "This entry stays private — it's not sent to any AI. Change its privacy to enable reflection."
)

_BODY = "These are my most personal thoughts, never for any AI to see."


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], str]:
    """Sign up a user and return (auth headers, email)."""
    email = f"{username}@example.com"
    resp = await client.post(
        "/auth/signup",
        json={"email": email, "password": "secret12345"},  # pragma: allowlist secret
    )
    assert resp.status_code == HTTPStatus.OK
    token = resp.json()["token"]
    return {"Authorization": f"Bearer {token}"}, email


async def _create_entry(
    client: AsyncClient,
    headers: dict[str, str],
    *,
    classification: str,
    body: str = _BODY,
) -> int:
    """POST a journal entry with the given classification and return its id."""
    resp = await client.post(
        "/journal/",
        json={"message": body, "classification": classification},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED
    return int(resp.json()["id"])


class _SpyLLM:
    """Spy on ``generate_response``; counts calls and returns canned text."""

    def __init__(self, reply: str = '{"notes":[]}') -> None:
        self.calls = 0
        self._reply = reply

    async def __call__(
        self, prompt: str, history: object, *, system_prompt: object, api_key: object
    ) -> SimpleNamespace:
        del prompt, history, system_prompt, api_key
        self.calls += 1
        return SimpleNamespace(text=self._reply)


async def _seed_marginalia_for_entry(session: AsyncSession, entry_id: int, user_id: int) -> int:
    """Insert a Marginalia row linked to the given entry; return its id."""
    note = Marginalia(
        journal_entry_id=entry_id,
        user_id=user_id,
        kind=MarginaliaKind.SYMBOL,
        anchor_start=0,
        anchor_end=5,
        anchor_text=_BODY[:5],
        note="A seed note.",
    )
    session.add(note)
    await session.commit()
    await session.refresh(note)
    assert note.id is not None
    return note.id


# ---------------------------------------------------------------------------
# 1. Resonance endpoint — intimate → 0 cloud calls (THE load-bearing guard)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_intimate_resonance_zero_cloud_calls(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Intimate entry: POST /resonance MUST NOT call the cloud LLM (call count == 0).

    This is the primary regression guard for issue #895. If this test passes
    before the guard is implemented, the implementation is wrong.
    """
    spy = _SpyLLM()
    monkeypatch.setattr(marginalia_service, "generate_response", spy)

    headers, _ = await _signup(async_client, "intimate_res_calls")
    entry_id = await _create_entry(async_client, headers, classification="intimate")

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    # THE assertion — the cloud must never be reached for an intimate entry.
    assert spy.calls == 0, (
        f"Expected 0 cloud LLM calls for an intimate entry; got {spy.calls}. "
        "The intimate-entry guard is not implemented."
    )


# ---------------------------------------------------------------------------
# 2. Resonance endpoint — intimate → private response shape
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_intimate_resonance_private_response_shape(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Intimate resonance is a private stub: private=True, empty notes, the exact copy."""
    spy = _SpyLLM()
    monkeypatch.setattr(marginalia_service, "generate_response", spy)

    headers, _ = await _signup(async_client, "intimate_res_shape")
    entry_id = await _create_entry(async_client, headers, classification="intimate")

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)
    assert resp.status_code == HTTPStatus.OK, resp.text

    body = resp.json()
    assert body["private"] is True, "Response must include private=True for intimate entries."
    assert body["marginalia"] == [], "No marginalia must be persisted for an intimate entry."
    assert body["suggestions"] == [], "No suggestions must be persisted for an intimate entry."
    assert body["private_message"] == _INTIMATE_PRIVATE_MESSAGE, (
        f"Wrong private_message copy.\n"
        f"  got:      {body.get('private_message')!r}\n"
        f"  expected: {_INTIMATE_PRIVATE_MESSAGE!r}"
    )


# ---------------------------------------------------------------------------
# 3. No LLMUsageLog row linked to the intimate entry after resonance
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_intimate_resonance_no_usage_log_row(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """After an intimate resonance call, zero LLMUsageLog rows must exist for that entry.

    Regression lock: even if the write-site is added later, this test will
    immediately catch any accidental logging of intimate-entry calls.
    """
    spy = _SpyLLM()
    monkeypatch.setattr(marginalia_service, "generate_response", spy)

    headers, _ = await _signup(async_client, "intimate_res_log")
    entry_id = await _create_entry(async_client, headers, classification="intimate")

    await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    log_count = (
        await db_session.execute(
            select(func.count())
            .select_from(LLMUsageLog)
            .where(col(LLMUsageLog.journal_entry_id) == entry_id)
        )
    ).scalar_one()
    assert log_count == 0, (
        f"Expected 0 LLMUsageLog rows for intimate entry {entry_id}; found {log_count}."
    )


# ---------------------------------------------------------------------------
# 4. No wallet charge after an intimate resonance call
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_intimate_resonance_no_wallet_charge(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Intimate resonance charges nothing: messages_used + offering_balance unchanged."""
    spy = _SpyLLM()
    monkeypatch.setattr(marginalia_service, "generate_response", spy)

    headers, email = await _signup(async_client, "intimate_res_wallet")
    entry_id = await _create_entry(async_client, headers, classification="intimate")

    # Snapshot balances before the resonance call.
    user_before = (
        await db_session.execute(select(User).where(col(User.email) == email))
    ).scalar_one()
    messages_before = user_before.monthly_messages_used
    balance_before = user_before.offering_balance

    await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    # Expire cached state so we read from DB.
    await db_session.refresh(user_before)
    assert user_before.monthly_messages_used == messages_before, (
        "monthly_messages_used must not increase for an intimate resonance call."
    )
    assert user_before.offering_balance == balance_before, (
        "offering_balance must not decrease for an intimate resonance call."
    )


# ---------------------------------------------------------------------------
# 5. Essay/expand endpoint — intimate entry → 0 cloud calls
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_intimate_essay_zero_cloud_calls(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Intimate entry: POST /marginalia/{id}/essay MUST NOT call the cloud LLM.

    The essay endpoint looks up the entry's classification via the marginalia FK.
    When that entry is intimate, the cloud call must be suppressed just as on
    the resonance path.
    """
    spy = _SpyLLM("A warm essay.")
    monkeypatch.setattr(marginalia_service, "generate_response", spy)

    # We need a real user_id to seed the marginalia; derive it from the signup.
    resp = await async_client.post(
        "/auth/signup",
        json={
            "email": "intimate_essay@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    payload = resp.json()
    headers = {"Authorization": f"Bearer {payload['token']}"}
    user_id = int(payload["user_id"])

    # Create an intimate entry directly in the DB (bypasses HTTP to control classification).
    entry = JournalEntry(
        sender="user",
        user_id=user_id,
        message=_BODY,
        classification="intimate",
    )
    db_session.add(entry)
    await db_session.commit()
    await db_session.refresh(entry)
    entry_id = cast("int", entry.id)

    marg_id = await _seed_marginalia_for_entry(db_session, entry_id, user_id)

    resp = await async_client.post(f"/journal/marginalia/{marg_id}/essay", headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    # Cloud must not be reached for an intimate entry's essay.
    assert spy.calls == 0, (
        f"Expected 0 cloud LLM calls for an intimate essay; got {spy.calls}. "
        "The intimate-entry guard is missing from expand_marginalia_essay."
    )


# ---------------------------------------------------------------------------
# 6. Personal entry — resonance STILL calls the LLM (guard is intimate-only)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_personal_resonance_still_calls_llm(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Personal entry: the cloud LLM is called at least once (guard must not over-block).

    This counter-test proves the intimate guard is classification-specific and
    does not accidentally block 'personal' entries.
    """
    spy = _SpyLLM('{"notes":[{"kind":"theme","quote":"my thoughts","note":"Noted."}]}')
    monkeypatch.setattr(marginalia_service, "generate_response", spy)

    headers, _ = await _signup(async_client, "personal_res_calls")
    entry_id = await _create_entry(async_client, headers, classification="personal")

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert spy.calls >= 1, (
        f"Expected ≥1 cloud LLM call for a personal entry; got {spy.calls}. "
        "The guard is over-blocking non-intimate entries."
    )
    body = resp.json()
    assert body.get("private") is not True, (
        "A personal entry must NOT be marked private in the resonance response."
    )


# ---------------------------------------------------------------------------
# 7. Public entry — resonance STILL calls the LLM (guard is intimate-only)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_public_resonance_still_calls_llm(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Public entry: the cloud LLM is called at least once (guard must not over-block).

    This counter-test proves the intimate guard is classification-specific and
    does not accidentally block 'public' entries.
    """
    spy = _SpyLLM('{"notes":[{"kind":"symbol","quote":"my thoughts","note":"Noted."}]}')
    monkeypatch.setattr(marginalia_service, "generate_response", spy)

    headers, _ = await _signup(async_client, "public_res_calls")
    entry_id = await _create_entry(async_client, headers, classification="public")

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert spy.calls >= 1, (
        f"Expected ≥1 cloud LLM call for a public entry; got {spy.calls}. "
        "The guard is over-blocking non-intimate entries."
    )
    body = resp.json()
    assert body.get("private") is not True, (
        "A public entry must NOT be marked private in the resonance response."
    )


# ---------------------------------------------------------------------------
# 8. Side-channel guard: intimate sibling body must NOT appear in the cloud
#    prompt when resonance runs on a newer personal/public entry (issue #895).
# ---------------------------------------------------------------------------

_INTIMATE_SENTINEL = "INTIMATE_SENTINEL_SECRET_TEXT"
_PERSONAL_BODY = "Some personal thoughts for a public entry that triggers resonance with a note."


class _CapturingSpyLLM:
    """Spy that records the prompt argument passed to ``generate_response``.

    Mirrors ``_SpyLLM`` but preserves the first positional argument (the prompt
    string) so tests can assert on its contents.  Returns a minimal valid JSON
    completion so the resonance path succeeds without touching real JSON parsing
    machinery.
    """

    def __init__(self) -> None:
        self.calls: int = 0
        self.captured_prompts: list[str] = []
        # Minimal valid completion: one anchored note whose quote is verbatim in
        # _PERSONAL_BODY so that anchoring succeeds and the spy call is counted.
        self._reply: str = (
            '{"notes":[{"kind":"theme","quote":"Some personal thoughts",'
            '"note":"A thoughtful observation."}]}'
        )

    async def __call__(
        self,
        prompt: str,
        history: object,
        *,
        system_prompt: object,
        api_key: object,
    ) -> SimpleNamespace:
        del history, system_prompt, api_key
        self.calls += 1
        self.captured_prompts.append(prompt)
        return SimpleNamespace(text=self._reply)


@pytest.mark.asyncio
async def test_intimate_prior_body_excluded_from_resonance_prompt(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Intimate sibling body must not appear in the cloud prompt for a personal entry.

    Regression guard for the ``_recent_prior_bodies`` side-channel (issue #895):
    before the fix, the helper loaded ALL sibling entries' bodies — including
    intimate ones — and embedded them verbatim in the ``<prior>`` block sent to
    the cloud LLM.  The fix adds ``classification != INTIMATE`` to the WHERE
    clause.  This test would be RED without that filter.

    Setup:
      - Older **intimate** entry whose body contains ``_INTIMATE_SENTINEL``.
      - Newer **personal** entry (does call the LLM; guard is intimate-only).

    Assertions:
      - The capturing spy was called at least once (personal resonance runs).
      - None of the captured prompts contain ``_INTIMATE_SENTINEL`` (the
        intimate body was excluded from ``<prior>``).

    Without the fix, ``_recent_prior_bodies`` would return the intimate entry's
    body (``_INTIMATE_SENTINEL``), ``build_prompt`` would embed it in the
    ``<prior>`` block, and the second assertion would fail — pinning the fix.
    """
    spy = _CapturingSpyLLM()
    monkeypatch.setattr(marginalia_service, "generate_response", spy)

    headers, _ = await _signup(async_client, "intimate_prior_leak")

    # 1. Older intimate entry — its body must never reach the cloud.
    await _create_entry(
        async_client,
        headers,
        classification="intimate",
        body=_INTIMATE_SENTINEL,
    )

    # 2. Newer personal entry — resonance WILL call the LLM; use a body that
    #    anchors cleanly with the spy's canned completion.
    personal_id = await _create_entry(
        async_client,
        headers,
        classification="personal",
        body=_PERSONAL_BODY,
    )

    resp = await async_client.post(f"/journal/{personal_id}/resonance", headers=headers)
    assert resp.status_code == HTTPStatus.OK, resp.text

    # The cloud spy must have been reached (personal entry is NOT guarded).
    assert spy.calls >= 1, (
        f"Expected ≥1 cloud LLM call for the personal entry; got {spy.calls}. "
        "The personal-entry resonance path is broken."
    )

    # The intimate sibling's body must be absent from every prompt the spy saw.
    for i, captured in enumerate(spy.captured_prompts):
        assert _INTIMATE_SENTINEL not in captured, (
            f"Intimate sentinel found in prompt #{i} sent to the cloud LLM. "
            "``_recent_prior_bodies`` is leaking intimate sibling bodies — "
            "the ``classification != INTIMATE`` filter is missing or not applied."
        )


# ---------------------------------------------------------------------------
# 9. Intimate entry + acute distress: local care must still surface, zero cloud
# ---------------------------------------------------------------------------

# A known elevated trigger for domain.safety.assess_distress.
_DISTRESS_BODY = "I keep thinking I want to kill myself and end my life tonight."


def _assert_local_care_shape(care: dict[str, object]) -> None:
    """Assert the care payload carries the human + professional pointers."""
    resources = care["resources"]
    assert isinstance(resources, list)
    kinds = {r["kind"] for r in resources if isinstance(r, dict)}
    assert {"hotline", "text_line", "human", "professional"} <= kinds
    blob = str(care).lower()
    assert "988" in blob
    assert "741741" in blob
    assert "trust" in blob
    assert "professional" in blob


@pytest.mark.asyncio
async def test_intimate_distress_surfaces_local_care_zero_cloud(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An intimate + distressed entry still gets the local care surface, zero cloud calls."""
    spy = _SpyLLM()
    monkeypatch.setattr(marginalia_service, "generate_response", spy)

    headers, _ = await _signup(async_client, "intimate_distress_care")
    entry_id = await _create_entry(
        async_client, headers, classification="intimate", body=_DISTRESS_BODY
    )

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)
    assert resp.status_code == HTTPStatus.OK, resp.text

    body = resp.json()
    assert body["private"] is True
    assert body["private_message"] == _INTIMATE_PRIVATE_MESSAGE
    assert body["marginalia"] == []
    assert body["suggestions"] == []
    assert body["care"] is not None, "A distressed intimate entry must still surface local care."
    _assert_local_care_shape(body["care"])
    assert spy.calls == 0, (
        f"Expected 0 cloud LLM calls for a distressed intimate entry; got {spy.calls}. "
        "The care surface must be local-only and never route through the cloud."
    )


@pytest.mark.asyncio
async def test_intimate_distress_care_no_wallet_charge_no_usage_log(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A distressed intimate entry's care surface still charges nothing and logs nothing."""
    spy = _SpyLLM()
    monkeypatch.setattr(marginalia_service, "generate_response", spy)

    headers, email = await _signup(async_client, "intimate_distress_wallet")
    entry_id = await _create_entry(
        async_client, headers, classification="intimate", body=_DISTRESS_BODY
    )

    user_before = (
        await db_session.execute(select(User).where(col(User.email) == email))
    ).scalar_one()
    messages_before = user_before.monthly_messages_used
    balance_before = user_before.offering_balance

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)
    assert resp.status_code == HTTPStatus.OK, resp.text
    assert resp.json()["care"] is not None, "Care must surface even though nothing is charged."

    await db_session.refresh(user_before)
    assert user_before.monthly_messages_used == messages_before, (
        "monthly_messages_used must not increase for a distressed intimate entry."
    )
    assert user_before.offering_balance == balance_before, (
        "offering_balance must not decrease for a distressed intimate entry."
    )

    log_count = (
        await db_session.execute(
            select(func.count())
            .select_from(LLMUsageLog)
            .where(col(LLMUsageLog.journal_entry_id) == entry_id)
        )
    ).scalar_one()
    assert log_count == 0, (
        f"Expected 0 LLMUsageLog rows for distressed intimate entry {entry_id}; found {log_count}."
    )


@pytest.mark.asyncio
async def test_intimate_denial_gets_no_care(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An explicit denial in an intimate entry must not false-trigger the care surface."""
    spy = _SpyLLM()
    monkeypatch.setattr(marginalia_service, "generate_response", spy)

    headers, _ = await _signup(async_client, "intimate_denial")
    entry_id = await _create_entry(
        async_client, headers, classification="intimate", body="I would never kill myself"
    )

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)
    assert resp.status_code == HTTPStatus.OK, resp.text

    body = resp.json()
    assert body["private"] is True
    assert body["care"] is None, "A negated denial must not surface the care screen."
    assert spy.calls == 0


@pytest.mark.asyncio
async def test_intimate_non_distress_unchanged(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A calm intimate entry is unchanged: private stub, no care, exact copy."""
    spy = _SpyLLM()
    monkeypatch.setattr(marginalia_service, "generate_response", spy)

    headers, _ = await _signup(async_client, "intimate_calm")
    entry_id = await _create_entry(async_client, headers, classification="intimate")

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)
    assert resp.status_code == HTTPStatus.OK, resp.text

    body = resp.json()
    assert body["private"] is True
    assert body["care"] is None
    assert body["private_message"] == _INTIMATE_PRIVATE_MESSAGE
    assert spy.calls == 0
