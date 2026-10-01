#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
    echo "secret mount verifier requires a directory and mountinfo file" >&2
    exit 2
fi

mount_directory=$1
mountinfo_file=$2

if [ -L "$mount_directory" ] || [ ! -d "$mount_directory" ]; then
    echo "secret mount must be a non-symlink directory" >&2
    exit 2
fi
if [ ! -r "$mountinfo_file" ]; then
    echo "Linux mount metadata is unavailable" >&2
    exit 2
fi

exact_mount=false
while IFS=' ' read -r _mount_id _parent_id _device _root mount_point _remainder; do
    if [ "$mount_point" = "$mount_directory" ]; then
        exact_mount=true
        break
    fi
done < "$mountinfo_file"

if [ "$exact_mount" != "true" ]; then
    echo "secret mount must be an exact mounted filesystem" >&2
    exit 2
fi
