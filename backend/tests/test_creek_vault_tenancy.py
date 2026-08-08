"""Single-tenant binding tests for the Creek Vault seam.

Adepthood reaches a vault with one deployment-wide identity, so the corpus a
vault grounds its answers in is whatever adepthood has replicated into it.  That
is safe only while exactly one person writes into it, which is what these tests
pin: a configured vault belongs to the single user named by
``CREEK_VAULT_OWNER_USER_ID``, and everyone else is served the local fallback, so
no other user's writing enters the corpus and no other user ever queries it.

Three families.  The first is the pure parse of the owner variable, which fails
closed on everything that is not a positive user id.  The second is the
dependency gate itself, driven directly against an environment rather than
through FastAPI, including what it logs when the binding is missing or
unreadable and what it must never echo.  The third drives the real app end to end
with two registered users and one shared fake vault standing in for the single
corpus, asserting the leak cannot travel in either direction: the non-owner's
writing never reaches the corpus, and nothing the non-owner is answered with is
drawn from it.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterator
from datetime import UTC, datetime
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from dependencies import creek_vault as vault_dependency
from domain.constants import TOTAL_STAGES
from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
    CreekCapabilityUnsupportedError,
    CreekVaultClient,
    HandshakeResult,
    VaultClassification,
    VaultIngestRequest,
    VaultIngestResult,
    VaultReflection,
    VaultReflectionNote,
    VaultReflectionStatus,
    VaultTierCeiling,
    VaultUploadRequest,
    VaultUploadResult,
    VaultWheelAspect,
    VaultWheelBalance,
    resolve_vault_owner,
)
from models.course_stage import CourseStage
from services import marginalia as marginalia_service
from services.botmason import STUB_MODEL_NAME, LLMResponse
from services.creek_vault_client import HttpCreekVaultClient, LocalFallbackCreekVaultClient
from services.creek_vault_telemetry import (
    VAULT_OUTCOME_EVENT,
    VaultTelemetryOutcome,
    reset_vault_telemetry_for_tests,
    vault_outcome_counts,
)

# The environment variable that binds a configured vault to one adepthood user.
_OWNER_ENV_VAR = "CREEK_VAULT_OWNER_USER_ID"

_VAULT_URL = "https://vault.example.test"
_API_KEY = "creek-vault-tenancy-key"  # pragma: allowlist secret

# Two ids that are never equal, so "owner" and "everyone else" cannot be
# satisfied by the same comparison.
_OWNER_ID = 7
_OTHER_ID = 8

# A mis-pasted owner value.  It stands in for a credential fat-fingered into the
# wrong variable, which is why no record may echo it back.
_UNPARSEABLE_OWNER = "not-an-int"

_SIGNUP_PASSWORD = "secret12345"  # pragma: allowlist secret

# The owner's writing, and the unmistakable substring by which it is recognized
# anywhere it must not appear.
_ALPHA_SENTINEL = "alpha-corpus-sentinel-never-leaves-its-owner"
_ALPHA_BODY = f"The willow bent without breaking. {_ALPHA_SENTINEL}"

# The non-owner's writing, plus the verbatim fragment their locally generated
# reflection anchors against.
_BETA_SENTINEL = "beta-corpus-sentinel-never-enters-the-vault"
_BETA_QUOTE = "the rain kept walking with me"
_BETA_BODY = f"I noticed {_BETA_QUOTE}. {_BETA_SENTINEL}"

_CLOUD_NOTE = "The cloud reads: you return to water."
_VAULT_NOTE = "The vault reads: this is written in the corpus."

# The fullness the shared fake vault reports for every Aspect.  Distinct from the
# 0.0 a fresh user's locally computed balance produces, so which source answered
# a wheel request is decidable from the response alone.
_VAULT_FULLNESS = 0.42

_VAULT_WHEEL_ASPECTS = tuple(
    VaultWheelAspect(stage_number=n, aspect=f"creek-frequency-{n}", fullness=_VAULT_FULLNESS)
    for n in range(1, TOTAL_STAGES + 1)
)

# One synthetic Aspect label per seeded stage: the wheel read is discarded whole
# unless every stage carries a non-blank label.
_STAGE_ASPECTS = (
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

_CREATED_AT = datetime(2026, 8, 1, 9, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def _reset_vault_telemetry() -> Iterator[None]:
    """Empty the process-wide outcome counters around every test in this module."""
    reset_vault_telemetry_for_tests()
    yield
    reset_vault_telemetry_for_tests()


@pytest.fixture
def configured_vault(monkeypatch: pytest.MonkeyPatch) -> None:
    """Configure a reachable vault with a credential and no owner bound yet.

    The protocol selector is cleared rather than set so a stale value in the
    developer's own environment cannot degrade the real client out from under the
    tests that assert one is built.
    """
    monkeypatch.setenv("CREEK_VAULT_URL", _VAULT_URL)
    monkeypatch.setenv("CREEK_VAULT_API_KEY", _API_KEY)
    monkeypatch.delenv("CREEK_VAULT_PROTOCOL", raising=False)
    monkeypatch.delenv(_OWNER_ENV_VAR, raising=False)


def _client_for(user_id: int) -> CreekVaultClient:
    """Resolve the vault client the request-time gate hands to ``user_id``."""
    return vault_dependency.get_creek_vault_client(user_id)


def _record_text(record: logging.LogRecord) -> str:
    """Render every string one record could carry: its message plus its own attributes."""
    attributes = " ".join(f"{key}={value}" for key, value in vars(record).items())
    return f"{record.getMessage()} {attributes}"


def _warnings(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    """Return the captured records an operator would actually be paged by."""
    return [record for record in caplog.records if record.levelno >= logging.WARNING]


def _ingest_request(body: str) -> VaultIngestRequest:
    """Build an open-tier ingest request carrying ``body``."""
    return VaultIngestRequest(
        entry_id=1,
        body=body,
        tier=VaultTierCeiling.OPEN,
        tier_ceiling=VaultTierCeiling.OPEN,
        created_at=_CREATED_AT,
    )


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (None, None),
        ("", None),
        ("   ", None),
        ("abc", None),
        ("1.5", None),
        ("0", None),
        ("-3", None),
        ("7", 7),
        ("  7  ", 7),
    ],
)
def test_resolve_vault_owner_admits_only_a_positive_user_id(
    raw: str | None, expected: int | None
) -> None:
    """Only a whitespace-tolerant positive integer names an owner; everything else is nobody.

    ``0`` and negatives are refused alongside the unparseable values, and that is
    the load-bearing half: a user id is positive, so admitting ``0`` would let the
    commonest "unset" sentinel silently own a deployment's vault.
    """
    assert resolve_vault_owner(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        "1_0",
        "+7",
        "\u0667",
        "\uff17",
        "7\u200b",
    ],
)
def test_resolve_vault_owner_refuses_every_spelling_int_would_have_widened(raw: str) -> None:
    """A binding is only a user id if it reads as one; ``int``'s generosity is refused.

    Each of these is something ``int`` accepts and an operator would not
    recognize as the id they typed: underscore grouping turns ``1_0`` into ten, a
    leading sign parses away, and every Unicode decimal digit converts to its
    numeric value, so an ARABIC-INDIC or FULLWIDTH seven is a seven. A
    zero-width space is the case whitespace-stripping alone would miss. All of
    them are written here as escapes rather than glyphs so this file cannot
    itself smuggle a confusable past a reader.

    This is the setting that decides whose journal a shared corpus accumulates,
    so the value an operator reads back must be the value that binds. Refusing
    these costs nothing -- no one means to type them -- and each one admitted
    would be a binding nobody could audit by looking at it.
    """
    assert resolve_vault_owner(raw) is None


@pytest.mark.usefixtures("configured_vault")
def test_the_bound_owner_gets_the_vault_and_every_other_user_gets_the_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With an owner bound, exactly that user reaches the configured vault."""
    monkeypatch.setenv(_OWNER_ENV_VAR, str(_OWNER_ID))

    assert isinstance(_client_for(_OWNER_ID), HttpCreekVaultClient)
    assert isinstance(_client_for(_OTHER_ID), LocalFallbackCreekVaultClient)


@pytest.mark.usefixtures("configured_vault")
def test_a_configured_vault_with_no_owner_is_nobodys_and_says_so(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A vault URL without an owner binding falls closed for everyone, loudly.

    Loudly because this is a live deployment one variable away from working:
    silence would leave an operator reading a vault-shaped configuration whose
    replication never happens, with nothing anywhere to say why.
    """
    caplog.set_level(logging.DEBUG)

    assert isinstance(_client_for(_OWNER_ID), LocalFallbackCreekVaultClient)
    assert isinstance(_client_for(_OTHER_ID), LocalFallbackCreekVaultClient)

    warnings = _warnings(caplog)
    assert warnings, "an unbound vault must warn rather than degrade in silence"
    assert all(_OWNER_ENV_VAR in _record_text(record) for record in warnings), (
        f"every warning must name {_OWNER_ENV_VAR}, the variable that fixes it"
    )


@pytest.mark.usefixtures("configured_vault")
def test_an_unreadable_owner_falls_closed_without_echoing_the_value(
    caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A garbage owner binding degrades everyone and keeps the raw value out of the log.

    The value is the operator's own text and could as easily be a credential
    pasted into the wrong variable, so the record names the variable and never
    what was found in it.
    """
    caplog.set_level(logging.DEBUG)
    monkeypatch.setenv(_OWNER_ENV_VAR, _UNPARSEABLE_OWNER)

    assert isinstance(_client_for(_OWNER_ID), LocalFallbackCreekVaultClient)
    assert isinstance(_client_for(_OTHER_ID), LocalFallbackCreekVaultClient)

    warnings = _warnings(caplog)
    assert warnings, "an unreadable owner binding must warn rather than degrade in silence"
    assert all(_OWNER_ENV_VAR in _record_text(record) for record in warnings)
    leaked = [record for record in caplog.records if _UNPARSEABLE_OWNER in _record_text(record)]
    assert not leaked, "the raw owner value must reach no log record, message or field"


def test_no_vault_configured_stays_silent_for_everyone(
    caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A deployment that chose no vault is not a fault and earns no warning."""
    caplog.set_level(logging.DEBUG)
    monkeypatch.delenv("CREEK_VAULT_URL", raising=False)
    monkeypatch.delenv(_OWNER_ENV_VAR, raising=False)

    assert isinstance(_client_for(_OWNER_ID), LocalFallbackCreekVaultClient)
    assert isinstance(_client_for(_OTHER_ID), LocalFallbackCreekVaultClient)
    assert _warnings(caplog) == []


@pytest.mark.asyncio
@pytest.mark.usefixtures("configured_vault")
async def test_a_non_owner_degrade_counts_under_its_own_outcome(
    caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A user who is not the owner is counted apart from a deployment with no vault.

    Two different facts with two different remedies: one deployment never wanted
    a vault, the other has one that this user is deliberately kept out of. The
    records stay at DEBUG like the unconfigured path, because neither is a fault.
    """
    caplog.set_level(logging.DEBUG)
    monkeypatch.setenv(_OWNER_ENV_VAR, str(_OWNER_ID))
    client = _client_for(_OTHER_ID)

    await client.handshake()
    await client.ingest(_ingest_request(_BETA_BODY))

    assert vault_outcome_counts() == {
        (VaultTelemetryOutcome.FALLBACK_NOT_OWNER, CreekCapability.HANDSHAKE): 1,
        (VaultTelemetryOutcome.FALLBACK_NOT_OWNER, CreekCapability.JOURNAL): 1,
    }
    levels = [
        record.levelno for record in caplog.records if record.getMessage() == VAULT_OUTCOME_EVENT
    ]
    assert levels == [logging.DEBUG, logging.DEBUG]


def test_the_not_owner_outcome_carries_its_own_wire_string() -> None:
    """The new outcome is countable under a name of its own on a dashboard."""
    assert VaultTelemetryOutcome.FALLBACK_NOT_OWNER.value == "vault_fallback_not_owner"


@pytest.mark.asyncio
async def test_the_fallback_client_still_counts_as_unconfigured_by_default() -> None:
    """The no-vault client's own outcome is unchanged, so existing counters keep their meaning."""
    await LocalFallbackCreekVaultClient().handshake()

    assert vault_outcome_counts() == {
        (VaultTelemetryOutcome.FALLBACK_UNCONFIGURED, CreekCapability.HANDSHAKE): 1,
    }


class _SharedCorpusVaultClient:
    """One deployment-wide vault: whatever it is given, it may hand back to anyone.

    The fake is deliberately a *single instance* shared across both users'
    requests, because that is the real risk this issue exists to close -- there
    is one vault, one identity, and therefore one corpus. Its ``reflect``
    grounds in what it was previously given, exactly as the real capability
    does, so a note quoting another user's writing is what a leak would look
    like rather than something this fake has to be told to fabricate.
    """

    def __init__(self) -> None:
        """Start with an empty corpus and no recorded reads."""
        self.ingested_bodies: list[str] = []
        self.reflect_calls: list[str] = []
        self.wheel_calls = 0

    async def handshake(self) -> HandshakeResult:
        """Report a vault that can ingest, reflect, and answer a wheel."""
        return HandshakeResult(
            available=True,
            contract_version=CONTRACT_VERSION,
            ontology_version="1.0.0",
            capabilities=frozenset(
                {CreekCapability.JOURNAL, CreekCapability.REFLECT, CreekCapability.WHEEL}
            ),
            attestation=None,
        )

    def is_available(self) -> bool:
        """Report available -- this fake never degrades."""
        return True

    def supports(self, capability: CreekCapability, /) -> bool:
        """Report every capability but classify as supported."""
        return capability is not CreekCapability.CLASSIFY

    async def ingest(self, request: VaultIngestRequest, /) -> VaultIngestResult:
        """Add the body to the one shared corpus and answer with a stored ref."""
        self.ingested_bodies.append(request.body)
        return VaultIngestResult(stored=True, vault_ref=f"vault-ref-{len(self.ingested_bodies)}")

    async def upload(self, request: VaultUploadRequest, /) -> VaultUploadResult:
        """Unused on this path; raises if a test calls it by mistake."""
        raise NotImplementedError(request)

    async def classify(self, _body: str, _tier_ceiling: VaultTierCeiling, /) -> VaultClassification:
        """Raise: adepthood never calls classify, and a fake that answered would hide that."""
        raise CreekCapabilityUnsupportedError("creek vault capability unsupported: creek.classify")

    async def reflect(self, body: str, tier_ceiling: VaultTierCeiling, /) -> VaultReflection:
        """Record the read and answer a note quoting the earliest body in the corpus."""
        del tier_ceiling
        self.reflect_calls.append(body)
        grounded = self.ingested_bodies[0] if self.ingested_bodies else body
        return VaultReflection(
            status=VaultReflectionStatus.OK,
            notes=(VaultReflectionNote(kind="theme", quote=grounded, note=_VAULT_NOTE),),
            essay=None,
            essay_grounded=False,
            routed_tier=VaultTierCeiling.PERSONAL,
        )

    async def wheel(self) -> VaultWheelBalance:
        """Record the read and answer the whole-corpus aggregate, recognizable by its fullness."""
        self.wheel_calls += 1
        return VaultWheelBalance(aspects=_VAULT_WHEEL_ASPECTS)


def _stage_row(stage_number: int) -> CourseStage:
    """Build one CourseStage row carrying the Aspect label a wheel read is relabelled with."""
    return CourseStage(
        title=f"Stage {stage_number}",
        subtitle="sub",
        stage_number=stage_number,
        overview_url="",
        category="test",
        aspect=_STAGE_ASPECTS[stage_number - 1],
        spiral_dynamics_color="beige",
        growing_up_stage="archaic",
        divine_gender_polarity="masculine",
        relationship_to_free_will="active",
        free_will_description="desc",
    )


async def _seed_all_stages(db_session: AsyncSession) -> None:
    """Insert every CourseStage row, so a wheel read has a full label set to land on."""
    for stage_number in range(1, TOTAL_STAGES + 1):
        db_session.add(_stage_row(stage_number))
    await db_session.commit()


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    """Sign up a fresh user and return its auth header and DB-assigned id."""
    resp = await client.post(
        "/auth/signup",
        json={"email": f"{username}@example.com", "password": _SIGNUP_PASSWORD},
    )
    assert resp.status_code == HTTPStatus.OK
    data = resp.json()
    return {"Authorization": f"Bearer {data['token']}"}, int(data["user_id"])


async def _create_entry(client: AsyncClient, headers: dict[str, str], body: str) -> int:
    """Create a personal journal entry and return its id."""
    resp = await client.post(
        "/journal/",
        json={"message": body, "classification": "personal"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED
    return int(resp.json()["id"])


def _fake_cloud_llm(monkeypatch: pytest.MonkeyPatch) -> None:
    """Patch the cloud resonance seam so the non-owner's reflection is locally generated."""
    payload = json.dumps({"notes": [{"kind": "theme", "quote": _BETA_QUOTE, "note": _CLOUD_NOTE}]})

    async def _complete(
        prompt: str, history: object, *, system_prompt: object, api_key: object
    ) -> LLMResponse:
        del prompt, history, system_prompt, api_key
        return LLMResponse(
            text=payload,
            provider="stub",
            model=STUB_MODEL_NAME,
            prompt_tokens=0,
            completion_tokens=0,
        )

    monkeypatch.setattr(marginalia_service, "generate_response", _complete)


def _fullness_values(payload: object) -> list[float]:
    """Return each Aspect's fullness from a wheel response body, in the order served."""
    assert isinstance(payload, dict)
    aspects = payload["aspects"]
    assert isinstance(aspects, list)
    return [float(item["fullness"]) for item in aspects]


@pytest.mark.asyncio
@pytest.mark.usefixtures("configured_vault")
async def test_reflection_is_never_grounded_in_another_users_corpus(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """One shared corpus, two users: only the bound owner writes to it or reads from it.

    Every leg is asserted in both directions. The owner's entry must reach the
    corpus, or the whole test would pass on broken wiring that simply never
    called a vault; the other user's entry must not, or their writing becomes
    material a stranger's reflection can quote; the other user's resonance must
    not touch the vault at all, since a corpus holding one person's journal can
    only ground an answer in it; and their wheel must be the balance computed
    from their own progress rather than the whole-corpus aggregate.
    """
    shared = _SharedCorpusVaultClient()

    def _build_shared() -> CreekVaultClient:
        """Return the one shared corpus, whoever asked for a vault."""
        return shared

    # Patch the builder, not the dependency: overriding the dependency bypasses the gate under test.
    monkeypatch.setattr(vault_dependency, "build_creek_vault_client", _build_shared)
    _fake_cloud_llm(monkeypatch)
    await _seed_all_stages(db_session)

    owner_headers, owner_id = await _signup(async_client, "vault_owner")
    other_headers, _other_id = await _signup(async_client, "vault_other")
    monkeypatch.setenv(_OWNER_ENV_VAR, str(owner_id))

    await _create_entry(async_client, owner_headers, _ALPHA_BODY)
    assert shared.ingested_bodies == [_ALPHA_BODY], "the owner's own writing must reach the vault"

    other_entry = await _create_entry(async_client, other_headers, _BETA_BODY)
    assert shared.ingested_bodies == [_ALPHA_BODY]
    assert _BETA_SENTINEL not in "\n".join(shared.ingested_bodies)

    resonance = await async_client.post(f"/journal/{other_entry}/resonance", headers=other_headers)
    assert resonance.status_code == HTTPStatus.OK
    # Ordered so a regression fails on the tenancy property itself rather than on a
    # downstream symptom.  Anchoring drops a note whose quote is absent from the
    # reader's own entry, so a cross-grounded note tends to arrive as *empty*
    # marginalia -- a real safety net, but a narrower one than this test is about:
    # it constrains the quote field only, never the note prose or the wheel.
    assert shared.reflect_calls == [], "a non-owner's reflection must never consult the corpus"
    notes = resonance.json()["marginalia"]
    assert _ALPHA_SENTINEL not in json.dumps(notes), "no answer may carry the owner's writing"
    assert notes, "the non-owner still gets a reflection, generated locally"

    other_wheel = await async_client.get("/stages/wheel", headers=other_headers)
    assert other_wheel.status_code == HTTPStatus.OK
    assert _fullness_values(other_wheel.json()) == [0.0] * TOTAL_STAGES

    owner_wheel = await async_client.get("/stages/wheel", headers=owner_headers)
    assert owner_wheel.status_code == HTTPStatus.OK
    assert _fullness_values(owner_wheel.json()) == [_VAULT_FULLNESS] * TOTAL_STAGES
