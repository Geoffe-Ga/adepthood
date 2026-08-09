#!/usr/bin/env bash
# Apply the 2026-08-09 cross-repo backlog re-groom to the two repos this
# session could not write to (creek-vault, windbreak).
#
# Rationale and per-issue justification: plan/2026-08-09_BACKLOG_REGROOM.md
#
# The adepthood half is already applied. This script is idempotent: re-running
# it is a no-op, and removing a label an issue does not carry is not an error.
#
# Usage:
#   ./plan/2026-08-09_regroom-sister-repos.sh          # apply
#   DRY_RUN=1 ./plan/2026-08-09_regroom-sister-repos.sh  # print only

set -euo pipefail

DRY_RUN="${DRY_RUN:-}"

run() {
  if [[ -n "$DRY_RUN" ]]; then
    printf '  would run: %s\n' "$*"
  else
    "$@"
  fi
}

# Re-tier one issue: repo, issue number, new tier, old tier.
retier() {
  local repo="$1" num="$2" new="$3" old="$4"
  printf '%s#%s: %s -> %s\n' "$repo" "$num" "$old" "$new"
  run gh issue edit "$num" --repo "Geoffe-Ga/$repo" \
    --add-label "$new" --remove-label "$old"
}

# windbreak has carried no P0/P1 issue, so those labels may not exist yet.
ensure_label() {
  local repo="$1" name="$2" color="$3" desc="$4"
  if ! gh label list --repo "Geoffe-Ga/$repo" --search "$name" \
       --json name --jq '.[].name' 2>/dev/null | grep -qx "$name"; then
    printf 'creating %s label in %s\n' "$name" "$repo"
    # Tolerate "already exists": the probe above can also fail transiently.
    run gh label create "$name" --repo "Geoffe-Ga/$repo" \
      --color "$color" --description "$desc" || true
  fi
}

for repo in creek-vault windbreak; do
  ensure_label "$repo" P0 B60205 'Critical: core promise violated or blocks everything else'
  ensure_label "$repo" P1 D93F0B 'High: core flow broken with no workaround, or unblocks a P0'
done

echo
echo '=== creek-vault: P0 (tier-ceiling egress + merge-gate forgery) ==='
retier creek-vault 1031 P0 P1   # creek draft resolves classification with no tier
retier creek-vault 1212 P0 P1   # ALL-ceiling consent gate reads the model tier
retier creek-vault 1106 P0 P1   # pre-#974 mis-stamped fragments, live, no remediation
retier creek-vault 1152 P0 P2   # crawdad LLM router uncapped -> cloud LLM -> Discord
retier creek-vault 1052 P0 P2   # bot-capture bypasses allowlists + channel_privacy_tiers
retier creek-vault 1199 P0 P2   # forged 'Verdict: LGTM' from any author clears Gate 4

echo
echo '=== creek-vault: P1 ==='
# Ceiling / egress defense-in-depth
retier creek-vault 1054 P1 P2   # FEAT-027 redaction gate is advisory
retier creek-vault 1213 P1 P2   # _eligible_register ignores voice_proxy_eligible
retier creek-vault  971 P1 P2   # skills.refresh never threads the ceiling
retier creek-vault  931 P1 P2   # above-ceiling parent titles leak into compile prompt
retier creek-vault 1036 P1 P2   # read_gate canary cannot see a prompt-side leak
retier creek-vault 1087 P1 P2   # redaction scan follows symlinks out of the scan root
retier creek-vault 1088 P1 P2   # staging_subpath escapes the scan's canonical scope
# Auth / irreversible destruction
retier creek-vault  914 P1 P2   # purge gate has no failed-attempt backoff
retier creek-vault  895 P1 P2   # static non-rotating consumer tokens
# Data integrity
retier creek-vault 1120 P1 P2   # failed .id-index append corrupts the next append
retier creek-vault 1083 P1 P2   # update_fragment does not verify the file's own id
# Fleet integrity
retier creek-vault 1200 P1 P2   # reviewer malfunction misread as a CI failure
# Cross-repo: gates adepthood's P0 epic #2043 (epic:adepthood-http-api)
retier creek-vault 1129 P1 P2   # Cache-Control: no-store on authenticated /v1
retier creek-vault 1128 P1 P2   # /v1 error-header merge lets Vary be overridden
retier creek-vault 1127 P1 P2   # map only routing HTTPExceptions to 404
retier creek-vault 1130 P1 P2   # semaphore-timeout test can never fail

echo
echo '=== windbreak: P0 (money invariants + safety controls) ==='
retier windbreak 423 P0 P2      # resting-order collateral unaccounted: cash dimension breaches
retier windbreak 413 P0 P2      # kill-switch row proves emission, not delivery

echo
echo '=== windbreak: P1 ==='
retier windbreak 265 P1 P2      # forged delimiters in market metadata reach the trusted scaffold
retier windbreak 313 P1 P2      # pubdate extraction is temporal-leakage-critical
retier windbreak 318 P1 P2      # egress allowlist prod-vs-demo host branch untested
retier windbreak 387 P1 P2      # PaperExchange.advance() never called: replay frozen at step 0
retier windbreak 252 P1 P2      # WAL client_order_id corruption guard untested
retier windbreak 122 P1 P2      # all 10 dashboard quality tiles read N/A

echo
echo 'Done. Verify with:'
echo '  gh issue list --repo Geoffe-Ga/creek-vault --label P0 --label P1'
echo '  gh issue list --repo Geoffe-Ga/windbreak   --label P0 --label P1'
