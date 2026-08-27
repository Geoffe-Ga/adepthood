"""Take-your-data-with-you endpoints.

``GET /users/me/export`` streams the whole archive as JSON; ``GET
/users/me/export/journal.md`` streams the journal alone as Markdown, for the
much more common case of a person who wants to *read* what they wrote rather
than re-import it.

Neither route takes a subject. There is no ``user_id`` in the path, the query
string or a body — the account is resolved from the caller's own token, which
is what makes "user A cannot export user B" a property of the route's shape
rather than of a check somebody has to remember to write. What each archive
contains is declared once in :mod:`domain.data_export` and assembled by
:mod:`services.data_export`.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Annotated

from fastapi import Depends
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_session
from dependencies.auth import get_current_user_model
from error_responses import build_router
from errors import bad_request
from models.user import User
from services.data_export import (
    ExportSubject,
    stream_journal_markdown,
    stream_json_export,
)

router = build_router(prefix="/users", tags=["export"])

_JSON_MEDIA_TYPE = "application/json"
_MARKDOWN_MEDIA_TYPE = "text/markdown; charset=utf-8"

# The names the two files land under, dated at request time. Documented for
# users in ``docs/your-data.md``; a change here belongs there too.
_JSON_FILENAME = ("adepthood-export", "json")
_MARKDOWN_FILENAME = ("adepthood-journal", "md")

# Every persisted account has an id; a caller holding a token for one that does
# not is a broken invariant rather than a request worth serving.
_ACCOUNT_NOT_PERSISTED = "account_not_persisted"


def _subject(current_user: User) -> ExportSubject:
    """Whose archive to build, taken from the authenticated caller alone."""
    if current_user.id is None:  # pragma: no cover - a persisted row always has an id
        raise bad_request(_ACCOUNT_NOT_PERSISTED)
    return ExportSubject(user_id=current_user.id, email=current_user.email)


def _attachment(filename: tuple[str, str]) -> dict[str, str]:
    """A dated, obvious filename, so the archive is a download and not a page.

    The date is in the name because the most likely place this file lands is a
    folder beside last year's copy.
    """
    stem, extension = filename
    stamp = datetime.now(UTC).date().isoformat()
    return {"Content-Disposition": f'attachment; filename="{stem}-{stamp}.{extension}"'}


def _streamed(
    chunks: AsyncIterator[str],
    media_type: str,
    filename: tuple[str, str],
) -> StreamingResponse:
    """Wrap an archive generator as a downloadable, streamed response."""
    return StreamingResponse(chunks, media_type=media_type, headers=_attachment(filename))


@router.get("/me/export")
async def export_my_data(
    current_user: Annotated[User, Depends(get_current_user_model)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> StreamingResponse:
    """Stream everything the caller has written, as a JSON archive.

    Streamed rather than assembled and returned, because the account this
    feature exists for — the one with years of journal in it — is exactly the
    one a buffered response would fail.
    """
    return _streamed(
        stream_json_export(session, _subject(current_user)),
        _JSON_MEDIA_TYPE,
        _JSON_FILENAME,
    )


@router.get("/me/export/journal.md")
async def export_my_journal_as_markdown(
    current_user: Annotated[User, Depends(get_current_user_model)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> StreamingResponse:
    """Stream the caller's journal as Markdown — the readable half of the pair."""
    return _streamed(
        stream_journal_markdown(session, _subject(current_user)),
        _MARKDOWN_MEDIA_TYPE,
        _MARKDOWN_FILENAME,
    )
