"""The scratch-lane environment cannot be steered by the ambient process.

``child_env`` is the single copy of a rule that used to exist three times: once
in ``tests.helpers.git_env`` and once hand-rolled inside each of the two
pre-commit meta-tests. Consolidating it is only an improvement if the surviving
copy is held to the rule, so this module holds it.

The ``GIT_*`` half is deliberately not re-proved here -- ``test_git_env`` owns
that, and duplicating its assertions would recreate in tests the duplication
this consolidation removed. What is proved here is that ``child_env`` still goes
through ``detached_git_env`` at all, and that the three redirections layered on
top of it survive.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from tests.helpers.precommit_lane import child_env


@pytest.fixture
def lane_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    """Build a lane environment from a process polluted with everything it strips.

    Args:
        tmp_path: pytest's per-test scratch directory.
        monkeypatch: Sets the ambient variables the helper must discard.

    Returns:
        The environment ``child_env`` produces for a scratch lane.
    """
    monkeypatch.setenv("GIT_DIR", "/somewhere/else/.git")
    monkeypatch.setenv("GIT_INDEX_FILE", "/somewhere/else/.git/index")
    monkeypatch.setenv("PRE_COMMIT_HOME", "/somebody/elses/store")
    monkeypatch.setenv("SKIP", "frontend-eslint")
    return child_env(tmp_path / "home", tmp_path / "store")


class TestTheAmbientProcessCannotReachTheLane:
    """Each variable below redirected a fixture at the real repository once."""

    @pytest.mark.parametrize("leaked", ["GIT_DIR", "GIT_INDEX_FILE"])
    def test_inherited_git_state_is_stripped(self, lane_env: dict[str, str], leaked: str) -> None:
        """A leaked GIT_DIR is what wrote fixture commits onto a live branch."""
        assert leaked not in lane_env

    def test_the_shared_pre_commit_store_is_not_inherited(
        self,
        lane_env: dict[str, str],
        tmp_path: Path,
    ) -> None:
        """An inherited PRE_COMMIT_HOME would install hooks into the developer's store."""
        assert lane_env["PRE_COMMIT_HOME"] == str(tmp_path / "store")

    def test_skip_is_dropped(self, lane_env: dict[str, str]) -> None:
        """SKIP would make a hook skip for a reason no caller may misread as selection."""
        assert "SKIP" not in lane_env

    def test_home_and_xdg_config_home_are_redirected(
        self,
        lane_env: dict[str, str],
        tmp_path: Path,
    ) -> None:
        """Otherwise the developer's global git config decides a test's outcome."""
        assert lane_env["HOME"] == str(tmp_path / "home")
        assert lane_env["XDG_CONFIG_HOME"] == str(tmp_path / "home" / "config")

    def test_unrelated_variables_are_carried_through(self, lane_env: dict[str, str]) -> None:
        """The control: an env stripped to nothing would satisfy every test above."""
        carried = set(lane_env) & set(os.environ)
        assert carried - {"HOME", "XDG_CONFIG_HOME", "PRE_COMMIT_HOME"}
