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

The reference dimension runs as a parallel loop with one asymmetry of its own:
the objects it names are seeded as *two* different identities. The foreign
object belongs to A, the control's object belongs to the caller, and any path
ids the route interpolates belong to the caller as well -- otherwise the request
is refused by the path's own ownership check and never reaches the body at all.
Seeding both cells as the same identity would turn the "cross" request into a
call against the caller's own row, which every correct application answers 2xx,
and the whole dimension would grade as one large leak while every status looked
right.

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
from scripts.dast.policy import (
    AllowlistEntry,
    Classification,
    ReferenceClassification,
    ReferenceTarget,
    classify_references,
    classify_routes,
)
from scripts.dast.references import (
    REFERENCE_REGISTRY,
    EvidenceStrategy,
    ObjectReference,
    ReferenceProbe,
    ReferenceRegistry,
    build_reference_request,
    evidence_reaches_object,
)
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
    window_fields,
)
from scripts.dast.verdict import (
    CELL_ORDER,
    REFERENCE_CELL_ORDER,
    Cell,
    CellResult,
    GuardFailure,
    LiveFailure,
    ReferenceCellResult,
    judge,
    judge_reference,
    require_allowlist_bounded,
    require_auth_established,
    require_declared_references_classified,
    require_live_stages_completed,
    require_minimum_coverage,
    require_minimum_reference_coverage,
    require_no_throttling,
    require_positive_controls,
    require_reference_allowlist_bounded,
    require_reference_positive_controls,
    require_seeded_resources,
    require_within_budget,
)

DEFAULT_MIN_ROUTES = 20
# The application publishes nine body- and query-carried ids today, one of which
# is allow-listed. The floor sits below that on purpose -- it is a tripwire for a
# dimension that collapsed, not a target -- but it is the only thing gating the
# workflow, which passes no flags at all, so it may never be zero.
DEFAULT_MIN_REFERENCES = 5
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
        reference_registry: Probes for the ids carried in bodies and query
            strings, keyed by ``(method, path)``.
        allowlist: The loaded opt-out entries.
        auth_probe_path: The route used to prove authentication works.
        min_routes: The floor the coverage guard enforces.
        min_references: The floor the reference-coverage guard enforces.
        budget_seconds: The ceiling the time-box guard enforces.
        max_allowlist_fraction: The share of routes the allow-list may excuse.
    """

    # Both constants are ``MappingProxyType``, which Python 3.11 rejects as a
    # dataclass default; the factories hand back those same shared objects.
    seed_registry: Mapping[str, SeedSpec] = field(default_factory=lambda: SEED_REGISTRY)
    replay_bodies: ReplayBodies = field(default_factory=lambda: REPLAY_BODIES)
    reference_registry: ReferenceRegistry = field(default_factory=lambda: REFERENCE_REGISTRY)
    allowlist: tuple[AllowlistEntry, ...] = ()
    auth_probe_path: str = DEFAULT_AUTH_PROBE_PATH
    min_routes: int = DEFAULT_MIN_ROUTES
    min_references: int = DEFAULT_MIN_REFERENCES
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
    references: ReferenceClassification
    probe: _AuthProbe
    results: tuple[CellResult, ...]
    reference_results: tuple[ReferenceCellResult, ...]
    seeded: int
    unseedable: tuple[str, ...]
    unprobed_references: tuple[str, ...]
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


@dataclass(frozen=True)
class _Request:
    """One request the matrix sends, described in full so the sender stays trivial.

    Attributes:
        method: The verb to send.
        path: The path, already resolved -- no braces left in it.
        body: The JSON body, or ``None`` for a verb that takes none.
        params: Query parameters, or ``None`` when the URL carries everything.
    """

    method: str
    path: str
    body: Mapping[str, object] | None = None
    params: Mapping[str, str] | None = None


async def _send(session: _Session, request: _Request, *, token: str | None) -> Response:
    """Issue one request, recording its status for the throttling guard."""
    headers = {"X-Forwarded-For": forwarded_for()}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    response = await session.client.request(
        request.method,
        request.path,
        headers=headers,
        json=request.body,
        params=request.params,
    )
    session.statuses.append(response.status_code)
    return response


def _render_fields(values: Mapping[str, str]) -> dict[str, object]:
    """Add the per-request fields any template may interpolate to the seeded ids.

    ``{unique}`` keeps a slug or a name from colliding with the object seeded for
    the previous cell, and the session window has to be minted per request
    because the routes that take one validate it against the wall clock.
    """
    return {
        **values,
        UNIQUE_FIELD: secrets.token_hex(_UNIQUE_TOKEN_BYTES),
        **window_fields(datetime.now(UTC)),
    }


async def _seed_one(
    session: _Session,
    spec: SeedSpec,
    values: dict[str, str],
    *,
    identity: Identity,
) -> str | None:
    """Create one object as ``identity`` and return its id, or ``None`` on failure.

    The identity is a parameter rather than always the owner because the
    reference dimension needs both: the object under test belongs to A, while
    the control's object and every path id the route interpolates belong to the
    caller.
    """
    fields = _render_fields(values)
    response = await _send(
        session,
        _Request(
            method=spec.create_method,
            path=render_text(spec.create_path, fields),
            body=create_body(spec, fields),
        ),
        token=identity.token,
    )
    if not _is_success(response.status_code):
        return None
    return resolve_id(response.json(), spec.id_pointer)


async def _seed_keys(
    session: _Session,
    keys: Sequence[str],
    *,
    identity: Identity,
    values: dict[str, str] | None = None,
) -> dict[str, str] | None:
    """Create a fresh object for every key, dependencies first, all as one identity.

    Args:
        session: The run's state.
        keys: The seed-registry keys to satisfy.
        identity: Who creates the objects, and therefore who owns them.
        values: Ids already seeded for this cell, extended in place by the
            caller's copy; dependencies resolve against them.

    Returns:
        The seeded ids keyed by seed key, or ``None`` when any create failed --
        in which case the caller reports the route as unseedable rather than
        probing against ids that do not exist.
    """
    seeded_values = dict(values or {})
    for key in seed_order(keys, session.config.seed_registry):
        seeded = await _seed_one(
            session,
            session.config.seed_registry[key],
            seeded_values,
            identity=identity,
        )
        if seeded is None:
            return None
        seeded_values[key] = seeded
    return seeded_values


async def _seed_cell(session: _Session, route: RouteSpec) -> dict[str, str] | None:
    """Create a fresh object for every path parameter of one route, as the owner."""
    return await _seed_keys(session, route.params, identity=session.owner)


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
        _Request(
            method=route.method,
            path=resolved,
            body=replay_body(route, session.config.replay_bodies),
        ),
        token=_token_for(session, cell),
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
    response = await _send(session, _Request(method="GET", path=_OPENAPI_PATH), token=None)
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, Mapping):
        return {}
    document: Mapping[str, object] = payload
    return document


async def _probe_auth(session: _Session) -> _AuthProbe:
    """Ask the probe route the same question twice: with a credential, and without."""
    probe = _Request(method="GET", path=session.config.auth_probe_path)
    authenticated = await _send(session, probe, token=session.owner.token)
    unauthenticated = await _send(session, probe, token=None)
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


@dataclass(frozen=True)
class _ReferenceAnswer:
    """What one reference cell's request answered, before anything grades it.

    Attributes:
        resolved_path: The path actually requested, path ids substituted in.
        object_id: The id that was injected.
        status: The status the server returned.
        object_was_reached: Whether the evidence showed the request reaching
            the referenced object.
        evidence_unavailable: Whether there was no evidence to read at all.
    """

    resolved_path: str
    object_id: str
    status: int
    object_was_reached: bool
    evidence_unavailable: bool = False


def json_body(response: Response) -> object | None:
    """Parse a response body, or report that it carried nothing anybody could read.

    Public because the distinction it draws is a grading decision rather than an
    implementation detail: everything downstream of it treats ``None`` as "this
    cell proves nothing", so it is worth pinning on its own.

    ``None`` is that report, and it is deliberately not the same answer as an
    empty body. A 2xx whose payload is not JSON at all -- an intercepting
    proxy's HTML, an empty 204, a truncated stream -- says nothing about which
    object was reached, and grading that silence as "the object was not reached"
    is fail-open: the paired control has its own healthy response, so it would
    license a pass over a request nobody ever looked at.

    The decode error is handled rather than allowed to end the run, because a
    response the harness cannot read is a fact about the target rather than an
    operational failure of the harness.
    """
    try:
        # Annotated rather than returned directly: httpx types this ``Any``, and
        # letting an ``Any`` widen the declared return would erase the one
        # distinction this function exists to make.
        parsed: object = response.json()
    except JSONDecodeError:
        return None
    return parsed


@dataclass(frozen=True)
class _SeededObject:
    """The object one reference cell injects, and everything needed to look for it.

    Attributes:
        object_id: The id that was injected, as text.
        owner: Whoever created it -- the foreign owner on the cross cell, the
            caller on the control. A read-back is issued as this identity.
        values: Every id seeded for this cell, for rendering a read-back path.
    """

    object_id: str
    owner: Identity
    values: Mapping[str, str]


@dataclass(frozen=True)
class _Evidence:
    """What one cell's evidence said, and whether there was any of it to read.

    Attributes:
        object_was_reached: Whether the evidence showed the referenced object
            being reached. Always ``False`` when there was no evidence: the two
            are distinct answers and this field carries only the first.
        unavailable: Whether the run had nothing to look at -- an unreadable
            body, or a read-back the target refused.
    """

    object_was_reached: bool
    unavailable: bool = False


# A refused probe: no evidence was sought, which is not the same as evidence
# sought and not found, and neither is the same as evidence that could not be read.
_NOT_REACHED = _Evidence(object_was_reached=False)
_NO_EVIDENCE = _Evidence(object_was_reached=False, unavailable=True)


async def _read_back_body(
    session: _Session,
    reference: ObjectReference,
    seeded: _SeededObject,
) -> object | None:
    """Read the referenced object back as its own owner and return what came back.

    This is the only way to grade a route whose response says nothing about
    which object it touched -- which is exactly the route an attacker would
    prefer, and one that grading on its own silence would pass forever.

    The surface a ``read_back_path`` names carries an obligation, and it is the
    whole reason the strategy works: it MUST be **owner-visible**. Reading it as
    the object's owner has to show writes made by *anyone* against that object,
    not merely the writes the caller made. A creator-scoped listing satisfies
    the control -- which reads back its own write on its own object and always
    sees it -- while hiding the cross cell's write from the owner it landed on,
    so the strategy would manufacture the very absence it then grades as a pass.
    The obligation is stated at the declaration site, on
    :attr:`scripts.dast.references.ObjectReference.read_back_path`, because that
    is where an author chooses the path.

    A read-back that was itself refused yields ``None``, so the cell reports
    that there was no evidence rather than reporting evidence of an absence.
    """
    if reference.read_back_path is None:
        return None
    path = render_text(
        reference.read_back_path,
        {**seeded.values, reference.seed_key: seeded.object_id},
    )
    response = await _send(session, _Request(method="GET", path=path), token=seeded.owner.token)
    if not _is_success(response.status_code):
        return None
    return json_body(response)


async def _evidence_body(
    session: _Session,
    reference: ObjectReference,
    response: Response,
    seeded: _SeededObject,
) -> object | None:
    """Return the body this cell's evidence lives in, or ``None`` when there is none.

    An echo or a listing is answered by the response already in hand; only a
    silent one costs a second round trip.
    """
    if reference.evidence is EvidenceStrategy.READ_BACK:
        return await _read_back_body(session, reference, seeded)
    return json_body(response)


async def _evidence_of(
    session: _Session,
    reference: ObjectReference,
    response: Response,
    seeded: _SeededObject,
) -> _Evidence:
    """Report what this cell's evidence showed about the referenced object.

    A refused request has no evidence to give, and asking for it would be a
    request nobody reads. What counts as a hit -- the id itself, or the fact a
    declared witness looks for -- is the reference's own decision, made once in
    :func:`scripts.dast.references.evidence_reaches_object`.
    """
    if not _is_success(response.status_code):
        return _NOT_REACHED
    body = await _evidence_body(session, reference, response, seeded)
    if body is None:
        return _NO_EVIDENCE
    return _Evidence(
        object_was_reached=evidence_reaches_object(reference, body, seeded.object_id),
    )


async def _run_reference_cell(
    session: _Session,
    probe: ReferenceProbe,
    reference: ObjectReference,
    cell: Cell,
) -> _ReferenceAnswer | None:
    """Seed the objects one reference cell needs, send its request, and look for the id.

    The caller is the intruder in both cells; what changes is who owns the id
    being injected. Path parameters always belong to the caller, or the request
    is refused by the path's own ownership check before the body is ever read --
    a denial that would look exactly like the one this cell is testing for.
    """
    owner = session.owner if cell is Cell.CROSS_REFERENCE else session.intruder
    values = await _seed_keys(session, probe.path_seeds, identity=session.intruder)
    if values is None:
        return None
    # The path is resolved from the caller's own ids alone, before the
    # referenced object joins them: were a seed key to appear in both chains,
    # merging first would quietly point the path at the foreign object too, and
    # the resulting denial would look exactly like the one under test.
    resolved = render_text(probe.path, values)
    referenced = await _seed_keys(session, (reference.seed_key,), identity=owner)
    if referenced is None:
        return None
    values.update(referenced)
    seeded = _SeededObject(object_id=values[reference.seed_key], owner=owner, values=values)
    injected = build_reference_request(
        probe,
        reference,
        object_id=seeded.object_id,
        values=_render_fields(values),
    )
    response = await _send(
        session,
        _Request(
            method=probe.method,
            path=resolved,
            body=injected.body,
            params=injected.params,
        ),
        token=session.intruder.token,
    )
    evidence = await _evidence_of(session, reference, response, seeded)
    return _ReferenceAnswer(
        resolved_path=resolved,
        object_id=seeded.object_id,
        status=response.status_code,
        object_was_reached=evidence.object_was_reached,
        evidence_unavailable=evidence.unavailable,
    )


def _graded_reference(
    target: ReferenceTarget,
    reference: ObjectReference,
    cell: Cell,
    answer: _ReferenceAnswer,
    *,
    control_proved_mechanism: bool,
) -> ReferenceCellResult:
    """Attach a verdict to one answered reference cell."""
    return ReferenceCellResult(
        route=target.route,
        reference=reference,
        cell=cell,
        resolved_path=answer.resolved_path,
        object_id=answer.object_id,
        status=answer.status,
        object_was_reached=answer.object_was_reached,
        verdict=judge_reference(
            cell,
            answer.status,
            object_was_reached=answer.object_was_reached,
            evidence_unavailable=answer.evidence_unavailable,
            control_proved_mechanism=control_proved_mechanism,
        ),
        evidence_unavailable=answer.evidence_unavailable,
    )


async def _answer_reference_cells(
    session: _Session,
    probe: ReferenceProbe,
    reference: ObjectReference,
) -> dict[Cell, _ReferenceAnswer] | None:
    """Send both cells of one reference in order, or report that one would not seed."""
    answers: dict[Cell, _ReferenceAnswer] = {}
    for cell in REFERENCE_CELL_ORDER:
        answer = await _run_reference_cell(session, probe, reference, cell)
        if answer is None:
            return None
        answers[cell] = answer
    return answers


def _control_proved_mechanism(control: _ReferenceAnswer) -> bool:
    """Report whether the control showed this request surfaces an id it can see."""
    return _is_success(control.status) and control.object_was_reached


async def _run_reference(
    session: _Session,
    target: ReferenceTarget,
) -> tuple[ReferenceCellResult, ...] | None:
    """Run both cells of one reference in order, then grade them together.

    Grading waits for both because the cross cell's ambiguous answer -- a 2xx
    with no trace of the object -- can only be read once the control has shown
    whether this request surfaces an id it *can* see. The control is graded
    without that flag on purpose: it is asked whether it worked, and letting it
    lean on its own outcome would be circular.
    """
    probe = session.config.reference_registry.get((target.route.method, target.route.path))
    reference = target.reference
    if probe is None or reference is None:
        # Only a classification that disagreed with the registry reaches here;
        # it is reported as unprobed rather than raised, like an unseedable route.
        return None
    answers = await _answer_reference_cells(session, probe, reference)
    if answers is None:
        return None
    control = answers[Cell.REFERENCE_CONTROL]
    return (
        _graded_reference(
            target,
            reference,
            Cell.CROSS_REFERENCE,
            answers[Cell.CROSS_REFERENCE],
            control_proved_mechanism=_control_proved_mechanism(control),
        ),
        _graded_reference(
            target,
            reference,
            Cell.REFERENCE_CONTROL,
            control,
            control_proved_mechanism=False,
        ),
    )


async def _probe_references(
    session: _Session,
    targets: Sequence[ReferenceTarget],
) -> tuple[tuple[ReferenceCellResult, ...], tuple[str, ...]]:
    """Probe every covered reference, collecting the cells and the ones that would not seed."""
    results: list[ReferenceCellResult] = []
    unprobed: list[str] = []
    for target in targets:
        cells = await _run_reference(session, target)
        if cells is None:
            unprobed.append(f"{target.route.method} {target.route.path} {target.field}")
            continue
        results.extend(cells)
    return tuple(results), tuple(unprobed)


def _probed_routes(outcome: _Outcome) -> int:
    """Count the routes that produced path cells, however many cells each produced."""
    return len({(result.route.method, result.route.path) for result in outcome.results})


def _probed_references(outcome: _Outcome) -> int:
    """Count the ``(route, field)`` references that produced cells."""
    return len(
        {
            (result.route.method, result.route.path, result.reference.field)
            for result in outcome.reference_results
        },
    )


def _classified_total(classification: Classification | ReferenceClassification) -> int:
    """Count everything one classifier placed, whichever dimension it classified.

    Both classifications carry the same three buckets, so both allow-list
    ceilings measure their share the same way rather than each spelling the sum
    out in its own call.
    """
    return (
        len(classification.covered)
        + len(classification.allowlisted)
        + len(classification.uncovered)
    )


def _reference_targets(references: ReferenceClassification) -> tuple[ReferenceTarget, ...]:
    """Return every classified reference, whichever bucket it landed in.

    The liveness guard asks only whether a declaration was placed at all, so an
    excused reference counts exactly as much as a probed one.
    """
    return (*references.covered, *references.allowlisted, *references.uncovered)


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

    ``require_declared_references_classified`` is present for the mirror-image
    reason. The unit suite asks the same question of this application's own
    document, but the answer differs per instance: pointed at a deployment whose
    document is older, a declared reference falls out of every bucket and stops
    being counted, and only a guard that runs against *that* document can say so.
    """
    live = require_live_stages_completed(outcome.live_failure)
    if live is not None:
        # A run that broke off has nothing trustworthy to say about coverage,
        # seeding, or throttling, and the other guards would only restate that
        # one collapse in seven less useful ways.
        return (live,)
    classification = outcome.classification
    references = outcome.references
    candidates = (
        require_auth_established(
            authenticated_status=outcome.probe.authenticated_status,
            unauthenticated_status=outcome.probe.unauthenticated_status,
        ),
        require_positive_controls(outcome.results),
        require_reference_positive_controls(outcome.reference_results),
        require_minimum_coverage(_probed_routes(outcome), minimum=config.min_routes),
        require_minimum_reference_coverage(
            _probed_references(outcome),
            minimum=config.min_references,
        ),
        require_seeded_resources(outcome.seeded),
        require_no_throttling(outcome.statuses),
        require_allowlist_bounded(
            len(classification.allowlisted),
            _classified_total(classification),
            max_fraction=config.max_allowlist_fraction,
        ),
        require_reference_allowlist_bounded(
            len(references.allowlisted),
            _classified_total(references),
            max_fraction=config.max_allowlist_fraction,
        ),
        require_declared_references_classified(
            config.reference_registry,
            _reference_targets(references),
        ),
        require_within_budget(outcome.elapsed_seconds, budget_seconds=config.budget_seconds),
    )
    return tuple(failure for failure in candidates if failure is not None)


def _build_report(outcome: _Outcome, config: MatrixConfig, base_url: str) -> MatrixReport:
    """Assemble the report from a finished run."""
    uncovered = tuple(
        sorted(
            [f"{route.method} {route.path}" for route in outcome.classification.uncovered]
            + [
                f"{target.route.method} {target.route.path} {target.field}"
                for target in outcome.references.uncovered
            ]
            + list(outcome.unseedable)
            + list(outcome.unprobed_references),
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
        reference_results=outcome.reference_results,
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
    references = classify_references(
        routes,
        reference_registry=config.reference_registry,
        seed_registry=config.seed_registry,
        allowlist=config.allowlist,
    )
    with _stage(_STAGE_PROBES):
        results, unseedable = await _probe_routes(session, classification.covered)
        reference_results, unprobed = await _probe_references(session, references.covered)
    return _Outcome(
        routes=routes,
        classification=classification,
        references=references,
        probe=probe,
        results=results,
        reference_results=reference_results,
        seeded=len(classification.covered) - len(unseedable),
        unseedable=unseedable,
        unprobed_references=unprobed,
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
        references=ReferenceClassification(covered=(), allowlisted=(), uncovered=()),
        probe=_AuthProbe(authenticated_status=_NO_STATUS, unauthenticated_status=_NO_STATUS),
        results=(),
        reference_results=(),
        seeded=0,
        unseedable=(),
        unprobed_references=(),
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
