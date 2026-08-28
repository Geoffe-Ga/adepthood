#!/usr/bin/env bash
# scripts/ci/classify_claude_outcome.sh
#
# Say WHICH way a scheduled Claude run failed, in one word.
#
# WHY THIS EXISTS: the nightly grooming workflow reported failure on most of its
# recent scheduled runs, in two ways that render identically in the Actions run
# list and that call for opposite responses.
#
#   * A FALSE red. The grooming ran to completion and wrote its summary, and the
#     action then exited non-zero because the conversation used more turns than
#     `--max-turns` allowed. Captured runs used 41, 44 and 45 against a cap of
#     40. The work landed; the job says failure; there is nothing to re-run.
#   * A REAL red. One turn, nothing attempted, `is_error` true, HTTP 429, a
#     result reading "You've hit your weekly limit". Re-running that before the
#     reset spends wall clock and achieves nothing.
#
# Nothing outside this script can tell them apart, because a turn-cap overrun is
# INVISIBLE in the transcript: its result message carries `subtype: "success"`
# and `is_error: false`, exactly as a clean run does. The only thing that
# separates them is that the action's step failed. So this takes three inputs
# rather than one.
#
# PASS `steps.<id>.outcome`, NEVER `steps.<id>.conclusion`. Under
# `continue-on-error: true` a failed step's `outcome` stays `failure` while its
# `conclusion` becomes `success`. Wiring `conclusion` in here would feed this
# script `success` for every failure it exists to catch and silently disable the
# whole mechanism -- while every test below still passed, because the tests feed
# the script directly.
#
# TWO RULES THAT FAIL CLOSED, both deliberate:
#
#   1. `is_error: true` NEVER yields `completed`, whatever the step outcome says.
#      The model reporting that it errored is positive evidence that nothing was
#      done; a green step beside it is a contradiction, and the safe side of a
#      contradiction is the one a human looks at.
#   2. An unreadable or resultless transcript is `no-result`, and the caller
#      treats that as a failure, even when the step succeeded. If the step passed
#      but the transcript cannot be read, this classifier is mis-wired -- and a
#      mis-wire that reports green is exactly the "green checkmark meaning nobody
#      looked" that this change exists to remove.
#
# NO VERDICT IS EVER KEYED ON TIME OR MONEY. A usage-limit failure and an expired
# credential have the same timing shape -- one turn, under a second, zero dollars
# -- and need opposite advice ("wait for the reset, retrying is wasted" versus
# "rotate the secret"). Reading `duration_ms` or `total_cost_usd` would tell the
# operator the wrong thing half the time. Everything here classifies on the
# structural fields (`is_error`, `api_error_status`, `num_turns`) and consults
# the model's `result` string only as a fallback for the cause and as material
# for the headline.
#
# The model's `result` string is HOSTILE DATA: it reaches a workflow input and an
# issue body. It is flattened to one line of printable ASCII and truncated before
# it is allowed anywhere near either.
#
# CONTRACT (the same one `scripts/ralph/playbook-wip-gate.sh` keeps): exactly ONE
# token on stdout and exit 0. A non-zero exit is a usage or tooling fault here,
# never a verdict, so a broken invocation can never be read as an answer about
# the run. The tokens:
#
#   completed          the run did its work and the step agrees
#   turn-cap-overrun   clean result, step failed, the conversation hit the cap
#   usage-limit        the account allowance is exhausted; waiting is the fix
#   auth-failure       the credential was rejected; rotating it is the fix
#   agent-error        it failed, and the cause is not one of the known ones
#   no-result          nothing to read; the run cannot be judged at all
#
# A usage fault still writes `outcome=classifier-fault` and a headline to
# $GITHUB_OUTPUT, because an unset output reads downstream as the empty string
# and every `if:` comparing against it takes the "not that outcome" branch -- the
# workflow then proceeds as though it had been told something. `classifier-fault`
# is deliberately not one of the six verdicts.
#
# Usage:
#   classify_claude_outcome.sh --execution-file <path> \
#                              --step-outcome <success|failure> \
#                              --max-turns <N>
#
# Tested at backend/tests/scripts/test_classify_claude_outcome.py.
set -uo pipefail

readonly EXIT_OK=0
readonly EXIT_USAGE=2

# The sentinel written to the step outputs when this script itself broke. Not a
# verdict, and deliberately not one of the six tokens.
readonly FAULT_OUTCOME="classifier-fault"

# One line an operator reads in the run list. The ceiling is what stops a
# multi-kilobyte model message from becoming "the headline".
readonly HEADLINE_MAX_CHARS=400
# How much of the model's last words ride along inside the headline. Enough to
# carry a reset time or an error type; short enough to leave room for the advice.
readonly EXCERPT_MAX_CHARS=120
# How much of them the step summary quotes. The summary has room to be useful.
readonly QUOTE_MAX_CHARS=1000

# HTTP statuses that name a cause on their own. Anything else that errored is an
# `agent-error`: unclassified is its own answer, and guessing is how wrong advice
# ships.
readonly STATUS_USAGE_LIMIT=429
readonly STATUS_UNAUTHORIZED=401
readonly STATUS_FORBIDDEN=403

# The only non-zero exit in this script. It is never a verdict: it says the
# classifier itself broke, in the outputs as well as on stderr, so a downstream
# `if:` comparing against an unset output cannot take a "not that outcome"
# branch and carry on as though it had been told something.
fault() {
  echo "classify-claude-outcome: $1" >&2
  publish "$FAULT_OUTCOME" "classifier fault: $1 -- the run was NOT classified, so nothing here says anything about it."
  exit "$EXIT_USAGE"
}

usage_fault() { fault "$1"; }

# Flatten arbitrary model output to one line of printable ASCII. A newline in
# here would append a second `key=value` line to $GITHUB_OUTPUT, which is a
# write-anything primitive; the backtick, dollar and backslash go because the
# value is destined for a markdown issue body.
sanitize() {
  LC_ALL=C printf '%s' "$1" \
    | LC_ALL=C sed -e 's/[^ -~]/ /g' -e 's/[`$\\]/ /g' -e 's/  */ /g' \
                   -e 's/^ //' -e 's/ $//'
}

# Sanitize and cut to a budget, marking the cut so a truncated quote is never
# mistaken for the whole message.
excerpt() { # excerpt <text> <max-chars>
  local text
  text="$(sanitize "$1")"
  if [[ "${#text}" -le "$2" ]]; then
    printf '%s' "$text"
  else
    printf '%s...' "${text:0:$2}"
  fi
}

append_to() { # append_to <env-var-name> <text>
  local path="${!1:-}"
  if [[ -n "$path" ]]; then
    printf '%s\n' "$2" >> "$path"
  fi
}

# Say it in all three places at once: stdout for a human running this by hand,
# $GITHUB_OUTPUT for whatever branches on it, $GITHUB_STEP_SUMMARY for the run
# list entry that is the only thing a cron run ever shows anybody.
publish() { # publish <outcome> <headline> [detail]
  local outcome="$1" headline="$2" detail="${3:-}"
  headline="$(excerpt "$headline" "$HEADLINE_MAX_CHARS")"
  append_to GITHUB_OUTPUT "outcome=$outcome"
  append_to GITHUB_OUTPUT "headline=$headline"
  append_to GITHUB_STEP_SUMMARY "### Claude run outcome: \`$outcome\`"
  append_to GITHUB_STEP_SUMMARY ""
  append_to GITHUB_STEP_SUMMARY "$headline"
  if [[ -n "$detail" ]]; then
    append_to GITHUB_STEP_SUMMARY ""
    append_to GITHUB_STEP_SUMMARY "$detail"
  fi
}

# The one exit that carries a verdict: token on stdout, exit 0.
verdict() { # verdict <outcome> <headline> [detail]
  publish "$1" "$2" "${3:-}"
  echo "$1"
  exit "$EXIT_OK"
}

execution_file=""
step_outcome=""
max_turns=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --execution-file)
      [[ $# -ge 2 ]] || usage_fault "--execution-file needs a value"
      execution_file="$2"; shift 2 ;;
    --step-outcome)
      [[ $# -ge 2 ]] || usage_fault "--step-outcome needs a value"
      step_outcome="$2"; shift 2 ;;
    --max-turns)
      [[ $# -ge 2 ]] || usage_fault "--max-turns needs a value"
      max_turns="$2"; shift 2 ;;
    *)
      usage_fault "unknown argument: $1" ;;
  esac
done

[[ -n "$execution_file" ]] || usage_fault "--execution-file is required"
[[ -n "$step_outcome" ]] || usage_fault "--step-outcome is required"
[[ -n "$max_turns" ]] || usage_fault "--max-turns is required"
# Only the two values GitHub itself puts in `steps.<id>.outcome` for a step that
# ran. Anything else is a mis-wiring -- most likely `conclusion`, which under
# `continue-on-error` reports `success` for the failures this exists to catch --
# and must not be guessed at.
case "$step_outcome" in
  success|failure) ;;
  *) usage_fault "--step-outcome must be success or failure, got: $step_outcome" ;;
esac
[[ "$max_turns" =~ ^[0-9]+$ ]] || usage_fault "--max-turns must be a number, got: $max_turns"

# --- Is there anything to read at all? --------------------------------------
# `-s` rather than `-f`: the action creates the file before it writes to it, so
# an empty one is a step that died before the SDK spoke.
if [[ ! -s "$execution_file" ]]; then
  verdict "no-result" \
    "no result: the execution file is missing or empty, so the run left nothing to judge. That is a failure in itself -- either the step died before the SDK spoke, or this classifier is pointed at the wrong path."
fi

# The action writes an ARRAY of messages ending in a `type: result` one. A reader
# loose enough to accept a top-level object would also accept whatever else a
# half-written file happens to parse as, so the shape is checked, not just the
# syntax. jq exits non-zero on malformed JSON and, under -e, on a null result.
result_json=""
jq_status=0
result_json="$(jq -ce 'if type == "array"
                       then (map(select(.type? == "result")) | last)
                       else null end' "$execution_file" 2>/dev/null)" || jq_status=$?
if [[ "$jq_status" -ne 0 || -z "$result_json" || "$result_json" == "null" ]]; then
  verdict "no-result" \
    "no result: the execution file is not a message array ending in a result, so the run left nothing to judge. Truncated, overwritten, or never finished -- read the raw file before believing anything about this run."
fi

# ONE jq call for all four fields, not one per field. Four calls are four
# processes that can each fail on their own, and a swallowed failure there would
# hand the logic below an empty `is_error` and an empty `num_turns` -- which
# reads as "clean transcript, stopped short of the cap" and reports a rejected
# credential as a generic agent error. So the extraction either succeeds
# completely or is a tooling fault, and never half-succeeds into a verdict.
#
# The fields are joined on ASCII US (0x1f) rather than a tab, because a TAB in
# IFS is whitespace to `read`, and IFS whitespace collapses runs of delimiters:
# an absent `api_error_status` would shift every later field one place left and
# the turn count would arrive holding the model's prose. US is not whitespace,
# so an empty field stays an empty field.
#
# The result string is flattened INSIDE jq: it is the only field a model writes,
# it is the one that can carry newlines, tabs and a US of its own, and the line
# format cannot survive any of them.
readonly FIELD_SEPARATOR=$'\037'
fields=""
extract_status=0
fields="$(printf '%s' "$result_json" | jq -r --arg sep "$FIELD_SEPARATOR" '[
    (.is_error == true | tostring),
    (if (.api_error_status | type) == "number" then (.api_error_status | tostring) else "" end),
    (if (.num_turns | type) == "number" then (.num_turns | tostring) else "" end),
    ((.result // "") | gsub("[[:cntrl:]]"; " "))
  ] | join($sep)')" || extract_status=$?
if [[ "$extract_status" -ne 0 ]]; then
  fault "the result message parsed but its fields could not be read (jq exited $extract_status)"
fi

IFS="$FIELD_SEPARATOR" read -r is_error api_status turns result_text <<< "$fields"
[[ "$turns" =~ ^[0-9]+$ ]] || turns="unknown"

quote=""
if [[ -n "$result_text" ]]; then
  quote="The model's last words:"$'\n\n'"> $(excerpt "$result_text" "$QUOTE_MAX_CHARS")"
fi
said=""
if [[ -n "$result_text" ]]; then
  said=" Model said: $(excerpt "$result_text" "$EXCERPT_MAX_CHARS")"
fi

# --- An error in the transcript outranks everything else --------------------
# Ordering matters here and is pinned by a test: the usage-limit run carries
# `subtype: "success"` too, and its single turn sits at the cap in some
# configurations, so a classifier that compared turns before reading `is_error`
# would report a weekly limit as a benign overrun and advise a retry that cannot
# succeed until the reset.
if [[ "$is_error" == "true" ]]; then
  lowered="$(printf '%s' "$result_text" | LC_ALL=C tr 'A-Z' 'a-z')"
  case "$api_status" in
    "$STATUS_USAGE_LIMIT") cause="usage-limit" ;;
    "$STATUS_UNAUTHORIZED"|"$STATUS_FORBIDDEN") cause="auth-failure" ;;
    "") cause="" ;;
    *) cause="agent-error" ;;
  esac
  # No status at all is normal for a transport-level failure, so the result
  # string is the fallback -- and only the fallback, because it is the one field
  # a model writes.
  if [[ -z "$cause" ]]; then
    case "$lowered" in
      *"usage limit"*|*"weekly limit"*|*"rate limit"*|*"limit reached"*|*quota*) cause="usage-limit" ;;
      *authentication*|*credential*|*unauthorized*|*oauth*|*"api key"*) cause="auth-failure" ;;
      *) cause="agent-error" ;;
    esac
  fi
  status_note=""
  [[ -n "$api_status" ]] && status_note=" (HTTP $api_status)"
  case "$cause" in
    usage-limit)
      verdict "usage-limit" \
        "usage limit reached$status_note: the account's allowance is exhausted and no work was attempted. Retrying before the reset is wasted work -- wait for it, or shrink what the schedule spends.$said" \
        "$quote" ;;
    auth-failure)
      verdict "auth-failure" \
        "auth failure$status_note: the credential was rejected and no work was attempted. Rotate the OAuth token secret -- unlike a usage limit this will never clear on its own.$said" \
        "$quote" ;;
    *)
      verdict "agent-error" \
        "agent error$status_note: the run reported an error with no cause this classifier recognises, after $turns turn(s). Read the transcript before re-running.$said" \
        "$quote" ;;
  esac
fi

# --- A clean transcript: the step outcome is the only thing left ------------
if [[ "$step_outcome" == "success" ]]; then
  verdict "completed" \
    "completed: the run finished its work in $turns turn(s) against a cap of $max_turns, and the step agrees." \
    "$quote"
fi

# The step failed on a clean result. Either the conversation hit the cap -- the
# benign case, where the work already landed -- or something broke AFTER a good
# result, which must NOT be filed under "benign, ignore". So the absence of a cap
# collision resolves to an error rather than to the comfortable answer.
if [[ "$turns" =~ ^[0-9]+$ ]] && [[ "$turns" -ge "$max_turns" ]]; then
  verdict "turn-cap-overrun" \
    "turn-cap overrun (benign): the work finished and its summary was written, then the action exited non-zero for using $turns turns against a cap of $max_turns. Nothing to re-run -- raise the cap or shorten the prompt." \
    "$quote"
fi

verdict "agent-error" \
  "agent error: the transcript is clean and stopped at $turns turn(s), below the cap of $max_turns, but the step still failed -- so something broke after the model was done. Read the step log, not the transcript.$said" \
  "$quote"
