"""The frontend guard proves the install was built from the committed lockfile.

``require-node-modules.sh`` asserted *presence* -- ``node_modules/.bin`` exists
-- and called that installed. Presence is not freshness. A tree installed weeks
ago satisfies it, and the staleness then surfaces two stages later as an Expo
SDK alignment failure whose text sends the reader at the committed pins. That
cost a full false-bug cycle: an issue was filed reporting ten SDK packages
behind on ``main`` with the gate output as evidence, when ``package.json`` and
``package-lock.json`` had been correct all along and only the installed tree was
stale. ``npm ci`` fixed it with zero tracked-file changes.

The oracle is npm's own install receipt, ``node_modules/.package-lock.json``,
which npm writes at install time to record what it actually put on disk. It
needs no tree walk and no network, and comparing all of its entries against the
committed lockfile is *cheaper* than spot-checking a handful of sentinel
packages would be -- and strictly more complete, since a sentinel set can miss
the one package that drifted.

Three tree shapes exist here, not one. ``frontend/node_modules`` may be absent,
a real directory, or -- inside a Ralph fleet lane -- a symlink into the main
checkout's install. The symlinked case is the one that makes a naive guard
actively harmful: a lane whose branch legitimately bumps a dependency would
read as stale on every frontend gate, because the shared install matches the
*owning* checkout's lockfile rather than the lane's. So the comparison resolves
the link and reads the owner's lockfile, and a divergence between the lane's own
lockfile and the owner's is a warning rather than a failure -- carrying the
remedy that removes the symlink first, because a bare ``npm ci`` in a lane
writes *through* the link and mutates every concurrent lane's tree.

These tests run the real scripts against fabricated trees in ``tmp_path``. The
guard derives its frontend directory from its own location, so copying it into a
scratch layout points it at that layout -- the same seam
``test_commitlint_message_path`` uses.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parents[3]
_FRONTEND_SCRIPT_DIR = _REPO_ROOT / "scripts" / "frontend"
_GUARD_SCRIPT = _FRONTEND_SCRIPT_DIR / "require-node-modules.sh"
_COMPARATOR_SCRIPT = _FRONTEND_SCRIPT_DIR / "lockfile-drift.mjs"
_PRE_COMMIT_CONFIG = _REPO_ROOT / ".pre-commit-config.yaml"

# The guard as a hook entry spells it: repo-root-relative, because pre-commit
# runs hooks with the repo root as cwd.
_GUARD_ENTRY = "scripts/frontend/require-node-modules.sh"

# Floors, so a sweep that matched nothing cannot pass. Today: lint, format,
# typecheck, test, bundle, sdk-align, cross-boundary-drift.
_MIN_VERIFY_RUNNERS = 7

# Today: frontend-eslint, frontend-prettier, frontend-typecheck, frontend-tests,
# frontend-tests-coverage. Deliberately NOT commitlint.
_MIN_VERIFY_HOOKS = 5

_SUBPROCESS_TIMEOUT_SECONDS = 60
_EXECUTABLE_BITS = 0o755

# The opt-in flag. The no-argument path stays presence-only, which is what keeps
# a stale frontend install from blocking a backend-only or docs-only commit.
_VERIFY_FLAG = "--verify-lockfile"

# The versions the fixtures drift between. Concrete numbers, so an assertion
# that the message names the offender cannot pass on a generic complaint.
_LOCKED_EXPO = "57.0.18"
_INSTALLED_EXPO = "57.0.11"


def _sanitised_env() -> dict[str, str]:
    """Return the ambient environment with the hook variables stripped.

    A ``GIT_DIR`` inherited from a running hook makes a subprocess operate on
    the real repository instead of the scratch one, and ``PRE_COMMIT_*`` does
    the same for pre-commit's own state.
    """
    return {
        key: value
        for key, value in os.environ.items()
        if not key.startswith(("GIT_", "PRE_COMMIT_"))
    }


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    """Write ``payload`` as JSON, creating the parent directory."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def _committed_lockfile(expo_version: str) -> dict[str, Any]:
    """Return a committed lockfile pinning ``expo`` at ``expo_version``.

    Carries the ``""`` root entry that npm writes into the committed file, and
    two further packages so a comparison over it is not a single-key special
    case.
    """
    return {
        "lockfileVersion": 3,
        "packages": {
            "": {"name": "fixture", "dependencies": {"expo": f"~{expo_version}"}},
            "node_modules/expo": {"version": expo_version},
            "node_modules/react-native": {"version": "0.86.3"},
            "node_modules/typescript": {"version": "5.9.2"},
        },
    }


def _install_receipt(expo_version: str) -> dict[str, Any]:
    """Return npm's install receipt recording ``expo`` at ``expo_version``.

    The ``""`` root key is deliberately absent: npm does not write one into
    ``node_modules/.package-lock.json``, and a fixture that invented one would
    let a comparator that mishandles the root pass.
    """
    return {
        "lockfileVersion": 3,
        "packages": {
            "node_modules/expo": {"version": expo_version},
            "node_modules/react-native": {"version": "0.86.3"},
            "node_modules/typescript": {"version": "5.9.2"},
        },
    }


def _copy_scripts(root: Path) -> Path:
    """Copy the real guard and comparator into a scratch checkout.

    Copied rather than reimplemented, so the behaviour under test is the shipped
    behaviour. The guard derives its frontend directory from its own location,
    which is what points it at the scratch tree.
    """
    scripts = root / "scripts" / "frontend"
    scripts.mkdir(parents=True, exist_ok=True)
    guard = scripts / _GUARD_SCRIPT.name
    shutil.copy2(_GUARD_SCRIPT, guard)
    guard.chmod(_EXECUTABLE_BITS)
    if _COMPARATOR_SCRIPT.is_file():
        shutil.copy2(_COMPARATOR_SCRIPT, scripts / _COMPARATOR_SCRIPT.name)
    return scripts


def _build_scratch_repo(
    root: Path,
    *,
    installed_expo: str,
    locked_expo: str,
    write_receipt: bool = True,
    write_manifests: bool = True,
) -> Path:
    """Build a scratch checkout whose install is at ``installed_expo``.

    ``node_modules/.bin`` exists and is empty -- exactly the shape that
    satisfied the presence-only guard while the tree underneath it was stale.

    Args:
        root: The scratch checkout root.
        installed_expo: The version the install is at.
        locked_expo: The version the committed lockfile pins.
        write_receipt: Whether npm's install receipt exists. False exercises the
            on-disk fallback comparison.
        write_manifests: Whether package.json / package-lock.json exist at all.

    Returns:
        The scratch checkout root, for chaining.
    """
    _copy_scripts(root)
    frontend = root / "frontend"
    node_modules = frontend / "node_modules"
    (node_modules / ".bin").mkdir(parents=True, exist_ok=True)
    if write_manifests:
        _write_json(frontend / "package.json", {"name": "fixture", "dependencies": {}})
        _write_json(frontend / "package-lock.json", _committed_lockfile(locked_expo))
    if write_receipt:
        _write_json(node_modules / ".package-lock.json", _install_receipt(installed_expo))
    _write_json(
        node_modules / "expo" / "package.json",
        {"name": "expo", "version": installed_expo},
    )
    for name, version in (("react-native", "0.86.3"), ("typescript", "5.9.2")):
        _write_json(node_modules / name / "package.json", {"name": name, "version": version})
    return root


def _build_lane_over_owner(
    root: Path, *, owner_installed: str, owner_locked: str, lane_locked: str
) -> Path:
    """Build a fleet-shaped pair: a lane symlinked to an owner's install.

    This is the shape that makes a naive freshness guard harmful. The lane's
    ``node_modules`` is a symlink into ``owner``, so the installed tree matches
    the OWNER's lockfile, not the lane's.

    Args:
        root: The directory holding both checkouts.
        owner_installed: The version installed in the owner's shared tree.
        owner_locked: The version the owner's lockfile pins.
        lane_locked: The version the lane's own lockfile pins.

    Returns:
        The lane checkout root.
    """
    owner = _build_scratch_repo(
        root / "owner", installed_expo=owner_installed, locked_expo=owner_locked
    )
    lane = root / "lane"
    _copy_scripts(lane)
    lane_frontend = lane / "frontend"
    lane_frontend.mkdir(parents=True, exist_ok=True)
    _write_json(lane_frontend / "package.json", {"name": "fixture", "dependencies": {}})
    _write_json(lane_frontend / "package-lock.json", _committed_lockfile(lane_locked))
    (lane_frontend / "node_modules").symlink_to(owner / "frontend" / "node_modules")
    return lane


def _run_guard(root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    """Run the copied guard inside ``root`` and return the completed process."""
    return subprocess.run(
        [str(root / "scripts" / "frontend" / _GUARD_SCRIPT.name), *args],
        cwd=root,
        env=_sanitised_env(),
        capture_output=True,
        text=True,
        timeout=_SUBPROCESS_TIMEOUT_SECONDS,
        check=False,
    )


class TestTheTreeShapes:
    """A stale install must be named as such, not mistaken for repo drift."""

    def test_a_stale_hidden_lockfile_fails_and_names_the_offending_package(
        self, tmp_path: Path
    ) -> None:
        """The measured defect: present, stale, and reported as fresh."""
        root = _build_scratch_repo(
            tmp_path, installed_expo=_INSTALLED_EXPO, locked_expo=_LOCKED_EXPO
        )
        result = _run_guard(root, _VERIFY_FLAG)
        assert result.returncode == 1, (
            f"expected exit 1 for a stale tree (node_modules/expo installed "
            f"{_INSTALLED_EXPO}, locked {_LOCKED_EXPO}), got {result.returncode}; "
            f"stderr={result.stderr!r}"
        )
        assert "expo" in result.stderr
        assert _INSTALLED_EXPO in result.stderr
        assert _LOCKED_EXPO in result.stderr

    def test_a_fresh_tree_passes_silently(self, tmp_path: Path) -> None:
        """The hot path runs on every frontend gate; it must say nothing."""
        root = _build_scratch_repo(tmp_path, installed_expo=_LOCKED_EXPO, locked_expo=_LOCKED_EXPO)
        result = _run_guard(root, _VERIFY_FLAG)
        assert result.returncode == 0, f"stderr={result.stderr!r}"
        assert result.stdout == "", f"unexpected chatter: {result.stdout!r}"
        assert result.stderr == "", f"unexpected chatter: {result.stderr!r}"

    def test_the_failure_refuses_to_blame_the_committed_pins(self, tmp_path: Path) -> None:
        """The whole point: the manifests are right, the install is not."""
        root = _build_scratch_repo(
            tmp_path, installed_expo=_INSTALLED_EXPO, locked_expo=_LOCKED_EXPO
        )
        result = _run_guard(root, _VERIFY_FLAG)
        assert result.returncode == 1
        assert "NOT the thing to change" in result.stderr
        assert "npm ci" in result.stderr

    def test_a_stale_tree_without_the_flag_still_passes(self, tmp_path: Path) -> None:
        """The default stays presence-only, which is what keeps commitlint safe."""
        root = _build_scratch_repo(
            tmp_path, installed_expo=_INSTALLED_EXPO, locked_expo=_LOCKED_EXPO
        )
        result = _run_guard(root)
        assert result.returncode == 0, (
            f"the no-argument path must not gain a freshness opinion; stderr={result.stderr!r}"
        )

    def test_an_absent_install_keeps_its_original_message(self, tmp_path: Path) -> None:
        """The pre-existing failure text is load-bearing and must not drift."""
        root = _build_scratch_repo(tmp_path, installed_expo=_LOCKED_EXPO, locked_expo=_LOCKED_EXPO)
        shutil.rmtree(root / "frontend" / "node_modules" / ".bin")
        result = _run_guard(root, _VERIFY_FLAG)
        assert result.returncode == 1
        assert "Frontend dependencies are not installed" in result.stderr
        assert "node_modules/.bin is missing" in result.stderr
        assert "scripts/ralph/fleet.sh provisioned node_modules" in result.stderr

    def test_absent_manifests_are_not_checked(self, tmp_path: Path) -> None:
        """The scratch shape ``test_commitlint_message_path`` builds."""
        root = _build_scratch_repo(
            tmp_path,
            installed_expo=_LOCKED_EXPO,
            locked_expo=_LOCKED_EXPO,
            write_manifests=False,
        )
        result = _run_guard(root, _VERIFY_FLAG)
        assert result.returncode == 0, f"stderr={result.stderr!r}"
        assert "not checked" in result.stdout

    def test_an_unknown_option_is_rejected(self, tmp_path: Path) -> None:
        """A typo must not silently degrade to the presence-only check."""
        root = _build_scratch_repo(tmp_path, installed_expo=_LOCKED_EXPO, locked_expo=_LOCKED_EXPO)
        result = _run_guard(root, "--verify-lockfiles")
        assert result.returncode == 2
        assert "Unknown option" in result.stderr


class TestTheFallbackMode:
    """A tree npm wrote no receipt into is still verifiable, and says so."""

    def test_a_stale_tree_without_a_receipt_still_fails(self, tmp_path: Path) -> None:
        """The on-disk comparison, derived from the lockfile's own root entry."""
        root = _build_scratch_repo(
            tmp_path,
            installed_expo=_INSTALLED_EXPO,
            locked_expo=_LOCKED_EXPO,
            write_receipt=False,
        )
        result = _run_guard(root, _VERIFY_FLAG)
        assert result.returncode == 1, f"stderr={result.stderr!r}"
        assert "expo" in result.stderr
        assert _INSTALLED_EXPO in result.stderr

    def test_the_mode_is_named_in_the_output(self, tmp_path: Path) -> None:
        """A verdict whose method is invisible cannot be argued with."""
        root = _build_scratch_repo(
            tmp_path,
            installed_expo=_LOCKED_EXPO,
            locked_expo=_LOCKED_EXPO,
            write_receipt=False,
        )
        result = _run_guard(root, _VERIFY_FLAG)
        assert result.returncode == 0, f"stderr={result.stderr!r}"
        assert "fallback mode" in result.stdout


class TestTheSharedInstallIsNotMisread:
    """The hazard: a lane must not read as stale because it shares a tree."""

    def test_a_lane_is_measured_against_the_owning_checkout(self, tmp_path: Path) -> None:
        """A lane that bumps a dep is not stale; the shared tree is the owner's.

        The lane's own lockfile pins a *newer* expo than the shared install
        carries. Measured against the lane's lockfile that reads as drift; the
        owner's lockfile matches the install exactly, so the correct verdict is
        clean plus a warning.
        """
        lane = _build_lane_over_owner(
            tmp_path,
            owner_installed=_INSTALLED_EXPO,
            owner_locked=_INSTALLED_EXPO,
            lane_locked=_LOCKED_EXPO,
        )
        result = _run_guard(lane, _VERIFY_FLAG)
        assert result.returncode == 0, (
            f"a lane whose branch bumps a dependency must not read as a stale "
            f"install; stderr={result.stderr!r}"
        )

    def test_a_diverging_lane_is_warned_with_the_symlink_safe_remedy(self, tmp_path: Path) -> None:
        """A bare ``npm ci`` here writes through the link into every lane."""
        lane = _build_lane_over_owner(
            tmp_path,
            owner_installed=_INSTALLED_EXPO,
            owner_locked=_INSTALLED_EXPO,
            lane_locked=_LOCKED_EXPO,
        )
        result = _run_guard(lane, _VERIFY_FLAG)
        assert "rm frontend/node_modules && cd frontend && npm ci" in result.stderr, (
            f"the symlinked remedy must remove the link first; stderr={result.stderr!r}"
        )
        assert "every concurrent worktree" in result.stderr

    def test_a_stale_owner_still_fails_the_lane(self, tmp_path: Path) -> None:
        """Reading the owner's lockfile must not become a way to never fail."""
        lane = _build_lane_over_owner(
            tmp_path,
            owner_installed=_INSTALLED_EXPO,
            owner_locked=_LOCKED_EXPO,
            lane_locked=_LOCKED_EXPO,
        )
        result = _run_guard(lane, _VERIFY_FLAG)
        assert result.returncode == 1, (
            f"the shared install is genuinely behind the owner's lockfile; stderr={result.stderr!r}"
        )
        assert _INSTALLED_EXPO in result.stderr


class TestTheComparatorFailsToUnverifiable:
    """A crashed comparator must never report the verdict 'you have drifted'."""

    def test_a_throwing_comparison_exits_two_not_one(self, tmp_path: Path) -> None:
        """Node exits 1 on an uncaught throw, and 1 is the drift code.

        Without the try/catch a bug in the comparison would tell every developer
        their install is stale -- the one verdict that is certainly wrong, and
        the one that sends them to reinstall a tree that was fine.
        """
        root = _build_scratch_repo(tmp_path, installed_expo=_LOCKED_EXPO, locked_expo=_LOCKED_EXPO)
        comparator = root / "scripts" / "frontend" / _COMPARATOR_SCRIPT.name
        original = comparator.read_text(encoding="utf-8")
        marker = "export function compareReceipt(receipt, locked) {"
        assert marker in original, "the comparator's entry point was renamed"
        comparator.write_text(
            original.replace(marker, f'{marker}\n  throw new Error("boom");'),
            encoding="utf-8",
        )
        result = _run_guard(root, _VERIFY_FLAG)
        assert result.returncode == 2, (
            f"a comparator that crashes must exit 2 (could not verify), never 1 "
            f"(drifted); got {result.returncode}, stderr={result.stderr!r}"
        )


class TestTheDetectorIsNonVacuous:
    """Driven both ways: it must fire on drift and stay quiet on a match."""

    def test_it_fires_on_a_package_missing_from_the_install(self, tmp_path: Path) -> None:
        """Locked but never installed is drift, not just a version skew."""
        root = _build_scratch_repo(tmp_path, installed_expo=_LOCKED_EXPO, locked_expo=_LOCKED_EXPO)
        receipt = root / "frontend" / "node_modules" / ".package-lock.json"
        payload = json.loads(receipt.read_text(encoding="utf-8"))
        del payload["packages"]["node_modules/typescript"]
        _write_json(receipt, payload)
        result = _run_guard(root, _VERIFY_FLAG)
        assert result.returncode == 1, f"stderr={result.stderr!r}"
        assert "typescript" in result.stderr

    def test_it_fires_on_a_package_installed_but_not_locked(self, tmp_path: Path) -> None:
        """Something on disk that no committed pin asks for is also drift."""
        root = _build_scratch_repo(tmp_path, installed_expo=_LOCKED_EXPO, locked_expo=_LOCKED_EXPO)
        receipt = root / "frontend" / "node_modules" / ".package-lock.json"
        payload = json.loads(receipt.read_text(encoding="utf-8"))
        payload["packages"]["node_modules/interloper"] = {"version": "9.9.9"}
        _write_json(receipt, payload)
        result = _run_guard(root, _VERIFY_FLAG)
        assert result.returncode == 1, f"stderr={result.stderr!r}"
        assert "interloper" in result.stderr

    def test_it_stays_quiet_on_a_platform_gated_absence(self, tmp_path: Path) -> None:
        """An optional binary is legitimately absent; that is not staleness.

        Without this carve-out the gate would fail on every Linux CI run for the
        darwin-only entries in the lockfile, and vice versa.
        """
        root = _build_scratch_repo(tmp_path, installed_expo=_LOCKED_EXPO, locked_expo=_LOCKED_EXPO)
        lockfile = root / "frontend" / "package-lock.json"
        payload = json.loads(lockfile.read_text(encoding="utf-8"))
        payload["packages"]["node_modules/native-binding-darwin"] = {
            "version": "1.0.0",
            "optional": True,
            "os": ["darwin"],
        }
        _write_json(lockfile, payload)
        result = _run_guard(root, _VERIFY_FLAG)
        assert result.returncode == 0, (
            f"an optional, platform-gated package absent from the install is not "
            f"drift; stderr={result.stderr!r}"
        )


class TestTheGateIsWiredEverywhereItShouldBe:
    """Static floors, so a sweep that matched nothing cannot pass."""

    def test_the_comparator_exists_and_the_guard_is_executable(self) -> None:
        """Both halves ship, or the gate is decorative."""
        assert _COMPARATOR_SCRIPT.is_file(), f"{_COMPARATOR_SCRIPT} is missing"
        assert _GUARD_SCRIPT.stat().st_mode & 0o111, f"{_GUARD_SCRIPT} is not executable"

    def test_every_frontend_runner_verifies_the_lockfile(self) -> None:
        """The runners are the gates that actually read the installed tree."""
        runners = [
            path
            for path in sorted(_FRONTEND_SCRIPT_DIR.glob("*.sh"))
            if path.name != _GUARD_SCRIPT.name
        ]
        verifying = [path for path in runners if _VERIFY_FLAG in path.read_text(encoding="utf-8")]
        assert len(verifying) >= _MIN_VERIFY_RUNNERS, (
            f"expected at least {_MIN_VERIFY_RUNNERS} frontend runners to pass "
            f"{_VERIFY_FLAG}, found {len(verifying)}: "
            f"{[path.name for path in verifying]}"
        )

    def test_the_frontend_hooks_verify_and_commitlint_does_not(self) -> None:
        """Commitlint runs on EVERY commit, including backend-only ones."""
        config = _PRE_COMMIT_CONFIG.read_text(encoding="utf-8")
        entries = [
            line for line in config.splitlines() if "entry:" in line and _GUARD_ENTRY in line
        ]
        verifying = [line for line in entries if _VERIFY_FLAG in line]
        assert len(verifying) >= _MIN_VERIFY_HOOKS, (
            f"expected at least {_MIN_VERIFY_HOOKS} frontend hook entries to pass "
            f"{_VERIFY_FLAG}, found {len(verifying)}"
        )
        commitlint = [line for line in entries if "commitlint --extends" in line]
        assert commitlint, "the commitlint entry vanished; this floor is now vacuous"
        assert all(_VERIFY_FLAG not in line for line in commitlint), (
            "commitlint carries no `files:` filter, so it fires on every commit in "
            "the repo. Gating it on the frontend install's freshness would block "
            "backend-only and docs-only commits on an unrelated stale tree."
        )

    def test_no_frontend_script_offers_the_expo_installer_realignment(self) -> None:
        """The literal string that sent a reader at the committed pins."""
        offenders = [
            path.name
            for path in sorted(_FRONTEND_SCRIPT_DIR.iterdir())
            if path.is_file() and "install --fix" in path.read_text(encoding="utf-8")
        ]
        assert not offenders, (
            f"{offenders} offer `expo install --fix` as a remedy. It runs an "
            f"installer, and inside a fleet lane that write goes through the "
            f"node_modules symlink into every concurrent lane."
        )
