"""Declarative content config: manifest-driven chapter records.

Stage-locked chapters are no longer hardcoded here (the old
``STAGE_PLANS`` covered stage 1 only and built Squarespace URLs).  They
now come from the vendored content manifest via
:class:`services.content_repository.ContentRepository` — every stage the
manifest ships, with ``title``/``content_type``/``release_day`` taken
verbatim and a **local content reference** (``content://<chapter-id>``)
written where the Squarespace URL used to go.  The stage-numbering
reconciliation from ADR 0001 applies: manifest ``stage`` N maps onto the
app's ``CourseStage.stage_number`` N, identity for 1..10.

The ``StageContent.url`` column is deliberately *repurposed* (not
renamed) to hold the ``content://`` reference — no Alembic migration is
needed, existing read-completion rows keep their foreign keys, and the
column rename can ride the final cutover issue once the Squarespace
reader is deleted.  See issue #392.

Site resources (philosophy, about, …) moved out of this module in issue
#395: the manifest's ``site_resources[]`` is their source of truth and
the course router reads them straight from the repository.

See ``docs/content.md`` for the editor's guide.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Final

from services.content_repository import ContentRepositoryError, get_content_repository

logger = logging.getLogger(__name__)

#: Scheme for local content references stored in ``StageContent.url``.
CONTENT_REF_SCHEME: Final[str] = "content"


def content_ref(chapter_id: str) -> str:
    """The local reference written to ``StageContent.url`` for a chapter.

    The body endpoint resolves this back to the vendored Markdown via
    :meth:`ContentRepository.read_body` (later cms-migration issue) —
    nothing downstream should treat it as a fetchable URL.
    """
    return f"{CONTENT_REF_SCHEME}://{chapter_id}"


# --------------------------------------------------------------------------- #
# Manifest-driven chapter records                                             #
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class ChapterRecord:
    """Expanded view of one chapter — what the seeder writes to the DB."""

    stage_number: int
    title: str
    content_type: str
    release_day: int
    url: str


def all_chapter_records() -> list[ChapterRecord]:
    """One ``ChapterRecord`` per manifest chapter, ordered by (stage, order).

    Reads the process-wide :class:`ContentRepository` lazily at call time
    (the seeder runs at boot, not at import).  When the content directory
    has no usable manifest — the bootstrap state until the first
    ``sync_content`` pin lands — this degrades to an empty list with a
    warning rather than crashing boot: the app keeps serving non-content
    features, and the CI drift gate (#397) catches bad manifests before
    deploy.
    """
    try:
        chapters = get_content_repository().list_chapters()
    except ContentRepositoryError as exc:
        logger.warning("No usable content manifest; seeding no chapters: %s", exc)
        return []
    return [
        ChapterRecord(
            stage_number=chapter.stage,
            title=chapter.title,
            content_type=chapter.content_type,
            release_day=chapter.release_day,
            url=content_ref(chapter.id),
        )
        for chapter in chapters
    ]


# Public surface — keep ``__all__`` small to make intent obvious.
__all__ = [
    "CONTENT_REF_SCHEME",
    "ChapterRecord",
    "all_chapter_records",
    "content_ref",
]
