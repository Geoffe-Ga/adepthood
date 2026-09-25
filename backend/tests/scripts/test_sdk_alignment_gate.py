"""Expo SDK drift is gated by ``expo install --check``, locally and in CI.

The frontend pins an Expo SDK, and that SDK publishes a compatibility table
naming the exact version of every package it ships alongside -- the React
version, the React Native version, and each ``expo-*`` module. Nothing in the
existing gate reads that table. ESLint reads syntax, ``tsc`` reads types, Jest
reads modules through its own ``moduleNameMapper``, and the bundler resolves an
import graph; a dependency that is a full minor behind what the SDK expects is
invisible to all four. The drift is therefore only discovered at runtime, on a
device, after merge -- which is how the same upgrade has had to be redone more
than once.

``expo install --check`` is the one command that reads that table: it exits 1
when ``frontend/package.json`` has drifted from the SDK's expected versions and
0 when it is aligned. Both outcomes were measured before this guard was
written, so the check is known to have a failing mode rather than being assumed
to.

A check with no call site enforces nothing, so this module pins all three
places it has to appear: the CI workflow (the authority), ``check-all.sh`` (so
local Gate 2 predicts CI instead of surprising it at merge time), and the
``sdk-align.sh`` runner itself -- which must resolve its tool out of
``./node_modules/.bin`` rather than through a bare ``npx``, must clear the
shared ``require-node-modules.sh`` guard so a missing install fails legibly,
and must never swallow the exit code that is the entire point of running it.

These are text-parse assertions rather than PyYAML ones on purpose. PyYAML is
absent from every requirements file, so ``import yaml`` would turn this guard
into a collection error on the backend-compat job instead of a passing check --
the same rule ``test_pre_push_hook_installation`` documents.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
_WORKFLOW = _REPO_ROOT / ".github" / "workflows" / "frontend-ci.yml"
_FRONTEND_SCRIPT_DIR = _REPO_ROOT / "scripts" / "frontend"
_CHECK_ALL = _FRONTEND_SCRIPT_DIR / "check-all.sh"
_SDK_ALIGN = _FRONTEND_SCRIPT_DIR / "sdk-align.sh"
_FRONTEND = _REPO_ROOT / "frontend"
_INSTALLED_EXPO = _FRONTEND / "node_modules" / "expo"
_SDK_TABLE = _INSTALLED_EXPO / "bundledNativeModules.json"
_INSTALLED_EXPO_BIN = _FRONTEND / "node_modules" / ".bin" / "expo"

# The runner's basename, as check-all.sh spells it when it dispatches.
_SDK_ALIGN_SCRIPT = "sdk-align.sh"

# The shared "are the deps installed?" helper every frontend runner calls first.
_GUARD_SCRIPT = "require-node-modules.sh"

# The hermetic path into the project's own binaries. Anything else -- a bare
# ``npx``, a global ``expo`` -- runs a version nobody pinned.
_LOCAL_EXPO_BIN = "./node_modules/.bin/expo"

# The gate itself. Spelled loosely on whitespace so a reformatting of the call
# site does not silently disarm the detector.
_EXPO_CHECK_RE = re.compile(r"\bexpo\s+install\s+--check\b")

# The prefix that makes the gate's verdict a function of the repository alone.
# Without it the CLI overlays the live api.expo.dev ``/versions`` answer on the
# installed expo's own table, so a tree nobody touched goes red the day Expo
# publishes a patch. With it, the expected versions come from
# ``node_modules/expo/bundledNativeModules.json`` -- installed from the lockfile,
# exactly like the tree it is compared against.
_EXPO_OFFLINE = "EXPO_OFFLINE=1"

# The flag as an inline environment assignment, bounded so ``EXPO_OFFLINE=10``
# or ``MY_EXPO_OFFLINE=1`` does not pass for it.
_OFFLINE_PREFIX_RE = re.compile(r"(?:^|\s)" + re.escape(_EXPO_OFFLINE) + r"\s")

# The sentence sdk-align.sh used to carry, which the offline mode made false.
_STALE_NETWORK_CLAIM = "does need the network"

# ``npx`` in *command* position: at the start of a line, or after a shell
# separator. Not a bare substring match -- ``node_modules/.bin/npx`` would be
# hermetic, and a word like "npxish" is not an invocation. ``test_frontend_bin
# _resolution`` already globs every ``scripts/frontend/*.sh`` for this, so the
# negative half below is belt-and-suspenders rather than new coverage. The half
# that is new is the *positive* one: that sweep only forbids a bare ``npx``, it
# never asserts which binary the check actually runs, so a runner that dropped
# the invocation entirely would still pass it.
_BARE_NPX_RE = re.compile(r"(?:^|[\s;&|(`])npx\s")

# Discarding a non-zero exit: ``|| true``, ``|| :``, ``|| echo <default>``. The
# repo's own idiom -- ``|| { echo "..." >&2; exit 1; }`` -- deliberately does
# not match, because it branches on the code and then propagates a failure.
_SWALLOWED_EXIT_RE = re.compile(r"\|\|\s*(?:true\b|:\s|:$|echo\b)")

# A ``run:`` step whose command sits on the same line as the key.
_INLINE_RUN_RE = re.compile(r"^\s*(?:-\s+)?run:\s*(?![|>])(\S.*)$")

# A ``run:`` step whose command is a block scalar on the following lines.
_BLOCK_RUN_RE = re.compile(r"^(\s*)(?:-\s+)?run:\s*[|>][-+]?\s*$")

# A bare exact semver: no ``~``, ``^``, range, or tag.
_EXACT_SEMVER_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")

# The package the drift fixture moves. Its table entry is an exact version (not
# a ``~`` range), so "one patch past the table" is unambiguously outside it.
_DRIFT_PACKAGE = "react-native-svg"

# A cold ``expo`` CLI start plus the check measures a few seconds here; this is
# the ceiling past which a hung run is a failure rather than a slow pass.
_CHECK_TIMEOUT_S = 120

# Why the subprocess tests cannot run: the backend CI job has no frontend
# install, and the real table is the whole point of the fixture.
_NO_FRONTEND_INSTALL = (
    "frontend/node_modules is not installed; run npm ci in frontend/ (outside a "
    "Ralph lane) to exercise the offline SDK gate"
)

# A check-all.sh dispatch: run_check "<label>" "<script>".
_RUN_CHECK_RE = re.compile(r'^\s*run_check\s+"([^"]+)"\s+"([^"]+)"', re.MULTILINE)

# The workflow's run steps today: npm ci, the audit-gate unit tests, the audit
# gate, eslint, tsc, prettier, the web bundle, and Jest. A floor, so "some run
# step mentions the check" cannot pass by parsing nothing.
_MIN_WORKFLOW_RUN_STEPS = 8

# check-all.sh's dispatches today: audit, lint, format, typecheck, bundle,
# tests. Same reason.
_MIN_LOCAL_CHECKS = 6


def _read(path: Path) -> str:
    """Return the file's text, failing legibly when it does not exist yet."""
    assert path.is_file(), f"{path.relative_to(_REPO_ROOT)} does not exist"
    return path.read_text(encoding="utf-8")


def _block_body(lines: list[str], start: int, indent: int) -> list[str]:
    """Return the stripped body lines of a block scalar opened at ``start``."""
    body: list[str] = []
    for line in lines[start + 1 :]:
        if not line.strip():
            continue
        if len(line) - len(line.lstrip()) <= indent:
            break
        body.append(line.strip())
    return body


def _workflow_run_commands(text: str) -> list[str]:
    """Return every shell command a workflow's ``run:`` steps execute."""
    lines = text.splitlines()
    commands: list[str] = []
    for index, line in enumerate(lines):
        inline = _INLINE_RUN_RE.match(line)
        if inline:
            commands.append(inline.group(1).strip())
        block = _BLOCK_RUN_RE.match(line)
        if block:
            commands.extend(_block_body(lines, index, len(block.group(1))))
    return commands


def _command_lines(text: str) -> list[str]:
    """Return a shell script's executable lines, without comments or blanks."""
    return [
        line.strip()
        for line in text.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]


def _gate_invocations(lines: list[str]) -> list[str]:
    """Return the lines that invoke ``expo install --check``."""
    return [line for line in lines if _EXPO_CHECK_RE.search(line)]


def _offline_invocations(lines: list[str]) -> list[str]:
    """Return the gate invocations that run with ``EXPO_OFFLINE=1`` set inline."""
    return [line for line in _gate_invocations(lines) if _OFFLINE_PREFIX_RE.search(line)]


def _swallowed_exits(lines: list[str]) -> list[str]:
    """Return the gate invocations whose non-zero exit is discarded."""
    return [line for line in _gate_invocations(lines) if _SWALLOWED_EXIT_RE.search(line)]


def _bare_npx_lines(lines: list[str]) -> list[str]:
    """Return the lines that resolve a tool through a bare ``npx``."""
    return [line for line in lines if _BARE_NPX_RE.search(line)]


class TestTheDetectorsAreNonVacuous:
    """Every predicate below is driven with fabricated input, both ways.

    A guard whose alarm has only ever been pointed at a correct file has not
    been shown to ring at all. Each test here perturbs a synthetic fixture into
    the exact shape the real assertions forbid, and confirms the detector fires
    -- then confirms it stays quiet on the healthy form.
    """

    def test_run_commands_are_read_from_inline_steps(self) -> None:
        """The one-line ``run:`` form the workflow uses everywhere."""
        workflow = (
            "    steps:\n      - name: SDK alignment\n        run: npx expo install --check\n"
        )
        assert _workflow_run_commands(workflow) == ["npx expo install --check"]

    def test_run_commands_are_read_from_block_steps(self) -> None:
        """A block scalar is still a run step, and must not slip past."""
        workflow = (
            "      - run: |\n"
            "          npm ci\n"
            "          npx expo install --check\n"
            "      - name: next\n"
        )
        assert _workflow_run_commands(workflow) == ["npm ci", "npx expo install --check"]

    def test_a_workflow_without_the_step_yields_no_gate_invocation(self) -> None:
        """The violating case: CI that never asks whether the SDK is aligned."""
        workflow = "      - name: Lint\n        run: npx eslint .\n      - run: npx jest\n"
        assert _workflow_run_commands(workflow)
        assert not _gate_invocations(_workflow_run_commands(workflow))

    def test_the_gate_detector_recognises_the_check(self) -> None:
        """Both spellings that can appear: the local bin and CI's resolver."""
        assert _gate_invocations([f"{_LOCAL_EXPO_BIN} install --check"])
        assert _gate_invocations(["npx expo install --check"])
        assert not _gate_invocations(["npx expo export --platform web"])

    def test_swallowed_exits_are_detected(self) -> None:
        """The shapes that turn a gate into a report: `|| true`, `|| echo`."""
        assert _swallowed_exits([f"{_LOCAL_EXPO_BIN} install --check || true"])
        assert _swallowed_exits([f"{_LOCAL_EXPO_BIN} install --check || :"])
        assert _swallowed_exits([f"{_LOCAL_EXPO_BIN} install --check || echo aligned"])

    def test_a_propagating_failure_branch_is_not_swallowing(self) -> None:
        """The repo's idiom branches on the code and then exits non-zero."""
        propagating = f'{_LOCAL_EXPO_BIN} install --check || {{ echo "x" >&2; exit 1; }}'
        assert not _swallowed_exits([propagating])
        assert not _swallowed_exits([f"{_LOCAL_EXPO_BIN} install --check"])

    def test_a_swallow_on_an_unrelated_line_is_not_attributed_to_the_gate(self) -> None:
        """Only the check's own exit code is this module's business."""
        assert not _swallowed_exits(["rm -rf .expo || true"])

    def test_bare_npx_is_detected_and_the_local_bin_is_not(self) -> None:
        """A runner that reaches the registry is the hazard, not the fix."""
        assert _bare_npx_lines(["npx expo install --check"])
        assert _bare_npx_lines(["cd frontend && npx expo install --check"])
        assert not _bare_npx_lines([f"{_LOCAL_EXPO_BIN} install --check"])

    def test_the_offline_prefix_is_detected_on_the_gate_line(self) -> None:
        """An unprefixed check reads the live API; a prefixed one does not."""
        assert not _offline_invocations(["npx expo install --check"])
        assert not _offline_invocations([f"{_LOCAL_EXPO_BIN} install --check"])
        assert _offline_invocations([f"{_EXPO_OFFLINE} npx expo install --check"])
        assert _offline_invocations([f"{_EXPO_OFFLINE} {_LOCAL_EXPO_BIN} install --check"])

    def test_a_disabled_offline_flag_is_not_the_offline_prefix(self) -> None:
        """``EXPO_OFFLINE=0`` reads the live API just as an absent flag does."""
        assert not _offline_invocations(["EXPO_OFFLINE=0 npx expo install --check"])
        assert not _offline_invocations(["EXPO_OFFLINE=10 npx expo install --check"])

    def test_comments_are_not_executable_lines(self) -> None:
        """A script must be able to name the hazard in prose."""
        assert _command_lines("# never use npx here\n\nexpo install --check\n") == [
            "expo install --check",
        ]


class TestCiGatesSdkAlignment:
    """CI is the authority: a drifted package.json must not merge green."""

    def test_the_workflow_has_run_steps_to_inspect(self) -> None:
        """A floor, so the assertion below cannot pass by parsing nothing."""
        commands = _workflow_run_commands(_read(_WORKFLOW))
        assert len(commands) >= _MIN_WORKFLOW_RUN_STEPS, (
            f"expected at least {_MIN_WORKFLOW_RUN_STEPS} run steps in "
            f"frontend-ci.yml, parsed {len(commands)} -- has the step shape changed?"
        )

    def test_a_run_step_invokes_the_sdk_alignment_check(self) -> None:
        """Without this step, SDK drift is only found on a device after merge."""
        commands = _workflow_run_commands(_read(_WORKFLOW))
        assert _gate_invocations(commands), (
            "frontend-ci.yml has no `run:` step invoking `expo install --check`, so "
            "a package.json that has drifted from the pinned Expo SDK's compatibility "
            "table merges green."
        )

    def test_the_ci_check_reads_the_installed_sdk_table(self) -> None:
        """Offline, so CI's verdict cannot change without a commit of ours."""
        invocations = _gate_invocations(_workflow_run_commands(_read(_WORKFLOW)))
        assert invocations
        unpinned = [line for line in invocations if line not in _offline_invocations(invocations)]
        assert not unpinned, (
            f"frontend-ci.yml runs `expo install --check` without {_EXPO_OFFLINE}: "
            f"{unpinned}. The CLI then prefers the live api.expo.dev table over the "
            f"lockfile-installed one, and the gate goes red when Expo publishes."
        )

    def test_the_ci_check_does_not_swallow_its_exit_code(self) -> None:
        """A gate that always exits 0 reports a verdict it never reached."""
        commands = _workflow_run_commands(_read(_WORKFLOW))
        assert not _swallowed_exits(commands)


class TestTheLocalGateMirrorsCi:
    """Gate 2 has to predict CI, or the surprise just moves to merge time."""

    def test_check_all_has_dispatches_to_inspect(self) -> None:
        """A floor, for the same reason as the workflow's."""
        dispatches = _RUN_CHECK_RE.findall(_read(_CHECK_ALL))
        assert len(dispatches) >= _MIN_LOCAL_CHECKS, (
            f"expected at least {_MIN_LOCAL_CHECKS} run_check dispatches in "
            f"check-all.sh, parsed {len(dispatches)} -- has run_check changed shape?"
        )

    def test_check_all_dispatches_the_sdk_alignment_runner(self) -> None:
        """The local gate runs the same question CI will ask."""
        scripts = [script for _, script in _RUN_CHECK_RE.findall(_read(_CHECK_ALL))]
        assert _SDK_ALIGN_SCRIPT in scripts, (
            f"scripts/frontend/check-all.sh does not run {_SDK_ALIGN_SCRIPT}; it "
            f"dispatches {scripts}. Local Gate 2 would pass on a tree CI fails."
        )


class TestTheSdkAlignmentRunner:
    """The runner itself: hermetic, legible when deps are absent, honest."""

    def test_the_runner_exists_and_is_executable(self) -> None:
        """check-all.sh invokes it directly, so the mode bit is load-bearing."""
        assert _SDK_ALIGN.is_file(), f"{_SDK_ALIGN} is missing"
        assert _SDK_ALIGN.stat().st_mode & 0o111, f"{_SDK_ALIGN} is not executable"

    def test_the_runner_invokes_the_check(self) -> None:
        """The whole reason the file exists."""
        assert _gate_invocations(_command_lines(_read(_SDK_ALIGN)))

    def test_the_runner_resolves_expo_from_the_local_bin(self) -> None:
        """A bare `npx` downloads and runs whatever the registry serves."""
        lines = _command_lines(_read(_SDK_ALIGN))
        offenders = _bare_npx_lines(lines)
        assert not offenders, (
            f"scripts/frontend/{_SDK_ALIGN_SCRIPT} resolves its tool through a bare "
            f"`npx`, which fetches and executes an unpinned package when "
            f"node_modules is absent: {offenders}. Call {_LOCAL_EXPO_BIN} instead."
        )
        assert any(_LOCAL_EXPO_BIN in line for line in _gate_invocations(lines)), (
            f"the check in {_SDK_ALIGN_SCRIPT} must run {_LOCAL_EXPO_BIN}, so the "
            f"version the lockfile pins is the version that answers."
        )

    def test_the_runner_reads_the_installed_sdk_table(self) -> None:
        """Local Gate 2 asks the same offline question CI asks."""
        # Only the lines that execute the pinned binary: the help heredoc and
        # the echo banner name the check in prose, and run nothing.
        executed = [
            line
            for line in _gate_invocations(_command_lines(_read(_SDK_ALIGN)))
            if _LOCAL_EXPO_BIN in line
        ]
        assert executed
        unpinned = [line for line in executed if line not in _offline_invocations(executed)]
        assert not unpinned, (
            f"scripts/frontend/{_SDK_ALIGN_SCRIPT} runs the check without "
            f"{_EXPO_OFFLINE}: {unpinned}. Its verdict would follow the live API "
            f"instead of the lockfile, and would disagree with CI."
        )

    def test_the_runner_no_longer_claims_it_needs_the_network(self) -> None:
        """Offline, the check reaches a verdict from disk; the prose must say so."""
        assert _STALE_NETWORK_CLAIM not in _read(_SDK_ALIGN)

    def test_the_runner_clears_the_node_modules_guard(self) -> None:
        """Otherwise a missing install fails as an opaque `command not found`."""
        assert _GUARD_SCRIPT in _read(_SDK_ALIGN), (
            f"scripts/frontend/{_SDK_ALIGN_SCRIPT} does not call {_GUARD_SCRIPT}, so "
            f"a lane without node_modules gets exit 127 instead of the remedy."
        )

    def test_the_runner_does_not_swallow_the_check_exit_code(self) -> None:
        """`|| true` on the one line that matters makes the gate decorative."""
        swallowed = _swallowed_exits(_command_lines(_read(_SDK_ALIGN)))
        assert not swallowed, (
            f"scripts/frontend/{_SDK_ALIGN_SCRIPT} discards the exit code that is the "
            f"entire signal: {swallowed}. Branch on the code and propagate a failure."
        )


def _table() -> dict[str, str]:
    """Return the installed expo's own compatibility table."""
    table: dict[str, str] = json.loads(_SDK_TABLE.read_text(encoding="utf-8"))
    return table


def _installed_expo_version() -> str:
    """Return the version of expo the lockfile installed."""
    manifest = json.loads((_INSTALLED_EXPO / "package.json").read_text(encoding="utf-8"))
    version: str = manifest["version"]
    return version


def _bumped_patch(version: str) -> str:
    """Return ``version`` one patch later, refusing anything but exact semver."""
    match = _EXACT_SEMVER_RE.fullmatch(version)
    assert match, f"{version!r} is not an exact version, so a one-patch drift is ambiguous"
    major, minor, patch = match.groups()
    return f"{major}.{minor}.{int(patch) + 1}"


def _scratch_project(root: Path, drift_version: str) -> Path:
    """Build a project that declares the real expo plus ``_DRIFT_PACKAGE``.

    ``node_modules/expo`` is a symlink to the real install, so the table the
    check reads is the one the lockfile pins; ``_DRIFT_PACKAGE`` is a stub
    whose only content is the version it claims to be.
    """
    manifest = {
        "name": "sdk-drift-fixture",
        "version": "0.0.0",
        "private": True,
        "dependencies": {"expo": _installed_expo_version(), _DRIFT_PACKAGE: drift_version},
    }
    (root / "package.json").write_text(json.dumps(manifest), encoding="utf-8")
    modules = root / "node_modules"
    modules.mkdir()
    (modules / "expo").symlink_to(_INSTALLED_EXPO, target_is_directory=True)
    stub = modules / _DRIFT_PACKAGE
    stub.mkdir()
    stub_manifest = {"name": _DRIFT_PACKAGE, "version": drift_version}
    (stub / "package.json").write_text(json.dumps(stub_manifest), encoding="utf-8")
    return root


def _run_offline_check(cwd: Path) -> subprocess.CompletedProcess[str]:
    """Run the gate exactly as sdk-align.sh does, in ``cwd``."""
    env = {**os.environ, "EXPO_OFFLINE": "1", "CI": "1", "EXPO_NO_TELEMETRY": "1"}
    return subprocess.run(
        [str(_INSTALLED_EXPO_BIN), "install", "--check"],
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        timeout=_CHECK_TIMEOUT_S,
        check=False,
    )


_FRONTEND_INSTALLED = (
    _SDK_TABLE.is_file() and _INSTALLED_EXPO_BIN.is_file() and shutil.which("node") is not None
)


@pytest.mark.skipif(not _FRONTEND_INSTALLED, reason=_NO_FRONTEND_INSTALL)
class TestTheOfflineGateStillFails:
    """The playbook rule for gates: prove the offline check rings on real drift.

    Taking the live API out of the comparison is only safe if what is left is
    still a gate. These run the pinned binary against the real installed table,
    once on a tree one patch past it (must fail), once on a tree exactly on it
    (must pass -- otherwise the first proves nothing), and once on the committed
    frontend itself. The drift version is computed from the table at run time,
    so an SDK bump that moves the table's entry cannot turn the drifted fixture
    into the aligned one.
    """

    def test_the_offline_gate_fails_on_a_drifted_tree(self, tmp_path: Path) -> None:
        """One patch past the table is drift, and the gate must exit non-zero."""
        drifted = _bumped_patch(_table()[_DRIFT_PACKAGE])
        result = _run_offline_check(_scratch_project(tmp_path, drifted))
        output = result.stdout + result.stderr
        assert result.returncode != 0, (
            f"{_EXPO_OFFLINE} expo install --check exited 0 with {_DRIFT_PACKAGE} at "
            f"{drifted}, past the table's {_table()[_DRIFT_PACKAGE]}: the offline gate "
            f"cannot see drift.\n{output}"
        )
        assert _DRIFT_PACKAGE in output, output

    def test_the_offline_gate_passes_an_aligned_tree(self, tmp_path: Path) -> None:
        """The control: the same fixture exactly on the table must pass."""
        result = _run_offline_check(_scratch_project(tmp_path, _table()[_DRIFT_PACKAGE]))
        assert result.returncode == 0, result.stdout + result.stderr

    def test_the_committed_frontend_passes_offline(self) -> None:
        """The repository's own tree is aligned, with no network consulted."""
        result = _run_offline_check(_FRONTEND)
        assert result.returncode == 0, result.stdout + result.stderr


class TestTheDriftFixtureHelpers:
    """The fixture's arithmetic, driven without a frontend install."""

    def test_a_patch_is_bumped_by_exactly_one(self) -> None:
        """15.15.4 -> 15.15.5: past the exact table value, and nothing else."""
        assert _bumped_patch("15.15.4") == "15.15.5"
        assert _bumped_patch("0.10.9") == "0.10.10"

    @pytest.mark.parametrize("spec", ["~57.0.7", "^12.0.1", "15.15", "1.2.3-rc.1"])
    def test_a_range_is_refused(self, spec: str) -> None:
        """A range has no single "one patch past", so the fixture must refuse it."""
        with pytest.raises(AssertionError, match="not an exact version"):
            _bumped_patch(spec)
