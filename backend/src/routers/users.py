"""User profile endpoints.

``PUT /users/me/timezone`` lets a user correct the IANA timezone stored at
signup (issue #261) — needed when they travel, immigrate, or signed up on a
device whose clock / zone was wrong. Without it, streak and daily-completion
math would use the original zone forever, re-introducing the off-by-one
boundary bug PR #260 closed.

``DELETE /users/me`` is the in-app account-deletion path. Apple App Store
Review 5.1.1(v) requires one of any app that creates accounts, and GDPR
Art. 17 requires that it erase rather than deactivate. What it reaches, what
survives anonymised, and why, is declared once in
:mod:`domain.account_deletion` and executed by :mod:`services.account_deletion`.
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_session
from dependencies.auth import get_current_user_model
from error_responses import build_router
from errors import bad_request
from models.user import User
from schemas.account_deletion import (
    AccountDeletionReceipt,
    AccountDeletionRequest,
    VaultDisposition,
)
from schemas.timezone import TimezoneRead, TimezoneUpdate
from services.account_deletion import Account, DeletionReceipt, delete_account

logger = logging.getLogger(__name__)

router = build_router(prefix="/users", tags=["users"])

# Deletion here is immediate and final: no grace period, no reversal window.
# A "deletion" that can be undone by logging back in is a deactivation, which
# is exactly what 5.1.1(v) refuses to accept — and a user who wanted a pause
# already has one, in simply not opening the app.
_ACCOUNT_DELETION_IS_RECOVERABLE = False

_CONFIRMATION_MISMATCH = "confirmation_email_mismatch"


@router.put("/me/timezone", response_model=TimezoneRead)
async def update_my_timezone(
    payload: TimezoneUpdate,
    current_user: Annotated[User, Depends(get_current_user_model)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> TimezoneRead:
    """Update the authenticated caller's IANA timezone.

    Validation mirrors signup (see :class:`~schemas.timezone.TimezoneUpdate`):
    an unknown or oversized name is rejected with 422 and blank input coerces
    to ``"UTC"``.  The dependency resolves the caller from their JWT, so only
    that user's own row is ever mutated.
    """
    previous = current_user.timezone
    current_user.timezone = payload.timezone
    session.add(current_user)
    await session.commit()
    logger.info(
        "timezone_changed",
        extra={
            "user_id": current_user.id,
            "old_timezone": previous,
            "new_timezone": payload.timezone,
        },
    )
    return TimezoneRead(timezone=payload.timezone)


def _confirms_own_address(typed: str, own_email: str) -> bool:
    """Whether the retyped address is the caller's own.

    Compared case-insensitively and with surrounding whitespace ignored, so a
    keyboard that capitalises the first letter cannot make a user who typed
    their address correctly look like they typed somebody else's.
    """
    return typed.strip().casefold() == own_email.strip().casefold()


def _to_receipt(receipt: DeletionReceipt) -> AccountDeletionReceipt:
    """Project the service's receipt onto the wire DTO."""
    return AccountDeletionReceipt(
        recoverable=_ACCOUNT_DELETION_IS_RECOVERABLE,
        rows_erased=receipt.rows_erased,
        erased=list(receipt.erased),
        anonymised=list(receipt.anonymised),
        retained=list(receipt.retained),
        vault=VaultDisposition(
            configured=receipt.vault_configured,
            # Never true: adepthood has no purge verb on the vault contract.
            purged=False,
            guidance=receipt.vault_guidance,
        ),
    )


@router.delete("/me", response_model=AccountDeletionReceipt)
async def delete_my_account(
    payload: AccountDeletionRequest,
    current_user: Annotated[User, Depends(get_current_user_model)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> AccountDeletionReceipt:
    """Erase the authenticated caller's account and personal data, irreversibly.

    The subject is resolved from the JWT alone — there is no ``user_id`` in the
    path or the body — so this route cannot be pointed at anybody else. The
    caller retypes their own email address as confirmation; a mismatch is a 400
    and touches nothing.

    The response enumerates the tables erased, the ones that survive with the
    account's name cleared off them, and what a user with a Creek Vault still
    has to purge themselves. Nothing here calls the vault, so an unreachable
    one cannot delay or block the erasure.
    """
    if not _confirms_own_address(payload.confirm_email, current_user.email):
        raise bad_request(_CONFIRMATION_MISMATCH)
    user_id = current_user.id
    if user_id is None:  # pragma: no cover - a persisted row always has an id
        raise bad_request("account_not_persisted")
    receipt = await delete_account(session, Account(user_id=user_id, email=current_user.email))
    return _to_receipt(receipt)
