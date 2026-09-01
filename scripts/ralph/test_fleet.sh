#!/usr/bin/env bash
# scripts/ralph/test_fleet.sh
#
# Offline tests for fleet.sh — the git/worktree/slot logic that never touches
# GitHub. We build a throwaway git repo (with an `origin` remote so `fetch` and
# `origin/main` resolve) and a fake `gh` on PATH for the reconcile test, then
# exercise assign / list / count / free / path / sync / release / reconcile, plus
# `adopt` — the bot-PR variant of assign that attaches a lane to a PR's EXISTING
# head branch so fixes land on that branch instead of opening a second PR.
#
# Run:  bash scripts/ralph/test_fleet.sh
set -euo pipefail

FLEET="$(cd "$(dirname "$0")" && pwd)/fleet.sh"
PASS=0
FAIL=0

ok()   { PASS=$((PASS + 1)); printf '  ok  - %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf 'FAIL  - %s\n' "$1"; }
check() { # check <desc> <expected> <actual>
  if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (expected '$2', got '$3')"; fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- build an upstream + working clone -------------------------------------
git init -q -b main "$WORK/upstream"
(
  cd "$WORK/upstream"
  git config user.email t@t.t && git config user.name t
  mkdir -p scripts/ralph
  printf '{"max_workers": 4, "parallel_enabled": true}\n' > scripts/ralph/state.json
  git add -A && git commit -qm init
)
git clone -q "$WORK/upstream" "$WORK/repo"
REPO="$WORK/repo"
(cd "$REPO" && git config user.email t@t.t && git config user.name t)

run() { (cd "$REPO" && "$FLEET" "$@"); }

# --- empty fleet ------------------------------------------------------------
check "count starts at 0" "0" "$(run count)"
check "free starts at 4"  "4" "$(run free)"
check "active empty"      ""  "$(run active)"

# --- assign creates a worktree + branch ------------------------------------
DIR="$(run assign 101 'Add Widget Endpoint!!' 2>/dev/null)"
[[ -d "$DIR" ]] && ok "assign created worktree dir" || bad "assign created worktree dir"
check "count is 1 after assign"    "1"   "$(run count)"
check "free drops to 3"            "3"   "$(run free)"
check "active lists issue"         "101" "$(run active)"
BR="$(cd "$DIR" && git rev-parse --abbrev-ref HEAD)"
check "branch slug sanitized"      "issue/101-add-widget-endpoint" "$BR"
check "path resolves"              "$DIR" "$(run path 101)"

# --- assign is idempotent (re-entrant) -------------------------------------
DIR2="$(run assign 101 'whatever' 2>/dev/null)"
check "re-assign returns same dir" "$DIR" "$DIR2"
check "count still 1"              "1"   "$(run count)"

# --- second worker ---------------------------------------------------------
run assign 102 'frontend tweak' >/dev/null 2>&1
check "count is 2"                 "2"   "$(run count)"
check "active lists both"          "101 102" "$(run active)"

# --- cap enforcement (parallel_enabled=false ⇒ effective cap 1) ------------
printf '{"max_workers": 4, "parallel_enabled": false}\n' > "$REPO/scripts/ralph/state.json"
check "free is 0 when sequential + active" "0" "$(run free)"
if run assign 103 'blocked by cap' >/dev/null 2>&1; then
  bad "assign refused when fleet full"
else
  ok "assign refused when fleet full"
fi
# restore parallel config
printf '{"max_workers": 4, "parallel_enabled": true}\n' > "$REPO/scripts/ralph/state.json"

# --- sync clean: merge advanced main into the branch -----------------------
(
  cd "$WORK/upstream"
  echo hello > NEWFILE.txt && git add -A && git commit -qm "advance main"
)
if run sync 101 >/dev/null 2>&1; then ok "clean sync exits 0"; else bad "clean sync exits 0"; fi
[[ -f "$DIR/NEWFILE.txt" ]] && ok "synced worktree has new main file" \
  || bad "synced worktree has new main file"

# --- sync conflict exits 3 and leaves worktree clean -----------------------
(cd "$DIR" && echo "worktree side" > CONFLICT.txt && git add -A && git commit -qm "wt change")
(
  cd "$WORK/upstream"
  echo "main side" > CONFLICT.txt && git add -A && git commit -qm "main conflict"
)
rc=0
run sync 101 >/dev/null 2>&1 || rc=$?
check "conflicting sync exits 3" "3" "$rc"
if (cd "$DIR" && git status --porcelain=v1 2>/dev/null | grep -qE '^(UU|AA|DD)'); then
  bad "worktree left mid-merge"
else
  ok "worktree left clean after aborted merge"
fi

# --- release removes worktree + branch -------------------------------------
run release 101 >/dev/null 2>&1
[[ -d "$DIR" ]] && bad "release removed worktree dir" || ok "release removed worktree dir"
check "count back to 1 after release" "1" "$(run count)"
if (cd "$REPO" && git show-ref --verify --quiet refs/heads/issue/101-add-widget-endpoint); then
  bad "release deleted branch"
else
  ok "release deleted branch"
fi

# --- reconcile releases only the MERGED worktree, keeps the open one -------
# Branch-aware fake gh: only $MERGED_BRANCH reports a MERGED PR, and only issue
# $CLOSED_ISSUE reports CLOSED — so an open second worktree must survive. This
# guards against an over-broad "MERGED for everything" stub silently releasing
# healthy workers.
run assign 105 'keep me open' >/dev/null 2>&1
check "two workers before reconcile" "2" "$(run count)"
BIN="$WORK/bin"; mkdir -p "$BIN"
cat > "$BIN/gh" <<'STUB'
#!/usr/bin/env bash
# real gh applies --jq, so emit the already-extracted scalar — branch-aware.
# `pr view --json headRefName,isCrossRepository` resolves to
# "<headRefName>|<isCrossRepository>"; only PR $FORK_PR comes from a fork.
# HEAD_LINE_RAW, when set, is emitted verbatim so a test can feed a malformed or
# truncated answer that the well-formed template could not express.
args="$*"
case "$args" in
  *"pr view"*"--json headRefName"*)
    if [[ -n "${HEAD_LINE_RAW:-}" ]]; then printf '%s\n' "$HEAD_LINE_RAW"; exit 0; fi
    pr=""
    for tok in "$@"; do
      if [[ "$tok" =~ ^[0-9]+$ ]]; then pr="$tok"; break; fi
    done
    if [[ -n "${FORK_PR:-}" && "$pr" == "$FORK_PR" ]]; then
      printf '%s|true\n' "${HEAD_REF:-}"
    else
      printf '%s|false\n' "${HEAD_REF:-}"
    fi ;;
  *"pr list"*"--json state"*)
    if [[ "$args" == *"--head $MERGED_BRANCH"* ]]; then echo 'MERGED'; else echo ''; fi ;;
  *"pr list"*) echo '' ;;
  *"issue view"*"--json state"*)
    for tok in "$@"; do
      if [[ "$tok" =~ ^[0-9]+$ ]]; then
        if [[ "$tok" == "${CLOSED_ISSUE:-}" ]]; then echo 'CLOSED'; else echo 'OPEN'; fi
        break
      fi
    done ;;
  *) echo '' ;;
esac
STUB
chmod +x "$BIN/gh"
(cd "$REPO" && PATH="$BIN:$PATH" MERGED_BRANCH="issue/102-frontend-tweak" \
  "$FLEET" reconcile >/dev/null 2>&1)
check "reconcile released only the merged worker" "1" "$(run count)"
check "the open worker survived reconcile"        "105" "$(run active)"

# --- adopt: attach a lane to a bot PR's existing head branch ----------------
# The branch name carries slashes on purpose — ref handling must survive them.
# It is pushed AFTER the clone, so adopt has to fetch it like the real loop does.
BOT_BRANCH="dependabot/pip/backend/pip-patch-minor-f1456b4b2b"
(
  cd "$WORK/upstream"
  git checkout -q -b "$BOT_BRANCH"
  echo "ruff==0.16.0" > BUMP.txt && git add -A && git commit -qm "bump deps"
  git checkout -q main
)
export HEAD_REF="$BOT_BRANCH" FORK_PR=""
run_gh() { (cd "$REPO" && PATH="$BIN:$PATH" "$FLEET" "$@"); }

# `|| true` keeps a failing adopt from aborting the run, so every later
# assertion still reports; the placeholder path keeps git off the real repo.
ADIR="$(run_gh adopt 201 901 2>/dev/null || true)"
ADIR="${ADIR:-$WORK/adopt-missing}"
[[ -d "$ADIR" ]] && ok "adopt created worktree dir" || bad "adopt created worktree dir"
check "adopt uses the standard slot name" "issue-201" "$(basename "$ADIR")"
ABR="$(cd "$ADIR" 2>/dev/null && git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
check "adopted lane sits on the PR head branch" "$BOT_BRANCH" "$ABR"
[[ -f "$ADIR/BUMP.txt" ]] && ok "adopted lane has the bot branch content" \
  || bad "adopted lane has the bot branch content"
if (cd "$REPO" && git for-each-ref --format='%(refname:short)' 'refs/heads/issue/201-*' | grep -q .); then
  bad "adopt created no issue/201-* branch"
else
  ok "adopt created no issue/201-* branch"
fi

# --- an adopted lane is a first-class fleet member --------------------------
check "count sees the adopted lane"  "2"       "$(run count)"
check "free accounts for it"         "2"       "$(run free)"
check "active lists it"              "105 201" "$(run active)"
check "path resolves it"             "$ADIR"   "$(run path 201)"

# --- adopt is idempotent (re-entrant) --------------------------------------
ADIR2="$(run_gh adopt 201 901 2>/dev/null || true)"
check "re-adopt returns same dir"     "$ADIR" "$ADIR2"
check "re-adopt creates no second worktree" "2" "$(run count)"

# --- adopt honours the same cap as assign ----------------------------------
printf '{"max_workers": 4, "parallel_enabled": false}\n' > "$REPO/scripts/ralph/state.json"
if run_gh adopt 202 902 >/dev/null 2>&1; then
  bad "adopt refused when fleet full"
else
  ok "adopt refused when fleet full"
fi
check "count unchanged after refused adopt" "2" "$(run count)"
printf '{"max_workers": 4, "parallel_enabled": true}\n' > "$REPO/scripts/ralph/state.json"

# --- adopt refuses a fork PR: we cannot push to another repo's branch -------
rc=0
(FORK_PR=903 run_gh adopt 203 903) >/dev/null 2>&1 || rc=$?
if [[ "$rc" -ne 0 ]]; then ok "adopt refuses a cross-repository PR"; else bad "adopt refuses a cross-repository PR"; fi
if run path 203 >/dev/null 2>&1; then
  bad "refused fork adopt created no worktree"
else
  ok "refused fork adopt created no worktree"
fi

# --- adopt validates its arguments -----------------------------------------
if run_gh adopt abc 901 >/dev/null 2>&1; then
  bad "adopt refuses a non-numeric issue"
else
  ok "adopt refuses a non-numeric issue"
fi
if run_gh adopt 204 xyz >/dev/null 2>&1; then
  bad "adopt refuses a non-numeric PR"
else
  ok "adopt refuses a non-numeric PR"
fi

# --- sync on an adopted lane: main merges INTO the bot branch --------------
(
  cd "$WORK/upstream"
  echo adopted > ADOPTED.txt && git add -A && git commit -qm "advance main again"
)
if run sync 201 >/dev/null 2>&1; then ok "sync on adopted lane exits 0"; else bad "sync on adopted lane exits 0"; fi
[[ -f "$ADIR/ADOPTED.txt" ]] && ok "adopted lane picked up new main file" \
  || bad "adopted lane picked up new main file"
[[ -f "$ADIR/BUMP.txt" ]] && ok "adopted lane kept the bot commit (merge, not reset)" \
  || bad "adopted lane kept the bot commit (merge, not reset)"

# --- release on an adopted lane: local branch only, remote untouched -------
run release 201 >/dev/null 2>&1
[[ -d "$ADIR" ]] && bad "release removed the adopted worktree" \
  || ok "release removed the adopted worktree"
check "count back to 1 after release" "1" "$(run count)"
if (cd "$REPO" && git show-ref --verify --quiet "refs/heads/$BOT_BRANCH"); then
  bad "release deleted the local bot branch"
else
  ok "release deleted the local bot branch"
fi
if (cd "$WORK/upstream" && git show-ref --verify --quiet "refs/heads/$BOT_BRANCH"); then
  ok "release left the remote bot branch intact"
else
  bad "release left the remote bot branch intact"
fi

# --- reconcile releases a merged adopted lane, keeps the open one ----------
run_gh adopt 201 901 >/dev/null 2>&1 || true
check "two lanes before adopted reconcile" "2" "$(run count)"
(cd "$REPO" && PATH="$BIN:$PATH" MERGED_BRANCH="$BOT_BRANCH" \
  "$FLEET" reconcile >/dev/null 2>&1)
check "reconcile released the merged adopted lane" "1" "$(run count)"
check "the unrelated open lane survived"           "105" "$(run active)"

# --- adopt: '|' is legal in a branch name, so the fork refusal must not be
# --- bypassable by naming a branch after the field separator ----------------
# The exploit: a FORK PR whose head branch is `main-shim|false` answers
# "main-shim|false|true". Splitting on the FIRST '|' yields head_ref=main-shim and
# is_fork="false|true" — never equal to "true", so the fork refusal stays silent
# and the lane attaches to the unrelated base-repo branch `main-shim`, which the
# worker then pushes to.
SHIM_BRANCH="main-shim"
PIPE_BRANCH="main-shim|false"
STRAY_BRANCH="stray-base-branch"
(
  cd "$WORK/upstream"
  git checkout -q -b "$SHIM_BRANCH" main
  echo "unrelated base-repo branch" > SHIM.txt && git add -A && git commit -qm "shim branch"
  git checkout -q -b "$PIPE_BRANCH" main
  echo "bot work" > PIPE.txt && git add -A && git commit -qm "pipe-named head branch"
  git checkout -q -b "$STRAY_BRANCH" main
  echo "another base-repo branch" > STRAY.txt && git add -A && git commit -qm "stray branch"
  git checkout -q main
)
rc=0
(HEAD_REF="$PIPE_BRANCH" FORK_PR=911 run_gh adopt 301 911) >/dev/null 2>&1 || rc=$?
if [[ "$rc" -ne 0 ]]; then
  ok "adopt refuses a fork PR whose branch name contains '|'"
else
  bad "adopt refuses a fork PR whose branch name contains '|'"
fi
if run path 301 >/dev/null 2>&1; then
  bad "the refused pipe-named fork adopt created no worktree"
else
  ok "the refused pipe-named fork adopt created no worktree"
fi
if (cd "$REPO" && git show-ref --verify --quiet "refs/heads/$SHIM_BRANCH"); then
  bad "the refused fork adopt never attached to the base-repo branch"
else
  ok "the refused fork adopt never attached to the base-repo branch"
fi

# The legal-branch twin: refusing every '|' would break a valid branch name, so a
# same-repo pipe-named head must still adopt onto that branch exactly.
PDIR="$(HEAD_REF="$PIPE_BRANCH" run_gh adopt 302 912 2>/dev/null || true)"
PDIR="${PDIR:-$WORK/adopt-pipe-missing}"
[[ -d "$PDIR" ]] && ok "adopt accepts a same-repo pipe-named head branch" \
  || bad "adopt accepts a same-repo pipe-named head branch"
PBR="$(cd "$PDIR" 2>/dev/null && git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
check "the pipe-named lane sits on the whole branch name" "$PIPE_BRANCH" "$PBR"
[[ -f "$PDIR/PIPE.txt" ]] && ok "the pipe-named lane has that branch's content" \
  || bad "the pipe-named lane has that branch's content"
run release 302 >/dev/null 2>&1

# Fail closed on an unparseable head lookup: an answer that cannot be split leaves
# the PR's origin undetermined, which must refuse rather than proceed. The name it
# would fall back to is a real base-repo branch, so proceeding is not harmless.
rc=0
(HEAD_LINE_RAW="$STRAY_BRANCH" run_gh adopt 303 913) >/dev/null 2>&1 || rc=$?
if [[ "$rc" -ne 0 ]]; then
  ok "adopt refuses a head lookup with no separator"
else
  bad "adopt refuses a head lookup with no separator"
fi
rc=0
(HEAD_LINE_RAW="$STRAY_BRANCH|" run_gh adopt 303 913) >/dev/null 2>&1 || rc=$?
if [[ "$rc" -ne 0 ]]; then
  ok "adopt refuses an empty isCrossRepository field"
else
  bad "adopt refuses an empty isCrossRepository field"
fi
if run path 303 >/dev/null 2>&1; then
  bad "the malformed head lookups created no worktree"
else
  ok "the malformed head lookups created no worktree"
fi

# --- the divergence guard must vet the BRANCH, not a same-named tag ---------
# A tag outranks a branch in `git rev-parse`'s disambiguation while `git worktree
# add` picks the branch, so bare rev names would vet a different object than the
# one checked out — here the tag is not an ancestor of the remote and the guard
# would refuse a perfectly healthy lane.
SHADOW_BRANCH="dependabot/pip/backend/shadowed"
(
  cd "$WORK/upstream"
  git checkout -q -b "$SHADOW_BRANCH" main
  echo shadowed > SHADOW.txt && git add -A && git commit -qm "shadowed bot branch"
  git checkout -q main
  echo later > LATER.txt && git add -A && git commit -qm "advance main past the bot branch"
)
(
  cd "$REPO"
  git fetch -q origin "+refs/heads/$SHADOW_BRANCH:refs/remotes/origin/$SHADOW_BRANCH"
  git branch "$SHADOW_BRANCH" "refs/remotes/origin/$SHADOW_BRANCH" >/dev/null
  git fetch -q origin main
  git tag "$SHADOW_BRANCH" origin/main
)
SDIR="$(HEAD_REF="$SHADOW_BRANCH" run_gh adopt 304 914 2>/dev/null || true)"
SDIR="${SDIR:-$WORK/adopt-shadow-missing}"
[[ -d "$SDIR" ]] && ok "adopt vets the branch, not a tag of the same name" \
  || bad "adopt vets the branch, not a tag of the same name"
SHEAD="$(cd "$SDIR" 2>/dev/null && git rev-parse HEAD 2>/dev/null || true)"
check "the shadowed lane checked out the branch tip" \
  "$(cd "$REPO" && git rev-parse "refs/heads/$SHADOW_BRANCH")" "$SHEAD"
run release 304 >/dev/null 2>&1

# --- a new lane is provisioned with the main checkout's frontend deps -------
# A worktree is a fresh checkout: `git worktree add` copies tracked files only,
# and node_modules is git-ignored, so every lane started life without it. The
# four frontend pre-commit hooks then could not gate the lane's diff at all --
# and worse, `npx` answered the missing binaries by fetching same-named packages
# off the public registry and running them. The lane therefore has to be handed
# the main checkout's node_modules, by symlink (a per-lane `npm ci` is ~700
# packages and the fleet runs four lanes).
NM_MARKER="ADEPTHOOD_FLEET_NODE_MODULES_MARKER"

# The backend-only case first, while $REPO still has no frontend deps to share:
# a lane must still be created, with a warning rather than a failure.
WARN="$( (run assign 401 'backend only lane' 2>&1 >/dev/null) || true )"
if run path 401 >/dev/null 2>&1; then
  ok "assign succeeds when the checkout has no frontend deps to share"
else
  bad "assign succeeds when the checkout has no frontend deps to share"
fi
if printf '%s' "$WARN" | grep -q 'node_modules'; then
  ok "assign warns about the missing frontend deps"
else
  bad "assign warns about the missing frontend deps"
fi
run release 401 >/dev/null 2>&1

# Now give the source checkout frontend deps and re-run the same path.
mkdir -p "$REPO/frontend/node_modules/.bin"
echo shared > "$REPO/frontend/node_modules/$NM_MARKER"

ADIR402="$(run assign 402 'provisioned lane' 2>/dev/null)"
ADIR402="${ADIR402:-$WORK/assign-402-missing}"
LINK402="$ADIR402/frontend/node_modules"
[[ -L "$LINK402" ]] && ok "assign symlinks node_modules into the lane" \
  || bad "assign symlinks node_modules into the lane"
[[ -f "$LINK402/$NM_MARKER" ]] && ok "the lane's node_modules resolves to the shared one" \
  || bad "the lane's node_modules resolves to the shared one"
[[ -d "$LINK402/.bin" ]] && ok "the lane can reach node_modules/.bin" \
  || bad "the lane can reach node_modules/.bin"

# A symlink, not a copy: a real directory here would be ~700 packages per lane.
if [[ -L "$LINK402" ]]; then
  ok "the lane shares rather than copies the dependency tree"
else
  bad "the lane shares rather than copies the dependency tree"
fi
run release 402 >/dev/null 2>&1

# Re-assign is re-entrant, so provisioning must never clobber what is already
# there -- a lane that ran its own `npm ci` keeps that real directory.
ADIR403="$(run assign 403 'reentrant lane' 2>/dev/null)"
ADIR403="${ADIR403:-$WORK/assign-403-missing}"
rm -f "$ADIR403/frontend/node_modules"
mkdir -p "$ADIR403/frontend/node_modules"
echo local > "$ADIR403/frontend/node_modules/LANE_OWNED"
run assign 403 'reentrant lane' >/dev/null 2>&1
[[ -f "$ADIR403/frontend/node_modules/LANE_OWNED" ]] \
  && ok "re-assign leaves an existing node_modules untouched" \
  || bad "re-assign leaves an existing node_modules untouched"
[[ -L "$ADIR403/frontend/node_modules" ]] \
  && bad "re-assign replaced a real node_modules with a symlink" \
  || ok "re-assign did not replace a real node_modules with a symlink"
run release 403 >/dev/null 2>&1

# adopt creates a worktree the same way assign does, so it needs the same
# provisioning -- a bot-PR lane runs the identical hooks.
ADIR404="$(HEAD_REF="$BOT_BRANCH" run_gh adopt 404 915 2>/dev/null || true)"
ADIR404="${ADIR404:-$WORK/adopt-404-missing}"
[[ -L "$ADIR404/frontend/node_modules" ]] && ok "adopt symlinks node_modules into the lane" \
  || bad "adopt symlinks node_modules into the lane"
[[ -f "$ADIR404/frontend/node_modules/$NM_MARKER" ]] \
  && ok "the adopted lane's node_modules resolves to the shared one" \
  || bad "the adopted lane's node_modules resolves to the shared one"
run release 404 >/dev/null 2>&1

# --- provisioning can never fail the lane it is provisioning ----------------
# provision_frontend_deps runs under `set -e`, AFTER `git worktree add` has
# succeeded and BEFORE cmd_assign prints "$dir". A non-zero return there aborts
# assign with a real worktree and branch already on disk and no path handed
# back, so count_active keeps counting that lane against max_workers and the
# orchestrator never learns it exists -- a fleet slot leaked silently. A lane
# without node_modules is not a silent hazard by comparison: every frontend gate
# fails it loudly through require-node-modules.sh. So the helper is best-effort
# by contract, and this pins that contract against a future edit.
PROVISION_BODY="$(awk '/^provision_frontend_deps\(\)/,/^}/' "$(dirname "$FLEET")/fleet.sh")"
if [[ -n "$PROVISION_BODY" ]]; then
  ok "provision_frontend_deps is present to inspect"
else
  bad "provision_frontend_deps is present to inspect"
fi
if printf '%s' "$PROVISION_BODY" | grep -qE '^[[:space:]]*(return[[:space:]]+[1-9]|exit[[:space:]]+[1-9]|die[[:space:]])'; then
  bad "provision_frontend_deps cannot fail the caller (found a non-zero exit path)"
else
  ok "provision_frontend_deps cannot fail the caller"
fi

# --- summary ----------------------------------------------------------------
echo
echo "fleet tests: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
