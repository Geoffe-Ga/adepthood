"""CI must run the stage-correspondence generator's drift check, armed.

Issue #2667: ``scripts/build_stage_correspondence.py`` regenerates
``src/curriculum/stage_correspondence.json`` from the vendored Complete Map CSV
and the ratified supersessions, and its ``--check`` mode exits 1 when the
committed artifact is stale. That exit code is only worth something if a
required job reads it. Until this module, the generator's own docstring called
``--check`` "the CI drift gate" while no workflow invoked it at all: a CSV
re-pin, a supersession edit or a schema bump could land with an artifact that
no longer matched its inputs, and every check stayed green.

The gate lives in the ``content-drift`` job of ``backend-ci.yml``, after the
step that proves the vendored tree matches ``CONTENT_VERSION`` -- the artifact
is generated *from* that tree, so checking it first would grade the output of
an input nobody had verified yet. The job installs only the drift scripts'
third-party imports, so this module also walks those imports and fails when
one of them is missing from the install step: an ``ImportError`` exits 1 too,
and a gate that is red for the wrong reason teaches people to ignore it.

Parsed as plain text through ``tests.workflow_text``, like the other guards in
this directory: PyYAML is deliberately in no requirements file. Every check is
a predicate over workflow text, so the code that grades the real workflow is
also pointed at deliberately violating copies below. A gate never observed to
fail is not known to be a gate.
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

import pytest

from tests.workflow_text import jobs, step_body, step_run_command, without_comment_lines

_REPO_ROOT = Path(__file__).resolve().parents[3]
_BACKEND = _REPO_ROOT / "backend"
_WORKFLOW = _REPO_ROOT / ".github" / "workflows" / "backend-ci.yml"

_JOB = "content-drift"
_INSTALL_STEP = "Install drift-check deps"
_SYNC_STEP = "Verify vendored content matches CONTENT_VERSION"
_SYNC_COMMAND = "python -m scripts.sync_content --check"
_GATE_STEP = "Verify stage_correspondence.json is current"
_GATE_COMMAND = "python -m scripts.build_stage_correspondence --check"
_GATE_WORKING_DIRECTORY = "working-directory: backend"

# Anything that lets a step fail without failing the job. Searched for in the
# comment-stripped job only, so the header explaining why none of these are
# used cannot itself trip the check.
_DISARMING_FRAGMENTS = (
    "continue-on-error",
    "|| true",
    "|| echo",
    "|| exit 0",
    "set +e",
    "if: false",
)

# The scripts the job runs, whose third-party imports the install step owns.
_DRIFT_SCRIPTS = (
    _BACKEND / "scripts" / "build_stage_correspondence.py",
    _BACKEND / "scripts" / "sync_content.py",
)

# Top-level import roots that are this repo's own code, not an installed package.
_FIRST_PARTY_ROOTS = frozenset({"__future__", "scripts"})

# Import root -> the distribution the install step must name for it. A new
# import that is not listed here fails loudly rather than being waved through.
_DISTRIBUTION_FOR_IMPORT = {"jsonschema": "jsonschema", "httpx": "httpx"}


def _content_drift_job(workflow_text: str) -> str:
    """Return the ``content-drift`` job body, scoped so no other job can answer."""
    found = jobs(workflow_text)
    assert _JOB in found, f"backend-ci.yml declares no {_JOB!r} job"
    return found[_JOB]


def _gate_problems(workflow_text: str) -> list[str]:
    """Return why the job's stage-correspondence step does not run the gate, if it does not."""
    job = _content_drift_job(workflow_text)
    names = [line.strip() for line in without_comment_lines(job).splitlines()]
    if f"- name: {_GATE_STEP}" not in names:
        return [f"{_JOB} has no step named {_GATE_STEP!r}"]
    problems = []
    command = step_run_command(job, _GATE_STEP)
    if command != _GATE_COMMAND:
        problems.append(f"{_GATE_STEP!r} runs {command!r}, not {_GATE_COMMAND!r}")
    live = [line.strip() for line in step_body(without_comment_lines(job), _GATE_STEP)]
    if _GATE_WORKING_DIRECTORY not in live:
        problems.append(f"{_GATE_STEP!r} does not set {_GATE_WORKING_DIRECTORY!r}")
    return problems


def _ordering_problems(workflow_text: str) -> list[str]:
    """Return why the gate does not run after the vendored-content check, if it does not."""
    lines = [
        line.strip()
        for line in without_comment_lines(_content_drift_job(workflow_text)).splitlines()
    ]
    sync, gate = f"- name: {_SYNC_STEP}", f"- name: {_GATE_STEP}"
    if sync not in lines or gate not in lines:
        return [f"{_JOB} lacks {_SYNC_STEP!r} or {_GATE_STEP!r}"]
    if lines.index(sync) > lines.index(gate):
        return [f"{_GATE_STEP!r} runs before {_SYNC_STEP!r}, so it grades unverified input"]
    return []


def _disarming_fragments(workflow_text: str) -> list[str]:
    """Return every exit-code-swallowing fragment live in the ``content-drift`` job."""
    live = without_comment_lines(_content_drift_job(workflow_text))
    return [fragment for fragment in _DISARMING_FRAGMENTS if fragment in live]


def _third_party_import_roots(paths: tuple[Path, ...]) -> set[str]:
    """Return the top-level module names the scripts import that are neither stdlib nor ours."""
    roots: set[str] = set()
    for path in paths:
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Import):
                roots.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module is not None and node.level == 0:
                roots.add(node.module.split(".")[0])
    return roots - set(sys.stdlib_module_names) - _FIRST_PARTY_ROOTS


def _install_problems(workflow_text: str, import_roots: set[str]) -> list[str]:
    """Return every third-party import the job's install step does not provide."""
    command = step_run_command(_content_drift_job(workflow_text), _INSTALL_STEP)
    problems = []
    for root in sorted(import_roots):
        distribution = _DISTRIBUTION_FOR_IMPORT.get(root)
        if distribution is None:
            problems.append(
                f"the drift scripts import {root!r}; map it in _DISTRIBUTION_FOR_IMPORT "
                f"and add it to {_INSTALL_STEP!r}"
            )
        elif distribution not in command:
            problems.append(f"{_INSTALL_STEP!r} does not install {distribution!r} for {root!r}")
    return problems


def _real_workflow() -> str:
    """Return the committed ``backend-ci.yml``."""
    return _WORKFLOW.read_text(encoding="utf-8")


# --- the committed workflow --------------------------------------------------


def test_content_drift_job_runs_the_stage_correspondence_check() -> None:
    """The job runs exactly ``build_stage_correspondence --check`` from ``backend/``."""
    assert _gate_problems(_real_workflow()) == []


def test_the_gate_runs_after_the_vendored_content_check() -> None:
    """The artifact is graded only once the tree it is generated from is verified."""
    assert _ordering_problems(_real_workflow()) == []


def test_the_job_is_not_disarmed() -> None:
    """Nothing in the job lets the gate's exit code be swallowed."""
    assert _disarming_fragments(_real_workflow()) == []


def test_the_install_step_covers_every_drift_script_import() -> None:
    """The job installs each third-party package the generator and sync script import."""
    roots = _third_party_import_roots(_DRIFT_SCRIPTS)
    assert roots == set(_DISTRIBUTION_FOR_IMPORT)
    assert _install_problems(_real_workflow(), roots) == []


# --- the predicates, watched failing on violating copies ---------------------

_FIXTURE_HEAD = """\
name: Backend CI
jobs:
  content-drift:
    runs-on: ubuntu-latest
    steps:
      - name: Install drift-check deps
        run: {install}
"""

_SYNC = f"""\
      - name: {_SYNC_STEP}
        working-directory: backend
        run: {_SYNC_COMMAND}
"""

_GATE = f"""\
      - name: {_GATE_STEP}
        working-directory: backend
        run: {_GATE_COMMAND}
"""

_FULL_INSTALL = "uv pip install --system httpx 'jsonschema>=4.0'"


def _fixture(*steps: str, install: str = _FULL_INSTALL) -> str:
    """Return a minimal workflow whose ``content-drift`` job runs ``steps`` in order."""
    return _FIXTURE_HEAD.format(install=install) + "".join(steps)


def test_the_predicates_accept_a_well_formed_job() -> None:
    """The fixture builder itself is sound, so each failure below is the mutation's."""
    good = _fixture(_SYNC, _GATE)
    assert _gate_problems(good) == []
    assert _ordering_problems(good) == []
    assert _disarming_fragments(good) == []
    assert _install_problems(good, set(_DISTRIBUTION_FOR_IMPORT)) == []


def test_a_job_without_the_gate_step_fails() -> None:
    """Deleting the step is caught."""
    assert _gate_problems(_fixture(_SYNC)) == [f"{_JOB} has no step named {_GATE_STEP!r}"]


def test_a_gate_in_another_job_does_not_count() -> None:
    """The step must live in ``content-drift``; one elsewhere is not this gate."""
    elsewhere = _fixture(_SYNC) + "  other-job:\n    steps:\n" + _GATE
    assert _gate_problems(elsewhere) == [f"{_JOB} has no step named {_GATE_STEP!r}"]


def test_a_swallowed_exit_code_fails() -> None:
    """``|| true`` both changes the command and is reported as a disarm."""
    swallowed = _fixture(_SYNC, _GATE.replace(_GATE_COMMAND, f"{_GATE_COMMAND} || true"))
    assert _gate_problems(swallowed) == [
        f"{_GATE_STEP!r} runs {_GATE_COMMAND + ' || true'!r}, not {_GATE_COMMAND!r}"
    ]
    assert _disarming_fragments(swallowed) == ["|| true"]


def test_continue_on_error_is_a_disarm() -> None:
    """A step allowed to fail is reported even though its command is exact."""
    tolerated = _fixture(_SYNC, _GATE + "        continue-on-error: true\n")
    assert _gate_problems(tolerated) == []
    assert _disarming_fragments(tolerated) == ["continue-on-error"]


def test_a_commented_out_command_fails() -> None:
    """A ``#`` in front of ``run:`` leaves a step that runs nothing."""
    commented = _fixture(_SYNC, _GATE.replace("        run:", "        # run:"))
    assert _gate_problems(commented) == [f"{_GATE_STEP!r} runs '', not {_GATE_COMMAND!r}"]


def test_a_gate_run_from_the_repo_root_fails() -> None:
    """Without ``working-directory: backend`` the ``scripts`` package is not importable."""
    rootless = _fixture(_SYNC, _GATE.replace(f"        {_GATE_WORKING_DIRECTORY}\n", ""))
    assert _gate_problems(rootless) == [f"{_GATE_STEP!r} does not set {_GATE_WORKING_DIRECTORY!r}"]


def test_a_gate_before_the_vendored_content_check_fails() -> None:
    """Reordering the two steps is caught."""
    assert _ordering_problems(_fixture(_GATE, _SYNC)) == [
        f"{_GATE_STEP!r} runs before {_SYNC_STEP!r}, so it grades unverified input"
    ]


def test_an_install_step_without_jsonschema_fails() -> None:
    """Dropping a package the generator imports is caught before CI hits ImportError."""
    thin = _fixture(_SYNC, _GATE, install="uv pip install --system httpx")
    assert _install_problems(thin, set(_DISTRIBUTION_FOR_IMPORT)) == [
        f"{_INSTALL_STEP!r} does not install 'jsonschema' for 'jsonschema'"
    ]


def test_an_unmapped_import_fails(tmp_path: Path) -> None:
    """A new third-party import must be mapped to a distribution, not waved through."""
    script = tmp_path / "drift.py"
    script.write_text(
        "import os\nimport yaml\nfrom scripts.sync_content import main\n", encoding="utf-8"
    )
    roots = _third_party_import_roots((script,))
    assert roots == {"yaml"}
    expected = (
        "the drift scripts import 'yaml'; map it in _DISTRIBUTION_FOR_IMPORT "
        f"and add it to {_INSTALL_STEP!r}"
    )
    assert _install_problems(_fixture(_SYNC, _GATE), roots) == [expected]


@pytest.mark.parametrize("fragment", _DISARMING_FRAGMENTS)
def test_every_disarming_fragment_is_detected(fragment: str) -> None:
    """Each listed fragment, live in the job, is reported."""
    disarmed = _fixture(_SYNC, _GATE + f"        # note\n        env:\n          X: '{fragment}'\n")
    assert fragment in _disarming_fragments(disarmed)


def test_a_disarm_mentioned_only_in_a_comment_is_ignored() -> None:
    """The header may explain why ``|| true`` is not used without tripping the check."""
    explained = _fixture(_SYNC, "      # never append || true or continue-on-error here\n" + _GATE)
    assert _disarming_fragments(explained) == []
