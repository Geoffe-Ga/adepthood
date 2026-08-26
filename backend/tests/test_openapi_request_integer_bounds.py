"""Every integer the request surface accepts must publish a ceiling.

A bare ``int`` on a FastAPI parameter or body field renders into OpenAPI with a
``type: integer`` and nothing else.  JSON-schema validation therefore accepts an
arbitrarily large value, which travels the whole way to a PostgreSQL ``integer``
column before asyncpg refuses it -- and by then the failure is a driver error
raised inside the handler, which the unhandled-exception middleware turns into a
500.  The caller sent a malformed request and was told the server broke.

The test database is SQLite, whose INTEGER is 64-bit, so that overflow cannot be
reproduced anywhere in this suite.  This file therefore checks the *published
contract* rather than a runtime rejection: an integer leaf reachable from a
request position carries a floor and a ceiling, or it is enumerated, or somebody
wrote down why not.  ``tests/routers/test_integer_bounds_reject_out_of_range.py``
pins the shape of the rejection those bounds produce.

The walker is reachability-based on purpose.  A component schema is visited only
by following a ``$ref`` from a request position, so a model used purely in
responses is never inspected, and a model used by both is -- because it is on the
request surface.  Iterating ``components/schemas`` directly would flag every
response model in the application and teach everyone to ignore this test.

The source of truth is the live ``app.openapi()`` render, never the committed
``openapi.json``.  That file is a derived artifact whose freshness is guaranteed
by ``tests/scripts/test_export_openapi.py``; reading it here would make each of
the two gates depend on the other's health.

One blind spot is covered separately.  ``UserPracticeCustomize.mode_config_override``
is a ``dict[str, Any]`` on the wire and is validated out of band through
``ModeConfigAdapter``, so no amount of walking the document reaches it.  The same
pure walker runs over that adapter's own schema below.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, fields, replace
from typing import Final

import pytest

from main import app
from schemas.practice_mode_config import ModeConfigAdapter

_HTTP_METHODS: Final = frozenset(
    {"get", "put", "post", "delete", "options", "head", "patch", "trace"},
)
_COMPOSITION_KEYWORDS: Final = ("anyOf", "oneOf", "allOf")
_COMPONENT_REF_PREFIX: Final = "#/components/schemas/"
_COMPONENT_REF_TEMPLATE: Final = _COMPONENT_REF_PREFIX + "{model}"
_BODY_POSITION: Final = "body"
_JSON_MEDIA_TYPE: Final = "application/json"
_MODE_CONFIG_PATH: Final = "/user-practices/{user_practice_id}/customize"
_MODE_CONFIG_METHOD: Final = "patch"

# Floors, never targets, and each one only ever moves UP.  A walk that inspects
# fewer operations or fewer leaves than the last measurement has stopped looking
# at something, and a walker that has stopped looking reports clean -- which is
# indistinguishable from a surface that is genuinely bounded.  The leaf floor is
# the load-bearing one: a walker that quietly stops resolving ``$ref`` still sees
# every path parameter in the application and would otherwise pass.
#
# Measured against the live render at the time of writing (128 operations, 139
# integer leaves).  Bounding a leaf does not remove it, so these numbers do not
# move when the bounds land; raise them whenever the request surface grows.
MIN_OPERATIONS_INSPECTED: Final = 128
MIN_INTEGER_LEAVES_INSPECTED: Final = 139

# A walk that silently drops a whole request position -- every path parameter, or
# the entire body -- would otherwise report clean for the part it still visits.
REQUIRED_LEAF_POSITIONS: Final = frozenset({"path", "query", _BODY_POSITION})

# A closed vocabulary.  Free text would let every awkward field acquire its own
# bespoke excuse, and the set of excuses is exactly what a reviewer scans.
ALLOWLIST_CATEGORIES: Final = frozenset(
    {"unbounded_by_nature", "external_identifier", "pending_bound"},
)
PENDING_BOUND_CATEGORY: Final = "pending_bound"
_REQUIRED_TEXT_FIELDS: Final = ("method", "path", "location", "category", "reason")


class UnresolvableReferenceError(LookupError):
    """A ``$ref`` on the request surface that names no component.

    Raised rather than skipped.  A walker that shrugs at a reference it cannot
    follow stops inspecting everything behind that reference and still reports
    clean, which is the failure this whole file exists to prevent.
    """


class AllowlistError(Exception):
    """An allow-list entry that cannot be trusted to mean what it says."""


@dataclass(frozen=True)
class BoundsAllowlistEntry:
    """One integer leaf deliberately left unbounded, and the reason why.

    Attributes:
        method: The HTTP verb, exactly as the document spells it.
        path: The templated path, exactly as the document spells it.
        location: The exact dotted leaf path the walker emits, for example
            ``body.application/json.properties.habit_ids.items``.  Requiring the
            exact leaf is what makes an entry rot loudly: rename the field and
            the entry stops matching anything and the build fails.
        category: One of :data:`ALLOWLIST_CATEGORIES`.
        reason: A sentence a reviewer can disagree with.
        tracking_issue: Where the remediation is tracked.  Permitted only on a
            ``pending_bound`` entry, so nothing else can be made to look tracked.
    """

    method: str
    path: str
    location: str
    category: str
    reason: str
    tracking_issue: int | None = None


# Deliberately empty.  An entry here is an integer the application promises to
# accept without a ceiling, which is a claim about the database column behind it.
BOUNDS_ALLOWLIST: Final[tuple[BoundsAllowlistEntry, ...]] = ()


@dataclass(frozen=True)
class Finding:
    """One integer leaf on the request surface that publishes no bound."""

    method: str
    path: str
    location: str
    component: str | None = None

    def describe(self) -> str:
        """Render the finding as one reviewable line."""
        return f"{self.method} {self.path} [{self.component or 'inline'}] {self.location}"


@dataclass(frozen=True)
class WalkResult:
    """Everything one walk of a document observed, findings and volume alike."""

    findings: tuple[Finding, ...]
    leaves_inspected: int
    operations_inspected: int
    leaf_positions: frozenset[str]


@dataclass(frozen=True)
class _Position:
    """Where in one operation's request surface the walker currently stands."""

    method: str
    path: str
    kind: str
    location: str
    component: str | None = None

    def child(self, segment: str) -> _Position:
        """Return this position descended one schema segment."""
        return replace(self, location=f"{self.location}.{segment}")

    def finding(self) -> Finding:
        """Report this position as a non-compliant leaf."""
        return Finding(self.method, self.path, self.location, self.component)


def _has_floor(schema: Mapping[str, object]) -> bool:
    """Whether the leaf publishes a lower bound in either 3.1 spelling."""
    return "minimum" in schema or "exclusiveMinimum" in schema


def _has_ceiling(schema: Mapping[str, object]) -> bool:
    """Whether the leaf publishes an upper bound in either 3.1 spelling.

    Both spellings count.  FastAPI emits OpenAPI 3.1, where Pydantic's ``lt``
    renders as ``exclusiveMaximum`` carrying a number rather than the 3.0
    boolean, and a check that only knew ``maximum`` would call a correctly
    bounded field a violation.
    """
    return "maximum" in schema or "exclusiveMaximum" in schema


def _is_enumerated(schema: Mapping[str, object]) -> bool:
    """Whether the leaf is bounded by enumeration rather than by range.

    An ``IntEnum`` renders as a ``$ref`` to a component carrying ``enum``; a
    pinned literal renders as ``const``.  Either way the accepted set is finite,
    which is the property this file is actually about.
    """
    return "enum" in schema or "const" in schema


def _is_bounded(schema: Mapping[str, object]) -> bool:
    """Whether this integer leaf publishes a finite set of accepted values."""
    return _is_enumerated(schema) or (_has_floor(schema) and _has_ceiling(schema))


def _mapping_at(container: Mapping[str, object], key: str) -> Mapping[str, object]:
    """Return ``container[key]`` when it is a mapping, else an empty one."""
    value = container.get(key)
    return value if isinstance(value, Mapping) else {}


class _RequestSurfaceWalker:
    """Visit every integer leaf reachable from a request position of a document.

    Responses are excluded by construction rather than by name: nothing in this
    class ever reads the ``responses`` key, so a component is inspected only when
    a request position refers to it.
    """

    def __init__(self, document: Mapping[str, object]) -> None:
        self._document = document
        self._components = _mapping_at(_mapping_at(document, "components"), "schemas")
        self._findings: list[Finding] = []
        self._leaves = 0
        self._operations = 0
        self._positions: set[str] = set()

    def run(self) -> WalkResult:
        """Walk every operation in the document and report what was seen."""
        for path, item in _mapping_at(self._document, "paths").items():
            if isinstance(item, Mapping):
                self._walk_path_item(str(path), item)
        return WalkResult(
            findings=tuple(self._findings),
            leaves_inspected=self._leaves,
            operations_inspected=self._operations,
            leaf_positions=frozenset(self._positions),
        )

    def _walk_path_item(self, path: str, item: Mapping[str, object]) -> None:
        """Walk each HTTP operation declared under one path.

        A path item may carry a ``parameters`` array of its own, which the spec
        applies to every operation beneath it.  Those are walked once per
        operation so a shared unbounded parameter is reported against each
        request that actually accepts it, exactly as an inline one would be.
        """
        shared = item.get("parameters")
        for method, operation in item.items():
            if str(method).lower() in _HTTP_METHODS and isinstance(operation, Mapping):
                self._operations += 1
                verb = str(method).lower()
                self._walk_parameters(verb, path, shared)
                self._walk_parameters(verb, path, operation.get("parameters"))
                self._walk_request_body(verb, path, operation)

    def _walk_parameters(self, method: str, path: str, parameters: object) -> None:
        """Walk every declared parameter's schema, whatever position it sits in."""
        if not isinstance(parameters, list):
            return
        for entry in parameters:
            if isinstance(entry, Mapping):
                kind = str(entry.get("in", "unknown"))
                name = str(entry.get("name", "unnamed"))
                start = _Position(method, path, kind, f"{kind}.{name}")
                self._walk_schema(entry.get("schema"), start, frozenset())

    def _walk_request_body(self, method: str, path: str, operation: Mapping[str, object]) -> None:
        """Walk the schema of every media type the operation accepts."""
        content = _mapping_at(_mapping_at(operation, "requestBody"), "content")
        for media_type, media in content.items():
            if isinstance(media, Mapping):
                start = _Position(method, path, _BODY_POSITION, f"{_BODY_POSITION}.{media_type}")
                self._walk_schema(media.get("schema"), start, frozenset())

    def _walk_schema(self, schema: object, position: _Position, seen: frozenset[str]) -> None:
        """Descend one schema node, following references and composites alike."""
        if not isinstance(schema, Mapping):
            return
        reference = schema.get("$ref")
        if isinstance(reference, str):
            self._walk_reference(reference, position, seen)
            return
        self._walk_composites(schema, position, seen)
        self._walk_typed(schema, position, seen)

    def _walk_reference(self, reference: str, position: _Position, seen: frozenset[str]) -> None:
        """Resolve a component reference, stopping on a cycle and never on a miss."""
        name = reference.rpartition("/")[2]
        if name in seen:
            return
        target = self._components.get(name)
        if not isinstance(target, Mapping):
            msg = (
                f"{position.method.upper()} {position.path} at {position.location} "
                f"refers to {reference!r}, which resolves to nothing. Everything "
                f"behind that reference is uninspected."
            )
            raise UnresolvableReferenceError(msg)
        self._walk_schema(target, replace(position, component=name), seen | {name})

    def _walk_composites(
        self, schema: Mapping[str, object], position: _Position, seen: frozenset[str]
    ) -> None:
        """Descend every branch of ``anyOf`` / ``oneOf`` / ``allOf``.

        ``int | None`` renders as ``anyOf: [{type: integer, ...}, {type: null}]``;
        the null branch is simply not an integer leaf, so no special case is
        needed to avoid counting it.
        """
        for keyword in _COMPOSITION_KEYWORDS:
            branches = schema.get(keyword)
            if isinstance(branches, list):
                for index, branch in enumerate(branches):
                    self._walk_schema(branch, position.child(f"{keyword}[{index}]"), seen)

    def _walk_typed(
        self, schema: Mapping[str, object], position: _Position, seen: frozenset[str]
    ) -> None:
        """Dispatch on the node's declared type."""
        kind = schema.get("type")
        if kind == "object":
            self._walk_object(schema, position, seen)
        elif kind == "array":
            self._walk_array(schema, position, seen)
        elif kind == "integer":
            self._record_leaf(schema, position)

    def _walk_object(
        self, schema: Mapping[str, object], position: _Position, seen: frozenset[str]
    ) -> None:
        """Descend every property, and the value schema of a ``dict[str, int]``."""
        for name, sub in _mapping_at(schema, "properties").items():
            self._walk_schema(sub, position.child(f"properties.{name}"), seen)
        additional = schema.get("additionalProperties")
        if isinstance(additional, Mapping):
            self._walk_schema(additional, position.child("additionalProperties"), seen)

    def _walk_array(
        self, schema: Mapping[str, object], position: _Position, seen: frozenset[str]
    ) -> None:
        """Descend the element schema, and each positional element of a tuple."""
        self._walk_schema(schema.get("items"), position.child("items"), seen)
        prefix = schema.get("prefixItems")
        if isinstance(prefix, list):
            for index, item in enumerate(prefix):
                self._walk_schema(item, position.child(f"prefixItems[{index}]"), seen)

    def _record_leaf(self, schema: Mapping[str, object], position: _Position) -> None:
        """Count one integer leaf and report it when it publishes no bound."""
        self._leaves += 1
        self._positions.add(position.kind)
        if not _is_bounded(schema):
            self._findings.append(position.finding())


def walk_request_surface(document: Mapping[str, object]) -> WalkResult:
    """Inspect every integer leaf reachable from a request position of ``document``.

    Args:
        document: An OpenAPI document, or any synthetic mapping shaped like one.

    Returns:
        The findings plus the volume counters the anti-vacuity floors read.

    Raises:
        UnresolvableReferenceError: When a ``$ref`` on the request surface names
            no component.
    """
    return _RequestSurfaceWalker(document).run()


def find_unbounded_integer_leaves(document: Mapping[str, object]) -> tuple[Finding, ...]:
    """Return every integer leaf on ``document``'s request surface lacking a bound."""
    return walk_request_surface(document).findings


def _require_text_fields(entry: BoundsAllowlistEntry, index: int) -> None:
    """Reject a blank justification, which looks reviewed and is not."""
    for field in _REQUIRED_TEXT_FIELDS:
        value: str = getattr(entry, field)
        if not value.strip():
            msg = f"allowlist entry {index}: {field!r} must be a non-empty string"
            raise AllowlistError(msg)


def _require_known_category(entry: BoundsAllowlistEntry, index: int) -> None:
    """Reject a category outside the closed vocabulary a reviewer scans."""
    if entry.category not in ALLOWLIST_CATEGORIES:
        msg = (
            f"allowlist entry {index}: category {entry.category!r} is not one of "
            f"{sorted(ALLOWLIST_CATEGORIES)}"
        )
        raise AllowlistError(msg)


def _require_earned_tracking_issue(entry: BoundsAllowlistEntry, index: int) -> None:
    """Refuse tracked work on any category but the one that means "not yet"."""
    if entry.tracking_issue is not None and entry.category != PENDING_BOUND_CATEGORY:
        msg = (
            f"allowlist entry {index}: only a {PENDING_BOUND_CATEGORY!r} entry may cite "
            f"a tracking issue; {entry.category!r} may not be made to look tracked"
        )
        raise AllowlistError(msg)


def validate_allowlist_entry(entry: BoundsAllowlistEntry, index: int = 0) -> None:
    """Reject an allow-list entry that looks reviewed and is not.

    Args:
        entry: The entry to check.
        index: Its position in the list, for the error message.

    Raises:
        AllowlistError: When a required field is blank, the category is outside
            the closed vocabulary, or a non-pending entry cites tracked work.
    """
    _require_text_fields(entry, index)
    _require_known_category(entry, index)
    _require_earned_tracking_issue(entry, index)


def stale_allowlist_entries(
    allowlist: tuple[BoundsAllowlistEntry, ...], findings: tuple[Finding, ...]
) -> tuple[BoundsAllowlistEntry, ...]:
    """Return the entries excusing a leaf that is no longer non-compliant.

    An entry survives its own subject in two ways: the field acquires a bound, or
    it is renamed and the entry stops describing anything at all.  Both leave a
    written excuse for a problem nobody has, which is how an allow-list stops
    being reviewable.
    """
    live = {(f.method, f.path, f.location) for f in findings}
    return tuple(e for e in allowlist if (e.method, e.path, e.location) not in live)


def unexcused_findings(
    findings: tuple[Finding, ...], allowlist: tuple[BoundsAllowlistEntry, ...]
) -> tuple[Finding, ...]:
    """Return the findings no allow-list entry accounts for."""
    excused = {(e.method, e.path, e.location) for e in allowlist}
    return tuple(f for f in findings if (f.method, f.path, f.location) not in excused)


def _render(findings: tuple[Finding, ...]) -> str:
    """Render findings as one sorted line each, for a failure message."""
    return "\n".join(sorted(f.describe() for f in findings))


def _operation_document(
    operation: Mapping[str, object], components: Mapping[str, object] | None = None
) -> dict[str, object]:
    """Wrap a single synthetic operation as a whole OpenAPI-shaped document."""
    document: dict[str, object] = {"paths": {"/probe": {"post": operation}}}
    if components is not None:
        document["components"] = {"schemas": components}
    return document


def _parameter_document(kind: str, name: str, schema: Mapping[str, object]) -> dict[str, object]:
    """A document whose only request surface is one parameter."""
    return _operation_document({"parameters": [{"in": kind, "name": name, "schema": schema}]})


def _shared_parameter_document(
    kind: str, name: str, schema: Mapping[str, object]
) -> dict[str, object]:
    """A document whose only request surface is one path-item-level parameter.

    The spec lets a path item declare parameters that apply to every operation
    beneath it.  FastAPI emits no such block today, which is precisely why the
    walker has to keep descending into one: the shape is invisible to every
    other assertion in this file.
    """
    parameter = {"in": kind, "name": name, "schema": schema}
    return {"paths": {"/probe": {"parameters": [parameter], "post": {}}}}


def _body_document(
    schema: Mapping[str, object], components: Mapping[str, object] | None = None
) -> dict[str, object]:
    """A document whose only request surface is one JSON body."""
    body = {"requestBody": {"content": {_JSON_MEDIA_TYPE: {"schema": schema}}}}
    return _operation_document(body, components)


def mode_config_document() -> dict[str, object]:
    """Wrap ``ModeConfigAdapter``'s schema as a synthetic single-operation document.

    ``mode_config_override`` crosses the wire as ``dict[str, Any]``, so the walker
    over the application document cannot see inside it.  Re-rendering the adapter
    with the component reference template the walker already understands lets the
    identical pure function inspect it, rather than a second near-copy that could
    drift.
    """
    schema = dict(ModeConfigAdapter.json_schema(ref_template=_COMPONENT_REF_TEMPLATE))
    definitions = schema.pop("$defs", {})
    body = {"requestBody": {"content": {_JSON_MEDIA_TYPE: {"schema": schema}}}}
    return {
        "paths": {_MODE_CONFIG_PATH: {_MODE_CONFIG_METHOD: body}},
        "components": {"schemas": definitions},
    }


_UNBOUNDED_LEAF: Final[Mapping[str, object]] = {"type": "integer"}
_FLOOR_ONLY_LEAF: Final[Mapping[str, object]] = {"type": "integer", "minimum": 1}


@pytest.fixture(scope="module")
def live_document() -> Mapping[str, object]:
    """The application's own OpenAPI render, memoised on the app by FastAPI."""
    return app.openapi()


@pytest.fixture(scope="module")
def live_walk(live_document: Mapping[str, object]) -> WalkResult:
    """One walk of the live request surface, shared by every assertion below."""
    return walk_request_surface(live_document)


def test_every_request_integer_publishes_a_bound(live_walk: WalkResult) -> None:
    """No integer the application accepts may be declared without a ceiling.

    An unbounded leaf is a promise to accept a value the database column behind
    it cannot hold, and the failure mode is a 500 rather than the 422 the caller
    earned.
    """
    unexcused = unexcused_findings(live_walk.findings, BOUNDS_ALLOWLIST)
    assert unexcused == (), (
        f"{len(unexcused)} integer leaves on the request surface publish no "
        f"ceiling (or no floor). Bound each one through ``bounds`` or write it "
        f"into BOUNDS_ALLOWLIST with a reason:\n{_render(unexcused)}"
    )


def test_mode_config_adapter_publishes_a_bound_on_every_integer() -> None:
    """The out-of-band practice config is on the request surface too.

    ``ModeConfigAdapter`` validates ``mode_config_override`` after FastAPI has
    already accepted the body as an opaque mapping, so the document walk cannot
    reach it.  Without this the config's integers get bounded once and regress
    silently the next time a mode is added.
    """
    findings = find_unbounded_integer_leaves(mode_config_document())
    assert findings == (), (
        f"{len(findings)} integer leaves in the practice mode-config union "
        f"publish no ceiling:\n{_render(findings)}"
    )


_REPORTED_CASES: Final = (
    ("path-parameter", _parameter_document("path", "habit_id", _UNBOUNDED_LEAF), "path.habit_id"),
    ("query-parameter", _parameter_document("query", "offset", _FLOOR_ONLY_LEAF), "query.offset"),
    (
        "body-property",
        _body_document({"type": "object", "properties": {"count": _UNBOUNDED_LEAF}}),
        "body.application/json.properties.count",
    ),
    (
        "array-items",
        _body_document(
            {"type": "object", "properties": {"ids": {"type": "array", "items": _UNBOUNDED_LEAF}}}
        ),
        "body.application/json.properties.ids.items",
    ),
    (
        "anyof-nullable-branch",
        _body_document(
            {
                "type": "object",
                "properties": {"maybe": {"anyOf": [_UNBOUNDED_LEAF, {"type": "null"}]}},
            }
        ),
        "body.application/json.properties.maybe.anyOf[0]",
    ),
    (
        "ref-nested",
        _body_document(
            {"$ref": f"{_COMPONENT_REF_PREFIX}Outer"},
            {
                "Outer": {
                    "type": "object",
                    "properties": {"nested": {"$ref": f"{_COMPONENT_REF_PREFIX}Inner"}},
                },
                "Inner": {"type": "object", "properties": {"depth": _UNBOUNDED_LEAF}},
            },
        ),
        "body.application/json.properties.nested.properties.depth",
    ),
    (
        "path-item-level-parameter",
        _shared_parameter_document("path", "habit_id", _UNBOUNDED_LEAF),
        "path.habit_id",
    ),
    (
        "additional-properties",
        _body_document({"type": "object", "additionalProperties": _UNBOUNDED_LEAF}),
        "body.application/json.additionalProperties",
    ),
    (
        "prefix-items",
        _body_document(
            {
                "type": "object",
                "properties": {"pair": {"type": "array", "prefixItems": [_UNBOUNDED_LEAF]}},
            }
        ),
        "body.application/json.properties.pair.prefixItems[0]",
    ),
)


@pytest.mark.parametrize(
    ("document", "expected_location"),
    [(doc, loc) for _, doc, loc in _REPORTED_CASES],
    ids=[name for name, _, _ in _REPORTED_CASES],
)
def test_walker_reports_an_unbounded_leaf_in_every_position(
    document: Mapping[str, object], expected_location: str
) -> None:
    """Each shape an integer can hide in must be reported, at its exact location.

    Pinning the location rather than merely the count is what lets an allow-list
    entry name a specific leaf and rot loudly when that leaf is renamed.
    """
    findings = find_unbounded_integer_leaves(document)
    assert [f.location for f in findings] == [expected_location]


def test_walker_reports_both_shared_and_operation_level_parameters() -> None:
    """An inherited parameter is walked *in addition to* the operation's own.

    A fix that swapped one array for the other would still satisfy the
    single-parameter case above, so both must be reported from one path item.
    """
    document = {
        "paths": {
            "/probe": {
                "parameters": [{"in": "path", "name": "habit_id", "schema": _UNBOUNDED_LEAF}],
                "post": {
                    "parameters": [{"in": "query", "name": "offset", "schema": _UNBOUNDED_LEAF}]
                },
            }
        }
    }
    findings = find_unbounded_integer_leaves(document)
    assert sorted(f.location for f in findings) == ["path.habit_id", "query.offset"]


def test_walker_reports_nothing_on_a_fully_bounded_document() -> None:
    """The inverse twin: a walker that reports everything would pass every test above.

    Covers all four bound spellings plus both enumerated forms, because FastAPI
    emits OpenAPI 3.1 where ``gt`` / ``lt`` become ``exclusiveMinimum`` /
    ``exclusiveMaximum`` carrying a number, and an ``IntEnum`` is bounded by its
    membership rather than by a range.
    """
    document = _body_document(
        {
            "type": "object",
            "properties": {
                "inclusive": {"type": "integer", "minimum": 1, "maximum": 2_147_483_647},
                "exclusive": {"type": "integer", "exclusiveMinimum": 0, "exclusiveMaximum": 11},
                "mixed": {"type": "integer", "minimum": 0, "exclusiveMaximum": 37},
                "enumerated": {"type": "integer", "enum": [1, 2, 3]},
                "pinned": {"type": "integer", "const": 7},
                "nullable": {
                    "anyOf": [
                        {"type": "integer", "minimum": 1, "maximum": 10},
                        {"type": "null"},
                    ]
                },
            },
        }
    )
    assert find_unbounded_integer_leaves(document) == ()


def test_walker_never_enters_responses() -> None:
    """A response model's integers are not on the request surface and must not be flagged.

    The reason the walker resolves references from request positions instead of
    iterating ``components/schemas``: the latter would report every response
    model in the application, and a gate that cries wolf is a gate nobody reads.
    """
    document = _operation_document(
        {
            "parameters": [
                {
                    "in": "path",
                    "name": "id",
                    "schema": {"type": "integer", "minimum": 1, "maximum": 9},
                }
            ],
            "responses": {
                "200": {
                    "content": {
                        _JSON_MEDIA_TYPE: {
                            "schema": {"type": "object", "properties": {"total": _UNBOUNDED_LEAF}}
                        }
                    }
                }
            },
        }
    )
    assert find_unbounded_integer_leaves(document) == ()


def test_walker_reports_a_component_shared_between_request_and_response() -> None:
    """Sharing a model with a response does not take it off the request surface.

    Exclusion is by reachability, not by naming, so a model reached from a body
    is inspected no matter what else refers to it.
    """
    document = _operation_document(
        {
            "requestBody": {
                "content": {
                    _JSON_MEDIA_TYPE: {"schema": {"$ref": f"{_COMPONENT_REF_PREFIX}Shared"}}
                }
            },
            "responses": {
                "200": {
                    "content": {
                        _JSON_MEDIA_TYPE: {"schema": {"$ref": f"{_COMPONENT_REF_PREFIX}Shared"}}
                    }
                }
            },
        },
        {"Shared": {"type": "object", "properties": {"count": _UNBOUNDED_LEAF}}},
    )
    findings = find_unbounded_integer_leaves(document)
    assert [f.location for f in findings] == ["body.application/json.properties.count"]


def test_walker_terminates_on_a_self_referential_component() -> None:
    """A recursive model is walked once, not forever, and its leaf is still reported."""
    document = _body_document(
        {"$ref": f"{_COMPONENT_REF_PREFIX}Node"},
        {
            "Node": {
                "type": "object",
                "properties": {
                    "depth": _UNBOUNDED_LEAF,
                    "child": {"$ref": f"{_COMPONENT_REF_PREFIX}Node"},
                },
            }
        },
    )
    findings = find_unbounded_integer_leaves(document)
    assert [f.location for f in findings] == ["body.application/json.properties.depth"]


def test_unresolvable_reference_is_a_hard_error() -> None:
    """A ``$ref`` that dead-ends must fail the build, never be skipped.

    Stripping ``components`` is the whole-document version of the accident this
    guards: everything behind an unfollowable reference goes uninspected, and a
    walker that shrugs reports the remainder as clean.
    """
    document = _body_document({"$ref": f"{_COMPONENT_REF_PREFIX}Missing"})
    document.pop("components", None)
    with pytest.raises(UnresolvableReferenceError, match="Missing"):
        find_unbounded_integer_leaves(document)


def test_walk_inspects_at_least_the_operations_seen_before(live_walk: WalkResult) -> None:
    """A walk visiting fewer operations than last measured has stopped looking."""
    assert live_walk.operations_inspected >= MIN_OPERATIONS_INSPECTED


def test_walk_inspects_at_least_the_integer_leaves_seen_before(live_walk: WalkResult) -> None:
    """The floor that catches a walker which quietly stopped resolving references.

    Path parameters alone account for well under half the leaves; a walker that
    gave up on ``$ref`` would still find them all and report clean.
    """
    assert live_walk.leaves_inspected >= MIN_INTEGER_LEAVES_INSPECTED


def test_walk_finds_integer_leaves_in_every_request_position(live_walk: WalkResult) -> None:
    """Path, query and body must each contribute at least one inspected leaf.

    A walk that silently dropped a whole position would otherwise pass every
    volume floor on the strength of the positions it still visits.
    """
    assert live_walk.leaf_positions >= REQUIRED_LEAF_POSITIONS


def test_every_allowlist_entry_is_well_formed() -> None:
    """The shipped allow-list must survive its own validator."""
    for index, entry in enumerate(BOUNDS_ALLOWLIST):
        validate_allowlist_entry(entry, index)


_INVALID_ENTRIES: Final = (
    (
        "blank-reason",
        BoundsAllowlistEntry(
            method="get",
            path="/probe",
            location="path.id",
            category="unbounded_by_nature",
            reason="   ",
        ),
    ),
    (
        "blank-location",
        BoundsAllowlistEntry(
            method="get",
            path="/probe",
            location="",
            category="unbounded_by_nature",
            reason="A location nobody can match is an excuse for nothing.",
        ),
    ),
    (
        "invented-category",
        BoundsAllowlistEntry(
            method="get",
            path="/probe",
            location="path.id",
            category="we_will_get_to_it",
            reason="Outside the closed vocabulary a reviewer scans.",
        ),
    ),
    (
        "untracked-category-citing-an-issue",
        BoundsAllowlistEntry(
            method="get",
            path="/probe",
            location="path.id",
            category="external_identifier",
            reason="Only a pending bound may look tracked.",
            tracking_issue=1,
        ),
    ),
)


@pytest.mark.parametrize(
    "entry",
    [entry for _, entry in _INVALID_ENTRIES],
    ids=[name for name, _ in _INVALID_ENTRIES],
)
def test_validator_rejects_an_untrustworthy_entry(entry: BoundsAllowlistEntry) -> None:
    """Each way an entry can look reviewed without being reviewed is a hard error."""
    with pytest.raises(AllowlistError):
        validate_allowlist_entry(entry)


def test_validator_accepts_a_pending_bound_citing_an_issue() -> None:
    """The one category permitted to cite tracked work must actually be permitted."""
    validate_allowlist_entry(
        BoundsAllowlistEntry(
            method="get",
            path="/probe",
            location="path.id",
            category=PENDING_BOUND_CATEGORY,
            reason="Bounded once the column widens; tracked rather than forgotten.",
            tracking_issue=1,
        )
    )


def test_entry_declares_exactly_the_reviewable_fields() -> None:
    """The entry's key set is closed, so a typo cannot become an ignored field.

    A frozen dataclass refuses an invented keyword outright; pinning the field
    names here is the other half, so widening the vocabulary an allow-list entry
    may speak stays a deliberate, reviewed act rather than a drive-by addition.
    """
    assert tuple(f.name for f in fields(BoundsAllowlistEntry)) == (
        *_REQUIRED_TEXT_FIELDS,
        "tracking_issue",
    )


def test_no_allowlist_entry_excuses_a_compliant_leaf(live_walk: WalkResult) -> None:
    """An entry whose leaf got bounded, or renamed, must fail the build.

    Precedence runs this way round on purpose: opting a leaf out stays a
    deliberate act that has to be deliberately undone, rather than an excuse that
    outlives the thing it excused.
    """
    stale = stale_allowlist_entries(BOUNDS_ALLOWLIST, live_walk.findings)
    assert stale == (), (
        "These allow-list entries no longer match a non-compliant leaf -- the "
        "field was bounded or renamed, so delete them:\n"
        + "\n".join(f"{e.method} {e.path} {e.location}" for e in stale)
    )


def test_stale_detection_distinguishes_a_live_entry_from_a_rotted_one() -> None:
    """The anti-rot check must report a rotted entry and spare a live one.

    Driven against synthetic pairs because the shipped allow-list is empty, which
    would make the assertion above hold no matter what the checker did.
    """
    live = BoundsAllowlistEntry(
        method="get",
        path="/probe",
        location="path.id",
        category="unbounded_by_nature",
        reason="Still describes a leaf that is genuinely unbounded.",
    )
    rotted = replace(live, location="path.renamed_id")
    findings = (Finding("get", "/probe", "path.id"),)
    assert stale_allowlist_entries((live, rotted), findings) == (rotted,)


def test_an_excused_finding_does_not_fail_the_gate() -> None:
    """A matching entry removes exactly its own leaf from the failure set."""
    entry = BoundsAllowlistEntry(
        method="get",
        path="/probe",
        location="path.id",
        category="unbounded_by_nature",
        reason="Written down, so it is a decision rather than an oversight.",
    )
    other = Finding("get", "/probe", "query.limit")
    findings = (Finding("get", "/probe", "path.id"), other)
    assert unexcused_findings(findings, (entry,)) == (other,)
