"""Read the live OpenAPI render the way a contract fuzzer reads it.

A contract fuzzer does exactly two things with an error response: it looks up
the operation's own declaration for the status it just received, and it
validates the body it received against that declaration. Nothing here does
anything else, so a test written on top of these helpers fails for the same
reason a fuzz run fails and not for a reason of its own invention.

The document always comes from ``app.openapi()`` rather than from the committed
``backend/openapi.json``. That file is a derived artifact whose freshness has
its own gate; reading it here would make one gate depend on the other's health,
and would let a stale export hide a live contract break.

``$ref`` resolution is plain JSON-pointer lookup against the same document,
which is why :func:`response_validator` hands the validator a root schema
carrying ``components`` alongside the operation schema: the refs inside an
operation's response are written relative to the document root, so the root the
validator sees has to be one they resolve in.
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from functools import cache
from typing import Any, Final

from fastapi.routing import APIRoute
from jsonschema import Draft202012Validator
from starlette.routing import BaseRoute

from main import app

JSON_MEDIA_TYPE: Final = "application/json"
DETAIL_KEY: Final = "detail"

_COMPONENT_PREFIX: Final = "#/components/schemas/"
_COMPOSITION_KEYWORDS: Final = ("anyOf", "oneOf", "allOf")
_REF_KEY: Final = "$ref"
_ARRAY_TYPE: Final = "array"


def live_document() -> dict[str, Any]:
    """Return the OpenAPI document the running application renders for itself."""
    return app.openapi()


def operation(document: dict[str, Any], method: str, path: str) -> dict[str, Any]:
    """Return one operation object, failing loudly when the path or verb moved."""
    paths: dict[str, Any] = document["paths"]
    if path not in paths:
        msg = f"{path} is not a declared path"
        raise LookupError(msg)
    verbs: dict[str, Any] = paths[path]
    key = method.lower()
    if key not in verbs:
        msg = f"{method.upper()} {path} is not a declared operation"
        raise LookupError(msg)
    resolved: dict[str, Any] = verbs[key]
    return resolved


def declared_status_codes(document: dict[str, Any], method: str, path: str) -> frozenset[str]:
    """Return every status code the operation publishes, as the document spells them."""
    return frozenset(operation(document, method, path)["responses"])


def declared_response_schema(
    document: dict[str, Any], method: str, path: str, status_code: int
) -> dict[str, Any]:
    """Return the JSON schema the operation declares for ``status_code``."""
    responses: dict[str, Any] = operation(document, method, path)["responses"]
    key = str(status_code)
    if key not in responses:
        msg = f"{method.upper()} {path} declares no {key} response"
        raise LookupError(msg)
    content: dict[str, Any] = responses[key].get("content", {})
    if JSON_MEDIA_TYPE not in content:
        msg = f"{method.upper()} {path} declares a {key} with no {JSON_MEDIA_TYPE} body"
        raise LookupError(msg)
    schema: dict[str, Any] = content[JSON_MEDIA_TYPE]["schema"]
    return schema


def response_validator(document: dict[str, Any], schema: dict[str, Any]) -> Draft202012Validator:
    """Return a validator for ``schema`` whose ``$ref`` targets still resolve."""
    root = {"allOf": [schema], "components": document["components"]}
    return Draft202012Validator(root)


def resolve_ref(document: dict[str, Any], schema: dict[str, Any]) -> dict[str, Any]:
    """Follow a component ``$ref`` to the schema it names, or return ``schema``."""
    current = schema
    while _REF_KEY in current:
        ref: str = current[_REF_KEY]
        if not ref.startswith(_COMPONENT_PREFIX):
            msg = f"unsupported reference: {ref}"
            raise LookupError(msg)
        current = document["components"]["schemas"][ref.removeprefix(_COMPONENT_PREFIX)]
    return current


def _branches(document: dict[str, Any], schema: dict[str, Any]) -> list[dict[str, Any]]:
    """Flatten a schema into itself plus every composition alternative it offers."""
    resolved = resolve_ref(document, schema)
    found = [resolved]
    for keyword in _COMPOSITION_KEYWORDS:
        for member in resolved.get(keyword, ()):
            found.extend(_branches(document, member))
    return found


def detail_entry_forbids_extra_properties(document: dict[str, Any], schema: dict[str, Any]) -> bool:
    """Whether every entry model inside a ``detail`` array closes itself to extra keys.

    ``additionalProperties: false`` is what turns the entry key set from a
    description into a promise: without it the published schema still admits an
    ``input`` alongside the three permitted keys, and a handler that regressed
    into echoing the submitted material would satisfy the document.

    Returns ``False`` when no entry model is found, so a schema that stopped
    declaring one cannot pass by having nothing to check.
    """
    found = False
    for envelope in _branches(document, schema):
        detail = envelope.get("properties", {}).get(DETAIL_KEY)
        if detail is None:
            continue
        for branch in _branches(document, detail):
            if branch.get("type") != _ARRAY_TYPE or "items" not in branch:
                continue
            for entry in _branches(document, branch["items"]):
                if "properties" not in entry:
                    continue
                found = True
                if entry.get("additionalProperties") is not False:
                    return False
    return found


def detail_entry_properties(document: dict[str, Any], schema: dict[str, Any]) -> frozenset[str]:
    """Return the property names of the entry model inside a ``detail`` array.

    The array branch is the one a Pydantic rejection fills, so its item schema is
    the model whose key set decides what a 422 is permitted to hand back.
    """
    names: set[str] = set()
    for envelope in _branches(document, schema):
        detail = envelope.get("properties", {}).get(DETAIL_KEY)
        if detail is None:
            continue
        for branch in _branches(document, detail):
            if branch.get("type") != _ARRAY_TYPE or "items" not in branch:
                continue
            for entry in _branches(document, branch["items"]):
                names.update(entry.get("properties", {}))
    return frozenset(names)


def _walk_routes(routes: Iterable[BaseRoute]) -> Iterator[APIRoute]:
    """Yield every ``APIRoute`` reachable from ``routes``, descending into includes.

    ``app.routes`` does not hold the endpoints directly: an included router
    appears as one wrapper carrying the router it was built from, so the
    endpoints live a level down. Descending through ``original_router`` is what
    keeps this walk honest across that shape; :func:`route_index` then cross-
    checks the result against the document so a walk that stopped finding
    endpoints fails loudly instead of reporting an empty world.
    """
    for route in routes:
        if isinstance(route, APIRoute):
            yield route
            continue
        included = getattr(route, "original_router", None)
        if included is not None:
            yield from _walk_routes(included.routes)


@cache
def route_index() -> dict[tuple[str, str], APIRoute]:
    """Map ``(method, path)`` to the route serving it, for every mounted endpoint."""
    found: dict[tuple[str, str], APIRoute] = {}
    for route in _walk_routes(app.routes):
        for method in route.methods or ():
            found[method.upper(), route.path] = route
    return found


def api_route(method: str, path: str) -> APIRoute:
    """Return the mounted route object behind one declared operation."""
    route = route_index().get((method.upper(), path))
    if route is None:
        msg = f"{method.upper()} {path} is not mounted on the application"
        raise LookupError(msg)
    return route


def dependency_callables(route: APIRoute) -> frozenset[object]:
    """Return every dependency callable the route resolves, at any depth."""
    seen: set[object] = set()
    pending = list(route.dependant.dependencies)
    while pending:
        dependant = pending.pop()
        if dependant.call is not None:
            seen.add(dependant.call)
        pending.extend(dependant.dependencies)
    return frozenset(seen)
