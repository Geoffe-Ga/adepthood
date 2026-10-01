#!/bin/sh
set -eu

runtime_uid=10001
runtime_gid=10001
secrets_directory=/run/adepthood-secrets

if [ "$(/usr/bin/id -u)" != "0" ]; then
    echo "backend startup bootstrap requires the image's root entrypoint" >&2
    exit 1
fi
if [ "$#" -eq 0 ]; then
    echo "backend startup command is required" >&2
    exit 1
fi
if [ "${ENV:-}" = "e2e" ]; then
    echo "ENV=e2e is forbidden in the production image" >&2
    exit 1
fi
if [ -n "${ADEPTHOOD_E2E_MANAGED_VAULT_SECRET_ROOT:-}" ]; then
    echo "E2E managed-vault secret roots are forbidden in the production image" >&2
    exit 1
fi

# Ordinary and bring-your-own-vault deployments need no managed-pilot volume.
# Any enabled or malformed/preparing activation setting fails closed into the
# exact-mount bootstrap, using the same parser as the application rollout.
bootstrap_mode=$(
    /usr/local/bin/python -I \
        /app/src/services/managed_vault_activation_config.py
)
bootstrap_required=false
case "$bootstrap_mode" in
    disabled)
        # A disabled preparation deploy may already have its volume attached.
        # Test existence (including a dangling symlink) before any mutation;
        # every present path must still prove it is the exact mount.
        if [ -e "$secrets_directory" ] || [ -L "$secrets_directory" ]; then
            bootstrap_required=true
        fi
        ;;
    required) bootstrap_required=true ;;
    *)
        echo "managed-vault bootstrap mode is invalid" >&2
        exit 1
        ;;
esac

if [ "$bootstrap_required" = "true" ]; then
    # Railway creates a newly attached volume as root. Bootstrap only its fixed
    # mount point; bearer files are never traversed or rewritten.
    /usr/local/bin/adepthood-verify-secrets-mount \
        "$secrets_directory" \
        /proc/self/mountinfo
    /usr/bin/install -d \
        --owner="$runtime_uid" \
        --group="$runtime_gid" \
        --mode=0700 \
        "$secrets_directory"
fi

# Clear supplementary groups and set no-new-privileges before replacing this
# bootstrap process. Neither Alembic nor uvicorn ever executes as root.
HOME=/home/appuser
USER=appuser
LOGNAME=appuser
export HOME USER LOGNAME
exec /usr/bin/setpriv \
    --reuid="$runtime_uid" \
    --regid="$runtime_gid" \
    --clear-groups \
    --no-new-privs \
    "$@"
