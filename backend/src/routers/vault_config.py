"""Endpoints for connecting, inspecting and removing a user's own Creek Vault.

Three verbs against one resource that always exists in the abstract and
sometimes exists as a row: ``GET`` reports whether this account has connected a
vault and where it points, ``PUT`` sets or replaces the connection, ``DELETE``
removes it. The caller is resolved from their JWT, so no account identifier is
accepted from a path or a body and no request can name a row that is not the
caller's own.

The credential travels in one direction only. It arrives on the ``PUT`` body and
is never carried on any response, which is a property of
:mod:`schemas.vault_config` -- no response schema in that module has a field to
put one in -- rather than of anything this module remembers to omit.

The URL is judged twice, by two rule sets, and the second one exists because
sharing the first was not safe on every axis.

:func:`~services.creek_vault_url.classify_vault_url` runs first, and reusing it
is what makes the refusal here mean something on the axis it covers: a URL this
endpoint accepted under looser shape rules than the request path applies would
leave a user told their vault was connected when it was not. That much of the
reuse is sound and stays.

What it cannot decide is *where the URL points*, and on that axis the shared
judgement is not merely silent but actively wrong for this input. It exempts
loopback, deliberately, because the value it was written for is the operator's
deployment-wide ``CREEK_VAULT_URL`` -- set by whoever owns the machine, who can
already reach every host it could name. The value here arrived in a request
body from somebody who owns none of that, and the URL it names is dialled by
this server on every journal save with a bearer credential attached. One
caller's safe default is this caller's open door, so
:mod:`services.creek_vault_url_user` and
:mod:`services.creek_vault_url_resolution` run *on top*, for this value only.
Narrowing the shared rules instead would break every operator's local vault.

The credential is judged last and by this module rather than by the request
schema, for a reason of the same kind: a schema refusal is a
``RequestValidationError``, and those carry the rejected value back to the
caller. See :func:`~schemas.vault_config.credential_is_usable`.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_session
from error_responses import build_router
from errors import unprocessable
from models.user_vault_config import UserVaultConfig
from routers.auth import get_current_user
from schemas.vault_config import (
    VaultConnectionRequest,
    VaultConnectionResponse,
    credential_is_usable,
)
from services.creek_vault_url import classify_vault_url
from services.creek_vault_url_resolution import (
    classify_resolved_user_vault_url_off_the_pool,
)
from services.creek_vault_url_user import classify_user_vault_url_host, vault_url_host
from services.user_vault_config import clear_vault_config, load_vault_config, store_vault_config

router = build_router(prefix="/vault", tags=["vault"])

# The refusal a caller sees for a URL this seam cannot use, prefixed so it reads
# as a code rather than as prose, and suffixed with the classifier's own defect
# name so the four kinds stay distinguishable to a client. The classifier's
# value-free ``detail`` is deliberately not appended: for three of the four
# defects it is a component name, but for the fourth it quotes the scheme and
# host, and a refusal body is a place a client may log.
_URL_REFUSED_PREFIX = "vault_url_"

# The refusal a caller sees for a credential no ``Authorization`` header could
# carry. A code this endpoint owns rather than a validator's prose, because the
# prose that used to carry this refusal arrived with the submitted value
# attached -- and this is the one field on this request that is a secret.
_KEY_REFUSED = "vault_key_unusable"


async def _refuse_a_url_this_endpoint_must_not_store(session: AsyncSession, url: str) -> None:
    """Raise a 422 naming the first rule ``url`` fails, or return having found none.

    The order is load-bearing rather than incidental. The shared classifier runs
    first because it is the one that can find userinfo, and userinfo is itself a
    credential: ``urlsplit`` puts it in the *scheme* slot when the ``//`` is
    missing, so no finding may quote or even judge a host until the parse it came
    from is known to hold no secret. A URL carrying userinfo in front of a
    private address is two defects at once and must report the credential rather
    than the destination.

    Then the destination, cheapest question first: an address literal is decided
    from the string and costs nothing, and only a name that survived that is
    worth a lookup. The lookup is last because it is the only part that touches
    the network.

    The classifier's ``detail`` is deliberately not appended to any of these
    codes. A refusal body is a place a client may log, and one of the shared
    wordings quotes a scheme and a host.

    ``session`` is taken only to be given up. The lookup is the one step here
    that waits on somebody else's machine, and by the time this function runs the
    authentication dependency has already opened a transaction on this session --
    so a lookup issued as-is would rent a pooled connection for the length of a
    DNS round trip. See
    :func:`~services.creek_vault_url_resolution.classify_resolved_user_vault_url_off_the_pool`,
    which is the only spelling of the lookup this module can reach.

    Nothing above the lookup pays for that. A URL refused on its shape, or on a
    literal address, is refused before the seam is reached and the transaction is
    left exactly as it was found.
    """
    shape = classify_vault_url(url)
    if shape is not None:
        raise unprocessable(f"{_URL_REFUSED_PREFIX}{shape.defect.value}")
    host = vault_url_host(url)
    destination = classify_user_vault_url_host(host)
    if destination is None:
        destination = await classify_resolved_user_vault_url_off_the_pool(session, host)
    if destination is not None:
        raise unprocessable(f"{_URL_REFUSED_PREFIX}{destination.defect.value}")


def _to_response(config: UserVaultConfig | None) -> VaultConnectionResponse:
    """Project a stored row, or its absence, onto the response DTO.

    A fresh instance every time, including for the "nothing connected" answer.
    A module-level singleton would read as the cheaper spelling of the same
    thing and is not: pydantic models are mutable, so one shared instance is a
    value every request holds a reference to.
    """
    if config is None:
        return VaultConnectionResponse(connected=False, vault_url=None)
    return VaultConnectionResponse(connected=True, vault_url=config.vault_url)


@router.get("/connection", response_model=VaultConnectionResponse)
async def get_vault_connection(
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> VaultConnectionResponse:
    """Report whether this account has connected a vault, and where it points.

    Never a 404 for an account that has connected nothing: "you have no vault"
    is an answer about a resource that exists conceptually for every account,
    not a missing resource, and answering it plainly is what lets a client
    render the connect affordance without first handling an error.
    """
    return _to_response(await load_vault_config(session, user_id))


@router.put("/connection", response_model=VaultConnectionResponse)
async def put_vault_connection(
    payload: VaultConnectionRequest,
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> VaultConnectionResponse:
    """Set or replace this account's vault connection, refusing a URL it cannot use.

    The URL is judged before anything is written, so a refused connection leaves
    no row behind and the account keeps whatever it had -- a half-applied
    replacement would pair a new URL with an old credential and send one vault's
    secret to another.

    ``PUT`` rather than ``POST`` because the resource is singular and the
    operation is idempotent: an account has at most one vault, and sending the
    same body twice leaves the same one connection.

    The URL is checked before the credential, so a request carrying both a bad
    destination and an unusable key is answered about the destination. That is
    the order the two cost: a URL naming private space is an attempt on this
    deployment's network, and a malformed key is a paste that went wrong.
    """
    await _refuse_a_url_this_endpoint_must_not_store(session, payload.vault_url)
    if not credential_is_usable(payload.api_key):
        raise unprocessable(_KEY_REFUSED)
    config = await store_vault_config(
        session, user_id, vault_url=payload.vault_url, api_key=payload.api_key
    )
    return _to_response(config)


@router.delete("/connection", status_code=status.HTTP_204_NO_CONTENT)
async def delete_vault_connection(
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> Response:
    """Remove this account's vault connection, credential included.

    Idempotent, and 204 either way: an account that had no connection ends up in
    the state it asked for, so reporting a 404 would describe the plumbing
    rather than the outcome.
    """
    await clear_vault_config(session, user_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
