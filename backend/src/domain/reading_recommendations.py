"""Bounded course and journal context for the vault's recommendation operation."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Protocol, TypedDict, TypeGuard, runtime_checkable

_MAX_READINGS = 6
_MAX_SOURCES = 3
_MAX_SOURCE_CHARS = 2000
_MAX_READING_CHARS = 1500


@dataclass(frozen=True)
class ReadingCandidate:
    """An available chapter with canonical app navigation coordinates."""

    content_id: int
    stage_number: int
    title: str
    content: str


@dataclass(frozen=True)
class ReadingSource:
    """Current owned writing; its display title stays outside the prompt."""

    entry_id: int
    title: str | None
    content: str = field(repr=False)
    tier: str


def _validate_count(count: int, maximum: int) -> None:
    if not 1 <= count <= maximum:
        raise ValueError("reading recommendation context exceeds its bound")


def _valid_source(source: ReadingSource) -> bool:
    return source.tier in {"open", "personal"} and _bounded_text(source.content, _MAX_SOURCE_CHARS)


def _validate_sources(sources: tuple[ReadingSource, ...]) -> None:
    if not all(_valid_source(source) for source in sources):
        raise ValueError("reading recommendation source refused")


def _validate_readings(readings: tuple[ReadingCandidate, ...]) -> None:
    if not all(_bounded_text(item.content, _MAX_READING_CHARS) for item in readings):
        raise ValueError("reading recommendation text exceeds its bound")


@dataclass(frozen=True)
class ReadingRequest:
    """An immutable context snapshot, used in the vault's private cache key."""

    catalog_version: str
    readings: tuple[ReadingCandidate, ...]
    sources: tuple[ReadingSource, ...]

    def wire_body(self) -> dict[str, object]:
        """Validate context before constructing any outbound body."""
        _validate_count(len(self.readings), _MAX_READINGS)
        _validate_count(len(self.sources), _MAX_SOURCES)
        _validate_sources(self.sources)
        _validate_readings(self.readings)
        return {
            "catalog_version": self.catalog_version,
            "readings": [
                {"content_id": item.content_id, "title": item.title, "content": item.content}
                for item in self.readings
            ],
            "sources": [
                {"entry_id": item.entry_id, "tier": item.tier, "content": item.content}
                for item in self.sources
            ],
        }


@dataclass(frozen=True)
class ReadingRecommendation:
    """Model prose whose identity and source quotation remain verifiable."""

    content_id: int
    entry_id: int
    quote: str = field(repr=False)
    reason: str = field(repr=False)
    benefit: str = field(repr=False)


def _bounded_text(value: object, limit: int) -> bool:
    return isinstance(value, str) and bool(value.strip()) and len(value) <= limit


class _Answer(TypedDict):
    """Fields admitted by the independent consumer parser."""

    content_id: int
    entry_id: int
    quote: str
    reason: str
    benefit: str


_FIELD_CHECKS: Mapping[str, Callable[[object], bool]] = {
    "content_id": lambda value: type(value) is int,
    "entry_id": lambda value: type(value) is int,
    "quote": lambda value: _bounded_text(value, 280),
    "reason": lambda value: _bounded_text(value, 400),
    "benefit": lambda value: _bounded_text(value, 400),
}


def _valid_fields(raw: Mapping[str, object]) -> TypeGuard[_Answer]:
    return set(raw) == set(_FIELD_CHECKS) and all(
        check(raw[key]) for key, check in _FIELD_CHECKS.items()
    )


def _answer(payload: object) -> _Answer | None:
    if not isinstance(payload, Mapping) or payload.get("status") != "ok":
        return None
    raw = payload.get("recommendation")
    return raw if isinstance(raw, Mapping) and _valid_fields(raw) else None


def _grounded(raw: _Answer, request: ReadingRequest) -> bool:
    offered = {item.content_id for item in request.readings}
    sources = {item.entry_id: item.content for item in request.sources}
    source = sources.get(raw["entry_id"], "")
    return raw["content_id"] in offered and raw["quote"] in source


def parse_reading_recommendation(
    payload: object, request: ReadingRequest
) -> ReadingRecommendation | None:
    """Independently verify the vault's menu choice and verbatim quote."""
    raw = _answer(payload)
    if raw is None or not _grounded(raw, request):
        return None
    return ReadingRecommendation(**raw)


@runtime_checkable
class ReadingRecommendationClient(Protocol):
    """Optional vault extension; older clients leave course invitations quiet."""

    async def recommend_reading(self, request: ReadingRequest) -> ReadingRecommendation | None:
        """Use configured keyless inference with no app-provider fallback."""
        ...
