"""Drive the matrix against a running instance: the one module that does any I/O.

Everything the harness knows how to decide lives in the pure modules beside this
one. What is left here is the part that cannot be pure -- issuing requests -- and
it is deliberately narrow: an ``httpx.AsyncClient`` and an identity bootstrap are
handed in, so the whole matrix can be exercised in-process against a throwaway
application with no socket, no database, and no server to start.

Three decisions in here carry most of the weight.

A fresh object is seeded for every *cell*, not merely for every route. A route
whose cross-user cell is a ``DELETE`` destroys the very row its positive control
needs; sharing one object across the four cells would leave that control
answering 404, which grades as inconclusive and hides a genuine mutating leak
behind a harness error.

The owner's own call runs last, after the probes that might destroy its object,
for the same reason.

Every request carries its own forwarded client address. The application applies
a global per-minute rate limit, and a throttled matrix answers uniformly no to
everything -- which is indistinguishable from an application that denies
correctly. Spreading the requests keeps the limiter out of the way, and the
throttling guard fails the run outright if a single 429 gets through anyway.

Because this is the module that touches the network, it is also the module that
must never let the network end the process. An uncaught exception exits 1, and 1
is the code for a genuine authorization finding -- so an unreachable instance
would report as a BOLA. Every live stage therefore runs inside :func:`_stage`,
which turns an operational failure into a named guard failure and lets the run
finish as an ordinary report with exit code 3.
"""

from __future__ import annotations

import secrets
from collections.abc import Awaitable, Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from json import JSONDecodeError
from textwrap import shorten
from time import perf_counter

import jwt
from httpx import AsyncClient, HTTPError, Response
from sqlalchemy.exc import SQLAlchemyError

from scripts.dast.discovery import RouteSpec, discover_routes, is_object_scoped
from scripts.dast.policy import AllowlistEntry, Classification, classify_routes
from scripts.dast.report import MatrixReport
from scripts.dast.seeds import (
    REPLAY_BODIES,
    SEED_REGISTRY,
    UNIQUE_FIELD,
    SeedSpec,
    create_body,
    render_text,
    replay_body,
    resolve_id,
    seed_order,
)
from scripts.dast.verdict import (
    CELL_ORDER,
    Cell,
    CellResult,
    GuardFailure,
    LiveFailure,
    judge,
    require_allowlist_bounded,
    require_auth_established,
    require_live_stages_completed,
    require_minimum_coverage,
    require_no_throttling,
    require_positive_controls,
    require_seeded_resources,
    require_within_budget,
)

DEFAULT_MIN_ROUTES = 20
DEFAULT_BUDGET_SECONDS = 120.0
DEFAULT_MAX_ALLOWLIST_FRACTION = 0.5

# A collection route that needs a credential: probed with and without one, it
# proves both that the token works and that refusals are possible at all.
DEFAULT_AUTH_PROBE_PATH = "/habits/"

_OPENAPI_PATH = "/openapi.json"
_SUCCESS_FLOOR = 200
_SUCCESS_CEILING = 300

# Enough entropy that two objects seeded a millisecond apart cannot collide on a
# unique slug or a habit name.
_UNIQUE_TOKEN_BYTES = 5

# The forged credential is signed with a key generated here and shared with
# nobody, which is the whole point: a valid-shaped token that no deployment can
# possibly verify.
_FORGED_KEY_BYTES = 32
_FORGED_ALGORITHM = "HS256"
_FORGED_SUBJECT = "1"
_FORGED_LIFETIME = timedelta(hours=1)

# Requests are spread across a private /8 so the per-minute limiter, which keys
# on the forwarded client address, never sees the same caller twice.
_FORWARDED_PREFIX = "10"
_FORWARDED_OCTETS = 3
_OCTET_RANGE = 256

ReplayBodies = Mapping[tuple[str, str], Mapping[str, object]]


class LiveTargetError(Exception):
    """A resource the run depends on could not be reached or used.

    Raised where the failing resource is not the HTTP target the runner already
    names -- the identity bootstrap's database above all -- so the message can
    carry that resource itself. The runner reports it as a harness error instead
    of letting it leave the process, because an uncaught exception exits 1, the
    same code the gate uses for a genuine authorization finding.
    """


# Failures of the target, its database, or the network in between: each leaves
# the matrix with nothing to say about authorization, so each is reported rather
# than raised. Deliberately narrow -- a ``TypeError`` in the harness is a bug and
# must still surface as one -- and deliberately all ``Exception`` subclasses, so
# ``KeyboardInterrupt`` and ``SystemExit`` are never captured here.
_OPERATIONAL_ERRORS = (HTTPError, OSError, SQLAlchemyError, JSONDecodeError, LiveTargetError)

# The live stages, phrased the way the report should name them.
_STAGE_BOOTSTRAP = "the identity bootstrap"
_STAGE_AUTH_PROBE = "the auth probe"
_STAGE_DISCOVERY = f"the {_OPENAPI_PATH} fetch"
_STAGE_PROBES = "the route probes"

# One driver error can run to several paragraphs; a gate's output wants a line.
_MAX_SUMMARY_CHARS = 240

# The auth probe of a run that never reached it: no status at all, which is not
# 200 and not 401, so nothing downstream can read it as a healthy answer.
_NO_STATUS = 0


@dataclass(frozen=True)
class Identity:
    """One logged-in actor of the matrix.

    Attributes:
        label: How the report names this actor, ``"A"`` or ``"B"``.
        email: The address the identity was created with.
        token: A bearer token minted by the target's own login route.
    """

    label: str
    email: str
    token: str


# Injected so production can insert user rows through the application's own ORM
# while a stub supplies identities its in-memory store already knows.
Bootstrap = Callable[[AsyncClient], Awaitable[tuple[Identity, Identity]]]


@dataclass(frozen=True)
class MatrixConfig:
    """Everything one run needs beyond a client and an identity bootstrap.

    Bundled into one frozen object rather than passed as eight keyword
    arguments, so adding a knob does not widen every signature between here and
    the CLI.

    Attributes:
        seed_registry: Seed strategies, keyed by path-parameter name.
        replay_bodies: Valid request bodies for the mutating replays.
        allowlist: The loaded opt-out entries.
        auth_probe_path: The route used to prove authentication works.
        min_routes: The floor the coverage guard enforces.
        budget_seconds: The ceiling the time-box guard enforces.
        max_allowlist_fraction: The share of routes the allow-list may excuse.
    """

    # Both constants are ``MappingProxyType``, which Python 3.11 rejects as a
    # dataclass default; the factories hand back those same shared objects.
    seed_registry: Mapping[str, SeedSpec] = field(default_factory=lambda: SEED_REGISTRY)
    replay_bodies: ReplayBodies = field(default_factory=lambda: REPLAY_BODIES)
    allowlist: tuple[AllowlistEntry, ...] = ()
    auth_probe_path: str = DEFAULT_AUTH_PROBE_PATH
    min_routes: int = DEFAULT_MIN_ROUTES
    budget_seconds: float = DEFAULT_BUDGET_SECONDS
    max_allowlist_fraction: float = DEFAULT_MAX_ALLOWLIST_FRACTION


@dataclass
class _Session:
    """The mutable state of one run: who is logged in, and what has been seen."""

    client: AsyncClient
    config: MatrixConfig
    owner: Identity
    intruder: Identity
    forged_token: str
    statuses: list[int] = field(default_factory=list)


@dataclass(frozen=True)
class _AuthProbe:
    """What the auth probe route answered, with and without a credential."""

    authenticated_status: int
    unauthenticated_status: int


@dataclass(frozen=True)
class _Outcome:
    """One finished run, before it is graded into a report.

    ``live_failure`` is set only when a stage of live I/O failed outright, in
    which case every other field is empty by construction. That is deliberate:
    the tallies of a run that broke off partway are not numbers anybody should
    read as coverage, and reporting zero says plainly that nothing was proven.
    """

    routes: tuple[RouteSpec, ...]
    classification: Classification
    probe: _AuthProbe
    results: tuple[CellResult, ...]
    seeded: int
    unseedable: tuple[str, ...]
    statuses: tuple[int, ...]
    elapsed_seconds: float
    live_failure: LiveFailure | None = None


class _StageError(Exception):
    """An operational failure, tagged with the live stage it happened in."""

    def __init__(self, stage: str, cause: Exception) -> None:
        """Record which stage failed and what it raised."""
        super().__init__(f"{stage}: {cause}")
        self.stage = stage
        self.cause = cause


@contextmanager
def _stage(name: str) -> Iterator[None]:
    """Tag any operational failure raised inside the block with the stage's name.

    Args:
        name: How the report should name what was being done.

    Yields:
        Nothing; the block is the stage.

    Raises:
        _StageError: When the target, its database, or the network failed. Every
            other exception passes through untouched, because a bug in the
            harness must not be laundered into "the instance was unreachable".
    """
    try:
        yield
    except _OPERATIONAL_ERRORS as error:
        raise _StageError(name, error) from error


def forwarded_for() -> str:
    """Return a fresh forwarded client address for one request.

    Drawn from a private /8 with a cryptographic source, so ~400 requests share
    a key with vanishing probability and no request can inherit the previous
    one's rate-limit budget.
    """
    octets = (str(secrets.randbelow(_OCTET_RANGE)) for _ in range(_FORWARDED_OCTETS))
    return ".".join((_FORWARDED_PREFIX, *octets))


def _forged_token() -> str:
    """Mint a well-formed JWT signed with a key no deployment can verify."""
    claims = {
        "sub": _FORGED_SUBJECT,
        "exp": datetime.now(UTC) + _FORGED_LIFETIME,
    }
    return jwt.encode(claims, secrets.token_urlsafe(_FORGED_KEY_BYTES), algorithm=_FORGED_ALGORITHM)


def _is_success(status: int) -> bool:
    """Report whether ``status`` is a 2xx."""
    return _SUCCESS_FLOOR <= status < _SUCCESS_CEILING


async def _send(
    session: _Session,
    method: str,
    path: str,
    *,
    token: str | None,
    body: Mapping[str, object] | None = None,
) -> Response:
    """Issue one request, recording its status for the throttling guard."""
    headers = {"X-Forwarded-For": forwarded_for()}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    response = await session.client.request(method, path, headers=headers, json=body)
    session.statuses.append(response.status_code)
    return response


async def _seed_one(session: _Session, spec: SeedSpec, values: dict[str, str]) -> str | None:
    """Create one object as the owner and return its id, or ``None`` on failure."""
    fields: dict[str, object] = {**values, UNIQUE_FIELD: secrets.token_hex(_UNIQUE_TOKEN_BYTES)}
    response = await _send(
        session,
        spec.create_method,
        render_text(spec.create_path, fields),
        token=session.owner.token,
        body=create_body(spec, fields),
    )
    if not _is_success(response.status_code):
        return None
    return resolve_id(response.json(), spec.id_pointer)


async def _seed_cell(session: _Session, route: RouteSpec) -> dict[str, str] | None:
    """Create a fresh object for every parameter of one route, dependencies first.

    Args:
        session: The run's state.
        route: The route whose parameters need objects.

    Returns:
        The seeded ids keyed by parameter name, or ``None`` when any create
        failed -- in which case the route is reported as unseedable rather than
        probed against ids that do not exist.
    """
    values: dict[str, str] = {}
    for param in seed_order(route.params, session.config.seed_registry):
        seeded = await _seed_one(session, session.config.seed_registry[param], values)
        if seeded is None:
            return None
        values[param] = seeded
    return values


def _token_for(session: _Session, cell: Cell) -> str | None:
    """Return the credential one cell sends, or ``None`` for the unauthenticated cell."""
    if cell is Cell.CROSS_USER:
        return session.intruder.token
    if cell is Cell.FORGED_JWT:
        return session.forged_token
    if cell is Cell.POSITIVE_CONTROL:
        return session.owner.token
    return None


async def _run_cell(session: _Session, route: RouteSpec, cell: Cell) -> CellResult | None:
    """Seed a fresh object, probe one route with one credential, and grade the answer."""
    values = await _seed_cell(session, route)
    if values is None:
        return None
    resolved = render_text(route.path, values)
    response = await _send(
        session,
        route.method,
        resolved,
        token=_token_for(session, cell),
        body=replay_body(route, session.config.replay_bodies),
    )
    return CellResult(
        route=route,
        cell=cell,
        resolved_path=resolved,
        object_ids=tuple((param, values[param]) for param in route.params),
        status=response.status_code,
        verdict=judge(cell, response.status_code),
    )


async def _run_route(session: _Session, route: RouteSpec) -> tuple[CellResult, ...] | None:
    """Run all four cells of one route in order, or report it unseedable."""
    results: list[CellResult] = []
    for cell in CELL_ORDER:
        result = await _run_cell(session, route, cell)
        if result is None:
            return None
        results.append(result)
    return tuple(results)


async def _fetch_document(session: _Session) -> Mapping[str, object]:
    """Fetch the target's own OpenAPI document.

    Args:
        session: The run's state.

    Returns:
        The parsed document, or an empty one when the body is valid JSON that is
        not a document at all -- which the coverage guard then reports as a
        harness error, the same as any other run that probed nothing.

    ``raise_for_status`` is what turns an instance answering 404 or 502 here into
    a named failure rather than a parse error three lines later.
    """
    response = await _send(session, "GET", _OPENAPI_PATH, token=None)
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, Mapping):
        return {}
    document: Mapping[str, object] = payload
    return document


async def _probe_auth(session: _Session) -> _AuthProbe:
    """Ask the probe route the same question twice: with a credential, and without."""
    path = session.config.auth_probe_path
    authenticated = await _send(session, "GET", path, token=session.owner.token)
    unauthenticated = await _send(session, "GET", path, token=None)
    return _AuthProbe(
        authenticated_status=authenticated.status_code,
        unauthenticated_status=unauthenticated.status_code,
    )


async def _probe_routes(
    session: _Session,
    covered: Sequence[RouteSpec],
) -> tuple[tuple[CellResult, ...], tuple[str, ...]]:
    """Probe every covered route, collecting the cells and the routes that would not seed."""
    results: list[CellResult] = []
    unseedable: list[str] = []
    for route in covered:
        cells = await _run_route(session, route)
        if cells is None:
            unseedable.append(f"{route.method} {route.path}")
            continue
        results.extend(cells)
    return tuple(results), tuple(unseedable)


def _collect_guards(outcome: _Outcome, config: MatrixConfig) -> tuple[GuardFailure, ...]:
    """Run every vacuity guard and keep the ones that tripped.

    Args:
        outcome: The finished run.
        config: The thresholds the run was given.

    Returns:
        Every failure, in guard order. All guards run even once one has failed,
        because an operator fixing a broken run wants the whole list rather than
        one symptom at a time.

    ``require_allowlist_is_live`` is deliberately absent: an entry outliving the
    route it excuses is a property of the shipped allow-list rather than of one
    run, and it is enforced against the application's own document in the fast
    unit suite, which is both earlier feedback and independent of which instance
    this run happens to be pointed at.
    """
    live = require_live_stages_completed(outcome.live_failure)
    if live is not None:
        # A run that broke off has nothing trustworthy to say about coverage,
        # seeding, or throttling, and the other guards would only restate that
        # one collapse in seven less useful ways.
        return (live,)
    classification = outcome.classification
    considered = (
        len(classification.covered)
        + len(classification.allowlisted)
        + len(classification.uncovered)
    )
    probed = len({(result.route.method, result.route.path) for result in outcome.results})
    candidates = (
        require_auth_established(
            authenticated_status=outcome.probe.authenticated_status,
            unauthenticated_status=outcome.probe.unauthenticated_status,
        ),
        require_positive_controls(outcome.results),
        require_minimum_coverage(probed, minimum=config.min_routes),
        require_seeded_resources(outcome.seeded),
        require_no_throttling(outcome.statuses),
        require_allowlist_bounded(
            len(classification.allowlisted),
            considered,
            max_fraction=config.max_allowlist_fraction,
        ),
        require_within_budget(outcome.elapsed_seconds, budget_seconds=config.budget_seconds),
    )
    return tuple(failure for failure in candidates if failure is not None)


def _build_report(outcome: _Outcome, config: MatrixConfig, base_url: str) -> MatrixReport:
    """Assemble the report from a finished run."""
    uncovered = tuple(
        sorted(
            [f"{route.method} {route.path}" for route in outcome.classification.uncovered]
            + list(outcome.unseedable),
        ),
    )
    return MatrixReport(
        base_url=base_url,
        discovered=sum(1 for route in outcome.routes if is_object_scoped(route)),
        seeded=outcome.seeded,
        uncovered=uncovered,
        allowlisted=len(outcome.classification.allowlisted),
        results=outcome.results,
        guard_failures=_collect_guards(outcome, config),
        elapsed_seconds=outcome.elapsed_seconds,
    )


async def _collect_outcome(
    client: AsyncClient,
    *,
    bootstrap: Bootstrap,
    config: MatrixConfig,
    started: float,
) -> _Outcome:
    """Run every live stage in order and gather what they saw.

    Each stage is named as it runs, so a failure can say which one of them the
    run died in rather than only that something did.
    """
    with _stage(_STAGE_BOOTSTRAP):
        owner, intruder = await bootstrap(client)
    session = _Session(
        client=client,
        config=config,
        owner=owner,
        intruder=intruder,
        forged_token=_forged_token(),
    )
    with _stage(_STAGE_AUTH_PROBE):
        probe = await _probe_auth(session)
    with _stage(_STAGE_DISCOVERY):
        routes = discover_routes(await _fetch_document(session))
    classification = classify_routes(
        routes,
        seed_registry=config.seed_registry,
        allowlist=config.allowlist,
    )
    with _stage(_STAGE_PROBES):
        results, unseedable = await _probe_routes(session, classification.covered)
    return _Outcome(
        routes=routes,
        classification=classification,
        probe=probe,
        results=results,
        seeded=len(classification.covered) - len(unseedable),
        unseedable=unseedable,
        statuses=tuple(session.statuses),
        elapsed_seconds=perf_counter() - started,
    )


def _summarize(cause: Exception) -> str:
    """Render one operational failure as a single actionable line.

    A :class:`LiveTargetError` already names what failed and which resource was
    involved, so repeating its class name would be noise. Anything else is named
    by its type, which for a driver or transport error is the useful half.
    """
    described = (
        str(cause) if isinstance(cause, LiveTargetError) else f"{type(cause).__name__}: {cause}"
    )
    return shorten(described, width=_MAX_SUMMARY_CHARS, placeholder=" ...")


def _failed_outcome(error: _StageError, *, target: str, elapsed_seconds: float) -> _Outcome:
    """Describe a run that never reached a verdict, so it still becomes a report."""
    return _Outcome(
        routes=(),
        classification=Classification(covered=(), allowlisted=(), uncovered=()),
        probe=_AuthProbe(authenticated_status=_NO_STATUS, unauthenticated_status=_NO_STATUS),
        results=(),
        seeded=0,
        unseedable=(),
        statuses=(),
        elapsed_seconds=elapsed_seconds,
        live_failure=LiveFailure(
            stage=error.stage,
            target=target,
            summary=_summarize(error.cause),
        ),
    )


async def run_matrix(
    client: AsyncClient,
    *,
    bootstrap: Bootstrap,
    config: MatrixConfig,
) -> MatrixReport:
    """Run the whole authorization matrix against one instance.

    Args:
        client: An HTTP client already pointed at the target. Its lifetime
            belongs to the caller.
        bootstrap: Creates the two identities and logs them both in. Injected
            because production inserts user rows through the application's own
            ORM before minting tokens over the real login route, while a stub
            has no database to insert into.
        config: The tables and thresholds this run uses.

    Returns:
        The graded report -- always a report, never a traceback. Failures inside
        the matrix (a route that will not seed, an owner who cannot reach their
        own object) are graded as such, and failures of the live target itself
        (a refused connection, a database that will not take the identity
        insert) come back as the live-stage guard. Both are exit code 3, which
        no consumer can confuse with the 1 an uncaught exception would produce.
    """
    started = perf_counter()
    target = str(client.base_url)
    try:
        outcome = await _collect_outcome(
            client, bootstrap=bootstrap, config=config, started=started
        )
    except _StageError as error:
        outcome = _failed_outcome(
            error,
            target=target,
            elapsed_seconds=perf_counter() - started,
        )
    return _build_report(outcome, config, target)
