"""Strict, bounded reader for credentials supplied through runtime file mounts."""

from __future__ import annotations

import os
import stat
from contextlib import suppress
from pathlib import Path
from typing import Final

MAX_MOUNTED_SECRET_BYTES: Final[int] = 4096
_REQUIRED_MODE: Final[int] = stat.S_IRUSR
_IDENTITY_FIELDS: Final[tuple[str, ...]] = (
    "st_dev",
    "st_ino",
    "st_uid",
    "st_mode",
    "st_size",
    "st_mtime_ns",
    "st_ctime_ns",
)


def _is_secure_regular_file(metadata: os.stat_result, *, effective_uid: int) -> bool:
    """Accept only one owner-bound regular file with no group/other access."""
    return (
        stat.S_ISREG(metadata.st_mode)
        and metadata.st_uid == effective_uid
        and stat.S_IMODE(metadata.st_mode) == _REQUIRED_MODE
        and metadata.st_size <= MAX_MOUNTED_SECRET_BYTES
    )


def _same_file_and_contents(
    before: os.stat_result,
    after: os.stat_result,
) -> bool:
    """Detect path replacement or mutation across the bounded read."""
    return all(getattr(before, field) == getattr(after, field) for field in _IDENTITY_FIELDS)


def _read_bounded(fd: int) -> bytes | None:
    """Read through EOF while retaining one byte with which to detect overflow."""
    chunks: list[bytes] = []
    remaining = MAX_MOUNTED_SECRET_BYTES + 1
    while remaining:
        chunk = os.read(fd, remaining)
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    payload = b"".join(chunks)
    return payload if len(payload) <= MAX_MOUNTED_SECRET_BYTES else None


def _decode_one_line(payload: bytes) -> str | None:
    """Decode one HTTP-header-safe ASCII bearer, allowing one terminal LF."""
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError:
        return None
    text = text.removesuffix("\n")
    if not text or not all("!" <= character <= "~" for character in text):
        return None
    return text


def _close_quietly(fd: int) -> None:
    """Best-effort close without turning an invalid credential into an exception."""
    with suppress(OSError):
        os.close(fd)


def _secure_path_metadata(path: str) -> tuple[os.stat_result, int] | None:
    """Inspect one absolute path before open without following a final link."""
    if not path or not Path(path).is_absolute():
        return None
    try:
        before = os.lstat(path)
        effective_uid = os.geteuid()
    except (OSError, ValueError):
        return None
    if not _is_secure_regular_file(before, effective_uid=effective_uid):
        return None
    return before, effective_uid


def _open_without_following(path: str) -> int | None:
    """Open read-only with close-on-exec and no-final-symlink where available."""
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        return os.open(path, flags)
    except (OSError, ValueError):
        return None


def _verified_descriptor_metadata(
    fd: int,
    *,
    before: os.stat_result,
    effective_uid: int,
) -> os.stat_result | None:
    """Prove the opened descriptor is the same secure file inspected by path."""
    try:
        opened = os.fstat(fd)
    except OSError:
        return None
    if not _is_secure_regular_file(opened, effective_uid=effective_uid):
        return None
    return opened if _same_file_and_contents(before, opened) else None


def _open_verified(path: str) -> tuple[int, os.stat_result] | None:
    """Open one secure path and bind the descriptor to its inspected inode."""
    inspected = _secure_path_metadata(path)
    if inspected is None:
        return None
    before, effective_uid = inspected
    fd = _open_without_following(path)
    if fd is None:
        return None
    opened = _verified_descriptor_metadata(fd, before=before, effective_uid=effective_uid)
    if opened is None:
        _close_quietly(fd)
        return None
    return fd, opened


def read_secure_mounted_secret(path: str) -> str | None:
    """Read an owner-only mounted secret without following or racing links."""
    verified = _open_verified(path)
    if verified is None:
        return None
    fd, opened = verified
    try:
        payload = _read_bounded(fd)
        after = os.fstat(fd)
    except OSError:
        return None
    finally:
        _close_quietly(fd)
    if payload is None or not _same_file_and_contents(opened, after):
        return None
    return _decode_one_line(payload)
