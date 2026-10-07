"""Automated tabletop scenarios for the draft privacy incident runbook (#3075).

Each test plays one scenario from ``docs/ops/privacy-incident-response.md`` §7
through the real application: the incident, the operator's steps, and the safe
state those steps reach. Each test keeps a ``trail``: one entry per step,
pairing the step with what the system was *observed* to do at that point (a
status code, a count of requests that reached a fake, the key a request
carried, a row). The test asserts the whole trail at once, so it fails if the
deployment was never unsafe to begin with, if a step had no effect, or if the
safe state is not reached.

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
    trail: list[tuple[str, object]] = []
    stub = arm_anthropic(monkeypatch)
    headers, user_id, _ = await signup(async_client, "canary")
    admin = await _admin(async_client, db_session, "canary_admin")

    before = await _resonate(async_client, headers, await seed_entry(db_session, user_id))
    trail.append(("resonance before", (before.status_code, stub.request_count > 0)))
    dialled = stub.request_count

    suspend_ai(monkeypatch)
    probe = await async_client.get(_PROBE, headers=admin)
    trail.append(("probe after the switch", probe.json()["external_ai_suspended"]))
    after = await _resonate(async_client, headers, await seed_entry(db_session, user_id))
    trail.append(("resonance after", (after.status_code, after.json()["detail"])))
    trail.append(("new provider requests", stub.request_count - dialled))

    assert trail == [
        ("resonance before", (HTTPStatus.OK, True)),
        ("probe after the switch", True),
        ("resonance after", (HTTPStatus.SERVICE_UNAVAILABLE, AI_SUSPENDED_DETAIL)),
        ("new provider requests", 0),
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


async def _refused(message: str) -> bool:
    """Whether a generation is refused by the suspension, rather than answered."""
    try:
        await botmason.generate_response(message, [])
    except botmason.ExternalAISuspendedError:
        return True
    return False


@pytest.mark.asyncio
async def test_compromised_llm_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """Switch on, swap the key, switch off: the next call carries only the new key."""
    trail: list[tuple[str, object]] = []
    keys = _record_anthropic_keys(monkeypatch)
    monkeypatch.setenv("LLM_API_KEY", _OLD_KEY)
    await botmason.generate_response("before", [])
    trail.append(("keys sent before", list(keys)))

    suspend_ai(monkeypatch)
    trail.append(("refused while suspended", await _refused("during")))
    monkeypatch.setenv("LLM_API_KEY", _NEW_KEY)
    monkeypatch.delenv(EXTERNAL_AI_SUSPEND_ENV_VAR)
    await botmason.generate_response("after", [])
    trail.append(("keys sent after the swap", keys[1:]))

    assert trail == [
        ("keys sent before", [_OLD_KEY]),
        ("refused while suspended", True),
        ("keys sent after the swap", [_NEW_KEY]),
    ]


# --- (c) compromised user session -----------------------------------------------


@pytest.mark.asyncio
async def test_compromised_session_revoked_by_password_changed_at(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Before: the stolen bearer reads the journal. After ``password_changed_at``: it cannot."""
    trail: list[tuple[str, object]] = []
    stolen, user_id, _ = await signup(async_client, "stolen_session")
    before = await async_client.get("/journal/", headers=stolen)
    trail.append(("stolen bearer before", before.status_code))

    user = await db_session.get(User, user_id)
    assert user is not None
    user.password_changed_at = datetime.now(UTC) + timedelta(seconds=1)
    db_session.add(user)
    await db_session.commit()
    after = await async_client.get("/journal/", headers=stolen)
    trail.append(("stolen bearer after password_changed_at", after.status_code))

    assert trail == [
        ("stolen bearer before", HTTPStatus.OK),
        ("stolen bearer after password_changed_at", HTTPStatus.UNAUTHORIZED),
    ]


# --- (d) budget exhaustion --------------------------------------------------------


@pytest.mark.asyncio
async def test_budget_exhaustion_ceiling_zero_then_switch_for_byok(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Ceiling 0 stops server-paid passes but not BYOK; only the switch stops both."""
    trail: list[tuple[str, object]] = []
    stub = arm_anthropic(monkeypatch)
    headers, user_id, _ = await signup(async_client, "budget")

    async def _pass(extra: dict[str, str] | None = None) -> tuple[object, bool]:
        before = stub.request_count
        resp = await _resonate(async_client, headers, await seed_entry(db_session, user_id), extra)
        answer = resp.status_code if resp.is_success else resp.json()["detail"]
        return answer, stub.request_count > before

    monkeypatch.setenv(DAILY_GENERATION_CEILING_ENV, "0")
    trail.append(("server-paid under ceiling 0", await _pass()))
    trail.append(("BYOK under ceiling 0", await _pass(_BYOK)))
    suspend_ai(monkeypatch)
    trail.append(("BYOK under the switch", await _pass(_BYOK)))

    assert trail == [
        ("server-paid under ceiling 0", (DAILY_GENERATION_LIMIT_REACHED, False)),
        ("BYOK under ceiling 0", (HTTPStatus.OK, True)),
        ("BYOK under the switch", (AI_SUSPENDED_DETAIL, False)),
    ]


# --- (e) false model readiness at the vault --------------------------------------


@pytest.mark.asyncio
async def test_false_model_readiness_contained_by_vault_send_switch(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Before: a vault claiming readiness receives the writing. After the switch: nothing."""
    trail: list[tuple[str, object]] = []
    recorder = _VaultRecorder()
    vault = await handshaken_vault(recorder)
    app.dependency_overrides[get_creek_vault_client] = lambda: vault
    headers, _, _ = await signup(async_client, "false_ready")
    monkeypatch.delenv(VAULT_SEND_SUSPEND_ENV_VAR, raising=False)

    async def _write(message: str) -> tuple[int, int, bool]:
        sent = recorder.methods().count("PUT")
        resp = await async_client.post("/journal/", json={"message": message}, headers=headers)
        saved = await db_session.get(JournalEntry, int(resp.json()["id"])) is not None
        return resp.status_code, recorder.methods().count("PUT") - sent, saved

    trail.append(("write before", await _write("Written before anyone noticed.")))
    suspend_vault(monkeypatch)
    trail.append(("write under the switch", await _write("Written while the vault is suspect.")))

    assert trail == [
        ("write before", (HTTPStatus.CREATED, 1, True)),
        ("write under the switch", (HTTPStatus.CREATED, 0, True)),
    ]


# --- (f) stuck deletion -------------------------------------------------------------


@pytest.mark.asyncio
async def test_stuck_deletion_visible_and_withdraw_continues(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A deletion stuck for days shows its true age, and withdrawals land under suspension."""
    trail: list[tuple[str, object]] = []
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

    suspend_ai(monkeypatch)
    suspend_vault(monkeypatch)
    listed = await async_client.get("/admin/vault-teardowns", headers=admin)
    (row,) = listed.json()
    pending_since = datetime.fromisoformat(row["pending_since"]).replace(tzinfo=UTC)
    trail.append(("teardown listed", (listed.status_code, row["state"], pending_since)))

    recorder = _VaultRecorder()
    vault = await handshaken_vault(recorder)
    await vault.withdraw_journal_entry(_WITHDRAWN_ENTRY)
    trail.append(("withdrawal under both switches", recorder.methods()))

    assert trail == [
        ("teardown listed", (HTTPStatus.OK, "deleting", requested.replace(tzinfo=UTC))),
        ("withdrawal under both switches", ["GET", "DELETE"]),
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
    trail: list[tuple[str, object]] = []
    use_openai(monkeypatch, HTTPStatus.OK, _OPENAI_OK)
    arm_anthropic(monkeypatch)
    # Each vendor's own default model, so a BYOK key of either kind is servable.
    monkeypatch.delenv("LLM_MODEL")
    built = record_constructions(monkeypatch)

    await botmason.generate_response("before", [], api_key=api_key)
    trail.append(("clients built before", list(built)))
    suspend_ai(monkeypatch)
    with pytest.raises(botmason.ExternalAISuspendedError):
        await botmason.generate_response("after", [], api_key=api_key)
    trail.append(("clients built under the switch", built[1:]))

    assert trail == [
        ("clients built before", [vendor]),
        ("clients built under the switch", []),
    ]
