"""Keep the root-only volume bootstrap separate from the backend identity."""

from pathlib import Path

_DOCKERFILE = Path(__file__).resolve().parents[1] / "Dockerfile"
_ENTRYPOINT = Path(__file__).resolve().parents[1] / "docker" / "backend-entrypoint.sh"
_RUNTIME_ID = "10001"
_SECRETS_DIRECTORY = "/run/adepthood-secrets"


def test_backend_image_pins_the_runtime_uid_and_gid_behind_root_bootstrap() -> None:
    dockerfile = _DOCKERFILE.read_text(encoding="utf-8")

    assert f"groupadd --gid {_RUNTIME_ID} appuser" in dockerfile
    assert f"useradd --uid {_RUNTIME_ID} --gid {_RUNTIME_ID}" in dockerfile
    assert "util-linux" in dockerfile
    assert (
        "COPY --chmod=0555 backend/docker/backend-entrypoint.sh "
        "/usr/local/bin/adepthood-backend-entrypoint" in dockerfile
    )
    assert (
        "COPY --chmod=0555 backend/docker/verify-secrets-mount.sh "
        "/usr/local/bin/adepthood-verify-secrets-mount" in dockerfile
    )
    assert 'ENTRYPOINT ["/usr/local/bin/adepthood-backend-entrypoint"]' in dockerfile
    assert not any(line.startswith("USER ") for line in dockerfile.splitlines())


def test_root_entrypoint_initializes_only_the_secret_directory_then_drops_privilege() -> None:
    entrypoint = _ENTRYPOINT.read_text(encoding="utf-8")

    mount_verification = entrypoint.index("adepthood-verify-secrets-mount")
    install_start = entrypoint.index("/usr/bin/install -d")
    runtime_home = entrypoint.index("HOME=/home/appuser")
    privilege_drop = entrypoint.index("exec /usr/bin/setpriv")
    assert mount_verification < install_start < runtime_home < privilege_drop
    assert '--owner="$runtime_uid"' in entrypoint
    assert '--group="$runtime_gid"' in entrypoint
    assert "--mode=0700" in entrypoint
    assert f"secrets_directory={_SECRETS_DIRECTORY}" in entrypoint
    assert "--clear-groups" in entrypoint
    assert "--no-new-privs" in entrypoint
    assert '"$@"' in entrypoint
    assert "chown -R" not in entrypoint
    assert "export HOME USER LOGNAME" in entrypoint
    assert (
        "/usr/local/bin/python -I \\\n        /app/src/services/managed_vault_activation_config.py"
    ) in entrypoint
    assert "python -m services.managed_vault_activation_config" not in entrypoint


def test_nonroot_entrypoint_refuses_to_start_without_the_bootstrap() -> None:
    entrypoint = _ENTRYPOINT.read_text(encoding="utf-8")

    root_guard = entrypoint.index('if [ "$(/usr/bin/id -u)" != "0" ]; then')
    refusal = entrypoint.index("exit 1", root_guard)
    mount_verification = entrypoint.index("adepthood-verify-secrets-mount")
    install_start = entrypoint.index("/usr/bin/install -d")
    assert root_guard < refusal < mount_verification < install_start
