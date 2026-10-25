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

import enum
import json
import re
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

# The journal link's default tiers -- 10 / 20 / 45 minutes a day -- as sent by
# ``POST /habits/``'s create-only ``goals`` block. A constant nested value, so
# the top-level-only interpolation passes it through untouched.
_TIMER_GOALS: dict[str, object] = {
    "target_unit": "minutes",
    "frequency": 1,
    "frequency_unit": "per_day",
    "low": 10,
    "clear": 20,
    "stretch": 45,
}

_SEED_NOTE = "seeded by the authorization matrix"
_REPLAY_NAME = "dast replay"

# The one journal tag a promoted quote may be folded into.
_HIERARCHICAL_REFLECTION = "hierarchical_reflection"


class IdSource(enum.Enum):
    """Where a create response carries the value the next step needs.

    Almost every create answers JSON, and ``JSON`` reads it through
    ``id_pointer``. The other two exist for the one object that cannot be made
    that way: an agent grant (#3534) is written only by a person pressing
    Approve on the consent page (#3532), so its seed walks the page a browser
    walks -- the ticket is read out of the rendered form, and the approval is
    read off the redirect back to the agent.
    """

    JSON = "json"
    BODY_TEXT = "body_text"
    LOCATION = "location"


# A redirect: what the consent decision answers, and the only non-2xx a seed
# may count as success.
_REDIRECT_FLOOR = 300
_REDIRECT_CEILING = 400
_SUCCESS_FLOOR = 200


@dataclass(frozen=True)
class SeedSpec:
    """How to create one object of the kind a path parameter names.

    Attributes:
        create_method: The verb of the create request.
        create_path: Its path, which may itself interpolate an earlier seed.
        payload: The request body, whose string values may interpolate an
            earlier seed or ``{unique}``.
        id_pointer: How to read the new object's id out of the response, e.g.
            ``("id",)`` or ``("goals", 0, "id")``. Read only for an
            ``IdSource.JSON`` spec.
        depends_on: Parameters that must be seeded first. Every parameter the
            create path interpolates has to appear here, or the ordering would
            be luck.
        form_encoded: Send the payload as ``application/x-www-form-urlencoded``
            rather than JSON, as an HTML form does.
        id_source: Where the response carries the value; see :class:`IdSource`.
        id_pattern: For a text or redirect source, the regular expression whose
            first group is the value.
    """

    create_method: str
    create_path: str
    payload: Mapping[str, object]
    id_pointer: tuple[str | int, ...]
    depends_on: tuple[str, ...] = ()
    form_encoded: bool = False
    id_source: IdSource = IdSource.JSON
    id_pattern: str | None = None


# --- an agent grant, the way a person makes one (#3534) ----------------------
#
# Five steps, each one ordinary request: connect a vault, register an agent,
# open its consent page, press Approve, and read the grant back off the list
# Settings renders. The vault is an address literal, so connecting it stores the
# address without a lookup; the agent is a public client returning to this
# computer, which the consent page admits on any port.

_AGENT_VAULT_URL = "https://1.1.1.1"
_AGENT_REDIRECT = "http://127.0.0.1/callback"
# RFC 7636 appendix B's published S256 challenge. Only its shape matters here:
# the matrix never exchanges the code it is sent.
_AGENT_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"  # pragma: allowlist secret
_AGENT_AUTHORIZE_PATH = (
    "/oauth/authorize?response_type=code&client_id={agent_client}"
    f"&redirect_uri={_AGENT_REDIRECT}&code_challenge={_AGENT_CHALLENGE}"
    "&code_challenge_method=S256&state=dast&scope=vault:read"
    "&resource={agent_vault}"
)
_CONSENT_TICKET = r'name="ticket" value="([^"]+)"'
_AUTHORIZATION_CODE = r"[?&]code=([^&]+)"
# A public client authenticates with nothing (RFC 7591 ``none``); named so the
# registration body reads as the method it is rather than as a literal secret.
_PUBLIC_CLIENT_AUTH = "none"


SEED_REGISTRY: Mapping[str, SeedSpec] = MappingProxyType(
    {
        "habit_id": SeedSpec(
            create_method="POST",
            create_path="/habits/",
            payload={"name": "DAST habit {unique}", **_HABIT_FIELDS},
            id_pointer=("id",),
        ),
        # A habit a timer may log to (#3150): created with minutes goals,
        # because ``PATCH /ui-flags`` and ``PATCH /user-practices/{id}/habit``
        # (#3151) refuse to link a habit on any unit a timer cannot measure.
        # Only those two references ask for it.
        "timer_habit_id": SeedSpec(
            create_method="POST",
            create_path="/habits/",
            payload={
                "name": "DAST timer habit {unique}",
                **_HABIT_FIELDS,
                "goals": _TIMER_GOALS,
            },
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
        # The steps an agent grant is made by (see the block above SeedSpec).
        # Only the last is named by a path parameter; the four before it are
        # reached through ``depends_on``, which is how each earns its keep.
        "agent_vault": SeedSpec(
            create_method="PUT",
            create_path="/vault/connection",
            # A throwaway per-cell value the vault is never dialled with.
            payload={
                "vault_url": _AGENT_VAULT_URL,
                "api_key": "dast-vault-{unique}",  # pragma: allowlist secret
            },
            id_pointer=("mcp_address",),
        ),
        "agent_client": SeedSpec(
            create_method="POST",
            create_path="/oauth/register",
            payload={
                "client_name": "DAST agent {unique}",
                "redirect_uris": [_AGENT_REDIRECT],
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "token_endpoint_auth_method": _PUBLIC_CLIENT_AUTH,
            },
            id_pointer=("client_id",),
        ),
        "agent_consent_ticket": SeedSpec(
            create_method="GET",
            create_path=_AGENT_AUTHORIZE_PATH,
            payload={},
            id_pointer=(),
            depends_on=("agent_client", "agent_vault"),
            id_source=IdSource.BODY_TEXT,
            id_pattern=_CONSENT_TICKET,
        ),
        "agent_approval": SeedSpec(
            create_method="POST",
            create_path="/oauth/authorize/decision",
            payload={
                "ticket": "{agent_consent_ticket}",
                "decision": "approve",
                "grant.vault:read": "on",
            },
            id_pointer=(),
            depends_on=("agent_consent_ticket",),
            form_encoded=True,
            id_source=IdSource.LOCATION,
            id_pattern=_AUTHORIZATION_CODE,
        ),
        # Newest approval first, and every cell approves a fresh agent, so the
        # head of the list is the grant this cell just made.
        "agent_id": SeedSpec(
            create_method="GET",
            create_path="/vault/agents",
            payload={},
            id_pointer=(0, "id"),
            depends_on=("agent_approval",),
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
        # A feedback receipt is addressed by a minted public reference rather
        # than by a row id, so the seed hands back ``public_id`` rather than
        # ``id``. That is the whole reason the route is worth probing: the
        # reference is the only handle on the report, and the matrix is what
        # proves a second identity holding a real one is refused.
        "public_id": SeedSpec(
            create_method="POST",
            create_path="/feedback/",
            payload={
                "category": "broken",
                "impact": "blocked",
                "summary": _SEED_NOTE,
                "context": {
                    "screen": "journal.shelf",
                    "platform": "ios",
                    "app_build": "1.0.0",
                    "viewport_class": "compact",
                },
            },
            id_pointer=("public_id",),
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
        # ``habit_id`` is required, so ``{}`` would be a 422; ``null`` (unlink)
        # names no other row, leaving the path's selection as the only object.
        ("PATCH", "/user-practices/{user_practice_id}/habit"): {"habit_id": None},
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


def create_bodies(
    spec: SeedSpec, values: Mapping[str, object]
) -> tuple[dict[str, object] | None, dict[str, object] | None]:
    """Render a create request's body as ``(json, form)``, at most one of them set.

    Args:
        spec: The seed strategy being run.
        values: The seeded ids of this cell plus ``unique``.

    Returns:
        The rendered body in the slot ``spec`` sends it in -- JSON for every
        create but a form an HTML page would post -- and ``None`` in the other.
    """
    body = create_body(spec, values)
    if spec.form_encoded:
        return None, body
    return body, None


def seed_succeeded(spec: SeedSpec, status: int) -> bool:
    """Report whether a create answered the way ``spec`` expects a success to look.

    A 2xx for every spec but one read off a redirect, which must be a 3xx: the
    consent decision answers by sending the browser back to the agent, and a
    2xx there would be a page saying the request stopped.
    """
    if spec.id_source is IdSource.LOCATION:
        return _REDIRECT_FLOOR <= status < _REDIRECT_CEILING
    return _SUCCESS_FLOOR <= status < _REDIRECT_FLOOR


def _json_or_none(text: str) -> object | None:
    """Parse ``text`` as JSON, or return ``None`` for a body that is not."""
    try:
        parsed: object = json.loads(text)
    except json.JSONDecodeError:
        return None
    return parsed


def read_seed_id(spec: SeedSpec, *, text: str, location: str | None) -> str | None:
    """Read the value a create produced, from wherever ``spec`` says it is.

    Args:
        spec: The seed strategy that was run.
        text: The response body as text.
        location: The ``Location`` header, if the response carried one.

    Returns:
        The value as text, or ``None`` when the response does not hold it -- the
        same "unseedable, not fatal" answer :func:`resolve_id` gives.
    """
    if spec.id_source is IdSource.JSON:
        return resolve_id(_json_or_none(text), spec.id_pointer)
    haystack = text if spec.id_source is IdSource.BODY_TEXT else location or ""
    match = re.search(spec.id_pattern, haystack) if spec.id_pattern else None
    return match.group(1) if match else None


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
