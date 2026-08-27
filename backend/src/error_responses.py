"""The error contract every router publishes, declared in one place.

A fuzzer -- and any generated client -- reads an operation's ``responses``
block and believes it. Two thirds of this API's fuzzable operations used to
answer with a status they never declared, and the 422 was declared outright
wrongly: FastAPI generates ``HTTPValidationError``, whose ``detail`` is an
array, while a domain refusal raised through :func:`errors.unprocessable` puts
a plain snake_case string there.

The correction runs one way only. **The wire does not change.** Every refusal
body this module describes is one the application already sends, byte for byte;
what changes is that the document now admits them. Array-ising the 422 to match
the paper would break clients that already switch on the string code.

Three pieces, in the order they matter:

* :class:`ValidationEntry` -- the sanitised Pydantic rejection entry, with
  ``extra="forbid"`` so the published schema *forbids* the disclosing keys;
* :data:`COMMON_ERROR_RESPONSES` -- the six statuses any operation on this API
  can answer with, whoever wrote it;
* :func:`build_router` -- the factory every router module goes through, so the
  contract is the default rather than something each author remembers.

The common six are uniform rather than derived from what a router imports,
because the mechanism that sends them is usually not the router's: 400 is the
framework's own body-parse refusal on any operation taking a body, 401 comes
from the auth dependency, and 429 from the global limiter -- those three are
reachable everywhere. 403 and 404 come from ``dependencies.ownership`` and from
admin checks, which is most operations but not literally all: a handful that
resolve no object and check no role cannot answer either, and declare them
anyway rather than making every author judge the question. That is a deliberate
over-declaration, and the one place this module trades precision for a contract
nobody has to remember. It costs nothing at the gate -- the fuzzer flags a
status that was *sent* and not declared, never one declared and not sent -- but
it does mean 403 and 404 carry no signal there.

Seven router modules import no refusal helper whatsoever and still answer 400
and 404 live, which is why deriving the set per module was rejected.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from enum import Enum
from typing import Any, Final

from fastapi import APIRouter, status
from pydantic import BaseModel, ConfigDict

# One response object as FastAPI's ``responses=`` takes it, keyed by status.
ResponseDeclarations = dict[int | str, dict[str, Any]]


class ValidationEntry(BaseModel):
    """One rejected field, carrying the three keys a sanitised 422 keeps.

    ``type``, ``loc`` and ``msg`` are the whole of the redaction that
    ``errors._VALIDATION_ENTRY_KEYS`` performs. What is deliberately absent is
    ``input`` -- a verbatim copy of the material that failed validation, which
    for a missing required field is the entire request body, credentials
    included -- and ``ctx``, which restates the violated bound and sometimes
    embeds the offending value a second time.

    ``extra="forbid"`` is load-bearing, not tidiness: it publishes
    ``additionalProperties: false``, so the document itself says an entry
    carrying ``input`` is out of contract. That turns the contract fuzz into a
    live regression guard on the redaction, rather than a check that merely
    tolerates it.
    """

    model_config = ConfigDict(extra="forbid")

    type: str
    loc: list[str | int]
    msg: str


class ValidationErrorResponse(BaseModel):
    """A 422 body, in either of the two shapes this API genuinely sends.

    A Pydantic rejection sends the array of :class:`ValidationEntry`; a domain
    refusal raised after the schema passed -- ``invalid_scope``,
    ``vault_url_malformed`` -- sends one snake_case string. Both occur on the
    *same* operation, so the declaration admits both. Narrowing it to either
    half would leave the other half of the traffic undocumented.
    """

    detail: list[ValidationEntry] | str


class RefusalResponse(BaseModel):
    """A refusal body: one snake_case code a client can switch on.

    The shape of every non-422 error this application sends, from the
    framework's own ``There was an error parsing the body`` through the
    ownership helpers' ``habit_not_found`` to the limiter's throttle.
    """

    detail: str


# What each refusal means, for the reader of the published document. Written
# out rather than left to FastAPI's fallback (the bare HTTP reason phrase),
# because the interesting part is which of this application's own mechanisms
# produces the status, not what the RFC calls it.
_REFUSAL_DESCRIPTIONS: Final[dict[int, str]] = {
    status.HTTP_400_BAD_REQUEST: (
        "The request body could not be parsed, or a value it carried was refused."
    ),
    status.HTTP_401_UNAUTHORIZED: "No usable credential was presented.",
    status.HTTP_402_PAYMENT_REQUIRED: "The account has no credit left for this operation.",
    status.HTTP_403_FORBIDDEN: "The caller is authenticated but does not own the resource.",
    status.HTTP_404_NOT_FOUND: "No such resource -- or none this caller is allowed to see.",
    status.HTTP_409_CONFLICT: "The request conflicts with the resource's current state.",
    status.HTTP_410_GONE: "The resource resolved but has been spent or withdrawn.",
    status.HTTP_413_CONTENT_TOO_LARGE: "The request body is past a declared ceiling.",
    status.HTTP_429_TOO_MANY_REQUESTS: "The caller went past a rate limit.",
    status.HTTP_502_BAD_GATEWAY: "An upstream dependency this route relies on failed.",
    status.HTTP_503_SERVICE_UNAVAILABLE: "A required dependency is temporarily unusable.",
}

_VALIDATION_DESCRIPTION: Final = (
    "The request failed validation -- an array of rejected fields -- or a check "
    "applied after the schema refused it, as one snake_case code."
)


def refusal_responses(statuses: Iterable[int]) -> ResponseDeclarations:
    """Declare a :class:`RefusalResponse` body for each status in ``statuses``."""
    return {
        code: {"model": RefusalResponse, "description": _REFUSAL_DESCRIPTIONS[code]}
        for code in statuses
    }


# The statuses any operation on this API can answer with, regardless of what
# its own module imports. 400 is the framework's body-parse refusal, 401 the
# auth dependency's, 403 and 404 the ownership helpers', 429 the global
# limiter's -- none of them is a line of code in the router that answers them.
_UNIVERSAL_REFUSAL_STATUSES: Final = (
    status.HTTP_400_BAD_REQUEST,
    status.HTTP_401_UNAUTHORIZED,
    status.HTTP_403_FORBIDDEN,
    status.HTTP_404_NOT_FOUND,
    status.HTTP_429_TOO_MANY_REQUESTS,
)

# Supplying a 422 here replaces the ``HTTPValidationError`` FastAPI would
# otherwise generate, which is what corrects the array-only declaration for
# every operation at once.
COMMON_ERROR_RESPONSES: Final[ResponseDeclarations] = {
    **refusal_responses(_UNIVERSAL_REFUSAL_STATUSES),
    status.HTTP_422_UNPROCESSABLE_CONTENT: {
        "model": ValidationErrorResponse,
        "description": _VALIDATION_DESCRIPTION,
    },
}


def build_router(
    *,
    tags: Sequence[str],
    prefix: str = "",
    extra_statuses: Iterable[int] = (),
) -> APIRouter:
    """Return a router whose every operation inherits the common error contract.

    Args:
        tags: OpenAPI tags for the router's operations.
        prefix: Path prefix, or empty for a router that mounts at the root.
        extra_statuses: Refusals this router can send beyond the common six,
            whether from an ``errors`` helper it imports or from a dependency
            or service it calls. Each is declared with the same string-detail
            body, which is what every one of them sends.

    Returns:
        An ``APIRouter`` carrying the merged declarations. Router-level
        ``responses`` propagate to every operation and merge with anything a
        route declares for itself, so a route stays free to add its own.
    """
    declared_tags: list[str | Enum] = list(tags)
    return APIRouter(
        prefix=prefix,
        tags=declared_tags,
        responses={**COMMON_ERROR_RESPONSES, **refusal_responses(extra_statuses)},
    )
