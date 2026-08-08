#!/usr/bin/env bash
# scripts/quality/verified.sh - gate receipts: proof that a green run is still true
# Usage: ./scripts/quality/verified.sh {fingerprint|record|check} <gate> [--explain]
#
# A gate that takes seven minutes gets skipped by hand, and a gate that is
# skipped protects nothing. This primitive lets a gate reuse the verdict it
# already earned when - and only when - nothing that verdict depended on has
# moved. The claim is keyed on a content hash of the declared inputs plus the
# environment they were measured in: never a timestamp, never a commit SHA,
# never a flag a caller sets about itself, because each of those would produce
# a receipt that says "verified" about a tree nobody verified.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The tree root is derived from this script's own location, never from
# `git rev-parse --show-toplevel`: inside a linked worktree, or when the caller
# stands in a directory nested under an unrelated checkout, rev-parse names a
# tree this script was not copied into and the receipt would describe somebody
# else's files.
TREE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Bumping this retires every receipt in existence. It is the only safe response
# to a change in what the fingerprint measures, or in how it combines it.
readonly SCHEMA_VERSION="1"

readonly RECEIPTS_DIR="$TREE_ROOT/.gate-state/receipts"
readonly RECEIPT_SUFFIX=".receipt"
readonly TEMP_RECEIPT_PREFIX=".tmp-"

# The gate name is the only caller-supplied value that reaches a path, so the
# set of legal names excludes separators and traversal segments entirely.
readonly GATE_NAME_PATTERN='^[a-z0-9-]+$'

# A gate whose declared paths match almost nothing hashes the empty input into
# a perfectly stable fingerprint - one that matches in every tree on earth.
# That is exactly what a typo'd path or a misplaced script looks like, so too
# few files is an error rather than a hit.
readonly MINIMUM_DECLARED_FILES=50

# Only EXIT_HIT may ever license reuse of a verdict. EXIT_MISS means "not
# verified, run the gate"; EXIT_CANNOT_EVALUATE means "no honest answer is
# available". Neither failure is permission to skip.
readonly EXIT_HIT=0
readonly EXIT_MISS=1
readonly EXIT_CANNOT_EVALUATE=2

readonly FIELD_SCHEMA_VERSION="schema_version"
readonly FIELD_GATE="gate"
readonly FIELD_FINGERPRINT="fingerprint"
readonly FIELD_RECORDED_AT="recorded_at"
readonly FIELD_COMPONENT_PREFIX="component_"

readonly TIMESTAMP_FORMAT="+%Y-%m-%dT%H:%M:%SZ"

readonly COMMAND_FINGERPRINT="fingerprint"
readonly COMMAND_RECORD="record"
readonly COMMAND_CHECK="check"
readonly FLAG_EXPLAIN="--explain"
readonly FLAG_HELP="--help"

# The fingerprint components, in the vocabulary --explain reports. Each is
# digested separately so a refusal can name the single input that moved; an
# operator who cannot tell a dependency upgrade from a code edit learns to
# distrust the cache, and the documented response to a cache nobody
# understands is to disable it.
COMPONENT_NAMES=(paths interpreter packages venv host env)
COMPONENT_DIGESTS=()

EXPLAIN=false

usage() {
    cat << EOF
Usage: $(basename "$0") {$COMMAND_FINGERPRINT|$COMMAND_RECORD|$COMMAND_CHECK} <gate> [$FLAG_EXPLAIN]

Prove that a previously green gate run still describes this tree.

COMMANDS:
    $COMMAND_FINGERPRINT <gate>   Print the gate's current fingerprint (sha256 hex)
    $COMMAND_RECORD <gate>        Write the gate's receipt for the current fingerprint
    $COMMAND_CHECK <gate>         Ask whether the recorded verdict still holds

OPTIONS:
    $FLAG_EXPLAIN       On a refusal, name the first component that differs:
                    ${COMPONENT_NAMES[*]}
    $FLAG_HELP          Display this help message

GATES:
    backend       backend/ + scripts/ + .pre-commit-config.yaml

EXIT CODES:
    $EXIT_HIT             The recorded verdict still describes this tree
    $EXIT_MISS             Not verified - run the gate
    $EXIT_CANNOT_EVALUATE             Cannot evaluate - unknown gate, degenerate input, or no repository

Only exit $EXIT_HIT may be read as permission to reuse a verdict.
EOF
}

# Gate registry. One line per gate: the paths whose working-tree content the
# gate's verdict is a function of. Registering a second gate is one more line.
declared_paths_for_gate() {
    case "$1" in
        backend) printf '%s' "backend scripts .pre-commit-config.yaml" ;;
        *) return 1 ;;
    esac
}

sha256_hex() {
    # Reads stdin, prints the bare digest. The two platforms this repo runs on
    # spell the tool differently.
    if command -v sha256sum > /dev/null 2>&1; then
        sha256sum | cut -d ' ' -f 1
    else
        shasum -a 256 | cut -d ' ' -f 1
    fi
}

sha256_of() {
    printf '%s' "$1" | sha256_hex
}

print_lines() {
    # Prints a captured multi-line string as lines, and prints nothing at all
    # when it is empty: `printf '%s\n' ""` would emit a phantom blank line and
    # make an empty listing look like one file.
    [ -n "$1" ] || return 0
    printf '%s\n' "$1"
}

require_git_repository() {
    # Without git there is no file listing, and falling back to an empty one
    # would produce the same everywhere-matching fingerprint the degenerate
    # guard exists to reject.
    if git -C "$TREE_ROOT" rev-parse --git-dir > /dev/null 2>&1; then
        return 0
    fi
    printf 'Error: %s is not a git repository, so the declared paths cannot be listed.\n' \
        "$TREE_ROOT" >&2
    return "$EXIT_CANNOT_EVALUATE"
}

declared_files() {
    # Every file the gate measures: tracked plus untracked-and-unignored, minus
    # the ones deleted from the working tree. Work in progress counts, because
    # the gate would have collected it; a still-cached deletion does not,
    # because the tree no longer contains it.
    local listed deleted
    listed="$(git -C "$TREE_ROOT" ls-files --cached --others --exclude-standard -- "$@")"
    deleted="$(git -C "$TREE_ROOT" ls-files --deleted -- "$@")"
    LC_ALL=C comm -23 \
        <(print_lines "$listed" | LC_ALL=C sort -u) \
        <(print_lines "$deleted" | LC_ALL=C sort -u)
}

paths_digest() {
    # Each path is hashed ALONGSIDE its content. Combining the content hashes
    # alone would leave a file renamed without an edit indistinguishable from
    # an untouched tree - a move that changes what imports resolve, and the
    # quietest possible way for a receipt to be wrong. One `git hash-object`
    # process reads every path and answers in the order it was asked, so its
    # output pairs back against the path list line for line.
    local files="$1"
    local hashes
    hashes="$(print_lines "$files" | git -C "$TREE_ROOT" hash-object --stdin-paths)"
    paste -d ' ' <(print_lines "$files") <(print_lines "$hashes") | LC_ALL=C sort | sha256_hex
}

refuse_degenerate_input() {
    local file_count="$1"
    shift
    printf 'Error: the declared paths (%s) match only %s files under %s.\n' \
        "$*" "$file_count" "$TREE_ROOT" >&2
    printf 'At least %s are expected; a gate that measures almost nothing produces a\n' \
        "$MINIMUM_DECLARED_FILES" >&2
    printf 'stable fingerprint that would match in any tree at all.\n' >&2
    return "$EXIT_CANNOT_EVALUATE"
}

compute_components() {
    # Fills COMPONENT_DIGESTS in COMPONENT_NAMES order. Called directly and
    # never through a command substitution: a non-zero status raised inside
    # `$(...)` is discarded by the caller, and the fail-closed guard below is
    # the one refusal that has to reach the exit code.
    local files file_count
    files="$(declared_files "$@")"
    file_count=0
    if [ -n "$files" ]; then
        file_count="$(print_lines "$files" | wc -l | tr -d '[:space:]')"
    fi
    if [ "$file_count" -lt "$MINIMUM_DECLARED_FILES" ]; then
        refuse_degenerate_input "$file_count" "$@"
        return "$EXIT_CANNOT_EVALUATE"
    fi
    COMPONENT_DIGESTS=(
        "$(paths_digest "$files")"
        "$(python3 -VV 2>&1 | sha256_hex)"
        "$(pip freeze 2> /dev/null | sha256_hex)"
        "$(sha256_of "${VIRTUAL_ENV-}")"
        "$(uname -n | sha256_hex)"
        "$(sha256_of "${TEST_POSTGRES_URL-}|${INTEGRATION_LANE_REQUIRE_POSTGRES-}")"
    )
}

component_lines() {
    local index=0
    while [ "$index" -lt "${#COMPONENT_NAMES[@]}" ]; do
        printf '%s=%s\n' "${COMPONENT_NAMES[$index]}" "${COMPONENT_DIGESTS[$index]}"
        index=$((index + 1))
    done
}

combined_fingerprint() {
    # Combined WITH the schema version, so a change to the algorithm retires
    # every old receipt instead of silently reinterpreting it.
    {
        printf '%s=%s\n' "$FIELD_SCHEMA_VERSION" "$SCHEMA_VERSION"
        component_lines
    } | sha256_hex
}

receipt_path_for() {
    printf '%s/%s%s' "$RECEIPTS_DIR" "$1" "$RECEIPT_SUFFIX"
}

receipt_field() {
    # Reads one key=value field, tolerating a truncated or binary-damaged
    # receipt: an interrupted run, a full disk or a killed process can each
    # leave a stub behind, and the only safe reading of one is a refusal said
    # without a shell traceback that would look like a broken tool.
    local file="$1"
    local key="$2"
    LC_ALL=C tr -d '\000' < "$file" 2> /dev/null \
        | LC_ALL=C awk -F '=' -v key="$key" \
            'found != 1 && $1 == key { sub(/^[^=]*=/, ""); print; found = 1 }'
}

record_receipt() {
    local gate="$1"
    local receipt temp
    receipt="$(receipt_path_for "$gate")"
    temp="$RECEIPTS_DIR/$TEMP_RECEIPT_PREFIX$gate$RECEIPT_SUFFIX"
    mkdir -p "$RECEIPTS_DIR"
    {
        printf '%s=%s\n' "$FIELD_SCHEMA_VERSION" "$SCHEMA_VERSION"
        printf '%s=%s\n' "$FIELD_GATE" "$gate"
        printf '%s=%s\n' "$FIELD_FINGERPRINT" "$(combined_fingerprint)"
        printf '%s=%s\n' "$FIELD_RECORDED_AT" "$(date -u "$TIMESTAMP_FORMAT")"
        component_lines | sed "s/^/$FIELD_COMPONENT_PREFIX/"
    } > "$temp"
    # Publish atomically. A reader must never observe a half-written receipt,
    # and a temp file left in the receipts directory is the visible symptom of
    # a torn write.
    mv -f "$temp" "$receipt"
}

explain_mismatch() {
    # Names the first component that differs, and only the first: a refusal
    # that listed every downstream difference would bury the one input the
    # operator actually changed.
    local receipt="$1"
    local index=0
    local name
    while [ "$index" -lt "${#COMPONENT_NAMES[@]}" ]; do
        name="${COMPONENT_NAMES[$index]}"
        if [ "$(receipt_field "$receipt" "$FIELD_COMPONENT_PREFIX$name")" \
            != "${COMPONENT_DIGESTS[$index]}" ]; then
            printf '%s\n' "$name"
            return 0
        fi
        index=$((index + 1))
    done
}

receipt_is_addressed_to() {
    # A receipt is evidence only about the gate it names, under the schema it
    # was computed with. Without both, a misfiled or superseded receipt is
    # indistinguishable from a legitimate verdict.
    local receipt="$1"
    local gate="$2"
    [ "$(receipt_field "$receipt" "$FIELD_SCHEMA_VERSION")" = "$SCHEMA_VERSION" ] \
        && [ "$(receipt_field "$receipt" "$FIELD_GATE")" = "$gate" ]
}

check_receipt() {
    local gate="$1"
    local receipt current recorded
    receipt="$(receipt_path_for "$gate")"
    if [ ! -f "$receipt" ]; then
        printf 'No receipt for gate %s; the gate has to run.\n' "$gate" >&2
        return "$EXIT_MISS"
    fi
    if ! receipt_is_addressed_to "$receipt" "$gate"; then
        printf 'The receipt for gate %s is damaged or was written under other terms.\n' \
            "$gate" >&2
        return "$EXIT_MISS"
    fi
    current="$(combined_fingerprint)"
    recorded="$(receipt_field "$receipt" "$FIELD_FINGERPRINT")"
    if [ -n "$recorded" ] && [ "$recorded" = "$current" ]; then
        printf '%s=%s\n' "$FIELD_RECORDED_AT" "$(receipt_field "$receipt" "$FIELD_RECORDED_AT")"
        return "$EXIT_HIT"
    fi
    if [ "$EXPLAIN" = true ]; then
        explain_mismatch "$receipt"
    fi
    printf 'The recorded verdict for gate %s no longer describes this tree.\n' "$gate" >&2
    return "$EXIT_MISS"
}

require_known_command() {
    case "$1" in
        "$COMMAND_FINGERPRINT" | "$COMMAND_RECORD" | "$COMMAND_CHECK") return 0 ;;
        *) ;;
    esac
    printf 'Error: unknown command: %s\n' "$1" >&2
    usage >&2
    return "$EXIT_CANNOT_EVALUATE"
}

require_valid_gate_name() {
    # Validated before a single file is created or read, so a name carrying a
    # separator or a traversal segment can never aim a receipt write elsewhere
    # on disk.
    if [[ "$1" =~ $GATE_NAME_PATTERN ]]; then
        return 0
    fi
    printf 'Error: %s is not a valid gate name; expected %s.\n' "$1" "$GATE_NAME_PATTERN" >&2
    return "$EXIT_CANNOT_EVALUATE"
}

parse_trailing_flags() {
    while [ $# -gt 0 ]; do
        case "$1" in
            "$FLAG_EXPLAIN")
                EXPLAIN=true
                shift
                ;;
            *)
                printf 'Error: unknown option: %s\n' "$1" >&2
                return "$EXIT_CANNOT_EVALUATE"
                ;;
        esac
    done
}

run_command() {
    local command="$1"
    local gate="$2"
    local status=0
    case "$command" in
        "$COMMAND_FINGERPRINT") combined_fingerprint ;;
        "$COMMAND_RECORD") record_receipt "$gate" ;;
        "$COMMAND_CHECK") check_receipt "$gate" || status=$? ;;
        *) status="$EXIT_CANNOT_EVALUATE" ;;
    esac
    return "$status"
}

main() {
    if [ $# -eq 0 ]; then
        usage >&2
        exit "$EXIT_CANNOT_EVALUATE"
    fi
    local command="$1"
    shift
    if [ "$command" = "$FLAG_HELP" ]; then
        usage
        exit "$EXIT_HIT"
    fi
    local gate=""
    if [ $# -gt 0 ]; then
        gate="$1"
        shift
    fi

    require_known_command "$command" || exit $?
    require_valid_gate_name "$gate" || exit $?
    parse_trailing_flags "$@" || exit $?

    local paths_spec
    if ! paths_spec="$(declared_paths_for_gate "$gate")"; then
        printf 'Error: no gate named %s is registered.\n' "$gate" >&2
        exit "$EXIT_CANNOT_EVALUATE"
    fi
    require_git_repository || exit $?

    local declared=()
    read -r -a declared <<< "$paths_spec"
    compute_components "${declared[@]}" || exit $?

    local status=0
    run_command "$command" "$gate" || status=$?
    exit "$status"
}

main "$@"
