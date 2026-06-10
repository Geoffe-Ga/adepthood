"""Local-file content repository for the git-content pipeline.

Issue #390 (epic #388): loads the vendored ``backend/content/manifest.json``
once, validates it against the frozen contract from issue #389
(``manifest.schema.json``, ADR 0001), and serves chapter metadata plus raw
Markdown bodies from disk.  Exposes a lazy singleton plus ``*_for_tests``
setters so tests can swap the instance without touching privates.

Read-only by design: this service never writes to the content directory.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError

# The manifest's schema ships with the app (it is code, not content), so a
# mis-vendored content directory cannot substitute a permissive schema.
_SCHEMA_PATH = Path(__file__).resolve().parents[2] / "content" / "manifest.schema.json"

# Default content root: ``backend/content``, overridable via CONTENT_DIR
# for deployments that vendor content elsewhere in the image.
_DEFAULT_CONTENT_DIR = Path(__file__).resolve().parents[2] / "content"

# Major version of the manifest contract this reader understands.  ADR 0001
# change control: reject manifests whose major version differs.
_SUPPORTED_SCHEMA_MAJOR = 1

# Site resources are not chapters, so they get a content_type outside the
# chapter enum (chapter|essay|prompt|video) — deliberately distinct.
_RESOURCE_CONTENT_TYPE: Final[str] = "resource"

#: Audit-trail stamp written by ``scripts/sync_content.py`` (issue #391).
_CONTENT_VERSION_FILE: Final[str] = "CONTENT_VERSION"


class ContentRepositoryError(Exception):
    """The content directory or manifest is missing, invalid, or unsafe."""


class ContentNotFoundError(ContentRepositoryError):
    """No chapter / resource with the requested identifier exists."""


@dataclass(frozen=True)
class ChapterMeta:
    """One chapter's manifest metadata (the index entry, not the body)."""

    id: str
    stage: int
    chapter: int
    slug: str
    title: str
    content_type: str
    release_day: int
    order: int
    path: str
    summary: str | None = None


@dataclass(frozen=True)
class SiteResourceMeta:
    """One free site resource's manifest metadata (issue #395).

    Deliberately omits the manifest ``path`` — body reads go through
    :meth:`ContentRepository.read_resource_body`, which resolves the path
    internally with the traversal guard; no caller needs it raw.
    """

    slug: str
    title: str
    description: str


@dataclass(frozen=True)
class ContentBody:
    """A rendered-ready body: raw Markdown plus the metadata the UI shows."""

    body: str
    title: str
    content_type: str


def _content_dir_from_env() -> Path:
    """Resolve the content root from ``CONTENT_DIR`` (default: backend/content)."""
    override = os.getenv("CONTENT_DIR")
    return Path(override) if override else _DEFAULT_CONTENT_DIR


def _parse_stamp_entries(text: str) -> dict[str, str]:
    """Parse ``key: value`` lines from a ``CONTENT_VERSION`` stamp."""
    entries: dict[str, str] = {}
    for line in text.splitlines():
        # partition stops at the FIRST ": ", so "digest: sha256:..." survives.
        key, separator, value = line.partition(": ")
        if separator and key:
            entries[key] = value
    return entries


def content_version_info(content_dir: Path | None = None) -> dict[str, str] | None:
    """Parse the vendored ``CONTENT_VERSION`` stamp, or ``None`` if absent.

    Observability helper (issue #397): boot logging and ``/health`` report
    which content pin is live.  Tolerant by design — a missing or
    malformed stamp returns ``None`` rather than raising, because the
    caller is a probe, not a gate (the CI drift check in
    ``scripts/sync_content.py`` is the gate).
    """
    path = (content_dir or _content_dir_from_env()) / _CONTENT_VERSION_FILE
    try:
        text = path.read_text()
    except OSError:
        return None
    entries = _parse_stamp_entries(text)
    return entries if "sha" in entries else None


def _load_json(path: Path, description: str) -> dict[str, Any]:
    """Read and parse a JSON object file, mapping every failure to a typed error."""
    try:
        with path.open() as f:
            data: object = json.load(f)
    except FileNotFoundError as exc:
        msg = f"{description} not found at {path}"
        raise ContentRepositoryError(msg) from exc
    except json.JSONDecodeError as exc:
        msg = f"{description} at {path} is not valid JSON"
        raise ContentRepositoryError(msg) from exc
    if not isinstance(data, dict):
        msg = f"{description} at {path} must be a JSON object"
        raise ContentRepositoryError(msg)
    return data


def _index_chapters(raw_chapters: list[dict[str, Any]]) -> dict[str, ChapterMeta]:
    """Index chapters by id, rejecting duplicates (the schema cannot)."""
    chapters: dict[str, ChapterMeta] = {}
    for raw in raw_chapters:
        meta = ChapterMeta(
            id=raw["id"],
            stage=raw["stage"],
            chapter=raw["chapter"],
            slug=raw["slug"],
            title=raw["title"],
            content_type=raw["content_type"],
            release_day=raw["release_day"],
            order=raw["order"],
            path=raw["path"],
            summary=raw.get("summary"),
        )
        if meta.id in chapters:
            msg = f"duplicate chapter id in manifest: {meta.id!r}"
            raise ContentRepositoryError(msg)
        chapters[meta.id] = meta
    return chapters


def _index_resources(raw_resources: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Index site resources by slug, rejecting duplicates (the schema cannot)."""
    resources: dict[str, dict[str, Any]] = {}
    for resource in raw_resources:
        if resource["slug"] in resources:
            msg = f"duplicate site resource slug in manifest: {resource['slug']!r}"
            raise ContentRepositoryError(msg)
        resources[resource["slug"]] = resource
    return resources


class ContentRepository:
    """Parse-once reader over the vendored content directory.

    Construction loads and validates the manifest; every read after that is
    an in-memory index lookup plus (for bodies) one local file read.  No
    TTL cache is needed — the files are local and immutable per deploy.
    """

    def __init__(self, content_dir: Path | None = None) -> None:
        """Load and validate the manifest under ``content_dir`` (or CONTENT_DIR)."""
        self._content_dir = (content_dir or _content_dir_from_env()).resolve()
        manifest = self._load_and_validate_manifest()
        self._chapters = _index_chapters(manifest["chapters"])
        self._resources = _index_resources(manifest["site_resources"])

    def _load_and_validate_manifest(self) -> dict[str, Any]:
        """Load ``manifest.json`` and enforce the issue #389 contract."""
        schema = _load_json(_SCHEMA_PATH, "manifest schema")
        manifest = _load_json(self._content_dir / "manifest.json", "content manifest")
        try:
            Draft202012Validator(schema).validate(manifest)
        except ValidationError as exc:
            msg = f"content manifest violates the contract: {exc.message}"
            raise ContentRepositoryError(msg) from exc
        major = int(manifest["schema_version"].split(".")[0])
        if major != _SUPPORTED_SCHEMA_MAJOR:
            msg = (
                f"content manifest schema_version major {major} is not the "
                f"supported major {_SUPPORTED_SCHEMA_MAJOR} (ADR 0001 change control)"
            )
            raise ContentRepositoryError(msg)
        return manifest

    def _read_markdown(self, rel_path: str) -> str:
        """Read a Markdown file, enforcing the in-directory guard.

        The LFI guard analogous to the old client's ``_validate_url``: a
        manifest ``path`` must resolve INSIDE the content directory, so a
        compromised or mis-generated manifest cannot read arbitrary files
        from the image.
        """
        resolved = (self._content_dir / rel_path).resolve()
        if not resolved.is_relative_to(self._content_dir):
            msg = f"content path escapes the content directory: {rel_path!r}"
            raise ContentRepositoryError(msg)
        try:
            return resolved.read_text()
        except FileNotFoundError as exc:
            msg = f"manifest references a missing file: {rel_path!r}"
            raise ContentRepositoryError(msg) from exc

    def list_chapters(self) -> list[ChapterMeta]:
        """Every chapter, ordered by (stage, order, chapter, id)."""
        return sorted(
            self._chapters.values(),
            key=lambda c: (c.stage, c.order, c.chapter, c.id),
        )

    def get_chapter(self, content_id: str) -> ChapterMeta | None:
        """The chapter with ``content_id``, or ``None`` when unknown.

        Optional lookup — returns ``None`` rather than raising, unlike
        :meth:`read_body`, which treats an unknown id as
        :class:`ContentNotFoundError` because fetching a body implies the
        caller expects it to exist.
        """
        return self._chapters.get(content_id)

    def read_body(self, content_id: str) -> ContentBody:
        """Raw Markdown + display metadata for a chapter, by id."""
        meta = self._chapters.get(content_id)
        if meta is None:
            msg = f"unknown content id: {content_id!r}"
            raise ContentNotFoundError(msg)
        return ContentBody(
            body=self._read_markdown(meta.path),
            title=meta.title,
            content_type=meta.content_type,
        )

    def list_resources(self) -> list[SiteResourceMeta]:
        """Every site resource, in manifest order (the UI display order).

        Direct ``raw[...]`` access is safe: the schema requires every
        resource field and the manifest was validated at construction.
        """
        return [
            SiteResourceMeta(
                slug=raw["slug"],
                title=raw["title"],
                description=raw["description"],
            )
            for raw in self._resources.values()
        ]

    def read_resource_body(self, slug: str) -> ContentBody:
        """Raw Markdown + title for a free site resource, by slug."""
        resource = self._resources.get(slug)
        if resource is None:
            msg = f"unknown site resource slug: {slug!r}"
            raise ContentNotFoundError(msg)
        return ContentBody(
            body=self._read_markdown(resource["path"]),
            title=resource["title"],
            content_type=_RESOURCE_CONTENT_TYPE,
        )


# Mutable container so the instance can be replaced without ``global``
# (and therefore without a ruff PLW0603 suppression).
_state: dict[str, ContentRepository | None] = {"repository": None}


def get_content_repository() -> ContentRepository:
    """Return the process-wide repository, constructed lazily.

    Lazy construction means a test run with no vendored content never
    touches the filesystem unless a content endpoint is actually hit.
    """
    repository = _state["repository"]
    if repository is None:
        repository = ContentRepository()
        _state["repository"] = repository
    return repository


def set_content_repository_for_tests(repository: ContentRepository | None) -> None:
    """Replace (or clear) the process-wide repository.

    Public on purpose — keeps the test contract on the module's public
    API instead of a private attribute.
    """
    _state["repository"] = repository


def reset_content_repository_for_tests() -> None:
    """Drop the singleton so the next caller builds a fresh repository."""
    set_content_repository_for_tests(None)
