#!/usr/bin/env bash
# scripts/graph/anthropic_preflight.sh
#
# One minimal authenticated request to the Anthropic API, so a failing semantic
# extraction names its own cause instead of hiding behind a string that fits
# every cause equally.
#
# WHY THIS EXISTS: graph-semantic.yml failed six weekly runs in a row with all
# thirteen chunks reporting the same `Connection error.` and nothing else. That
# one string is compatible with three very different faults, which have three
# different owners:
#
#   1. the credential is dead — revoked, expired, or out of credit. ONLY the
#      repo owner can fix this, and it must not be worked around.
#   2. the runner cannot reach the API — egress policy, DNS, TLS.
#   3. the extractor's pinned client is broken — it reaches the API fine and
#      still fails, in which case the bug is in graphify, not in this repo's
#      configuration.
#
# Nothing in the extractor's output distinguishes them, so a month of failures
# looked like one undiagnosable problem. A single request that prints its HTTP
# status separates all three in about a second, and the exit codes below say
# which one it was.
#
# Exit codes (each maps to exactly one owner):
#   0  reachable and authenticated (HTTP 200) — causes 1 and 2 are ruled out, so
#      a chunk failure after this is cause 3
#   1  usage error: no key was passed at all
#   2  credential REJECTED (401/403) — cause 1, the owner's to rotate
#   3  could not reach the API at all (no HTTP response) — cause 2
#   4  reached and authenticated, but the API refused (429/5xx/other) — the
#      response body says which, and "out of credit" lands here rather than on 2
#
# THE KEY IS NEVER PRINTED. It travels in a request header, never in the URL, so
# curl's own error messages cannot contain it; the response body is third-party
# output and is scrubbed of anything key-shaped anyway rather than trusted.
#
# Usage:  anthropic_preflight.sh
# Reads:  ANTHROPIC_API_KEY (required), ANTHROPIC_BASE_URL (optional)

# Deliberately no `-e`: curl's non-zero exit IS the diagnosis on the egress path,
# so it must be captured and classified rather than kill the script unexamined.
set -uo pipefail

readonly DEFAULT_BASE_URL="https://api.anthropic.com"
# A model listing: authenticated, cheap, and it buys no tokens. The preflight
# for a workflow whose whole problem is a paid API must not itself be a paid
# call, so this is deliberately not a /v1/messages completion.
readonly PROBE_PATH="/v1/models?limit=1"
readonly ANTHROPIC_VERSION="2023-06-01"
readonly CONNECT_TIMEOUT_SECONDS=10
readonly MAX_TIME_SECONDS=30
readonly HTTP_OK="200"
readonly HTTP_UNAUTHORIZED="401"
readonly HTTP_FORBIDDEN="403"
# What curl writes for `%{http_code}` when no HTTP response ever arrived.
readonly NO_HTTP_RESPONSE="000"
# How much third-party response body to echo. Enough to carry an Anthropic error
# type and message, short enough that a hostile or broken endpoint cannot bury
# the diagnosis under its own output.
readonly MAX_BODY_CHARS=500

readonly EXIT_OK=0
readonly EXIT_USAGE=1
readonly EXIT_CREDENTIAL_REJECTED=2
readonly EXIT_UNREACHABLE=3
readonly EXIT_REFUSED=4

# Anything key-shaped is replaced before it can be printed. The body cannot
# legitimately contain the key — but "cannot" is an assumption about someone
# else's server, and a leaked credential in a public Actions log is worse than
# the outage this script explains.
readonly REDACTION='[REDACTED]'
redact() { sed -e 's/sk-ant-[A-Za-z0-9_-]*/'"$REDACTION"'/g'; }

key="${ANTHROPIC_API_KEY:-}"
if [[ -z "$key" ]]; then
  echo "::error::ANTHROPIC_API_KEY is empty — cannot run the Anthropic preflight."
  exit "$EXIT_USAGE"
fi

base="${ANTHROPIC_BASE_URL:-}"
[[ -n "$base" ]] || base="$DEFAULT_BASE_URL"
# One trailing slash on a configured base URL is the common shape and must not
# produce a `//` path.
base="${base%/}"
url="$base$PROBE_PATH"

body_file="$(mktemp)"
err_file="$(mktemp)"
trap 'rm -f "$body_file" "$err_file"' EXIT

echo "anthropic preflight: GET $url"

status=""
curl_ec=0
status="$(curl --silent --show-error \
  --output "$body_file" \
  --write-out '%{http_code}' \
  --connect-timeout "$CONNECT_TIMEOUT_SECONDS" \
  --max-time "$MAX_TIME_SECONDS" \
  --header "x-api-key: $key" \
  --header "anthropic-version: $ANTHROPIC_VERSION" \
  "$url" 2>"$err_file")" || curl_ec=$?

curl_err="$(redact <"$err_file")"
body="$(head -c "$MAX_BODY_CHARS" "$body_file" | redact)"

# Cause 2 — no HTTP response at all. A non-zero curl exit is treated as
# unreachable even when a status somehow got written, because a request that did
# not complete cannot have delivered a final answer, and reading a partial one
# as authoritative is how an egress fault gets misfiled as an auth fault.
if [[ "$curl_ec" -ne 0 || "$status" == "$NO_HTTP_RESPONSE" ]]; then
  echo "::error::anthropic preflight: could not reach $base — no HTTP response (curl exit $curl_ec). This is a runner egress/DNS/TLS problem, not a credential problem."
  [[ -z "$curl_err" ]] || echo "curl: $curl_err"
  exit "$EXIT_UNREACHABLE"
fi

echo "anthropic preflight: HTTP $status"

# Cause 1 — the credential is dead. Stop here and hand it back: rotating a
# secret is the repo owner's, and working around it would publish a docs-blind
# graph, which is worse than publishing none.
if [[ "$status" == "$HTTP_UNAUTHORIZED" || "$status" == "$HTTP_FORBIDDEN" ]]; then
  echo "::error::anthropic preflight: the API rejected the credential (HTTP $status). ANTHROPIC_API_KEY is revoked, expired, or lacks access — the repo owner must rotate the secret; this is not something the workflow can work around."
  [[ -z "$body" ]] || echo "response: $body"
  exit "$EXIT_CREDENTIAL_REJECTED"
fi

if [[ "$status" != "$HTTP_OK" ]]; then
  echo "::error::anthropic preflight: the API answered HTTP $status. The credential and the network are both fine; the API refused this request (rate limit, insufficient credit, or an outage)."
  [[ -z "$body" ]] || echo "response: $body"
  exit "$EXIT_REFUSED"
fi

echo "anthropic preflight: HTTP $HTTP_OK — credential valid and the API is reachable."
echo "If semantic chunks still fail after this, the fault is in the extractor's own client, not in this repo's secrets or the runner's egress."
exit "$EXIT_OK"
