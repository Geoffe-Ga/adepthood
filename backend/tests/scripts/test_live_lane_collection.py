"""The opt-in resonance lane never reads as "skipped" to the live model check.

``.github/workflows/live-model-check.yml`` runs ``pytest tests/live -m live``
and treats any ``skipped`` in its log as "the provider was unreachable, no
verdict". The resonance yield lane (#2816) also lives under ``tests/live`` with
the ``live`` marker, but is armed only by ``LIVE_RESONANCE_CHECK``. If it
skipped while unarmed, every scheduled model check would report a false "no
verdict" even when the catalogue reconciled cleanly. ``tests/live/conftest.py``
deselects it at collection instead; these tests drive that exact command.
"""

from __future__ import annotations

import os
import subprocess
import sys
from collections.abc import Mapping
from pathlib import Path

from tests.live.resonance_lane import KEY_ENV, OPT_IN_ENV, PROVIDER_ENV

_BACKEND_DIR = Path(__file__).resolve().parents[2]
_LANE_MODULE = "test_resonance_yield.py"
_KEY = "sk-live-test-key"


def _run_lane(overrides: Mapping[str, str], *extra: str) -> str:
    """Run the lane module with the workflow's flags; return the output."""
    env = {
        key: value
        for key, value in os.environ.items()
        if key not in {OPT_IN_ENV, PROVIDER_ENV, KEY_ENV}
    }
    env.update(overrides)
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            f"tests/live/{_LANE_MODULE}",
            "-m",
            "live",
            "-q",
            "--no-cov",
            # The repo's addopts carry another -q, and -qq hides the summary
            # line this test reads; clear them so "deselected"/"skipped" print.
            "-o",
            "addopts=",
            *extra,
        ],
        capture_output=True,
        text=True,
        check=False,
        env=env,
        cwd=_BACKEND_DIR,
    )
    return result.stdout + result.stderr


def test_unarmed_resonance_lane_is_deselected_not_skipped() -> None:
    """Unarmed, the lane is deselected and nothing in the run says "skipped"."""
    output = _run_lane({})

    assert "3 deselected" in output
    assert "skipped" not in output


def test_armed_resonance_lane_is_collected() -> None:
    """Armed, all of the lane's scenarios are collected for a real run."""
    output = _run_lane({OPT_IN_ENV: "1", PROVIDER_ENV: "openai", KEY_ENV: _KEY}, "--collect-only")

    assert "3 tests collected" in output
    assert "deselected" not in output
