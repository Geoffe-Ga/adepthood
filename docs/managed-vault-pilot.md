# Managed-vault pilot operations

This runbook controls new cost-bearing Creek allocations. It does not govern
bring-your-own vault connections and must never hide recovery or deletion
controls for a vault that already exists.

## Configuration states

The backend records exactly one state at startup without logging bearer values:

- `disabled`: `CREEK_MANAGED_VAULT_ACTIVATION_ENABLED` is unset or false;
- `incomplete`: the switch is invalid/true but the allowlist, alert destination,
  Creek URL, or mounted bearer files are invalid, empty, missing, or insecure;
- `ready`: the switch is true, both mounted bearers are readable, the Creek URL
  and fleet-alert destination are usable, and 1–100 positive account ids are
  allowlisted.

The container uses this same closed switch parser before startup. An unset or
explicitly false switch skips the volume bootstrap only when the secret path is
absent **and both managed bearer-path settings are unset**, then still drops to
`10001:10001`; ordinary and bring-your-own-vault deployments therefore need no
pilot volume. If the path is present for a disabled preparation deploy, or
either bearer path remains configured so existing lifecycle recovery can run,
the path must be the exact durable mount and is normalized before the drop. A
present ephemeral directory or a missing configured mount refuses startup.
True or malformed/preparing settings always require the exact mount and refuse
startup if it is absent or mis-mounted.

A bearer path must be absolute and resolve directly to a regular, non-symlink
file owned by the backend's effective uid. The backend image pins that runtime
identity to uid/gid `10001:10001`. Each file must have exact mode `0400`, contain
one non-empty visible-ASCII bearer line (`0x21`–`0x7e`), and be no larger than
4,096 bytes. One terminal LF is accepted; spaces, tabs, controls, embedded
line breaks, and non-ASCII characters fail closed before HTTP-header use.
Replacement or mutation across the open/read boundary also fails closed. The
secret reader never logs the path contents or value.

Only `ready` plus membership of the authenticated account id admits a new
allocation. Every other case returns the same
`managed_vault_activation_unavailable` refusal and writes no activation row.
The UI derives availability from the GET response and continues to expose the
bring-your-own-vault form.

## Enabling a bounded cohort

1. Verify Creek's provider-side fleet cap, billing alert, reconciliation worker,
   callback, and public ownership-bound route are healthy.
2. With managed activation disabled, attach the runtime secret volume and
   deploy the ordinary image once. Its fixed root startup bootstrap initializes
   and chowns only `/run/adepthood-secrets` to `10001:10001` with mode `0700`.
   Before any mutation it requires that path to be a non-symlink directory and
   its own exact entry in `/proc/self/mountinfo`; a missing volume refuses
   startup instead of accepting ephemeral container storage. The bootstrap
   then clears supplementary groups, sets no-new-privileges, and irreversibly
   drops to `10001:10001` before migrations or the backend application runs.
   It never recursively chowns the volume or runs the application as root; do
   not override the entrypoint and never set `RAILWAY_RUN_UID=0`. Use an
   authorized Railway SSH/SFTP session and record its effective numeric
   identity; root access is neither assumed nor required. A root session must
   install the staged file as `10001:10001`, while a `10001:10001` session
   creates it directly. For each separately rotated bearer, upload a local
   owner-only file into an owner-only `.new` file without putting its
   bytes in an environment value, argument, command, log, or terminal output.
   Require owner `10001:10001` and exact mode `0400`; verify by `lstat` that it
   is a regular non-symlink
   between 1 and 4,096 bytes, then use an atomic rename on that volume. Install
   the final files as `/run/adepthood-secrets/creek-control-bearer` and
   `/run/adepthood-secrets/creek-handoff-bearer`. The bearer is never a Railway
   variable. Restart only the normal non-root image and re-stat both final
   files before enabling the cohort. The disabled rollout leaves the ordinary
   journal available while the volume is being bootstrapped.
3. Set `CREEK_PROVISIONING_URL` to Creek's public HTTPS control-plane origin.
4. Set `CREEK_MANAGED_VAULT_ALERT_EMAIL` to the approved operator mailbox.
   Creek authenticates `POST /internal/vault-provisioning/alerts` with the
   existing mounted handoff bearer. The closed request and email contain only
   alert-kind counts—never an allocation id, user id, path, URL, exception,
   provider response, or journal content. Delivery failure is a generic 503 so
   Creek's bounded sender retries and reports the unhealthy reconciliation pass.
5. Set `CREEK_MANAGED_VAULT_PILOT_USER_IDS` to the comma-separated Adepthood
   account ids approved for this cohort. Never use email addresses or a browser
   flag. The parser rejects zero, negative, malformed, empty, and over-100 lists.
6. Set `CREEK_MANAGED_VAULT_ACTIVATION_ENABLED=true`, deploy, and confirm the
   startup record says `managed_vault_activation_config_state=ready` with only
   the expected cohort count.
7. Exercise one eligible and one ineligible account before expanding the list.

Before enabling activation, record content-free proof that each bearer is a
single-link regular file and that the control and handoff bearer values differ.
Never record either value or a digest derived from it.

## Emergency disable and rollback

Set `CREEK_MANAGED_VAULT_ACTIVATION_ENABLED=false` and redeploy. Confirm startup
records `disabled`, an inactive account sees the unavailable state, and POST
creates no row or Creek call. Then verify an existing activation can still poll,
retry with its durable activation id even if the first response lost the Creek
job id, complete its authenticated handoff, report `provider_managed` custody at
`ready`, export, revoke, and delete. Provider-managed custody means privileged
Fly, Adepthood, or Creek operators can read the stored bytes and the service can
restart without the user. This does not bypass the stop: only activation ids
admitted before the switch changed may recover, and Creek still enforces its
idempotency and hard fleet cap.

An upstream capacity refusal remains an explicit failed activation. Do not
expand Adepthood's cohort to work around Creek's fleet cap; reconcile or raise
the authoritative Creek limit deliberately, with billing approval.

## Final deployed proof

The fake-Creek E2E lane proves the application seam but cannot authorize a live
pilot. After Creek-Vault #1806 is deployed and provider/billing authorization is
explicit, follow [`docs/qa/managed-vault-pilot-proof.md`](qa/managed-vault-pilot-proof.md).
It defines the disposable lifecycle, required teardown, sanitized pending
template, and fail-closed evidence validator for Adepthood #2871. The dated
schema-v2 record embeds the exact versioned `managed_vault_pilot_prerequisite`
block emitted by Creek's offline evidence reducer; operators must not copy its
individual facts by hand or substitute a mutable artifact reference. Until that
record passes independent review, keep managed activation limited to the
approved pilot allowlist—or disabled—and do not describe the deployed lifecycle
as proven.
