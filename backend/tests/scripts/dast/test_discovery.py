"""Discovery reads the live OpenAPI document; it never trusts a hand-written route list.

A hard-coded list of endpoints is the quiet way this check dies: a router lands,
nobody edits the list, and the matrix keeps reporting clean over a shrinking
fraction of the app. So the only input is the document the running app serves,
and the tests below pin the two decisions that document drives — which
operations exist, and which of them carry an object reference in the path.

The ``_id`` heuristic is deliberately narrow, and everything it declines is
*kept* rather than dropped. ``{slug}``, ``{token}``, and ``{stage_number}`` are
still discovered as templated routes so the policy layer can force an explicit
allow-list entry for each. Silently skipping them would shrink the matrix
without anybody noticing.

The final test runs against a real ``FastAPI()`` app's own generated document,
so a change in how the framework spells parameters or header dependencies fails
here rather than in production.
"""

from __future__ import annotations

import pytest

from scripts.dast.discovery import (
    RouteSpec,
    carries_reference,
    discover_routes,
    is_object_scoped,
)
from tests.scripts.dast.conftest import (
    LEAKY_WIDGET_DELETE,
    LEAKY_WIDGET_GET,
    REFERENCE_LEAKY_NOTE_POST,
    SAFE_ITEM_GET,
    SAFE_PART_GET,
    SAFE_PART_POST,
    build_leaky_app,
    build_reference_leaky_app,
)

AUTH_HEADER_PARAMETER: dict[str, object] = {
    "name": "authorization",
    "in": "header",
    "required": False,
    "schema": {"anyOf": [{"type": "string"}, {"type": "null"}]},
}


def path_parameter(name: str) -> dict[str, object]:
    """Return an OpenAPI path-parameter object for ``name``."""
    return {"name": name, "in": "path", "required": True, "schema": {"type": "integer"}}


def document(paths: dict[str, object]) -> dict[str, object]:
    """Wrap a ``paths`` mapping in a minimal OpenAPI envelope."""
    return {"openapi": "3.1.0", "info": {"title": "t", "version": "1"}, "paths": paths}


def authenticated_operation(*params: str) -> dict[str, object]:
    """Return an operation that takes a bearer header plus the named path params."""
    return {
        "parameters": [*(path_parameter(name) for name in params), AUTH_HEADER_PARAMETER],
        "responses": {"200": {"description": "ok"}},
    }


def test_an_empty_document_discovers_nothing_rather_than_raising() -> None:
    """A garbled or empty document must produce zero routes, which a guard then catches."""
    assert discover_routes(document({})) == ()


def test_a_missing_paths_key_discovers_nothing() -> None:
    """A document without ``paths`` at all is the same non-answer, not a crash."""
    assert discover_routes({"openapi": "3.1.0"}) == ()


def test_a_parameterless_operation_is_discovered_with_no_params() -> None:
    """Collection routes are still discovered; they simply carry no object reference."""
    routes = discover_routes(document({"/habits/": {"get": authenticated_operation()}}))

    assert routes == (RouteSpec(method="GET", path="/habits/", params=(), requires_auth=True),)
    assert is_object_scoped(routes[0]) is False


def test_a_single_path_parameter_is_captured() -> None:
    """The common shape: one owned object addressed by id."""
    routes = discover_routes(
        document({"/habits/{habit_id}": {"get": authenticated_operation("habit_id")}}),
    )

    assert routes == (
        RouteSpec(
            method="GET",
            path="/habits/{habit_id}",
            params=("habit_id",),
            requires_auth=True,
        ),
    )
    assert is_object_scoped(routes[0]) is True


def test_two_path_parameters_are_captured_in_path_order() -> None:
    """Order matters: each parameter is resolved independently and then substituted."""
    path = "/practice-recipes/{recipe_id}/apply-to/{user_practice_id}"
    routes = discover_routes(
        document({path: {"post": authenticated_operation("recipe_id", "user_practice_id")}}),
    )

    assert routes == (
        RouteSpec(
            method="POST",
            path=path,
            params=("recipe_id", "user_practice_id"),
            requires_auth=True,
        ),
    )
    assert is_object_scoped(routes[0]) is True


@pytest.mark.parametrize("param", ["id", "habit_id", "entry_id", "user_practice_id"])
def test_parameters_ending_in_id_are_object_scoped(param: str) -> None:
    """Automatic inclusion is driven by the parameter name, so it needs no maintenance."""
    spec = RouteSpec(method="GET", path=f"/x/{{{param}}}", params=(param,), requires_auth=True)

    assert is_object_scoped(spec) is True


@pytest.mark.parametrize("param", ["slug", "token", "stage_number", "identity", "idea"])
def test_parameters_that_are_not_ids_are_not_object_scoped(param: str) -> None:
    """``identity`` and ``idea`` merely contain "id"; the heuristic anchors on the suffix."""
    spec = RouteSpec(method="GET", path=f"/x/{{{param}}}", params=(param,), requires_auth=True)

    assert is_object_scoped(spec) is False


def test_a_route_with_one_id_among_other_params_is_object_scoped() -> None:
    """Any object reference in the path is enough to make the route worth probing."""
    spec = RouteSpec(
        method="GET",
        path="/course/{slug}/entries/{entry_id}",
        params=("slug", "entry_id"),
        requires_auth=True,
    )

    assert is_object_scoped(spec) is True


def test_templated_routes_that_are_not_object_scoped_are_still_discovered() -> None:
    """Not-an-id is a reason to demand an allow-list entry, never a reason to drop the route.

    Dropping them would shrink the matrix silently, which is the failure mode
    the allow-list exists to make loud.
    """
    routes = discover_routes(
        document(
            {
                "/course/{slug}": {"get": authenticated_operation("slug")},
                "/invitations/{token}": {"get": authenticated_operation("token")},
            },
        ),
    )

    assert tuple(spec.path for spec in routes) == ("/course/{slug}", "/invitations/{token}")
    assert [is_object_scoped(spec) for spec in routes] == [False, False]


def test_an_operation_without_an_authorization_header_is_unauthenticated() -> None:
    """Login and health are open by design, so the matrix must be able to tell."""
    routes = discover_routes(
        document({"/auth/login": {"post": {"responses": {"200": {"description": "ok"}}}}}),
    )

    assert routes == (RouteSpec(method="POST", path="/auth/login", params=(), requires_auth=False),)


def test_an_operation_level_security_requirement_also_marks_the_route_authenticated() -> None:
    """Some routers declare a security scheme instead of a bare header parameter."""
    routes = discover_routes(
        document(
            {
                "/widgets/{widget_id}": {
                    "get": {
                        "parameters": [path_parameter("widget_id")],
                        "security": [{"HTTPBearer": []}],
                        "responses": {"200": {"description": "ok"}},
                    },
                },
            },
        ),
    )

    assert routes[0].requires_auth is True


def test_parameters_declared_on_the_path_item_are_inherited_by_every_operation() -> None:
    """OpenAPI lets a path item hoist shared parameters; discovery must merge them."""
    routes = discover_routes(
        document(
            {
                "/widgets/{widget_id}": {
                    "parameters": [AUTH_HEADER_PARAMETER],
                    "get": {
                        "parameters": [path_parameter("widget_id")],
                        "responses": {"200": {"description": "ok"}},
                    },
                },
            },
        ),
    )

    assert routes == (
        RouteSpec(
            method="GET",
            path="/widgets/{widget_id}",
            params=("widget_id",),
            requires_auth=True,
        ),
    )


def test_non_operation_keys_in_a_path_item_are_not_mistaken_for_methods() -> None:
    """``summary``, ``description``, and ``parameters`` are metadata, not verbs."""
    routes = discover_routes(
        document(
            {
                "/widgets/{widget_id}": {
                    "summary": "widgets",
                    "description": "a widget",
                    "parameters": [AUTH_HEADER_PARAMETER],
                    "get": authenticated_operation("widget_id"),
                },
            },
        ),
    )

    assert tuple(spec.method for spec in routes) == ("GET",)


def test_routes_are_returned_in_a_stable_path_then_method_order() -> None:
    """Deterministic ordering keeps the report diffable and the probe order predictable."""
    routes = discover_routes(
        document(
            {
                "/widgets/{widget_id}": {
                    "put": authenticated_operation("widget_id"),
                    "get": authenticated_operation("widget_id"),
                    "delete": authenticated_operation("widget_id"),
                },
                "/safeitems/{item_id}": {"get": authenticated_operation("item_id")},
            },
        ),
    )

    assert tuple((spec.method, spec.path) for spec in routes) == (
        ("GET", "/safeitems/{item_id}"),
        ("DELETE", "/widgets/{widget_id}"),
        ("GET", "/widgets/{widget_id}"),
        ("PUT", "/widgets/{widget_id}"),
    )


def test_discovery_reads_a_real_fastapi_generated_document() -> None:
    """The genuine article: FastAPI's own ``/openapi.json`` output, not a guess.

    Building the matrix on a hand-written document would let a framework change
    in how parameters or header dependencies are spelled slip through unnoticed.
    """
    deployment = build_leaky_app()

    routes = discover_routes(deployment.app.openapi())
    object_scoped = {(spec.method, spec.path) for spec in routes if is_object_scoped(spec)}

    assert object_scoped == {
        LEAKY_WIDGET_GET,
        LEAKY_WIDGET_DELETE,
        SAFE_ITEM_GET,
        SAFE_PART_GET,
        SAFE_PART_POST,
    }
    assert all(spec.requires_auth for spec in routes if is_object_scoped(spec))
    login = next(spec for spec in routes if spec.path == "/auth/login")
    assert login.requires_auth is False


# --- Object references carried in a request body or a query parameter --------
#
# The path heuristic above sees only ``/goals/{goal_id}``. An id posted in a
# body or hung off a query string addresses somebody's object just as directly,
# so discovery reads those too -- as a separate dimension, leaving
# ``is_object_scoped`` exactly as it was.

GOAL_UPDATE_SCHEMA: dict[str, object] = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "goal_group_id": {"anyOf": [{"type": "integer"}, {"type": "null"}]},
        "identity": {"type": "string"},
        "idea": {"type": "string"},
    },
}

JOURNAL_CREATE_SCHEMA: dict[str, object] = {
    "type": "object",
    "properties": {
        "message": {"type": "string"},
        "practice_session_id": {"anyOf": [{"type": "integer"}, {"type": "null"}]},
        "user_practice_id": {"anyOf": [{"type": "integer"}, {"type": "null"}]},
    },
}


def query_parameter(name: str) -> dict[str, object]:
    """Return an OpenAPI query-parameter object for ``name``."""
    return {"name": name, "in": "query", "required": False, "schema": {"type": "integer"}}


def json_request_body(schema_name: str) -> dict[str, object]:
    """Return a ``requestBody`` whose JSON schema is a reference to ``schema_name``."""
    return {
        "required": True,
        "content": {
            "application/json": {"schema": {"$ref": f"#/components/schemas/{schema_name}"}},
        },
    }


def document_with_schemas(
    paths: dict[str, object],
    schemas: dict[str, object],
) -> dict[str, object]:
    """Wrap ``paths`` and ``components.schemas`` in a minimal OpenAPI envelope."""
    envelope = document(paths)
    envelope["components"] = {"schemas": schemas}
    return envelope


def body_operation(schema_name: str, *params: str) -> dict[str, object]:
    """Return an authenticated operation that posts ``schema_name`` as its body."""
    operation = authenticated_operation(*params)
    operation["requestBody"] = json_request_body(schema_name)
    return operation


def test_a_request_body_property_ending_in_id_is_discovered_as_a_body_reference() -> None:
    """A ``$ref`` body has to be resolved against ``components.schemas`` to be read at all."""
    routes = discover_routes(
        document_with_schemas(
            {"/goals/{goal_id}": {"put": body_operation("GoalUpdate", "goal_id")}},
            {"GoalUpdate": GOAL_UPDATE_SCHEMA},
        ),
    )

    assert routes[0].body_id_refs == ("goal_group_id",)
    assert routes[0].query_id_refs == ()


def test_body_properties_that_merely_contain_the_letters_are_not_references() -> None:
    """``identity`` and ``idea`` are ordinary fields; the heuristic anchors on the suffix."""
    routes = discover_routes(
        document_with_schemas(
            {"/goals/{goal_id}": {"put": body_operation("GoalUpdate", "goal_id")}},
            {"GoalUpdate": GOAL_UPDATE_SCHEMA},
        ),
    )

    assert "identity" not in routes[0].body_id_refs
    assert "idea" not in routes[0].body_id_refs


def test_several_body_references_are_captured_in_declaration_order() -> None:
    """One operation may address two foreign objects, and each is probed separately."""
    routes = discover_routes(
        document_with_schemas(
            {"/journal/": {"post": body_operation("JournalMessageCreate")}},
            {"JournalMessageCreate": JOURNAL_CREATE_SCHEMA},
        ),
    )

    assert routes[0].body_id_refs == ("practice_session_id", "user_practice_id")


def test_a_query_parameter_ending_in_id_is_discovered_as_a_query_reference() -> None:
    """A listing filtered by somebody else's id is an object reference in a query string."""
    routes = discover_routes(
        document(
            {
                "/practice-sessions/": {
                    "get": {
                        "parameters": [
                            query_parameter("user_practice_id"),
                            query_parameter("stage_number"),
                            AUTH_HEADER_PARAMETER,
                        ],
                        "responses": {"200": {"description": "ok"}},
                    },
                },
            },
        ),
    )

    assert routes[0].query_id_refs == ("user_practice_id",)
    assert routes[0].body_id_refs == ()


def test_a_path_parameter_is_never_counted_as_a_query_reference() -> None:
    """The two dimensions stay disjoint, so neither count can inflate the other."""
    routes = discover_routes(
        document({"/habits/{habit_id}": {"get": authenticated_operation("habit_id")}}),
    )

    assert routes[0].params == ("habit_id",)
    assert routes[0].query_id_refs == ()
    assert routes[0].body_id_refs == ()


def test_a_request_body_whose_schema_cannot_be_resolved_yields_no_references() -> None:
    """A dangling ``$ref`` must produce an empty answer, which a guard then catches.

    Raising here would abort the whole run on one malformed document, and the
    minimum-coverage guard can only report "nothing was discovered" if discovery
    returns at all.
    """
    routes = discover_routes(
        document_with_schemas(
            {"/goals/{goal_id}": {"put": body_operation("MissingSchema", "goal_id")}},
            {"GoalUpdate": GOAL_UPDATE_SCHEMA},
        ),
    )

    assert routes[0].body_id_refs == ()


def test_a_document_with_no_components_at_all_yields_no_body_references() -> None:
    """The same non-answer when the whole ``components`` object is absent."""
    routes = discover_routes(
        document({"/goals/{goal_id}": {"put": body_operation("GoalUpdate", "goal_id")}}),
    )

    assert routes[0].body_id_refs == ()


def test_a_request_body_that_is_not_json_yields_no_body_references() -> None:
    """A form or binary upload declares no JSON properties to read."""
    routes = discover_routes(
        document(
            {
                "/uploads/": {
                    "post": {
                        "parameters": [AUTH_HEADER_PARAMETER],
                        "requestBody": {"content": {"application/octet-stream": {}}},
                        "responses": {"200": {"description": "ok"}},
                    },
                },
            },
        ),
    )

    assert routes[0].body_id_refs == ()


def test_carries_reference_is_true_for_a_body_reference_and_false_without_one() -> None:
    """The predicate the reference dimension is driven by, asserted both ways."""
    with_body = RouteSpec(
        method="POST",
        path="/journal/",
        params=(),
        requires_auth=True,
        body_id_refs=("practice_session_id",),
    )
    without = RouteSpec(method="POST", path="/journal/", params=(), requires_auth=True)

    assert carries_reference(with_body) is True
    assert carries_reference(without) is False


def test_carries_reference_is_true_for_a_query_reference() -> None:
    """A filtered listing is a reference even though it mutates nothing."""
    spec = RouteSpec(
        method="GET",
        path="/journal/",
        params=(),
        requires_auth=True,
        query_id_refs=("practice_session_id",),
    )

    assert carries_reference(spec) is True


def test_the_path_dimension_is_unchanged_by_the_reference_dimension() -> None:
    """``is_object_scoped`` still reads the path and nothing else.

    A route carrying a body reference and no path id must stay out of the path
    matrix entirely, or the two dimensions would double-count each other.
    """
    body_only = RouteSpec(
        method="POST",
        path="/journal/",
        params=(),
        requires_auth=True,
        body_id_refs=("practice_session_id",),
    )
    path_only = RouteSpec(
        method="GET",
        path="/habits/{habit_id}",
        params=("habit_id",),
        requires_auth=True,
    )

    assert is_object_scoped(body_only) is False
    assert carries_reference(body_only) is True
    assert is_object_scoped(path_only) is True
    assert carries_reference(path_only) is False


def test_discovery_reads_body_references_out_of_a_real_fastapi_document() -> None:
    """FastAPI spells a body schema as a ``$ref``, so the resolution runs for real here.

    A hand-written document could not prove that: the whole reason the
    ``components.schemas`` lookup exists is the shape the framework emits.
    """
    deployment = build_reference_leaky_app()

    routes = discover_routes(deployment.app.openapi())
    referencing = {
        (spec.method, spec.path): spec.body_id_refs
        for spec in routes
        if carries_reference(spec) and spec.body_id_refs
    }

    assert referencing[REFERENCE_LEAKY_NOTE_POST] == ("gadget_id",)
