"""A vault-bound writer's AI operations are answered by their vault or not at all (#3061, #3078).

The defect this suite closes: a writer who connected a vault had every resonance
pass quietly re-asked of the app's own model provider whenever the vault said
nothing, failed, was still provisioning, or was not asked at all (a distress
flag, an unknown tier) -- and completion detection always went to the app
provider, vault or not. None of that was visible to them.

Every case here is asserted at the one seam every app-provider dial crosses:
:func:`services.marginalia.generate_response` (the resonance, detection and
essay adapter) and :func:`services.frequency_classification.generate_response`
(the classifier). Both are replaced by a recording sink installed *after* signup
and entry creation, so the sink sees exactly the pass under test. A sink that
recorded nothing is only evidence if it can record something, which is what
:func:`test_no_vault_still_uses_app_provider` proves: same sink, no vault, calls
recorded.

The vault-bound boundary is set two ways on purpose. Most cases override the
:func:`~dependencies.creek_vault.get_reflection_boundary` dependency, to pin the
route's behaviour for each vault outcome. The not-ready, undialable and
deployment-owner cases override nothing about the boundary, so they pin the
resolver too -- those are exactly the cases where the vault client the route is
served cannot tell "chose a vault" from "has none".
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncGenerator
from dataclasses import dataclass, field
from datetime import date
from http import HTTPStatus

import httpx
import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from dependencies.creek_vault import (
    OWNER_ENV_VAR,
    get_creek_vault_client,
    get_reflection_boundary,
)
from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
    CreekCapabilityUnsupportedError,
    CreekVaultAuthError,
    CreekVaultCareEscalationError,
    CreekVaultContractError,
    CreekVaultPayloadError,
    CreekVaultUnavailableError,
    VaultReflection,
    VaultReflectionNote,
    VaultReflectionStatus,
    VaultTierCeiling,
)
from domain.resonance import NO_NOTES_MESSAGES, NoNotesReason
from main import app
from models.completion_suggestion import CompletionSuggestion
from models.goal import Goal
from models.habit import Habit
from models.marginalia import Marginalia
from models.user import User
from models.wallet_audit import REASON_REFUND_FAILED_RESONANCE, REASON_SPEND_MONTHLY, WalletAudit
from routers import journal as journal_router
from services import creek_vault_reflect, creek_vault_url_resolution
from services import frequency_classification as frequency_classification_service
from services import marginalia as marginalia_service
from services.botmason import STUB_MODEL_NAME, LLMResponse
from services.creek_vault_client import HttpCreekVaultClient
from services.reflection_boundary import (
    REFLECTION_SOURCE_UNAVAILABLE,
    ReflectionBoundary,
    VaultSourceUnavailableReason,
)
from services.usage import get_monthly_cap
from services.user_vault_config import store_vault_config
from tests.support.reflecting_vault import (
    DEFAULT_REFLECT_CAPABILITIES,
    ReflectingVaultClient,
    empty_reflection,
)

_PASSWORD = "secret12345"  # pragma: allowlist secret
_BODY = "I meditated for twenty minutes by the river and the willow bent without breaking."
_QUOTE = "the willow bent without breaking"
_VAULT_NOTE = "The vault reads: you bend and return."
_CLOUD_NOTE = "SENTINEL_APP_PROVIDER_NOTE"
_DISTRESS_BODY = "I keep thinking I want to kill myself and end my life tonight."
# A syntactically valid, synthetic BYOK key: it is never sent anywhere, and the
# point of every case carrying it is that it authorizes nothing.
_BYOK_HEADER = "X-LLM-API-Key"
_BYOK_KEY = "sk-abcdef1234567890abcdef1234567890"  # pragma: allowlist secret
_VAULT_URL = "https://vault.example.test"
_VAULT_KEY = "creek-vault-boundary-key"  # pragma: allowlist secret
_CAPABILITIES_PATH = "/v1/capabilities"
# A loopback answer for a stored vault host: this server must never dial it.
_PRIVATE_ADDRESS = "127.0.0.1"

# Resonance: one notes call and one detection call when a candidate exists.
_APP_PROVIDER_RESONANCE_CALLS = 2
_APP_PROVIDER_DETECT_CALLS = 1


@dataclass
class _Sink:
    """Records every app-provider dial; answers notes or an empty hit list."""

    calls: list[str] = field(default_factory=list)


def _install_sink(monkeypatch: pytest.MonkeyPatch) -> _Sink:
    """Replace both app-provider seams with one recorder. Install after setup."""
    sink = _Sink()
    notes = json.dumps({"notes": [{"kind": "theme", "quote": _QUOTE, "note": _CLOUD_NOTE}]})
    hits = json.dumps({"hits": []})

    async def _record(prompt: str = "", *_args: object, **kwargs: object) -> LLMResponse:
        system_prompt = kwargs.get("system_prompt")
        task = f"{system_prompt or ''}\n{prompt}"
        sink.calls.append(prompt)
        text = hits if '"hits"' in task or "COMPLETED" in task else notes
        return LLMResponse(
            text=text,
            provider="stub",
            model=STUB_MODEL_NAME,
            prompt_tokens=0,
            completion_tokens=0,
        )

    monkeypatch.setattr(marginalia_service, "generate_response", _record)
    monkeypatch.setattr(frequency_classification_service, "generate_response", _record)
    return sink


def _vault_bound(fake_vault: object) -> None:
    """Serve ``fake_vault`` and bind the caller's AI operations to it."""
    app.dependency_overrides[get_creek_vault_client] = lambda: fake_vault
    app.dependency_overrides[get_reflection_boundary] = lambda: ReflectionBoundary.VAULT_BOUND


def _note_reflection(*notes: VaultReflectionNote) -> VaultReflection:
    """An ``OK`` reflection carrying ``notes``."""
    return VaultReflection(
        status=VaultReflectionStatus.OK,
        notes=notes,
        essay=None,
        essay_grounded=False,
        routed_tier=VaultTierCeiling.PERSONAL,
    )


async def _signup(client: AsyncClient, username: str) -> dict[str, str]:
    """Sign up and return an Authorization header."""
    resp = await client.post(
        "/auth/signup", json={"email": f"{username}@example.com", "password": _PASSWORD}
    )
    assert resp.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {resp.json()['token']}"}


async def _user(session: AsyncSession, username: str) -> User:
    """The persisted user row for ``username``."""
    return (
        await session.execute(select(User).where(col(User.email) == f"{username}@example.com"))
    ).scalar_one()


async def _create_entry(client: AsyncClient, headers: dict[str, str], body: str = _BODY) -> int:
    """Create a personal entry and return its id."""
    resp = await client.post(
        "/journal/", json={"message": body, "classification": "personal"}, headers=headers
    )
    assert resp.status_code == HTTPStatus.CREATED
    return int(resp.json()["id"])


async def _seed_candidate(session: AsyncSession, user_id: int) -> None:
    """Seed one active habit, so a detection pass has a candidate to send."""
    habit = Habit(
        name="Meditation",
        icon="🧘",
        start_date=date(2025, 1, 1),
        energy_cost=1,
        energy_return=2,
        user_id=user_id,
    )
    session.add(habit)
    await session.commit()
    await session.refresh(habit)
    session.add(
        Goal(
            habit_id=habit.id,
            title="clear",
            tier="clear",
            target=20.0,
            target_unit="minutes",
            frequency=1.0,
            frequency_unit="per_day",
            is_additive=True,
        )
    )
    await session.commit()


@dataclass(frozen=True)
class _Writer:
    """One signed-up writer with an entry and a detection candidate."""

    username: str
    headers: dict[str, str]
    user_id: int
    entry_id: int


async def _writer(
    client: AsyncClient, session: AsyncSession, username: str, body: str = _BODY
) -> _Writer:
    """Sign up, seed a candidate, and write one entry."""
    headers = await _signup(client, username)
    user = await _user(session, username)
    assert user.id is not None
    await _seed_candidate(session, user.id)
    entry_id = await _create_entry(client, headers, body)
    return _Writer(username=username, headers=headers, user_id=user.id, entry_id=entry_id)


async def _assert_refunded_failure(
    client: AsyncClient, session: AsyncSession, writer: _Writer
) -> None:
    """The pass charged, compensated, persisted nothing, and left the entry intact."""
    await session.rollback()
    user = await _user(session, writer.username)
    assert user.monthly_messages_used == 0
    reasons = (
        (
            await session.execute(
                select(col(WalletAudit.reason))
                .where(col(WalletAudit.user_id) == writer.user_id)
                .order_by(col(WalletAudit.id))
            )
        )
        .scalars()
        .all()
    )
    assert list(reasons) == [REASON_SPEND_MONTHLY, REASON_REFUND_FAILED_RESONANCE]
    notes = (await session.execute(select(func.count()).select_from(Marginalia))).scalar_one()
    assert notes == 0
    entry = await client.get(f"/journal/{writer.entry_id}", headers=writer.headers)
    assert entry.status_code == HTTPStatus.OK
    assert entry.json()["message"] == _BODY


async def _resonance(client: AsyncClient, writer: _Writer, *, byok: bool = False) -> httpx.Response:
    """POST the resonance pass, optionally carrying a BYOK header."""
    headers = {**writer.headers, _BYOK_HEADER: _BYOK_KEY} if byok else writer.headers
    return await client.post(f"/journal/{writer.entry_id}/resonance", headers=headers)


async def _detect(client: AsyncClient, writer: _Writer, *, byok: bool = False) -> httpx.Response:
    """POST standalone completion detection, optionally carrying a BYOK header."""
    headers = {**writer.headers, _BYOK_HEADER: _BYOK_KEY} if byok else writer.headers
    return await client.post(f"/journal/{writer.entry_id}/suggestions/detect", headers=headers)


# --- notes ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_vault_notes_with_candidates_make_zero_app_provider_calls(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The vault's note renders, and completion detection does not go to the app provider."""
    vault = ReflectingVaultClient(
        reflect_result=_note_reflection(
            VaultReflectionNote(kind="theme", quote=_QUOTE, note=_VAULT_NOTE)
        )
    )
    _vault_bound(vault)
    writer = await _writer(async_client, db_session, "boundary_notes")
    sink = _install_sink(monkeypatch)

    resp = await _resonance(async_client, writer)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert [note["note"] for note in body["marginalia"]] == [_VAULT_NOTE]
    assert body["suggestions"] == []
    assert sink.calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("reflection", "reason"),
    [
        pytest.param(empty_reflection(), NoNotesReason.NOTHING_TO_ADD, id="empty"),
        pytest.param(_note_reflection(), NoNotesReason.NOTHING_TO_ADD, id="ok_zero_notes"),
        pytest.param(
            _note_reflection(
                VaultReflectionNote(kind="theme", quote="never in the body", note=_VAULT_NOTE)
            ),
            None,
            id="ok_unanchorable",
        ),
    ],
)
async def test_a_vault_with_nothing_usable_is_a_refunded_zero_note_pass(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    reflection: VaultReflection,
    reason: NoNotesReason | None,
) -> None:
    """EMPTY, OK with no notes, and OK whose notes do not anchor: zero notes, explained, uncharged.

    Never handed to the app provider to answer instead.
    """
    vault = ReflectingVaultClient(reflect_result=reflection)
    _vault_bound(vault)
    writer = await _writer(async_client, db_session, "boundary_empty")
    sink = _install_sink(monkeypatch)

    resp = await _resonance(async_client, writer)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["marginalia"] == []
    assert body["no_notes_message"] is not None
    if reason is not None:
        assert body["no_notes_message"] == NO_NOTES_MESSAGES[reason]
    assert body["remaining_messages"] == get_monthly_cap()
    # A note that does not anchor earns the pass's one corrective re-ask, and
    # that re-ask goes to the vault too.
    assert vault.reflect_calls
    assert sink.calls == []


# --- the vault cannot answer ----------------------------------------------------


class _TimingOutReflect:
    """A MockTransport handler: a REFLECT-capable handshake, then a timeout on reflect."""

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Answer the capability probe; time out on anything else."""
        if request.url.path == _CAPABILITIES_PATH:
            return httpx.Response(
                HTTPStatus.OK,
                json={
                    "available": True,
                    "capabilities": [c.value for c in DEFAULT_REFLECT_CAPABILITIES],
                    "contract_version": CONTRACT_VERSION,
                    "ontology_version": "1.0.0",
                    "attestation": None,
                },
            )
        message = "reflect timed out"
        raise httpx.ReadTimeout(message, request=request)


@pytest_asyncio.fixture
async def timing_out_vault() -> AsyncGenerator[HttpCreekVaultClient]:
    """A real HTTP vault client whose reflect call times out on the wire."""
    http = httpx.AsyncClient(transport=httpx.MockTransport(_TimingOutReflect()))
    yield HttpCreekVaultClient(_VAULT_URL, _VAULT_KEY, http_client=http)
    await http.aclose()


_FAILING_VAULTS = {
    "unavailable": lambda: ReflectingVaultClient(
        reflect_error=CreekVaultUnavailableError("creek vault call failed")
    ),
    "refused": lambda: ReflectingVaultClient(
        reflect_error=CreekVaultContractError("creek vault rejected the request")
    ),
    "credential": lambda: ReflectingVaultClient(
        reflect_error=CreekVaultAuthError("creek vault rejected our credential")
    ),
    "unreadable": lambda: ReflectingVaultClient(
        reflect_error=CreekVaultPayloadError("creek vault returned an unreadable response")
    ),
    "unsupported": lambda: ReflectingVaultClient(
        reflect_error=CreekCapabilityUnsupportedError("creek vault capability unsupported")
    ),
    "handshake_unavailable": lambda: ReflectingVaultClient(available=False),
    "no_reflect": lambda: ReflectingVaultClient(
        capabilities=frozenset({CreekCapability.JOURNAL, CreekCapability.CLASSIFY})
    ),
}


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", sorted(_FAILING_VAULTS))
async def test_vault_failure_never_falls_back(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    failure: str,
) -> None:
    """Every way the vault can fail is a refunded, retryable 503 -- never the app provider."""
    _vault_bound(_FAILING_VAULTS[failure]())
    writer = await _writer(async_client, db_session, f"boundary_fail_{failure}")
    sink = _install_sink(monkeypatch)

    resp = await _resonance(async_client, writer)

    assert resp.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert resp.json()["detail"] == REFLECTION_SOURCE_UNAVAILABLE
    assert sink.calls == []
    await _assert_refunded_failure(async_client, db_session, writer)


@pytest.mark.asyncio
async def test_a_vault_timeout_on_the_wire_never_falls_back(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    timing_out_vault: HttpCreekVaultClient,
) -> None:
    """A real client timing out mid-reflect is the same refunded 503, through the real adapter."""
    _vault_bound(timing_out_vault)
    writer = await _writer(async_client, db_session, "boundary_timeout")
    sink = _install_sink(monkeypatch)

    resp = await _resonance(async_client, writer)

    assert resp.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert resp.json()["detail"] == REFLECTION_SOURCE_UNAVAILABLE
    assert sink.calls == []
    await _assert_refunded_failure(async_client, db_session, writer)


@pytest.mark.asyncio
@pytest.mark.parametrize("state", ["not_ready", "undialable"])
async def test_not_ready_and_undialable_connections_are_vault_bound(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    state: str,
) -> None:
    """A real connection row the route cannot use is still the writer's choice of vault.

    No override of either dependency: the route is served the local fallback
    client, exactly as for a writer with no vault, and only the resolver's read
    of the row tells them apart. Before #3061 this writer was answered by the app
    provider.
    """
    writer = await _writer(async_client, db_session, f"boundary_{state}")
    if state == "undialable":
        host_url = "https://boundary-undialable.example.test"

        async def _resolves_to_loopback(_host: str) -> tuple[str, ...]:
            return (_PRIVATE_ADDRESS,)

        monkeypatch.setattr(
            creek_vault_url_resolution, "resolve_host_addresses", _resolves_to_loopback
        )
        await store_vault_config(db_session, writer.user_id, vault_url=host_url, api_key=_VAULT_KEY)
    else:
        await store_vault_config(
            db_session, writer.user_id, vault_url=_VAULT_URL, api_key=_VAULT_KEY, provisioned=True
        )
    sink = _install_sink(monkeypatch)

    resp = await _resonance(async_client, writer)
    detect = await _detect(async_client, writer)

    assert resp.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert resp.json()["detail"] == REFLECTION_SOURCE_UNAVAILABLE
    assert detect.status_code == HTTPStatus.OK
    assert detect.json() == {"items": [], "checked": False}
    assert sink.calls == []


@pytest.mark.asyncio
async def test_deployment_owner_env_vault_is_vault_bound(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The deployment-wide vault's bound owner is vault-bound too (E3: the restrictive default).

    The boundary is not overridden: only the environment binding says this
    writer has a vault.
    """
    vault = ReflectingVaultClient(reflect_result=empty_reflection())
    app.dependency_overrides[get_creek_vault_client] = lambda: vault
    writer = await _writer(async_client, db_session, "boundary_deployment_owner")
    monkeypatch.setenv("CREEK_VAULT_URL", _VAULT_URL)
    monkeypatch.setenv(OWNER_ENV_VAR, str(writer.user_id))
    sink = _install_sink(monkeypatch)

    resp = await _resonance(async_client, writer)

    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["marginalia"] == []
    assert len(vault.reflect_calls) == 1
    assert sink.calls == []


# --- not asked at all -----------------------------------------------------------


@pytest.mark.asyncio
async def test_distress_entry_under_vault_boundary_gets_care_without_any_model_call(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Care alone: no vault handshake, no reflect, no app provider, and the charge refunded."""
    vault = ReflectingVaultClient(
        reflect_result=_note_reflection(
            VaultReflectionNote(kind="theme", quote="kill myself", note=_VAULT_NOTE)
        )
    )
    _vault_bound(vault)
    headers = await _signup(async_client, "boundary_distress")
    user = await _user(db_session, "boundary_distress")
    assert user.id is not None
    entry_id = await _create_entry(async_client, headers, _DISTRESS_BODY)
    handshakes_before = vault.handshake_calls
    sink = _install_sink(monkeypatch)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["care"] is not None
    assert body["marginalia"] == []
    assert body["remaining_messages"] == get_monthly_cap()
    assert vault.reflect_calls == []
    assert vault.handshake_calls == handshakes_before
    assert sink.calls == []


@pytest.mark.asyncio
async def test_unknown_classification_under_vault_boundary_fails_closed(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A tier the vault map does not recognize is never widened and never sent elsewhere.

    The database refuses an unrecognized classification outright, so the case is
    driven at the tier map the seam consults: the only place a new tier added on
    one side but not the other would surface.
    """
    vault = ReflectingVaultClient()
    _vault_bound(vault)
    writer = await _writer(async_client, db_session, "boundary_unknown_tier")
    handshakes_before = vault.handshake_calls

    def _unrecognized(classification: str) -> VaultTierCeiling:
        raise ValueError(classification)

    monkeypatch.setattr(creek_vault_reflect, "tier_ceiling_for", _unrecognized)
    sink = _install_sink(monkeypatch)

    resp = await _resonance(async_client, writer)

    assert resp.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert resp.json()["detail"] == REFLECTION_SOURCE_UNAVAILABLE
    assert vault.handshake_calls == handshakes_before
    assert sink.calls == []
    await _assert_refunded_failure(async_client, db_session, writer)


@pytest.mark.asyncio
async def test_vault_care_escalation_still_returns_care_and_refunds(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The vault's own care guard keeps its specialized path: care, refunded, no other model."""
    _vault_bound(ReflectingVaultClient(reflect_error=CreekVaultCareEscalationError()))
    writer = await _writer(async_client, db_session, "boundary_escalation")
    sink = _install_sink(monkeypatch)

    resp = await _resonance(async_client, writer)

    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["care"] is not None
    assert body["marginalia"] == []
    assert body["remaining_messages"] == get_monthly_cap()
    assert sink.calls == []


# --- standalone detection -------------------------------------------------------


@pytest.mark.asyncio
async def test_standalone_detect_under_vault_boundary_is_unchecked_and_silent(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``checked: false`` before any candidate is even read, and no app-provider dial."""
    _vault_bound(ReflectingVaultClient())
    writer = await _writer(async_client, db_session, "boundary_detect")

    async def _must_not_read(*_args: object, **_kwargs: object) -> object:
        msg = "a vault-bound detect read detection candidates"
        raise AssertionError(msg)

    monkeypatch.setattr(journal_router, "_detection_inputs", _must_not_read)
    sink = _install_sink(monkeypatch)

    resp = await _detect(async_client, writer)

    assert resp.status_code == HTTPStatus.OK
    assert resp.json() == {"items": [], "checked": False}
    suggestions = (
        await db_session.execute(select(func.count()).select_from(CompletionSuggestion))
    ).scalar_one()
    assert suggestions == 0
    assert sink.calls == []


# --- a BYOK key is not consent --------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("route", ["resonance", "detect"])
async def test_byok_header_does_not_authorize_fallback_under_vault_boundary(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    route: str,
) -> None:
    """The client attaches a stored key to every request; it pays for calls, it permits none."""
    _vault_bound(ReflectingVaultClient(reflect_result=empty_reflection()))
    writer = await _writer(async_client, db_session, f"boundary_byok_{route}")
    sink = _install_sink(monkeypatch)

    if route == "resonance":
        resp = await _resonance(async_client, writer, byok=True)
        assert resp.json()["marginalia"] == []
    else:
        resp = await _detect(async_client, writer, byok=True)
        assert resp.json() == {"items": [], "checked": False}

    assert resp.status_code == HTTPStatus.OK
    assert sink.calls == []


# --- the guard: with no vault, nothing changed ---------------------------------


@pytest.mark.asyncio
async def test_no_vault_still_uses_app_provider(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No vault, no override: the app provider answers notes and detection, as before.

    Also the proof the sink is live: the same recorder every vault-bound case
    asserts empty records these calls.
    """
    writer = await _writer(async_client, db_session, "boundary_app_provider")
    sink = _install_sink(monkeypatch)

    resp = await _resonance(async_client, writer)

    assert resp.status_code == HTTPStatus.OK
    assert [note["note"] for note in resp.json()["marginalia"]] == [_CLOUD_NOTE]
    assert len(sink.calls) == _APP_PROVIDER_RESONANCE_CALLS

    detect = await _detect(async_client, writer)

    assert detect.status_code == HTTPStatus.OK
    assert detect.json()["checked"] is True
    assert len(sink.calls) == _APP_PROVIDER_RESONANCE_CALLS + _APP_PROVIDER_DETECT_CALLS


@pytest.mark.asyncio
async def test_a_distress_entry_with_no_vault_still_gets_the_app_provider_and_care(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The vault-bound care-only branch does not reach a writer with no vault."""
    headers = await _signup(async_client, "boundary_app_distress")
    entry_id = await _create_entry(async_client, headers, _DISTRESS_BODY)
    sink = _install_sink(monkeypatch)

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["care"] is not None
    assert sink.calls


# --- what the operator sees -----------------------------------------------------


def _record_text(record: logging.LogRecord) -> str:
    """Everything a log record carries, message and extras, as one string."""
    return " ".join(str(value) for value in (record.getMessage(), *record.__dict__.values()))


@pytest.mark.asyncio
async def test_fail_closed_log_lines_are_content_free(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The refusal is countable by a closed-vocabulary reason, and carries no writing or key."""
    _vault_bound(ReflectingVaultClient(available=False))
    writer = await _writer(async_client, db_session, "boundary_logs")
    _install_sink(monkeypatch)
    caplog.set_level(logging.DEBUG)

    resp = await _resonance(async_client, writer, byok=True)

    assert resp.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    refusals = [r for r in caplog.records if r.getMessage() == REFLECTION_SOURCE_UNAVAILABLE]
    assert len(refusals) == 1
    assert getattr(refusals[0], "reason", None) == VaultSourceUnavailableReason.UNAVAILABLE.value
    assert getattr(refusals[0], "entry_id", None) == writer.entry_id
    for record in caplog.records:
        text = _record_text(record)
        assert _BODY not in text
        assert _QUOTE not in text
        assert _BYOK_KEY not in text
