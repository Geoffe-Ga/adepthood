"""The frontend launch-matrix fixture equals the seeded presets (#3072 AC8).

``frontend/src/features/Practice/__tests__/fixtures/seededPresets.json`` is a
projection of :data:`seed_practices.PRESET_PRACTICES`; the frontend's
``presetLaunchMatrix`` test launches every row of it. Adding, renaming or
reconfiguring a preset without regenerating the fixture would leave the new
preset untested, so this fails until the fixture is regenerated.
"""

from __future__ import annotations

import json
from collections import Counter

from scripts.dump_seeded_presets import FIXTURE_PATH, REGENERATE_COMMAND, dump_seeded_presets
from seed_practices import PRESET_PRACTICES


def test_frontend_preset_fixture_matches_seed() -> None:
    """The committed fixture parses to exactly the current projection."""
    assert FIXTURE_PATH.is_file(), f"missing fixture; run: {REGENERATE_COMMAND}"
    committed = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    assert committed == dump_seeded_presets(), (
        f"seededPresets.json drifted from PRESET_PRACTICES; run: {REGENERATE_COMMAND}"
    )


def test_every_preset_appears_exactly_once() -> None:
    """Each seeded preset name is projected once — none dropped, none doubled."""
    projected = Counter(row["name"] for row in dump_seeded_presets())
    seeded = Counter(p["name"] for p in PRESET_PRACTICES)
    assert projected == seeded
    assert set(projected.values()) == {1}


def test_projection_marks_one_canonical_preset_per_stage() -> None:
    """Exactly one row per stage carries ``canonical: true``."""
    canonical = Counter(row["stage_number"] for row in dump_seeded_presets() if row["canonical"])
    assert set(canonical.values()) == {1}
    assert sorted(canonical) == list(range(1, 11))
