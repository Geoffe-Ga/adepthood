"""Unit tests for the local-file ContentRepository (issue #390).

The repository is the seam that replaces ``SquarespaceClient``: it loads
``manifest.json`` once, validates it against the frozen contract from
issue #389, and serves chapter metadata plus raw Markdown bodies from the
vendored content directory.  These tests cover the full public surface —
including the traversal guard that stands in for the old client's
``_validate_url`` SSRF protection.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from services.content_repository import (
    ContentNotFoundError,
    ContentRepository,
    ContentRepositoryError,
    get_content_repository,
    reset_content_repository_for_tests,
    set_content_repository_for_tests,
)

_VALID_MANIFEST: dict[str, Any] = {
    "schema_version": "1.0.0",
    "chapters": [
        {
            "id": "beige-1",
            "stage": 1,
            "chapter": 1,
            "slug": "survival",
            "title": "Survival",
            "content_type": "chapter",
            "release_day": 0,
            "order": 1,
            "path": "markdown/01-beige/01-survival.md",
        },
        {
            "id": "beige-2",
            "stage": 1,
            "chapter": 2,
            "slug": "breath",
            "title": "Breath as Anchor",
            "content_type": "essay",
            "release_day": 3,
            "order": 2,
            "path": "markdown/01-beige/02-breath.md",
        },
    ],
    "site_resources": [
        {
            "slug": "getting-started",
            "title": "Getting Started",
            "description": "Orientation guide.",
            "path": "markdown/site/getting-started.md",
        }
    ],
}


def _write_content_dir(root: Path, manifest: dict[str, Any]) -> Path:
    """Materialise a content dir with the manifest and matching Markdown files."""
    root.mkdir(parents=True, exist_ok=True)
    (root / "manifest.json").write_text(json.dumps(manifest))
    for chapter in manifest.get("chapters", []):
        md = root / chapter["path"]
        md.parent.mkdir(parents=True, exist_ok=True)
        md.write_text(f"# {chapter.get('title', chapter['id'])}\n\nBody of {chapter['id']}.\n")
    for resource in manifest.get("site_resources", []):
        md = root / resource["path"]
        md.parent.mkdir(parents=True, exist_ok=True)
        md.write_text(f"# {resource['title']}\n")
    return root


@pytest.fixture
def content_dir(tmp_path: Path) -> Path:
    return _write_content_dir(tmp_path / "content", copy.deepcopy(_VALID_MANIFEST))


# ── Happy path ──────────────────────────────────────────────────────────


def test_lists_chapters_in_stage_then_order(content_dir: Path) -> None:
    repo = ContentRepository(content_dir)
    chapters = repo.list_chapters()
    assert [c.id for c in chapters] == ["beige-1", "beige-2"]
    assert chapters[0].title == "Survival"
    assert chapters[0].content_type == "chapter"


def test_get_chapter_by_id(content_dir: Path) -> None:
    repo = ContentRepository(content_dir)
    chapter = repo.get_chapter("beige-2")
    assert chapter is not None
    assert chapter.slug == "breath"
    assert repo.get_chapter("nope") is None


def test_read_body_returns_markdown_with_metadata(content_dir: Path) -> None:
    repo = ContentRepository(content_dir)
    body = repo.read_body("beige-1")
    assert body.title == "Survival"
    assert body.content_type == "chapter"
    assert "Body of beige-1." in body.body


def test_read_resource_body(content_dir: Path) -> None:
    repo = ContentRepository(content_dir)
    body = repo.read_resource_body("getting-started")
    assert body.title == "Getting Started"
    assert "# Getting Started" in body.body


# ── Error paths ─────────────────────────────────────────────────────────


def test_unknown_chapter_id_raises_not_found(content_dir: Path) -> None:
    repo = ContentRepository(content_dir)
    with pytest.raises(ContentNotFoundError):
        repo.read_body("missing-id")


def test_unknown_resource_slug_raises_not_found(content_dir: Path) -> None:
    repo = ContentRepository(content_dir)
    with pytest.raises(ContentNotFoundError):
        repo.read_resource_body("missing-slug")


def test_duplicate_chapter_id_raises_repository_error(tmp_path: Path) -> None:
    """A duplicate id passes the schema but must not silently drop a chapter."""
    doubled = copy.deepcopy(_VALID_MANIFEST)
    doubled["chapters"][1]["id"] = doubled["chapters"][0]["id"]
    root = _write_content_dir(tmp_path / "content", doubled)
    with pytest.raises(ContentRepositoryError):
        ContentRepository(root)


def test_duplicate_resource_slug_raises_repository_error(tmp_path: Path) -> None:
    """Duplicate slugs must fail loudly, consistent with chapter ids."""
    doubled = copy.deepcopy(_VALID_MANIFEST)
    doubled["site_resources"].append(dict(doubled["site_resources"][0]))
    root = _write_content_dir(tmp_path / "content", doubled)
    with pytest.raises(ContentRepositoryError):
        ContentRepository(root)


def test_missing_markdown_for_known_resource_raises_repository_error(
    content_dir: Path,
) -> None:
    (content_dir / "markdown/site/getting-started.md").unlink()
    repo = ContentRepository(content_dir)
    with pytest.raises(ContentRepositoryError):
        repo.read_resource_body("getting-started")


def test_malformed_json_manifest_raises_repository_error(tmp_path: Path) -> None:
    root = tmp_path / "content"
    root.mkdir()
    (root / "manifest.json").write_text("{not valid json")
    with pytest.raises(ContentRepositoryError):
        ContentRepository(root)


def test_non_object_json_manifest_raises_repository_error(tmp_path: Path) -> None:
    root = tmp_path / "content"
    root.mkdir()
    (root / "manifest.json").write_text("[]")
    with pytest.raises(ContentRepositoryError):
        ContentRepository(root)


def test_missing_manifest_raises_repository_error(tmp_path: Path) -> None:
    (tmp_path / "empty").mkdir()
    with pytest.raises(ContentRepositoryError):
        ContentRepository(tmp_path / "empty")


def test_invalid_manifest_raises_repository_error(tmp_path: Path) -> None:
    broken = copy.deepcopy(_VALID_MANIFEST)
    broken["chapters"][0].pop("title")
    root = _write_content_dir(tmp_path / "content", broken)
    with pytest.raises(ContentRepositoryError):
        ContentRepository(root)


def test_wrong_major_schema_version_is_rejected(tmp_path: Path) -> None:
    """ADR 0001 change control: readers reject a different major version."""
    future = copy.deepcopy(_VALID_MANIFEST)
    future["schema_version"] = "2.0.0"
    root = _write_content_dir(tmp_path / "content", future)
    with pytest.raises(ContentRepositoryError):
        ContentRepository(root)


def test_path_traversal_is_rejected(tmp_path: Path) -> None:
    """The LFI guard analogous to the old client's _validate_url."""
    evil = copy.deepcopy(_VALID_MANIFEST)
    evil["chapters"][0]["path"] = "../../etc/passwd"
    root = _write_content_dir(tmp_path / "content", evil)
    # The escape target genuinely exists, so only the guard stops the read.
    outside = tmp_path / "etc"
    outside.mkdir(parents=True, exist_ok=True)
    (outside / "passwd").write_text("root:x:0:0\n")
    repo = ContentRepository(root)
    with pytest.raises(ContentRepositoryError):
        repo.read_body("beige-1")


def test_missing_markdown_for_known_id_raises_repository_error(content_dir: Path) -> None:
    (content_dir / "markdown/01-beige/01-survival.md").unlink()
    repo = ContentRepository(content_dir)
    with pytest.raises(ContentRepositoryError):
        repo.read_body("beige-1")


def test_list_resources_in_manifest_order(content_dir: Path) -> None:
    repo = ContentRepository(content_dir)
    resources = repo.list_resources()
    assert [r.slug for r in resources] == ["getting-started"]
    assert resources[0].title == "Getting Started"
    assert resources[0].description == "Orientation guide."


def test_list_resources_empty_manifest(tmp_path: Path) -> None:
    manifest: dict[str, Any] = {"schema_version": "1.0.0", "chapters": [], "site_resources": []}
    root = _write_content_dir(tmp_path / "content", manifest)
    assert ContentRepository(root).list_resources() == []


def test_resource_missing_description_is_rejected_at_construction(tmp_path: Path) -> None:
    """A sparse resource entry never reaches ``list_resources()``.

    The schema requires every resource field (slug/title/description/path),
    so construction fails validation first — direct ``raw[...]`` access in
    ``list_resources`` cannot KeyError.
    """
    sparse = copy.deepcopy(_VALID_MANIFEST)
    del sparse["site_resources"][0]["description"]
    root = _write_content_dir(tmp_path / "content", sparse)
    with pytest.raises(ContentRepositoryError):
        ContentRepository(root)


# ── Singleton trio ──────────────────────────────────────────────────────


def test_singleton_set_and_reset_for_tests(content_dir: Path) -> None:
    custom = ContentRepository(content_dir)
    set_content_repository_for_tests(custom)
    try:
        assert get_content_repository() is custom
    finally:
        reset_content_repository_for_tests()


def test_lazy_singleton_builds_from_content_dir_env(
    content_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """First call constructs from CONTENT_DIR; later calls reuse the instance."""
    monkeypatch.setenv("CONTENT_DIR", str(content_dir))
    reset_content_repository_for_tests()
    try:
        first = get_content_repository()
        assert get_content_repository() is first
        assert [c.id for c in first.list_chapters()] == ["beige-1", "beige-2"]
    finally:
        reset_content_repository_for_tests()
