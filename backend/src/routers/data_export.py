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

from fastapi import Depends, status
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_session
from dependencies.auth import get_current_user_model
from error_responses import ResponseDeclarations, build_router
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

# What separates a media type from its parameters, in a header and in the
# document key alike: ``text/markdown; charset=utf-8``.
_MEDIA_TYPE_PARAMETER_SEPARATOR = ";"

_JSON_DESCRIPTION = "The caller's whole archive, streamed as one JSON document."
_MARKDOWN_DESCRIPTION = "The caller's journal, streamed as Markdown."

# The names the two files land under, dated at request time. Documented for
# users in ``docs/your-data.md``; a change here belongs there too.
_JSON_FILENAME = ("adepthood-export", "json")
_MARKDOWN_FILENAME = ("adepthood-journal", "md")

# Every persisted account has an id; a caller holding a token for one that does
# not is a broken invariant rather than a request worth serving.
_ACCOUNT_NOT_PERSISTED = "account_not_persisted"


def _sends(media_type: str, description: str) -> ResponseDeclarations:
    """Declare a 200 carrying exactly ``media_type``, and nothing besides.

    The precedent for declaring a success media type in this codebase: no
    router had needed one before, because every other route answers the JSON
    FastAPI assumes on its own. Three things about the shape are deliberate.

    The parameter is stripped off the document key -- ``text/markdown``, not
    ``text/markdown; charset=utf-8`` -- while the caller hands over the very
    constant the route gives ``StreamingResponse``. That keeps the wire value
    the single source of truth, so the paper cannot drift from the header. A
    conformance check parses parameters off both sides before comparing, so the
    bare type still matches the charset-bearing header it describes.

    No ``schema`` is declared under the media type. FastAPI would synthesise
    ``{"type": "string"}`` for a route whose response class is not
    ``JSONResponse``, and the JSON archive -- an object -- would then fail its
    own published schema; a response-schema validator skips a body it has no
    schema for, so declaring nothing is both honest and safe.

    Args:
        media_type: The value the route passes ``StreamingResponse``,
            parameters and all.
        description: What the body is, for the reader of the document.

    Returns:
        A ``responses=`` mapping carrying that single 200.
    """
    documented = media_type.split(_MEDIA_TYPE_PARAMETER_SEPARATOR, maxsplit=1)[0].strip()
    return {
        status.HTTP_200_OK: {"description": description, "content": {documented: {}}},
    }


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


# ``response_class=StreamingResponse`` is load-bearing rather than cosmetic:
# that class carries no class-level ``media_type``, which is what makes
# FastAPI's generator skip the block that would otherwise publish a default
# ``application/json`` entry. Declaring ``responses=`` alone would merely add a
# second media type beside the bogus JSON one.
@router.get(
    "/me/export",
    response_class=StreamingResponse,
    responses=_sends(_JSON_MEDIA_TYPE, _JSON_DESCRIPTION),
)
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


@router.get(
    "/me/export/journal.md",
    response_class=StreamingResponse,
    responses=_sends(_MARKDOWN_MEDIA_TYPE, _MARKDOWN_DESCRIPTION),
)
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
