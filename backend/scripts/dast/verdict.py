"""Grade one probe, and refuse to call a run clean when it proved nothing.

Two things live here because they answer the same question from opposite ends.
:func:`judge` decides what a single response means; the ``require_*`` guards
decide whether the run that produced those responses is worth believing at all.

The grading vocabulary is deliberately wider than "denied or not". A ``401`` on
the cross-user cell is a broken credential, not a denial; a ``5xx`` is a handler
that reached the row before it checked who was asking; a ``429`` is a rate
limiter turning the whole matrix into uniform, meaningless refusals. Collapsing
any of those into "fine" is how a check reports clean while having exercised
nothing.

The guards exist for the same reason. A harness that cannot authenticate sees
every request answered 401, finds no IDOR, and reports success. Each guard
below closes one route to that false pass, and each returns either a
:class:`GuardFailure` naming itself or ``None`` -- never a bare bool, so the
report can say which guard tripped and why.

An id carried in a request body or a query string is graded by a second
function, :func:`judge_reference`, for one reason: its status is not the whole
answer. ``GET /journal/?practice_session_id=`` filters the caller's own entries,
so a foreign id there is answered 200 with an empty page. Calling that a leak
would make the gate cry wolf on the most common correct shape in the
application; calling it a pass on the strength of the status alone would let a
route that ignores the filter entirely pass for the same reason. So a 2xx is
graded on whether the evidence shows the foreign object was reached -- the id
appearing in it, or, for a route that answers with no id at all, a declared
witness firing -- and an absence only means "you saw nothing" once the paired
control has shown that this same request, pointed at the caller's own object,
does show it. Until then it means "we learned nothing", which grades RED.

``CellResult`` and ``GuardFailure`` live here rather than in the report module
because the runner produces them and the report consumes them; putting the
types beside the grader keeps the dependency pointing one way.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from enum import Enum, auto
from http import HTTPStatus

from scripts.dast.discovery import RouteSpec
from scripts.dast.policy import AllowlistEntry, ReferenceTarget, publishes_field
from scripts.dast.references import ObjectReference, ReferenceRegistry

_SUCCESS_FLOOR = 200
_SUCCESS_CEILING = 300
_SERVER_ERROR_FLOOR = 500

# The two statuses this codebase uses to refuse a cross-user request. The split
# is deliberate: ownership denials 403, while the enumeration-safe resources
# (goals, marginalia, journal entries) collapse to 404 on purpose.
_ACCEPTABLE_DENIALS = frozenset({HTTPStatus.FORBIDDEN, HTTPStatus.NOT_FOUND})


class Cell(Enum):
    """One square of the matrix: which credential met which object.

    The last two belong to the reference dimension and never appear in
    :data:`CELL_ORDER`. Both are sent by the *same* caller: the difference is
    whose object the id names, not who is asking.
    """

    CROSS_USER = auto()
    UNAUTH = auto()
    FORGED_JWT = auto()
    POSITIVE_CONTROL = auto()
    CROSS_REFERENCE = auto()
    REFERENCE_CONTROL = auto()


# The owner's own call runs last. Running it first against a route whose
# cross-user cell is destructive would let that cell inherit a live row, delete
# it, and leave every later probe reading a 404 as a correct denial.
CELL_ORDER: tuple[Cell, ...] = (
    Cell.CROSS_USER,
    Cell.UNAUTH,
    Cell.FORGED_JWT,
    Cell.POSITIVE_CONTROL,
)


# The cross request runs first here too, for the same reason: a reference probe
# may create a row, and the control has to see the surface as the probe left it.
REFERENCE_CELL_ORDER: tuple[Cell, ...] = (
    Cell.CROSS_REFERENCE,
    Cell.REFERENCE_CONTROL,
)


class Verdict(Enum):
    """What one graded response means. Every value but ``PASS`` fails the build."""

    PASS = auto()
    LEAK = auto()
    SERVER_ERROR = auto()
    AUTH_BROKEN = auto()
    THROTTLED = auto()
    INCONCLUSIVE = auto()


@dataclass(frozen=True)
class CellResult:
    """One probe, fully described, so a finding can be triaged without a rerun.

    Attributes:
        route: The operation that was probed.
        cell: Which credential was used.
        resolved_path: The path actually requested, ids substituted in.
        object_ids: The ``(parameter, id)`` pairs that were sent, in path order.
        status: The status the server returned.
        verdict: The grade :func:`judge` gave that status.
    """

    route: RouteSpec
    cell: Cell
    resolved_path: str
    object_ids: tuple[tuple[str, str], ...]
    status: int
    verdict: Verdict


@dataclass(frozen=True)
class ReferenceCellResult:
    """One reference probe, fully described, so a finding can be triaged without a rerun.

    Attributes:
        route: The operation that was probed.
        reference: The id that was injected, and how it was looked for.
        cell: Whose object the id named -- the foreign owner's, or the caller's.
        resolved_path: The path actually requested, path ids substituted in.
        object_id: The id that was injected, as text.
        status: The status the server returned.
        object_was_reached: Whether the evidence showed the request actually
            reached the referenced object -- the fact a status cannot supply.
            Read either as the id appearing in the evidence or, for a route
            that answers with no id at all, as a declared witness firing.
            Always ``False`` when ``evidence_unavailable`` is set: nothing was
            looked at, so nothing was seen.
        verdict: The grade :func:`judge_reference` gave the pair.
        evidence_unavailable: Whether there was no evidence to read at all -- a
            2xx whose body is not JSON, or a read-back the target refused. It
            trails the other fields because it defaults: only the runner knows
            when a response could not be read, and every other caller is
            reporting what it saw.
    """

    route: RouteSpec
    reference: ObjectReference
    cell: Cell
    resolved_path: str
    object_id: str
    status: int
    object_was_reached: bool
    verdict: Verdict
    evidence_unavailable: bool = False


@dataclass(frozen=True)
class GuardFailure:
    """A vacuity guard that tripped, named so the report can say which one.

    Attributes:
        guard: The guard function's own name.
        detail: One sentence an operator can act on.
    """

    guard: str
    detail: str


@dataclass(frozen=True)
class LiveFailure:
    """A stage of live I/O that failed outright instead of answering something.

    Attributes:
        stage: What the run was doing, phrased for the report -- e.g.
            ``"the identity bootstrap"``.
        target: The instance the run was pointed at.
        summary: The exception's type and message, shortened to one line.
    """

    stage: str
    target: str
    summary: str


def _is_success(status: int) -> bool:
    """Report whether ``status`` is a 2xx."""
    return _SUCCESS_FLOOR <= status < _SUCCESS_CEILING


def _judge_denial(cell: Cell, status: int) -> Verdict:
    """Grade a non-2xx, non-throttled, non-5xx response on a probing cell.

    Args:
        cell: The cell being graded; never ``POSITIVE_CONTROL``.
        status: The observed status.

    Returns:
        For the cross-user cell, ``PASS`` on 403/404 and ``AUTH_BROKEN`` on 401
        -- the intruder's token is supposed to be valid, so a 401 means the run
        learned nothing about authorization. For the token-less cells only a
        401 passes. Anything else is ``INCONCLUSIVE``: a status nobody thought
        about must never default to acceptable.
    """
    if cell is not Cell.CROSS_USER:
        return Verdict.PASS if status == HTTPStatus.UNAUTHORIZED else Verdict.INCONCLUSIVE
    if status == HTTPStatus.UNAUTHORIZED:
        return Verdict.AUTH_BROKEN
    return Verdict.PASS if status in _ACCEPTABLE_DENIALS else Verdict.INCONCLUSIVE


def _judge_control(status: int) -> Verdict:
    """Grade the owner's own call, which is asked one question: did it succeed?

    A control that could not succeed makes the intruder's denial meaningless, so
    every non-2xx is inconclusive -- including the 422 a mutating replay with an
    invalid body returns, and the 429 a throttled run would show.
    """
    return Verdict.PASS if _is_success(status) else Verdict.INCONCLUSIVE


def _judge_probe(cell: Cell, status: int) -> Verdict:
    """Grade a cell that was supposed to be refused.

    A 2xx is the ``LEAK`` this whole check exists to catch. A 429 means the rate
    limiter, not the application, produced the refusal, and a 5xx means the
    handler reached the row before it checked who was asking; neither is a
    denial. What is left goes to the per-cell denial table.
    """
    if _is_success(status):
        return Verdict.LEAK
    if status == HTTPStatus.TOO_MANY_REQUESTS:
        return Verdict.THROTTLED
    if status >= _SERVER_ERROR_FLOOR:
        return Verdict.SERVER_ERROR
    return _judge_denial(cell, status)


def judge(cell: Cell, status: int) -> Verdict:
    """Grade one response as a total function of its cell and status.

    Args:
        cell: Which credential produced this response.
        status: The status the server returned.

    Returns:
        The verdict. The owner's own call is graded on whether it succeeded;
        every other cell is graded on whether it was genuinely refused.
    """
    if cell is Cell.POSITIVE_CONTROL:
        return _judge_control(status)
    return _judge_probe(cell, status)


def _judge_reference_success(
    *,
    object_was_reached: bool,
    evidence_unavailable: bool,
    control_proved_mechanism: bool,
) -> Verdict:
    """Grade a 2xx on the cross cell, which is the only genuinely ambiguous answer.

    Evidence of the foreign object is the leak, and no control can explain it
    away. Evidence nobody could read -- a body that is not JSON, a read-back the
    target refused -- is inconclusive whatever the control did: there is no
    observation here for a control to license. An absence is a pass only when
    the control has proved that this request surfaces an id it *can* see;
    otherwise the run learned nothing about this route.

    That last step rests on an assumption worth naming, because the control does
    not establish it: **the response's rendering of the reference is
    identity-independent** -- a reference the handler persisted renders the same
    way whoever owns the object it names. The control only ever shows the route
    surfacing an id the caller *owns*, which is a strictly weaker claim.

    Where the assumption fails, this function reads a pass out of an absence the
    application manufactured. A serializer that resolves the reference through
    an owner-scoped lookup renders a persisted foreign key as ``null``, exactly
    as it renders no key at all; a read-back scoped to whoever created the row
    hides a foreign write from the object's own owner while showing the control
    its own. Both grade PASS here with the row on disk.

    A route that cannot satisfy the assumption needs a declared witness over a
    fact only the landed write produces, or an owner-visible read-back -- see
    :func:`scripts.dast.runner._read_back_body` for the obligation that carries.
    Distinguishing the two cases in general would take a third probe
    establishing that the route surfaces a foreign reference when it has one,
    which is a change to the cell pair rather than to this grader.
    """
    if object_was_reached:
        return Verdict.LEAK
    if evidence_unavailable:
        return Verdict.INCONCLUSIVE
    return Verdict.PASS if control_proved_mechanism else Verdict.INCONCLUSIVE


def _judge_reference_refusal(status: int) -> Verdict:
    """Grade a non-2xx on the cross cell, exactly as the path matrix would.

    The intruder's token is supposed to be valid, so a 401 means the run learned
    nothing about authorization; a 429 means the rate limiter produced the
    refusal; a 5xx means the handler reached the row before it checked who was
    asking. Only 403 and 404 are denials, and anything else is inconclusive
    because a status nobody thought about must never default to acceptable.
    """
    if status == HTTPStatus.TOO_MANY_REQUESTS:
        return Verdict.THROTTLED
    if status >= _SERVER_ERROR_FLOOR:
        return Verdict.SERVER_ERROR
    if status == HTTPStatus.UNAUTHORIZED:
        return Verdict.AUTH_BROKEN
    return Verdict.PASS if status in _ACCEPTABLE_DENIALS else Verdict.INCONCLUSIVE


def _judge_reference_control(status: int, *, object_was_reached: bool) -> Verdict:
    """Grade the same request sent with the caller's own id.

    It is asked two questions, and both have to answer yes. A control that could
    not succeed denies everybody equally. A control that succeeded while
    surfacing nothing has demonstrated that this route's responses say nothing
    about which object was reached -- at which point every cross-user 2xx on it
    is unfalsifiable, and grading its silence as a pass would be the vacuous
    green this whole harness exists to forbid.
    """
    if status == HTTPStatus.TOO_MANY_REQUESTS:
        return Verdict.THROTTLED
    if status >= _SERVER_ERROR_FLOOR:
        return Verdict.SERVER_ERROR
    if _is_success(status) and object_was_reached:
        return Verdict.PASS
    return Verdict.INCONCLUSIVE


def judge_reference(
    cell: Cell,
    status: int,
    *,
    object_was_reached: bool,
    evidence_unavailable: bool = False,
    control_proved_mechanism: bool = False,
) -> Verdict:
    """Grade one reference probe from its cell, its status, and its evidence.

    Args:
        cell: Whose object the injected id named.
        status: The status the server returned.
        object_was_reached: Whether the evidence -- the probe's own response,
            the listing it returned, or the read-back issued as the object's
            owner -- showed the request reaching the referenced object.
        evidence_unavailable: Whether there was no evidence to read. It defaults
            to the readable case because every caller with an observation to
            report has one; only the runner learns that a body could not be
            parsed or a read-back was refused, and it says so explicitly. A
            control in this state necessarily reports ``object_was_reached``
            false, which is already inconclusive and already trips
            :func:`require_reference_positive_controls`.
        control_proved_mechanism: Whether the paired control both succeeded and
            surfaced its own id. It defaults to ``False`` so this function is
            fail-closed on its own: a caller that forgets to supply it grades an
            ambiguous 2xx as inconclusive rather than as a pass.

    Returns:
        The verdict. Every ambiguous outcome grades toward RED.
    """
    if cell is Cell.REFERENCE_CONTROL:
        return _judge_reference_control(status, object_was_reached=object_was_reached)
    if _is_success(status):
        return _judge_reference_success(
            object_was_reached=object_was_reached,
            evidence_unavailable=evidence_unavailable,
            control_proved_mechanism=control_proved_mechanism,
        )
    return _judge_reference_refusal(status)


def require_live_stages_completed(failure: LiveFailure | None) -> GuardFailure | None:
    """Prove every stage of live I/O reached an answer instead of erroring out.

    Args:
        failure: The stage that failed, or ``None`` when all of them completed.

    Returns:
        ``None`` when the run got far enough to have a verdict of its own. An
        instance that refuses the connection, a database that will not accept
        the identity insert, a login that answers something unexpected -- each
        leaves the matrix having probed nothing, and each would otherwise leave
        the process on an uncaught exception, which exits 1: bit-for-bit the
        code for a genuine authorization finding. Reporting it here is what
        keeps "the harness never authenticated" distinguishable from "user B
        read user A's journal".
    """
    if failure is None:
        return None
    return GuardFailure(
        guard="require_live_stages_completed",
        detail=f"{failure.stage} against {failure.target} failed: {failure.summary}",
    )


def require_auth_established(
    *,
    authenticated_status: int,
    unauthenticated_status: int,
) -> GuardFailure | None:
    """Prove the credential works *and* that the auth layer is engaged at all.

    Args:
        authenticated_status: What the probe route returned with the owner's token.
        unauthenticated_status: What it returned with no token.

    Returns:
        ``None`` only when the first is 200 and the second is 401. Both halves
        matter: the first proves the token is accepted, the second proves
        refusals are possible. Without the second, an application whose auth was
        entirely bypassed would sail through every later cell.
    """
    if authenticated_status == HTTPStatus.OK and unauthenticated_status == HTTPStatus.UNAUTHORIZED:
        return None
    return GuardFailure(
        guard="require_auth_established",
        detail=(
            f"the auth probe returned {authenticated_status} with the owner's token and "
            f"{unauthenticated_status} without one; expected 200 and 401"
        ),
    )


def require_positive_controls(results: Sequence[CellResult]) -> GuardFailure | None:
    """Prove every probed route could be reached by the owner of its object.

    Args:
        results: Every graded cell of the run.

    Returns:
        ``None`` when each route's ``POSITIVE_CONTROL`` succeeded. A route whose
        object was never really created, or whose replay body was rejected as
        invalid, denies everybody equally -- which reads exactly like a
        correctly guarded route and is the false green this harness exists to
        forbid.
    """
    failed = sorted(
        f"{result.route.method} {result.route.path}"
        for result in results
        if result.cell is Cell.POSITIVE_CONTROL and result.verdict is not Verdict.PASS
    )
    if not failed:
        return None
    return GuardFailure(
        guard="require_positive_controls",
        detail=(
            f"{len(failed)} route(s) could not be reached by their own owner, "
            f"so their denials prove nothing: {', '.join(failed)}"
        ),
    )


def require_minimum_coverage(probed: int, *, minimum: int) -> GuardFailure | None:
    """Prove the matrix still covers the application it is supposed to cover.

    Args:
        probed: How many routes produced cells.
        minimum: The floor the run was told to expect.

    Returns:
        ``None`` when at least ``minimum`` routes were probed. Zero catches an
        empty or garbled document, which would otherwise score a perfect clean
        run; the floor catches the slower failure where a matrix quietly shrinks
        and nobody notices.
    """
    if probed >= minimum:
        return None
    return GuardFailure(
        guard="require_minimum_coverage",
        detail=f"only {probed} route(s) were probed; at least {minimum} were expected",
    )


def require_seeded_resources(seeded: int) -> GuardFailure | None:
    """Prove at least one real object existed for the probes to address.

    Args:
        seeded: How many routes had their objects created successfully.

    Returns:
        ``None`` once anything was seeded. With nothing seeded every probe
        addresses an id that never existed, so every 404 is meaningless.
    """
    if seeded > 0:
        return None
    return GuardFailure(
        guard="require_seeded_resources",
        detail="no objects were created, so every probe addressed an id that never existed",
    )


def require_no_throttling(statuses: Sequence[int]) -> GuardFailure | None:
    """Prove the rate limiter never turned a probe into a false denial.

    Args:
        statuses: Every status the run observed, seeding included.

    Returns:
        ``None`` when no response was throttled. One 429 anywhere is enough to
        fail: the harness spreads requests across forwarded client keys
        precisely so this cannot happen, so a single throttled response means
        that mechanism stopped working and the run's denials are suspect.
    """
    throttled = sum(1 for status in statuses if status == HTTPStatus.TOO_MANY_REQUESTS)
    if not throttled:
        return None
    return GuardFailure(
        guard="require_no_throttling",
        detail=f"{throttled} of {len(statuses)} responses were 429; results are inconclusive",
    )


def _entry_label(entry: AllowlistEntry) -> str:
    """Name one entry the way an operator would search the file for it."""
    if entry.field is None:
        return f"{entry.method} {entry.path}"
    return f"{entry.method} {entry.path} {entry.field}"


def _entry_is_live(entry: AllowlistEntry, routes: Mapping[tuple[str, str], RouteSpec]) -> bool:
    """Report whether an entry still names something the application publishes.

    A route-scoped entry is live while its operation exists. A field-scoped one
    needs the property as well: the operation may well have survived a rename
    that took the excused field with it.
    """
    spec = routes.get((entry.method, entry.path))
    if spec is None:
        return False
    return entry.field is None or publishes_field(spec, entry.field)


def require_allowlist_is_live(
    allowlist: Sequence[AllowlistEntry],
    routes: Sequence[RouteSpec],
) -> GuardFailure | None:
    """Prove every allow-list entry still names something the running application has.

    Args:
        allowlist: The loaded opt-out entries.
        routes: Every route the current document declares.

    Returns:
        ``None`` when each entry matches a live route, and -- for the entries
        scoped to a single body property or query parameter -- a field that
        route still declares. A rename leaves the excuse behind, and the excuse
        then keeps excusing nothing: the classifier will not let it transfer to
        whatever replaced the field, so without this it would simply stop doing
        anything, silently and forever. Left unchecked the allow-list becomes a
        graveyard whose size guard eventually fires for reasons nobody can
        reconstruct.
    """
    live = {(route.method, route.path): route for route in routes}
    stale = sorted(_entry_label(entry) for entry in allowlist if not _entry_is_live(entry, live))
    if not stale:
        return None
    return GuardFailure(
        guard="require_allowlist_is_live",
        detail=(
            f"{len(stale)} allow-list entry(s) no longer match anything this app "
            f"publishes: {', '.join(stale)}"
        ),
    )


def require_allowlist_bounded(
    allowlisted: int,
    considered: int,
    *,
    max_fraction: float,
) -> GuardFailure | None:
    """Prove the opt-out list still excuses a minority of the application.

    Args:
        allowlisted: How many routes carry an allow-list entry.
        considered: How many routes were classified at all.
        max_fraction: The permitted share, inclusive.

    Returns:
        ``None`` while the share is within bounds. Multiplication rather than
        division keeps an empty document -- zero considered, zero allow-listed
        -- from raising instead of reporting.
    """
    if allowlisted <= considered * max_fraction:
        return None
    return GuardFailure(
        guard="require_allowlist_bounded",
        detail=(
            f"{allowlisted} of {considered} route(s) are allow-listed, "
            f"above the permitted {max_fraction:.0%}"
        ),
    )


def require_within_budget(elapsed_seconds: float, *, budget_seconds: float) -> GuardFailure | None:
    """Prove the matrix finished inside its time box.

    Args:
        elapsed_seconds: Wall-clock time the matrix took.
        budget_seconds: The ceiling the run was given.

    Returns:
        ``None`` for a run inside its budget. Enforcing the limit here rather
        than in the workflow measures the matrix itself instead of the runner's
        package installation.
    """
    if elapsed_seconds <= budget_seconds:
        return None
    return GuardFailure(
        guard="require_within_budget",
        detail=f"the matrix took {elapsed_seconds:.1f}s, over its {budget_seconds:.1f}s budget",
    )


def _control_proved_nothing(result: ReferenceCellResult) -> bool:
    """Report whether this cell is a control that failed to make its cross cell readable.

    Read from the status and the evidence rather than from the verdict, so a
    change to the grader can never quietly disarm the guard that checks it.
    """
    if result.cell is not Cell.REFERENCE_CONTROL:
        return False
    return not (_is_success(result.status) and result.object_was_reached)


def require_reference_positive_controls(
    results: Sequence[ReferenceCellResult],
) -> GuardFailure | None:
    """Prove every probed reference has a control that both worked and showed its id.

    Args:
        results: Every graded reference cell of the run.

    Returns:
        ``None`` when each control succeeded *and* surfaced the caller's own
        object. Either half missing makes the cross cell's silence
        unfalsifiable: a control the route rejected denies everybody equally,
        and a control that answered 2xx while showing nothing proves that this
        route's responses say nothing about which object was reached. Both are
        read here from the status and the evidence rather than from the verdict,
        so a change to the grader can never quietly disarm the guard that is
        supposed to check it.
    """
    failed = sorted(
        f"{result.route.method} {result.route.path} {result.reference.field}"
        for result in results
        if _control_proved_nothing(result)
    )
    if not failed:
        return None
    return GuardFailure(
        guard="require_reference_positive_controls",
        detail=(
            f"{len(failed)} reference control(s) did not both succeed and surface the "
            f"caller's own object, so their cross-user answers prove nothing: "
            f"{', '.join(failed)}"
        ),
    )


def require_minimum_reference_coverage(probed: int, *, minimum: int) -> GuardFailure | None:
    """Prove the reference dimension still covers the ids the application accepts.

    Args:
        probed: How many ``(route, field)`` references produced cells.
        minimum: The floor the run was told to expect.

    Returns:
        ``None`` when at least ``minimum`` references were probed. Zero catches
        the run that entered this dimension not at all -- a garbled document, a
        harness that could not authenticate -- which would otherwise score a
        perfect clean sweep of a surface it never touched.
    """
    if probed >= minimum:
        return None
    return GuardFailure(
        guard="require_minimum_reference_coverage",
        detail=f"only {probed} reference(s) were probed; at least {minimum} were expected",
    )


def require_reference_allowlist_bounded(
    allowlisted: int,
    considered: int,
    *,
    max_fraction: float,
) -> GuardFailure | None:
    """Prove the opt-out list still excuses a minority of the ids the application accepts.

    Args:
        allowlisted: How many ``(route, field)`` references carry an entry.
        considered: How many references were classified at all.
        max_fraction: The permitted share, inclusive.

    Returns:
        ``None`` while the share is within bounds. This is the ceiling the
        reference dimension was missing: :func:`require_allowlist_bounded`
        measures routes, and a field-scoped entry excuses no route, so it enters
        neither side of that fraction. Without this guard a file could excuse
        every body- and query-carried id in the application and the only thing
        left standing between it and a clean sweep would be the absolute
        coverage floor -- which holds today by the accident of how many
        references this application happens to publish.
    """
    if allowlisted <= considered * max_fraction:
        return None
    return GuardFailure(
        guard="require_reference_allowlist_bounded",
        detail=(
            f"{allowlisted} of {considered} body/query reference(s) are allow-listed, "
            f"above the permitted {max_fraction:.0%}"
        ),
    )


def _declared_references(
    reference_registry: ReferenceRegistry,
) -> Iterator[tuple[str, str, str]]:
    """Flatten the registry into one ``(method, path, field)`` triple per declaration.

    The registry nests references under routes, and the liveness question is
    asked of each reference on its own, so the nesting is undone once here
    rather than inside the comparison that follows.
    """
    for (method, path), probe in reference_registry.items():
        for reference in probe.references:
            yield method, path, reference.field


def require_declared_references_classified(
    reference_registry: ReferenceRegistry,
    targets: Sequence[ReferenceTarget],
) -> GuardFailure | None:
    """Prove every reference the registry declares was accounted for by this run.

    Args:
        reference_registry: The declared probes, keyed by ``(method, path)``.
        targets: Every classified reference, covered and excused and uncovered
            alike -- the question is whether the declaration was placed at all,
            not which bucket it landed in.

    Returns:
        ``None`` when each declaration was classified. The classifier walks the
        fields the *document* publishes, so a declaration whose route or
        property has gone falls into no bucket rather than into ``uncovered``:
        it stops being probed and stops being counted in the same instant, and
        nothing says so. The unit suite catches that against this application's
        own document, but a run pointed at a stale deployed instance sees a
        different document, and there the dimension would shrink silently toward
        its floor.
    """
    classified = {(target.route.method, target.route.path, target.field) for target in targets}
    missing = sorted(
        " ".join(declared)
        for declared in _declared_references(reference_registry)
        if declared not in classified
    )
    if not missing:
        return None
    return GuardFailure(
        guard="require_declared_references_classified",
        detail=(
            f"{len(missing)} declared reference(s) were neither probed nor classified, so "
            f"this instance no longer publishes them: {', '.join(missing)}"
        ),
    )
