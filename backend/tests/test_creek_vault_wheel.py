"""Unit tests for the Creek Vault wheel-of-wholeness seam.

The cases that need a real wire body read it from the vendored Creek contract
bundle rather than writing one out, so a wheel this suite claims the read path
accepts is a wheel Creek actually publishes.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncGenerator, Callable
from datetime import date
from http import HTTPStatus

import httpx
import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession

from domain.constants import TOTAL_STAGES
from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
    CreekCapabilityUnsupportedError,
    CreekVaultAuthError,
    CreekVaultContractError,
    CreekVaultPayloadError,
    CreekVaultUnavailableError,
    HandshakeResult,
    VaultClassification,
    VaultErrorCode,
    VaultIngestRequest,
    VaultIngestResult,
    VaultReflection,
    VaultTierCeiling,
    VaultUploadRequest,
    VaultUploadResult,
    VaultWheelAspect,
    VaultWheelBalance,
)
from domain.wheel import compute_wheel_balance
from models.course_stage import CourseStage
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.habit import Habit
from models.user import User
from observability import trace_id_var
from scripts.creek_contract_drift import BUNDLE_ROOT
from services.creek_vault_client import (
    HttpCreekVaultClient,
    LocalFallbackCreekVaultClient,
    _wheel_aspects,
)
from services.creek_vault_read import _DEGRADED_EVENT, VaultReadDegradeReason
from services.creek_vault_wheel import (
    VAULT_WHEEL_EXPECTED_ASPECTS,
    VAULT_WHEEL_FULLNESS_MAX,
    VAULT_WHEEL_FULLNESS_MIN,
    VAULT_WHEEL_STAGE_MIN,
    fetch_vault_wheel,
    select_wheel_balance,
)

_CANONICAL_ASPECTS = [
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
]

_VAULT_URL = "https://vault.example.test"
_API_KEY = "creek-vault-wheel-key"  # pragma: allowlist secret
_CAPABILITIES_PATH = "/v1/capabilities"
_ONTOLOGY_VERSION = "aptitude-wavelength/2026-05-23"

# A vault error message distinct enough to spot in any formatted log record. A
# real one is static and content-free, but this seam must hold even for a
# transport that someday builds its message from what the vault said.
_SENTINEL_VAULT_TEXT = "SENTINEL_VAULT_ERROR_TEXT_DO_NOT_LEAK"

# Everything ``logging`` puts on a record itself, the two a formatter adds when
# the capture handler renders one, and the correlation id the app's own filter
# stamps on every record once ``main`` has been imported. Whatever is left is
# exactly what the read path chose to attach.
_STANDARD_RECORD_FIELDS = frozenset(
    logging.LogRecord("n", logging.WARNING, "p", 0, "m", None, None).__dict__
) | {"message", "asctime", trace_id_var.name}


class RecordingWheelVaultClient:
    """A scriptable, call-recording fake CreekVaultClient (wheel path only)."""

    def __init__(
        self,
        *,
        available: bool = True,
        capabilities: frozenset[CreekCapability] = frozenset({CreekCapability.WHEEL}),
        wheel_result: VaultWheelBalance | None = None,
        wheel_error: Exception | None = None,
    ) -> None:
        """Store the scripted handshake outcome and wheel behavior."""
        self.handshake_calls = 0
        self.wheel_calls = 0
        self._available = available
        self._capabilities = capabilities
        self._wheel_result = wheel_result
        self._wheel_error = wheel_error

    async def handshake(self) -> HandshakeResult:
        """Record the call and return the scripted availability/capabilities."""
        self.handshake_calls += 1
        return HandshakeResult(
            available=self._available,
            contract_version=CONTRACT_VERSION,
            ontology_version="1.0.0",
            capabilities=self._capabilities,
            attestation=None,
        )

    def is_available(self) -> bool:
        """Return the scripted availability."""
        return self._available

    def supports(self, capability: CreekCapability, /) -> bool:
        """Return whether ``capability`` is in the scripted capability set."""
        return capability in self._capabilities

    async def ingest(self, request: VaultIngestRequest, /) -> VaultIngestResult:
        """Unused on the wheel path; raises if a test calls it by mistake."""
        raise NotImplementedError(request)

    async def upload(self, request: VaultUploadRequest, /) -> VaultUploadResult:
        """Unused on this path; raises if a test calls it by mistake."""
        raise NotImplementedError(request)

    async def classify(self, body: str, tier_ceiling: VaultTierCeiling, /) -> VaultClassification:
        """Unused on the wheel path; raises if a test calls it by mistake."""
        raise NotImplementedError((body, tier_ceiling))

    async def reflect(self, body: str, tier_ceiling: VaultTierCeiling, /) -> VaultReflection:
        """Unused on the wheel path; raises if a test calls it by mistake."""
        raise NotImplementedError((body, tier_ceiling))

    async def wheel(self) -> VaultWheelBalance:
        """Record the call, then raise the scripted error or return the scripted balance."""
        self.wheel_calls += 1
        if self._wheel_error is not None:
            raise self._wheel_error
        assert self._wheel_result is not None
        return self._wheel_result


def _valid_aspects() -> tuple[VaultWheelAspect, ...]:
    """Ten valid, distinct aspects in canonical ascending order."""
    return tuple(
        VaultWheelAspect(stage_number=n, aspect=f"Aspect-{n}", fullness=round(n / 10, 2))
        for n in range(1, VAULT_WHEEL_EXPECTED_ASPECTS + 1)
    )


def _override_field(
    position: int,
    *,
    stage_number: int | None = None,
    aspect: str | None = None,
    fullness: float | None = None,
) -> tuple[VaultWheelAspect, ...]:
    """Ten valid aspects with the aspect at ``position`` (1-based) mutated by the given fields.

    Each keyword left as ``None`` keeps the original field, so a single call can
    inject one out-of-range value while the rest of the wheel stays valid.
    """
    base = list(_valid_aspects())
    idx = position - 1
    original = base[idx]
    base[idx] = VaultWheelAspect(
        stage_number=original.stage_number if stage_number is None else stage_number,
        aspect=original.aspect if aspect is None else aspect,
        fullness=original.fullness if fullness is None else fullness,
    )
    return tuple(base)


def _zero_fullness_aspects() -> tuple[VaultWheelAspect, ...]:
    """Ten valid aspects whose fullness is zero everywhere, as an unclassified corpus reads."""
    return tuple(
        VaultWheelAspect(stage_number=n, aspect=f"Aspect-{n}", fullness=VAULT_WHEEL_FULLNESS_MIN)
        for n in range(1, VAULT_WHEEL_EXPECTED_ASPECTS + 1)
    )


_INVALID_PAYLOADS: list[tuple[str, tuple[VaultWheelAspect, ...]]] = [
    ("stage_number_zero", _override_field(1, stage_number=0)),
    ("stage_number_eleven", _override_field(1, stage_number=11)),
    ("fullness_below_min", _override_field(1, fullness=-0.01)),
    ("fullness_above_max", _override_field(1, fullness=1.01)),
    ("fullness_nan", _override_field(1, fullness=float("nan"))),
    ("aspect_empty", _override_field(1, aspect="")),
    ("aspect_whitespace_only", _override_field(1, aspect="   ")),
    (
        "duplicate_stage_missing_other",
        tuple(
            VaultWheelAspect(stage_number=n, aspect=f"Aspect-{n}", fullness=0.5)
            for n in (1, 2, 3, 3, 5, 6, 7, 8, 9, 10)
        ),
    ),
    ("nine_aspects", _valid_aspects()[:-1]),
    (
        "eleven_aspects",
        (*_valid_aspects(), VaultWheelAspect(stage_number=1, aspect="Extra", fullness=0.1)),
    ),
]


def _stage_data(stage_number: int) -> dict[str, object]:
    """Valid CourseStage fields for direct DB insertion."""
    return {
        "title": f"Stage {stage_number}",
        "subtitle": "sub",
        "stage_number": stage_number,
        "overview_url": "",
        "category": "test",
        "aspect": _CANONICAL_ASPECTS[stage_number - 1],
        "spiral_dynamics_color": "beige",
        "growing_up_stage": "archaic",
        "divine_gender_polarity": "masculine",
        "relationship_to_free_will": "active",
        "free_will_description": "desc",
    }


async def _seed_all_stages(session: AsyncSession) -> None:
    """Insert all ten CourseStage rows."""
    for n in range(1, TOTAL_STAGES + 1):
        session.add(CourseStage(**_stage_data(n)))
    await session.commit()


async def _seed_stages_except(session: AsyncSession, skipped: int) -> None:
    """Insert every CourseStage row but the one for ``skipped``."""
    for n in range(1, TOTAL_STAGES + 1):
        if n != skipped:
            session.add(CourseStage(**_stage_data(n)))
    await session.commit()


async def _seed_stages_with_blank_aspect(session: AsyncSession, blank_stage: int) -> None:
    """Insert all ten CourseStage rows, labelling ``blank_stage`` with whitespace only."""
    for n in range(1, TOTAL_STAGES + 1):
        data = _stage_data(n)
        if n == blank_stage:
            data["aspect"] = "   "
        session.add(CourseStage(**data))
    await session.commit()


async def _make_user(session: AsyncSession, email: str = "wheelvault@example.com") -> int:
    """Insert a User row and return its id."""
    user = User(email=email, password_hash="x")  # pragma: allowlist secret
    session.add(user)
    await session.commit()
    await session.refresh(user)
    assert user.id is not None
    return user.id


async def _seed_habit_with_completion(
    session: AsyncSession, user_id: int, stage_number: int
) -> None:
    """Seed one habit with one goal and one completion for the given stage."""
    habit = Habit(
        name=f"HW-{stage_number}-{user_id}",
        icon="x",
        start_date=date(2026, 1, 1),
        energy_cost=1,
        energy_return=1,
        user_id=user_id,
        stage=str(stage_number),
        streak=0,
    )
    session.add(habit)
    await session.commit()
    await session.refresh(habit)
    goal = Goal(
        habit_id=habit.id,
        title="g",
        tier="t",
        target=1,
        target_unit="rep",
        frequency=1,
        frequency_unit="per_day",
    )
    session.add(goal)
    await session.commit()
    await session.refresh(goal)
    session.add(GoalCompletion(goal_id=goal.id, user_id=user_id, completed_units=1))
    await session.commit()


def _wheel_example(state: str) -> dict[str, object]:
    """Return one vendored wheel example body, decoded fresh on every call."""
    decoded = json.loads((BUNDLE_ROOT / f"examples/wheel/{state}.json").read_bytes())
    assert isinstance(decoded, dict), state
    return decoded


def _wheel_frequencies(payload: dict[str, object]) -> dict[str, dict[str, object]]:
    """Return the ten published Frequency entries of a wheel body."""
    frequencies = payload["wheel"]
    assert isinstance(frequencies, dict)
    return {code: entry for code, entry in frequencies.items() if isinstance(entry, dict)}


def _published_shares(payload: dict[str, object]) -> list[object]:
    """Return a wheel body's ten shares in canonical stage order."""
    frequencies = _wheel_frequencies(payload)
    return [frequencies[f"F{n}"]["share"] for n in range(1, TOTAL_STAGES + 1)]


def _capability_document() -> dict[str, object]:
    """Build the handshake document a vault advertising only the wheel would serve."""
    return {
        "available": True,
        "capabilities": [CreekCapability.WHEEL.value],
        "contract_version": CONTRACT_VERSION,
        "ontology_version": _ONTOLOGY_VERSION,
        "attestation": None,
    }


def _wheel_handler(payload: object) -> Callable[[httpx.Request], httpx.Response]:
    """Return a handler answering the capability probe, then one wheel body."""

    def _handle(request: httpx.Request) -> httpx.Response:
        """Answer the capability GET with a wheel-advertising document, else the wheel."""
        if request.url.path == _CAPABILITIES_PATH:
            return httpx.Response(HTTPStatus.OK, json=_capability_document())
        return httpx.Response(HTTPStatus.OK, json=payload)

    return _handle


@pytest_asyncio.fixture
async def wheel_clients() -> AsyncGenerator[Callable[[object], HttpCreekVaultClient], None]:
    """Yield a factory for MockTransport-backed vault clients serving one wheel body."""
    created: list[httpx.AsyncClient] = []

    def _build(payload: object) -> HttpCreekVaultClient:
        """Build one in-memory client whose vault answers ``payload`` for the wheel."""
        http = httpx.AsyncClient(transport=httpx.MockTransport(_wheel_handler(payload)))
        created.append(http)
        return HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http)

    yield _build
    for http in created:
        await http.aclose()


def _degrade_records(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    """Return every captured record carrying the read path's static degrade event."""
    return [record for record in caplog.records if record.getMessage() == _DEGRADED_EVENT]


def _structured_fields(record: logging.LogRecord) -> dict[str, object]:
    """Return only the fields a record carries beyond a bare LogRecord's own."""
    return {
        key: value for key, value in record.__dict__.items() if key not in _STANDARD_RECORD_FIELDS
    }


# ---------------------------------------------------------------------------
# Constants pinning
# ---------------------------------------------------------------------------


def test_wheel_validation_constants_match_curriculum_and_range() -> None:
    """The module's validation constants match the design's pinned values."""
    assert VAULT_WHEEL_EXPECTED_ASPECTS == TOTAL_STAGES
    assert VAULT_WHEEL_STAGE_MIN == 1
    assert VAULT_WHEEL_FULLNESS_MIN == 0.0
    assert VAULT_WHEEL_FULLNESS_MAX == 1.0


# ---------------------------------------------------------------------------
# fetch_vault_wheel: happy path + canonical reordering
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fetch_vault_wheel_returns_canonical_order_from_shuffled_input() -> None:
    """A valid vault payload in shuffled order is returned sorted ascending by stage_number."""
    shuffled_order = [7, 2, 9, 1, 10, 4, 3, 6, 5, 8]
    aspects = tuple(
        VaultWheelAspect(stage_number=n, aspect=f"Aspect-{n}", fullness=round(n / 10, 2))
        for n in shuffled_order
    )
    client = RecordingWheelVaultClient(wheel_result=VaultWheelBalance(aspects=aspects))

    result = await fetch_vault_wheel(client)

    assert result is not None
    assert [item["stage_number"] for item in result] == list(range(1, TOTAL_STAGES + 1))
    for item in result:
        n = item["stage_number"]
        assert item["aspect"] == f"Aspect-{n}"
        assert item["fullness"] == round(n / 10, 2)
    assert client.wheel_calls == 1


# ---------------------------------------------------------------------------
# fetch_vault_wheel: fallback to None on unavailable / unsupported / errors
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fetch_vault_wheel_returns_none_when_not_available() -> None:
    """An unavailable vault falls back without ever calling wheel()."""
    client = RecordingWheelVaultClient(
        available=False, wheel_result=VaultWheelBalance(aspects=_valid_aspects())
    )

    result = await fetch_vault_wheel(client)

    assert result is None
    assert client.wheel_calls == 0


@pytest.mark.asyncio
async def test_fetch_vault_wheel_returns_none_when_wheel_unsupported() -> None:
    """A vault that never advertises WHEEL falls back without calling wheel()."""
    client = RecordingWheelVaultClient(
        capabilities=frozenset(), wheel_result=VaultWheelBalance(aspects=_valid_aspects())
    )

    result = await fetch_vault_wheel(client)

    assert result is None
    assert client.wheel_calls == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "error",
    [
        CreekVaultUnavailableError("creek vault call failed: creek.wheel"),
        CreekCapabilityUnsupportedError("capability not advertised: creek.wheel"),
    ],
    ids=["unavailable_error", "capability_unsupported_error"],
)
async def test_fetch_vault_wheel_returns_none_on_wheel_call_error(error: Exception) -> None:
    """Every CreekVaultError the seam can raise from wheel() falls back to None."""
    client = RecordingWheelVaultClient(wheel_error=error)

    result = await fetch_vault_wheel(client)

    assert result is None
    assert client.wheel_calls == 1


# ---------------------------------------------------------------------------
# fetch_vault_wheel: field-level and structural validation failures (all-or-nothing)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "aspects", [p[1] for p in _INVALID_PAYLOADS], ids=[p[0] for p in _INVALID_PAYLOADS]
)
async def test_fetch_vault_wheel_returns_none_on_invalid_payload(
    aspects: tuple[VaultWheelAspect, ...],
) -> None:
    """Any single validation violation is all-or-nothing: the whole read falls back."""
    client = RecordingWheelVaultClient(wheel_result=VaultWheelBalance(aspects=aspects))

    result = await fetch_vault_wheel(client)

    assert result is None


@pytest.mark.asyncio
async def test_fetch_vault_wheel_returns_none_when_no_aspect_is_positive() -> None:
    """An all-zero wheel is well-formed but carries no signal, so the read path falls back."""
    client = RecordingWheelVaultClient(
        wheel_result=VaultWheelBalance(aspects=_zero_fullness_aspects())
    )

    result = await fetch_vault_wheel(client)

    assert result is None
    assert client.wheel_calls == 1


@pytest.mark.asyncio
async def test_fetch_vault_wheel_accepts_a_single_positive_aspect_among_zeros() -> None:
    """One positive fullness among nine zeros is signal enough to keep the vault's wheel."""
    positive_stage = 3
    positive_fullness = 0.4
    aspects = tuple(
        VaultWheelAspect(
            stage_number=aspect.stage_number,
            aspect=aspect.aspect,
            fullness=positive_fullness
            if aspect.stage_number == positive_stage
            else VAULT_WHEEL_FULLNESS_MIN,
        )
        for aspect in _zero_fullness_aspects()
    )
    client = RecordingWheelVaultClient(wheel_result=VaultWheelBalance(aspects=aspects))

    result = await fetch_vault_wheel(client)

    assert result is not None
    assert [item["fullness"] for item in result] == [
        positive_fullness if n == positive_stage else VAULT_WHEEL_FULLNESS_MIN
        for n in range(1, TOTAL_STAGES + 1)
    ]


@pytest.mark.asyncio
async def test_fetch_vault_wheel_accepts_fullness_boundary_zero_and_one() -> None:
    """Fullness exactly 0.0 and exactly 1.0 both pass validation (inclusive bounds)."""
    boundary_fullness = {1: VAULT_WHEEL_FULLNESS_MIN, 2: VAULT_WHEEL_FULLNESS_MAX}
    aspects = tuple(
        VaultWheelAspect(
            stage_number=a.stage_number,
            aspect=a.aspect,
            fullness=boundary_fullness.get(a.stage_number, a.fullness),
        )
        for a in _valid_aspects()
    )
    client = RecordingWheelVaultClient(wheel_result=VaultWheelBalance(aspects=aspects))

    result = await fetch_vault_wheel(client)

    assert result is not None
    stage1 = next(item for item in result if item["stage_number"] == 1)
    stage2 = next(item for item in result if item["stage_number"] == 2)
    assert stage1["fullness"] == VAULT_WHEEL_FULLNESS_MIN
    assert stage2["fullness"] == VAULT_WHEEL_FULLNESS_MAX


# ---------------------------------------------------------------------------
# select_wheel_balance: vault-or-local selection
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_select_wheel_balance_falls_back_to_local_when_vault_unavailable(
    db_session: AsyncSession,
) -> None:
    """No usable vault -> select_wheel_balance returns compute_wheel_balance's result verbatim."""
    await _seed_all_stages(db_session)
    user_id = await _make_user(db_session)
    await _seed_habit_with_completion(db_session, user_id, stage_number=4)
    client = RecordingWheelVaultClient(available=False)

    expected = await compute_wheel_balance(db_session, user_id)
    result = await select_wheel_balance(client, db_session, user_id)

    assert result == expected
    assert client.wheel_calls == 0


@pytest.mark.asyncio
async def test_select_wheel_balance_relabels_vault_items_with_course_stage_aspects(
    db_session: AsyncSession,
) -> None:
    """A valid vault wheel keeps its fullness but is relabelled with adepthood's own aspects."""
    await _seed_all_stages(db_session)
    user_id = await _make_user(db_session)
    aspects = _valid_aspects()
    client = RecordingWheelVaultClient(wheel_result=VaultWheelBalance(aspects=aspects))

    result = await select_wheel_balance(client, db_session, user_id)

    assert result == [
        {
            "stage_number": a.stage_number,
            "aspect": _CANONICAL_ASPECTS[a.stage_number - 1],
            "fullness": a.fullness,
        }
        for a in aspects
    ]
    rendered_labels = {item["aspect"] for item in result}
    assert rendered_labels.isdisjoint({a.aspect for a in aspects})
    assert client.wheel_calls == 1


@pytest.mark.asyncio
async def test_select_wheel_balance_falls_back_when_a_course_stage_row_is_missing(
    db_session: AsyncSession,
) -> None:
    """No local label for one stage discards the whole vault wheel, never half of it."""
    await _seed_stages_except(db_session, skipped=6)
    user_id = await _make_user(db_session)
    client = RecordingWheelVaultClient(wheel_result=VaultWheelBalance(aspects=_valid_aspects()))

    expected = await compute_wheel_balance(db_session, user_id)
    result = await select_wheel_balance(client, db_session, user_id)

    assert result == expected
    assert client.wheel_calls == 1


@pytest.mark.asyncio
async def test_select_wheel_balance_falls_back_when_a_course_stage_label_is_blank(
    db_session: AsyncSession,
) -> None:
    """A whitespace-only local label discards the whole vault wheel, never half of it."""
    await _seed_stages_with_blank_aspect(db_session, blank_stage=6)
    user_id = await _make_user(db_session)
    client = RecordingWheelVaultClient(wheel_result=VaultWheelBalance(aspects=_valid_aspects()))

    expected = await compute_wheel_balance(db_session, user_id)
    result = await select_wheel_balance(client, db_session, user_id)

    assert result == expected
    assert client.wheel_calls == 1


@pytest.mark.asyncio
async def test_select_wheel_balance_falls_back_on_an_all_zero_vault_wheel(
    db_session: AsyncSession,
) -> None:
    """An all-zero vault wheel is fetched, then discarded for the local computation."""
    await _seed_all_stages(db_session)
    user_id = await _make_user(db_session)
    await _seed_habit_with_completion(db_session, user_id, stage_number=4)
    client = RecordingWheelVaultClient(
        wheel_result=VaultWheelBalance(aspects=_zero_fullness_aspects())
    )

    expected = await compute_wheel_balance(db_session, user_id)
    result = await select_wheel_balance(client, db_session, user_id)

    assert any(item["fullness"] > VAULT_WHEEL_FULLNESS_MIN for item in expected)
    assert result == expected
    assert client.wheel_calls == 1


# ---------------------------------------------------------------------------
# Read-path observability, and the vendored wire body end to end
# ---------------------------------------------------------------------------


def test_vault_read_degrade_reason_wire_values_are_stable() -> None:
    """The read path's degrade reasons carry the exact strings telemetry will count."""
    assert [reason.value for reason in VaultReadDegradeReason] == [
        "payload",
        "contract",
        "auth",
        "unsupported_capability",
        "unavailable",
    ]


@pytest.mark.parametrize(
    ("error", "reason", "code"),
    [
        pytest.param(
            CreekVaultPayloadError(_SENTINEL_VAULT_TEXT),
            VaultReadDegradeReason.PAYLOAD,
            None,
            id="payload",
        ),
        pytest.param(
            CreekVaultContractError(_SENTINEL_VAULT_TEXT, code=VaultErrorCode.PRIVACY_REFUSED),
            VaultReadDegradeReason.CONTRACT,
            VaultErrorCode.PRIVACY_REFUSED,
            id="contract",
        ),
        pytest.param(
            CreekVaultAuthError(_SENTINEL_VAULT_TEXT),
            VaultReadDegradeReason.AUTH,
            None,
            id="auth",
        ),
        pytest.param(
            CreekVaultUnavailableError(_SENTINEL_VAULT_TEXT),
            VaultReadDegradeReason.UNAVAILABLE,
            None,
            id="unavailable",
        ),
        pytest.param(
            CreekCapabilityUnsupportedError(_SENTINEL_VAULT_TEXT),
            VaultReadDegradeReason.UNSUPPORTED_CAPABILITY,
            None,
            id="unsupported_capability",
        ),
    ],
)
@pytest.mark.asyncio
async def test_vault_read_degrade_is_logged_with_a_reason_and_no_content(
    error: Exception,
    reason: VaultReadDegradeReason,
    code: VaultErrorCode | None,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Each way a wheel read fails logs one static WARNING naming a reason and nothing else.

    The user sees one silent fallback either way -- that is the point of
    degrading -- so the reasons exist purely to keep the failures countable
    apart. A payload fault is a vault bug to report upstream and an unavailable
    vault is infrastructure to restore, and a single shared reason would make
    those two indistinguishable in the only place anyone can see them.
    """
    caplog.set_level(logging.DEBUG)
    client = RecordingWheelVaultClient(wheel_error=error)

    assert await fetch_vault_wheel(client) is None

    records = _degrade_records(caplog)
    assert len(records) == 1
    expected: dict[str, object] = {
        "capability": CreekCapability.WHEEL.value,
        "reason": reason.value,
    }
    if code is not None:
        expected["code"] = code.value
    assert records[0].levelno == logging.WARNING
    assert _structured_fields(records[0]) == expected
    assert _SENTINEL_VAULT_TEXT not in caplog.text
    assert _SENTINEL_VAULT_TEXT not in str(records[0].__dict__)


@pytest.mark.asyncio
async def test_empty_corpus_wheel_falls_back_to_local_without_a_degrade_log(
    caplog: pytest.LogCaptureFixture,
    wheel_clients: Callable[[object], HttpCreekVaultClient],
) -> None:
    """A freshly-initialised vault is a legitimate answer, so it is not a degrade at all.

    Creek's empty corpus is an all-zero wheel served at 200. The read path still
    falls back -- an all-zero ring would blank a Map the local balance can fill
    -- but nothing failed, and recording a degrade here would train an operator
    to ignore the one signal that means something.
    """
    caplog.set_level(logging.DEBUG)
    published = _wheel_example("empty")
    assert set(_published_shares(published)) == {VAULT_WHEEL_FULLNESS_MIN}

    assert await fetch_vault_wheel(wheel_clients(published)) is None

    assert _degrade_records(caplog) == []


def test_frequency_to_stage_projection_is_the_named_mapping() -> None:
    """The projection is a named function mapping F{n} onto stage n, verbatim.

    Separately testable on purpose: the whole vault wheel rests on this one
    correspondence between Creek's Frequency keys and adepthood's stage numbers,
    and a projection reachable only through a transport is a projection nobody
    checks directly.
    """
    frequencies = _wheel_frequencies(_wheel_example("success"))

    aspects = _wheel_aspects(frequencies)

    assert [aspect.stage_number for aspect in aspects] == list(range(1, TOTAL_STAGES + 1))
    for aspect in aspects:
        entry = frequencies[f"F{aspect.stage_number}"]
        assert aspect.aspect == entry["name"]
        assert aspect.fullness == entry["share"]


@pytest.mark.asyncio
async def test_vault_wheel_and_local_wheel_are_not_conflated(
    db_session: AsyncSession,
    wheel_clients: Callable[[object], HttpCreekVaultClient],
) -> None:
    """The two wheels are different concepts, not two spellings of one.

    They share adepthood's Aspect vocabulary and nothing else: Creek's Frequency
    names never survive to a rendered wheel, the two fullness vectors disagree,
    and neither result mixes a number from the other source.
    """
    await _seed_all_stages(db_session)
    user_id = await _make_user(db_session)
    await _seed_habit_with_completion(db_session, user_id, stage_number=4)
    published = _wheel_example("success")
    shares = _published_shares(published)

    from_vault = await select_wheel_balance(wheel_clients(published), db_session, user_id)
    from_local = await select_wheel_balance(LocalFallbackCreekVaultClient(), db_session, user_id)

    curriculum = set(_CANONICAL_ASPECTS)
    creek_names = {str(entry["name"]) for entry in _wheel_frequencies(published).values()}
    assert {item["aspect"] for item in from_vault} <= curriculum
    assert {item["aspect"] for item in from_local} <= curriculum
    assert curriculum.isdisjoint(creek_names)
    assert [item["fullness"] for item in from_vault] == shares
    assert [item["fullness"] for item in from_local] != shares
    assert any(item["fullness"] > VAULT_WHEEL_FULLNESS_MIN for item in from_local)
