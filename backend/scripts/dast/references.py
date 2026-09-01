"""Declare which body- and query-carried ids get probed, and how a hit is recognised.

The path matrix asks one question -- can identity B reach identity A's object? --
of every route that names an object in its URL. This module asks the same
question of every route that names one in a JSON request body or a query string,
which is the larger half of the surface in this application: a journal entry
links a practice session, a goal is filed under a group, a listing is filtered
by a user-practice.

A body reference cannot be graded the way a path reference is. Reaching
``/journal/14`` at all is the leak, so its status is the whole answer. But
``GET /journal/?practice_session_id=`` applies its filter *after* scoping to the
caller, so a foreign id there is answered ``200`` with an empty page -- a
correct route that status-only grading would report as a leak, and a gate that
cries wolf is a gate somebody switches off. The question asked of a ``2xx`` is
therefore "did the foreign object appear in the evidence?", and the three
:class:`EvidenceStrategy` values are the three places that evidence can live:

* ``ECHO`` -- the probe's own response repeats the id it was handed. Most
  creates do this, and it is the cheapest honest answer.
* ``LISTING`` -- the probe *is* a read, so its body is the evidence directly.
* ``READ_BACK`` -- the response says nothing at all, so the object is read back
  through a declared follow-up ``GET`` issued as the object's own owner. Without
  it, a write that lands silently on somebody else's row passes forever, which
  is exactly the route an attacker would prefer. The follow-up has to be an
  owner-visible surface, and that obligation is spelled out on
  :attr:`ObjectReference.read_back_path` because a creator-scoped listing
  satisfies every check here while proving nothing.

Some routes answer with no id at all -- not in the response, not in any listing,
not through any follow-up read. Folding a quote into a reflection reports only
whether the quote is still pending; a check-in reports only the streak. Scanning
those answers for the injected id finds nothing on *either* cell, which leaves
the cross cell graded on its status alone -- the one thing this module exists to
avoid. So a reference may instead declare an :class:`EvidenceWitness`: a pointer
to a field of the evidence and the condition that field satisfies only once the
write has actually landed. ``pending: false`` is such a fact, and so is a streak
of at least one. A witness *replaces* the id scan for the reference that
declares it, because a body with no id in it has nothing to scan and a numeric
field that happens to equal the id would be a false leak.

A witness cannot rot quietly. If the field it points at is renamed away, the
witness stops firing on the control as well as on the cross cell, and the
positive-control guard fails the run by name rather than letting the reference
slide back to status grading.

``READ_BACK`` carries the same caveat in the other direction: it is only as
sharp as the read surface it has. Where a route's effect is observable -- an
attachment appearing under its parent -- the follow-up distinguishes a write
that landed from one that did not. Where it is not, a witness over the route's
own answer is the sharper instrument, and the two compose: the witness is
evaluated over whichever body the strategy produced.

The tables are data on purpose. A new ``*_id`` in a request schema is discovered
by :mod:`scripts.dast.discovery` the day it lands, and the policy layer then
demands either an entry here or a written allow-list line -- so the way this
check goes quietly out of date is closed by the build rather than by vigilance.

Everything in this module is pure: a probe and a seeded id in, a request or a
boolean out. The requests themselves belong to the runner.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from enum import Enum, auto
from types import MappingProxyType

from scripts.dast.seeds import REPLAY_BODIES, SESSION_WINDOW, render_payload


class ReferenceLocation(Enum):
    """Where in the request the id travels."""

    BODY = auto()
    QUERY = auto()


class EvidenceStrategy(Enum):
    """Where to look for proof that the referenced object was actually reached."""

    ECHO = auto()
    LISTING = auto()
    READ_BACK = auto()


class WitnessCondition(Enum):
    """The condition a witnessed field satisfies only once the write landed."""

    IS_FALSE = auto()
    AT_LEAST_ONE = auto()


@dataclass(frozen=True)
class EvidenceWitness:
    """A fact in the evidence that is true only once the referenced object was reached.

    Attributes:
        pointer: The property path into the evidence body, outermost first. A
            path that does not resolve reads as "the fact is absent", so a
            renamed field makes the witness go quiet on the control too --
            which the positive-control guard reports rather than tolerates.
        condition: What the value at that path has to be. The vocabulary is
            closed and tiny on purpose: an arbitrary callable here would be a
            predicate nobody reviews, and the point of the witness is that a
            reader can check it against the route by eye.
    """

    pointer: tuple[str, ...]
    condition: WitnessCondition


@dataclass(frozen=True)
class ObjectReference:
    """One id a route accepts, and how the matrix decides whether it was honoured.

    Attributes:
        field: The property or query parameter name, exactly as the document
            spells it.
        location: Whether the id rides in the JSON body or the query string.
        seed_key: The :data:`scripts.dast.seeds.SEED_REGISTRY` key that creates
            an object this field can name. It is frequently *not* the field's
            own name -- ``goal_group_id`` names a goal group, whose seed spec is
            keyed ``group_id`` after the path parameter that also names one.
        evidence: How a hit is recognised.
        read_back_path: The follow-up ``GET`` for a ``READ_BACK`` reference,
            templated on the seed key. Required for that strategy and forbidden
            for the others, which is asserted against the shipped registry: a
            read-back without a path would grade every silent response
            inconclusive forever, and a path nobody reads is a request wasted on
            every cell.

            The path carries one obligation the type system cannot check and
            the author has to satisfy: it MUST name an **owner-visible**
            surface -- one that shows the object's owner every write made
            against that object, by anyone. A listing scoped to whoever created
            the row looks identical from here and is silently useless: the
            control reads back its own write on its own object and always finds
            it, while the cross cell's write stays hidden from the owner it
            landed on, so the strategy manufactures the absence it then grades
            as a pass. Where the application offers no such surface, a witness
            over the route's own answer is the instrument to reach for instead.
        witness: The fact to look for instead of the id, for a route whose
            evidence never names the object it acted on. ``None`` -- the usual
            case -- scans the evidence for the id.
    """

    field: str
    location: ReferenceLocation
    seed_key: str
    evidence: EvidenceStrategy
    read_back_path: str | None = None
    witness: EvidenceWitness | None = None


@dataclass(frozen=True)
class ReferenceProbe:
    """How to issue one route's request so that only the reference is in question.

    Attributes:
        method: The verb to send.
        path: The path template, braces intact.
        body: The rest of the request body -- everything the route requires
            besides the id under test. Without it the route answers 422 before
            it ever reads the reference, which is not a denial but a probe that
            proved nothing. String values may interpolate a seeded id, the
            per-request ``{unique}`` token, or the session window fields, the
            same way a seed payload does.
        path_seeds: Seed keys for the path parameters this route interpolates,
            seeded as the *caller* so the request gets past the path's own
            ownership check and reaches the body.
        references: The ids this route accepts, one probed cell pair each.
    """

    method: str
    path: str
    body: Mapping[str, object]
    path_seeds: tuple[str, ...] = ()
    references: tuple[ObjectReference, ...] = ()


@dataclass(frozen=True)
class ReferenceRequest:
    """The two halves of one probe request, ready to hand to the client.

    Attributes:
        params: Query parameters, empty for a body reference.
        body: The JSON body, or ``None`` for a query reference -- posting a
            body a query route ignores is noise the server has to parse.
    """

    params: Mapping[str, str]
    body: Mapping[str, object] | None = None


ReferenceRegistry = Mapping[tuple[str, str], ReferenceProbe]

# Routes whose reference probes need a body of their own, spelled once.
_GOAL_UPDATE_ROUTE = ("PUT", "/goals/{goal_id}")

# ``PUT`` is a full replace here, so the reference probe has to send every
# required field. It is the same body the path matrix replays, taken from the
# same table, so a schema change lands in one place rather than two.
_GOAL_UPDATE_BODY: Mapping[str, object] = REPLAY_BODIES[_GOAL_UPDATE_ROUTE]

_PROBE_NOTE = "probed by the authorization matrix"

# The smallest count that can only have come from the write under test.
_MOVED_COUNT = 1

REFERENCE_REGISTRY: ReferenceRegistry = MappingProxyType(
    {
        # The check-in names a goal and answers with a streak, so the response
        # never says which goal was reached -- but it does say whether one was.
        # A goal nobody has checked in against has a streak of zero, so a streak
        # of at least one is a fact only a recorded completion produces, and the
        # completion is the write under test.
        ("POST", "/goal_completions/"): ReferenceProbe(
            method="POST",
            path="/goal_completions/",
            body={},
            references=(
                ObjectReference(
                    field="goal_id",
                    location=ReferenceLocation.BODY,
                    seed_key="goal_id",
                    evidence=EvidenceStrategy.ECHO,
                    witness=EvidenceWitness(
                        pointer=("streak",),
                        condition=WitnessCondition.AT_LEAST_ONE,
                    ),
                ),
            ),
        ),
        # The goal in the path is the caller's own; the group in the body is the
        # object under test, and the updated goal echoes the group it was filed
        # under.
        _GOAL_UPDATE_ROUTE: ReferenceProbe(
            method="PUT",
            path="/goals/{goal_id}",
            body=_GOAL_UPDATE_BODY,
            path_seeds=("goal_id",),
            references=(
                ObjectReference(
                    field="goal_group_id",
                    location=ReferenceLocation.BODY,
                    seed_key="group_id",
                    evidence=EvidenceStrategy.ECHO,
                ),
            ),
        ),
        # The listing filters the caller's own entries by session, so it can
        # only surface the id when an entry of the caller's carries it -- which
        # is why the seed key creates that entry and hands back the session id.
        ("GET", "/journal/"): ReferenceProbe(
            method="GET",
            path="/journal/",
            body={},
            references=(
                ObjectReference(
                    field="practice_session_id",
                    location=ReferenceLocation.QUERY,
                    seed_key="journalled_practice_session_id",
                    evidence=EvidenceStrategy.LISTING,
                ),
            ),
        ),
        ("POST", "/journal/"): ReferenceProbe(
            method="POST",
            path="/journal/",
            body={"message": _PROBE_NOTE},
            references=(
                ObjectReference(
                    field="practice_session_id",
                    location=ReferenceLocation.BODY,
                    seed_key="practice_session_id",
                    evidence=EvidenceStrategy.ECHO,
                ),
                ObjectReference(
                    field="user_practice_id",
                    location=ReferenceLocation.BODY,
                    seed_key="user_practice_id",
                    evidence=EvidenceStrategy.ECHO,
                ),
            ),
        ),
        # Same shape as the journal listing: the sessions of a user-practice
        # only name it once one has been logged against it.
        ("GET", "/practice-sessions/"): ReferenceProbe(
            method="GET",
            path="/practice-sessions/",
            body={},
            references=(
                ObjectReference(
                    field="user_practice_id",
                    location=ReferenceLocation.QUERY,
                    seed_key="logged_user_practice_id",
                    evidence=EvidenceStrategy.LISTING,
                ),
            ),
        ),
        ("POST", "/practice-sessions/"): ReferenceProbe(
            method="POST",
            path="/practice-sessions/",
            body=dict(SESSION_WINDOW),
            references=(
                ObjectReference(
                    field="user_practice_id",
                    location=ReferenceLocation.BODY,
                    seed_key="user_practice_id",
                    evidence=EvidenceStrategy.ECHO,
                ),
            ),
        ),
        # Folding a quote into a reflection returns no id at all -- but the quote
        # reports whether it is still pending, and it is pending exactly while
        # the inclusion is null. So ``pending: false`` is a direct reading of the
        # foreign key under test, in the route's own answer, and no follow-up
        # read is needed to see it. The target must itself be a hierarchical
        # reflection, or the route answers 422 for a reason that has nothing to
        # do with ownership, which is why the seed key is the reflection-tagged
        # entry rather than a plain one.
        ("PATCH", "/promotions/{promotion_id}"): ReferenceProbe(
            method="PATCH",
            path="/promotions/{promotion_id}",
            body={},
            path_seeds=("promotion_id",),
            references=(
                ObjectReference(
                    field="included_in_entry_id",
                    location=ReferenceLocation.BODY,
                    seed_key="reflection_entry_id",
                    evidence=EvidenceStrategy.ECHO,
                    witness=EvidenceWitness(
                        pointer=("pending",),
                        condition=WitnessCondition.IS_FALSE,
                    ),
                ),
            ),
        ),
    },
)


def _injected_value(object_id: str) -> object:
    """Return the seeded id in the type its schema declares.

    Ids are read out of JSON responses generically and therefore arrive as text,
    but every ``*_id`` body field in this application is declared ``integer``.
    Posting the text form works only through Pydantic's lax coercion; the day
    any request model turns strict, a string would be answered 422 -- which
    grades as a denial, so every reference probe would silently start passing
    for the wrong reason. A non-numeric id (a slug, a share token) is passed
    through as the text it is.
    """
    return int(object_id) if object_id.isdigit() else object_id


def build_reference_request(
    probe: ReferenceProbe,
    reference: ObjectReference,
    *,
    object_id: str,
    values: Mapping[str, object],
) -> ReferenceRequest:
    """Build the one request that puts ``object_id`` where the route reads it.

    Args:
        probe: The route's declared probe.
        reference: The id under test.
        object_id: The seeded id to inject, as text.
        values: The seeded ids of this cell plus the per-request fields, for
            rendering the rest of the body.

    Returns:
        The query parameters and body to send. A query reference travels in the
        URL and carries no body; a body reference travels in the rendered
        payload, alongside everything else the route requires.
    """
    if reference.location is ReferenceLocation.QUERY:
        return ReferenceRequest(params={reference.field: object_id})
    body = render_payload(probe.body, values)
    body[reference.field] = _injected_value(object_id)
    return ReferenceRequest(params={}, body=body)


def _is_the_id(value: object, object_id: str) -> bool:
    """Report whether one JSON scalar is the id being looked for.

    Whole values are compared rather than serialized text searched: id ``314``
    contains ``31``, and a substring match would report a leak every time the
    longer id came back. Booleans are excluded because ``True == 1``.
    """
    if isinstance(value, bool):
        return False
    return isinstance(value, int | str) and str(value) == object_id


def _value_at(body: object, pointer: Sequence[str]) -> object:
    """Return the value one pointer names, or ``None`` when the path does not resolve.

    A body of the wrong shape at any step yields ``None`` rather than raising:
    an evidence body is whatever the server sent, and a witness that cannot find
    its field has to report that it did not fire, not end the run.
    """
    current = body
    for key in pointer:
        if not isinstance(current, Mapping):
            return None
        current = current.get(key)
    return current


def _is_false(value: object) -> bool:
    """Report whether a flag the write is supposed to clear is in fact cleared."""
    return value is False


def _is_at_least_one(value: object) -> bool:
    """Report whether a counter the write is supposed to move has in fact moved.

    Booleans are excluded because ``True == 1``: a flag is not a count, and
    reading one as the other would let an unrelated field witness a write.
    """
    if isinstance(value, bool):
        return False
    return isinstance(value, int) and value >= _MOVED_COUNT


_WITNESS_TESTS: Mapping[WitnessCondition, Callable[[object], bool]] = MappingProxyType(
    {
        WitnessCondition.IS_FALSE: _is_false,
        WitnessCondition.AT_LEAST_ONE: _is_at_least_one,
    },
)


def witness_fires(witness: EvidenceWitness, body: object) -> bool:
    """Report whether the evidence carries the fact only a landed write produces.

    Args:
        witness: The declared pointer and condition.
        body: The parsed evidence body, of any shape.

    Returns:
        ``True`` only when the pointer resolves *and* the value it names meets
        the condition. Both halves fail closed, so an absent field and a field
        that says the write did not land are reported the same way -- as no
        evidence -- and the paired control is what tells those two apart.
    """
    return _WITNESS_TESTS[witness.condition](_value_at(body, witness.pointer))


def evidence_reaches_object(reference: ObjectReference, body: object, object_id: str) -> bool:
    """Report whether one cell's evidence shows the referenced object was reached.

    Args:
        reference: The id under test, and how a hit is recognised.
        body: The parsed evidence body -- the probe's own response, the listing
            it returned, or the read-back issued as the object's owner.
        object_id: The seeded id, as text.

    Returns:
        The witness's answer when the reference declares one, and otherwise
        whether the id appears anywhere in the body. A witness replaces the scan
        rather than joining it: the routes that need one answer with no id at
        all, so the scan could only match a field that coincidentally equals the
        id, which would be a leak reported against a route that did nothing.
    """
    if reference.witness is not None:
        return witness_fires(reference.witness, body)
    return body_carries_id(body, object_id)


def body_carries_id(body: object, object_id: str) -> bool:
    """Report whether a parsed response body names the object anywhere inside it.

    Args:
        body: The parsed JSON body, of any shape.
        object_id: The seeded id, as text.

    Returns:
        ``True`` when the id appears as a value at any depth. Responses wrap ids
        in pages, envelopes, and nested objects, so a shallow check would miss
        the evidence and grade a real leak inconclusive. An id serialized as a
        string counts: the object was reached either way.
    """
    if isinstance(body, Mapping):
        return any(body_carries_id(value, object_id) for value in body.values())
    if isinstance(body, list):
        return any(body_carries_id(value, object_id) for value in body)
    return _is_the_id(body, object_id)
