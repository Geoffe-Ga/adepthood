"""Meta-test: the seeded-preset fixture gate fails on a violating fixture (#3072).

Per the playbook rule on gates, a drift check is only trusted once it has been
seen to exit non-zero on a real violation, not just zero on a clean tree.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.dump_seeded_presets import (
    EXIT_DRIFT,
    EXIT_OK,
    REGENERATE_COMMAND,
    dump_seeded_presets,
    main,
    render,
)


def _write(path: Path, rows: list[dict[str, object]]) -> Path:
    path.write_text(json.dumps(rows), encoding="utf-8")
    return path


def test_check_passes_on_a_current_fixture(tmp_path: Path) -> None:
    """A freshly rendered fixture is current, whatever its whitespace."""
    fixture = _write(tmp_path / "presets.json", dump_seeded_presets())
    assert main(["--check", "--path", str(fixture)]) == EXIT_OK


def test_check_fails_on_an_edited_mode_config(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """One changed config value is drift, and the failure names the fix."""
    rows = dump_seeded_presets()
    rows[0]["mode_config"] = {**rows[0]["mode_config"], "mode": "count_up"}
    fixture = _write(tmp_path / "presets.json", rows)
    assert main(["--check", "--path", str(fixture)]) == EXIT_DRIFT
    assert REGENERATE_COMMAND in capsys.readouterr().err


def test_check_fails_on_a_dropped_preset(tmp_path: Path) -> None:
    """A preset missing from the fixture is drift."""
    fixture = _write(tmp_path / "presets.json", dump_seeded_presets()[1:])
    assert main(["--check", "--path", str(fixture)]) == EXIT_DRIFT


def test_check_fails_on_a_missing_fixture(tmp_path: Path) -> None:
    """No fixture at all is drift, not a silent pass."""
    assert main(["--check", "--path", str(tmp_path / "absent.json")]) == EXIT_DRIFT


def test_write_produces_a_current_fixture(tmp_path: Path) -> None:
    """``--write`` output passes ``--check`` and is the deterministic render."""
    fixture = tmp_path / "nested" / "presets.json"
    assert main(["--write", "--path", str(fixture)]) == EXIT_OK
    assert fixture.read_text(encoding="utf-8") == render(dump_seeded_presets())
    assert main(["--check", "--path", str(fixture)]) == EXIT_OK
