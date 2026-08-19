"""Pins the contract of the detached git environment helper."""

from __future__ import annotations

import os

import pytest

from tests.helpers.git_env import detached_git_env


def test_every_inherited_git_variable_is_stripped(monkeypatch: pytest.MonkeyPatch) -> None:
    """The three variables git exports into hooks must not survive.

    Args:
        monkeypatch: Used to plant the variables a hook would export.
    """
    monkeypatch.setenv("GIT_DIR", "/somewhere/else/.git")
    monkeypatch.setenv("GIT_INDEX_FILE", "/somewhere/else/.git/index")
    monkeypatch.setenv("GIT_WORK_TREE", "/somewhere/else")

    env = detached_git_env()

    assert "GIT_DIR" not in env
    assert "GIT_INDEX_FILE" not in env
    assert "GIT_WORK_TREE" not in env


def test_an_unanticipated_git_variable_is_stripped_too(monkeypatch: pytest.MonkeyPatch) -> None:
    """Stripping the prefix, not a fixed list, is the point.

    Naming only the variables known to cause the escape would leave the next one
    to reopen it silently.

    Args:
        monkeypatch: Used to plant a variable no current code knows about.
    """
    monkeypatch.setenv("GIT_COMMON_DIR", "/somewhere/else/.git")

    assert "GIT_COMMON_DIR" not in detached_git_env()


def test_the_surrounding_environment_still_reaches_the_subprocess(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Only git state is removed; PATH and friends must survive.

    A helper that returned a bare environment would break every shim-based
    fixture that depends on ``PATH``.

    Args:
        monkeypatch: Used to set a representative non-git variable.
    """
    monkeypatch.setenv("ADEPTHOOD_FIXTURE_MARKER", "kept")

    env = detached_git_env()

    assert env["ADEPTHOOD_FIXTURE_MARKER"] == "kept"
    assert env["PATH"] == os.environ["PATH"]


def test_overrides_are_applied_after_the_strip() -> None:
    """An override must win, including one inside the stripped namespace.

    ``GIT_CONFIG_GLOBAL`` is set by callers precisely to detach an operator's
    global git configuration, so it has to survive the prefix strip.
    """
    env = detached_git_env(GIT_CONFIG_GLOBAL=os.devnull)

    assert env["GIT_CONFIG_GLOBAL"] == os.devnull
