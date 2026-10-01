"""Executable regressions for the backend's exact Railway volume boundary."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
_ENTRYPOINT = _REPO_ROOT / "backend" / "docker" / "backend-entrypoint.sh"
_VERIFIER = _REPO_ROOT / "backend" / "docker" / "verify-secrets-mount.sh"


def _write_mountinfo(path: Path, mount: Path) -> None:
    path.write_text(
        f"41 32 0:35 / {mount} rw,nosuid - ext4 /dev/volume rw\n",
        encoding="utf-8",
    )


def _verify(mount: Path, mountinfo: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["/bin/sh", str(_VERIFIER), str(mount), str(mountinfo)],
        check=False,
        capture_output=True,
        text=True,
    )


def _write_executable(path: Path, contents: str) -> None:
    path.write_text(contents, encoding="utf-8")
    path.chmod(0o755)


def _instrumented_entrypoint(
    tmp_path: Path,
) -> tuple[Path, Path, Path, Path, Path]:
    bin_directory = tmp_path / "bin"
    bin_directory.mkdir()
    mount = tmp_path / "adepthood-secrets"
    mountinfo = tmp_path / "mountinfo"
    trace = tmp_path / "trace"
    _write_executable(bin_directory / "id", "#!/bin/sh\nprintf '0\\n'\n")
    verifier = bin_directory / "verify-secrets-mount"
    _write_executable(
        verifier,
        f'#!/bin/sh\nexec /bin/sh "{_VERIFIER}" "$@"\n',
    )
    _write_executable(
        bin_directory / "install",
        """#!/bin/sh
for final_argument do :; done
chmod 0700 "$final_argument"
printf 'install:%s\n' "$*" >> "$ENTRYPOINT_TRACE"
""",
    )
    _write_executable(
        bin_directory / "setpriv",
        """#!/bin/sh
runtime_uid=
runtime_gid=
while [ "$#" -gt 0 ]; do
    case "$1" in
        --reuid=*) runtime_uid=${1#--reuid=} ;;
        --regid=*) runtime_gid=${1#--regid=} ;;
        --clear-groups|--no-new-privs) ;;
        *) break ;;
    esac
    shift
done
printf 'setpriv:%s:%s\n' "$runtime_uid" "$runtime_gid" >> "$ENTRYPOINT_TRACE"
ENTRYPOINT_EFFECTIVE_UID=$runtime_uid
ENTRYPOINT_EFFECTIVE_GID=$runtime_gid
export ENTRYPOINT_EFFECTIVE_UID ENTRYPOINT_EFFECTIVE_GID
exec "$@"
""",
    )
    command = bin_directory / "record-identity"
    _write_executable(
        command,
        """#!/bin/sh
identity="$ENTRYPOINT_EFFECTIVE_UID:$ENTRYPOINT_EFFECTIVE_GID:$HOME"
printf '%s\n' "$identity" > "$ENTRYPOINT_RESULT"
""",
    )
    entrypoint = tmp_path / "backend-entrypoint.sh"
    source = _ENTRYPOINT.read_text(encoding="utf-8")
    replacements = {
        "/usr/bin/id": str(bin_directory / "id"),
        "/usr/local/bin/python": sys.executable,
        "/app/src/services/managed_vault_activation_config.py": str(
            _REPO_ROOT / "backend" / "src" / "services" / "managed_vault_activation_config.py"
        ),
        "/usr/local/bin/adepthood-verify-secrets-mount": str(verifier),
        "/usr/bin/install": str(bin_directory / "install"),
        "/usr/bin/setpriv": str(bin_directory / "setpriv"),
        "secrets_directory=/run/adepthood-secrets": f"secrets_directory={mount}",
        "/proc/self/mountinfo": str(mountinfo),
    }
    for production_value, test_value in replacements.items():
        source = source.replace(production_value, test_value)
    entrypoint.write_text(source, encoding="utf-8")
    entrypoint.chmod(0o755)
    return entrypoint, command, mount, mountinfo, trace


def _run_entrypoint(
    entrypoint: Path,
    command: Path,
    trace: Path,
    result: Path,
    *,
    managed_environment: dict[str, str | None],
) -> subprocess.CompletedProcess[str]:
    environment = {
        **os.environ,
        "ENTRYPOINT_RESULT": str(result),
        "ENTRYPOINT_TRACE": str(trace),
        "HOME": "/root",
    }
    managed_names = (
        "ADEPTHOOD_E2E_MANAGED_VAULT_SECRET_ROOT",
        "CREEK_MANAGED_VAULT_ACTIVATION_ENABLED",
        "CREEK_PROVISIONING_AUTH_FILE",
        "CREEK_PROVISIONING_HANDOFF_AUTH_FILE",
        "ENV",
    )
    for env_var in managed_names:
        environment.pop(env_var, None)
    environment.update(
        {env_var: value for env_var, value in managed_environment.items() if value is not None}
    )
    return subprocess.run(
        ["/bin/sh", str(entrypoint), str(command)],
        check=False,
        capture_output=True,
        env=environment,
        text=True,
    )


def test_production_entrypoint_refuses_e2e_secret_root_before_bootstrap(tmp_path: Path) -> None:
    entrypoint, command, _mount, _mountinfo, trace = _instrumented_entrypoint(tmp_path)
    result = tmp_path / "result"

    completed = _run_entrypoint(
        entrypoint,
        command,
        trace,
        result,
        managed_environment={
            "ADEPTHOOD_E2E_MANAGED_VAULT_SECRET_ROOT": str(tmp_path / "fixture-root"),
            "CREEK_MANAGED_VAULT_ACTIVATION_ENABLED": "false",
        },
    )

    assert completed.returncode != 0
    assert not result.exists()
    assert not trace.exists()


def test_production_entrypoint_refuses_e2e_environment_before_bootstrap(tmp_path: Path) -> None:
    entrypoint, command, _mount, _mountinfo, trace = _instrumented_entrypoint(tmp_path)
    result = tmp_path / "result"

    completed = _run_entrypoint(
        entrypoint,
        command,
        trace,
        result,
        managed_environment={
            "CREEK_MANAGED_VAULT_ACTIVATION_ENABLED": "false",
            "ENV": "e2e",
        },
    )

    assert completed.returncode != 0
    assert not result.exists()
    assert not trace.exists()


def test_exact_mounted_directory_is_accepted(tmp_path: Path) -> None:
    mount = tmp_path / "adepthood-secrets"
    mount.mkdir()
    mountinfo = tmp_path / "mountinfo"
    _write_mountinfo(mountinfo, mount)

    completed = _verify(mount, mountinfo)

    assert completed.returncode == 0


@pytest.mark.parametrize("mountinfo_available", [True, False])
def test_unmounted_or_unverifiable_directory_is_rejected(
    tmp_path: Path,
    *,
    mountinfo_available: bool,
) -> None:
    mount = tmp_path / "adepthood-secrets"
    mount.mkdir()
    mountinfo = tmp_path / "mountinfo"
    if mountinfo_available:
        _write_mountinfo(mountinfo, tmp_path / "somewhere-else")

    completed = _verify(mount, mountinfo)

    assert completed.returncode != 0


@pytest.mark.parametrize("candidate_kind", ["symlink", "file"])
def test_non_directory_or_symlink_mount_is_rejected(
    tmp_path: Path,
    candidate_kind: str,
) -> None:
    target = tmp_path / "target"
    target.mkdir()
    mount = tmp_path / "adepthood-secrets"
    if candidate_kind == "symlink":
        mount.symlink_to(target, target_is_directory=True)
    else:
        mount.write_text("not a volume", encoding="utf-8")
    mountinfo = tmp_path / "mountinfo"
    _write_mountinfo(mountinfo, mount)

    completed = _verify(mount, mountinfo)

    assert completed.returncode != 0


@pytest.mark.parametrize(
    "activation_setting",
    [None, "", " \t", "0", " false ", "NO", "OFF"],
)
def test_disabled_entrypoint_starts_as_service_identity_without_a_volume(
    tmp_path: Path,
    activation_setting: str | None,
) -> None:
    entrypoint, command, mount, _mountinfo, trace = _instrumented_entrypoint(tmp_path)
    result = tmp_path / "result"

    completed = _run_entrypoint(
        entrypoint,
        command,
        trace,
        result,
        managed_environment={"CREEK_MANAGED_VAULT_ACTIVATION_ENABLED": activation_setting},
    )

    assert completed.returncode == 0
    assert result.read_text(encoding="utf-8") == "10001:10001:/home/appuser\n"
    assert not mount.exists()
    assert trace.read_text(encoding="utf-8") == "setpriv:10001:10001\n"


def test_disabled_entrypoint_with_existing_lifecycle_config_refuses_missing_mount(
    tmp_path: Path,
) -> None:
    entrypoint, command, _mount, _mountinfo, trace = _instrumented_entrypoint(tmp_path)
    result = tmp_path / "result"
    completed = _run_entrypoint(
        entrypoint,
        command,
        trace,
        result,
        managed_environment={
            "CREEK_MANAGED_VAULT_ACTIVATION_ENABLED": "false",
            "CREEK_PROVISIONING_AUTH_FILE": ("/run/adepthood-secrets/creek-control-bearer"),
        },
    )

    assert completed.returncode != 0
    assert not result.exists()
    assert not trace.exists()


@pytest.mark.parametrize(
    ("activation_setting", "mount_state"),
    [("true", "absent"), (" unexpected ", "mis-mounted")],
)
def test_enabled_or_preparing_entrypoint_refuses_without_exact_mount(
    tmp_path: Path,
    activation_setting: str,
    mount_state: str,
) -> None:
    entrypoint, command, mount, mountinfo, trace = _instrumented_entrypoint(tmp_path)
    result = tmp_path / "result"
    if mount_state == "mis-mounted":
        mount.mkdir()
        _write_mountinfo(mountinfo, tmp_path / "somewhere-else")

    completed = _run_entrypoint(
        entrypoint,
        command,
        trace,
        result,
        managed_environment={"CREEK_MANAGED_VAULT_ACTIVATION_ENABLED": activation_setting},
    )

    assert completed.returncode != 0
    assert not result.exists()
    assert not trace.exists()


def test_enabled_entrypoint_normalizes_exact_mount_then_runs_as_service_identity(
    tmp_path: Path,
) -> None:
    entrypoint, command, mount, mountinfo, trace = _instrumented_entrypoint(tmp_path)
    result = tmp_path / "result"
    mount.mkdir(mode=0o755)
    _write_mountinfo(mountinfo, mount)

    completed = _run_entrypoint(
        entrypoint,
        command,
        trace,
        result,
        managed_environment={"CREEK_MANAGED_VAULT_ACTIVATION_ENABLED": "YES"},
    )

    assert completed.returncode == 0
    assert mount.stat().st_mode & 0o777 == 0o700
    assert result.read_text(encoding="utf-8") == "10001:10001:/home/appuser\n"
    assert trace.read_text(encoding="utf-8").splitlines() == [
        f"install:-d --owner=10001 --group=10001 --mode=0700 {mount}",
        "setpriv:10001:10001",
    ]


def test_disabled_entrypoint_normalizes_a_present_exact_preparation_mount(
    tmp_path: Path,
) -> None:
    entrypoint, command, mount, mountinfo, trace = _instrumented_entrypoint(tmp_path)
    result = tmp_path / "result"
    mount.mkdir(mode=0o755)
    _write_mountinfo(mountinfo, mount)

    completed = _run_entrypoint(
        entrypoint,
        command,
        trace,
        result,
        managed_environment={"CREEK_MANAGED_VAULT_ACTIVATION_ENABLED": "false"},
    )

    assert completed.returncode == 0
    assert mount.stat().st_mode & 0o777 == 0o700
    assert result.read_text(encoding="utf-8") == "10001:10001:/home/appuser\n"
    assert trace.read_text(encoding="utf-8").splitlines() == [
        f"install:-d --owner=10001 --group=10001 --mode=0700 {mount}",
        "setpriv:10001:10001",
    ]


def test_disabled_entrypoint_refuses_a_present_nonmount_directory(tmp_path: Path) -> None:
    entrypoint, command, mount, mountinfo, trace = _instrumented_entrypoint(tmp_path)
    result = tmp_path / "result"
    mount.mkdir()
    _write_mountinfo(mountinfo, tmp_path / "somewhere-else")

    completed = _run_entrypoint(
        entrypoint,
        command,
        trace,
        result,
        managed_environment={"CREEK_MANAGED_VAULT_ACTIVATION_ENABLED": None},
    )

    assert completed.returncode != 0
    assert not result.exists()
    assert not trace.exists()


def test_root_parser_ignores_hostile_pythonpath_before_privilege_drop(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    entrypoint, command, _mount, _mountinfo, trace = _instrumented_entrypoint(tmp_path)
    result = tmp_path / "result"
    sentinel = tmp_path / "startup-sentinel"
    hostile = tmp_path / "hostile-pythonpath"
    shadow_services = hostile / "services"
    shadow_services.mkdir(parents=True)
    (shadow_services / "__init__.py").write_text("", encoding="utf-8")
    (shadow_services / "managed_vault_activation_config.py").write_text(
        "print('disabled')\n",
        encoding="utf-8",
    )
    (hostile / "sitecustomize.py").write_text(
        "import os\n"
        "from pathlib import Path\n"
        "Path(os.environ['PYTHON_STARTUP_SENTINEL']).write_text('executed')\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("PYTHONPATH", str(hostile))
    monkeypatch.setenv("PYTHON_STARTUP_SENTINEL", str(sentinel))

    completed = _run_entrypoint(
        entrypoint,
        command,
        trace,
        result,
        managed_environment={"CREEK_MANAGED_VAULT_ACTIVATION_ENABLED": None},
    )

    assert completed.returncode == 0
    assert result.read_text(encoding="utf-8") == "10001:10001:/home/appuser\n"
    assert not sentinel.exists()
