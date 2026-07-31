"""Tests for ``backend/scripts/check_dependency_drift.py``.

The shared virtualenv silently drifted away from the pinned requirements, so
every local quality gate measured a dependency set CI never uses. The failure
mode is the expensive kind: a test asserted on a uvicorn internal that exists
in the installed version and was removed in the pinned one, so the full local
suite passed while every CI job would have raised ``AttributeError``. Gate 2 is
only worth running if it predicts Gate 3, and drift removes that faithfulness
while leaving the green checkmark in place.

These tests therefore pin the checker's *contract*, not the machine it runs on.
Drift is proven exclusively with synthetic requirements files under ``tmp_path``
plus a fake version resolver, because the real virtualenv is shared by parallel
worktrees and must never be read for its drift status, let alone mutated. The
only contact with the real environment is two ``importlib.metadata`` lookups: a
package guaranteed to be installed (``pytest``) and one guaranteed not to be.
Nothing here installs, upgrades, or removes anything.

The zero-argument default path is exercised by monkeypatching the module-level
constant rather than by running against the real requirements files, so the
suite never depends on whether the current environment happens to be clean.
"""

from __future__ import annotations

import textwrap
from collections.abc import Callable
from pathlib import Path

import pytest

from scripts import check_dependency_drift as drift_module
from scripts.check_dependency_drift import (
    DEFAULT_REQUIREMENTS_FILES,
    EXIT_CLEAN,
    EXIT_DRIFT,
    EXIT_UNVERIFIABLE,
    REMEDIATION_COMMAND,
    ConflictingPin,
    Drift,
    DriftReport,
    PinnedRequirement,
    Unevaluated,
    check_drift,
    installed_version,
    main,
    normalize_name,
    render_report,
)

MARKER_REASON = (
    "environment markers are not evaluated by this check; "
    "extend check_dependency_drift.py or restate the pin without a marker"
)
NOT_A_PIN_REASON = "not an exact == pin"
UNSUPPORTED_OPTION_REASON = "unsupported option line"
MISSING_FILE_REASON = "requirements file not found"
NOTHING_VERIFIED_REPORT = "No pinned packages were found to compare; nothing was verified.\n"
ABSENT_PACKAGE = "adepthood-definitely-not-a-real-package"
# Two distributions the test run itself guarantees: pytest is running, and
# pluggy is the plugin system running it.
PRESENT_PACKAGE = "pytest"
OTHER_PRESENT_PACKAGE = "pluggy"


def _write(path: Path, body: str) -> Path:
    """Write a dedented requirements file and return its path."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(body).lstrip("\n"))
    return path


def _installed_pin(name: str) -> str:
    """Return a one-pin requirements body matching the installed version of ``name``.

    The CLI tests drive ``main``, which always uses the production resolver, so
    their fixtures need a pin the environment genuinely satisfies. The version is
    read at test time rather than hardcoded: hardcoding would break on the next
    dependency bump and would smuggle an assertion about the shared virtualenv's
    contents into a suite that must never make one. The tests below assert only
    that the plumbing works, never which version is installed.
    """
    version = installed_version(name)
    assert version is not None, f"{name} must be installed to exercise the real resolver"
    return f"{name}=={version}\n"


def _resolver(installed: dict[str, str]) -> Callable[[str], str | None]:
    """Build a fake version resolver over a normalised-name mapping.

    This is the seam that makes drift testable: no package metadata is read and
    no environment is touched. Absent keys model a package that is not
    installed at all.
    """

    def _lookup(name: str) -> str | None:
        return installed.get(name)

    return _lookup


def test_exit_code_constants_are_the_documented_shell_codes() -> None:
    """The three exit codes are the contract between the script and check-all.sh."""
    assert EXIT_CLEAN == 0
    assert EXIT_DRIFT == 1
    assert EXIT_UNVERIFIABLE == 2


def test_remediation_command_is_the_documented_reinstall() -> None:
    """The operator must be able to paste the fix line without editing it."""
    assert REMEDIATION_COMMAND == (
        "pip install -r backend/requirements.txt -r backend/requirements-dev.txt"
    )


def test_clean_run_across_two_files_reports_no_drift(tmp_path: Path) -> None:
    """Every pin in both files matching the environment is the silent, passing case."""
    runtime = _write(
        tmp_path / "requirements.txt",
        """
        uvicorn==0.51.0
        fastapi==0.139.2
        """,
    )
    dev = _write(
        tmp_path / "requirements-dev.txt",
        """
        pytest==9.1.1
        """,
    )

    report = check_drift(
        [runtime, dev],
        resolver=_resolver({"uvicorn": "0.51.0", "fastapi": "0.139.2", "pytest": "9.1.1"}),
    )

    assert report.checked == 3
    assert report.drifted == ()
    assert report.unevaluated == ()
    assert report.conflicts == ()
    assert report.exit_code == EXIT_CLEAN
    assert render_report(report) == (
        "Dependency drift: none. 3 pinned package(s) match the active environment.\n"
    )


def test_single_drifted_pin_renders_the_actionable_block(tmp_path: Path) -> None:
    """One stale package names itself, its two versions, and the exact fix command."""
    runtime = _write(
        tmp_path / "requirements.txt",
        """
        uvicorn==0.51.0
        """,
    )

    report = check_drift([runtime], resolver=_resolver({"uvicorn": "0.44.0"}))

    assert report.drifted == (Drift(name="uvicorn", pinned="0.51.0", installed="0.44.0"),)
    assert report.checked == 1
    assert report.exit_code == EXIT_DRIFT
    assert render_report(report) == (
        "Dependency drift: 1 package does not match the pins.\n"
        "  uvicorn: pinned 0.51.0 / installed 0.44.0\n"
        "Fix: pip install -r backend/requirements.txt -r backend/requirements-dev.txt\n"
    )


def test_multiple_drifted_pins_are_listed_sorted_by_name(tmp_path: Path) -> None:
    """Offenders read alphabetically, not in file order, so scanning the list is easy."""
    runtime = _write(
        tmp_path / "requirements.txt",
        """
        uvicorn==0.51.0
        fastapi==0.139.2
        sqlalchemy==2.0.51
        """,
    )

    report = check_drift(
        [runtime],
        resolver=_resolver(
            {"uvicorn": "0.44.0", "fastapi": "0.136.0", "sqlalchemy": "2.0.49"},
        ),
    )

    assert set(report.drifted) == {
        Drift(name="fastapi", pinned="0.139.2", installed="0.136.0"),
        Drift(name="sqlalchemy", pinned="2.0.51", installed="2.0.49"),
        Drift(name="uvicorn", pinned="0.51.0", installed="0.44.0"),
    }
    assert report.checked == 3
    assert report.exit_code == EXIT_DRIFT
    assert render_report(report) == (
        "Dependency drift: 3 packages do not match the pins.\n"
        "  fastapi: pinned 0.139.2 / installed 0.136.0\n"
        "  sqlalchemy: pinned 2.0.51 / installed 2.0.49\n"
        "  uvicorn: pinned 0.51.0 / installed 0.44.0\n"
        f"Fix: {REMEDIATION_COMMAND}\n"
    )


def test_package_that_is_not_installed_is_drift_not_a_pass(tmp_path: Path) -> None:
    """A pin with no installed version at all must fail closed, never read as clean."""
    runtime = _write(
        tmp_path / "requirements.txt",
        """
        uvicorn==0.51.0
        """,
    )

    report = check_drift([runtime], resolver=_resolver({}))

    assert report.drifted == (Drift(name="uvicorn", pinned="0.51.0", installed=None),)
    assert report.exit_code == EXIT_DRIFT
    assert render_report(report) == (
        "Dependency drift: 1 package does not match the pins.\n"
        "  uvicorn: pinned 0.51.0 / installed (not installed)\n"
        f"Fix: {REMEDIATION_COMMAND}\n"
    )


def test_comments_and_blank_lines_are_skipped_and_inline_comments_stripped(
    tmp_path: Path,
) -> None:
    """Real requirements files carry commentary; none of it may leak into a version."""
    runtime = _write(
        tmp_path / "requirements.txt",
        """
        # runtime pins

        uvicorn==0.51.0  # pinned for the proxy-headers API
           # indented commentary about the next pin
        fastapi==0.139.2
        """,
    )

    report = check_drift(
        [runtime],
        resolver=_resolver({"uvicorn": "0.51.0", "fastapi": "0.139.2"}),
    )

    assert report.checked == 2
    assert report.drifted == ()
    assert report.unevaluated == ()
    assert report.exit_code == EXIT_CLEAN


def test_extras_are_stripped_from_the_compared_name(tmp_path: Path) -> None:
    """``uvicorn[standard]`` installs metadata under ``uvicorn``; compare that name."""
    runtime = _write(
        tmp_path / "requirements.txt",
        """
        uvicorn[standard]==0.51.0
        """,
    )

    report = check_drift([runtime], resolver=_resolver({"uvicorn": "0.44.0"}))

    assert report.drifted == (Drift(name="uvicorn", pinned="0.51.0", installed="0.44.0"),)
    assert report.unevaluated == ()
    assert report.checked == 1


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("uvicorn", "uvicorn"),
        ("PyJWT", "pyjwt"),
        ("types_jsonschema", "types-jsonschema"),
        ("Types.JsonSchema", "types-jsonschema"),
        ("ruamel__yaml", "ruamel-yaml"),
        ("a-_.b", "a-b"),
    ],
)
def test_normalize_name_applies_pep503_normalisation(raw: str, expected: str) -> None:
    """Distribution names are case- and separator-insensitive; comparison must be too."""
    assert normalize_name(raw) == expected


def test_differently_spelled_same_package_dedups_to_one_pin(tmp_path: Path) -> None:
    """``PyJWT`` and ``pyjwt`` are one package, so they are one checked pin."""
    runtime = _write(
        tmp_path / "requirements.txt",
        """
        PyJWT==2.13.0
        types_jsonschema==4.26.0
        """,
    )
    dev = _write(
        tmp_path / "requirements-dev.txt",
        """
        pyjwt==2.13.0
        """,
    )

    report = check_drift(
        [runtime, dev],
        resolver=_resolver({"pyjwt": "2.13.0", "types-jsonschema": "4.26.0"}),
    )

    assert report.checked == 2
    assert report.conflicts == ()
    assert report.drifted == ()
    assert report.exit_code == EXIT_CLEAN


def test_identical_pin_in_both_files_is_reported_once(tmp_path: Path) -> None:
    """The real files pin uvicorn identically twice; that is agreement, not conflict."""
    runtime = _write(
        tmp_path / "requirements.txt",
        """
        uvicorn==0.51.0
        """,
    )
    dev = _write(
        tmp_path / "requirements-dev.txt",
        """
        uvicorn==0.51.0
        """,
    )

    report = check_drift([runtime, dev], resolver=_resolver({"uvicorn": "0.44.0"}))

    assert report.checked == 1
    assert report.conflicts == ()
    assert report.drifted == (Drift(name="uvicorn", pinned="0.51.0", installed="0.44.0"),)
    assert report.exit_code == EXIT_DRIFT


def test_conflicting_pins_are_reported_and_excluded_from_the_comparison(
    tmp_path: Path,
) -> None:
    """An unsatisfiable pin set has no "does the install match?" answer to give."""
    runtime = _write(
        tmp_path / "requirements.txt",
        """
        # runtime pins
        uvicorn==0.51.0
        fastapi==0.139.2
        """,
    )
    dev = _write(
        tmp_path / "requirements-dev.txt",
        """
        # dev pins
        pytest==9.1.1
        uvicorn==0.44.0
        """,
    )

    report = check_drift(
        [runtime, dev],
        resolver=_resolver({"uvicorn": "0.44.0", "fastapi": "0.139.2", "pytest": "9.1.1"}),
    )

    assert report.conflicts == (
        ConflictingPin(
            name="uvicorn",
            first=PinnedRequirement(
                name="uvicorn",
                version="0.51.0",
                source=runtime,
                line_number=2,
            ),
            second=PinnedRequirement(
                name="uvicorn",
                version="0.44.0",
                source=dev,
                line_number=3,
            ),
        ),
    )
    assert report.drifted == ()
    assert report.checked == 2
    assert report.exit_code == EXIT_UNVERIFIABLE
    assert render_report(report) == (
        "Conflicting pins: 1 package is pinned to different versions.\n"
        f"  uvicorn: 0.51.0 ({runtime}:2) vs 0.44.0 ({dev}:3)\n"
    )


def test_conflicts_header_pluralises_for_more_than_one_package(tmp_path: Path) -> None:
    """Two disagreeing packages read as "packages are", not "package is"."""
    runtime = _write(
        tmp_path / "requirements.txt",
        """
        # runtime pins
        fastapi==0.139.2
        uvicorn==0.51.0
        """,
    )
    dev = _write(
        tmp_path / "requirements-dev.txt",
        """
        fastapi==0.136.0
        uvicorn==0.44.0
        """,
    )

    report = check_drift([runtime, dev], resolver=_resolver({}))

    assert report.checked == 0
    assert report.drifted == ()
    assert report.exit_code == EXIT_UNVERIFIABLE
    assert render_report(report) == (
        "Conflicting pins: 2 packages are pinned to different versions.\n"
        f"  fastapi: 0.139.2 ({runtime}:2) vs 0.136.0 ({dev}:1)\n"
        f"  uvicorn: 0.51.0 ({runtime}:3) vs 0.44.0 ({dev}:2)\n"
    )


def test_environment_marker_line_is_unevaluated_with_an_instructive_reason(
    tmp_path: Path,
) -> None:
    """A marker the checker cannot evaluate is a gap to report, never a silent pass."""
    runtime = _write(
        tmp_path / "requirements.txt",
        """
        # runtime pins
        httpx==0.28.1; python_version < "3.13"
        """,
    )

    report = check_drift([runtime], resolver=_resolver({"httpx": "0.28.1"}))

    assert report.unevaluated == (
        Unevaluated(
            source=runtime,
            line_number=2,
            text='httpx==0.28.1; python_version < "3.13"',
            reason=MARKER_REASON,
        ),
    )
    assert report.checked == 0
    assert report.exit_code == EXIT_UNVERIFIABLE
    assert render_report(report) == (
        "Cannot verify the pinned set: 1 requirement line(s) were not evaluated.\n"
        f"  {runtime}:2: {MARKER_REASON}\n"
        '    httpx==0.28.1; python_version < "3.13"\n'
    )


def test_lines_that_are_not_exact_pins_are_unevaluated(tmp_path: Path) -> None:
    """Ranges, bare names, and URLs cannot be compared, so they must be surfaced."""
    runtime = _write(
        tmp_path / "requirements.txt",
        """
        ruff>=0.6.0
        black~=24.3.0
        wheel
        https://example.invalid/wheels/pkg-1.0.0-py3-none-any.whl
        """,
    )

    report = check_drift([runtime], resolver=_resolver({}))

    assert report.unevaluated == (
        Unevaluated(source=runtime, line_number=1, text="ruff>=0.6.0", reason=NOT_A_PIN_REASON),
        Unevaluated(source=runtime, line_number=2, text="black~=24.3.0", reason=NOT_A_PIN_REASON),
        Unevaluated(source=runtime, line_number=3, text="wheel", reason=NOT_A_PIN_REASON),
        Unevaluated(
            source=runtime,
            line_number=4,
            text="https://example.invalid/wheels/pkg-1.0.0-py3-none-any.whl",
            reason=NOT_A_PIN_REASON,
        ),
    )
    assert report.checked == 0
    assert report.drifted == ()
    assert report.exit_code == EXIT_UNVERIFIABLE


def test_unsupported_option_lines_are_unevaluated(tmp_path: Path) -> None:
    """Index URLs and editable installs are options the checker declines to interpret."""
    runtime = _write(
        tmp_path / "requirements.txt",
        """
        --extra-index-url https://example.invalid/simple
        -e .
        uvicorn==0.51.0
        """,
    )

    report = check_drift([runtime], resolver=_resolver({"uvicorn": "0.51.0"}))

    assert report.unevaluated == (
        Unevaluated(
            source=runtime,
            line_number=1,
            text="--extra-index-url https://example.invalid/simple",
            reason=UNSUPPORTED_OPTION_REASON,
        ),
        Unevaluated(
            source=runtime,
            line_number=2,
            text="-e .",
            reason=UNSUPPORTED_OPTION_REASON,
        ),
    )
    assert report.checked == 1
    assert report.drifted == ()
    assert report.exit_code == EXIT_UNVERIFIABLE


@pytest.mark.parametrize("include_option", ["-r", "--requirement"])
def test_includes_resolve_relative_to_the_including_file(
    tmp_path: Path,
    include_option: str,
) -> None:
    """An include path is relative to its own file, not to the process working directory."""
    _write(
        tmp_path / "reqs" / "sub" / "deeper" / "deepest.txt",
        """
        uvicorn==0.51.0
        """,
    )
    _write(
        tmp_path / "reqs" / "sub" / "more.txt",
        f"""
        fastapi==0.139.2
        {include_option} deeper/deepest.txt
        """,
    )
    base = _write(
        tmp_path / "reqs" / "base.txt",
        f"""
        {include_option} sub/more.txt
        """,
    )

    report = check_drift(
        [base],
        resolver=_resolver({"uvicorn": "0.51.0", "fastapi": "0.139.2"}),
    )

    assert report.checked == 2
    assert report.unevaluated == ()
    assert report.drifted == ()
    assert report.exit_code == EXIT_CLEAN


def test_include_cycle_terminates_and_counts_each_pin_once(tmp_path: Path) -> None:
    """Mutually including files must not recurse forever or double-count a pin."""
    _write(
        tmp_path / "a.txt",
        """
        -r b.txt
        alpha==1.0.0
        """,
    )
    _write(
        tmp_path / "b.txt",
        """
        -r a.txt
        beta==2.0.0
        """,
    )

    report = check_drift(
        [tmp_path / "a.txt"],
        resolver=_resolver({"alpha": "1.0.0", "beta": "2.0.0"}),
    )

    assert report.checked == 2
    assert report.unevaluated == ()
    assert report.exit_code == EXIT_CLEAN


def test_missing_top_level_file_is_reported_without_a_traceback(tmp_path: Path) -> None:
    """A path that does not exist is an unverifiable pin set, not a crash."""
    missing = tmp_path / "requirements.txt"

    report = check_drift([missing], resolver=_resolver({}))

    assert report.unevaluated == (
        Unevaluated(
            source=missing,
            line_number=0,
            text=str(missing),
            reason=MISSING_FILE_REASON,
        ),
    )
    assert report.checked == 0
    assert report.exit_code == EXIT_UNVERIFIABLE
    assert render_report(report) == (
        "Cannot verify the pinned set: 1 requirement line(s) were not evaluated.\n"
        f"  {missing}: {MISSING_FILE_REASON}\n"
        f"    {missing}\n"
    )


def test_missing_include_target_is_reported_against_the_resolved_path(tmp_path: Path) -> None:
    """A dangling include names the file it looked for, so the operator can find it.

    The finding points at the include target rather than at the including file,
    and reports the path it looked up as its own text.
    """
    base = _write(
        tmp_path / "requirements.txt",
        """
        uvicorn==0.51.0
        -r missing/other.txt
        """,
    )

    report = check_drift([base], resolver=_resolver({"uvicorn": "0.51.0"}))

    expected_target = tmp_path / "missing" / "other.txt"
    assert len(report.unevaluated) == 1
    finding = report.unevaluated[0]
    assert finding.source.resolve() == expected_target.resolve()
    assert finding.line_number == 0
    assert finding.text == str(finding.source)
    assert finding.reason == MISSING_FILE_REASON
    assert report.checked == 1
    assert report.drifted == ()
    assert report.exit_code == EXIT_UNVERIFIABLE


def test_drift_outranks_unevaluated_in_the_exit_code(tmp_path: Path) -> None:
    """Both findings are reported, but a concrete mismatch is the headline failure."""
    runtime = _write(
        tmp_path / "requirements.txt",
        """
        uvicorn==0.51.0
        ruff>=0.6.0
        """,
    )

    report = check_drift([runtime], resolver=_resolver({"uvicorn": "0.44.0"}))

    assert report.drifted == (Drift(name="uvicorn", pinned="0.51.0", installed="0.44.0"),)
    assert report.unevaluated == (
        Unevaluated(source=runtime, line_number=2, text="ruff>=0.6.0", reason=NOT_A_PIN_REASON),
    )
    assert report.exit_code == EXIT_DRIFT
    assert render_report(report) == (
        "Dependency drift: 1 package does not match the pins.\n"
        "  uvicorn: pinned 0.51.0 / installed 0.44.0\n"
        f"Fix: {REMEDIATION_COMMAND}\n"
        "Cannot verify the pinned set: 1 requirement line(s) were not evaluated.\n"
        f"  {runtime}:2: {NOT_A_PIN_REASON}\n"
        "    ruff>=0.6.0\n"
    )


def test_a_run_that_compared_no_pins_is_unverifiable_not_clean() -> None:
    """Zero compared pins proves nothing, so it must fail the gate rather than pass it.

    Emptying a requirements file, truncating one in a bad merge, or aiming the
    CLI at the wrong pair of paths all land here. Reporting success for a run
    that verified nothing is the fail-open the whole check exists to forbid.
    """
    report = DriftReport(checked=0, drifted=(), unevaluated=(), conflicts=())

    assert report.exit_code == EXIT_UNVERIFIABLE


def test_render_report_says_plainly_that_nothing_was_verified() -> None:
    """The zero-pin report must name its cause, never claim everything matched."""
    report = DriftReport(checked=0, drifted=(), unevaluated=(), conflicts=())

    assert render_report(report) == NOTHING_VERIFIED_REPORT


def test_default_resolver_reads_metadata_of_an_installed_package() -> None:
    """The production resolver must return a real version string for a real package.

    ``pytest`` is by definition installed while this test runs. The assertion is
    deliberately shape-only: asserting a specific version would couple the suite
    to the very environment state the checker exists to police.
    """
    version = installed_version("pytest")

    assert isinstance(version, str)
    assert version != ""


def test_default_resolver_returns_none_for_an_absent_package() -> None:
    """A package that is not installed resolves to None rather than raising."""
    assert installed_version(ABSENT_PACKAGE) is None


def test_default_requirements_files_are_the_two_backend_pin_files() -> None:
    """The default target set is exactly the pair the setup instructions install.

    Only the names, locations, and existence of the files are asserted; their
    drift status belongs to the operator's environment, never to this suite.
    """
    assert len(DEFAULT_REQUIREMENTS_FILES) == 2
    assert tuple(path.name for path in DEFAULT_REQUIREMENTS_FILES) == (
        "requirements.txt",
        "requirements-dev.txt",
    )
    assert all(path.parent.name == "backend" for path in DEFAULT_REQUIREMENTS_FILES)
    assert all(path.is_file() for path in DEFAULT_REQUIREMENTS_FILES)


def test_main_writes_a_clean_report_to_stdout(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A passing check is ordinary output, so check-all.sh stays quiet on success."""
    runtime = _write(tmp_path / "requirements.txt", _installed_pin(PRESENT_PACKAGE))

    exit_code = main([str(runtime)])

    captured = capsys.readouterr()
    assert exit_code == EXIT_CLEAN
    assert captured.out == (
        "Dependency drift: none. 1 pinned package(s) match the active environment.\n"
    )
    assert captured.err == ""


def test_main_writes_a_drift_report_to_stderr(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A failing check reports on stderr so the gate's failure output is unambiguous.

    The pinned package is one that cannot exist in any environment, which makes
    the "not installed" branch deterministic without inspecting real versions.
    """
    runtime = _write(tmp_path / "requirements.txt", f"{ABSENT_PACKAGE}==0.0.0\n")

    exit_code = main([str(runtime)])

    captured = capsys.readouterr()
    assert exit_code == EXIT_DRIFT
    assert captured.out == ""
    assert captured.err == (
        "Dependency drift: 1 package does not match the pins.\n"
        f"  {ABSENT_PACKAGE}: pinned 0.0.0 / installed (not installed)\n"
        f"Fix: {REMEDIATION_COMMAND}\n"
    )


def test_main_writes_an_unverifiable_report_to_stderr(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """An unverifiable pin set fails the gate too, with its own diagnostic code."""
    runtime = _write(tmp_path / "requirements.txt", "-e .\n")

    exit_code = main([str(runtime)])

    captured = capsys.readouterr()
    assert exit_code == EXIT_UNVERIFIABLE
    assert captured.out == ""
    assert captured.err == (
        "Cannot verify the pinned set: 1 requirement line(s) were not evaluated.\n"
        f"  {runtime}:1: {UNSUPPORTED_OPTION_REASON}\n"
        "    -e .\n"
    )


def test_main_reports_a_file_with_no_pins_as_unverifiable_on_stderr(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A requirements file left with nothing to compare fails the gate on stderr.

    This is the fail-open the checker must refuse: a truncating merge or an
    emptied file leaves a parseable file with zero pins, and reporting that as
    a pass would manufacture the confidence the gate is supposed to earn.
    """
    runtime = _write(tmp_path / "requirements.txt", "# every pin was lost in a bad merge\n")

    exit_code = main([str(runtime)])

    captured = capsys.readouterr()
    assert exit_code == EXIT_UNVERIFIABLE
    assert captured.out == ""
    assert captured.err == NOTHING_VERIFIED_REPORT


def test_main_checks_several_explicit_paths(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The CLI takes the runtime and dev files as separate arguments."""
    runtime = _write(tmp_path / "requirements.txt", _installed_pin(PRESENT_PACKAGE))
    dev = _write(tmp_path / "requirements-dev.txt", _installed_pin(OTHER_PRESENT_PACKAGE))

    exit_code = main([str(runtime), str(dev)])

    assert exit_code == EXIT_CLEAN
    assert capsys.readouterr().out == (
        "Dependency drift: none. 2 pinned package(s) match the active environment.\n"
    )


@pytest.mark.parametrize("argv", [None, []])
def test_main_without_paths_uses_the_default_requirements_files(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    argv: list[str] | None,
) -> None:
    """No arguments means the backend pin files, looked up when main runs.

    The constant is redirected to a fixture file so the fallback is proven
    without reading the shared environment's actual drift status.
    """
    runtime = _write(tmp_path / "requirements.txt", _installed_pin(PRESENT_PACKAGE))
    monkeypatch.setattr(drift_module, "DEFAULT_REQUIREMENTS_FILES", (runtime,))

    exit_code = main(argv)

    assert exit_code == EXIT_CLEAN
    assert capsys.readouterr().out == (
        "Dependency drift: none. 1 pinned package(s) match the active environment.\n"
    )
