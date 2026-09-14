# Managed private-vault pilot operations

This runbook controls new cost-bearing Creek allocations. It does not govern
bring-your-own vault connections and must never hide recovery or deletion
controls for a vault that already exists.

## Configuration states

The backend records exactly one state at startup without logging bearer values:

- `disabled`: `CREEK_MANAGED_VAULT_ACTIVATION_ENABLED` is unset or false;
- `incomplete`: the switch is invalid/true but the allowlist or Creek URL and
  mounted bearer files are invalid, empty, or missing;
- `ready`: the switch is true, both mounted bearers are readable, the Creek URL
  is usable, and 1–100 positive account ids are allowlisted.

Only `ready` plus membership of the authenticated account id admits a new
allocation. Every other case returns the same
`managed_vault_activation_unavailable` refusal and writes no activation row.
The UI derives availability from the GET response and continues to expose the
bring-your-own-vault form.

## Enabling a bounded cohort

1. Verify Creek's provider-side fleet cap, billing alert, reconciliation worker,
   callback, and public ownership-bound route are healthy.
2. Mount separately rotated, non-empty control and handoff bearer files.
3. Set `CREEK_PROVISIONING_URL` to Creek's public HTTPS control-plane origin.
4. Set `CREEK_MANAGED_VAULT_PILOT_USER_IDS` to the comma-separated Adepthood
   account ids approved for this cohort. Never use email addresses or a browser
   flag. The parser rejects zero, negative, malformed, empty, and over-100 lists.
5. Set `CREEK_MANAGED_VAULT_ACTIVATION_ENABLED=true`, deploy, and confirm the
   startup record says `managed_vault_activation_config_state=ready` with only
   the expected cohort count.
6. Exercise one eligible and one ineligible account before expanding the list.

## Emergency disable and rollback

Set `CREEK_MANAGED_VAULT_ACTIVATION_ENABLED=false` and redeploy. Confirm startup
records `disabled`, an inactive account sees the unavailable state, and POST
creates no row or Creek call. Then verify an existing activation can still poll,
retry with its durable activation id even if the first response lost the Creek
job id, finish its key ceremony, export, revoke, and delete. This does not bypass
the stop: only activation ids admitted before the switch changed may recover,
and Creek still enforces its idempotency and hard fleet cap.

An upstream capacity refusal remains an explicit failed activation. Do not
expand Adepthood's cohort to work around Creek's fleet cap; reconcile or raise
the authoritative Creek limit deliberately, with billing approval.
