"""Collection rules for the opt-in live lanes.

The resonance yield lane (#2816) shares this directory and the ``live`` marker
with the model-catalogue check that ``live-model-check.yml`` runs on a
schedule. That workflow reads any ``skipped`` in its log as "provider
unreachable, no verdict", so an unarmed resonance lane is *deselected* here
rather than left to skip -- otherwise every scheduled run would report a false
"no verdict". ``tests/scripts/test_live_lane_collection.py`` pins this.
"""

from __future__ import annotations

import os

import pytest

from tests.live.resonance_lane import lane_is_armed

_RESONANCE_LANE_MODULE = "test_resonance_yield.py"


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    """Deselect the resonance lane's tests unless ``LIVE_RESONANCE_CHECK`` arms it."""
    if lane_is_armed(os.environ):
        return
    deselected = [item for item in items if item.path.name == _RESONANCE_LANE_MODULE]
    if not deselected:
        return
    config.hook.pytest_deselected(items=deselected)
    items[:] = [item for item in items if item.path.name != _RESONANCE_LANE_MODULE]
