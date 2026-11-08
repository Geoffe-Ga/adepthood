"""Tests for ``backend/scripts/check_wavelength_terms.py`` (issue #3135).

The gate compares every stage's six Rx/OD phase names in
``archetypal_wavelength.json`` against the vendored Modes of the Wavelength
CSV, joining each stage to its CSV row by the colour the generated
``stage_correspondence.json`` gives it (#2666: the dataset no longer carries a
colour of its own). Each test builds its own CSV, dataset and correspondence
artifact under ``tmp_path`` so the rules are exercised without depending on the
real vendored bytes; one test also runs the gate over the committed inputs,
which is what CI does.
"""

from __future__ import annotations

import copy
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

import scripts.check_wavelength_terms as gate
from scripts.check_wavelength_terms import (
    APP_AUTHORED,
    WavelengthTermsError,
    find_drift,
    main,
    read_canonical_terms,
    read_stage_colours,
)

_BACKEND = Path(__file__).resolve().parents[2]

_PHASES = ("Rising", "Peaking", "Withdrawal", "Diminishing", "Bottoming Out", "Restoration")
_HEADER = "dosage,stage,mode,orientation," + ",".join(p.lower() for p in _PHASES) + "\n"

#: Two canonical stages. The trailing spaces mirror the real CSV's edge
#: whitespace, which the comparison must tolerate.
_RX: dict[str, tuple[str, ...]] = {
    "Beige": ("Commitment", "Diligence", "Steadiness", "Security", "Planning", "Next Habit"),
    "Teal": (
        "Epiphany",
        "Gnosis",
        "Receptivity",
        "Absorption",
        "Metabolism",
        "Pattern-Seeking",
    ),
}
_OD: dict[str, tuple[str, ...]] = {
    "Beige": ("Overcommitment", "Thriving", "Burnout", "Grasping", "Overwhelm ", "New Plan"),
    "Teal": ("Delusion", "Psychosis", "Paranoia", "Horror", "Despair", "Belief Salience"),
}


def _csv_text(rx: dict[str, tuple[str, ...]], od: dict[str, tuple[str, ...]]) -> str:
    """Render a Modes CSV in the upstream layout (Medicine rows, then Toxic)."""
    lines = [_HEADER]
    for dosage, table in (("Medicine", rx), ("Toxic", od)):
        lines.extend(
            f"{dosage},{stage},Mode,Do,{','.join(terms)}\n" for stage, terms in table.items()
        )
    return "".join(lines)


def _manifestations(stage: str) -> list[dict[str, Any]]:
    """Six manifestations whose names equal the canonical terms for ``stage``."""
    return [
        {
            "phase": phase,
            "integrated": {"name": rx.strip(), "description": "Rx copy."},
            "shadow": {"name": od.strip(), "description": "OD copy."},
        }
        for phase, rx, od in zip(_PHASES, _RX[stage], _OD[stage], strict=True)
    ]


def _app_authored() -> list[dict[str, Any]]:
    """Six manifestations for a stage with no CSV row, each marked app-authored."""
    return [
        {
            "phase": phase,
            "source": APP_AUTHORED,
            "integrated": {"name": f"Rx {phase}", "description": "Rx copy."},
            "shadow": {"name": f"OD {phase}", "description": "OD copy."},
        }
        for phase in _PHASES
    ]


def _dataset() -> dict[str, Any]:
    """A dataset agreeing with the fixture CSV, plus one app-authored stage.

    Like the committed dataset it names no colour: the join goes through the
    correspondence artifact.
    """
    return {
        "stages": [
            {"stage_number": 1, "manifestations": _manifestations("Beige")},
            {"stage_number": 8, "manifestations": _manifestations("Teal")},
            {"stage_number": 10, "manifestations": _app_authored()},
        ]
    }


def _correspondence() -> dict[str, Any]:
    """A correspondence artifact giving each fixture stage its colour."""
    return {
        "stages": [
            {"id": "beige", "stage_number": 1, "spiral_dynamics_color": "Beige"},
            {"id": "teal", "stage_number": 8, "spiral_dynamics_color": "Teal"},
            {"id": "clearlight", "stage_number": 10, "spiral_dynamics_color": "Clear Light"},
        ]
    }


class Workspace:
    """A modes CSV, dataset and correspondence artifact under ``tmp_path``."""

    def __init__(self, root: Path) -> None:
        """Write a valid, agreeing CSV, dataset and correspondence artifact."""
        self.csv_path = root / "modes.csv"
        self.dataset_path = root / "dataset.json"
        self.correspondence_path = root / "correspondence.json"
        self.write_csv(_csv_text(_RX, _OD))
        self.write_dataset(_dataset())
        self.write_correspondence(_correspondence())

    def write_csv(self, text: str) -> None:
        """Replace the CSV text."""
        self.csv_path.write_text(text, encoding="utf-8")

    def write_dataset(self, payload: dict[str, Any]) -> None:
        """Replace the dataset JSON."""
        self.dataset_path.write_text(json.dumps(payload), encoding="utf-8")

    def write_correspondence(self, payload: object) -> None:
        """Replace the correspondence artifact JSON."""
        self.correspondence_path.write_text(json.dumps(payload), encoding="utf-8")

    def argv(self) -> list[str]:
        """CLI arguments pointing at this workspace."""
        return [
            "--modes-csv",
            str(self.csv_path),
            "--dataset",
            str(self.dataset_path),
            "--correspondence",
            str(self.correspondence_path),
        ]

    def drift(self) -> list[str]:
        """Run the pure comparison over this workspace."""
        return find_drift(
            read_canonical_terms(self.csv_path),
            self.dataset_path,
            read_stage_colours(self.correspondence_path),
        )


@pytest.fixture
def workspace(tmp_path: Path) -> Workspace:
    """A fresh, agreeing workspace."""
    return Workspace(tmp_path)


# ── read_canonical_terms ────────────────────────────────────────────────


def test_reads_stripped_terms_keyed_by_stage_phase_and_expression(workspace: Workspace) -> None:
    """Each cell becomes one ``(phase, expression)`` term, edge whitespace stripped."""
    terms = read_canonical_terms(workspace.csv_path)

    assert set(terms) == {"beige", "teal"}
    assert terms["teal"][("Rising", "integrated")] == "Epiphany"
    assert terms["teal"][("Restoration", "shadow")] == "Belief Salience"
    assert terms["beige"][("Bottoming Out", "shadow")] == "Overwhelm"


def test_rejects_a_csv_missing_a_phase_column(workspace: Workspace) -> None:
    workspace.write_csv(_csv_text(_RX, _OD).replace(",restoration", ",renewal"))
    with pytest.raises(WavelengthTermsError, match="restoration"):
        read_canonical_terms(workspace.csv_path)


def test_rejects_an_unknown_dosage(workspace: Workspace) -> None:
    workspace.write_csv(_csv_text(_RX, _OD).replace("Toxic,Teal", "Poison,Teal"))
    with pytest.raises(WavelengthTermsError, match="Poison"):
        read_canonical_terms(workspace.csv_path)


def test_rejects_a_duplicate_row(workspace: Workspace) -> None:
    text = _csv_text(_RX, _OD)
    duplicate = next(line for line in text.splitlines() if line.startswith("Toxic,Teal"))
    workspace.write_csv(f"{text}{duplicate}\n")
    with pytest.raises(WavelengthTermsError, match="duplicate"):
        read_canonical_terms(workspace.csv_path)


def test_rejects_a_stage_with_only_one_dosage(workspace: Workspace) -> None:
    workspace.write_csv(_csv_text(_RX, {"Beige": _OD["Beige"]}))
    with pytest.raises(WavelengthTermsError, match="Teal"):
        read_canonical_terms(workspace.csv_path)


def test_rejects_a_blank_term(workspace: Workspace) -> None:
    workspace.write_csv(_csv_text(_RX, _OD).replace("Gnosis", " "))
    with pytest.raises(WavelengthTermsError, match="blank"):
        read_canonical_terms(workspace.csv_path)


def test_rejects_a_missing_csv(tmp_path: Path) -> None:
    with pytest.raises(WavelengthTermsError, match="sync_content"):
        read_canonical_terms(tmp_path / "absent.csv")


# ── find_drift ──────────────────────────────────────────────────────────


def test_an_agreeing_dataset_has_no_drift(workspace: Workspace) -> None:
    assert workspace.drift() == []


def test_comparison_ignores_case_and_edge_whitespace(workspace: Workspace) -> None:
    payload = _dataset()
    payload["stages"][1]["manifestations"][0]["integrated"]["name"] = "  epiphany "
    workspace.write_dataset(payload)
    assert workspace.drift() == []


def test_a_wrong_integrated_name_is_drift(workspace: Workspace) -> None:
    """The #3135 regression: Teal carrying Yellow's old 'Focus' is caught."""
    payload = _dataset()
    payload["stages"][1]["manifestations"][0]["integrated"]["name"] = "Focus"
    workspace.write_dataset(payload)

    problems = workspace.drift()

    assert len(problems) == 1
    assert "stage 8" in problems[0]
    assert "Rising" in problems[0]
    assert "'Focus'" in problems[0]
    assert "'Epiphany'" in problems[0]


def test_a_wrong_shadow_name_is_drift(workspace: Workspace) -> None:
    payload = _dataset()
    payload["stages"][0]["manifestations"][5]["shadow"]["name"] = "Addiction"
    workspace.write_dataset(payload)

    problems = workspace.drift()

    assert len(problems) == 1
    assert "shadow" in problems[0]
    assert "'New Plan'" in problems[0]


def test_a_stage_without_a_csv_row_must_be_marked_app_authored(workspace: Workspace) -> None:
    payload = _dataset()
    del payload["stages"][2]["manifestations"][3]["source"]
    workspace.write_dataset(payload)

    problems = workspace.drift()

    assert len(problems) == 1
    assert "stage 10" in problems[0]
    assert APP_AUTHORED in problems[0]


def test_a_canonical_stage_cannot_claim_app_authored(workspace: Workspace) -> None:
    """Marking a CSV-backed phase app-authored would silently exempt it."""
    payload = _dataset()
    payload["stages"][1]["manifestations"][2]["source"] = APP_AUTHORED
    workspace.write_dataset(payload)

    problems = workspace.drift()

    assert len(problems) == 1
    assert "stage 8" in problems[0]
    assert "canonical" in problems[0]


def test_a_csv_stage_missing_from_the_dataset_is_drift(workspace: Workspace) -> None:
    payload = _dataset()
    del payload["stages"][1]
    workspace.write_dataset(payload)

    problems = workspace.drift()

    assert problems == ["the Modes CSV has a row for 'teal' but no dataset stage carries it"]


def test_a_malformed_dataset_is_refused(workspace: Workspace) -> None:
    workspace.dataset_path.write_text("{not json", encoding="utf-8")
    with pytest.raises(WavelengthTermsError, match="not valid JSON"):
        workspace.drift()


def test_a_dataset_without_stages_is_refused(workspace: Workspace) -> None:
    workspace.write_dataset({"stages": "nope"})
    with pytest.raises(WavelengthTermsError, match="stages"):
        workspace.drift()


def test_the_colour_join_follows_the_correspondence_artifact(workspace: Workspace) -> None:
    """Swapping two stages' colours in the artifact swaps the canonical rows they meet.

    The dataset is unchanged, so every one of the twelve names at stages 1 and
    8 is now compared against the other stage's row: the artifact, not the
    dataset, decides the join (#2666).
    """
    payload = _correspondence()
    payload["stages"][0]["spiral_dynamics_color"] = "Teal"
    payload["stages"][1]["spiral_dynamics_color"] = "Beige"
    workspace.write_correspondence(payload)

    problems = workspace.drift()

    phase_pairs = len(_PHASES) * 2
    assert len(problems) == 2 * phase_pairs
    assert sum("stage 1 " in problem for problem in problems) == phase_pairs
    assert sum("stage 8 " in problem for problem in problems) == phase_pairs
    assert "the Modes CSV says 'Epiphany'" in problems[0]


def test_a_dataset_stage_the_artifact_lacks_is_drift(workspace: Workspace) -> None:
    """A stage with no colour in the artifact is reported, not raised as a KeyError."""
    payload = _correspondence()
    del payload["stages"][1]
    workspace.write_correspondence(payload)

    problems = workspace.drift()

    assert problems == [
        "stage 8 has no spiral_dynamics_color in the stage-correspondence artifact",
        "the Modes CSV has a row for 'teal' but no dataset stage carries it",
    ]


# ── read_stage_colours ──────────────────────────────────────────────────


def test_reads_each_stage_colour_normalised(workspace: Workspace) -> None:
    payload = _correspondence()
    payload["stages"][2]["spiral_dynamics_color"] = "  Clear   LIGHT "
    workspace.write_correspondence(payload)

    assert read_stage_colours(workspace.correspondence_path) == {
        1: "beige",
        8: "teal",
        10: "clear light",
    }


def test_rejects_a_missing_correspondence_artifact(tmp_path: Path) -> None:
    with pytest.raises(WavelengthTermsError, match="build_stage_correspondence"):
        read_stage_colours(tmp_path / "absent.json")


def test_rejects_a_correspondence_artifact_that_is_not_json(workspace: Workspace) -> None:
    workspace.correspondence_path.write_text("{not json", encoding="utf-8")
    with pytest.raises(WavelengthTermsError, match="not valid JSON"):
        read_stage_colours(workspace.correspondence_path)


@pytest.mark.parametrize(
    "payload",
    [
        pytest.param({"stages": "nope"}, id="stages_not_a_list"),
        pytest.param(["not", "an", "object"], id="not_an_object"),
        pytest.param({"stages": ["beige"]}, id="stage_not_an_object"),
        pytest.param(
            {"stages": [{"stage_number": "1", "spiral_dynamics_color": "Beige"}]},
            id="number_is_str",
        ),
        pytest.param(
            {"stages": [{"stage_number": True, "spiral_dynamics_color": "Beige"}]},
            id="number_is_bool",
        ),
        pytest.param({"stages": [{"stage_number": 1}]}, id="no_colour"),
        pytest.param(
            {"stages": [{"stage_number": 1, "spiral_dynamics_color": " "}]}, id="blank_colour"
        ),
    ],
)
def test_rejects_a_malformed_correspondence_artifact(workspace: Workspace, payload: object) -> None:
    workspace.write_correspondence(payload)
    with pytest.raises(WavelengthTermsError, match=re.escape(str(workspace.correspondence_path))):
        read_stage_colours(workspace.correspondence_path)


# ── main / CLI ──────────────────────────────────────────────────────────


def test_main_passes_an_agreeing_workspace(
    workspace: Workspace, capsys: pytest.CaptureFixture[str]
) -> None:
    assert main(workspace.argv()) == 0
    assert "match" in capsys.readouterr().out


def test_main_fails_on_drift_and_names_every_problem(
    workspace: Workspace, capsys: pytest.CaptureFixture[str]
) -> None:
    payload = copy.deepcopy(_dataset())
    payload["stages"][1]["manifestations"][0]["integrated"]["name"] = "Focus"
    payload["stages"][1]["manifestations"][0]["shadow"]["name"] = "Hyperfocus"
    workspace.write_dataset(payload)

    assert main(workspace.argv()) == 1

    err = capsys.readouterr().err
    assert "'Focus'" in err
    assert "'Hyperfocus'" in err


def test_main_fails_on_an_unreadable_input(
    workspace: Workspace, capsys: pytest.CaptureFixture[str]
) -> None:
    workspace.csv_path.unlink()
    assert main(workspace.argv()) == 1
    assert "sync_content" in capsys.readouterr().err


def test_main_fails_on_a_missing_correspondence_artifact(
    workspace: Workspace, capsys: pytest.CaptureFixture[str]
) -> None:
    workspace.correspondence_path.unlink()
    assert main(workspace.argv()) == 1
    assert "build_stage_correspondence" in capsys.readouterr().err


def test_main_fails_on_a_malformed_correspondence_artifact(
    workspace: Workspace, capsys: pytest.CaptureFixture[str]
) -> None:
    workspace.correspondence_path.write_text("{not json", encoding="utf-8")
    assert main(workspace.argv()) == 1
    assert "not valid JSON" in capsys.readouterr().err


def test_main_fails_when_the_artifact_moves_a_colour(
    workspace: Workspace, capsys: pytest.CaptureFixture[str]
) -> None:
    """A violating correspondence fixture turns the gate red with an untouched dataset."""
    payload = _correspondence()
    payload["stages"][1]["spiral_dynamics_color"] = "Beige"
    workspace.write_correspondence(payload)

    assert main(workspace.argv()) == 1
    assert "stage 8 Rising integrated is 'Epiphany'" in capsys.readouterr().err


def test_the_committed_dataset_matches_the_vendored_csv() -> None:
    """What CI runs: the real inputs agree (this is the #3135 drift gate)."""
    assert main([]) == 0


def test_the_default_inputs_are_the_committed_files() -> None:
    assert (
        gate.MODES_CSV_PATH == _BACKEND / "content" / "curriculum" / "modes_of_the_wavelength.csv"
    )
    assert gate.DATASET_PATH == _BACKEND / "src" / "curriculum" / "archetypal_wavelength.json"
    assert gate.CORRESPONDENCE_PATH == _BACKEND / "src" / "curriculum" / "stage_correspondence.json"


def test_the_module_runs_as_a_cli_without_src_on_the_path() -> None:
    """CI runs ``python -m scripts.check_wavelength_terms`` with no PYTHONPATH."""
    result = subprocess.run(
        [sys.executable, "-m", "scripts.check_wavelength_terms"],
        cwd=_BACKEND,
        capture_output=True,
        text=True,
        check=False,
        env={},  # no PYTHONPATH: src/ must not be importable
    )
    assert result.returncode == 0, result.stderr
