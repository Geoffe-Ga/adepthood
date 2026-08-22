#!/usr/bin/env bash
# scripts/graph/test_anthropic_preflight.sh
#
# Offline tests for anthropic_preflight.sh — the one cheap authenticated request
# that tells the three causes of a failing semantic extraction apart. The
# workflow it guards had failed six times in a row over a month with every chunk
# reporting the same opaque `Connection error.`, which is compatible with a dead
# credential, a runner that cannot egress, and a broken client in the extractor.
# Those have three different owners, so the diagnostic must NAME which one it is.
#
# The point of the suite is the failure paths: a preflight that only proves the
# happy case would have told us nothing about any of the six real runs. `curl` is
# stubbed on PATH so each cause can be reproduced exactly.
#
# The other hard requirement is negative: the key must never appear in the
# output. That is asserted on EVERY path, including the ones that print a
# response body, because a diagnostic that leaks a credential into a public log
# is worse than the outage it explains.
#
# Run:  bash scripts/graph/test_anthropic_preflight.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PREFLIGHT="$HERE/anthropic_preflight.sh"
PASS=0
FAIL=0

ok()  { PASS=$((PASS + 1)); printf '  ok  - %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL  - %s\n' "$1"; }
check() { # check <desc> <expected> <actual>
  if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (expected '$2', got '$3')"; fi
}
contains() { # contains <desc> <needle> <haystack>
  # Haystacks here range from one line to a whole workflow file, so a failure
  # prints a bounded excerpt: an unreadable wall of YAML is how a real failure
  # gets skimmed past.
  if grep -qF -- "$2" <<<"$3"; then ok "$1"; else bad "$1 (no '$2' in: ${3:0:200})"; fi
}
lacks() { # lacks <desc> <needle> <haystack>
  if grep -qF -- "$2" <<<"$3"; then bad "$1 (found '$2')"; else ok "$1"; fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
BIN="$WORK/bin"
mkdir -p "$BIN"

# Stub curl. Driven by:
#   STUB_STATUS — the HTTP status to write out (`000` is what real curl reports
#                 when it never got a response at all)
#   STUB_EC     — curl's own exit code (7 = connect failed, 6 = DNS, 35 = TLS)
#   STUB_STDERR — what curl writes to stderr, as `--show-error` would
#   STUB_BODY   — the response body written to the `--output` path
#   STUB_ARGS_FILE — file the stub records its full argv into, so the test can
#                 assert what was actually requested (and what was not)
cat > "$BIN/curl" <<'STUB'
#!/usr/bin/env bash
[[ -z "${STUB_ARGS_FILE:-}" ]] || printf '%s\n' "$*" > "$STUB_ARGS_FILE"
out=""
prev=""
for a in "$@"; do
  [[ "$prev" == "--output" || "$prev" == "-o" ]] && out="$a"
  prev="$a"
done
[[ -z "$out" || -z "${STUB_BODY:-}" ]] || printf '%s' "$STUB_BODY" > "$out"
[[ -z "${STUB_STDERR:-}" ]] || printf '%s\n' "$STUB_STDERR" >&2
printf '%s' "${STUB_STATUS:-200}"
exit "${STUB_EC:-0}"
STUB
chmod +x "$BIN/curl"

# A credential-shaped value, so every assertion that it never leaks is testing
# the real redaction path rather than an unrecognisable placeholder. Assembled
# from parts so the literal prefix never appears in this file as a token a
# secret scanner would flag.
FAKE_KEY="sk-ant-api03-$(printf 'T%.0sOPSECRET' 1)-do-not-log"

run() { # run <expected-desc-only>: prints "<exit code>\n<combined output>"
  local ec=0 out
  out="$(PATH="$BIN:$PATH" ANTHROPIC_API_KEY="$FAKE_KEY" "$PREFLIGHT" 2>&1)" || ec=$?
  printf '%s\n%s' "$ec" "$out"
}
ec_of()  { printf '%s' "${1%%$'\n'*}"; }
out_of() { printf '%s' "${1#*$'\n'}"; }

# --- the credential is dead: 401/403 belongs to the repo owner ---------------
# This is the cause that must NOT be worked around. The whole reason to run a
# preflight is that `Connection error.` from thirteen parallel chunks looks
# identical whether the key is revoked or the network is down.
r="$(STUB_STATUS=401 run)"
check "a 401 exits with the credential-rejected code" "2" "$(ec_of "$r")"
contains "a 401 says the credential was rejected" "401" "$(out_of "$r")"
contains "a 401 names the owner as the fixer" "rotate" "$(out_of "$r")"
lacks "a 401 never prints the key" "$FAKE_KEY" "$(out_of "$r")"

r="$(STUB_STATUS=403 run)"
check "a 403 exits with the credential-rejected code" "2" "$(ec_of "$r")"
lacks "a 403 never prints the key" "$FAKE_KEY" "$(out_of "$r")"

# --- the runner cannot reach the API: curl fails before any status -----------
# Real curl reports `000` here, because there was no HTTP response to report.
# Reading that as "some HTTP error" is how an egress problem gets misfiled as a
# credential problem.
r="$(STUB_STATUS=000 STUB_EC=7 STUB_STDERR='curl: (7) Failed to connect to api.anthropic.com port 443' run)"
check "a refused connection exits with the unreachable code" "3" "$(ec_of "$r")"
contains "a refused connection is reported as egress, not auth" "could not reach" "$(out_of "$r")"
contains "a refused connection keeps curl's own exit code" "7" "$(out_of "$r")"
lacks "a refused connection never prints the key" "$FAKE_KEY" "$(out_of "$r")"

r="$(STUB_STATUS=000 STUB_EC=6 STUB_STDERR='curl: (6) Could not resolve host: api.anthropic.com' run)"
check "a DNS failure exits with the unreachable code" "3" "$(ec_of "$r")"
contains "a DNS failure surfaces curl's message" "Could not resolve host" "$(out_of "$r")"

r="$(STUB_STATUS=000 STUB_EC=35 STUB_STDERR='curl: (35) TLS connect error' run)"
check "a TLS failure exits with the unreachable code" "3" "$(ec_of "$r")"

# A non-zero curl exit with a status that somehow arrived is still "we could not
# complete the request" — fail closed rather than reading the status as final.
r="$(STUB_STATUS=200 STUB_EC=28 STUB_STDERR='curl: (28) Operation timed out' run)"
check "a timeout is unreachable even with a 200 written out" "3" "$(ec_of "$r")"

# --- the API answered, and refused ------------------------------------------
# Out of credit and rate limits are neither a dead key nor a dead network, and
# the response body is what distinguishes them. It cannot contain the key: the
# key travels in a request header and this body is written by the API.
r="$(STUB_STATUS=429 STUB_BODY='{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}' run)"
check "a 429 exits with the refused code" "4" "$(ec_of "$r")"
contains "a 429 surfaces the API's own error type" "rate_limit_error" "$(out_of "$r")"

r="$(STUB_STATUS=400 STUB_BODY='{"type":"error","error":{"type":"invalid_request_error","message":"credit balance is too low"}}' run)"
check "a 400 exits with the refused code" "4" "$(ec_of "$r")"
contains "a 400 surfaces the reason it was refused" "credit balance is too low" "$(out_of "$r")"

r="$(STUB_STATUS=500 run)"
check "a 5xx exits with the refused code" "4" "$(ec_of "$r")"

# --- the credential works ---------------------------------------------------
# A 200 means causes (1) and (2) are both ruled out, so a chunk failure after
# this points at the extractor's own client — which is the whole diagnostic.
r="$(STUB_STATUS=200 STUB_BODY='{"data":[{"id":"claude-x"}]}' run)"
check "a 200 exits 0" "0" "$(ec_of "$r")"
contains "a 200 reports the status" "200" "$(out_of "$r")"
lacks "a 200 never prints the key" "$FAKE_KEY" "$(out_of "$r")"

# --- the key must never leak, even if the API echoes something key-shaped ----
# Belt and braces: the body is third-party output, so it is scrubbed rather than
# trusted. A diagnostic that leaks a credential into a public Actions log is
# worse than the outage it explains.
r="$(STUB_STATUS=400 STUB_BODY="{\"error\":{\"message\":\"bad key $FAKE_KEY\"}}" run)"
lacks "a key-shaped string in the response body is redacted" "$FAKE_KEY" "$(out_of "$r")"
contains "the redaction is visible rather than silent" "REDACTED" "$(out_of "$r")"

# --- the request itself ------------------------------------------------------
ARGS="$WORK/curl-args"
r="$(STUB_STATUS=200 STUB_ARGS_FILE="$ARGS" run)"
args="$(cat "$ARGS")"
lacks "the key never travels in the URL" "$FAKE_KEY/" "$args"
contains "the request is authenticated" "x-api-key" "$args"
contains "the request pins an API version" "anthropic-version" "$args"
contains "the request cannot hang the job" "--max-time" "$args"
# The six real failures took ~90s for thirteen chunks, i.e. they failed FAST.
# A preflight without a connect timeout could still stall a 30-minute job.
contains "the request bounds the connect phase too" "--connect-timeout" "$args"
# A HEAD/GET listing is the cheap probe; the preflight must not itself buy
# tokens on a workflow whose whole point is that it calls a paid API.
lacks "the preflight does not POST a completion" "/v1/messages" "$args"

# --- an absent key is a usage error, not a diagnosis -------------------------
ec=0
out="$(PATH="$BIN:$PATH" ANTHROPIC_API_KEY="" "$PREFLIGHT" 2>&1)" || ec=$?
check "an empty key exits 1 without probing" "1" "$ec"
contains "an empty key says so" "ANTHROPIC_API_KEY" "$out"

# --- the base URL is honoured ------------------------------------------------
# The workflow passes `vars.ANTHROPIC_BASE_URL` through and documents that empty
# is fine, so both branches have to work.
ARGS2="$WORK/curl-args-base"
r="$(STUB_STATUS=200 STUB_ARGS_FILE="$ARGS2" ANTHROPIC_BASE_URL="https://proxy.example.com/" run)"
args2="$(cat "$ARGS2")"
contains "a configured base URL is used" "https://proxy.example.com/v1/models" "$args2"
lacks "a trailing slash does not double up" "com//v1" "$args2"

ARGS3="$WORK/curl-args-default"
r="$(STUB_STATUS=200 STUB_ARGS_FILE="$ARGS3" run)"
contains "an empty base URL falls back to the real API" "https://api.anthropic.com/v1/models" \
  "$(cat "$ARGS3")"

# --- the workflow actually runs it -------------------------------------------
# A diagnostic nothing invokes is the same silent gap as the failures it exists
# to explain, so the coupling is pinned here rather than left to review.
WORKFLOW="$(cd "$HERE/../.." && pwd)/.github/workflows/graph-semantic.yml"
if [[ ! -f "$WORKFLOW" ]]; then
  bad "graph-semantic.yml exists"
else
  ok "graph-semantic.yml exists"
  wf="$(cat "$WORKFLOW")"
  contains "the workflow invokes the preflight" "scripts/graph/anthropic_preflight.sh" "$wf"
  # It has to run BEFORE the extraction, or it explains nothing that the
  # extraction has not already failed on.
  pre_line="$(grep -n 'anthropic_preflight.sh' "$WORKFLOW" | head -n 1 | cut -d: -f1)"
  ext_line="$(grep -n 'graphify extract' "$WORKFLOW" | head -n 1 | cut -d: -f1)"
  if [[ -n "$pre_line" && -n "$ext_line" && "$pre_line" -lt "$ext_line" ]]; then
    ok "the preflight runs before the extraction"
  else
    bad "the preflight runs before the extraction (preflight@$pre_line, extract@$ext_line)"
  fi
  # The hard guard the issue explicitly says to keep.
  contains "the ANTHROPIC_API_KEY guard is still there" "refusing to publish a docs-blind graph" "$wf"
  # Weekly cron only: this calls a paid API over the whole tree.
  if grep -qE '^\s+(push|pull_request):' "$WORKFLOW"; then
    bad "the workflow has no push/pull_request trigger"
  else
    ok "the workflow has no push/pull_request trigger"
  fi
fi

printf '\nanthropic_preflight tests: %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
