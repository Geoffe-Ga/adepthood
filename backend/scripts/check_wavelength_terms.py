"""Gate the Map's Rx/OD phase names against the canonical Modes CSV.

Issue #3135: ``src/curriculum/archetypal_wavelength.json`` carries each
stage's six "Mode of the Wavelength" phase names, an integrated (Rx / medicine)
and a shadow (OD / toxic) name per phase, and ``GET /stages`` serves them to
the Map. They were once hand-copied from vendored chapters that were
themselves stale, and Teal shipped Yellow's twelve names for a release while
every check stayed green. The canonical source is aptitude-course's
``The Archetypal Wavelength - Modes of the Wavelength.csv``, vendored
byte-for-byte by :mod:`scripts.sync_content` to
``backend/content/curriculum/modes_of_the_wavelength.csv``. This script is the
drift gate:

    python -m scripts.check_wavelength_terms

It runs in the ``content-drift`` job of ``.github/workflows/backend-ci.yml``
after ``sync_content --check`` has verified the vendored CSV, and
``tests/scripts/test_stage_correspondence_drift_gate.py`` fails if that step is
removed, reordered or disarmed.

Rules, all read-only:

* Every phase of a stage whose ``spiral_dynamics_color`` has a CSV row must
  carry exactly the CSV's Medicine (``integrated``) and Toxic (``shadow``)
  terms, compared case-insensitively with whitespace collapsed (the CSV has
  edge spaces such as ``"Overwhelm "``).
* A stage with no CSV row (today only Clear Light) must mark each of its
  manifestations ``"source": "app-authored"`` so the gap is explicit, and a
  CSV-backed phase may not carry that marker (it would exempt itself).
* Every CSV stage must appear in the dataset.

Like the other drift scripts it imports nothing from ``src/``: the CI job
installs only ``httpx`` and ``jsonschema`` and sets no ``PYTHONPATH``, so the
dataset is read as plain JSON. Exit codes: 0 when the names match, 1 on any
drift or unreadable input.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import sys
from pathlib import Path
from typing import Any

from scripts.sync_content import WAVELENGTH_MODES_CSV_VENDORED

_BACKEND_DIR = Path(__file__).resolve().parents[1]

#: The vendored canonical CSV (mirrors ``sync_content``'s default target).
MODES_CSV_PATH = _BACKEND_DIR / "content" / WAVELENGTH_MODES_CSV_VENDORED

#: The dataset whose phase names ``GET /stages`` serves.
DATASET_PATH = _BACKEND_DIR / "src" / "curriculum" / "archetypal_wavelength.json"

#: The marker a manifestation with no canonical CSV row must carry.
APP_AUTHORED = "app-authored"

#: The six phases in canonical order, as the dataset spells them.
PHASES: tuple[str, ...] = (
    "Rising",
    "Peaking",
    "Withdrawal",
    "Diminishing",
    "Bottoming Out",
    "Restoration",
)

#: CSV ``dosage`` value (normalised) -> the dataset expression it names.
DOSAGE_EXPRESSIONS: dict[str, str] = {"medicine": "integrated", "toxic": "shadow"}

_DOSAGE_COLUMN = "dosage"
_STAGE_COLUMN = "stage"

#: One stage's canonical terms, keyed by ``(phase, expression)``.
StageTerms = dict[tuple[str, str], str]


class WavelengthTermsError(Exception):
    """An input is missing or malformed, so no verdict can be trusted."""


def normalise(term: str) -> str:
    """Case-fold and collapse whitespace: the comparison key for a term."""
    return " ".join(term.split()).casefold()


def _read_records(path: Path) -> list[list[str]]:
    """Parse ``path`` into raw CSV records (header first), or explain how to vendor it."""
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        msg = f"{path} is missing — vendor it with `python -m scripts.sync_content --ref <sha>`"
        raise WavelengthTermsError(msg) from exc
    # newline="" keeps quoted multi-line cells intact, as the csv module requires.
    return list(csv.reader(io.StringIO(text, newline=""))) or [[]]


def _require_columns(path: Path, columns: list[str]) -> None:
    """Reject a header lacking the dosage, stage or any phase column."""
    required = (_DOSAGE_COLUMN, _STAGE_COLUMN, *(normalise(phase) for phase in PHASES))
    missing = [column for column in required if column not in columns]
    if missing:
        msg = f"{path} has no {missing[0]!r} column"
        raise WavelengthTermsError(msg)


def _read_rows(path: Path) -> list[dict[str, str]]:
    """Parse the CSV into rows keyed by normalised header, requiring every column."""
    header, *records = _read_records(path)
    columns = [normalise(name) for name in header]
    _require_columns(path, columns)
    return [dict(zip(columns, record, strict=False)) for record in records if any(record)]


def _expression_for(row: dict[str, str]) -> str:
    """Map a row's dosage to its dataset expression, rejecting unknown dosages."""
    dosage = row.get(_DOSAGE_COLUMN, "")
    expression = DOSAGE_EXPRESSIONS.get(normalise(dosage))
    if expression is None:
        msg = f"Modes CSV has an unknown dosage {dosage!r}"
        raise WavelengthTermsError(msg)
    return expression


def _row_terms(row: dict[str, str], expression: str) -> StageTerms:
    """Return one row's six terms, stripped, rejecting a blank cell."""
    terms: StageTerms = {}
    for phase in PHASES:
        term = row.get(normalise(phase), "").strip()
        if not term:
            msg = f"Modes CSV has a blank {phase} term for {row[_STAGE_COLUMN]!r}"
            raise WavelengthTermsError(msg)
        terms[phase, expression] = term
    return terms


def _require_both_dosages(terms: dict[str, StageTerms], names: dict[str, str]) -> None:
    """Every stage needs a Medicine and a Toxic row: twelve terms, no fewer."""
    expected = len(PHASES) * len(DOSAGE_EXPRESSIONS)
    for key, stage_terms in terms.items():
        if len(stage_terms) != expected:
            msg = f"Modes CSV stage {names[key]!r} lacks a Medicine or Toxic row"
            raise WavelengthTermsError(msg)


def read_canonical_terms(path: Path) -> dict[str, StageTerms]:
    """Read the Modes CSV into ``{normalised stage: {(phase, expression): term}}``."""
    terms: dict[str, StageTerms] = {}
    names: dict[str, str] = {}
    for row in _read_rows(path):
        expression = _expression_for(row)
        key = normalise(row[_STAGE_COLUMN])
        stage_terms = terms.setdefault(key, {})
        if (PHASES[0], expression) in stage_terms:
            msg = f"Modes CSV has a duplicate {expression} row for {row[_STAGE_COLUMN]!r}"
            raise WavelengthTermsError(msg)
        names[key] = row[_STAGE_COLUMN].strip()
        stage_terms.update(_row_terms(row, expression))
    _require_both_dosages(terms, names)
    return terms


def _read_stages(path: Path) -> list[dict[str, Any]]:
    """Read the dataset's ``stages`` array as plain JSON."""
    try:
        payload: Any = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        msg = f"{path} is not valid JSON: {exc}"
        raise WavelengthTermsError(msg) from exc
    stages = payload.get("stages") if isinstance(payload, dict) else None
    if not isinstance(stages, list):
        msg = f"{path} must hold a 'stages' array"
        raise WavelengthTermsError(msg)
    return stages


def _app_authored_problem(stage_number: object, manifestation: dict[str, Any]) -> list[str]:
    """A phase with no CSV row must say it is app-authored."""
    if manifestation.get("source") == APP_AUTHORED:
        return []
    phase = manifestation.get("phase")
    marker = f'"source": "{APP_AUTHORED}"'
    return [f"stage {stage_number} {phase} has no Modes CSV row; mark it {marker}"]


def _canonical_problems(
    stage_number: object, manifestation: dict[str, Any], terms: StageTerms
) -> list[str]:
    """Compare one CSV-backed phase's two names against the canonical terms."""
    phase = str(manifestation.get("phase"))
    if manifestation.get("source") == APP_AUTHORED:
        return [f"stage {stage_number} {phase} is marked {APP_AUTHORED} but has a canonical row"]
    problems = []
    for expression in DOSAGE_EXPRESSIONS.values():
        expected = terms.get((phase, expression), "")
        actual = str(manifestation.get(expression, {}).get("name", ""))
        if normalise(actual) != normalise(expected):
            problems.append(
                f"stage {stage_number} {phase} {expression} is {actual!r}; "
                f"the Modes CSV says {expected!r}"
            )
    return problems


def _stage_problems(stage: dict[str, Any], canonical: dict[str, StageTerms]) -> list[str]:
    """Every problem with one stage's six manifestations."""
    number = stage.get("stage_number")
    terms = canonical.get(normalise(str(stage.get("spiral_dynamics_color", ""))))
    problems: list[str] = []
    for manifestation in stage.get("manifestations", []):
        if terms is None:
            problems += _app_authored_problem(number, manifestation)
        else:
            problems += _canonical_problems(number, manifestation, terms)
    return problems


def find_drift(canonical: dict[str, StageTerms], dataset_path: Path) -> list[str]:
    """Return every disagreement between the dataset and the canonical terms."""
    stages = _read_stages(dataset_path)
    problems = [problem for stage in stages for problem in _stage_problems(stage, canonical)]
    return problems + _missing_stage_problems(canonical, stages)


def _missing_stage_problems(
    canonical: dict[str, StageTerms], stages: list[dict[str, Any]]
) -> list[str]:
    """Every CSV stage that no dataset stage carries."""
    seen = {normalise(str(stage.get("spiral_dynamics_color", ""))) for stage in stages}
    return [
        f"the Modes CSV has a row for {key!r} but no dataset stage carries it"
        for key in sorted(set(canonical) - seen)
    ]


def main(argv: list[str] | None = None) -> int:
    """CLI entry point. Returns 0 when every name matches, 1 otherwise."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--modes-csv", type=Path, default=MODES_CSV_PATH)
    parser.add_argument("--dataset", type=Path, default=DATASET_PATH)
    args = parser.parse_args(argv)
    try:
        problems = find_drift(read_canonical_terms(args.modes_csv), args.dataset)
    except WavelengthTermsError as exc:
        sys.stderr.write(f"{exc}\n")
        return 1
    if problems:
        sys.stderr.write("".join(f"{problem}\n" for problem in problems))
        return 1
    sys.stdout.write(f"{args.dataset} phase names match {args.modes_csv}\n")
    return 0


if __name__ == "__main__":  # pragma: no cover — exercised by the subprocess test
    sys.exit(main())
