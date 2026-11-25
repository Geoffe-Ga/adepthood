"""``GET /vault/pipeline``: the "Your vault" dashboard's one read (#3775).

Did my files land, what has Creek run over them, and which parts of the vault
hold something: the account's own upload receipts and stage runs, and Creek's
``GET /v1/pipeline/status`` re-projected (see
:mod:`services.vault_pipeline_dashboard`), with whole-corpus totals (#3795): the
account's receipts by outcome, and Creek's count of documents per stage.

Owner-only and read-only. The account is the caller's own, from their bearer
token, and the vault dialled is the one resolved for that account like every
other vault read. The one id a request may carry is ``before``, a cursor into
the caller's *own* receipts: it is only ever compared against rows already
filtered to the caller, so another account's receipt id names nothing here.
Nothing is started and nothing is written.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from bounds import INT32_MAX, MIN_ROW_ID
from database import get_session
from dependencies.creek_vault import get_creek_vault_client
from domain.creek_vault import CreekVaultPipelineClient
from error_responses import build_router
from routers.auth import get_current_user
from schemas.vault_pipeline import VaultPipelineResponse
from services.vault_pipeline_dashboard import (
    RECEIPT_PAGE_MAX,
    RECEIPT_PAGE_MIN,
    ReceiptPage,
    read_vault_pipeline,
)

router = build_router(prefix="/vault", tags=["vault"])


@router.get("/pipeline", response_model=VaultPipelineResponse)
async def read_vault_pipeline_status(
    user_id: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    vault: Annotated[CreekVaultPipelineClient, Depends(get_creek_vault_client)],
    limit: Annotated[int, Query(ge=RECEIPT_PAGE_MIN, le=RECEIPT_PAGE_MAX)] = RECEIPT_PAGE_MAX,
    before: Annotated[int | None, Query(ge=MIN_ROW_ID, le=INT32_MAX)] = None,
) -> VaultPipelineResponse:
    """This account's upload receipts, its stage runs, and its vault's own status.

    Always a ``200``: a vault that is absent, out, or too old to answer leaves
    ``vault`` ``null`` and says which in ``vault_status`` (``vault_unreachable``
    is the outage case), so the dashboard renders a sentence, never an error.
    """
    return await read_vault_pipeline(
        session, user_id, vault, ReceiptPage(limit=limit, before=before)
    )
