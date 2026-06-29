"""Share-link endpoints for forwarding a custom practice to another user.

The flow is four routes joined by one token table
(:class:`models.practice_share_link.PracticeShareLink`):

* Owner mints a link with ``POST /practices/{practice_id}/share-link``.
* Recipient (any signed-in user) previews with
  ``GET /practices/share/{token}``.
* Recipient imports with ``POST /practices/share/{token}/import`` --
  the server clones the source practice as an ``approved=False`` row
  whose ``submitted_by_user_id`` is the recipient, so the visibility
  filter in :mod:`dependencies.ownership` keeps it private to them.
* Owner revokes with ``DELETE /practices/share-links/{share_link_id}``.

Tokens are opaque secrets -- anyone who holds one can preview and
import.  The status-code split for failed redemptions is deliberate:

* ``404 share_link_not_found`` -- the token does not exist.
* ``410 share_link_expired|revoked|exhausted`` -- the token did exist
  but has aged out, been revoked, or hit its ``max_uses`` cap.  410
  tells the client the link itself is dead and not worth retrying.
* ``400 cannot_import_own_practice`` -- self-import is a UX foot-gun;
  the recipient already owns the original row.
"""

from __future__ import annotations

import logging
import secrets
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, cast

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy import or_ as sa_or
from sqlalchemy import update as sa_update
from sqlalchemy.engine import CursorResult
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from database import get_session
from errors import bad_request, forbidden, not_found
from models.practice import Practice
from models.practice_share_link import PracticeShareLink
from models.user import User
from rate_limit import limiter
from rate_limit_keys import per_user_rate_limit_key
from routers.auth import get_current_user
from schemas.practice_share import (
    ShareLinkCreateRequest,
    ShareLinkImportResponse,
    ShareLinkPreviewResponse,
    ShareLinkResponse,
)

logger = logging.getLogger(__name__)

# 32 random bytes encodes to a 43-char URL-safe base64 string with 256
# bits of entropy -- comfortably outside any plausible online brute
# force.  Mirrors the password-reset token width.
_TOKEN_BYTES = 32
# A handful of mint retries in the astronomically unlikely event of a
# token collision (~ 2**-256 per attempt).  Caps the loop so a future
# DB bug that always raises IntegrityError can't hang the request.
_MAX_MINT_ATTEMPTS = 4

# 410 Gone keeps the wire shape the dead-link UX prefers -- 404 would
# imply "we couldn't find it" which gives the client nothing to act
# on, while 410 says "this is dead, don't retry."  Each detail string
# is a stable token the frontend branches on.
_DETAIL_EXPIRED = "share_link_expired"
_DETAIL_REVOKED = "share_link_revoked"
_DETAIL_EXHAUSTED = "share_link_exhausted"

# Rate limits per #348:
# * mint -- 10/hour keyed on the JWT ``sub`` so a single user can't
#   carpet-bomb every practice with new links;
# * redeem -- 30/hour keyed on the remote IP so an attacker enumerating
#   random tokens hits a wall quickly even without an account.
_MINT_RATE_LIMIT = "10/hour"
_REDEEM_RATE_LIMIT = "30/hour"


router = APIRouter(prefix="/practices", tags=["practice-share"])


def _gone(detail: str) -> HTTPException:
    """Build a 410 HTTPException with the canonical share-link detail string."""
    return HTTPException(status_code=status.HTTP_410_GONE, detail=detail)


async def _ensure_owner_or_preset(
    session: AsyncSession, practice_id: int, current_user: int
) -> Practice:
    """Resolve a practice for share-link operations.

    Owner-or-preset (``submitted_by_user_id IS NULL`` or matches
    caller) so the "Sharing a preset is also allowed" constraint from
    #348 sits in one place instead of branching per route.
    """
    practice = await session.get(Practice, practice_id)
    if practice is None:
        raise not_found("practice")
    if practice.submitted_by_user_id not in (None, current_user):
        raise forbidden("forbidden")
    return practice


async def _insert_with_fresh_token(
    session: AsyncSession, link: PracticeShareLink
) -> PracticeShareLink:
    """Insert ``link`` retrying on token uniqueness collisions.

    Each retry mints a fresh ``secrets.token_urlsafe`` value before
    committing, so a unique-index hit (astronomically unlikely at 256
    bits but possible against a malicious-but-prescient attacker)
    transparently rolls forward.  ``_MAX_MINT_ATTEMPTS`` caps the loop
    so a future DB bug that always raises IntegrityError surfaces as a
    500 instead of hanging the request.
    """
    last_exc: IntegrityError | None = None
    for _ in range(_MAX_MINT_ATTEMPTS):
        link.token = secrets.token_urlsafe(_TOKEN_BYTES)
        session.add(link)
        try:
            await session.commit()
        except IntegrityError as exc:
            await session.rollback()
            last_exc = exc
            continue
        await session.refresh(link)
        return link
    msg = "failed to mint a unique share-link token after retries"
    raise RuntimeError(msg) from last_exc


def _build_share_link(
    *,
    practice_id: int,
    current_user: int,
    expires_at: datetime | None,
    max_uses: int | None,
) -> PracticeShareLink:
    """Construct a ``PracticeShareLink`` with a freshly minted token.

    Mints the token before constructing the row so the SQLModel field
    is never instantiated with a sentinel value -- keeps the bandit
    ``B106 hardcoded_password`` check quiet without a noqa, and
    closes a minor race where a partially-built row could be saved
    before the token is set.
    """
    return PracticeShareLink(
        token=secrets.token_urlsafe(_TOKEN_BYTES),
        practice_id=practice_id,
        created_by_user_id=current_user,
        expires_at=expires_at,
        max_uses=max_uses,
    )


def _display_name_from_email(email: str | None) -> str | None:
    """Derive a public-facing display name from an email address.

    Returns the part before ``@`` (``alice@example.com -> "alice"``) so
    the recipient sees *something* identifying the sender without the
    full address landing in the preview payload.  ``None`` for a
    missing user (post-deletion) so the frontend can fall back to a
    generic "Shared with you" copy.
    """
    if not email or "@" not in email:
        return None
    return email.split("@", 1)[0] or None


def _is_link_expired(link: PracticeShareLink) -> bool:
    return link.expires_at is not None and link.expires_at <= datetime.now(UTC)


def _is_link_exhausted(link: PracticeShareLink) -> bool:
    return link.max_uses is not None and link.use_count >= link.max_uses


def _dead_link_detail(link: PracticeShareLink) -> str | None:
    """Return the 410-detail string for a dead link, or ``None`` if alive.

    Each soft-kill predicate is delegated to a one-liner so this function
    stays at xenon rank A while preserving the explicit precedence
    (revoked > expired > exhausted) the API contract documents.
    """
    if link.revoked_at is not None:
        return _DETAIL_REVOKED
    if _is_link_expired(link):
        return _DETAIL_EXPIRED
    if _is_link_exhausted(link):
        return _DETAIL_EXHAUSTED
    return None


def _check_link_alive(link: PracticeShareLink) -> None:
    """Raise 410 if the link is revoked, expired, or exhausted."""
    detail = _dead_link_detail(link)
    if detail is not None:
        raise _gone(detail)


async def _load_active_link(session: AsyncSession, token: str) -> PracticeShareLink:
    """Resolve a token to a live :class:`PracticeShareLink`.

    Centralises the 404 -> 410 split so each redeem endpoint stays a
    couple of lines long.
    """
    result = await session.execute(
        select(PracticeShareLink).where(PracticeShareLink.token == token)
    )
    link = result.scalars().first()
    if link is None:
        raise not_found("share_link")
    _check_link_alive(link)
    return link


def _clone_practice_for_recipient(source: Practice, recipient_user_id: int) -> Practice:
    """Build the recipient's private draft from the source row.

    ``approved=False`` keeps the new row private via the visibility
    filter in :mod:`dependencies.ownership`; ``submitted_by_user_id``
    is the recipient so a follow-up customize / delete is authorised.
    ``mode_config`` is shallow-copied (it's already plain JSON; a deep
    copy would re-walk the same dict) so an in-place tweak by the
    recipient cannot mutate the source row through the shared
    reference.
    """
    return Practice(
        stage_number=source.stage_number,
        name=source.name,
        description=source.description,
        instructions=source.instructions,
        default_duration_minutes=source.default_duration_minutes,
        submitted_by_user_id=recipient_user_id,
        approved=False,
        mode=source.mode,
        mode_config=dict(source.mode_config),
    )


@router.post(
    "/{practice_id}/share-link",
    response_model=ShareLinkResponse,
    status_code=status.HTTP_201_CREATED,
)
@limiter.limit(_MINT_RATE_LIMIT, key_func=per_user_rate_limit_key)
async def create_share_link(
    request: Request,  # noqa: ARG001 — consumed by @limiter.limit decorator
    practice_id: int,
    payload: ShareLinkCreateRequest,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> PracticeShareLink:
    """Mint a share-link token for a practice the caller owns.

    Ownership is "I submitted this row" -- preset practices have
    ``submitted_by_user_id IS NULL`` so anyone can share them
    (consistent with #348's "sharing a preset is also allowed").  A
    practice submitted by someone else 403s.
    """
    await _ensure_owner_or_preset(session, practice_id, current_user)

    expires_at: datetime | None = None
    if payload.expires_in_days is not None:
        expires_at = datetime.now(UTC) + timedelta(days=payload.expires_in_days)

    link = _build_share_link(
        practice_id=practice_id,
        current_user=current_user,
        expires_at=expires_at,
        max_uses=payload.max_uses,
    )
    minted = await _insert_with_fresh_token(session, link)
    logger.info(
        "practice_share_link_created",
        extra={
            "practice_id": practice_id,
            "user_id": current_user,
            "share_link_id": minted.id,
        },
    )
    return minted


@router.get("/share/{token}", response_model=ShareLinkPreviewResponse)
@limiter.limit(_REDEEM_RATE_LIMIT)
async def preview_share_link(
    request: Request,  # noqa: ARG001 — consumed by @limiter.limit decorator
    token: str,
    _current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ShareLinkPreviewResponse:
    """Return the practice payload a redeem would copy.

    The caller is authenticated (any signed-in user is allowed) so an
    anonymous link harvester cannot crawl tokens without paying the
    signup tax.  The response intentionally omits the source row's
    ``submitted_by_user_id`` to keep the endpoint from doubling as a
    user-id enumeration oracle.
    """
    link = await _load_active_link(session, token)
    practice = await session.get(Practice, link.practice_id)
    if practice is None:
        # Source row was deleted after the link was minted -- treat
        # the link as dead.  Same wire shape as ``revoked_at`` so the
        # frontend's stale-link UX covers both.
        raise _gone(_DETAIL_REVOKED)

    display_name: str | None = None
    if link.created_by_user_id is not None:
        owner = await session.get(User, link.created_by_user_id)
        if owner is not None:
            display_name = _display_name_from_email(owner.email)

    return ShareLinkPreviewResponse(
        practice_id=cast("int", practice.id),
        stage_number=practice.stage_number,
        name=practice.name,
        description=practice.description,
        instructions=practice.instructions,
        default_duration_minutes=practice.default_duration_minutes,
        mode=practice.mode,
        mode_config=practice.mode_config,
        created_by_display_name=display_name,
        expires_at=link.expires_at,
        max_uses=link.max_uses,
        use_count=link.use_count,
    )


async def _atomically_claim_use_slot(session: AsyncSession, link_id: int) -> bool:
    """Increment ``use_count`` only if the cap still allows.

    The WHERE clause encodes the precondition (link not revoked and
    ``max_uses IS NULL OR use_count < max_uses``) inside the same
    statement that performs the increment, so two concurrent importers
    of a ``max_uses=1`` link cannot both pass the read-side check and
    both bump the counter (the bug flagged in PR #359 review).

    Returns ``True`` when the row was updated, ``False`` when the cap
    or revocation gate caused the UPDATE to match zero rows.  The
    expiry check stays in the read-side :func:`_check_link_alive`
    because ``datetime.now(UTC)`` cannot be expressed inside a portable
    UPDATE expression and clock skew between request handlers is
    smaller than the typical expiry granularity (days, not microseconds).
    """
    use_count_col = col(PracticeShareLink.use_count)
    max_uses_col = col(PracticeShareLink.max_uses)
    statement = (
        sa_update(PracticeShareLink)
        .where(
            col(PracticeShareLink.id) == link_id,
            col(PracticeShareLink.revoked_at).is_(None),
            sa_or(max_uses_col.is_(None), use_count_col < max_uses_col),
        )
        .values(use_count=use_count_col + 1)
    )
    # ``AsyncSession.execute`` is typed as returning ``Result[Any]`` even for
    # UPDATE statements; the runtime object is a ``CursorResult`` carrying
    # the ``rowcount`` attribute the contract here depends on.  Cast keeps
    # the type-checker honest without resorting to ``type: ignore``.
    result = cast("CursorResult[Any]", await session.execute(statement))
    return result.rowcount > 0


@router.post(
    "/share/{token}/import",
    response_model=ShareLinkImportResponse,
    status_code=status.HTTP_201_CREATED,
)
@limiter.limit(_REDEEM_RATE_LIMIT)
async def import_share_link(
    request: Request,  # noqa: ARG001 — consumed by @limiter.limit decorator
    token: str,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> ShareLinkImportResponse:
    """Copy the source practice into the recipient's catalog.

    Self-import is rejected with 400 because the recipient already
    owns the original row -- cloning it would just clutter their
    catalog with a duplicate.

    Race safety: :func:`_atomically_claim_use_slot` issues a single
    ``UPDATE ... SET use_count = use_count + 1 WHERE ... AND
    use_count < max_uses`` so two concurrent importers of a
    ``max_uses=1`` link cannot both bypass the cap.  The loser sees
    ``rowcount == 0`` and gets the same 410 ``share_link_exhausted``
    that a sequential third importer would.  The increment and the
    clone live in the same transaction so a crash between the two
    rolls both back together.
    """
    link = await _load_active_link(session, token)
    if link.created_by_user_id == current_user:
        raise bad_request("cannot_import_own_practice")

    source = await session.get(Practice, link.practice_id)
    if source is None:
        raise _gone(_DETAIL_REVOKED)

    if not await _atomically_claim_use_slot(session, cast("int", link.id)):
        # The link was exhausted (or revoked) between the read-side
        # check and the atomic update -- treat the loser the same way
        # the read-side check would treat a fresh request.
        await session.rollback()
        raise _gone(_DETAIL_EXHAUSTED)

    copy = _clone_practice_for_recipient(source, current_user)
    session.add(copy)
    await session.commit()
    await session.refresh(copy)

    logger.info(
        "practice_share_link_imported",
        extra={
            "share_link_id": link.id,
            "source_practice_id": source.id,
            "imported_practice_id": copy.id,
            "user_id": current_user,
        },
    )
    return ShareLinkImportResponse(
        practice_id=cast("int", copy.id),
        stage_number=copy.stage_number,
        name=copy.name,
        approved=copy.approved,
    )


@router.delete("/share-links/{share_link_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_share_link(
    share_link_id: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> Response:
    """Revoke an outstanding share link the caller minted.

    Idempotent in the sense that calling DELETE on an already-revoked
    link is a no-op 204 -- the row stays revoked, ``revoked_at`` is
    not pushed forward.
    """
    link = await session.get(PracticeShareLink, share_link_id)
    if link is None:
        raise not_found("share_link")
    if link.created_by_user_id != current_user:
        raise forbidden("forbidden")
    if link.revoked_at is None:
        link.revoked_at = datetime.now(UTC)
        session.add(link)
        await session.commit()
        logger.info(
            "practice_share_link_revoked",
            extra={"share_link_id": link.id, "user_id": current_user},
        )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


_LIST_LIMIT_DEFAULT = 50
_LIST_LIMIT_MAX = 200


@router.get("/{practice_id}/share-links", response_model=list[ShareLinkResponse])
async def list_share_links(
    practice_id: int,
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    limit: Annotated[
        int,
        Query(
            ge=1,
            le=_LIST_LIMIT_MAX,
            description="Maximum links to return (newest first). Defaults to 50.",
        ),
    ] = _LIST_LIMIT_DEFAULT,
) -> list[PracticeShareLink]:
    """List the share links the caller has minted for a practice.

    Powers the "active links with Revoke" panel in the frontend's
    ``ShareSheet``.  Visibility mirrors ``create_share_link``: the
    caller must own the source practice (preset or self-submitted).

    Bounded by ``limit`` (default 50, max 200) so a long-lived practice
    cannot produce an unbounded payload.  Rows are returned newest-first
    so the most relevant links appear in the first page.
    """
    await _ensure_owner_or_preset(session, practice_id, current_user)

    result = await session.execute(
        select(PracticeShareLink)
        .where(
            PracticeShareLink.practice_id == practice_id,
            PracticeShareLink.created_by_user_id == current_user,
        )
        .order_by(col(PracticeShareLink.created_at).desc())
        .limit(limit)
    )
    return list(result.scalars().all())


__all__: list[str] = ["router"]
