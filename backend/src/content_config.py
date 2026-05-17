"""Declarative content config for Squarespace-hosted course material.

This module is the single source of truth for which Squarespace URLs the
backend pulls into the app — both stage-locked drip-feed chapters and the
always-available site resources surfaced on the Course screen.

Editing rules
=============

To **add** a stage's chapters:
    Append a new ``StageContentPlan`` to ``STAGE_PLANS``.  The seeder will
    create one ``StageContent`` row per chapter on next boot.

To **add** a site resource (philosophy, about, etc.):
    Append a new ``SiteResource`` to ``SITE_RESOURCES``.  It becomes
    available immediately via ``GET /course/site-resources`` — no DB
    migration, no seed step.

To **remove** a chapter:
    Drop or shorten the relevant ``chapter_count`` and run
    ``backend/scripts/resync_stage_content.py`` (or wait for next boot —
    the seeder reconciles).

See ``docs/content.md`` at the repo root for the full editor's guide.

Why this lives in a Python module
=================================
Plain Python lets us validate at import time (uniqueness, URL sanity,
release-day bounds) and lets type-checkers catch typos in field names.
The "config feel" is preserved by keeping every URL pattern declarative.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

from domain.energy import PLAN_DURATION_DAYS

#: Public-facing Squarespace site root. Used to build chapter URLs.
SITE_BASE_URL: Final[str] = "https://aptitude.guru"


@dataclass(frozen=True)
class StageContentPlan:
    """Declarative plan for one course stage's chapters.

    ``slug`` is the Squarespace URL prefix — chapters are addressed as
    ``{SITE_BASE_URL}/course/{slug}-{n}`` where ``n`` runs from 1 to
    ``chapter_count``.

    ``release_pattern`` controls how chapters are spaced across the stage.
    Today we only ship ``"daily"``: one chapter per day starting at day 0,
    with any remaining days in the stage left empty for catch-up.  Adding
    another pattern (``"weekly"``, ``"front_loaded"``) means extending
    :func:`build_chapter_release_days`.
    """

    stage_number: int
    slug: str
    chapter_count: int
    content_type: str = "chapter"
    release_pattern: str = "daily"
    title_template: str = "Chapter {n}"


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
        """Absolute public URL on the Squarespace site."""
        suffix = self.path or f"/{self.slug}"
        return f"{SITE_BASE_URL}{suffix}"


# --------------------------------------------------------------------------- #
# Stage-locked drip-feed plans                                                 #
# --------------------------------------------------------------------------- #

#: Per-stage chapter plans.  Stages not listed here keep whatever existing
#: ``StageContent`` rows already live in the DB (placeholder seed data, in
#: the case of stages 2 and 3 today).
STAGE_PLANS: Final[list[StageContentPlan]] = [
    StageContentPlan(
        stage_number=1,
        slug="beige",
        chapter_count=14,
    ),
]


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
# Derivations — kept pure so tests can call them without a DB                  #
# --------------------------------------------------------------------------- #


def build_chapter_release_days(plan: StageContentPlan) -> list[int]:
    """Return the ``release_day`` value for each chapter in the plan.

    The current ``"daily"`` pattern: chapter ``n`` (1-indexed) unlocks on
    day ``n - 1``, capped by ``PLAN_DURATION_DAYS - 1`` so a too-long plan
    cannot push a chapter past the end of its stage.  If a stage ships
    fewer chapters than ``PLAN_DURATION_DAYS``, the trailing days remain
    empty by design (catch-up window).
    """
    if plan.release_pattern != "daily":
        msg = f"Unsupported release_pattern: {plan.release_pattern!r}"
        raise ValueError(msg)
    if plan.chapter_count < 1:
        msg = f"chapter_count must be >= 1, got {plan.chapter_count}"
        raise ValueError(msg)
    cap = PLAN_DURATION_DAYS - 1
    return [min(n, cap) for n in range(plan.chapter_count)]


def chapter_url(plan: StageContentPlan, chapter_index: int) -> str:
    """Return the absolute URL for the n-th chapter (1-indexed)."""
    if not 1 <= chapter_index <= plan.chapter_count:
        msg = (
            f"chapter_index {chapter_index} out of range for "
            f"stage {plan.stage_number} (1..{plan.chapter_count})"
        )
        raise ValueError(msg)
    return f"{SITE_BASE_URL}/course/{plan.slug}-{chapter_index}"


@dataclass(frozen=True)
class ChapterRecord:
    """Expanded view of one chapter — what the seeder writes to the DB."""

    stage_number: int
    title: str
    content_type: str
    release_day: int
    url: str


def expand_plan(plan: StageContentPlan) -> list[ChapterRecord]:
    """Expand a ``StageContentPlan`` into one ``ChapterRecord`` per chapter."""
    release_days = build_chapter_release_days(plan)
    records: list[ChapterRecord] = []
    for index_zero_based, day in enumerate(release_days):
        chapter_number = index_zero_based + 1
        records.append(
            ChapterRecord(
                stage_number=plan.stage_number,
                title=plan.title_template.format(n=chapter_number),
                content_type=plan.content_type,
                release_day=day,
                url=chapter_url(plan, chapter_number),
            )
        )
    return records


def all_chapter_records() -> list[ChapterRecord]:
    """Flatten every ``STAGE_PLANS`` entry into a single list of chapters."""
    flat: list[ChapterRecord] = []
    for plan in STAGE_PLANS:
        flat.extend(expand_plan(plan))
    return flat


def find_resource(slug: str) -> SiteResource | None:
    """Look up a ``SiteResource`` by its slug, or ``None`` if not configured."""
    for resource in SITE_RESOURCES:
        if resource.slug == slug:
            return resource
    return None


# --------------------------------------------------------------------------- #
# Import-time validation — fail fast on bad config rather than at request time #
# --------------------------------------------------------------------------- #


def _validate_stage_plans(plans: list[StageContentPlan]) -> None:
    """Reject duplicate stage_numbers or duplicate slugs at import time."""
    stages_seen: set[int] = set()
    slugs_seen: set[str] = set()
    for plan in plans:
        if plan.stage_number in stages_seen:
            msg = f"Duplicate stage_number in STAGE_PLANS: {plan.stage_number}"
            raise ValueError(msg)
        if plan.slug in slugs_seen:
            msg = f"Duplicate slug in STAGE_PLANS: {plan.slug!r}"
            raise ValueError(msg)
        stages_seen.add(plan.stage_number)
        slugs_seen.add(plan.slug)
        # Force release-day computation so a bad pattern blows up at boot.
        build_chapter_release_days(plan)


def _validate_site_resources(resources: list[SiteResource]) -> None:
    """Reject duplicate site-resource slugs at import time."""
    slugs_seen: set[str] = set()
    for resource in resources:
        if resource.slug in slugs_seen:
            msg = f"Duplicate slug in SITE_RESOURCES: {resource.slug!r}"
            raise ValueError(msg)
        slugs_seen.add(resource.slug)


_validate_stage_plans(STAGE_PLANS)
_validate_site_resources(SITE_RESOURCES)


# Public surface — keep ``__all__`` small to make intent obvious.
__all__ = [
    "SITE_BASE_URL",
    "SITE_RESOURCES",
    "STAGE_PLANS",
    "ChapterRecord",
    "SiteResource",
    "StageContentPlan",
    "all_chapter_records",
    "build_chapter_release_days",
    "chapter_url",
    "expand_plan",
    "find_resource",
]
