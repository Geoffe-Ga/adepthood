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

The URL is judged by :func:`~services.creek_vault_url.classify_vault_url`,
which is the same judgement :func:`~services.creek_vault_client.build_creek_vault_client`
already applies to the deployment-wide variable. Reusing it is what makes the
refusal here mean something: a second set of rules written for this endpoint
could accept a URL the request path would then quietly degrade, and the user
would have been told their vault was connected when it was not.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_session
from errors import unprocessable
from models.user_vault_config import UserVaultConfig
from routers.auth import get_current_user
from schemas.vault_config import VaultConnectionRequest, VaultConnectionResponse
from services.creek_vault_url import classify_vault_url
from services.user_vault_config import clear_vault_config, load_vault_config, store_vault_config

router = APIRouter(prefix="/vault", tags=["vault"])

# The refusal a caller sees for a URL this seam cannot use, prefixed so it reads
# as a code rather than as prose, and suffixed with the classifier's own defect
# name so the four kinds stay distinguishable to a client. The classifier's
# value-free ``detail`` is deliberately not appended: for three of the four
# defects it is a component name, but for the fourth it quotes the scheme and
# host, and a refusal body is a place a client may log.
_URL_REFUSED_PREFIX = "vault_url_"


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
    """
    finding = classify_vault_url(payload.vault_url)
    if finding is not None:
        raise unprocessable(f"{_URL_REFUSED_PREFIX}{finding.defect.value}")
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
