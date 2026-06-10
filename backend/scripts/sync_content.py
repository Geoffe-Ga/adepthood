"""Vendor a pinned ``aptitude-course`` commit into ``backend/content/``.

Issue #391 (epic #388, ADR 0001): the Railway image must carry the course
content with no runtime network dependency, so this script is the single
command that materialises it:

    python -m scripts.sync_content --ref <sha-or-tag>
    python -m scripts.sync_content --check          # CI drift gate

Fetch strategy — **GitHub tarball, not git**: the script downloads
``codeload.github.com/<repo>/tar.gz/<sha>``, which is shallow by
construction, needs no git binary or credentials (the content repo is
public), and resolves branch/tag refs to a concrete SHA via the GitHub
commits API first so the vendored state is always pinned to a commit.

Sync semantics — **clean sync via atomic swap**: the published surface
(``manifest.json`` + ``markdown/**``) is staged in a sibling temp
directory together with the preserved adepthood-owned contract files
(``manifest.schema.json``, ``manifest.example.json``), validated against
the schema, stamped with ``CONTENT_VERSION`` (resolved SHA, ISO
timestamp, tree digest), and only then swapped into place with two
renames. A failed sync never partially overwrites the target.

Vendoring policy — **``backend/content/`` is committed** (not built at
deploy time): the image is reproducible from the repo alone and every
content pin bump is a reviewable diff. The directory is marked
``linguist-vendored`` in ``.gitattributes`` so it stays out of language
stats and review noise.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import shutil
import sys
import tarfile
import tempfile
import time
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError

#: The public content repository this script vendors from (no token needed).
CONTENT_REPO = "Geoffe-Ga/aptitude-course"

#: Default ref when ``--ref`` is omitted. Deliberately a moving branch for
#: bootstrap convenience; deployments should always pass an explicit pin.
DEFAULT_REF = "main"

#: Files owned by *this* repo that a clean sync must never remove — the
#: frozen contract (issue #389) lives beside the vendored content.
PRESERVED_FILES = ("manifest.schema.json", "manifest.example.json")

#: The audit-trail file recording what is vendored.
CONTENT_VERSION_FILE = "CONTENT_VERSION"

#: Backoff schedule per repo git conventions: 4 attempts, 2s/4s/8s/16s.
#: (The 16s slot is reached only if a 5th attempt existed; with 4 attempts
#: the sleeps actually taken are 2/4/8.)
RETRY_DELAYS_SECONDS = (2, 4, 8, 16)
MAX_ATTEMPTS = 4

_DEFAULT_CONTENT_DIR = Path(__file__).resolve().parents[1] / "content"
_FULL_SHA_RE = re.compile(r"^[0-9a-f]{40}$")

FetchBytes = Callable[[str], bytes]
Sleep = Callable[[float], None]


class SyncContentError(Exception):
    """The sync or drift check failed; the target directory is untouched."""


def _http_get_bytes(url: str) -> bytes:
    """Fetch ``url`` and return the response body (module-level for mocking)."""
    response = httpx.get(url, follow_redirects=True, timeout=30)
    response.raise_for_status()
    return response.content


def _sleep(seconds: float) -> None:
    """Module-level sleep indirection so tests can run without waiting."""
    time.sleep(seconds)


def _fetch_with_retry(url: str, *, fetch: FetchBytes, sleep: Sleep) -> bytes:
    """Fetch with exponential backoff; raise after ``MAX_ATTEMPTS`` failures."""
    last_error: Exception | None = None
    for attempt in range(MAX_ATTEMPTS):
        try:
            return fetch(url)
        except (OSError, httpx.HTTPError) as exc:
            last_error = exc
            if attempt < MAX_ATTEMPTS - 1:
                sleep(RETRY_DELAYS_SECONDS[attempt])
    msg = f"failed to fetch {url} after {MAX_ATTEMPTS} attempts: {last_error}"
    raise SyncContentError(msg) from last_error


def resolve_ref(
    ref: str,
    *,
    fetch: FetchBytes | None = None,
    sleep: Sleep | None = None,
) -> str:
    """Resolve a branch/tag/short ref to a full commit SHA.

    A 40-hex ref is already a pin and passes through without touching the
    network; anything else is resolved via the GitHub commits API.
    """
    if _FULL_SHA_RE.fullmatch(ref):
        return ref
    url = f"https://api.github.com/repos/{CONTENT_REPO}/commits/{ref}"
    body = _fetch_with_retry(url, fetch=fetch or _http_get_bytes, sleep=sleep or _sleep)
    try:
        payload = json.loads(body)
        sha = payload["sha"]
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        msg = f"could not resolve ref {ref!r}: unexpected API response"
        raise SyncContentError(msg) from exc
    if not isinstance(sha, str) or not _FULL_SHA_RE.fullmatch(sha):
        msg = f"could not resolve ref {ref!r}: API returned malformed sha {sha!r}"
        raise SyncContentError(msg)
    return sha


def compute_tree_digest(content_dir: Path) -> str:
    """SHA-256 over the vendored surface (paths + bytes), order-independent.

    ``CONTENT_VERSION`` and the preserved contract files are excluded so the
    digest covers exactly what the sync vendored — the value is written into
    ``CONTENT_VERSION`` and recomputed by ``--check``.
    """
    excluded = {CONTENT_VERSION_FILE, *PRESERVED_FILES}
    digest = hashlib.sha256()
    files = sorted(
        path
        for path in content_dir.rglob("*")
        if path.is_file() and path.relative_to(content_dir).as_posix() not in excluded
    )
    for path in files:
        digest.update(path.relative_to(content_dir).as_posix().encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return f"sha256:{digest.hexdigest()}"


def read_content_version(content_dir: Path) -> dict[str, str]:
    """Parse ``CONTENT_VERSION`` into a dict; raise if missing or malformed."""
    path = content_dir / CONTENT_VERSION_FILE
    try:
        text = path.read_text()
    except FileNotFoundError as exc:
        msg = f"{CONTENT_VERSION_FILE} not found in {content_dir} — run a sync first"
        raise SyncContentError(msg) from exc
    entries: dict[str, str] = {}
    for line in text.splitlines():
        key, separator, value = line.partition(": ")
        if separator and key:
            entries[key] = value
    if "sha" not in entries or "digest" not in entries:
        msg = f"{path} is malformed: expected 'sha' and 'digest' entries"
        raise SyncContentError(msg)
    return entries


def _extract_tarball_root(tarball: bytes, destination: Path) -> Path:
    """Extract a codeload archive and return its single top-level directory."""
    try:
        with tarfile.open(fileobj=io.BytesIO(tarball), mode="r:gz") as archive:
            archive.extractall(destination, filter="data")
    except (tarfile.TarError, OSError) as exc:
        msg = f"could not extract content tarball: {exc}"
        raise SyncContentError(msg) from exc
    roots = [entry for entry in destination.iterdir() if entry.is_dir()]
    if len(roots) != 1:
        msg = f"expected a single top-level directory in the tarball, found {len(roots)}"
        raise SyncContentError(msg)
    return roots[0]


def _stage_published_surface(source_root: Path, staging: Path, content_dir: Path) -> None:
    """Copy the published surface + preserved contract files into ``staging``."""
    manifest_src = source_root / "manifest.json"
    if not manifest_src.is_file():
        msg = "content tarball has no manifest.json at its root"
        raise SyncContentError(msg)
    shutil.copy(manifest_src, staging / "manifest.json")
    markdown_src = source_root / "markdown"
    if markdown_src.is_dir():
        shutil.copytree(markdown_src, staging / "markdown")
    for name in PRESERVED_FILES:
        preserved = content_dir / name
        if preserved.is_file():
            shutil.copy(preserved, staging / name)


def _validate_staged_manifest(staging: Path) -> None:
    """Validate the staged manifest against the staged copy of the schema."""
    schema_path = staging / "manifest.schema.json"
    if not schema_path.is_file():
        msg = "manifest.schema.json is missing — cannot validate the vendored manifest"
        raise SyncContentError(msg)
    schema: Any = json.loads(schema_path.read_text())
    try:
        manifest: Any = json.loads((staging / "manifest.json").read_text())
    except json.JSONDecodeError as exc:
        msg = f"vendored manifest.json is not valid JSON: {exc}"
        raise SyncContentError(msg) from exc
    try:
        Draft202012Validator(schema).validate(manifest)
    except ValidationError as exc:
        msg = f"vendored manifest violates the contract: {exc.message}"
        raise SyncContentError(msg) from exc


def _swap_into_place(staging: Path, content_dir: Path) -> None:
    """Replace ``content_dir`` with ``staging`` via two renames."""
    retired = content_dir.with_name(content_dir.name + ".old")
    if retired.exists():
        shutil.rmtree(retired)
    if content_dir.exists():
        content_dir.rename(retired)
    staging.rename(content_dir)
    if retired.exists():
        shutil.rmtree(retired)


def sync(
    ref: str,
    content_dir: Path | None = None,
    *,
    fetch: FetchBytes | None = None,
    sleep: Sleep | None = None,
) -> str:
    """Vendor ``ref`` of the content repo into ``content_dir``; return the SHA.

    The target is only ever replaced wholesale after the staged tree has
    passed schema validation — a failure at any step leaves it untouched.
    """
    target = (content_dir or _DEFAULT_CONTENT_DIR).resolve()
    fetch_impl = fetch or _http_get_bytes
    sleep_impl = sleep or _sleep
    sha = resolve_ref(ref, fetch=fetch_impl, sleep=sleep_impl)
    tarball_url = f"https://codeload.github.com/{CONTENT_REPO}/tar.gz/{sha}"
    tarball = _fetch_with_retry(tarball_url, fetch=fetch_impl, sleep=sleep_impl)
    with tempfile.TemporaryDirectory(dir=target.parent) as workspace:
        workspace_path = Path(workspace)
        source_root = _extract_tarball_root(tarball, workspace_path / "extracted")
        staging = workspace_path / "staging"
        staging.mkdir()
        _stage_published_surface(source_root, staging, target)
        _validate_staged_manifest(staging)
        digest = compute_tree_digest(staging)
        synced_at = datetime.now(UTC).isoformat()
        version_text = f"sha: {sha}\nsynced_at: {synced_at}\ndigest: {digest}\n"
        (staging / CONTENT_VERSION_FILE).write_text(version_text)
        _swap_into_place(staging, target)
    return sha


def check(content_dir: Path | None = None) -> None:
    """Verify ``content_dir`` matches its ``CONTENT_VERSION`` (CI drift gate).

    Read-only: recomputes the tree digest and compares it to the recorded
    one. Raises :class:`SyncContentError` on drift or a missing stamp.
    """
    target = (content_dir or _DEFAULT_CONTENT_DIR).resolve()
    version = read_content_version(target)
    actual = compute_tree_digest(target)
    if actual != version["digest"]:
        msg = (
            f"content drift detected in {target}: digest {actual} does not "
            f"match CONTENT_VERSION ({version['digest']}) — re-run the sync"
        )
        raise SyncContentError(msg)


def main(argv: list[str] | None = None) -> int:
    """CLI entry point. Returns 0 on success, 1 on any sync/check failure."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--ref",
        default=DEFAULT_REF,
        help=f"aptitude-course ref (sha/tag/branch) to vendor (default: {DEFAULT_REF})",
    )
    parser.add_argument(
        "--content-dir",
        type=Path,
        default=_DEFAULT_CONTENT_DIR,
        help="target content directory (default: backend/content)",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify the vendored content matches CONTENT_VERSION; mutate nothing",
    )
    args = parser.parse_args(argv)
    try:
        if args.check:
            check(args.content_dir)
            sys.stdout.write("content is in sync with CONTENT_VERSION\n")
        else:
            sha = sync(args.ref, args.content_dir)
            sys.stdout.write(f"vendored {CONTENT_REPO}@{sha} into {args.content_dir}\n")
    except SyncContentError as exc:
        sys.stderr.write(f"{exc}\n")
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover — exercised via tests/CLI
    sys.exit(main())
