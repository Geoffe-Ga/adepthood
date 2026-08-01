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

``CellResult`` and ``GuardFailure`` live here rather than in the report module
because the runner produces them and the report consumes them; putting the
types beside the grader keeps the dependency pointing one way.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from enum import Enum, auto
from http import HTTPStatus

from scripts.dast.discovery import RouteSpec
from scripts.dast.policy import AllowlistEntry

_SUCCESS_FLOOR = 200
_SUCCESS_CEILING = 300
_SERVER_ERROR_FLOOR = 500

# The two statuses this codebase uses to refuse a cross-user request. The split
# is deliberate: ownership denials 403, while the enumeration-safe resources
# (goals, marginalia, journal entries) collapse to 404 on purpose.
_ACCEPTABLE_DENIALS = frozenset({HTTPStatus.FORBIDDEN, HTTPStatus.NOT_FOUND})


class Cell(Enum):
    """One square of the matrix: which credential met which object."""

    CROSS_USER = auto()
    UNAUTH = auto()
    FORGED_JWT = auto()
    POSITIVE_CONTROL = auto()


# The owner's own call runs last. Running it first against a route whose
# cross-user cell is destructive would let that cell inherit a live row, delete
# it, and leave every later probe reading a 404 as a correct denial.
CELL_ORDER: tuple[Cell, ...] = (
    Cell.CROSS_USER,
    Cell.UNAUTH,
    Cell.FORGED_JWT,
    Cell.POSITIVE_CONTROL,
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
class GuardFailure:
    """A vacuity guard that tripped, named so the report can say which one.

    Attributes:
        guard: The guard function's own name.
        detail: One sentence an operator can act on.
    """

    guard: str
    detail: str


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


def require_allowlist_is_live(
    allowlist: Sequence[AllowlistEntry],
    routes: Sequence[RouteSpec],
) -> GuardFailure | None:
    """Prove every allow-list entry still names a route of the running application.

    Args:
        allowlist: The loaded opt-out entries.
        routes: Every route the current document declares.

    Returns:
        ``None`` when each entry matches a live route. A renamed route leaves
        its excuse behind, and the excuse keeps excusing nothing; left unchecked
        the allow-list becomes a graveyard whose size guard eventually fires for
        reasons nobody can reconstruct.
    """
    live = {(route.method, route.path) for route in routes}
    stale = sorted(
        f"{entry.method} {entry.path}"
        for entry in allowlist
        if (entry.method, entry.path) not in live
    )
    if not stale:
        return None
    return GuardFailure(
        guard="require_allowlist_is_live",
        detail=f"{len(stale)} allow-list entry(s) no longer match any route: {', '.join(stale)}",
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
