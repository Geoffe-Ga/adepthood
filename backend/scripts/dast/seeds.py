"""Create the objects the matrix probes, and carry the bodies its replays need.

Two tables and the small amount of pure logic that reads them.

``SEED_REGISTRY`` is keyed by *path-parameter name* rather than by resource,
which is what lets a two-parameter route like
``/practice-recipes/{recipe_id}/apply-to/{user_practice_id}`` be filled without
a bespoke rule: each parameter is resolved independently, and parameter names
are globally consistent in this application. Every payload lives in this one
table so a schema change has exactly one place to land.

``REPLAY_BODIES`` supplies a valid request body for the mutating verbs that
require one. Without it a replayed ``PUT`` returns 422 before the ownership
check ever runs -- which is not a denial, merely a probe that proved nothing.
The positive control catches that automatically, but the point is to exercise
the real cell, so the bodies are here.

Three kinds of substitution run over both tables, and all of them are ordinary
``str.format`` fields so a spec reads as the request it will become.
``{some_id}`` is filled from an object seeded earlier in the same cell, which is
how a dependent create path finds its parent; ``{unique}`` is filled with a
fresh random token, which is what keeps a slug or a habit name from colliding
with the object seeded for the previous cell; and ``{started_at}`` /
``{ended_at}`` are filled with a window that ends now, because a practice
session is validated against the wall clock and a constant timestamp would be
rejected as stale the day after it was written.

A handful of specs exist only to be *named* by a body or query reference rather
than by a path parameter. Each of those creates the row a filtered listing needs
in order to have anything to return, and hands back the id of the object under
test rather than of the row it just made -- a listing whose control answers with
an empty page proves nothing, and the reference guards fail the run when it does.

The two top-level tables are read-only proxies so they can be bound as
configuration defaults; everything nested inside them is a plain dict, because
these payloads are handed straight to a JSON encoder that refuses a proxy.

Everything here is pure. The requests themselves belong to the runner.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from types import MappingProxyType

from scripts.dast.discovery import RouteSpec

# Only these verbs carry a request body in this application; sending one on a
# GET or DELETE would be noise the server has to ignore.
_BODY_METHODS = frozenset({"POST", "PUT", "PATCH"})

# The field every payload and create path may interpolate to stay unique across
# the four cells of a route.
UNIQUE_FIELD = "unique"

# A practice session is validated against the wall clock: a window that ends in
# the future, or starts more than a day ago, is answered 422 before the
# ownership check ever runs -- a probe that proved nothing. So the two
# timestamps are rendered per request rather than written down as constants.
STARTED_AT_FIELD = "started_at"
ENDED_AT_FIELD = "ended_at"
_SESSION_MINUTES = 10

# Spelled once and shared by the seed spec and the reference probe, so the two
# cannot drift into disagreeing about what a valid session looks like.
SESSION_WINDOW: Mapping[str, object] = MappingProxyType(
    {
        STARTED_AT_FIELD: f"{{{STARTED_AT_FIELD}}}",
        ENDED_AT_FIELD: f"{{{ENDED_AT_FIELD}}}",
    },
)

# Stage 1 is the curriculum's entry point, so it is the one stage every fresh
# identity can select a practice for.
_SEED_STAGE_NUMBER = 1

# A sense-grounding practice is seeded rather than a meditation timer because
# the recipe-application route refuses a mode mismatch: recipes are
# grounding-only, so the practice a recipe is applied to has to match.
_SENSE_GROUNDING = "sense_grounding"
_SENSE_PROMPT = "Notice one thing you can see"
_SIGHT_TAG = "sight"

_RECIPE_STEP: dict[str, object] = {
    "tag_slug": _SIGHT_TAG,
    "tag_label": "Sight",
    "prompt_label": _SENSE_PROMPT,
    "target_count": 1,
}

_HABIT_FIELDS: dict[str, object] = {
    "icon": "star",
    "start_date": "2024-01-01",
    "energy_cost": 1,
    "energy_return": 2,
}

_SEED_NOTE = "seeded by the authorization matrix"
_REPLAY_NAME = "dast replay"

# The one journal tag a promoted quote may be folded into.
_HIERARCHICAL_REFLECTION = "hierarchical_reflection"


@dataclass(frozen=True)
class SeedSpec:
    """How to create one object of the kind a path parameter names.

    Attributes:
        create_method: The verb of the create request.
        create_path: Its path, which may itself interpolate an earlier seed.
        payload: The request body, whose string values may interpolate an
            earlier seed or ``{unique}``.
        id_pointer: How to read the new object's id out of the response, e.g.
            ``("id",)`` or ``("goals", 0, "id")``.
        depends_on: Parameters that must be seeded first. Every parameter the
            create path interpolates has to appear here, or the ordering would
            be luck.
    """

    create_method: str
    create_path: str
    payload: Mapping[str, object]
    id_pointer: tuple[str | int, ...]
    depends_on: tuple[str, ...] = ()


SEED_REGISTRY: Mapping[str, SeedSpec] = MappingProxyType(
    {
        "habit_id": SeedSpec(
            create_method="POST",
            create_path="/habits/",
            payload={"name": "DAST habit {unique}", **_HABIT_FIELDS},
            id_pointer=("id",),
        ),
        # Creating a habit auto-creates its three goals, so the same call is
        # also the only way to obtain a goal the caller owns.
        "goal_id": SeedSpec(
            create_method="POST",
            create_path="/habits/",
            payload={"name": "DAST goal carrier {unique}", **_HABIT_FIELDS},
            id_pointer=("goals", 0, "id"),
        ),
        "entry_id": SeedSpec(
            create_method="POST",
            create_path="/journal/",
            payload={"message": _SEED_NOTE},
            id_pointer=("id",),
        ),
        "group_id": SeedSpec(
            create_method="POST",
            create_path="/goal-groups/",
            payload={"name": "DAST group {unique}"},
            id_pointer=("id",),
        ),
        "tag_id": SeedSpec(
            create_method="POST",
            create_path="/practice-tags/",
            payload={"slug": "dast_tag_{unique}", "label": "DAST tag {unique}"},
            id_pointer=("id",),
        ),
        "recipe_id": SeedSpec(
            create_method="POST",
            create_path="/practice-recipes/",
            payload={
                "slug": "dast_recipe_{unique}",
                "name": "DAST recipe {unique}",
                "mode": _SENSE_GROUNDING,
                "steps": [_RECIPE_STEP],
            },
            id_pointer=("id",),
        ),
        # Read from the catalog rather than submitted, for two reasons.
        #
        # The first is that probing a *shared* practice is the only honest thing
        # to do here: the application deliberately lets any authenticated user
        # reach a preset. ``require_visible_practice`` returns any approved
        # practice to anybody, and the share-link resolver admits a practice
        # whose ``submitted_by_user_id`` is NULL by design. Cross-user access to
        # a preset is therefore the feature, and the three routes that address
        # this id directly are allow-listed saying exactly that -- a matrix that
        # probed them against a submitted practice instead would report a
        # false-positive LEAK and teach everyone to ignore the gate. The
        # ownership rule that does exist (a draft is visible only to its
        # submitter) is pinned in-process by tests/security/test_idor.py.
        #
        # The second is mechanical: submitting is capped at five practices per
        # minute per user, keyed on the JWT subject rather than the client
        # address, so the per-request forwarded address the rest of the matrix
        # relies on cannot spread that cost -- and the matrix needs a practice
        # for every cell of every route that names one.
        #
        # Reusing one preset across cells is safe because nothing here can
        # destroy it. It is a prerequisite for the objects that *are* probed --
        # share links and user-practices, both of which stay fresh per cell.
        # Stage 1's canonical preset is a sense-grounding practice, and it is
        # the first practice row the seeder inserts, so an unordered listing
        # returns it first. That is what lets a recipe be applied to it without
        # a mode mismatch. Should the seeder ever put a non-grounding practice
        # first, the recipe-application route's positive control returns 400 and
        # the run fails naming that route -- loudly, not silently.
        "practice_id": SeedSpec(
            create_method="GET",
            create_path=f"/practices/?stage_number={_SEED_STAGE_NUMBER}",
            payload={},
            id_pointer=(0, "id"),
        ),
        "user_practice_id": SeedSpec(
            create_method="POST",
            create_path="/user-practices/",
            payload={"practice_id": "{practice_id}", "stage_number": _SEED_STAGE_NUMBER},
            id_pointer=("id",),
            depends_on=("practice_id",),
        ),
        "share_link_id": SeedSpec(
            create_method="POST",
            create_path="/practices/{practice_id}/share-link",
            payload={},
            id_pointer=("id",),
            depends_on=("practice_id",),
        ),
        "promotion_id": SeedSpec(
            create_method="POST",
            create_path="/journal/{entry_id}/promote",
            payload={"anchor_start": 0, "anchor_end": 4},
            id_pointer=("id",),
            depends_on=("entry_id",),
        ),
        "practice_session_id": SeedSpec(
            create_method="POST",
            create_path="/practice-sessions/",
            payload={"user_practice_id": "{user_practice_id}", **SESSION_WINDOW},
            id_pointer=("id",),
            depends_on=("user_practice_id",),
        ),
        # A quote may only be folded into a *hierarchical reflection*: any other
        # tag is refused 422 for a reason that has nothing to do with who owns
        # the target, which would let the probe pass while proving nothing. So
        # the inclusion target is seeded with the tag the route demands rather
        # than reusing the plain ``entry_id`` note.
        "reflection_entry_id": SeedSpec(
            create_method="POST",
            create_path="/journal/",
            payload={"message": _SEED_NOTE, "tag": _HIERARCHICAL_REFLECTION},
            id_pointer=("id",),
        ),
        # The next two exist for the filtered listings, and each hands back the
        # id of the object the *filter* names rather than of the row it just
        # created. A listing scoped to the caller can only surface a session or
        # a user-practice id once the caller owns something that carries it; a
        # control answering with an empty page proves nothing, and the reference
        # guard fails the run rather than let that count as a pass.
        "journalled_practice_session_id": SeedSpec(
            create_method="POST",
            create_path="/journal/",
            payload={"message": _SEED_NOTE, "practice_session_id": "{practice_session_id}"},
            id_pointer=("practice_session_id",),
            depends_on=("practice_session_id",),
        ),
        "logged_user_practice_id": SeedSpec(
            create_method="POST",
            create_path="/practice-sessions/",
            payload={"user_practice_id": "{user_practice_id}", **SESSION_WINDOW},
            id_pointer=("user_practice_id",),
            depends_on=("user_practice_id",),
        ),
    },
)


REPLAY_BODIES: Mapping[tuple[str, str], Mapping[str, object]] = MappingProxyType(
    {
        ("PUT", "/goal-groups/{group_id}"): {"name": _REPLAY_NAME},
        ("PUT", "/goals/{goal_id}"): {
            "title": _REPLAY_NAME,
            "tier": "low",
            "target": 1,
            "target_unit": "reps",
            "frequency": 1,
            "frequency_unit": "day",
        },
        ("PUT", "/habits/{habit_id}"): {"name": "DAST replayed habit", **_HABIT_FIELDS},
        ("PUT", "/habits/{habit_id}/goals/units"): {
            "target_unit": "reps",
            "frequency": 1,
            "frequency_unit": "day",
        },
        ("PATCH", "/journal/{entry_id}"): {"title": _REPLAY_NAME},
        ("POST", "/journal/{entry_id}/promote"): {"anchor_start": 0, "anchor_end": 4},
        ("PATCH", "/practice-recipes/{recipe_id}"): {
            "name": _REPLAY_NAME,
            "steps": [_RECIPE_STEP],
        },
        ("PATCH", "/practice-tags/{tag_id}"): {"label": _REPLAY_NAME},
        ("PATCH", "/promotions/{promotion_id}"): {"included_in_entry_id": None},
    },
)


def window_fields(now: datetime) -> dict[str, str]:
    """Return the session window every practice-session payload interpolates.

    Args:
        now: The instant the request is being built for. Passed in rather than
            read here so this module stays pure and the window is testable.

    Returns:
        An ISO ``started_at`` / ``ended_at`` pair ending at ``now``, short
        enough to satisfy the route's duration ceiling and recent enough to
        satisfy its backdating limit.
    """
    return {
        STARTED_AT_FIELD: (now - timedelta(minutes=_SESSION_MINUTES)).isoformat(),
        ENDED_AT_FIELD: now.isoformat(),
    }


def render_text(template: str, values: Mapping[str, object]) -> str:
    """Interpolate seeded ids and the unique token into one template string.

    Args:
        template: A path or payload string with ``{name}`` fields.
        values: The seeded ids of this cell plus ``unique``.

    Returns:
        The rendered string. A field the mapping cannot supply raises, which is
        the loud failure a silently unsubstituted path would not be.
    """
    return template.format(**values)


def _render_value(value: object, values: Mapping[str, object]) -> object:
    """Interpolate a string leaf, or pass any other JSON value through."""
    if isinstance(value, str):
        return render_text(value, values)
    return value


def render_payload(
    payload: Mapping[str, object],
    values: Mapping[str, object],
) -> dict[str, object]:
    """Render a create payload against this cell's seeded ids.

    Args:
        payload: The spec's declared body.
        values: The seeded ids of this cell plus ``unique``.

    Returns:
        A JSON-ready body. Only top-level string values are interpolated;
        numbers and nested structures are constant by construction, so they are
        copied through untouched.
    """
    return {key: _render_value(value, values) for key, value in payload.items()}


def create_body(spec: SeedSpec, values: Mapping[str, object]) -> dict[str, object] | None:
    """Render a create request's body, or return ``None`` for a verb that takes none.

    Args:
        spec: The seed strategy being run.
        values: The seeded ids of this cell plus ``unique``.

    Returns:
        The rendered body for a mutating create, and ``None`` for a read -- a
        catalog lookup is a legitimate way to obtain a prerequisite id, and
        attaching a JSON body to it would be noise.
    """
    if spec.create_method not in _BODY_METHODS:
        return None
    return render_payload(spec.payload, values)


def _visit(
    param: str,
    registry: Mapping[str, SeedSpec],
    ordered: list[str],
    pending: set[str],
) -> None:
    """Append ``param`` after its dependencies, skipping anything already placed.

    ``pending`` holds the parameters whose dependencies are still being walked,
    so a registry that somehow described a cycle degrades to a partial order
    instead of recursing until the interpreter gives up.
    """
    if param in ordered or param in pending or param not in registry:
        return
    pending.add(param)
    for dependency in registry[param].depends_on:
        _visit(dependency, registry, ordered, pending)
    ordered.append(param)


def seed_order(params: Sequence[str], registry: Mapping[str, SeedSpec]) -> tuple[str, ...]:
    """Return the parameters to seed, dependencies first.

    Args:
        params: The path parameters of the route being probed.
        registry: The seed strategies to resolve against.

    Returns:
        Each parameter once, preceded by whatever it depends on. Parameters the
        registry does not know are dropped here; the policy layer has already
        refused to call such a route covered.
    """
    ordered: list[str] = []
    pending: set[str] = set()
    for param in params:
        _visit(param, registry, ordered, pending)
    return tuple(ordered)


def _descend(node: object, step: str | int) -> object:
    """Take one step into a parsed JSON body, or return ``None`` if it does not fit."""
    if isinstance(node, Mapping):
        return node.get(step)
    if isinstance(node, list) and isinstance(step, int) and step < len(node):
        return node[step]
    return None


def resolve_id(body: object, pointer: Sequence[str | int]) -> str | None:
    """Read the new object's id out of a create response.

    Args:
        body: The parsed response body.
        pointer: The path to the id, e.g. ``("goals", 0, "id")``.

    Returns:
        The id as text, or ``None`` when the response does not have the shape
        the spec expects. A missing id is reported as an unseedable route rather
        than raised, so one changed response schema cannot abort the whole run.
    """
    current: object = body
    for step in pointer:
        current = _descend(current, step)
        if current is None:
            return None
    return str(current)


def replay_body(
    route: RouteSpec,
    replay_bodies: Mapping[tuple[str, str], Mapping[str, object]],
) -> Mapping[str, object] | None:
    """Return the body to send when replaying one route, if it takes one.

    Args:
        route: The route being probed.
        replay_bodies: The configured bodies, keyed by ``(method, path)``.

    Returns:
        ``None`` for verbs that carry no body. For a mutating verb, the
        configured body or an empty object: an operation that declares a request
        body and receives none is answered 422 before it ever reaches the
        ownership check, so sending ``{}`` is strictly better than sending
        nothing.
    """
    if route.method not in _BODY_METHODS:
        return None
    return replay_bodies.get((route.method, route.path), {})
