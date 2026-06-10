"""Declarative content config: manifest-driven chapters + site resources.

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

Site resources (philosophy, about, …) are still declared here and still
point at the public site; they migrate in a later cms-migration issue.

See ``docs/content.md`` for the editor's guide.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Final

from services.content_repository import ContentRepositoryError, get_content_repository

logger = logging.getLogger(__name__)

#: Public-facing site root. Used to build site-resource URLs (only).
SITE_BASE_URL: Final[str] = "https://aptitude.guru"

#: Scheme for local content references stored in ``StageContent.url``.
CONTENT_REF_SCHEME: Final[str] = "content"


def content_ref(chapter_id: str) -> str:
    """The local reference written to ``StageContent.url`` for a chapter.

    The body endpoint resolves this back to the vendored Markdown via
    :meth:`ContentRepository.read_body` (later cms-migration issue) —
    nothing downstream should treat it as a fetchable URL.
    """
    return f"{CONTENT_REF_SCHEME}://{chapter_id}"


@dataclass(frozen=True)
class SiteResource:
    """A non-stage-locked link surfaced on the Course screen.

    Use this for evergreen pages (philosophy, about, FAQ) that the adept
    should be able to reach from inside the app at any point in the
    program.  These are not tracked for read-completion.
    """

    slug: str
    title: str
    description: str = ""
    path: str = ""

    @property
    def url(self) -> str:
        """Absolute public URL on the live site."""
        suffix = self.path or f"/{self.slug}"
        return f"{SITE_BASE_URL}{suffix}"


# --------------------------------------------------------------------------- #
# Always-available site resources                                             #
# --------------------------------------------------------------------------- #

#: Pages that are not stage-gated. Order here is the order shown in the UI.
SITE_RESOURCES: Final[list[SiteResource]] = [
    SiteResource(
        slug="liminal-creep",
        title="Who Benefits?",
        description="Why the program exists.",
        path="/philosophy/liminal-creep",
    ),
    SiteResource(
        slug="archetypal-wavelength",
        title="Archetypal Wavelength Intro",
        description="The shape of human development.",
        path="/philosophy/archetypal-wavelength",
    ),
    SiteResource(
        slug="aptitude-stages",
        title="APTITUDE Stages",
        description="The 36-week stage map.",
        path="/philosophy/aptitude-stages",
    ),
    SiteResource(
        slug="about",
        title="APTITUDE Intro",
        description="What Adepthood is and who it's for.",
        path="/about",
    ),
]


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


def find_resource(slug: str) -> SiteResource | None:
    """Look up a ``SiteResource`` by its slug, or ``None`` if not configured."""
    for resource in SITE_RESOURCES:
        if resource.slug == slug:
            return resource
    return None


# --------------------------------------------------------------------------- #
# Import-time validation — fail fast on bad config rather than at request time #
# --------------------------------------------------------------------------- #


def _validate_site_resources(resources: list[SiteResource]) -> None:
    """Reject duplicate site-resource slugs at import time."""
    slugs_seen: set[str] = set()
    for resource in resources:
        if resource.slug in slugs_seen:
            msg = f"Duplicate slug in SITE_RESOURCES: {resource.slug!r}"
            raise ValueError(msg)
        slugs_seen.add(resource.slug)


_validate_site_resources(SITE_RESOURCES)


# Public surface — keep ``__all__`` small to make intent obvious.
__all__ = [
    "CONTENT_REF_SCHEME",
    "SITE_BASE_URL",
    "SITE_RESOURCES",
    "ChapterRecord",
    "SiteResource",
    "all_chapter_records",
    "content_ref",
    "find_resource",
]
