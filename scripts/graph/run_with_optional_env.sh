#!/usr/bin/env bash
# scripts/graph/run_with_optional_env.sh
#
# Run a command with the named environment variables REMOVED if they are empty
# (or whitespace-only), and passed through untouched if they carry a value.
#
# WHY THIS EXISTS: GitHub Actions has no way to omit an `env:` key
# conditionally. `FOO: ${{ vars.FOO }}` with `vars.FOO` unset does not leave
# FOO unset in the step — it sets FOO to the empty string. Shell readers cannot
# tell the difference, because `${FOO:-default}` treats empty and unset alike,
# so an optional-variable passthrough looks correct and tests clean.
#
# Library clients are not so forgiving. The Anthropic Python SDK resolves its
# base URL as `os.environ.get("ANTHROPIC_BASE_URL")` and only substitutes
# https://api.anthropic.com when that returns None. An empty string is a value,
# so it became the base URL, every request was issued against a relative URL,
# and the SDK reported the transport failure as `Connection error.` — a string
# that fits a dead credential and a firewalled runner just as well as it fits
# this. graph-semantic.yml failed that way, every chunk of every weekly run,
# for over a month, while the curl preflight beside it passed every time.
#
# So the rule this encodes is: an optional variable that was never configured
# must reach the child process as ABSENT, not as empty. Whitespace-only counts
# as never configured — a repo variable saved with a stray space is the same
# defect wearing a disguise.
#
# Usage:  run_with_optional_env.sh NAME [NAME...] -- command [args...]
#
# Exits with the command's own status, so a wrapped failure stays a failure.
# Exit 1 is reserved for a usage error (no `--`, or nothing after it), which is
# refused loudly rather than treated as "nothing to run".
set -uo pipefail

names=()
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == "--" ]]; then shift; break; fi
  names+=("$1")
  shift
  # A run that never saw `--` has consumed every argument; that is the usage
  # error below, not an empty command list.
  if [[ "$#" -eq 0 ]]; then
    printf 'run_with_optional_env: missing `--` separator before the command\n' >&2
    printf 'usage: run_with_optional_env.sh NAME [NAME...] -- command [args...]\n' >&2
    exit 1
  fi
done

if [[ "$#" -eq 0 ]]; then
  printf 'run_with_optional_env: no command after `--`\n' >&2
  printf 'usage: run_with_optional_env.sh NAME [NAME...] -- command [args...]\n' >&2
  exit 1
fi

for name in ${names[@]+"${names[@]}"}; do
  value="${!name-}"
  # Strip whitespace; what is left decides. Empty and unset are the same
  # answer here, which is the whole point.
  if [[ -z "${value//[[:space:]]/}" ]]; then
    unset "$name"
  fi
done

exec "$@"
