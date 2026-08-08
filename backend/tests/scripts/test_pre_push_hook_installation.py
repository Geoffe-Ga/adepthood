"""The pre-push hooks are actually installed, not merely declared.

``.pre-commit-config.yaml`` has carried three ``stages: [pre-push]`` hooks -- the
whole expensive local gate -- for a long time, and not one of them had ever run
on anybody's machine. ``scripts/dev-setup.sh`` installed only the ``pre-commit``
and ``commit-msg`` hook types, and nothing supplied ``--hook-type pre-push``, so
``.git/hooks/pre-push`` simply did not exist.

Nothing shipped unverified -- ``backend-ci.yml`` runs the same hooks with an
explicit ``--hook-stage pre-push`` -- but four documents described an automatic
push-time gate that was fiction, and a coverage or complexity regression
surfaced ~18 minutes into CI rather than ~5 minutes locally.

The failure mode was that the *declaration* and the *installation* lived in
different files, so neither looked wrong on its own. These tests pin them
together: a hook declared for a stage nobody installs is worse than no hook,
because it reads as covered.

The config is parsed as plain text rather than with PyYAML, matching
``test_integration_lane_guard`` and ``test_config_consolidation``: PyYAML is
absent from every requirements file on purpose, so ``import yaml`` would turn
this guard into a collection error on the ``backend-compat`` job instead of a
passing check.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
_CONFIG = _REPO_ROOT / ".pre-commit-config.yaml"
_DEV_SETUP = _REPO_ROOT / "scripts" / "dev-setup.sh"

# The hook types a bare ``pre-commit install`` must write. ``pre-push`` is the
# one this module exists for; the other two are included so a future edit cannot
# quietly drop them while "fixing" the list.
_REQUIRED_HOOK_TYPES = frozenset({"pre-commit", "commit-msg", "pre-push"})

# ``manual`` is opt-in by definition -- a hook staged there is never expected to
# fire automatically, so it is not an orphan.
_NEVER_AUTOMATIC = frozenset({"manual"})


# ``default_install_hook_types: [a, b, c]`` -- the bracketed flow sequence the
# config uses. Anchored at column zero because it is a top-level key; a
# same-named key nested under a hook would not mean this.
_INSTALL_TYPES_RE = re.compile(r"^default_install_hook_types:\s*\[([^\]]*)\]", re.MULTILINE)

# ``stages: [x]`` as written on a hook, which is always indented.
_STAGES_RE = re.compile(r"^\s+stages:\s*\[([^\]]*)\]", re.MULTILINE)

# ``- id: some-hook`` -- a hook's id, to attribute a following ``stages:`` line.
_HOOK_ID_RE = re.compile(r"^\s+- id:\s*(\S+)", re.MULTILINE)


def _config_text() -> str:
    """Return the pre-commit config as text."""
    return _CONFIG.read_text(encoding="utf-8")


def _split_list(raw: str) -> list[str]:
    """Split a YAML flow sequence's body into its bare items."""
    return [item.strip().strip("\"'") for item in raw.split(",") if item.strip()]


def _installed_hook_types() -> set[str]:
    """Return the hook types a bare ``pre-commit install`` would write."""
    match = _INSTALL_TYPES_RE.search(_config_text())
    return set(_split_list(match.group(1))) if match else set()


def _stages_declared_by_hooks() -> set[str]:
    """Return every stage any hook in the config declares."""
    return {
        stage
        for match in _STAGES_RE.finditer(_config_text())
        for stage in _split_list(match.group(1))
    }


def _hook_ids_for_stage(stage: str) -> list[str]:
    """Return the ids of every hook declaring ``stage``.

    Attributes each ``stages:`` line to the nearest preceding ``- id:``, which
    is what the config's own layout means.
    """
    text = _config_text()
    ids = [(m.start(), m.group(1)) for m in _HOOK_ID_RE.finditer(text)]
    matched: list[str] = []
    for stages in _STAGES_RE.finditer(text):
        if stage not in _split_list(stages.group(1)):
            continue
        preceding = [hook_id for pos, hook_id in ids if pos < stages.start()]
        if preceding:
            matched.append(preceding[-1])
    return matched


class TestInstalledHookTypes:
    """A bare ``pre-commit install`` writes every stage the config relies on."""

    def test_the_config_declares_the_hook_types_to_install(self) -> None:
        """Declared centrally so no caller has to remember a flag."""
        assert _INSTALL_TYPES_RE.search(_config_text()) is not None, (
            "default_install_hook_types is absent, so `pre-commit install` writes "
            "only the pre-commit hook and every pre-push hook is dead config."
        )
        assert _installed_hook_types() >= _REQUIRED_HOOK_TYPES

    def test_dev_setup_does_not_restate_the_hook_types(self) -> None:
        """Two sources of truth is how the pre-push stage went missing.

        ``dev-setup.sh`` must install without naming types, so the config stays
        the only place the set is written down.
        """
        assert "--hook-type" not in _DEV_SETUP.read_text(encoding="utf-8")

    def test_dev_setup_still_installs_hooks(self) -> None:
        """Guard against the previous assertion being satisfied by deleting the call."""
        assert "pre-commit install" in _DEV_SETUP.read_text(encoding="utf-8")


class TestPrePushStageIsRealWork:
    """The stage being installed only matters because real gates hang off it."""

    @pytest.mark.parametrize(
        "hook_id",
        ["backend-complexity", "backend-tests-coverage", "frontend-tests-coverage"],
    )
    def test_the_expensive_gates_run_at_pre_push(self, hook_id: str) -> None:
        """Each is the local counterpart of a CI gate; moving one off is a policy change."""
        assert hook_id in _hook_ids_for_stage("pre-push")

    def test_no_hook_declares_a_stage_that_is_never_installed(self) -> None:
        """The general form of the bug: a stage nobody installs still reads as covered."""
        orphaned = _stages_declared_by_hooks() - _installed_hook_types() - _NEVER_AUTOMATIC
        assert not orphaned, (
            f"These stages are declared by hooks but installed by nothing: "
            f"{sorted(orphaned)}. They will never run locally."
        )
