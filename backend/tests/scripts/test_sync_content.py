"""Tests for ``backend/scripts/sync_content.py`` (issue #391).

The sync script vendors a pinned ``aptitude-course`` commit into
``backend/content/``: resolve ref → SHA, download the GitHub tarball,
copy the published surface (``manifest.json`` + ``markdown/**``) via a
staging directory with an atomic swap, validate against the frozen
schema, and record the result in ``CONTENT_VERSION``. Everything that
touches the network is injected and mocked here — no real clone in CI.
"""

from __future__ import annotations

import io
import json
import shutil
import tarfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

import scripts.sync_content as sync_content_module
from scripts.sync_content import (
    SyncContentError,
    check,
    compute_tree_digest,
    main,
    read_content_version,
    resolve_ref,
    sync,
)

_SHA = "a" * 40
_REPO_DIR = Path(__file__).resolve().parents[3]
_SCHEMA_SRC = _REPO_DIR / "backend" / "content" / "manifest.schema.json"

_MANIFEST: dict[str, Any] = {
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
        }
    ],
    "site_resources": [],
}


def _make_tarball(files: dict[str, str], root: str = f"aptitude-course-{_SHA}") -> bytes:
    """Build an in-memory .tar.gz shaped like a GitHub codeload archive."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        for rel_path, text in files.items():
            data = text.encode()
            info = tarfile.TarInfo(name=f"{root}/{rel_path}")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def _content_tarball(manifest: dict[str, Any] | None = None) -> bytes:
    """A tarball holding a valid manifest plus its Markdown files."""
    payload = manifest if manifest is not None else _MANIFEST
    return _make_tarball(
        {
            "manifest.json": json.dumps(payload),
            "markdown/01-beige/01-survival.md": "# Survival\n",
            "README.md": "not part of the published surface\n",
        }
    )


@pytest.fixture
def content_dir(tmp_path: Path) -> Path:
    """A target content dir seeded with the preserved contract files."""
    target = tmp_path / "content"
    target.mkdir()
    shutil.copy(_SCHEMA_SRC, target / "manifest.schema.json")
    (target / "manifest.example.json").write_text("{}")
    return target


def _fetch_for(tarball: bytes) -> Callable[[str], bytes]:
    """A fake ``_http_get_bytes`` serving the API JSON and the tarball."""

    def fake_fetch(url: str) -> bytes:
        if "api.github.com" in url:
            return json.dumps({"sha": _SHA}).encode()
        return tarball

    return fake_fetch


# ── resolve_ref ─────────────────────────────────────────────────────────


def test_resolve_ref_passes_through_full_sha() -> None:
    def explode(url: str) -> bytes:
        raise AssertionError(f"unexpected network call: {url}")

    assert resolve_ref(_SHA, fetch=explode) == _SHA


def test_resolve_ref_resolves_branch_via_api() -> None:
    calls: list[str] = []

    def fake_fetch(url: str) -> bytes:
        calls.append(url)
        return json.dumps({"sha": _SHA}).encode()

    assert resolve_ref("main", fetch=fake_fetch) == _SHA
    assert len(calls) == 1
    assert "aptitude-course" in calls[0]
    assert calls[0].endswith("/commits/main")


def test_resolve_ref_rejects_malformed_api_payload() -> None:
    def fake_fetch(_url: str) -> bytes:
        return json.dumps({"nope": True}).encode()

    with pytest.raises(SyncContentError):
        resolve_ref("main", fetch=fake_fetch)


# ── retry / backoff ─────────────────────────────────────────────────────


def test_fetch_retries_with_backoff_then_succeeds(content_dir: Path) -> None:
    tarball = _content_tarball()
    sleeps: list[float] = []
    attempts: list[str] = []

    def flaky_fetch(url: str) -> bytes:
        attempts.append(url)
        if len(attempts) < 4:
            msg = "transient network failure"
            raise OSError(msg)
        return tarball

    sha = sync(_SHA, content_dir, fetch=flaky_fetch, sleep=sleeps.append)
    assert sha == _SHA
    assert sleeps == [2, 4, 8]


def test_fetch_gives_up_after_four_attempts(content_dir: Path) -> None:
    sleeps: list[float] = []
    attempts: list[str] = []

    def dead_fetch(url: str) -> bytes:
        attempts.append(url)
        msg = "network down"
        raise OSError(msg)

    with pytest.raises(SyncContentError):
        sync(_SHA, content_dir, fetch=dead_fetch, sleep=sleeps.append)
    assert len(attempts) == 4
    assert sleeps == [2, 4, 8]


# ── sync ────────────────────────────────────────────────────────────────


def test_sync_vendors_published_surface(content_dir: Path) -> None:
    sha = sync(_SHA, content_dir, fetch=_fetch_for(_content_tarball()), sleep=lambda _: None)

    assert sha == _SHA
    assert json.loads((content_dir / "manifest.json").read_text()) == _MANIFEST
    assert (content_dir / "markdown/01-beige/01-survival.md").read_text() == "# Survival\n"
    # Only the published surface is vendored.
    assert not (content_dir / "README.md").exists()
    # Preserved contract files survive the clean sync.
    assert (content_dir / "manifest.schema.json").exists()
    assert (content_dir / "manifest.example.json").exists()


def test_sync_removes_stale_files(content_dir: Path) -> None:
    stale = content_dir / "markdown" / "99-old" / "stale.md"
    stale.parent.mkdir(parents=True)
    stale.write_text("left over from a previous pin\n")

    sync(_SHA, content_dir, fetch=_fetch_for(_content_tarball()), sleep=lambda _: None)

    assert not stale.exists()


def test_sync_writes_content_version(content_dir: Path) -> None:
    sync(_SHA, content_dir, fetch=_fetch_for(_content_tarball()), sleep=lambda _: None)

    version = read_content_version(content_dir)
    assert version["sha"] == _SHA
    assert version["digest"] == compute_tree_digest(content_dir)
    assert "synced_at" in version


def test_sync_is_deterministic_for_a_ref(content_dir: Path) -> None:
    fetch = _fetch_for(_content_tarball())
    sync(_SHA, content_dir, fetch=fetch, sleep=lambda _: None)
    first = compute_tree_digest(content_dir)
    sync(_SHA, content_dir, fetch=fetch, sleep=lambda _: None)
    assert compute_tree_digest(content_dir) == first


def test_sync_aborts_on_schema_invalid_manifest(content_dir: Path) -> None:
    broken = json.loads(json.dumps(_MANIFEST))
    broken["chapters"][0].pop("title")
    sentinel = content_dir / "manifest.json"
    sentinel.write_text("pre-existing content must survive a failed sync")

    with pytest.raises(SyncContentError):
        sync(_SHA, content_dir, fetch=_fetch_for(_content_tarball(broken)), sleep=lambda _: None)

    # Failed sync must not partially overwrite the target.
    assert sentinel.read_text() == "pre-existing content must survive a failed sync"


def test_sync_aborts_on_tarball_missing_manifest(content_dir: Path) -> None:
    tarball = _make_tarball({"markdown/01-beige/01-survival.md": "# Survival\n"})
    with pytest.raises(SyncContentError):
        sync(_SHA, content_dir, fetch=_fetch_for(tarball), sleep=lambda _: None)


# ── check ───────────────────────────────────────────────────────────────


def test_check_passes_after_sync(content_dir: Path) -> None:
    sync(_SHA, content_dir, fetch=_fetch_for(_content_tarball()), sleep=lambda _: None)
    check(content_dir)  # must not raise


def test_check_fails_on_tampered_file(content_dir: Path) -> None:
    sync(_SHA, content_dir, fetch=_fetch_for(_content_tarball()), sleep=lambda _: None)
    (content_dir / "markdown/01-beige/01-survival.md").write_text("tampered\n")
    with pytest.raises(SyncContentError):
        check(content_dir)


def test_check_fails_without_content_version(content_dir: Path) -> None:
    with pytest.raises(SyncContentError):
        check(content_dir)


# ── CLI ─────────────────────────────────────────────────────────────────


def test_cli_sync_then_check(content_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sync_content_module, "_http_get_bytes", _fetch_for(_content_tarball()))
    monkeypatch.setattr(sync_content_module, "_sleep", lambda _: None)

    assert main(["--ref", _SHA, "--content-dir", str(content_dir)]) == 0
    assert main(["--check", "--content-dir", str(content_dir)]) == 0

    (content_dir / "manifest.json").write_text("{}")
    assert main(["--check", "--content-dir", str(content_dir)]) == 1


def test_cli_reports_sync_failure(content_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def dead_fetch(_url: str) -> bytes:
        msg = "network down"
        raise OSError(msg)

    monkeypatch.setattr(sync_content_module, "_http_get_bytes", dead_fetch)
    monkeypatch.setattr(sync_content_module, "_sleep", lambda _: None)

    assert main(["--ref", _SHA, "--content-dir", str(content_dir)]) == 1
