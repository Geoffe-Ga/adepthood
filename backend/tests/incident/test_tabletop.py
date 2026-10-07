"""Automated tabletop scenarios for the draft privacy incident runbook (#3075).

Each test plays one scenario from ``docs/ops/privacy-incident-response.md`` §7
through the real application: the incident, the operator's steps, and the safe
state those steps reach. Every test records its steps in ``steps`` and asserts
both the final state and the path to it, so a scenario that "passes" by never
having been unsafe in the first place fails instead.

These are rehearsals against fakes. A live rehearsal on the real deployment,
with real credentials, is the owner's (#3075).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from http import HTTPStatus
from typing import TYPE_CHECKING, Any, Final, cast

import anthropic
import httpx
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from dependencies.creek_vault import get_creek_vault_client
from main import app
from models.journal_entry import JournalEntry
from models.user import User
from models.vault_activation import VaultTeardownReceipt
from services import botmason
from services.privacy_suspension import (
    AI_SUSPENDED_DETAIL,
    EXTERNAL_AI_SUSPEND_ENV_VAR,
    VAULT_SEND_SUSPEND_ENV_VAR,
)
from services.usage import DAILY_GENERATION_CEILING_ENV
from services.wallet import DAILY_GENERATION_LIMIT_REACHED
from tests.incident.test_privacy_suspension import (
    _ANTHROPIC_OK,
    _VaultRecorder,
    arm_anthropic,
    handshaken_vault,
    record_constructions,
    seed_entry,
    signup,
    suspend_ai,
    suspend_vault,
)
from tests.provider_transport import ANTHROPIC_KEY, OPENAI_KEY, use_openai

if TYPE_CHECKING:
    from httpx import Response

_OLD_KEY: Final = "sk-ant-old0000000000000000000000000000000"  # pragma: allowlist secret
_NEW_KEY: Final = "sk-ant-new1111111111111111111111111111111"  # pragma: allowlist secret
_BYOK: Final = {"X-LLM-API-Key": ANTHROPIC_KEY}
_STUCK_FOR: Final = timedelta(days=3)
_WITHDRAWN_ENTRY: Final = 11
_PROBE: Final = "/admin/privacy-suspensions"
_OPENAI_OK: Final[dict[str, object]] = {
    "id": "chatcmpl-1",
    "object": "chat.completion",
    "created": 0,
    "model": "gpt-4o-mini",
    "choices": [
        {"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}
    ],
    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
}


async def _admin(client: AsyncClient, session: AsyncSession, name: str) -> dict[str, str]:
    """A signed-up account promoted to admin, as its bearer headers."""
    headers, user_id, _ = await signup(client, name)
    user = await session.get(User, user_id)
    assert user is not None
    user.is_admin = True
    session.add(user)
    await session.commit()
    return headers


async def _resonate(
    client: AsyncClient, headers: dict[str, str], entry_id: int, extra: dict[str, str] | None = None
) -> Response:
    return await client.post(f"/journal/{entry_id}/resonance", headers={**headers, **(extra or {})})


# --- (a) canary leak at an external provider -----------------------------------


@pytest.mark.asyncio
async def test_canary_leak_contained_by_ai_switch(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Before: a pass reaches the provider. After the switch: nothing more does."""
    steps: list[str] = []
    stub = arm_anthropic(monkeypatch)
    headers, user_id, _ = await signup(async_client, "canary")
    admin = await _admin(async_client, db_session, "canary_admin")

    before = await _resonate(async_client, headers, await seed_entry(db_session, user_id))
    assert before.status_code == HTTPStatus.OK, before.text
    dialled = stub.request_count
    assert dialled >= 1, "the incident never reached the provider, so nothing was contained"
    steps.append("canary observed at provider")

    suspend_ai(monkeypatch)
    steps.append(f"set {EXTERNAL_AI_SUSPEND_ENV_VAR}")
    probe = await async_client.get(_PROBE, headers=admin)
    steps.append("probe confirms safe state")

    after = await _resonate(async_client, headers, await seed_entry(db_session, user_id))

    assert probe.json()["external_ai_suspended"] is True
    assert after.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert after.json() == {"detail": AI_SUSPENDED_DETAIL}
    assert stub.request_count == dialled
    assert steps == [
        "canary observed at provider",
        f"set {EXTERNAL_AI_SUSPEND_ENV_VAR}",
        "probe confirms safe state",
    ]


# --- (b) compromised provider key -----------------------------------------------


def _record_anthropic_keys(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Serve Anthropic over a mock transport, recording the key each request carried."""
    keys: list[str] = []
    real_client = anthropic.AsyncAnthropic

    def _handle(request: httpx.Request) -> httpx.Response:
        keys.append(request.headers.get("x-api-key", ""))
        return httpx.Response(HTTPStatus.OK, json=_ANTHROPIC_OK, request=request)

    def _factory(**kwargs: object) -> anthropic.AsyncAnthropic:
        kwargs["http_client"] = httpx.AsyncClient(transport=httpx.MockTransport(_handle))
        return real_client(**cast("dict[str, Any]", kwargs))

    monkeypatch.setenv("BOTMASON_PROVIDER", "anthropic")
    monkeypatch.setenv("LLM_MODEL", "claude-sonnet-5")
    monkeypatch.setattr(botmason.anthropic, "AsyncAnthropic", _factory)
    return keys


@pytest.mark.asyncio
async def test_compromised_llm_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """Switch on, swap the key, switch off: the next call carries only the new key."""
    steps: list[str] = []
    keys = _record_anthropic_keys(monkeypatch)
    monkeypatch.setenv("LLM_API_KEY", _OLD_KEY)
    await botmason.generate_response("before", [])
    assert keys == [_OLD_KEY]

    suspend_ai(monkeypatch)
    steps.append("suspend")
    with pytest.raises(botmason.ExternalAISuspendedError):
        await botmason.generate_response("during", [])
    monkeypatch.setenv("LLM_API_KEY", _NEW_KEY)
    steps.append("swap key")
    monkeypatch.delenv(EXTERNAL_AI_SUSPEND_ENV_VAR)
    steps.append("resume")
    await botmason.generate_response("after", [])

    assert keys == [_OLD_KEY, _NEW_KEY]
    assert steps == ["suspend", "swap key", "resume"]


# --- (c) compromised user session -----------------------------------------------


@pytest.mark.asyncio
async def test_compromised_session_revoked_by_password_changed_at(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Before: the stolen bearer reads the journal. After ``password_changed_at``: it cannot."""
    steps: list[str] = []
    stolen, user_id, _ = await signup(async_client, "stolen_session")
    before = await async_client.get("/journal/", headers=stolen)
    assert before.status_code == HTTPStatus.OK, "the stolen bearer never worked: nothing to revoke"
    steps.append("stolen bearer reads the journal")

    user = await db_session.get(User, user_id)
    assert user is not None
    user.password_changed_at = datetime.now(UTC) + timedelta(seconds=1)
    db_session.add(user)
    await db_session.commit()
    steps.append("set password_changed_at")

    after = await async_client.get("/journal/", headers=stolen)

    assert after.status_code == HTTPStatus.UNAUTHORIZED
    assert steps == ["stolen bearer reads the journal", "set password_changed_at"]


# --- (d) budget exhaustion --------------------------------------------------------


@pytest.mark.asyncio
async def test_budget_exhaustion_ceiling_zero_then_switch_for_byok(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Ceiling 0 stops server-paid passes but not BYOK; only the switch stops both."""
    steps: list[str] = []
    stub = arm_anthropic(monkeypatch)
    headers, user_id, _ = await signup(async_client, "budget")
    monkeypatch.setenv(DAILY_GENERATION_CEILING_ENV, "0")
    steps.append(f"set {DAILY_GENERATION_CEILING_ENV}=0")

    paid = await _resonate(async_client, headers, await seed_entry(db_session, user_id))
    assert paid.status_code == HTTPStatus.TOO_MANY_REQUESTS, paid.text
    assert paid.json()["detail"] == DAILY_GENERATION_LIMIT_REACHED
    assert stub.request_count == 0

    byok = await _resonate(async_client, headers, await seed_entry(db_session, user_id), _BYOK)
    assert byok.status_code == HTTPStatus.OK, byok.text
    dialled = stub.request_count
    assert dialled >= 1, "BYOK should still dial under ceiling 0: that is the gap"
    steps.append("BYOK still dials")

    suspend_ai(monkeypatch)
    steps.append(f"set {EXTERNAL_AI_SUSPEND_ENV_VAR}")
    refused = await _resonate(async_client, headers, await seed_entry(db_session, user_id), _BYOK)

    assert refused.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert refused.json() == {"detail": AI_SUSPENDED_DETAIL}
    assert stub.request_count == dialled
    assert steps == [
        f"set {DAILY_GENERATION_CEILING_ENV}=0",
        "BYOK still dials",
        f"set {EXTERNAL_AI_SUSPEND_ENV_VAR}",
    ]


# --- (e) false model readiness at the vault --------------------------------------


@pytest.mark.asyncio
async def test_false_model_readiness_contained_by_vault_send_switch(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Before: a vault claiming readiness receives the writing. After the switch: nothing."""
    steps: list[str] = []
    recorder = _VaultRecorder()
    vault = await handshaken_vault(recorder)
    app.dependency_overrides[get_creek_vault_client] = lambda: vault
    headers, _, _ = await signup(async_client, "false_ready")
    monkeypatch.delenv(VAULT_SEND_SUSPEND_ENV_VAR, raising=False)

    before = await async_client.post(
        "/journal/", json={"message": "Written before anyone noticed."}, headers=headers
    )
    assert before.status_code == HTTPStatus.CREATED, before.text
    sent = recorder.methods().count("PUT")
    assert sent >= 1, "the vault never received the writing: nothing to contain"
    steps.append("vault receives journal content")

    suspend_vault(monkeypatch)
    steps.append(f"set {VAULT_SEND_SUSPEND_ENV_VAR}")
    after = await async_client.post(
        "/journal/", json={"message": "Written while the vault is suspect."}, headers=headers
    )

    assert after.status_code == HTTPStatus.CREATED, after.text
    row = await db_session.get(JournalEntry, int(after.json()["id"]))
    assert row is not None
    assert row.vault_ref is None
    assert recorder.methods().count("PUT") == sent
    assert steps == ["vault receives journal content", f"set {VAULT_SEND_SUSPEND_ENV_VAR}"]


# --- (f) stuck deletion -------------------------------------------------------------


@pytest.mark.asyncio
async def test_stuck_deletion_visible_and_withdraw_continues(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A deletion stuck for days shows its true age, and withdrawals land under suspension."""
    steps: list[str] = []
    admin = await _admin(async_client, db_session, "teardown_admin")
    requested = datetime.now(UTC) - _STUCK_FOR
    db_session.add(
        VaultTeardownReceipt(
            creek_job_id="job-stuck-incident",
            state="deleting",
            attempts=4,
            retryable=True,
            requested_at=requested,
            updated_at=datetime.now(UTC),
        )
    )
    await db_session.commit()
    steps.append("deletion stuck for three days, retried moments ago")

    suspend_ai(monkeypatch)
    suspend_vault(monkeypatch)
    steps.append("set both suspension switches")
    listed = await async_client.get("/admin/vault-teardowns", headers=admin)
    steps.append("list teardowns")

    assert listed.status_code == HTTPStatus.OK, listed.text
    (row,) = listed.json()
    assert row["state"] == "deleting"
    pending_since = datetime.fromisoformat(row["pending_since"])
    assert pending_since.replace(tzinfo=UTC) == requested.replace(tzinfo=UTC)

    recorder = _VaultRecorder()
    vault = await handshaken_vault(recorder)
    await vault.withdraw_journal_entry(_WITHDRAWN_ENTRY)
    steps.append("withdraw the entry")

    assert recorder.methods() == ["GET", "DELETE"]
    assert steps == [
        "deletion stuck for three days, retried moments ago",
        "set both suspension switches",
        "list teardowns",
        "withdraw the entry",
    ]


# --- (g) vendor policy change -------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("api_key", "vendor"),
    [(ANTHROPIC_KEY, "anthropic"), (OPENAI_KEY, "openai"), (None, "anthropic")],
)
async def test_vendor_policy_change(
    monkeypatch: pytest.MonkeyPatch, api_key: str | None, vendor: str
) -> None:
    """Before: the vendor is reached. After the switch: no client for it is built."""
    steps: list[str] = []
    use_openai(monkeypatch, HTTPStatus.OK, _OPENAI_OK)
    arm_anthropic(monkeypatch)
    # Each vendor's own default model, so a BYOK key of either kind is servable.
    monkeypatch.delenv("LLM_MODEL")
    built = record_constructions(monkeypatch)

    await botmason.generate_response("before", [], api_key=api_key)
    assert built == [vendor], "the vendor was never reached: nothing to stop"
    steps.append(f"{vendor} reached")

    suspend_ai(monkeypatch)
    steps.append(f"set {EXTERNAL_AI_SUSPEND_ENV_VAR}")
    with pytest.raises(botmason.ExternalAISuspendedError):
        await botmason.generate_response("after", [], api_key=api_key)

    assert built == [vendor]
    assert steps == [f"{vendor} reached", f"set {EXTERNAL_AI_SUSPEND_ENV_VAR}"]
