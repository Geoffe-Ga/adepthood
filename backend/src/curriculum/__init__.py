"""Typed loader for the vendored Archetypal Wavelength curriculum dataset.

This package vendors a single source of truth for the per-Stage and per-phase
copy of the Archetypal Wavelength (``archetypal_wavelength.json``) and exposes
it as validated, frozen dataclasses.  The seeder and any other consumer read
their Stage definitions from here rather than hardcoding them, so the copy
cannot drift between call sites.

The loader is strict: it rejects any dataset that is not exactly ten Stages
(numbered one through ten, no duplicates), each carrying exactly the six
canonical Wavelength phases in order, with every required string populated.
The one exception is a Stage whose ``mode`` holds all the Modes (Clear Light,
the Neither/Both Mode): it plays no scale of its own, so it carries no phase
pairs, and :func:`phase_chords` composes its phases from every other Stage's
healthy (integrated) expressions instead.
Malformed JSON and every shape mismatch surface as :class:`CurriculumDataError`
so callers never have to catch a raw ``json`` or ``KeyError``.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from enum import StrEnum
from functools import cache
from pathlib import Path
from typing import Any, Final


class WavelengthPhase(StrEnum):
    """One of the six phases of the Archetypal Wavelength.

    The values are the human-readable phase names exactly as they appear in
    the dataset and the course copy, so the enum can be compared directly
    against the JSON strings.
    """

    RISING = "Rising"
    PEAKING = "Peaking"
    WITHDRAWAL = "Withdrawal"
    DIMINISHING = "Diminishing"
    BOTTOMING_OUT = "Bottoming Out"
    RESTORATION = "Restoration"


#: The canonical order the six phases must appear in for every Stage.  The
#: enum declaration order is authoritative, so we derive the tuple from it.
CANONICAL_PHASE_ORDER: Final[tuple[WavelengthPhase, ...]] = tuple(WavelengthPhase)

#: The Stage numbers the dataset must contain, exactly (one through ten).
_EXPECTED_STAGE_COUNT: Final[int] = 10
_EXPECTED_STAGE_NUMBERS: Final[frozenset[int]] = frozenset(
    range(1, _EXPECTED_STAGE_COUNT + 1),
)

#: The vendored dataset ships alongside this module inside the package.
_DEFAULT_DATASET_PATH: Final[Path] = Path(__file__).parent / "archetypal_wavelength.json"


@dataclass(frozen=True, slots=True)
class PhaseExpression:
    """One expression of a phase: an integrated (Rx) or shadow (OD) form."""

    name: str
    description: str


@dataclass(frozen=True, slots=True)
class PhaseManifestation:
    """How one Stage manifests in one Wavelength phase (integrated + shadow)."""

    phase: WavelengthPhase
    integrated: PhaseExpression
    shadow: PhaseExpression


@dataclass(frozen=True, slots=True)
class StageMode:
    """A Stage's Mode of the Wavelength, where the dataset states one.

    ``holds_all_modes`` marks the Neither/Both Mode: it contains the healthy
    expression of every other Mode rather than a six-phase scale of its own.
    """

    name: str
    description: str
    holds_all_modes: bool


@dataclass(frozen=True, slots=True)
class ChordNote:
    """One Stage's healthy (integrated) expression, sounding inside a phase chord."""

    stage_number: int
    name: str


@dataclass(frozen=True, slots=True)
class PhaseChord:
    """Every scale Stage's healthy expression of one phase, in Stage order."""

    phase: WavelengthPhase
    notes: tuple[ChordNote, ...]


@dataclass(frozen=True, slots=True)
class StageCurriculum:
    """The full curriculum record for one APTITUDE Stage.

    Carries the Stage's identifying attributes plus its six phase
    manifestations, in canonical phase order. A Stage whose ``mode`` holds all
    the Modes carries no manifestations of its own.
    """

    stage_number: int
    title: str
    subtitle: str
    category: str
    aspect: str
    spiral_dynamics_color: str
    growing_up_stage: str
    divine_gender_polarity: str
    relationship_to_free_will: str
    free_will_description: str
    manifestations: tuple[PhaseManifestation, ...]
    mode: StageMode | None = None


class CurriculumDataError(ValueError):
    """The curriculum dataset is missing, malformed, or fails validation."""


def _require_dict(obj: object, context: str) -> dict[str, Any]:
    """Return ``obj`` as a dict, or raise :class:`CurriculumDataError`."""
    if not isinstance(obj, dict):
        msg = f"{context} must be a JSON object"
        raise CurriculumDataError(msg)
    return obj


def _require_list(obj: object, context: str) -> list[Any]:
    """Return ``obj`` as a list, or raise :class:`CurriculumDataError`."""
    if not isinstance(obj, list):
        msg = f"{context} must be a JSON array"
        raise CurriculumDataError(msg)
    return obj


def _require_str(obj: dict[str, Any], key: str, context: str) -> str:
    """Return a non-empty string at ``key``, or raise :class:`CurriculumDataError`."""
    value = obj.get(key)
    if not isinstance(value, str) or not value.strip():
        msg = f"{context} field {key!r} must be a non-empty string"
        raise CurriculumDataError(msg)
    return value


def _require_int(obj: dict[str, Any], key: str, context: str) -> int:
    """Return an integer at ``key``, or raise :class:`CurriculumDataError`."""
    value = obj.get(key)
    # ``bool`` is an ``int`` subclass, so reject it explicitly.
    if not isinstance(value, int) or isinstance(value, bool):
        msg = f"{context} field {key!r} must be an integer"
        raise CurriculumDataError(msg)
    return value


def _parse_expression(raw: object, context: str) -> PhaseExpression:
    """Build a :class:`PhaseExpression` from a raw JSON object."""
    obj = _require_dict(raw, context)
    return PhaseExpression(
        name=_require_str(obj, "name", context),
        description=_require_str(obj, "description", context),
    )


def _parse_mode(raw: object, context: str) -> StageMode | None:
    """Build the optional :class:`StageMode`; ``None`` when the Stage states no mode."""
    if raw is None:
        return None
    obj = _require_dict(raw, f"{context} mode")
    holds_all_modes = obj.get("holds_all_modes", False)
    if not isinstance(holds_all_modes, bool):
        msg = f"{context} mode field 'holds_all_modes' must be a boolean"
        raise CurriculumDataError(msg)
    return StageMode(
        name=_require_str(obj, "name", f"{context} mode"),
        description=_require_str(obj, "description", f"{context} mode"),
        holds_all_modes=holds_all_modes,
    )


def _parse_phase(raw: dict[str, Any], context: str) -> WavelengthPhase:
    """Resolve the ``phase`` value to a :class:`WavelengthPhase` member."""
    value = _require_str(raw, "phase", context)
    try:
        return WavelengthPhase(value)
    except ValueError as exc:
        msg = f"{context} has an unknown phase {value!r}"
        raise CurriculumDataError(msg) from exc


def _parse_manifestation(raw: object, context: str) -> PhaseManifestation:
    """Build a :class:`PhaseManifestation` from a raw JSON object."""
    obj = _require_dict(raw, context)
    return PhaseManifestation(
        phase=_parse_phase(obj, context),
        integrated=_parse_expression(obj.get("integrated"), f"{context} integrated"),
        shadow=_parse_expression(obj.get("shadow"), f"{context} shadow"),
    )


def _parse_manifestations(raw: object, context: str) -> tuple[PhaseManifestation, ...]:
    """Parse and validate the six manifestations of one Stage, in order."""
    entries = _require_list(raw, f"{context} manifestations")
    manifestations = tuple(
        _parse_manifestation(entry, f"{context} manifestation {index}")
        for index, entry in enumerate(entries)
    )
    phases = tuple(m.phase for m in manifestations)
    if phases != CANONICAL_PHASE_ORDER:
        msg = f"{context} must list the six phases in canonical order"
        raise CurriculumDataError(msg)
    return manifestations


def _holds_all_modes(mode: StageMode | None) -> bool:
    """True for the Neither/Both Mode, which holds every other Mode's medicine."""
    return mode is not None and mode.holds_all_modes


def _parse_stage_manifestations(
    raw: object, context: str, mode: StageMode | None
) -> tuple[PhaseManifestation, ...]:
    """Parse a Stage's manifestations: none for a Mode holding all Modes, else six."""
    if not _holds_all_modes(mode):
        return _parse_manifestations(raw, context)
    if _require_list(raw, f"{context} manifestations"):
        msg = f"{context} holds all the Modes, so it carries no phase pairs of its own"
        raise CurriculumDataError(msg)
    return ()


def _parse_stage(raw: object) -> StageCurriculum:
    """Build a :class:`StageCurriculum` from a raw JSON object."""
    obj = _require_dict(raw, "stage")
    stage_number = _require_int(obj, "stage_number", "stage")
    context = f"stage {stage_number}"
    mode = _parse_mode(obj.get("mode"), context)
    return StageCurriculum(
        stage_number=stage_number,
        title=_require_str(obj, "title", context),
        subtitle=_require_str(obj, "subtitle", context),
        category=_require_str(obj, "category", context),
        aspect=_require_str(obj, "aspect", context),
        spiral_dynamics_color=_require_str(obj, "spiral_dynamics_color", context),
        growing_up_stage=_require_str(obj, "growing_up_stage", context),
        divine_gender_polarity=_require_str(obj, "divine_gender_polarity", context),
        relationship_to_free_will=_require_str(
            obj,
            "relationship_to_free_will",
            context,
        ),
        free_will_description=_require_str(obj, "free_will_description", context),
        manifestations=_parse_stage_manifestations(obj.get("manifestations"), context, mode),
        mode=mode,
    )


def _validate_stages(stages: tuple[StageCurriculum, ...]) -> None:
    """Enforce that the ten Stages are present, unique, and complete."""
    if len(stages) != _EXPECTED_STAGE_COUNT:
        msg = f"curriculum must define exactly {_EXPECTED_STAGE_COUNT} stages"
        raise CurriculumDataError(msg)
    numbers = {stage.stage_number for stage in stages}
    if numbers != _EXPECTED_STAGE_NUMBERS:
        msg = f"curriculum stage numbers must be exactly {sorted(_EXPECTED_STAGE_NUMBERS)}"
        raise CurriculumDataError(msg)


def _parse_dataset(payload: object) -> tuple[StageCurriculum, ...]:
    """Parse the full dataset into an ordered, validated Stage tuple.

    Accepts either the wrapped object shape (with a ``stages`` array) or a
    bare array of Stage objects, so test fixtures can supply the minimal form.
    """
    entries: object = payload.get("stages") if isinstance(payload, dict) else payload
    raw_stages = _require_list(entries, "curriculum stages")
    stages = tuple(_parse_stage(raw) for raw in raw_stages)
    _validate_stages(stages)
    return tuple(sorted(stages, key=lambda stage: stage.stage_number))


def _read_json(path: Path) -> object:
    """Read and parse a JSON file, mapping every failure to a typed error."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        msg = f"curriculum dataset not found at {path}"
        raise CurriculumDataError(msg) from exc
    try:
        parsed: object = json.loads(text)
    except json.JSONDecodeError as exc:
        msg = f"curriculum dataset at {path} is not valid JSON"
        raise CurriculumDataError(msg) from exc
    return parsed


@cache
def _load_default() -> tuple[StageCurriculum, ...]:
    """Load and cache the vendored dataset from the default path."""
    return _parse_dataset(_read_json(_DEFAULT_DATASET_PATH))


def load_curriculum(path: Path | None = None) -> tuple[StageCurriculum, ...]:
    """Load the curriculum, ordered by ``stage_number``.

    With no ``path`` the vendored dataset is read once and cached; passing an
    explicit ``path`` always parses fresh (used by tests to exercise
    validation against fixtures).  Malformed data raises
    :class:`CurriculumDataError`.
    """
    if path is None:
        return _load_default()
    return _parse_dataset(_read_json(path))


def all_stages() -> tuple[StageCurriculum, ...]:
    """Return every Stage's curriculum, ordered by ``stage_number``."""
    return load_curriculum()


def stage_curriculum(stage_number: int) -> StageCurriculum:
    """Return the curriculum for ``stage_number``.

    Raises :class:`CurriculumDataError` (not ``KeyError``) when unknown.
    """
    for stage in all_stages():
        if stage.stage_number == stage_number:
            return stage
    msg = f"unknown stage_number {stage_number}"
    raise CurriculumDataError(msg)


def manifestation(stage_number: int, phase: WavelengthPhase) -> PhaseManifestation:
    """Return one Stage's manifestation for ``phase``.

    Raises :class:`CurriculumDataError` when the Stage or phase is unknown.
    """
    stage = stage_curriculum(stage_number)
    for candidate in stage.manifestations:
        if candidate.phase == phase:
            return candidate
    msg = f"stage {stage_number} has no manifestation for phase {phase!r}"
    raise CurriculumDataError(msg)


def compose_phase_chords(
    stages: tuple[StageCurriculum, ...], stage_number: int
) -> tuple[PhaseChord, ...]:
    """Compose ``stage_number``'s phase chords from ``stages``.

    A Stage that holds all the Modes sounds, in each phase, the healthy
    (integrated) expression of every Stage that plays its own scale, in Stage
    order. Any other Stage has no chord, so the result is empty.
    """
    if not _holds_all_modes(_mode_of(stages, stage_number)):
        return ()
    scales = _scale_stages(stages)
    return tuple(
        _phase_chord(phase, index, scales) for index, phase in enumerate(CANONICAL_PHASE_ORDER)
    )


def _mode_of(stages: tuple[StageCurriculum, ...], stage_number: int) -> StageMode | None:
    """The Mode ``stage_number`` states in ``stages``, or ``None`` (also when it is absent)."""
    return next((s.mode for s in stages if s.stage_number == stage_number), None)


def _scale_stages(stages: tuple[StageCurriculum, ...]) -> tuple[StageCurriculum, ...]:
    """The Stages that play a six-phase scale of their own, in their given order."""
    return tuple(s for s in stages if s.manifestations)


def _phase_chord(
    phase: WavelengthPhase, index: int, scales: tuple[StageCurriculum, ...]
) -> PhaseChord:
    """One phase's chord: each scale Stage's integrated name at ``index``, in Stage order."""
    notes = tuple(
        ChordNote(stage_number=s.stage_number, name=s.manifestations[index].integrated.name)
        for s in scales
    )
    return PhaseChord(phase=phase, notes=notes)


def phase_chords(stage_number: int) -> tuple[PhaseChord, ...]:
    """Return ``stage_number``'s phase chords from the vendored dataset (empty if none)."""
    return compose_phase_chords(all_stages(), stage_number)
