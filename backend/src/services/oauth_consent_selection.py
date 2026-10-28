"""Narrow the signed OAuth request to the permissions the person chose (#3544)."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import replace
from typing import Final

from services.oauth_authorization import AuthorizationError, AuthorizationRequest

# These are defaults for the controls, never implicit approvals on POST. In
# particular, a browser omits an unchecked checkbox entirely.
DEFAULT_SELECTION: Final = frozenset({"vault:read", "vault:desk"})
GRANT_FIELD_PREFIX: Final = "grant."
GRANT_CHECKED_VALUE: Final = "on"


def _checkbox_values(fields: Mapping[str, str]) -> dict[str, str]:
    """Read only the checkbox controls; ticket and decision are handled by the router."""
    return {
        name.removeprefix(GRANT_FIELD_PREFIX): value
        for name, value in fields.items()
        if name.startswith(GRANT_FIELD_PREFIX)
    }


def selected_request(
    request: AuthorizationRequest, fields: Mapping[str, str]
) -> AuthorizationRequest | AuthorizationError:
    """Keep exactly the checked grants, bounded by the request the server signed.

    Each checkbox has its own name because the OAuth form reader refuses
    repeated parameter names. Unknown, unrequested and malformed choices fail
    closed; an empty selection shares nothing and returns access_denied.
    """
    selected = _checkbox_values(fields)
    if not selected:
        return AuthorizationError.ACCESS_DENIED
    if not selected.keys() <= set(request.scopes) or set(selected.values()) != {
        GRANT_CHECKED_VALUE
    }:
        return AuthorizationError.INVALID_SCOPE
    return replace(request, scopes=tuple(filter(selected.__contains__, request.scopes)))
