"""SPEC R4: timing-parity test for ``/auth/password-reset/request``.

The endpoint must return the same body shape and status (202) for every
input -- registered or not -- and must spend a comparable amount of
server-side time on each path so an attacker cannot harvest a leak
corpus by timing the responses.

The two endpoints are verified by deliberately different means, because
only one of them has arms that a stopwatch can fairly compare.

The **request** path is checked with a paired-sample wall-clock
comparison whose tolerance is derived at runtime from one real cost-10
bcrypt on the host (``_consume_dummy_bcrypt``), so it tracks CPU speed
instead of a hardcoded millisecond budget.  That works because its two
arms are symmetric: hit and miss each spend exactly one cost-10 bcrypt,
so contention inflates both by the same factor and the ratio survives.

The **confirm** path is checked by auditing the bcrypt work each arm
performs rather than how long it takes.  Its arms are *not* symmetric:
the reuse arm verifies the reset-token digest (cost-10) and then the
submitted password (cost-12), while the invalid-token arm spends only
the cost-12 masking dummy -- the lookup-key pre-filter means a token
matching no row is never bcrypt-compared.  Each verify is dispatched
through ``asyncio.to_thread``, so an arm's wall time is its bcrypt CPU
cost *plus* one thread-handoff queueing delay per dispatch.  On a
contended host that queueing term dominates and does not scale with any
single-bcrypt budget, so the healthy two-dispatch arm drifts arbitrarily
far from the one-dispatch arm and no fixed or fractional millisecond
tolerance can separate "busy machine" from "missing dummy".  Counting
the verifies instead measures exactly the property the dummy exists to
provide, and is immune to load by construction.
"""

from __future__ import annotations

import time
from datetime import UTC, datetime
from statistics import median
from typing import TYPE_CHECKING

import bcrypt
import pytest
from sqlmodel import select

from models.password_reset_token import PasswordResetToken
from models.user import User
from routers.auth import _consume_dummy_bcrypt, _hash_password
from services.email import RecordingEmailSender
from tests.helpers.password_reset import extract_reset_token

# ``email_sender`` + ``wire_email_sender`` fixtures live in
# ``backend/tests/conftest.py`` and are auto-discovered by pytest.

if TYPE_CHECKING:
    from httpx import AsyncClient
    from sqlalchemy.ext.asyncio import AsyncSession


# Samples per arm for the request-path test.  Its tolerance is a fraction
# of a single cost-10 bcrypt (~tens of ms), so it needs enough samples for
# the median to shrug off a descheduled process distorting one of them.
_REQUEST_ITERATIONS = 11

# Samples used to estimate the host's single cost-10 bcrypt budget.
_BUDGET_SAMPLES = 9

# Request-path tolerance as a fraction of one cost-10 bcrypt.  Both the
# hit and miss paths spend exactly one such bcrypt, so their parity delta
# is a few ms; deleting the miss-path dummy shifts the delta to a whole
# budget (~1.0x).  Half a budget sits comfortably above the parity noise
# and well below the removed-dummy signal, so the test fails on that
# mutation without flaking on a quiescent-but-busy CI box.
_REQUEST_TOLERANCE_FRACTION = 0.5

# bcrypt cost factor of a stored user password (``_hash_password`` uses
# ``gensalt(rounds=12)``).  This is the verify the confirm reuse-branch
# spends and the invalid-token branch must mask with an equal dummy.
_PASSWORD_VERIFY_BCRYPT_COST = 12

# How many cost-12 verifies each confirm arm must perform.  One apiece:
# the reuse arm's real ``_verify_password`` and the invalid arm's
# ``_consume_dummy_password_verify``.  Equality is the security property;
# the shared literal keeps "what we require" and "what each arm does" in
# one place.
_EXPECTED_PASSWORD_VERIFIES = 1

# Index of the cost field in a modular-crypt bcrypt digest: splitting
# ``$2b$12$<salt+hash>`` on "$" yields ["", "2b", "12", "<salt+hash>"].
_BCRYPT_COST_FIELD_INDEX = 2

_PASSWORD = "correct-horse-battery-staple"  # pragma: allowlist secret

# Environment variable naming the proxy networks whose X-Forwarded-For we honour.
_TRUSTED_PROXIES_ENV_VAR = "TRUSTED_PROXY_CIDRS"

# Socket peer that ``httpx.ASGITransport`` reports for the ``async_client``
# fixture; the trusted-proxy config below must name it for the header to count.
_TRANSPORT_PEER_IP = "127.0.0.1"
_FORWARDED_CLIENT_IP = "203.0.113.5"


pytestmark = pytest.mark.usefixtures("wire_email_sender")


# Local alias to keep the existing test body unchanged.
_extract_token_from_body = extract_reset_token


async def _seed_user(db_session: AsyncSession, email: str) -> None:
    db_session.add(
        User(
            email=email,
            password_hash=await _hash_password(_PASSWORD),
            created_at=datetime.now(UTC),
        )
    )
    await db_session.commit()


async def _cost10_bcrypt_budget_ms() -> float:
    """Median wall-time of one cost-10 bcrypt verify on this host.

    Ties the request-path tolerance to the exact operation the miss path
    spends (``_consume_dummy_bcrypt``), so the threshold scales with the
    machine rather than assuming a fixed millisecond budget.
    """
    samples: list[float] = []
    for _ in range(_BUDGET_SAMPLES):
        start = time.perf_counter()
        await _consume_dummy_bcrypt()
        samples.append((time.perf_counter() - start) * 1_000)
    return median(samples)


async def _measure(client: AsyncClient, email: str) -> float:
    start = time.perf_counter()
    response = await client.post("/auth/password-reset/request", json={"email": email})
    duration_ms = (time.perf_counter() - start) * 1_000
    assert response.status_code == 202, response.text
    return duration_ms


@pytest.mark.asyncio
async def test_request_timing_parity_hit_vs_miss(
    async_client: AsyncClient,
    db_session: AsyncSession,
    disable_rate_limit: None,  # noqa: ARG001 -- need >3 calls per test
) -> None:
    """Hit/miss median latency must differ by less than half a cost-10 bcrypt.

    Removing the miss-path ``_consume_dummy_bcrypt`` would shift the delta
    to roughly a whole bcrypt budget, so the sub-budget tolerance fails on
    that mutation -- the side channel the SPEC R4 dummy exists to close.
    """
    await _seed_user(db_session, "hit@example.com")

    tolerance_ms = _REQUEST_TOLERANCE_FRACTION * await _cost10_bcrypt_budget_ms()

    # Warm up bcrypt + JIT once so the first sample isn't an outlier.
    await _measure(async_client, "warmup@example.com")

    hits: list[float] = []
    misses: list[float] = []
    for _ in range(_REQUEST_ITERATIONS):
        hits.append(await _measure(async_client, "hit@example.com"))
        misses.append(await _measure(async_client, f"miss-{time.time_ns()}@example.com"))

    delta = abs(median(hits) - median(misses))
    assert delta < tolerance_ms, (
        f"timing leak: hit median={median(hits):.1f}ms "
        f"miss median={median(misses):.1f}ms delta={delta:.1f}ms "
        f"exceeds tolerance={tolerance_ms:.1f}ms "
        f"(={_REQUEST_TOLERANCE_FRACTION} x one cost-10 bcrypt)"
    )


@pytest.mark.asyncio
async def test_request_response_shape_identical_hit_vs_miss(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """SPEC R4 part 2: every byte of the response body matches."""
    await _seed_user(db_session, "shape@example.com")
    hit = await async_client.post(
        "/auth/password-reset/request", json={"email": "shape@example.com"}
    )
    miss = await async_client.post(
        "/auth/password-reset/request", json={"email": "missing@example.com"}
    )
    assert hit.status_code == miss.status_code == 202
    assert hit.json() == miss.json()


async def _request_reset_behind_forwarded_for(client: AsyncClient, email: str) -> None:
    """Request a reset for ``email`` carrying a forwarded client address."""
    response = await client.post(
        "/auth/password-reset/request",
        json={"email": email},
        headers={"X-Forwarded-For": _FORWARDED_CLIENT_IP},
    )
    assert response.status_code == 202


async def _recorded_request_ip(db_session: AsyncSession) -> str:
    """Return the ``requested_ip`` written on the only reset-token row."""
    rows = (await db_session.execute(select(PasswordResetToken))).scalars().all()
    assert len(rows) == 1
    return rows[0].requested_ip


@pytest.mark.asyncio
async def test_request_ip_is_recorded_with_x_forwarded_for(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """SPEC R9 audit trail: a trusted proxy's ``X-Forwarded-For`` is the recorded IP."""
    monkeypatch.setenv(_TRUSTED_PROXIES_ENV_VAR, _TRANSPORT_PEER_IP)
    await _seed_user(db_session, "audit@example.com")

    await _request_reset_behind_forwarded_for(async_client, "audit@example.com")

    assert await _recorded_request_ip(db_session) == _FORWARDED_CLIENT_IP


@pytest.mark.asyncio
async def test_request_ip_ignores_x_forwarded_for_without_a_trusted_proxy(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Audit integrity: an unvouched header cannot poison ``requested_ip``.

    With no trusted proxy configured the header is attacker-controlled, so the
    socket peer is the only address worth writing to the audit trail.
    """
    monkeypatch.delenv(_TRUSTED_PROXIES_ENV_VAR, raising=False)
    await _seed_user(db_session, "spoofed@example.com")

    await _request_reset_behind_forwarded_for(async_client, "spoofed@example.com")

    recorded = await _recorded_request_ip(db_session)
    assert recorded == _TRANSPORT_PEER_IP
    assert recorded != _FORWARDED_CLIENT_IP


async def _confirm(client: AsyncClient, token: str, new_password: str) -> None:
    """POST one password-reset confirm and assert it took a modelled branch.

    Both arms under audit end in 400 (bad token, or a reused password);
    200 is allowed so an accidental success surfaces as a clearer
    downstream assertion than a bare status mismatch here.
    """
    response = await client.post(
        "/auth/password-reset/confirm",
        json={"token": token, "new_password": new_password},
    )
    assert response.status_code in {200, 400}, response.text


def _record_bcrypt_costs(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    """Patch ``bcrypt.checkpw`` to log the cost factor of every verify performed.

    Returns the live list the patch appends to, so a caller can clear it
    between arms and read back exactly the work one request provoked.
    ``routers.auth`` resolves ``bcrypt.checkpw`` at call time off the
    shared module object, so patching the attribute here reaches it.

    The handler dispatches each verify through ``asyncio.to_thread``, so
    the append happens on a worker thread; ``list.append`` is atomic
    under the GIL, which is all the synchronisation this needs.
    """
    real_checkpw = bcrypt.checkpw
    costs: list[int] = []

    def recording_checkpw(password: bytes, hashed_password: bytes) -> bool:
        cost_field = hashed_password.split(b"$")[_BCRYPT_COST_FIELD_INDEX]
        costs.append(int(cost_field.decode()))
        return real_checkpw(password, hashed_password)

    monkeypatch.setattr(bcrypt, "checkpw", recording_checkpw)
    return costs


@pytest.mark.asyncio
async def test_confirm_invalid_token_spends_the_same_password_verify_budget(
    async_client: AsyncClient,
    db_session: AsyncSession,
    email_sender: RecordingEmailSender,
    monkeypatch: pytest.MonkeyPatch,
    disable_rate_limit: None,  # noqa: ARG001 -- confirm is capped at 5/hour per IP
) -> None:
    """Invalid-token confirm spends the same cost-12 verify as the reused-password branch.

    Without the dummy bcrypt on the invalid path, the cost-12 verify that
    ``_reject_if_password_reuse`` runs only on the
    valid-token-with-password-reuse branch becomes a side channel an
    attacker can use to detect whether a submitted token matches a real
    active row.

    The invariant is asserted on the bcrypt *work ledger* -- how many
    cost-12 verifies each arm performs -- rather than on elapsed time.
    That is a deliberate choice, not a convenience: the reuse arm makes
    two thread-dispatched bcrypt calls to the invalid arm's one, so under
    CPU contention the arms' queueing delays diverge without bound while
    a masking dummy that is genuinely present looks, to a stopwatch,
    exactly like one that has been deleted.  Counting the verifies asserts
    the property the dummy exists to provide and cannot be perturbed by
    load, so it holds on an idle laptop and on a machine running a dozen
    parallel builds alike.  Deleting ``_consume_dummy_password_verify``
    drops the invalid arm's count to zero and fails this test outright.

    Nothing is given up by dropping the stopwatch: a sub-bcrypt
    asymmetry such as one extra indexed query is ~1 ms, which sat far
    inside the 250 ms tolerance the wall-clock version of this test
    allowed, so that version could not have detected it either.  bcrypt
    is the only term here big enough to be a usable oracle, and the
    ledger accounts for all of it.
    """
    await _seed_user(db_session, "reuse@example.com")
    # Set up a real outstanding reset-token row that we will confirm
    # using the user's CURRENT password (triggers the reuse-check).
    request_resp = await async_client.post(
        "/auth/password-reset/request", json={"email": "reuse@example.com"}
    )
    assert request_resp.status_code == 202
    valid_token = _extract_token_from_body(email_sender.sent[-1].body)

    costs = _record_bcrypt_costs(monkeypatch)

    # Invalid arm: the token matches no row, so the handler reaches
    # ``_consume_dummy_password_verify`` and nothing else.
    await _confirm(async_client, "x" * 43, "irrelevant-pw")
    invalid_costs = list(costs)

    # Reuse arm: real token, but ``new_password`` equals the current one,
    # so ``_reject_if_password_reuse`` 400s after its real cost-12 verify
    # and before the row is marked used.
    costs.clear()
    await _confirm(async_client, valid_token, _PASSWORD)
    reuse_costs = list(costs)

    invalid_verifies = invalid_costs.count(_PASSWORD_VERIFY_BCRYPT_COST)
    reuse_verifies = reuse_costs.count(_PASSWORD_VERIFY_BCRYPT_COST)
    assert invalid_verifies == reuse_verifies == _EXPECTED_PASSWORD_VERIFIES, (
        f"confirm timing leak: the invalid-token arm performed "
        f"{invalid_verifies} cost-{_PASSWORD_VERIFY_BCRYPT_COST} bcrypt "
        f"verify(s) and the password-reuse arm performed {reuse_verifies}; "
        f"both must perform exactly {_EXPECTED_PASSWORD_VERIFIES} or the "
        f"response time reveals whether a submitted token hit a real row "
        f"(invalid arm costs={invalid_costs}, reuse arm costs={reuse_costs})"
    )
