"""One test per live census row: the request's transaction must be closed at the dial.

The census itself -- all twenty-three rows, including the safe ones and why they
are safe -- lives in the observer's own docstring, at
``tests/support/outbound_boundary.py``. This file is its executable half: each
row here drives the real route and asks the observer what the request was
holding at the moment it dialled out.

A row known to be defective ships under ``xfail(strict=True, raises=...)``. That
is not a skip and must not be read as one. A skipped test does not run; these
run, on every suite, and assert exactly the same property as the rows that pass.
The marker records a red row rather than hiding it, and it is strict, so the day
somebody fixes a row the expected failure becomes an unexpected pass and the
build goes red until the census is corrected. The alternative -- shipping seven
genuine failures on day one -- produces a gate that gets disabled rather than
obeyed.

``raises=ConnectionHeldAcrossOutboundCallError`` is the other half of that bargain,
and it is what keeps an expected-red row honest. Only the property assertion
raises that type; a broken happy path, or a leaf the test never reached, raises
a plain ``AssertionError``, which does not match, so the row fails loudly
instead of xfailing for a reason nobody intended. An expected failure that could
be satisfied by a setup mistake would teach nobody anything.
"""

from __future__ import annotations

import base64
import json
from collections.abc import Iterator, Sequence
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from dependencies.creek_vault import get_creek_vault_client
from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
    HandshakeResult,
    VaultIngestAction,
    VaultReflection,
    VaultReflectionNote,
    VaultReflectionStatus,
    VaultTierCeiling,
    VaultUploadRequest,
    VaultUploadResult,
    VaultWheelAspect,
    VaultWheelBalance,
)
from main import app
from models.course_stage import CourseStage
from models.journal_entry import JournalEntry
from models.marginalia import Marginalia, MarginaliaKind
from routers import auth as auth_router
from services import marginalia as marginalia_service
from services.botmason import STUB_MODEL_NAME, LLMResponse
from services.email import RecordingEmailSender
from services.oidc import OIDCIdentity
from tests.helpers.password_reset import extract_reset_token
from tests.support.outbound_boundary import (
    ConnectionHeldAcrossOutboundCallError,
    Observation,
    OutboundBoundaryObserver,
    assert_dialled_off_the_pool,
    observe_outbound_boundaries,
)
from tests.transcription_helpers import (
    JPEG_BYTES,
    patch_generate_response,
    priced_response,
)
from tests.transcription_helpers import (
    payload as transcribe_payload,
)
from tests.vault_client_doubles import NoPipelineVaultDouble

_TOTAL_STAGES = 10
_PASSWORD = "securepassword123"  # pragma: allowlist secret
_NEW_PASSWORD = "fresh-horse-battery-staple"  # pragma: allowlist secret
_VAULT_URL = "https://vault.example.test"
_VAULT_KEY = "outbound-boundary-key"  # pragma: allowlist secret

_BODY = "I walked by the river and the willow bent without breaking."
_QUOTE = "I walked by the river"

_ASPECTS = (
    "Body",
    "Body",
    "Emotion",
    "Emotion",
    "Mind",
    "Mind",
    "Spirit",
    "Spirit",
    "Nondual",
    "Nondual",
)

# Census keys the observer records, named once so a row asserts on the leaf it
# is about rather than on whatever else the same request happened to dial.
_LLM = "services.botmason.generate_response"
_LICENSE = "domain.entitlements.verify_aptitude_license"
_HANDSHAKE = "CreekVaultClient.handshake"
_REFLECT = "CreekVaultClient.reflect"
_WHEEL = "CreekVaultClient.wheel"
_UPLOAD = "CreekVaultClient.upload"
_SEND = "EmailSender.send"


@pytest.fixture
def outbound_boundary(async_client: AsyncClient) -> Iterator[OutboundBoundaryObserver]:
    """Install the observer for the length of one test.

    Depends on ``async_client`` so the client's own ``get_session`` override is
    already registered when the observer takes the overrides mapping, and so the
    observer is removed again *before* that fixture asserts the mapping is empty.
    """
    del async_client
    with observe_outbound_boundaries(app) as observer:
        yield observer
        # At teardown, so a genuine failure is never masked by this: a finalizer
        # runs on every outcome, and a test that already failed reports both.
        # A leaf the observer could not wrap records nothing, and nothing is what
        # a clean site records too -- so an uninstrumentable leaf must be news.
        assert not observer.uninstrumentable, (
            f"the observer could not instrument {observer.uninstrumentable}; "
            "a leaf it cannot wrap is silent, and silence reads as clean"
        )


def _at(observer: OutboundBoundaryObserver, *leaves: str) -> Sequence[Observation]:
    """Return only the observations made at the named leaves."""
    return [record for record in observer.observations if record.leaf in leaves]


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    """Create a user and return its auth headers and id."""
    resp = await client.post(
        "/auth/signup",
        json={"email": f"{username}@example.com", "password": _PASSWORD},
    )
    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()
    return {"Authorization": f"Bearer {body['token']}"}, int(body["user_id"])


async def _create_entry(client: AsyncClient, headers: dict[str, str]) -> int:
    """Create one journal entry through the real route and return its id."""
    resp = await client.post("/journal/", json={"message": _BODY}, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED, resp.text
    return int(resp.json()["id"])


async def _seed_all_stages(db_session: AsyncSession) -> None:
    """Insert the ten course stages the wheel relabels its answer from."""
    for number in range(1, _TOTAL_STAGES + 1):
        db_session.add(
            CourseStage(
                title=f"Stage {number}",
                subtitle="sub",
                stage_number=number,
                overview_url="",
                category="test",
                aspect=_ASPECTS[number - 1],
                spiral_dynamics_color="beige",
                growing_up_stage="archaic",
                divine_gender_polarity="masculine",
                relationship_to_free_will="active",
                free_will_description="desc",
            )
        )
    await db_session.commit()


async def _seed_marginalia(session: AsyncSession, user_id: int) -> int:
    """Seed one journal entry and one margin note on it, returning the note's id."""
    entry = JournalEntry(sender="user", user_id=user_id, message=_BODY)
    session.add(entry)
    await session.flush()
    note = Marginalia(
        journal_entry_id=entry.id,
        user_id=user_id,
        kind=MarginaliaKind.SYMBOL,
        anchor_start=0,
        anchor_end=6,
        anchor_text="I walk",
        note="A beginning.",
    )
    session.add(note)
    await session.commit()
    await session.refresh(note)
    assert note.id is not None
    return note.id


def _bind_deployment_vault(monkeypatch: pytest.MonkeyPatch, user_id: int) -> None:
    """Configure the deployment-wide vault and bind it to this user.

    The condition under which the vault dependency takes its ``connection is
    None`` exit: no personal connection row, a configured vault, and this user
    named as its owner.
    """
    monkeypatch.setenv("CREEK_VAULT_URL", _VAULT_URL)
    monkeypatch.setenv("CREEK_VAULT_API_KEY", _VAULT_KEY)
    monkeypatch.setenv("CREEK_VAULT_OWNER_USER_ID", str(user_id))


def _full_wheel() -> VaultWheelBalance:
    """A structurally valid wheel carrying signal on every stage."""
    return VaultWheelBalance(
        aspects=tuple(
            VaultWheelAspect(stage_number=n, aspect=f"VaultAspect-{n}", fullness=0.9)
            for n in range(1, _TOTAL_STAGES + 1)
        )
    )


class _ScriptedVault(NoPipelineVaultDouble):
    """One vault double, scripted per row, serving only the verbs its row reaches."""

    def __init__(
        self,
        *,
        capabilities: frozenset[CreekCapability] = frozenset(),
        wheel_result: VaultWheelBalance | None = None,
        reflect_result: VaultReflection | None = None,
        upload_result: VaultUploadResult | None = None,
    ) -> None:
        """Bind the advertised capabilities and the scripted answers."""
        self._capabilities = capabilities
        self._wheel_result = wheel_result
        self._reflect_result = reflect_result
        self._upload_result = upload_result

    async def handshake(self) -> HandshakeResult:
        """Report an available vault advertising the scripted capabilities."""
        return HandshakeResult(
            available=True,
            contract_version=CONTRACT_VERSION,
            ontology_version="1.0.0",
            capabilities=self._capabilities,
            attestation=None,
        )

    def is_available(self) -> bool:
        """Report the vault reachable."""
        return True

    def supports(self, capability: CreekCapability, /) -> bool:
        """Report whether the scripted capability set advertises ``capability``."""
        return capability in self._capabilities

    async def wheel(self) -> VaultWheelBalance:
        """Return the scripted balance."""
        assert self._wheel_result is not None, "this double was not scripted for the wheel"
        return self._wheel_result

    async def reflect(self, body: str, tier_ceiling: VaultTierCeiling, /) -> VaultReflection:
        """Return the scripted reflection."""
        del body, tier_ceiling
        assert self._reflect_result is not None, "this double was not scripted to reflect"
        return self._reflect_result

    async def upload(self, request: VaultUploadRequest, /) -> VaultUploadResult:
        """Return the scripted upload result."""
        del request
        assert self._upload_result is not None, "this double was not scripted to upload"
        return self._upload_result


# ---------------------------------------------------------------------------
# Rows closed by this change: the vault dependency now releases on both exits.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_deployment_wide_vault_wheel_is_dialled_off_the_pool(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    outbound_boundary: OutboundBoundaryObserver,
) -> None:
    """Census row 7: GET /stages/wheel, for a caller served the deployment-wide vault.

    The vault dependency used to commit on the exit that reads a personal
    connection row and return without committing on the exit that does not, so
    this branch reached the handler still carrying the revocation SELECT's
    transaction and the connection lookup's own, and nothing released it before
    the handshake.

    ``build_creek_vault_client`` is substituted rather than the whole dependency,
    because overriding ``get_creek_vault_client`` would replace the very code
    whose transaction handling is under test.
    """
    await _seed_all_stages(db_session)
    headers, user_id = await _signup(async_client, "wheel_boundary")
    _bind_deployment_vault(monkeypatch, user_id)
    vault = _ScriptedVault(
        capabilities=frozenset({CreekCapability.WHEEL}), wheel_result=_full_wheel()
    )
    monkeypatch.setattr("dependencies.creek_vault.build_creek_vault_client", lambda: vault)
    outbound_boundary.reset()

    resp = await async_client.get("/stages/wheel", headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert_dialled_off_the_pool(
        _at(outbound_boundary, _HANDSHAKE, _WHEEL), what="the vault wheel dial"
    )


@pytest.mark.asyncio
async def test_the_deployment_wide_vault_upload_is_dialled_off_the_pool(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    outbound_boundary: OutboundBoundaryObserver,
) -> None:
    """Census row 8: POST /corpus/import, on the same deployment-wide-vault branch.

    The same uncommitted dependency exit as row 7, and the router's own commit
    comes *after* the upload rather than before it -- so the fix has to live in
    the dependency, which is where both rows meet. One line closes both.
    """
    headers, user_id = await _signup(async_client, "import_boundary")
    _bind_deployment_vault(monkeypatch, user_id)
    vault = _ScriptedVault(
        capabilities=frozenset({CreekCapability.JOURNAL, CreekCapability.UPLOAD}),
        upload_result=VaultUploadResult(
            stored=True,
            vault_ref="vault-ref-boundary-1",
            action=VaultIngestAction.CREATED,
            tags=(),
        ),
    )
    monkeypatch.setattr("dependencies.creek_vault.build_creek_vault_client", lambda: vault)
    outbound_boundary.reset()

    resp = await async_client.post(
        "/corpus/import",
        json={
            "filename": "field-notes.pdf",
            "content_base64": base64.b64encode(b"%PDF-1.7 a page of field notes").decode("ascii"),
            "classification": "personal",
        },
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.ACCEPTED, resp.text
    assert_dialled_off_the_pool(
        _at(outbound_boundary, _HANDSHAKE, _UPLOAD), what="the vault upload dial"
    )


# ---------------------------------------------------------------------------
# Rows still defective. Each runs; each asserts; each is expected red.
# ---------------------------------------------------------------------------


@pytest.mark.xfail(
    strict=True,
    raises=ConnectionHeldAcrossOutboundCallError,
    reason=(
        "Census row 1: run_resonance loads the entry, stages an uncommitted wallet "
        "deduction and gathers grounding before probing the vault's capabilities, "
        "and its first commit is far below. The handler's atomicity argument covers "
        "the reflection pass that follows, not this probe: a handshake's result is "
        "not something a rollback can undo."
    ),
)
@pytest.mark.asyncio
async def test_the_resonance_vault_handshake_is_dialled_off_the_pool(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    outbound_boundary: OutboundBoundaryObserver,
) -> None:
    """Census row 1: POST /journal/{entry_id}/resonance, at the capability probe."""
    vault = _ScriptedVault(capabilities=frozenset())
    app.dependency_overrides[get_creek_vault_client] = lambda: vault
    headers, _user_id = await _signup(async_client, "resonance_handshake")
    entry_id = await _create_entry(async_client, headers)

    async def _complete(
        prompt: str, history: object, *, system_prompt: object, api_key: object
    ) -> LLMResponse:
        del prompt, history, system_prompt, api_key
        return LLMResponse(
            text=json.dumps({"notes": [{"kind": "theme", "quote": _QUOTE, "note": "It holds."}]}),
            provider="stub",
            model=STUB_MODEL_NAME,
            prompt_tokens=0,
            completion_tokens=0,
        )

    monkeypatch.setattr(marginalia_service, "generate_response", _complete)
    outbound_boundary.reset()

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert_dialled_off_the_pool(_at(outbound_boundary, _HANDSHAKE), what="the vault handshake")


@pytest.mark.xfail(
    strict=True,
    raises=ConnectionHeldAcrossOutboundCallError,
    reason=(
        "Census row 2: the same open, write-holding transaction is held across the "
        "whole reflection pass. Unlike the handshake above this is a trade the "
        "handler argues for -- the pass, the persistence and the charge commit "
        "together so a provider error never charges -- which makes it a candidate "
        "for a reasoned allowlist entry rather than a fix."
    ),
)
@pytest.mark.asyncio
async def test_the_resonance_reflection_pass_is_dialled_off_the_pool(
    async_client: AsyncClient,
    outbound_boundary: OutboundBoundaryObserver,
) -> None:
    """Census row 2: POST /journal/{entry_id}/resonance, at the reflection itself."""
    vault = _ScriptedVault(
        capabilities=frozenset({CreekCapability.REFLECT}),
        reflect_result=VaultReflection(
            status=VaultReflectionStatus.OK,
            notes=(VaultReflectionNote(kind="theme", quote=_QUOTE, note="You return to water."),),
            essay=None,
            essay_grounded=False,
            routed_tier=VaultTierCeiling.PERSONAL,
        ),
    )
    app.dependency_overrides[get_creek_vault_client] = lambda: vault
    headers, _user_id = await _signup(async_client, "resonance_reflect")
    entry_id = await _create_entry(async_client, headers)
    outbound_boundary.reset()

    resp = await async_client.post(f"/journal/{entry_id}/resonance", headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert_dialled_off_the_pool(_at(outbound_boundary, _REFLECT), what="the vault reflection pass")


@pytest.mark.xfail(
    strict=True,
    raises=ConnectionHeldAcrossOutboundCallError,
    reason=(
        "Census row 3: _cache_essay runs two SELECTs, then the language model, then "
        "a commit. Nothing about an essay is transactional; the commit is simply on "
        "the wrong side of the call."
    ),
)
@pytest.mark.asyncio
async def test_the_essay_llm_is_dialled_off_the_pool(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    outbound_boundary: OutboundBoundaryObserver,
) -> None:
    """Census row 3: POST /journal/marginalia/{marginalia_id}/essay."""
    headers, user_id = await _signup(async_client, "essay_boundary")
    note_id = await _seed_marginalia(db_session, user_id)

    async def _essay(
        prompt: str, history: object, *, system_prompt: object, api_key: object
    ) -> LLMResponse:
        del prompt, history, system_prompt, api_key
        return LLMResponse(
            text="A warm letter about beginnings.",
            provider="stub",
            model=STUB_MODEL_NAME,
            prompt_tokens=0,
            completion_tokens=0,
        )

    monkeypatch.setattr(marginalia_service, "generate_response", _essay)
    outbound_boundary.reset()

    resp = await async_client.post(f"/journal/marginalia/{note_id}/essay", headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert_dialled_off_the_pool(_at(outbound_boundary, _LLM), what="the essay dial")


@pytest.mark.xfail(
    strict=True,
    raises=ConnectionHeldAcrossOutboundCallError,
    reason=(
        "Census row 4: _gather_aggregates evaluates its four arguments in order -- "
        "three database gathers, then the vault -- so the transaction is open at the "
        "dial regardless of which branch the vault dependency took. On a polled list "
        "endpoint."
    ),
)
@pytest.mark.asyncio
async def test_the_invitation_corpus_themes_are_dialled_off_the_pool(
    async_client: AsyncClient,
    outbound_boundary: OutboundBoundaryObserver,
) -> None:
    """Census row 4: GET /invitations."""
    vault = _ScriptedVault(
        capabilities=frozenset({CreekCapability.WHEEL}), wheel_result=_full_wheel()
    )
    app.dependency_overrides[get_creek_vault_client] = lambda: vault
    headers, _user_id = await _signup(async_client, "invitations_boundary")
    outbound_boundary.reset()

    resp = await async_client.get("/invitations", headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert_dialled_off_the_pool(
        _at(outbound_boundary, _HANDSHAKE, _WHEEL), what="the invitation corpus-theme read"
    )


@pytest.mark.xfail(
    strict=True,
    raises=ConnectionHeldAcrossOutboundCallError,
    reason=(
        "Census row 5: _apply_reset_to_user commits and then calls session.refresh "
        "on the very next line; the refresh emits a SELECT and autobegins a fresh "
        "transaction, undoing the release the commit just made. The notification "
        "email is then sent under it. Its sibling request_password_reset is safe and "
        "differs by exactly that one line."
    ),
)
@pytest.mark.usefixtures("wire_email_sender")
@pytest.mark.asyncio
async def test_the_password_change_notification_is_sent_off_the_pool(
    async_client: AsyncClient,
    email_sender: RecordingEmailSender,
    outbound_boundary: OutboundBoundaryObserver,
) -> None:
    """Census row 5: POST /auth/password-reset/confirm."""
    await _signup(async_client, "reset_boundary")
    requested = await async_client.post(
        "/auth/password-reset/request", json={"email": "reset_boundary@example.com"}
    )
    assert requested.status_code == HTTPStatus.ACCEPTED, requested.text
    token = extract_reset_token(email_sender.sent[-1].body)
    outbound_boundary.reset()

    resp = await async_client.post(
        "/auth/password-reset/confirm",
        json={"token": token, "new_password": _NEW_PASSWORD},
    )

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert_dialled_off_the_pool(
        _at(outbound_boundary, _SEND), what="the password-change notification"
    )


@pytest.mark.xfail(
    strict=True,
    raises=ConnectionHeldAcrossOutboundCallError,
    reason=(
        "Census row 6: resolving an existing account issues an identity SELECT and "
        "an email SELECT; on the create path both return nothing and the handler "
        "then dials a third-party licensing host under the transaction they opened."
    ),
)
@pytest.mark.asyncio
async def test_the_oauth_license_check_is_dialled_off_the_pool(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    outbound_boundary: OutboundBoundaryObserver,
) -> None:
    """Census row 6: POST /auth/oauth/google, on the new-account create path."""

    async def _identity(_id_token: str) -> OIDCIdentity:
        return OIDCIdentity(
            subject="google-sub-boundary-1",
            email="oauth_boundary@example.com",
            email_verified=True,
            name="Boundary Newcomer",
        )

    monkeypatch.setattr(auth_router, "verify_google_id_token", _identity)
    outbound_boundary.reset()

    resp = await async_client.post(
        "/auth/oauth/google",
        json={
            "id_token": "an-id-token-the-stub-ignores",
            "license_key": "AAAA1111-BBBB-2222",
            "timezone": "America/Los_Angeles",
        },
    )

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert_dialled_off_the_pool(_at(outbound_boundary, _LICENSE), what="the OAuth licence check")


@pytest.mark.xfail(
    strict=True,
    raises=ConnectionHeldAcrossOutboundCallError,
    reason=(
        "Census row 9, and the one deliberate row: the wallet deduction is staged "
        "uncommitted, the vision model is called, and every error arm rolls the "
        "deduction back so a provider failure never charges. Real atomicity, bought "
        "with a pooled connection held for the longest-latency provider shape in the "
        "repository -- which is a cost to write down, not to omit."
    ),
)
@pytest.mark.asyncio
async def test_the_page_transcription_is_dialled_off_the_pool(
    async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    outbound_boundary: OutboundBoundaryObserver,
) -> None:
    """Census row 9: POST /journal/transcribe-page."""
    patch_generate_response(monkeypatch, priced_response("the transcribed page"))
    headers, _user_id = await _signup(async_client, "transcribe_boundary")
    outbound_boundary.reset()

    resp = await async_client.post(
        "/journal/transcribe-page",
        json=transcribe_payload(JPEG_BYTES, "image/jpeg"),
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert_dialled_off_the_pool(_at(outbound_boundary, _LLM), what="the transcription dial")
