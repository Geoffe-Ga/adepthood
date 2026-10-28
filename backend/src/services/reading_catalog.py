"""Immutable public course context and bounded relevance shortlisting."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from functools import lru_cache
from itertools import chain

from domain.reading_recommendations import ReadingCandidate, ReadingSource
from models.stage_content import StageContent
from services.content_repository import ContentRepository, get_content_repository

_READING_CHARS = 1400


@dataclass(frozen=True)
class _Chapter:
    key: str
    stage: int
    title: str
    body: str


@lru_cache(maxsize=2)
def _catalog(repository: ContentRepository) -> tuple[str, dict[str, _Chapter]]:
    """Cache immutable public course context once per repository instance."""
    chapters = {
        item.id: _Chapter(item.id, item.stage, item.title, repository.read_body(item.id).body)
        for item in repository.list_chapters()
    }
    revision = hashlib.sha256(repr(chapters).encode()).hexdigest()
    return revision, chapters


def _words(text: str) -> set[str]:
    return set(re.findall(r"[a-z]{4,}", text.lower())) - {
        "that",
        "this",
        "with",
        "from",
        "have",
        "your",
        "they",
        "their",
        "there",
        "what",
        "when",
        "will",
        "about",
        "would",
        "could",
        "which",
        "been",
        "into",
        "more",
        "some",
        "than",
        "then",
    }


def _excerpt(body: str, query: set[str], limit: int) -> str:
    """Use a contiguous real passage around the strongest lexical match."""
    chunks = [(offset, body[offset : offset + limit]) for offset in range(0, len(body), limit // 2)]
    return (
        max(chunks, key=lambda item: (len(_words(item[1]) & query), -item[0]))[1].strip()
        if chunks
        else ""
    )


def _content_key(url: str) -> str:
    return url.removeprefix("content://") if url.startswith("content://") else ""


def _candidate(
    item: StageContent, stage: int, catalog: dict[str, _Chapter], query: set[str]
) -> ReadingCandidate | None:
    key = _content_key(item.url)
    chapter = catalog.get(key)
    if item.id is None or chapter is None:
        return None
    if chapter.stage != stage:
        return None
    content = _excerpt(chapter.body, query, _READING_CHARS)
    return ReadingCandidate(item.id, stage, chapter.title, content) if content else None


def _stage_candidates(
    items: list[StageContent], stage: int, catalog: dict[str, _Chapter], query: set[str]
) -> list[ReadingCandidate]:
    return [
        value for item in items if (value := _candidate(item, stage, catalog, query)) is not None
    ]


def shortlist(
    available: dict[int, list[StageContent]], sources: tuple[ReadingSource, ...]
) -> tuple[str, tuple[ReadingCandidate, ...]]:
    """Choose across every eligible signalled stage with one model call's menu."""
    revision, catalog = _catalog(get_content_repository())
    query = _words(" ".join(source.content for source in sources))
    candidates = list(
        chain.from_iterable(
            _stage_candidates(items, stage, catalog, query) for stage, items in available.items()
        )
    )
    candidates.sort(
        key=lambda item: (-len(_words(item.content + " " + item.title) & query), item.content_id)
    )
    return revision, tuple(sorted(candidates[:3], key=lambda item: item.content_id))
