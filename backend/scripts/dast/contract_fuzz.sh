#!/usr/bin/env bash
# backend/scripts/dast/contract_fuzz.sh
#
# Ask one question of every operation the running instance publishes about
# itself: can schema-aware but adversarial input make this endpoint break its
# own contract?
#
# This lives in a script rather than inline in .github/workflows/dast-contract.yml
# so that it can be *executed* by a test. A YAML `run:` block can only be
# asserted about by grepping the file for strings, and a substring search cannot
# tell a live invocation from a commented-out one, nor a wired exclusion list
# from an array that reaches no argument. The suite in
# backend/tests/scripts/dast/test_contract_fuzz_script.py runs this script with a
# recording stub named `schemathesis` on PATH and asserts on the argv it
# actually built.
#
# The document is read from the running app, never from the checked-in export,
# so the spec this gate judges against can never drift away from the code it is
# judging.
#
# Environment (all required; there is no default, because every default here
# would be a way to fuzz the wrong thing and report success):
#   BASE_URL    -- the running instance, e.g. http://127.0.0.1:8000
#   DAST_TOKEN  -- a bearer token already proven to open an authenticated route
#   REPORT_DIR  -- where the JUnit report is written
#
# Exits with schemathesis's own exit code. Nothing runs after it, by
# construction: the fuzzer is `exec`'d, so no trailing command can ever stand
# between a failing run and a failing job.

set -euo pipefail

# This script takes no arguments. Accepting any would hand a caller a way to
# append a filter -- `--exclude-method GET`, `--exclude-path-regex ...` -- that
# widens the exclusion set behind the back of the named list below and of the
# test that caps that list at a minority of the API.
if [ "$#" -ne 0 ]; then
  echo "usage: contract_fuzz.sh (no arguments; see the header for the environment)" >&2
  exit 2
fi

: "${BASE_URL:?BASE_URL must name the running instance}"
: "${DAST_TOKEN:?DAST_TOKEN must hold a token proven to open an authenticated route}"
: "${REPORT_DIR:?REPORT_DIR must name a directory for the JUnit report}"

# The checks the run enforces, named one by one. `--checks all` would silently
# change meaning with every upgrade.
#
# status_code_conformance is enabled now that every operation declares the
# refusals it can actually send. It was held back while the document declared no
# 401, 403, 404 or 429 anywhere, which made it measure a documentation gap
# rather than a fuzzing finding: 66 of the 114 selected operations failed it.
#
# Turned on against evidence rather than hope. With the declarations in place a
# real run answers 899/899 at this seed and budget, and three further seeds at
# three times the budget -- roughly 8,700 generated cases -- raised no failure
# this check found on its own. Two unit guards keep it that way without a live
# run: one fails any router module that builds its own APIRouter instead of the
# shared factory, the other any module naming a status in an `errors` helper or
# a hand-built HTTPException that its operations do not declare.
CHECKS="not_a_server_error,content_type_conformance,response_schema_conformance,status_code_conformance"

# Budget: the live document publishes 128 operations, 14 of which are excluded
# below, leaving 114. At this example count that is at most ~1,140 generated
# cases in the fuzzing phase plus the handful the examples phase replays --
# roughly a minute of request time against a loopback instance. Raise it once
# the measured wall clock of a real run is known.
MAX_EXAMPLES=10

# Fixed so a failure can be replayed byte for byte. A gate that cannot be
# replayed cannot be trusted to have failed honestly.
SEED=1337

# Truncates the evidence, never the verdict: reaching this still exits non-zero.
# It exists so a systemically broken build reports in seconds instead of
# spending the whole budget rediscovering one bug on every route.
MAX_FAILURES=20

# Phases: the coverage phase is off because the number of cases it derives from
# a schema is not something this comment could state a bound for, and an
# unstated budget is how a five-minute gate becomes a twenty-minute one. The
# stateful phase is off because a FastAPI-generated document declares no OpenAPI
# links, so it has no transitions to follow.
PHASES="examples,fuzzing"

# Excluded by exact operation name, never by a blanket path filter, and every
# line carries the reason it cannot be fuzzed. A named exclusion has to be
# defended; a pattern quietly grows.
#
# backend/tests/scripts/dast/test_contract_fuzz_script.py checks every name here
# against the operations the app actually publishes -- so a renamed route turns
# red rather than leaving a dead line behind -- and separately proves that each
# one reaches the fuzzer as an `--exclude-name` argument.
#
# The first two entries are the load-bearing ones: both destroy the credential
# this whole run depends on, and losing it mid-run is invisible. Every request
# after it answers 401, which is not a 5xx and is undeclared on every operation,
# so all three enabled checks pass and the job goes green having reached no
# handler at all.
EXCLUDED=(
  'DELETE /users/me'                    # deletes the fuzzing identity; every later request would be unauthenticated
  'POST /auth/refresh'                  # revokes the presented token's jti; every later request would be unauthenticated
  'POST /auth/signup'                   # gated on a live Gumroad license verification
  'POST /auth/oauth/google'             # verifies a token with Google
  'POST /auth/oauth/apple'              # verifies a token with Apple
  'POST /auth/password-reset/request'   # sends real mail, and is capped at 3/hour per route
  'POST /journal/transcribe-page'       # external ASR provider (routers/transcription.py)
  'GET /user/balance'                   # external Botmason credit API (routers/botmason.py)
  'GET /user/usage'                     # external Botmason credit API (routers/botmason.py)
  'POST /user/balance/add'              # external Botmason credit API (routers/botmason.py)
  'POST /webhooks/gumroad/ping'         # HMAC-signed vendor webhook, not a client route (routers/gumroad.py)
  'POST /corpus/import'                 # dials the external Creek vault
  'GET /users/me/export'                # streams a non-JSON media type the document declares as JSON
  'GET /users/me/export/journal.md'     # streams Markdown the document declares as JSON
)

exclusions=()
for name in "${EXCLUDED[@]}"; do
  exclusions+=(--exclude-name "$name")
done

exec schemathesis run "$BASE_URL/openapi.json" \
  --url "$BASE_URL" \
  --checks "$CHECKS" \
  --header "Authorization: Bearer $DAST_TOKEN" \
  --max-examples "$MAX_EXAMPLES" \
  --seed "$SEED" \
  --phases "$PHASES" \
  --max-failures "$MAX_FAILURES" \
  --report junit \
  --report-dir "$REPORT_DIR" \
  "${exclusions[@]}"
