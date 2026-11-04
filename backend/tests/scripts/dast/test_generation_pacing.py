"""Seeds that spend the owner's generations wait their turn; probes still may not be throttled.

The application admits five generations a minute per user (#623), and the
matrix seeds every lettered margin note as one owner (#3658). So
:mod:`scripts.dast.pacing` holds the paced seeds under the server's limit, waits
out a 429 a paced seed is answered with, and stops the run as a harness error
once the waiting would cross its cap. These tests pin each of those, and the one
property the pacing must never weaken: a 429 on a *probe* still fails the run.

The runner-level tests drive the real matrix at a small stub app with one paced
create and one owner-scoped read, on an injected clock, so a minute of waiting
costs nothing to run.

No ``from __future__ import annotations`` here, as in this package's conftest:
FastAPI resolves a route's ``Annotated[..., Depends(actor)]`` from the closure it
was defined in, which a postponed string annotation cannot see.
"""

import secrets
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from http import HTTPStatus
from typing import Annotated

import pytest
import pytest_asyncio
from fastapi import Depends, FastAPI, Header, HTTPException, Response
from httpx import AsyncClient
from pydantic import BaseModel

from scripts.dast.pacing import (
    DEFAULT_MAX_PACING_SECONDS,
    GENERATION_WINDOW_SECONDS,
    PACED_PER_WINDOW,
    PROBE_RESERVE,
    Pacer,
    PacingCapError,
    PacingPolicy,
    retry_after_seconds,
)
from scripts.dast.report import EXIT_CLEAN, EXIT_HARNESS_ERROR, MatrixReport
from scripts.dast.runner import DEFAULT_BUDGET_SECONDS, MatrixConfig, run_matrix
from scripts.dast.seeds import SeedSpec
from scripts.dast.verdict import CELL_ORDER, Verdict
from services.generation_guardrails import GENERATIONS_PER_MINUTE_PER_USER
from tests.scripts.dast.conftest import (
    StubCredentials,
    StubDeployment,
    StubStore,
    make_stub_bootstrap,
    stub_client,
)

_LETTERS_PATH = "/letters/"
_LETTER_ROUTE = ("GET", "/letters/{letter_id}")
_ADVERTISED_RETRY_SECONDS = 7
_CAP_SECONDS = 30.0
_WINDOW = 60.0
_PER_WINDOW = 2
# Far past any cap a test sets: the stub stops refusing here, so a harness
# whose cap never fires fails an assertion instead of retrying forever.
_REFUSAL_BREAKER = 50


# ── An injected clock ─────────────────────────────────────────────────────


@dataclass
class _FakeTime:
    """A monotonic clock that only moves when something sleeps on it."""

    now: float = 1_000.0
    sleeps: list[float] = field(default_factory=list)

    def clock(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds

    def policy(self, *, per_window: int = _PER_WINDOW, cap: float = _CAP_SECONDS) -> PacingPolicy:
        return PacingPolicy(
            per_window=per_window,
            window_seconds=_WINDOW,
            max_wait_seconds=cap,
            clock=self.clock,
            sleep=self.sleep,
        )


# ── The pacer on its own ──────────────────────────────────────────────────


def test_the_paced_budget_is_the_servers_limit_less_the_probe_reserve() -> None:
    """Derived from the server's own constant, so the two cannot drift apart."""
    assert PROBE_RESERVE >= 1
    assert PACED_PER_WINDOW == GENERATIONS_PER_MINUTE_PER_USER - PROBE_RESERVE
    assert GENERATION_WINDOW_SECONDS == 60.0


def test_the_pacing_cap_sits_inside_the_matrix_budget() -> None:
    """The budget still measures the whole run, waits included, so the cap must fit in it."""
    assert DEFAULT_MAX_PACING_SECONDS < DEFAULT_BUDGET_SECONDS


@pytest.mark.asyncio
async def test_the_pacer_admits_a_full_window_then_waits_for_the_oldest_to_leave() -> None:
    """Up to ``per_window`` creates go at once; the next waits exactly until the oldest leaves."""
    time = _FakeTime()
    pacer = Pacer(time.policy(cap=_WINDOW))
    await pacer.admit()
    pacer.record()
    time.now += 10.0
    await pacer.admit()
    pacer.record()
    assert time.sleeps == []

    time.now += 5.0
    await pacer.admit()

    assert time.sleeps == [_WINDOW - 15.0]
    assert pacer.waited_seconds == _WINDOW - 15.0
    assert list(pacer.spent) == [time.now - (_WINDOW - 10.0)]


@pytest.mark.asyncio
async def test_a_wait_past_the_cap_raises_before_sleeping() -> None:
    """The cap is checked first: a run that cannot finish says so at once."""
    time = _FakeTime()
    pacer = Pacer(time.policy(cap=10.0))
    await pacer.wait(6.0)

    with pytest.raises(PacingCapError, match="pacing cap"):
        await pacer.wait(5.0)

    assert time.sleeps == [6.0]
    assert pacer.waited_seconds == 6.0


@pytest.mark.parametrize(
    ("headers", "expected"),
    [
        ({"Retry-After": "7"}, 7.0),
        ({"retry-after": " 12 "}, 12.0),
        ({"Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"}, None),
        ({}, None),
    ],
)
def test_retry_after_is_read_in_whole_seconds_only(
    headers: dict[str, str], expected: float | None
) -> None:
    """An HTTP-date is not guessed at; the pacer waits a whole window instead."""
    assert retry_after_seconds(headers) == expected


@pytest.mark.asyncio
async def test_a_refusal_without_retry_after_waits_a_whole_window() -> None:
    """No advertised wait means the longest the window could still be full."""
    time = _FakeTime()
    pacer = Pacer(time.policy(cap=_WINDOW))

    await pacer.wait_out({})

    assert time.sleeps == [_WINDOW]
    assert pacer.refusals == 1


# ── The runner, against a stub with one paced create ─────────────────────


class _LoginIn(BaseModel):
    email: str
    password: str


class _TokenOut(BaseModel):
    token: str


class _IdOut(BaseModel):
    id: int


@dataclass
class _Desk:
    """The stub's letters, and how its create and read are told to misbehave."""

    letters: dict[int, str] = field(default_factory=dict)
    creates: int = 0
    refusals: int = 0
    refuse_creates: int = 0
    refuse_forever: bool = False
    throttle_owner_reads: bool = False


def _actor_dependency(store: StubStore) -> Callable[..., Awaitable[str]]:
    """The stub's bearer check: the caller's email, or 401."""

    async def actor(authorization: Annotated[str | None, Header()] = None) -> str:
        email = store.tokens.get((authorization or "").removeprefix("Bearer "))
        if email is None:
            raise HTTPException(status_code=HTTPStatus.UNAUTHORIZED, detail="unauthorized")
        return email

    return actor


def _mount_login(app: FastAPI, store: StubStore) -> None:
    """A minimal ``POST /auth/login`` that mints a bearer token."""

    @app.post("/auth/login")
    async def login(payload: _LoginIn) -> _TokenOut:
        if store.passwords.get(payload.email) != payload.password:
            raise HTTPException(status_code=HTTPStatus.UNAUTHORIZED, detail="unauthorized")
        token = secrets.token_urlsafe(16)
        store.tokens[token] = payload.email
        return _TokenOut(token=token)


def _refused_create() -> Response:
    """The generation window's answer: not yet, and when to ask again."""
    return Response(
        status_code=HTTPStatus.TOO_MANY_REQUESTS,
        headers={"Retry-After": str(_ADVERTISED_RETRY_SECONDS)},
    )


def _mount_letters(
    app: FastAPI, store: StubStore, desk: _Desk, actor: Callable[..., Awaitable[str]]
) -> None:
    """``POST /letters/`` stands in for a generation; ``GET /letters/{id}`` is owner-scoped."""

    @app.get(_LETTERS_PATH)
    async def list_letters(caller: Annotated[str, Depends(actor)]) -> list[int]:
        return [key for key, owner in desk.letters.items() if owner == caller]

    @app.post(_LETTERS_PATH, status_code=HTTPStatus.CREATED, response_model=None)
    async def write_letter(caller: Annotated[str, Depends(actor)]) -> _IdOut | Response:
        if desk.refusals >= _REFUSAL_BREAKER:
            # Only a harness with no cap gets here; failing loudly beats hanging.
            return Response(status_code=HTTPStatus.SERVICE_UNAVAILABLE)
        if desk.refuse_forever or desk.refuse_creates:
            desk.refuse_creates = max(desk.refuse_creates - 1, 0)
            desk.refusals += 1
            return _refused_create()
        desk.creates += 1
        letter_id = store.allocate_id()
        desk.letters[letter_id] = caller
        return _IdOut(id=letter_id)

    @app.get("/letters/{letter_id}")
    async def read_letter(letter_id: int, caller: Annotated[str, Depends(actor)]) -> _IdOut:
        if desk.letters.get(letter_id) != caller:
            raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail="not_found")
        if desk.throttle_owner_reads:
            raise HTTPException(status_code=HTTPStatus.TOO_MANY_REQUESTS, detail="slow down")
        return _IdOut(id=letter_id)


def _build_letter_app(desk: _Desk) -> StubDeployment:
    """The paced stub, with two identities registered, owner first."""
    store = StubStore()
    app = FastAPI(title="dast-stub-paced")
    _mount_login(app, store)
    _mount_letters(app, store, desk, _actor_dependency(store))
    owner = StubCredentials("A", "paced-a@example.com", secrets.token_urlsafe(12))
    intruder = StubCredentials("B", "paced-b@example.com", secrets.token_urlsafe(12))
    for credentials in (owner, intruder):
        store.passwords[credentials.email] = credentials.password
    return StubDeployment(app=app, store=store, owner=owner, intruder=intruder)


_PACED_REGISTRY = {
    "letter_id": SeedSpec(
        create_method="POST",
        create_path=_LETTERS_PATH,
        payload={},
        id_pointer=("id",),
        paced=True,
    ),
}


@dataclass
class _Harness:
    """One stub deployment, its desk, a client into it, and the clock the run uses."""

    desk: _Desk
    deployment: StubDeployment
    client: AsyncClient
    time: _FakeTime

    async def run(self, *, shared: bool = False, cap: float = _CAP_SECONDS) -> MatrixReport:
        config = MatrixConfig(
            seed_registry=_PACED_REGISTRY,
            replay_bodies={},
            reference_registry={},
            auth_probe_path=_LETTERS_PATH,
            min_routes=1,
            min_references=0,
            shared_seed_routes=frozenset({_LETTER_ROUTE}) if shared else frozenset(),
            pacing=self.time.policy(cap=cap),
        )
        return await run_matrix(
            self.client, bootstrap=make_stub_bootstrap(self.deployment), config=config
        )


@pytest_asyncio.fixture
async def harness() -> AsyncIterator[_Harness]:
    """A fresh paced stub per test."""
    desk = _Desk()
    deployment = _build_letter_app(desk)
    async with stub_client(deployment) as client:
        yield _Harness(desk=desk, deployment=deployment, client=client, time=_FakeTime())


def _letter_cells(report: MatrixReport) -> list[Verdict]:
    return [result.verdict for result in report.results if result.route.path == _LETTER_ROUTE[1]]


@pytest.mark.asyncio
async def test_a_paced_seed_answered_429_waits_its_retry_after_and_the_run_still_passes(
    harness: _Harness,
) -> None:
    """The refused create is waited out and resent; that 429 is no throttled probe."""
    harness.desk.refuse_creates = 1

    report = await harness.run(shared=True)

    assert report.exit_code == EXIT_CLEAN, [failure.detail for failure in report.guard_failures]
    assert _letter_cells(report) == [Verdict.PASS] * len(CELL_ORDER)
    assert report.paced_refusals == 1
    assert _ADVERTISED_RETRY_SECONDS in harness.time.sleeps
    assert report.paced_seconds >= _ADVERTISED_RETRY_SECONDS


@pytest.mark.asyncio
async def test_seeding_past_the_pacing_cap_is_a_harness_error_never_a_pass(
    harness: _Harness,
) -> None:
    """A server that never admits the create runs the waits into the cap: exit 3."""
    harness.desk.refuse_forever = True

    report = await harness.run()

    assert report.exit_code == EXIT_HARNESS_ERROR
    assert report.results == ()
    (failure,) = report.guard_failures
    assert "pacing cap" in failure.detail
    assert sum(harness.time.sleeps) <= _CAP_SECONDS
    assert harness.desk.refusals < _REFUSAL_BREAKER


@pytest.mark.asyncio
async def test_a_429_on_a_probe_still_fails_the_run_while_seeds_are_paced(
    harness: _Harness,
) -> None:
    """Pacing excuses a seed waiting its turn, never a probe the limiter answered."""
    harness.desk.throttle_owner_reads = True

    report = await harness.run(shared=True)

    assert report.exit_code == EXIT_HARNESS_ERROR
    assert "require_no_throttling" in {failure.guard for failure in report.guard_failures}


@pytest.mark.asyncio
async def test_the_ledger_paces_creates_before_the_server_ever_refuses_one(
    harness: _Harness,
) -> None:
    """Four cells seeded per cell overrun a two-per-window ledger, so the run waits, unrefused."""
    report = await harness.run(cap=_WINDOW)

    assert report.exit_code == EXIT_CLEAN, [failure.detail for failure in report.guard_failures]
    assert harness.desk.creates == len(CELL_ORDER)
    assert report.paced_refusals == 0
    assert report.paced_seconds > 0


@pytest.mark.asyncio
async def test_a_shared_seed_route_seeds_once_for_all_four_cells(harness: _Harness) -> None:
    """One create, four graded cells, all against the same object, and no waiting at all."""
    report = await harness.run(shared=True)

    assert report.exit_code == EXIT_CLEAN, [failure.detail for failure in report.guard_failures]
    assert harness.desk.creates == 1
    sent = {dict(result.object_ids)["letter_id"] for result in report.results}
    assert len(sent) == 1
    assert _letter_cells(report) == [Verdict.PASS] * len(CELL_ORDER)
    assert harness.time.sleeps == []
