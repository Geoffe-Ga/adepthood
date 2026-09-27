"""Fail-closed file-boundary tests for mounted service credentials."""

from __future__ import annotations

import os
from pathlib import Path
from typing import TYPE_CHECKING

import pytest

from services.secure_mounted_secret import (
    MAX_MOUNTED_SECRET_BYTES,
    read_secure_mounted_secret,
)

if TYPE_CHECKING:
    from collections.abc import Callable


_TOKEN = "mounted-bearer-" + "s" * 48


def _secure_file(path: Path, content: str = _TOKEN) -> Path:
    path.write_text(content, encoding="utf-8")
    path.chmod(0o400)
    return path


def test_valid_owner_only_regular_file_is_read_without_normalizing_token(
    tmp_path: Path,
) -> None:
    secret = _secure_file(tmp_path / "control", f"{_TOKEN}\n")

    assert read_secure_mounted_secret(str(secret)) == _TOKEN


@pytest.mark.parametrize("kind", ["symlink", "directory"])
def test_nonregular_or_linked_secret_path_fails_closed(tmp_path: Path, kind: str) -> None:
    secret = tmp_path / "control"
    if kind == "symlink":
        target = _secure_file(tmp_path / "target")
        secret.symlink_to(target)
    else:
        secret.mkdir()
        secret.chmod(0o400)

    assert read_secure_mounted_secret(str(secret)) is None


def test_relative_secret_path_fails_closed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _secure_file(tmp_path / "control")
    monkeypatch.chdir(tmp_path)

    assert read_secure_mounted_secret("control") is None


def test_invalid_absolute_path_fails_closed() -> None:
    assert read_secure_mounted_secret("/run/adepthood-secrets/control\0suffix") is None


@pytest.mark.parametrize("mode", [0o000, 0o440, 0o600, 0o640, 0o644])
def test_secret_mode_must_be_exactly_owner_read_only(tmp_path: Path, mode: int) -> None:
    secret = _secure_file(tmp_path / "control")
    secret.chmod(mode)

    assert read_secure_mounted_secret(str(secret)) is None


def test_secret_owner_must_match_the_effective_runtime_uid(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = _secure_file(tmp_path / "control")
    monkeypatch.setattr(
        "services.secure_mounted_secret.os.geteuid",
        lambda: secret.stat().st_uid + 1,
    )

    assert read_secure_mounted_secret(str(secret)) is None


@pytest.mark.parametrize(
    "content",
    [
        "",
        "\n",
        "   ",
        f" {_TOKEN}",
        f"{_TOKEN} ",
        f"{_TOKEN}\tpart",
        f"{_TOKEN}\x00part",
        f"{_TOKEN}\x7fpart",
        f"{_TOKEN}-snowman-\N{SNOWMAN}",
        f"{_TOKEN}\nsecond-line",
        f"{_TOKEN}\r\n",
        "not-utf8-\udcff",
    ],
)
def test_empty_multiline_or_invalid_utf8_secret_fails_closed(
    tmp_path: Path,
    content: str,
) -> None:
    secret = tmp_path / "control"
    if "\udcff" in content:
        secret.write_bytes(b"not-utf8-\xff")
        secret.chmod(0o400)
    else:
        _secure_file(secret, content)

    assert read_secure_mounted_secret(str(secret)) is None


def test_oversize_secret_fails_closed(tmp_path: Path) -> None:
    secret = _secure_file(tmp_path / "control", "s" * (MAX_MOUNTED_SECRET_BYTES + 1))

    assert read_secure_mounted_secret(str(secret)) is None


def test_path_swap_between_lstat_and_open_fails_closed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = _secure_file(tmp_path / "control")
    replacement = _secure_file(tmp_path / "replacement", "different-secret")
    real_open: Callable[..., int] = os.open
    swapped = False

    def swap_then_open(path: str, flags: int) -> int:
        nonlocal swapped
        if not swapped:
            swapped = True
            replacement.replace(secret)
        return real_open(path, flags)

    monkeypatch.setattr("services.secure_mounted_secret.os.open", swap_then_open)

    assert read_secure_mounted_secret(str(secret)) is None
