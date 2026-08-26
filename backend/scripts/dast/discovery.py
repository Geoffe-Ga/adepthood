"""Read the application's own OpenAPI document and decide which routes carry an object id.

A hand-maintained list of endpoints is the quiet way an authorization check
dies: a router lands, nobody edits the list, and the matrix keeps reporting
clean over a shrinking share of the application. So the only input here is the
document the running app serves, and the only judgement is which operations
address somebody's object by id.

That judgement is deliberately narrow -- a path parameter whose name ends in
``id`` -- and everything it declines is *kept* rather than dropped.
``{slug}``, ``{token}``, and ``{stage_number}`` are still discovered, so the
policy layer can force a written allow-list entry for each instead of letting
them vanish from the count.

A path is not the only place a request names somebody's object. An id posted in
a request body or hung off a query string addresses a row just as directly, and
the two are read here as a *second, parallel* dimension: ``body_id_refs`` and
``query_id_refs`` sit beside ``params`` and never inside it. ``is_object_scoped``
is left reading the path and nothing else, so a route carrying only a body
reference stays out of the path matrix instead of being probed for ids it does
not have.

Reading a body reference costs one indirection the path heuristic does not
need: FastAPI spells every request schema as a ``$ref`` into
``components.schemas``, so the referenced schema has to be resolved before its
properties can be read at all. A reference that will not resolve yields nothing
rather than raising -- the coverage guards can only report "nothing was
discovered" if discovery returns.

Every function in this module is pure: an OpenAPI mapping in, route specs out.
Nothing here opens a socket.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

# The verbs an OpenAPI path item may carry; every other key on a path item
# ("summary", "description", "parameters") is metadata, not an operation.
_OPERATION_METHODS = frozenset(
    {"get", "put", "post", "delete", "options", "head", "patch", "trace"},
)

# ``id``, ``habit_id``, ``user_practice_id`` -- but not ``identity`` or
# ``idea``, which merely contain the letters.
_OBJECT_ID_PARAMETER = re.compile(r"(^|_)id$")

_PATH_LOCATION = "path"
_QUERY_LOCATION = "query"
_HEADER_LOCATION = "header"
_AUTHORIZATION_HEADER = "authorization"
_PARAMETERS_KEY = "parameters"
_SECURITY_KEY = "security"
_PATHS_KEY = "paths"
_NAME_KEY = "name"
_LOCATION_KEY = "in"
_COMPONENTS_KEY = "components"
_SCHEMAS_KEY = "schemas"
_REQUEST_BODY_KEY = "requestBody"
_CONTENT_KEY = "content"
_SCHEMA_KEY = "schema"
_PROPERTIES_KEY = "properties"
_REF_KEY = "$ref"

# The one media type whose properties are readable as named fields. A form or a
# binary upload declares no JSON object to read ids out of.
_JSON_MEDIA_TYPE = "application/json"

# ``#/components/schemas/GoalUpdate`` -- only the trailing name is looked up, so
# a document that spells the pointer differently resolves to nothing rather than
# to the wrong schema.
_REF_SEPARATOR = "/"


@dataclass(frozen=True)
class RouteSpec:
    """One operation of the target application, as the document describes it.

    Attributes:
        method: The upper-cased HTTP verb.
        path: The templated path, braces intact, e.g. ``/habits/{habit_id}``.
        params: The path parameters in declaration order.
        requires_auth: Whether the operation accepts a credential at all.
            Login and the health probes do not, which is how the matrix knows
            not to expect a 401 from them.
        body_id_refs: Request-body properties naming somebody's object by id,
            in declaration order. Empty for an operation with no JSON body.
        query_id_refs: Query parameters naming somebody's object by id, in
            declaration order.
    """

    method: str
    path: str
    params: tuple[str, ...]
    requires_auth: bool
    body_id_refs: tuple[str, ...] = ()
    query_id_refs: tuple[str, ...] = ()


def _as_mapping(value: object) -> Mapping[str, object]:
    """Return ``value`` when it is a mapping, otherwise an empty one.

    A malformed document must produce an empty answer rather than a traceback:
    the minimum-coverage guard is what turns "nothing was discovered" into a
    failure, and it can only do that if discovery returns.
    """
    return value if isinstance(value, Mapping) else {}


def _as_sequence(value: object) -> Sequence[object]:
    """Return ``value`` when it is a non-string sequence, otherwise an empty one."""
    return value if isinstance(value, Sequence) and not isinstance(value, str) else ()


def _merged_parameters(
    item: Mapping[str, object],
    operation: Mapping[str, object],
) -> tuple[Mapping[str, object], ...]:
    """Return the operation's parameters, including those hoisted to the path item.

    OpenAPI lets a path item declare parameters shared by every operation under
    it, which FastAPI does not emit but hand-written and generated documents
    both do. Missing the merge would silently drop the id out of such a route.
    """
    merged = (
        *_as_sequence(item.get(_PARAMETERS_KEY)),
        *_as_sequence(operation.get(_PARAMETERS_KEY)),
    )
    return tuple(_as_mapping(entry) for entry in merged)


def _path_parameters(parameters: Sequence[Mapping[str, object]]) -> tuple[str, ...]:
    """Return the names of the path parameters, in declaration order."""
    return tuple(
        str(parameter[_NAME_KEY])
        for parameter in parameters
        if parameter.get(_LOCATION_KEY) == _PATH_LOCATION and _NAME_KEY in parameter
    )


def _requires_auth(
    item: Mapping[str, object],
    operation: Mapping[str, object],
    parameters: Sequence[Mapping[str, object]],
) -> bool:
    """Report whether the operation takes a credential.

    Two spellings both count: a declared security requirement, and the bare
    ``authorization`` header parameter FastAPI emits for a header-typed
    dependency. This application uses the second, but reading only that would
    make the check brittle the day a router adopts a security scheme.
    """
    if _as_sequence(operation.get(_SECURITY_KEY)) or _as_sequence(item.get(_SECURITY_KEY)):
        return True
    return any(
        parameter.get(_LOCATION_KEY) == _HEADER_LOCATION
        and str(parameter.get(_NAME_KEY, "")).lower() == _AUTHORIZATION_HEADER
        for parameter in parameters
    )


def _query_id_parameters(parameters: Sequence[Mapping[str, object]]) -> tuple[str, ...]:
    """Return the query parameters that name an object by id, in declaration order.

    The same suffix rule the path uses, applied one location over: a listing
    filtered by ``?user_practice_id=`` addresses that row exactly as directly as
    ``/user-practices/{user_practice_id}`` does.
    """
    return tuple(
        str(parameter[_NAME_KEY])
        for parameter in parameters
        if parameter.get(_LOCATION_KEY) == _QUERY_LOCATION
        and _NAME_KEY in parameter
        and _OBJECT_ID_PARAMETER.search(str(parameter[_NAME_KEY]))
    )


def _resolve_schema(
    schema: Mapping[str, object],
    schemas: Mapping[str, object],
) -> Mapping[str, object]:
    """Follow one ``$ref`` into ``components.schemas``, or return the schema as given.

    Args:
        schema: The media type's declared schema, inline or a reference.
        schemas: The document's component schemas.

    Returns:
        The schema whose properties should be read. A pointer nothing resolves
        -- a dangling ``$ref``, a document with no components at all -- yields an
        empty mapping, so the operation is discovered with no body references
        rather than aborting the whole run.
    """
    reference = schema.get(_REF_KEY)
    if not isinstance(reference, str):
        return schema
    return _as_mapping(schemas.get(reference.rsplit(_REF_SEPARATOR, maxsplit=1)[-1]))


def _body_id_properties(
    operation: Mapping[str, object],
    schemas: Mapping[str, object],
) -> tuple[str, ...]:
    """Return the JSON body properties that name an object by id, in declaration order.

    Args:
        operation: One OpenAPI operation object.
        schemas: The document's component schemas, for resolving the ``$ref``
            FastAPI emits for every request model.

    Returns:
        The property names ending in ``id``. An operation with no body, or one
        whose body is not JSON, has none to give.
    """
    content = _as_mapping(_as_mapping(operation.get(_REQUEST_BODY_KEY)).get(_CONTENT_KEY))
    declared = _as_mapping(_as_mapping(content.get(_JSON_MEDIA_TYPE)).get(_SCHEMA_KEY))
    properties = _resolve_schema(declared, schemas).get(_PROPERTIES_KEY)
    return tuple(
        str(name) for name in _as_mapping(properties) if _OBJECT_ID_PARAMETER.search(str(name))
    )


def _operations(
    path: str,
    item: Mapping[str, object],
    schemas: Mapping[str, object],
) -> list[RouteSpec]:
    """Return one route spec per operation declared on a single path item."""
    specs: list[RouteSpec] = []
    for method, raw_operation in item.items():
        if method.lower() not in _OPERATION_METHODS:
            continue
        operation = _as_mapping(raw_operation)
        parameters = _merged_parameters(item, operation)
        specs.append(
            RouteSpec(
                method=method.upper(),
                path=path,
                params=_path_parameters(parameters),
                requires_auth=_requires_auth(item, operation, parameters),
                body_id_refs=_body_id_properties(operation, schemas),
                query_id_refs=_query_id_parameters(parameters),
            ),
        )
    return specs


def discover_routes(openapi: Mapping[str, object]) -> tuple[RouteSpec, ...]:
    """Return every operation the document declares, ordered by path then method.

    Args:
        openapi: A parsed OpenAPI document. A document without a usable
            ``paths`` object yields no routes at all, which the minimum-coverage
            guard then reports as a harness error rather than a clean run.

    Returns:
        The operations in a stable ``(path, method)`` order, so the report is
        diffable and the probe order is reproducible between runs.
    """
    schemas = _as_mapping(_as_mapping(openapi.get(_COMPONENTS_KEY)).get(_SCHEMAS_KEY))
    specs: list[RouteSpec] = []
    for path, raw_item in _as_mapping(openapi.get(_PATHS_KEY)).items():
        specs.extend(_operations(str(path), _as_mapping(raw_item), schemas))
    return tuple(sorted(specs, key=lambda spec: (spec.path, spec.method)))


def is_object_scoped(spec: RouteSpec) -> bool:
    """Report whether the route addresses somebody's object by id in its path.

    Args:
        spec: The route to judge.

    Returns:
        ``True`` when any path parameter is named ``id`` or ends in ``_id``.
        One such parameter is enough: a route mixing a slug with an entry id
        still exposes that entry to whoever guesses the number.
    """
    return any(_OBJECT_ID_PARAMETER.search(param) for param in spec.params)


def carries_reference(spec: RouteSpec) -> bool:
    """Report whether the route names somebody's object by id outside its path.

    Args:
        spec: The route to judge.

    Returns:
        ``True`` when any request-body property or query parameter is named
        ``id`` or ends in ``_id``. This is the reference dimension's counterpart
        to :func:`is_object_scoped`, and the two are deliberately independent:
        a route may carry both, either, or neither, and each dimension probes
        only what it can see.
    """
    return bool(spec.body_id_refs or spec.query_id_refs)
