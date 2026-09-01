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

import re
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]
_WORKFLOW = _REPO_ROOT / ".github" / "workflows" / "frontend-ci.yml"
_FRONTEND_SCRIPT_DIR = _REPO_ROOT / "scripts" / "frontend"
_CHECK_ALL = _FRONTEND_SCRIPT_DIR / "check-all.sh"
_SDK_ALIGN = _FRONTEND_SCRIPT_DIR / "sdk-align.sh"

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
