"""Fail the backend gate when the active virtualenv drifts from the pinned set.

Every local quality gate measures the packages that are *installed*, not the
packages that are *pinned*. When those two sets disagree, Gate 2 stops
predicting Gate 3: a suite can pass locally against an old uvicorn and then
raise ``AttributeError`` on every CI job, with a green checkmark in between.
The documented setup command (``pip install -r requirements.txt -r
requirements-dev.txt``) installs what is missing but never reports what is
stale, which is what kept the drift invisible.

This check therefore runs first, before anything that would spend minutes
measuring a lie. It reads already-installed metadata through
``importlib.metadata`` — no subprocess, no ``pip``, no network — so it costs
milliseconds. It deliberately does **not** repair the environment: the
virtualenv is shared by parallel worktrees, so installing mid-run would race
its siblings. It reports and fails; the operator runs the fix.

The design constraint that shapes every branch below is that this check must
never fail open. A gate that reports success while having verified nothing is
worse than no gate at all, because it manufactures confidence. So a package
that is missing entirely counts as drift, and any line the parser cannot
interpret — an environment marker, a version range, an unreadable file —
counts as "could not verify" rather than "fine". The same rule decides the
emptiest case: a run that ends up comparing no pins at all has learned
nothing, so it says exactly that instead of claiming everything matched.

Usage:

    python -m scripts.check_dependency_drift                    # the backend pins
    python -m scripts.check_dependency_drift path/to/reqs.txt   # explicit files

Exit codes:
    0 — every pin matches the installed distribution.
    1 — at least one pinned package is missing or at the wrong version.
    2 — the pin set could not be fully evaluated (unparseable line, missing
        file, two files pinning one package to different versions, or no pins
        found to compare at all). No drift was proven, but none was ruled out
        either.
    Both non-zero codes fail the gate; the split exists only to tell an
    operator whether to reinstall or to fix the requirements files.
"""

from __future__ import annotations

import re
import sys
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass, field
from importlib import metadata
from pathlib import Path

EXIT_CLEAN = 0
EXIT_DRIFT = 1
EXIT_UNVERIFIABLE = 2

REMEDIATION_COMMAND = "pip install -r backend/requirements.txt -r backend/requirements-dev.txt"

_BACKEND_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_REQUIREMENTS_FILES: tuple[Path, ...] = (
    _BACKEND_ROOT / "requirements.txt",
    _BACKEND_ROOT / "requirements-dev.txt",
)

_MARKER_REASON = (
    "environment markers are not evaluated by this check; "
    "extend check_dependency_drift.py or restate the pin without a marker"
)
_NOT_A_PIN_REASON = "not an exact == pin"
_UNSUPPORTED_OPTION_REASON = "unsupported option line"
_MISSING_FILE_REASON = "requirements file not found"

_NOT_INSTALLED = "(not installed)"
_NOTHING_VERIFIED = "No pinned packages were found to compare; nothing was verified.\n"

_COMMENT_PREFIX = "#"
_OPTION_PREFIX = "-"
_MARKER_SEPARATOR = ";"
_INCLUDE_OPTIONS = ("-r", "--requirement")
# An include is the option token plus exactly one path argument.
_INCLUDE_TOKEN_COUNT = 2
# Line number reserved for findings about a whole file rather than a line in it.
_WHOLE_FILE = 0

# ``name[extras]==version``. Anything looser (>=, ~=, a bare name, a URL) is
# deliberately rejected so it surfaces as unevaluated instead of passing.
_EXACT_PIN = re.compile(
    r"^(?P<name>[A-Za-z0-9._-]+)\s*(?:\[[^\]]*\])?\s*==\s*(?P<version>\S+)$",
)
_NAME_SEPARATORS = re.compile(r"[-_.]+")


@dataclass(frozen=True)
class PinnedRequirement:
    """One ``name==version`` pin, with the file and line it came from."""

    name: str
    version: str
    source: Path
    line_number: int


@dataclass(frozen=True)
class Drift:
    """A pin whose installed version disagrees with the pinned one.

    ``installed`` is ``None`` when the distribution is absent entirely, which
    is drift rather than an excuse to skip the comparison.
    """

    name: str
    pinned: str
    installed: str | None


@dataclass(frozen=True)
class Unevaluated:
    """A requirement line the checker declined to interpret, and why.

    ``line_number`` is 0 for findings about a whole file (a path that does not
    exist), in which case ``text`` repeats the path that was looked up.
    """

    source: Path
    line_number: int
    text: str
    reason: str


@dataclass(frozen=True)
class ConflictingPin:
    """Two files pinning one package to different versions.

    An unsatisfiable pin set has no "does the install match?" answer to give,
    so the package is excluded from the drift comparison and reported instead.
    """

    name: str
    first: PinnedRequirement
    second: PinnedRequirement


@dataclass(frozen=True)
class DriftReport:
    """The full outcome of one run: what matched, what drifted, what could not be read."""

    checked: int
    drifted: tuple[Drift, ...]
    unevaluated: tuple[Unevaluated, ...]
    conflicts: tuple[ConflictingPin, ...]

    @property
    def exit_code(self) -> int:
        """Return the process exit code for this report."""
        return _grade(self)


def _grade(report: DriftReport) -> int:
    """Decide a report's exit code, with proven drift outranking uncertainty.

    Args:
        report: The report to grade.

    Returns:
        ``EXIT_DRIFT`` when any pin mismatched, ``EXIT_UNVERIFIABLE`` when the
        pin set could not be fully read — including when there was nothing to
        compare, since having checked nothing must never be reported the same
        way as having checked everything and found it sound — and
        ``EXIT_CLEAN`` only when real pins were compared and all of them held.
    """
    if report.drifted:
        return EXIT_DRIFT
    if report.unevaluated or report.conflicts or not report.checked:
        return EXIT_UNVERIFIABLE
    return EXIT_CLEAN


@dataclass(frozen=True)
class _Include:
    """A ``-r``/``--requirement`` directive pointing at another requirements file."""

    target: Path


@dataclass
class _Collected:
    """Mutable accumulator threaded through the recursive file walk."""

    pins: list[PinnedRequirement] = field(default_factory=list)
    unevaluated: list[Unevaluated] = field(default_factory=list)
    visited: set[Path] = field(default_factory=set)


def normalize_name(name: str) -> str:
    """Return the PEP 503 normalised form of a distribution name.

    Args:
        name: A distribution name as spelled in a requirements file.

    Returns:
        The lowercased name with every run of ``-``, ``_``, or ``.``
        collapsed to a single ``-``, so ``PyJWT`` and ``pyjwt`` compare equal.
    """
    return _NAME_SEPARATORS.sub("-", name).lower()


def installed_version(name: str) -> str | None:
    """Return the installed version of a distribution, or ``None`` if absent.

    Reads the metadata the interpreter already has on disk. It never shells
    out to ``pip`` and never touches the network, both because this runs at
    the head of every gate and because the environment is shared.

    Args:
        name: The distribution name to look up.

    Returns:
        The installed version string, or ``None`` when the distribution is
        not installed in the active environment.
    """
    try:
        found = metadata.version(name)
    except metadata.PackageNotFoundError:
        return None
    return found


def iter_requirement_lines(path: Path) -> Iterator[tuple[int, str]]:
    """Yield the meaningful lines of a requirements file.

    Args:
        path: An existing requirements file.

    Yields:
        ``(line_number, text)`` pairs — 1-based line numbers and stripped
        text — for every line that is neither blank nor a whole-line comment.
    """
    for number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        stripped = raw.strip()
        if stripped and not stripped.startswith(_COMMENT_PREFIX):
            yield number, stripped


def parse_pin(source: Path, line_number: int, text: str) -> PinnedRequirement | Unevaluated:
    """Parse one non-option requirement line into a pin, or explain the refusal.

    Args:
        source: The file the line came from.
        line_number: The 1-based line number within that file.
        text: The stripped line, possibly carrying a trailing inline comment.

    Returns:
        A :class:`PinnedRequirement` for an exact ``name[extras]==version``
        pin, otherwise an :class:`Unevaluated` naming the reason: an
        environment marker this checker does not evaluate, or a requirement
        that is not an exact pin at all.
    """
    requirement = text.split(_COMMENT_PREFIX, 1)[0].strip()
    if _MARKER_SEPARATOR in requirement:
        return Unevaluated(
            source=source,
            line_number=line_number,
            text=requirement,
            reason=_MARKER_REASON,
        )
    match = _EXACT_PIN.match(requirement)
    if match is None:
        return Unevaluated(
            source=source,
            line_number=line_number,
            text=requirement,
            reason=_NOT_A_PIN_REASON,
        )
    return PinnedRequirement(
        name=normalize_name(match["name"]),
        version=match["version"],
        source=source,
        line_number=line_number,
    )


def _parse_option(source: Path, line_number: int, text: str) -> _Include | Unevaluated:
    """Interpret a leading-dash line as an include, or decline to interpret it.

    Args:
        source: The file the line came from.
        line_number: The 1-based line number within that file.
        text: The stripped line, starting with ``-``.

    Returns:
        An :class:`_Include` whose target is resolved relative to the
        *including* file's directory, or an :class:`Unevaluated` for any other
        option (index URLs, editable installs, hash modes).
    """
    tokens = text.split()
    if len(tokens) >= _INCLUDE_TOKEN_COUNT and tokens[0] in _INCLUDE_OPTIONS:
        return _Include(target=source.parent / tokens[1])
    return Unevaluated(
        source=source,
        line_number=line_number,
        text=text,
        reason=_UNSUPPORTED_OPTION_REASON,
    )


def classify_line(
    source: Path,
    line_number: int,
    text: str,
) -> PinnedRequirement | Unevaluated | _Include:
    """Classify one meaningful requirements line.

    Args:
        source: The file the line came from.
        line_number: The 1-based line number within that file.
        text: The stripped line.

    Returns:
        An :class:`_Include` to recurse into, a :class:`PinnedRequirement` to
        compare, or an :class:`Unevaluated` to report.
    """
    if text.startswith(_OPTION_PREFIX):
        return _parse_option(source, line_number, text)
    return parse_pin(source, line_number, text)


def _parse_file(path: Path, collected: _Collected) -> None:
    """Walk one requirements file, following includes, into ``collected``.

    Args:
        path: The file to read. A path that does not exist is recorded as an
            unevaluated finding rather than raised, so a dangling include
            never turns the gate into a traceback.
        collected: The accumulator to append pins and findings to.
    """
    # Cycle and diamond guard. Resolved only for identity: the *reported*
    # paths stay as written, since a resolved path can surprise the reader
    # (on macOS, /var silently becomes /private/var).
    identity = path.resolve()
    if identity in collected.visited:
        return
    collected.visited.add(identity)

    if not path.is_file():
        collected.unevaluated.append(
            Unevaluated(
                source=path,
                line_number=_WHOLE_FILE,
                text=str(path),
                reason=_MISSING_FILE_REASON,
            ),
        )
        return

    for number, text in iter_requirement_lines(path):
        _record(classify_line(path, number, text), collected)


def _record(item: PinnedRequirement | Unevaluated | _Include, collected: _Collected) -> None:
    """File one classified line into the accumulator, recursing into includes.

    Args:
        item: The classification produced by :func:`classify_line`.
        collected: The accumulator to append to.
    """
    if isinstance(item, _Include):
        _parse_file(item.target, collected)
    elif isinstance(item, PinnedRequirement):
        collected.pins.append(item)
    else:
        collected.unevaluated.append(item)


def _index_pins(
    pins: Sequence[PinnedRequirement],
) -> tuple[dict[str, PinnedRequirement], tuple[ConflictingPin, ...]]:
    """Deduplicate pins by normalised name and detect disagreements.

    Args:
        pins: Every pin found, in file order, possibly with repeats.

    Returns:
        A ``(unique, conflicts)`` pair. ``unique`` maps each normalised name
        to its first pin. A name repeated with the *same* version is agreement
        (the real files pin uvicorn twice), not a conflict; a name repeated
        with a different version yields one :class:`ConflictingPin`. A name
        pinned to three or more different versions reports only the first
        disagreement — it is excluded from the comparison either way, so the
        extra detail would not change the verdict.
    """
    unique: dict[str, PinnedRequirement] = {}
    conflicts: dict[str, ConflictingPin] = {}
    for pin in pins:
        first = unique.setdefault(pin.name, pin)
        if first.version != pin.version:
            conflicts.setdefault(pin.name, ConflictingPin(name=pin.name, first=first, second=pin))
    return unique, tuple(conflicts.values())


def _compare_pins(
    unique: dict[str, PinnedRequirement],
    conflicted: frozenset[str],
    resolver: Callable[[str], str | None],
) -> tuple[int, tuple[Drift, ...]]:
    """Compare each unambiguous pin against the environment.

    Args:
        unique: Normalised name to pin, as built by :func:`_index_pins`.
        conflicted: Names excluded from the comparison because their pins
            disagree; they are neither checked nor counted.
        resolver: Maps a normalised name to its installed version, or ``None``.

    Returns:
        A ``(checked, drifted)`` pair, with drifted entries sorted by name so
        the rendered list scans alphabetically rather than in file order.
    """
    drifted: list[Drift] = []
    checked = 0
    for name, pin in unique.items():
        if name in conflicted:
            continue
        checked += 1
        found = resolver(name)
        if found != pin.version:
            drifted.append(Drift(name=name, pinned=pin.version, installed=found))
    return checked, tuple(sorted(drifted, key=lambda item: item.name))


def check_drift(
    files: Sequence[Path],
    *,
    resolver: Callable[[str], str | None] = installed_version,
) -> DriftReport:
    """Compare the pins in ``files`` against the versions the resolver reports.

    Args:
        files: Requirements files to read. Includes are followed; a file
            reached twice is read once.
        resolver: Seam for the version lookup. Defaults to reading real
            installed metadata; tests substitute a pure mapping so no
            environment is read.

    Returns:
        A :class:`DriftReport` carrying every mismatch, every conflicting pin,
        and every line that could not be evaluated.
    """
    collected = _Collected()
    for path in files:
        _parse_file(path, collected)

    unique, conflicts = _index_pins(collected.pins)
    conflicted = frozenset(conflict.name for conflict in conflicts)
    checked, drifted = _compare_pins(unique, conflicted, resolver)

    return DriftReport(
        checked=checked,
        drifted=drifted,
        unevaluated=tuple(collected.unevaluated),
        conflicts=conflicts,
    )


def _drift_lines(drifted: tuple[Drift, ...]) -> list[str]:
    """Render the drift section, ending with the paste-ready fix command.

    Args:
        drifted: The mismatched packages, already sorted.

    Returns:
        The rendered lines, without trailing newlines.
    """
    verb = "package does" if len(drifted) == 1 else "packages do"
    lines = [f"Dependency drift: {len(drifted)} {verb} not match the pins."]
    lines.extend(
        f"  {item.name}: pinned {item.pinned} / "
        f"installed {item.installed if item.installed is not None else _NOT_INSTALLED}"
        for item in drifted
    )
    lines.append(f"Fix: {REMEDIATION_COMMAND}")
    return lines


def _conflict_lines(conflicts: tuple[ConflictingPin, ...]) -> list[str]:
    """Render the conflicting-pins section, citing both file:line locations.

    Args:
        conflicts: The packages pinned to more than one version.

    Returns:
        The rendered lines, without trailing newlines.
    """
    verb = "package is" if len(conflicts) == 1 else "packages are"
    lines = [f"Conflicting pins: {len(conflicts)} {verb} pinned to different versions."]
    lines.extend(
        f"  {item.name}: {item.first.version} "
        f"({item.first.source}:{item.first.line_number}) vs {item.second.version} "
        f"({item.second.source}:{item.second.line_number})"
        for item in conflicts
    )
    return lines


def _unevaluated_lines(unevaluated: tuple[Unevaluated, ...]) -> list[str]:
    """Render the could-not-verify section, quoting each offending line.

    Args:
        unevaluated: The requirement lines that were not evaluated.

    Returns:
        The rendered lines, without trailing newlines.
    """
    count = len(unevaluated)
    lines = [f"Cannot verify the pinned set: {count} requirement line(s) were not evaluated."]
    for item in unevaluated:
        location = f"{item.source}"
        if item.line_number != _WHOLE_FILE:
            location = f"{location}:{item.line_number}"
        lines.append(f"  {location}: {item.reason}")
        lines.append(f"    {item.text}")
    return lines


def _finding_lines(report: DriftReport) -> list[str]:
    """Render every non-empty finding section, in severity order.

    Args:
        report: The report to render.

    Returns:
        The rendered lines, empty when the run found nothing at all.
    """
    lines: list[str] = []
    if report.drifted:
        lines.extend(_drift_lines(report.drifted))
    if report.conflicts:
        lines.extend(_conflict_lines(report.conflicts))
    if report.unevaluated:
        lines.extend(_unevaluated_lines(report.unevaluated))
    return lines


def render_report(report: DriftReport) -> str:
    """Render a report as the operator-facing text the gate prints.

    Args:
        report: The report to render.

    Returns:
        A newline-terminated block. A clean run is one reassuring line naming
        how many pins were actually verified, so "checked nothing" can never
        read the same as "checked everything" — and a run with nothing to
        compare says so outright instead of borrowing that reassurance.
    """
    lines = _finding_lines(report)
    if lines:
        return "\n".join(lines) + "\n"
    if not report.checked:
        return _NOTHING_VERIFIED
    return (
        f"Dependency drift: none. {report.checked} pinned package(s) "
        "match the active environment.\n"
    )


def main(argv: Sequence[str] | None = None) -> int:
    """Run the check over the given paths, or over the backend pin files.

    Args:
        argv: Requirements-file paths. ``None`` or empty means
            ``DEFAULT_REQUIREMENTS_FILES``, read here rather than bound as a
            default so callers and tests can redirect it.

    Returns:
        The report's exit code. The report goes to stdout when clean and to
        stderr otherwise, so a failing gate's output is unambiguous.
    """
    paths = [Path(item) for item in argv] if argv else list(DEFAULT_REQUIREMENTS_FILES)
    report = check_drift(paths)
    stream = sys.stdout if report.exit_code == EXIT_CLEAN else sys.stderr
    stream.write(render_report(report))
    return report.exit_code


if __name__ == "__main__":  # pragma: no cover — exercised via tests/CLI
    sys.exit(main(sys.argv[1:]))
