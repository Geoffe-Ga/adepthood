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
_HEADER_LOCATION = "header"
_AUTHORIZATION_HEADER = "authorization"
_PARAMETERS_KEY = "parameters"
_SECURITY_KEY = "security"
_PATHS_KEY = "paths"
_NAME_KEY = "name"
_LOCATION_KEY = "in"


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
    """

    method: str
    path: str
    params: tuple[str, ...]
    requires_auth: bool


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


def _operations(
    path: str,
    item: Mapping[str, object],
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
    specs: list[RouteSpec] = []
    for path, raw_item in _as_mapping(openapi.get(_PATHS_KEY)).items():
        specs.extend(_operations(str(path), _as_mapping(raw_item)))
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
